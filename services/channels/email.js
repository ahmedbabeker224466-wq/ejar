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

const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The HTML version of a plain-text email: the logo on top, the text as
 * paragraphs (escaped, line breaks kept), the site link at the bottom.
 * Right to left when the text is Arabic. Built only from the text, so the
 * two versions always say the same thing.
 */
function htmlFor({ subject, text }, env = process.env) {
  const base = String(env.APP_URL || 'https://mi3aad.com').trim().replace(/\/+$/, '');
  const rtl = /[\u0600-\u06FF]/.test(`${subject || ''}${text || ''}`);
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const paragraphs = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.8;color:#0f1d45">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject || '')}</title></head>`
    + `<body style="margin:0;padding:0;background:#f4f7fd"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fd"><tr><td align="center" style="padding:28px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e1e6f1;border-radius:16px">`
    + `<tr><td style="padding:24px 28px 8px;text-align:${align}"><a href="${base}"><img src="${base}/img/email-logo-2.png" width="150" height="46" alt="miaad" style="display:inline-block;border:0;width:150px;height:auto"></a></td></tr>`
    + `<tr><td dir="${dir}" style="padding:12px 28px 14px;text-align:${align};font-family:Tahoma,'Segoe UI',Arial,sans-serif">`
    + (subject ? `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.5;color:#0f1d45">${escapeHtml(subject)}</h1>` : '')
    + paragraphs + `</td></tr>`
    + `<tr><td style="padding:14px 28px 22px;border-top:1px solid #e1e6f1;text-align:${align};font-family:Tahoma,Arial,sans-serif;font-size:13px;color:#8f9bbd"><a href="${base}" style="color:#1b6af5;text-decoration:none">mi3aad.com</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

// The in-app disclaimer line is left out of emails (owner's decision, Nov 2026).
const EMAIL_DROPPED_LINE = 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط';

function withoutDisclaimer(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== EMAIL_DROPPED_LINE)
    .join('\n\n')
    .trim();
}

/** Sends one plain-text email. Returns { ok } or { ok: false, error, retryable, skip }. */
async function send({ to, subject, text: rawText }, env = process.env) {
  const text = withoutDisclaimer(rawText);
  const config = smtpConfig(env);
  if (!config) return { ok: false, error: 'smtp_not_configured', skip: true };
  if (!to) return { ok: false, error: 'no_contact', skip: true };
  const mailer = mailerFor(config);
  if (!mailer) return { ok: false, error: 'network_disabled_in_tests', retryable: false };
  try {
    await mailer.sendMail({ from: config.from, to, subject, text, html: htmlFor({ subject, text }, env) });
    return { ok: true };
  } catch (err) {
    const code = String(err.code || 'smtp_error').slice(0, 40);
    return { ok: false, error: code, retryable: !PERMANENT.has(code) && !(err.responseCode >= 500 && err.responseCode < 600) };
  }
}

module.exports = { send, smtpConfig, setMailer, htmlFor, withoutDisclaimer };
