'use strict';

// Unifonic REST API. SMS_API_KEY is the AppSid; SMS_SENDER the approved sender ID.
const { httpsPost, parseJson } = require('./httpsPost');

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
};
