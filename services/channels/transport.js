'use strict';

// The one door to the outside for WhatsApp and Telegram: HTTPS POST with a
// 10 s timeout (built-in https, no SDK). Tests install a mock with setMock();
// under NODE_ENV=test without a mock nothing leaves the machine.

const { httpsPost, parseJson } = require('../sms/httpsPost');

const TIMEOUT_MS = 10000;
let mock = null;

/** Under NODE_ENV=test or the node test runner, nothing real is ever called. */
function inTests() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

/** Replaces the network for tests: fn(url, { headers, body }) -> { status, body } | { error }. */
function setMock(fn) {
  mock = fn;
}

async function postJson(url, payload, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const body = JSON.stringify(payload);
  const options = { headers: { 'Content-Type': 'application/json', ...headers }, body, timeoutMs };
  let res;
  if (mock) res = await mock(url, options);
  else if (inTests()) res = { error: 'network_disabled_in_tests' };
  else res = await httpsPost(url, options);
  return { ...res, json: res && res.body ? parseJson(res.body) : null };
}

/**
 * A provider reply as { ok } or { ok: false, error, retryable }. Network
 * errors, timeouts, 429 and 5xx are worth retrying; other answers are not.
 * error is a short code, never the reply body.
 */
function outcome(res) {
  if (!res || res.error) {
    return { ok: false, error: res && res.error === 'timeout' ? 'timeout' : String((res && res.error) || 'network').slice(0, 40), retryable: true };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, error: `http_${res.status}`, retryable: res.status === 429 || res.status >= 500 };
}

module.exports = { postJson, outcome, setMock, inTests, TIMEOUT_MS };
