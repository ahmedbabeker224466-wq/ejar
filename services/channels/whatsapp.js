'use strict';

// WhatsApp through a provider interface. One provider today: Meta WhatsApp
// Cloud API, template messages only (the office supplies phone_number_id and
// an access token in its settings, plus an approved template whose body has
// two parameters: {{1}} title, {{2}} text). A new provider is one more entry
// in PROVIDERS with the same send() shape.

const { postJson, outcome } = require('./transport');

const GRAPH_VERSION = 'v20.0';

// WhatsApp template parameters may not contain new lines, tabs or more than
// four spaces in a row.
function templateParam(text, max = 1000) {
  return String(text || '').replace(/\s*\n+\s*/g, ' - ').replace(/[\t ]{2,}/g, ' ').trim().slice(0, max);
}

const PROVIDERS = {
  meta: {
    label: 'Meta WhatsApp Cloud API',
    secretFields: ['token'],
    async send({ config, settings, to, title, body }) {
      if (!config || !config.token || !config.phone_number_id) return { ok: false, error: 'channel_not_configured', skip: true };
      const res = await postJson(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(config.phone_number_id)}/messages`,
        {
          messaging_product: 'whatsapp',
          to: String(to).replace(/^\+/, ''),
          type: 'template',
          template: {
            name: (settings && settings.template_name) || 'aqdi_reminder',
            language: { code: (settings && settings.language) || 'ar' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: templateParam(title, 160) }, { type: 'text', text: templateParam(body) }] }],
          },
        },
        { headers: { Authorization: `Bearer ${config.token}` } },
      );
      return outcome(res);
    },
  },
};

function provider(name) {
  return PROVIDERS[name] || null;
}

/** Sends through the office's provider. to is E.164 ('+9665XXXXXXXX'). */
async function send({ providerName = 'meta', config, settings, to, title, body }) {
  if (!to) return { ok: false, error: 'no_contact', skip: true };
  const p = provider(providerName);
  if (!p) return { ok: false, error: 'unknown_provider', skip: true };
  return p.send({ config, settings, to, title, body });
}

module.exports = { send, provider, PROVIDERS, templateParam, GRAPH_VERSION };
