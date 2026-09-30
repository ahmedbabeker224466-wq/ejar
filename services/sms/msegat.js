'use strict';

// Msegat API. Needs SMS_USERNAME (account user name), SMS_API_KEY and SMS_SENDER.
const { httpsPost, parseJson } = require('./httpsPost');

const ENDPOINT = 'https://www.msegat.com/gw/sendsms.php';
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
};
