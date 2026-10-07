'use strict';

// Unifonic REST API. SMS_API_KEY is the AppSid; SMS_SENDER the approved sender ID.
const { httpsPost, parseJson } = require('./httpsPost');

const BALANCE_ENDPOINT = 'https://el.cloud.unifonic.com/rest/Account/GetBalance';

const ENDPOINT = 'https://el.cloud.unifonic.com/rest/SMS/messages';

module.exports = {
  name: 'unifonic',
  async send(toE164, message) {
    const appSid = process.env.SMS_API_KEY;
    const sender = process.env.SMS_SENDER;
    if (!appSid || !sender) return { ok: false, providerRef: null, error: 'not_configured' };

    const body = new URLSearchParams({
      AppSid: appSid,
      SenderID: sender,
      Recipient: toE164.replace(/^\+/, ''),
      Body: message,
    }).toString();

    const response = await httpsPost(ENDPOINT, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (response.error) return { ok: false, providerRef: null, error: response.error };

    const json = parseJson(response.body);
    if (response.status !== 200 || !json || json.success !== true) {
      return { ok: false, providerRef: null, error: `http_${response.status}` };
    }
    return { ok: true, providerRef: String(json.data?.MessageID ?? ''), error: null };
  },

  /**
   * The remaining balance as { supported: true, ok, balance } (a number) or
   * { supported: true, ok: false, error }. The request shape follows Unifonic's
   * public documentation and must be checked once with a real account.
   */
  async getBalance(post = httpsPost) {
    const appSid = process.env.SMS_API_KEY;
    if (!appSid) return { supported: true, ok: false, error: 'not_configured' };
    const response = await post(BALANCE_ENDPOINT, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ AppSid: appSid }).toString(),
    });
    if (response.error) return { supported: true, ok: false, error: response.error };
    const json = parseJson(response.body);
    const value = json && json.data ? Number(json.data.Balance ?? json.data.balance) : NaN;
    if (response.status !== 200 || !json || json.success === false || !Number.isFinite(value)) {
      return { supported: true, ok: false, error: response.status === 200 ? 'bad_response' : `http_${response.status}` };
    }
    return { supported: true, ok: true, balance: value };
  },
};
