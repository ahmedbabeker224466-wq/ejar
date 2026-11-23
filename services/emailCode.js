'use strict';

// Six-digit sign-in codes sent by email. Same rules as the SMS codes
// (services/otp.js): 5 minutes, one request a minute and five an hour per
// address, twenty an hour per IP, five wrong codes lock the address for 15
// minutes, only a keyed hash of the code is stored. Rows live in otp_codes
// under a key derived from the address ("e:" + 18 hex characters of an HMAC),
// so the address itself is never stored there.

const crypto = require('crypto');
const db = require('../config/db');
const { createOtpService, CODE_TTL_MINUTES } = require('./otp');
const { normalizeEmail } = require('./emailAuth');
const email = require('./channels/email');
const tr = require('./tr');

function idKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHash('sha256').update(`email-code-id:${secret}`).digest();
}

/** The otp_codes key of an address (fits the 20-character column), or null. */
function identify(input) {
  const address = normalizeEmail(input);
  if (!address) return null;
  return `e:${crypto.createHmac('sha256', idKey()).update(address).digest('hex').slice(0, 18)}`;
}

function messageFor(code, lang) {
  const subject = tr.translate(lang, 'رمز الدخول إلى ميعاد');
  const text = tr.translate(lang, `رمز الدخول إلى ميعاد: ${code}\nصالح لمدة ${CODE_TTL_MINUTES} دقائق. لا تشاركه مع أحد.`)
    + '\n\n'
    + tr.translate(lang, 'إذا لم تطلب هذا الرمز فتجاهل هذه الرسالة.');
  return { subject, text };
}

/** Sends the code. Returns { ok } (never the address or the provider's text). */
async function deliver(input, code, lang = 'ar') {
  const to = normalizeEmail(input);
  if (!to) return { ok: false };
  const { subject, text } = messageFor(code, lang);
  const sent = await email.send({ to, subject, text });
  return { ok: Boolean(sent && sent.ok) };
}

function createEmailCodeService({ pool = db.pool, send = deliver, key = null } = {}) {
  return createOtpService({ pool, key, identify, deliver: send });
}

/** Email codes are offered whenever outgoing mail is configured (AUTH_EMAIL_LOGIN=false turns them off). */
function enabled(env = process.env) {
  if (String(env.AUTH_EMAIL_LOGIN || '').trim().toLowerCase() === 'false') return false;
  return Boolean(email.smtpConfig(env)) || String(env.AUTH_EMAIL_LOGIN || '').trim().toLowerCase() === 'true';
}

module.exports = {
  ...createEmailCodeService(),
  createEmailCodeService,
  identify,
  messageFor,
  deliver,
  enabled,
};
