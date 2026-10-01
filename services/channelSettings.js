'use strict';

// Per office WhatsApp and Telegram credentials (channel_settings). Secrets are
// sealed with SECRET_BOX_KEY (services/secretBox.js), never logged and never
// sent back to the browser: summary() says only whether a channel is set up.
// A blank secret field on save keeps the stored value.

const crypto = require('crypto');
const secretBox = require('./secretBox');
const telegram = require('./channels/telegram');

const WHATSAPP = {
  phone_number_id: /^\d{5,30}$/,
  token: /^[A-Za-z0-9_\-.|]{20,1000}$/,
  template_name: /^[a-z0-9_]{1,100}$/,
  language: /^[a-z]{2}(_[A-Z]{2})?$/,
};

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function parsePublic(row) {
  if (!row || !row.public_json) return {};
  return typeof row.public_json === 'string' ? JSON.parse(row.public_json) : row.public_json;
}

/** What the settings page may show: configured or not, and non-secret settings. */
async function summary(scoped) {
  const rows = await scoped.select('channel_settings', {}, { columns: ['channel', 'enabled', 'public_json'] });
  const out = { whatsapp: { configured: false, enabled: false, settings: {} }, telegram: { configured: false, enabled: false, settings: {} } };
  for (const row of rows) out[row.channel] = { configured: true, enabled: Boolean(Number(row.enabled)), settings: parsePublic(row) };
  return out;
}

/** The decrypted settings for sending, or null when missing or turned off. */
async function loadForSending(scoped, channel) {
  const row = await scoped.selectOne('channel_settings', { channel });
  if (!row || !Number(row.enabled)) return null;
  return { provider: row.provider, config: JSON.parse(secretBox.open(row.config_sealed)), settings: parsePublic(row) };
}

async function storedConfig(scoped, channel) {
  const row = await scoped.selectOne('channel_settings', { channel });
  return row ? JSON.parse(secretBox.open(row.config_sealed)) : null;
}

async function upsert(scoped, channel, { provider, config, settings, webhookSecretHash = null, enabled, actorId }) {
  await scoped.query(
    `INSERT INTO channel_settings (office_id, channel, provider, config_sealed, public_json, webhook_secret_hash, enabled, updated_by)
     VALUES (:office_id, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), config_sealed = VALUES(config_sealed), public_json = VALUES(public_json),
       webhook_secret_hash = COALESCE(VALUES(webhook_secret_hash), webhook_secret_hash), enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
    [channel, provider, secretBox.seal(JSON.stringify(config)), JSON.stringify(settings), webhookSecretHash, enabled ? 1 : 0, actorId],
  );
}

/** Saves the WhatsApp form. Returns { ok } or { ok: false, errors }. */
async function saveWhatsapp(scoped, body = {}, actorId) {
  const current = (await storedConfig(scoped, 'whatsapp')) || {};
  const value = (k) => String(body[k] ?? '').trim();
  const config = {
    phone_number_id: value('phone_number_id') || current.phone_number_id || '',
    token: value('token') || current.token || '',
  };
  const settings = { template_name: value('template_name') || 'aqdi_reminder', language: value('language') || 'ar' };
  const errors = {};
  if (!WHATSAPP.phone_number_id.test(config.phone_number_id)) errors.phone_number_id = 'اكتب معرف رقم الهاتف (أرقام فقط) من حساب واتساب للأعمال.';
  if (!WHATSAPP.token.test(config.token)) errors.token = 'اكتب رمز الوصول (Access Token) كما هو.';
  if (!WHATSAPP.template_name.test(settings.template_name)) errors.template_name = 'اسم القالب حروف إنجليزية صغيرة وأرقام و _ فقط.';
  if (!WHATSAPP.language.test(settings.language)) errors.language = 'رمز اللغة مثل ar.';
  if (Object.keys(errors).length) return { ok: false, errors };
  await upsert(scoped, 'whatsapp', { provider: 'meta', config, settings, enabled: body.enabled !== '0', actorId });
  return { ok: true };
}

/**
 * Saves the Telegram bot token, reads the bot user name and points the bot's
 * webhook at /webhooks/telegram/<new random secret>. Returns { ok, warning }
 * or { ok: false, errors }.
 */
async function saveTelegram(scoped, body = {}, actorId, { appUrl = process.env.APP_URL } = {}) {
  const current = (await storedConfig(scoped, 'telegram')) || {};
  const token = String(body.token ?? '').trim() || current.token || '';
  if (!telegram.isToken(token)) return { ok: false, errors: { token: 'اكتب رمز البوت كما وصلك من BotFather.' } };
  const secret = crypto.randomBytes(32).toString('base64url');
  const username = await telegram.getMe(token);
  let warning = null;
  if (!username) warning = 'تعذر التحقق من البوت. تأكد من الرمز ثم احفظ مرة أخرى.';
  const base = String(appUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    warning = 'اضبط APP_URL (يبدأ بـ https) حتى يستقبل البوت رموز الربط.';
  } else {
    const hooked = await telegram.setWebhook(token, `${base}/webhooks/telegram/${secret}`);
    if (!hooked.ok) warning = 'حُفظ الرمز لكن تعذر ربط البوت بالموقع. احفظ مرة أخرى بعد قليل.';
  }
  await upsert(scoped, 'telegram', {
    provider: 'telegram', config: { token }, settings: { bot_username: username || null }, webhookSecretHash: sha256(secret), enabled: body.enabled !== '0', actorId,
  });
  return { ok: true, warning };
}

async function remove(scoped, channel) {
  return scoped.remove('channel_settings', { channel });
}

/**
 * The office whose Telegram webhook secret this is, or null. Looked up across
 * offices by design (Telegram calls us without a session); the stored hash is
 * compared in constant time.
 */
async function telegramBySecret(pool, secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(secret)) return null;
  const hash = sha256(secret);
  const [rows] = await pool.query(
    "SELECT office_id, webhook_secret_hash, config_sealed, enabled FROM channel_settings WHERE channel = 'telegram' AND webhook_secret_hash = ? LIMIT 1",
    [hash],
  );
  const row = rows[0];
  if (!row || !row.webhook_secret_hash) return null;
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(row.webhook_secret_hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { officeId: Number(row.office_id), token: JSON.parse(secretBox.open(row.config_sealed)).token };
}

module.exports = { summary, loadForSending, saveWhatsapp, saveTelegram, remove, telegramBySecret, sha256 };
