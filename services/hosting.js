'use strict';

// Attaches an office's own domain to this hosting account so the server answers
// for it (cPanel "parked domain" / alias, owner's decision Nov 2026: connecting
// is automatic). Two drivers, both built-in Node only:
//   token: CPANEL_HOST + CPANEL_USER + CPANEL_API_TOKEN (env) -> HTTPS to
//          https://<host>:2083 with "Authorization: cpanel user:token".
//   cli:   the cPanel command line tool cpapi2 / uapi on the same server
//          (execFile, never a shell; the domain is validated before it gets here).
// No driver configured = { ok: false, code: 'hosting_off' }: the caller keeps the
// request open and the platform admin finishes it by hand.
// The token is never logged, returned or put in an error; errors carry a short code.
// Under the node test runner nothing real is called unless a mock is set.

const https = require('node:https');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const CLI_DIRS = ['/usr/local/cpanel/bin', '/usr/bin'];
const TIMEOUT_MS = 20000;

let mock = null;
/** For tests: { attach(domain), detach(domain), mode } replaces the real driver; null restores it. */
function setMock(m) {
  mock = m;
}

function underTest() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

function tokenConfig(env = process.env) {
  const host = String(env.CPANEL_HOST || '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  const user = String(env.CPANEL_USER || '').trim();
  const token = String(env.CPANEL_API_TOKEN || '').trim();
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9_]+$/i.test(user) || !/^[A-Z0-9]{20,}$/i.test(token)) return null;
  return { host, user, token };
}

function cliPath(name) {
  for (const dir of CLI_DIRS) {
    const full = `${dir}/${name}`;
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Which driver would run: 'token' | 'cli' | 'off' (and 'mock' in tests). */
function mode(env = process.env) {
  if (mock) return mock.mode || 'mock';
  if (tokenConfig(env)) return 'token';
  if (!underTest() && cliPath('cpapi2')) return 'cli';
  return 'off';
}

function httpsJson(cfg, path) {
  return new Promise((resolve) => {
    const req = https.request({
      host: cfg.host, port: 2083, method: 'GET', path,
      headers: { Authorization: `cpanel ${cfg.user}:${cfg.token}`, Accept: 'application/json' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return resolve({ ok: false, code: 'hosting_auth' });
        try {
          resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ ok: false, code: 'hosting_bad_reply' });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, code: err.message === 'timeout' ? 'hosting_timeout' : 'hosting_unreachable' }));
    req.end();
  });
}

function runCli(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, [...args, '--output=json'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, code: 'hosting_cli_failed' });
      try {
        resolve({ ok: true, json: JSON.parse(String(stdout)) });
      } catch {
        resolve({ ok: false, code: 'hosting_bad_reply' });
      }
    });
  });
}

// API2 answers { cpanelresult: { data: [{ result: 1|0, reason }], error? } };
// an already parked domain counts as done.
function api2Done(json) {
  const r = json && (json.cpanelresult || json.result || json);
  const row = r && Array.isArray(r.data) ? r.data[0] : null;
  if (row && Number(row.result) === 1) return true;
  const text = String((row && row.reason) || (r && r.error) || '');
  return /already|exists|is not parked|not found/i.test(text) && !/denied|permission|maximum|limit/i.test(text);
}

async function api2(func, domain, env) {
  const cfg = tokenConfig(env);
  if (cfg) {
    const q = new URLSearchParams({ cpanel_jsonapi_user: cfg.user, cpanel_jsonapi_apiversion: '2', cpanel_jsonapi_module: 'Park', cpanel_jsonapi_func: func, domain });
    const reply = await httpsJson(cfg, `/json-api/cpanel?${q}`);
    if (!reply.ok) return reply;
    return api2Done(reply.json) ? { ok: true } : { ok: false, code: `hosting_${func}_refused` };
  }
  const bin = cliPath('cpapi2');
  if (!bin || underTest()) return { ok: false, code: 'hosting_off' };
  const reply = await runCli(bin, ['Park', func, `domain=${domain}`]);
  if (!reply.ok) return reply;
  return api2Done(reply.json) ? { ok: true } : { ok: false, code: `hosting_${func}_refused` };
}

/** Asks AutoSSL to run now so https works soon. Best effort: never fails the connect. */
async function requestSsl(env = process.env) {
  const cfg = tokenConfig(env);
  if (cfg) {
    const reply = await httpsJson(cfg, '/execute/SSL/start_autossl_check');
    return reply.ok && reply.json && Number(reply.json.status) === 1;
  }
  const bin = cliPath('uapi');
  if (!bin || underTest()) return false;
  const reply = await runCli(bin, ['SSL', 'start_autossl_check']);
  return reply.ok;
}

/** Makes the server answer for the domain (and www.). Returns { ok, ssl } or { ok: false, code }. */
async function attach(domain, env = process.env) {
  if (mock) return mock.attach(domain);
  if (mode(env) === 'off') return { ok: false, code: 'hosting_off' };
  const parked = await api2('park', domain, env);
  if (!parked.ok) return parked;
  return { ok: true, ssl: await requestSsl(env) };
}

/** Stops answering for the domain. Best effort. Returns { ok } or { ok: false, code }. */
async function detach(domain, env = process.env) {
  if (mock) return mock.detach ? mock.detach(domain) : { ok: true };
  if (mode(env) === 'off') return { ok: false, code: 'hosting_off' };
  return api2('unpark', domain, env);
}

module.exports = { mode, attach, detach, requestSsl, setMock, tokenConfig, api2Done };
