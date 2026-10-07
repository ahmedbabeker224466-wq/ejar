'use strict';

// Msegat API. Needs SMS_USERNAME (account user name), SMS_API_KEY and SMS_SENDER.
const { httpsPost, parseJson } = require('./httpsPost');

const ENDPOINT = 'https://www.msegat.com/gw/sendsms.php';
const BALANCE_ENDPOINT = 'https://www.msegat.com/gw/Credits.php';
const SUCCESS_CODES = new Set(['1', 'M0000']);

module.exports = {
  name: 'msegat',
  async send(toE164, message) {
    const userName = process.env.SMS_USERNAME;
    const apiKey = process.env.SMS_API_KEY;
    const sender = process.env.SMS_SENDER;
    if (!userName || !apiKey || !sender) return { ok: false, providerRef: null, error: 'not_configured' };

    const response = await httpsPost(ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName,
        apiKey,
        numbers: toE164.replace(/^\+/, ''),
        userSender: sender,
        msg: message,
        msgEncoding: 'UTF8',
      }),
    });
    if (response.error) return { ok: false, providerRef: null, error: response.error };

    const json = parseJson(response.body);
    const code = json && json.code !== undefined ? String(json.code) : null;
    if (response.status !== 200 || !SUCCESS_CODES.has(code)) {
      return { ok: false, providerRef: null, error: code ? `provider_${code}` : `http_${response.status}` };
    }
    return { ok: true, providerRef: String(json.id ?? json.messageId ?? ''), error: null };
  },

  /**
   * The remaining credit as { supported: true, ok, balance } (a number) or
   * { supported: true, ok: false, error }. The reply is read as a plain number
   * or a JSON object; check the shape once with a real account.
   */
  async getBalance(post = httpsPost) {
    const userName = process.env.SMS_USERNAME;
    const apiKey = process.env.SMS_API_KEY;
    if (!userName || !apiKey) return { supported: true, ok: false, error: 'not_configured' };
    const response = await post(BALANCE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'En', userName, apiKey }),
    });
    if (response.error) return { supported: true, ok: false, error: response.error };
    const text = String(response.body || '').trim();
    const json = parseJson(text);
    const raw = json && typeof json === 'object' ? json.balance ?? json.credits ?? json.credit ?? json.message : json ?? text;
    const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
    if (response.status !== 200 || !Number.isFinite(value)) {
      return { supported: true, ok: false, error: response.status === 200 ? 'bad_response' : `http_${response.status}` };
    }
    return { supported: true, ok: true, balance: value };
  },
};
