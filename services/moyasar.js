'use strict';

// Moyasar (online payment), built-in https only, TEST MODE ONLY.
//
// - Keys come from the environment only: MOYASAR_SECRET_KEY (server side),
//   MOYASAR_PUBLISHABLE_KEY (goes to the hosted form in the browser) and
//   MOYASAR_WEBHOOK_SECRET (checked on /webhooks/moyasar). Without the first
//   two the payment UI says "الدفع الإلكتروني غير مفعّل" and bank transfer
//   still works.
// - Live keys (sk_live_ / pk_live_) are refused unless MOYASAR_ALLOW_LIVE=1,
//   which must not be set before the invoicing entity is decided.
// - Card data never touches this app: the customer types it into Moyasar's
//   hosted form. We keep only the payment id, status, amount in halalas and
//   the last 4 digits when Moyasar returns them.
// - A redirect or a webhook is never trusted: the payment is always fetched
//   from the API by id (fetchPayment) and compared with the pending order.
// - Tests install a mock with setTransport(); under the node test runner
//   without one nothing leaves the machine.
//
// The API shapes below (GET /v1/payments/:id, the form's config and the
// webhook body) are written from Moyasar's public documentation; verify them
// once in test mode before launch (see DEPLOY.md).

const https = require('https');
const crypto = require('crypto');
const billing = require('../config/billing');

let transport = null;

/** Replaces the network for tests: fn({ method, url, headers, timeoutMs }) -> { status, body } | { error }. */
function setTransport(fn) {
  transport = fn;
}

function inTests() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

/** The keys and whether online payment is available. Never returns a value to the browser except the publishable key. */
function config(env = process.env) {
  const secret = String(env.MOYASAR_SECRET_KEY || '').trim();
  const publishable = String(env.MOYASAR_PUBLISHABLE_KEY || '').trim();
  const webhookSecret = String(env.MOYASAR_WEBHOOK_SECRET || '').trim();
  const allowLive = env.MOYASAR_ALLOW_LIVE === '1';
  const missing = !secret || !publishable;
  const live = secret.startsWith('sk_live_') || publishable.startsWith('pk_live_');
  const wrong = !secret.startsWith('sk_') || !publishable.startsWith('pk_');
  const refused = live && !allowLive;
  return {
    enabled: !missing && !wrong && !refused,
    reason: missing ? 'not_configured' : wrong ? 'bad_keys' : refused ? 'live_refused' : null,
    secret,
    publishable,
    webhookSecret,
    webhookEnabled: webhookSecret.length > 0,
  };
}

/** Constant-time comparison of two secrets (compared as sha256 digests so lengths never leak). */
function secretsMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function request({ method, url, headers = {}, timeoutMs = billing.MOYASAR.TIMEOUT_MS }) {
  if (transport) return Promise.resolve(transport({ method, url, headers, timeoutMs }));
  if (inTests()) return Promise.resolve({ error: 'network_disabled_in_tests' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let req;
    try {
      req = https.request(url, { method, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (data.length < 256 * 1024) data += chunk;
        });
        res.on('end', () => finish({ status: res.statusCode, body: data }));
        res.on('error', (err) => finish({ error: err.code || 'response_error' }));
      });
    } catch (err) {
      finish({ error: err.code || 'invalid_request' });
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      finish({ error: 'timeout' });
    });
    req.on('error', (err) => finish({ error: err.code || 'request_error' }));
    req.end();
  });
}

/** A Moyasar payment id looks like a UUID; anything else never reaches a URL. */
function validPaymentId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

/**
 * Fetches a payment from Moyasar by id and keeps only what we use:
 * { ok: true, payment: { id, status, amount (halalas), currency, orderId, last4 } }
 * or { ok: false, error } (a short code: no_keys, bad_id, network, http_NNN, bad_reply).
 */
async function fetchPayment(id, env = process.env) {
  const cfg = config(env);
  if (!cfg.enabled) return { ok: false, error: 'no_keys' };
  if (!validPaymentId(id)) return { ok: false, error: 'bad_id' };
  const auth = Buffer.from(`${cfg.secret}:`).toString('base64');
  const res = await request({
    method: 'GET',
    url: `${billing.MOYASAR.API_BASE}/payments/${encodeURIComponent(id)}`,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res || res.error) return { ok: false, error: 'network' };
  if (res.status !== 200) return { ok: false, error: `http_${res.status}` };
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { ok: false, error: 'bad_reply' };
  }
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || typeof body.status !== 'string') {
    return { ok: false, error: 'bad_reply' };
  }
  const number = body.source && typeof body.source.number === 'string' ? /(\d{4})$/.exec(body.source.number) : null;
  const orderId = body.metadata && body.metadata.order_id !== undefined ? String(body.metadata.order_id) : null;
  return {
    ok: true,
    payment: {
      id: body.id,
      status: body.status,
      amount: Number.isInteger(body.amount) ? body.amount : null,
      currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
      orderId: orderId && /^\d{1,18}$/.test(orderId) ? orderId : null,
      last4: number ? number[1] : null,
    },
  };
}

/**
 * The browser-side settings of Moyasar's hosted form for one order. Only the
 * publishable key is included; the callback URL is on our own origin.
 */
function formConfig({ order, description, callbackUrl, env = process.env }) {
  const cfg = config(env);
  return {
    element: '.mysr-form',
    amount: Math.round(Number(order.totalHalalas)),
    currency: order.currency,
    description,
    publishable_api_key: cfg.publishable,
    callback_url: callbackUrl,
    methods: ['creditcard'],
    metadata: { order_id: String(order.id) },
  };
}

module.exports = { setTransport, config, secretsMatch, validPaymentId, fetchPayment, formConfig };
