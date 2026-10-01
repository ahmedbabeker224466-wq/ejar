'use strict';

// Telegram Bot API through built-in https: sendMessage, getMe and setWebhook
// with the office's bot token. The token is part of the URL, so a URL is
// never logged.

const { postJson, outcome } = require('./transport');

const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/;

function isToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function api(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Plain text (no parse_mode), so nothing in it is interpreted as markup. */
async function send({ token, chatId, text }) {
  if (!isToken(token)) return { ok: false, error: 'channel_not_configured', skip: true };
  if (!chatId) return { ok: false, error: 'no_contact', skip: true };
  const res = await postJson(api(token, 'sendMessage'), { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
  return outcome(res);
}

/** The bot's user name, or null. */
async function getMe(token) {
  if (!isToken(token)) return null;
  const res = await postJson(api(token, 'getMe'), {});
  return outcome(res).ok && res.json && res.json.result ? res.json.result.username || null : null;
}

/** Points the bot's updates at our webhook URL. Returns { ok } or { ok: false, error }. */
async function setWebhook(token, url) {
  if (!isToken(token)) return { ok: false, error: 'invalid_token' };
  return outcome(await postJson(api(token, 'setWebhook'), { url, allowed_updates: ['message'] }));
}

module.exports = { send, getMe, setWebhook, isToken };
