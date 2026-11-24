'use strict';

// Admin sign-in at /admin/login (routes/adminLogin.js): PLATFORM_ADMIN_EMAIL and
// PLATFORM_ADMIN_PASSWORD; one generic error; the authenticator step only once
// turned on at /admin/security; the address is never in the audit row. Database parts run only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { retryOnDeadlock } = require('../services/transaction');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Phones 9665000034NN, emails al-...@aqdi-test.example.
const phone = (n) => `9665000034${String(n).padStart(2, '0')}`;
const ADMIN = 'al-admin@aqdi-test.example';
const saved = {};
let db;
let http;
let routes;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
process.env.SECRET_BOX_KEY = process.env.SECRET_BOX_KEY || '0123456789abcdef'.repeat(4);

const PASSWORD = 'al-test-password-123';

test('admin email and password are read from the environment', () => {
  const { adminEmail, adminPassword } = require('../routes/adminLogin');
  assert.equal(adminEmail({ PLATFORM_ADMIN_EMAIL: ' CEO@Mi3aad.com ' }), 'ceo@mi3aad.com');
  assert.equal(adminEmail({}), null);
  assert.equal(adminPassword({ PLATFORM_ADMIN_PASSWORD: 'short' }), null, 'under 8 characters = off');
  assert.equal(adminPassword({ PLATFORM_ADMIN_PASSWORD: PASSWORD }), PASSWORD);
});

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'PLATFORM_ADMIN_PHONE', 'PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD', 'REQUIRE_ADMIN_2FA']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.PLATFORM_ADMIN_PHONE = phone(1);
  process.env.PLATFORM_ADMIN_EMAIL = ADMIN;
  process.env.PLATFORM_ADMIN_PASSWORD = PASSWORD;
  process.env.REQUIRE_ADMIN_2FA = 'false';
  db = require('../config/db');
  await db.ensureSchema();
  routes = require('../routes/adminLogin');
  await cleanup();
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'platform_admin')", [phone(1)]);
  http = createOfficeHttp(db);
  await http.start();
});

async function cleanup() {
  const ids = 'SELECT id FROM users WHERE phone LIKE \'9665000034%\'';
  await db.pool.query(`DELETE FROM audit_logs WHERE actor_id IN (${ids}) OR (entity_type = 'user' AND entity_id IN (${ids}))`);
  await retryOnDeadlock(() => db.pool.query("DELETE FROM users WHERE phone LIKE '9665000034%'"), { retries: 5 });
}

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

const cookieOf = (res, name) => {
  const c = res.response.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
};
const signIn = (email, password) => http.request('/admin/login', { method: 'POST', form: { email, password } });

test('anonymous /admin goes to /admin/login, which is not indexable', { skip }, async () => {
  const r = await http.request('/admin');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/login');
  const page = await http.request('/admin/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /name="password"/);
  assert.equal(page.response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('a wrong email or password: one generic answer, no session', { skip }, async () => {
  routes.limit.counter.reset();
  for (const [email, password] of [['al-other@aqdi-test.example', PASSWORD], [ADMIN, 'wrong-password-000'], [ADMIN, '']]) {
    const r = await signIn(email, password);
    assert.equal(r.status, 401);
    assert.match(r.text, /البريد الإلكتروني أو كلمة المرور غير صحيحة/);
    assert.equal(cookieOf(r, 'aqdi_session'), null);
  }
});

test('the right email and password sign in; 2FA is optional and turned on inside', { skip }, async () => {
  routes.limit.counter.reset();
  const ok = await signIn(' AL-Admin@aqdi-test.example ', PASSWORD);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin');
  const session = cookieOf(ok, 'aqdi_session');
  assert.ok(session);

  const page = await http.request('/admin/security', { cookie: session });
  assert.equal(page.status, 200);
  assert.match(page.text, /غير مفعّل/);
  const wrong = await http.request('/admin/security/2fa', { method: 'POST', cookie: session, form: { code: '000000' } });
  assert.equal(wrong.status, 422);

  // Turn it on with a real code from the sealed secret.
  const [[row]] = await db.pool.query('SELECT twofa_secret FROM users WHERE phone = ?', [phone(1)]);
  const secret = require('../services/secretBox').open(row.twofa_secret);
  const code = require('../services/totp').generateCode(secret, Date.now());
  const on = await http.request('/admin/security/2fa', { method: 'POST', cookie: session, form: { code } });
  assert.equal(on.status, 200);
  assert.match(on.text, /رموز الاحتياط/);

  routes.limit.counter.reset();
  const next = await signIn(ADMIN, PASSWORD);
  assert.equal(next.location, '/login/2fa', 'now the authenticator step follows');
  assert.equal(cookieOf(next, 'aqdi_session'), null);
  assert.ok(cookieOf(next, 'aqdi_mfa'));

  const [rows] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'auth.admin_login' AND actor_id IN (SELECT id FROM users WHERE phone = ?)", [phone(1)]);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!String(r.after_json).includes('@'), 'the address is never audited');
});

test('2FA can be turned off inside with a current code', { skip }, async () => {
  routes.limit.counter.reset();
  // Sign in through the authenticator step (it is on after the previous test).
  const [[row]] = await db.pool.query('SELECT id, twofa_secret FROM users WHERE phone = ?', [phone(1)]);
  const secret = require('../services/secretBox').open(row.twofa_secret);
  const totp = require('../services/totp');
  const step = await signIn(ADMIN, PASSWORD);
  const two = await http.request('/login/2fa', { method: 'POST', cookie: cookieOf(step, 'aqdi_mfa'), form: { code: totp.generateCode(secret, Date.now()) } });
  const session = cookieOf(two, 'aqdi_session');
  assert.ok(session, `2FA step answered ${two.status}`);

  const wrong = await http.request('/admin/security/2fa/disable', { method: 'POST', cookie: session, form: { code: '000000' } });
  assert.equal(wrong.status, 422);
  // A fresh code from the next time window, so the same code is not reused.
  const off = await http.request('/admin/security/2fa/disable', { method: 'POST', cookie: session, form: { code: totp.generateCode(secret, Date.now() + 30000) } });
  assert.equal(off.status, 302, off.text.slice(0, 200));
  const [[after]] = await db.pool.query('SELECT twofa_enabled, twofa_secret FROM users WHERE id = ?', [row.id]);
  assert.equal(Number(after.twofa_enabled), 0);
  assert.equal(after.twofa_secret, null);

  routes.limit.counter.reset();
  const direct = await signIn(ADMIN, PASSWORD);
  assert.equal(direct.location, '/admin', 'email and password only again');
});
