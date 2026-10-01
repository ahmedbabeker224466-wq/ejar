'use strict';

// Email through nodemailer and the SMTP settings in the environment
// (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM; the older names
// SMTP_PASSWORD and SMTP_FROM still work). Without SMTP every email is
// skipped, never an error. Tests replace the mailer with setMailer().

const nodemailer = require('nodemailer');
const { TIMEOUT_MS, inTests } = require('./transport');

let mailerOverride = null;
let cached = null;

function smtpConfig(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const from = (env.MAIL_FROM || env.SMTP_FROM || '').trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT) || 465;
  const user = env.SMTP_USER || '';
  const pass = env.SMTP_PASS || env.SMTP_PASSWORD || '';
  return { host, port, secure: port === 465, from, auth: user ? { user, pass } : undefined };
}

/** For tests: an object with sendMail(message) -> Promise. null restores nodemailer. */
function setMailer(mailer) {
  mailerOverride = mailer;
}

function mailerFor(config) {
  if (mailerOverride) return mailerOverride;
  if (inTests()) return null;
  const key = `${config.host}:${config.port}:${config.auth ? config.auth.user : ''}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      mailer: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      }),
    };
  }
  return cached.mailer;
}

const PERMANENT = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE']);

/** Sends one plain-text email. Returns { ok } or { ok: false, error, retryable, skip }. */
async function send({ to, subject, text }, env = process.env) {
  const config = smtpConfig(env);
  if (!config) return { ok: false, error: 'smtp_not_configured', skip: true };
  if (!to) return { ok: false, error: 'no_contact', skip: true };
  const mailer = mailerFor(config);
  if (!mailer) return { ok: false, error: 'network_disabled_in_tests', retryable: false };
  try {
    await mailer.sendMail({ from: config.from, to, subject, text });
    return { ok: true };
  } catch (err) {
    const code = String(err.code || 'smtp_error').slice(0, 40);
    return { ok: false, error: code, retryable: !PERMANENT.has(code) && !(err.responseCode >= 500 && err.responseCode < 600) };
  }
}

module.exports = { send, smtpConfig, setMailer };
