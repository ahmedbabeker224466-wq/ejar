'use strict';

// A person's verified addresses for outside channels (user_contacts).
// - Telegram: the person asks for a one-time code (8 characters, 15 minutes,
//   stored as a hash), sends it to the office's bot, and the bot's webhook
//   links that chat. Telegram private chat ids equal the person's Telegram id,
//   so one link works with every office bot the person has started.
// - WhatsApp: the login phone (already verified by the login code) with one
//   tap, or another number confirmed by an SMS code.
// Numbers are shown masked; they are never logged in full.

const crypto = require('crypto');
const { generateInviteCode } = require('./inviteCode');
const { normalizeCode } = require('./invites');
const { scopeToOffice } = require('./scopeToOffice');
const { membershipsFor } = require('./offices');
const { landlordLinks, tenantLinks } = require('./memberships');
const { normalizeSaudi, toE164, maskPhone } = require('../utils/phone');

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const CODE_MINUTES = 15;

async function ensureRow(pool, userId) {
  await pool.query('INSERT IGNORE INTO user_contacts (user_id) VALUES (?)', [userId]);
}

async function contactsOf(pool, userId) {
  const [[row]] = await pool.query('SELECT * FROM user_contacts WHERE user_id = ?', [userId]);
  return row || {};
}

/** What the settings page shows (numbers masked, never the code hash). */
async function contactsView(pool, user) {
  const row = await contactsOf(pool, user.id);
  const canonical = (e164) => (e164 ? String(e164).replace(/^\+/, '') : null);
  return {
    whatsapp: row.whatsapp_verified_at && row.whatsapp_e164 ? maskPhone(canonical(row.whatsapp_e164)) : null,
    whatsappIsLogin: Boolean(row.whatsapp_e164 && canonical(row.whatsapp_e164) === user.phone),
    whatsappPending: row.whatsapp_pending ? maskPhone(canonical(row.whatsapp_pending)) : null,
    loginPhone: maskPhone(user.phone),
    telegramLinked: Boolean(row.telegram_verified_at && row.telegram_chat_id),
  };
}

// ------------------------------------------------------------ Telegram

/** A fresh one-time code for linking Telegram (replaces any earlier one). */
async function createTelegramCode(pool, userId) {
  await ensureRow(pool, userId);
  const code = generateInviteCode();
  await pool.query(
    `UPDATE user_contacts SET telegram_code_hash = ?, telegram_code_expires_at = UTC_TIMESTAMP() + INTERVAL ${CODE_MINUTES} MINUTE
      WHERE user_id = ?`,
    [sha256(code), userId],
  );
  return { code, minutes: CODE_MINUTES };
}

/** The code typed in the bot chat ("/start CODE" or "CODE"), normalized, or null. */
function codeFromMessage(text) {
  const words = String(text || '').trim().split(/\s+/);
  const candidate = words[0] === '/start' || /^\/start@/.test(words[0] || '') ? words.slice(1).join('') : words.join('');
  return normalizeCode(candidate);
}

/** Links the chat to whoever holds this unexpired code. Returns the user id or null. */
async function linkTelegram(pool, { code, chatId }) {
  if (!code || !/^-?\d{1,20}$/.test(String(chatId))) return null;
  const hash = sha256(code);
  const [[row]] = await pool.query(
    'SELECT user_id FROM user_contacts WHERE telegram_code_hash = ? AND telegram_code_expires_at > UTC_TIMESTAMP()',
    [hash],
  );
  if (!row) return null;
  const [result] = await pool.query(
    `UPDATE user_contacts SET telegram_chat_id = ?, telegram_verified_at = UTC_TIMESTAMP(),
            telegram_code_hash = NULL, telegram_code_expires_at = NULL
      WHERE user_id = ? AND telegram_code_hash = ? AND telegram_code_expires_at > UTC_TIMESTAMP()`,
    [String(chatId), row.user_id, hash],
  );
  return result.affectedRows === 1 ? Number(row.user_id) : null;
}

async function unlinkTelegram(pool, userId) {
  await pool.query(
    'UPDATE user_contacts SET telegram_chat_id = NULL, telegram_verified_at = NULL, telegram_code_hash = NULL, telegram_code_expires_at = NULL WHERE user_id = ?',
    [userId],
  );
}

/** Bot user names of the offices this person deals with (to tell them where to send the code). */
async function botsFor(pool, userId) {
  const ids = new Set();
  for (const m of await membershipsFor(pool, userId)) if (m.is_active) ids.add(Number(m.office_id));
  for (const l of await landlordLinks(pool, userId)) ids.add(l.office_id);
  for (const t of await tenantLinks(pool, userId)) ids.add(t.office_id);
  const bots = [];
  for (const officeId of ids) {
    const [row] = await scopeToOffice(pool, officeId).query(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(public_json, '$.bot_username')) AS bot FROM channel_settings
        WHERE channel = 'telegram' AND enabled = 1 AND office_id = :office_id`,
    );
    if (row && row.bot && row.bot !== 'null') bots.push(row.bot);
  }
  return [...new Set(bots)];
}

// ------------------------------------------------------------ WhatsApp

/** Uses the login phone (verified when the person signed in). */
async function useLoginPhone(pool, user) {
  await ensureRow(pool, user.id);
  await pool.query(
    'UPDATE user_contacts SET whatsapp_e164 = ?, whatsapp_verified_at = UTC_TIMESTAMP(), whatsapp_pending = NULL WHERE user_id = ?',
    [toE164(user.phone), user.id],
  );
}

/** Starts a number change: sends an SMS code. Returns { ok } or { ok: false, error }. */
async function startWhatsappChange(pool, { userId, phone: input, ip, otp }) {
  const phone = normalizeSaudi(input);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  const sent = await otp.request(phone, 'verify', ip);
  if (!sent.ok) return { ok: false, error: sent.error };
  await ensureRow(pool, userId);
  await pool.query('UPDATE user_contacts SET whatsapp_pending = ? WHERE user_id = ?', [toE164(phone), userId]);
  return { ok: true };
}

/** Confirms the pending number with its SMS code. Returns { ok } or { ok: false, error }. */
async function finishWhatsappChange(pool, { userId, code, otp }) {
  const row = await contactsOf(pool, userId);
  if (!row.whatsapp_pending) return { ok: false, error: 'nothing_pending' };
  const checked = await otp.verify(String(row.whatsapp_pending).replace(/^\+/, ''), code, 'verify');
  if (!checked.ok) return { ok: false, error: checked.error };
  await pool.query(
    'UPDATE user_contacts SET whatsapp_e164 = whatsapp_pending, whatsapp_verified_at = UTC_TIMESTAMP(), whatsapp_pending = NULL WHERE user_id = ? AND whatsapp_pending = ?',
    [userId, row.whatsapp_pending],
  );
  return { ok: true };
}

async function removeWhatsapp(pool, userId) {
  await pool.query('UPDATE user_contacts SET whatsapp_e164 = NULL, whatsapp_verified_at = NULL, whatsapp_pending = NULL WHERE user_id = ?', [userId]);
}

module.exports = {
  contactsView,
  createTelegramCode,
  codeFromMessage,
  linkTelegram,
  unlinkTelegram,
  botsFor,
  useLoginPhone,
  startWhatsappChange,
  finishWhatsappChange,
  removeWhatsapp,
  CODE_MINUTES,
};
