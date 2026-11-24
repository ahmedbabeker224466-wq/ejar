'use strict';

// Admin sign-in at /admin/login (routes/adminLogin.js): only PLATFORM_ADMIN_EMAIL
// gets a code, another address sees the same page and gets no mail, the right
// code leads to the authenticator step (never straight to a session), the
// address is never in the audit row. Database parts run only when TEST_DB_NAME is set.

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
const sent = [];
let db;
let http;
let routes;
let emailCode;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';

test('admin email is read from the environment, lower-case', () => {
  const { adminEmail } = require('../routes/adminLogin');
  assert.equal(adminEmail({ PLATFORM_ADMIN_EMAIL: ' CEO@Mi3aad.com ' }), 'ceo@mi3aad.com');
  assert.equal(adminEmail({}), null);
  assert.equal(adminEmail({ PLATFORM_ADMIN_EMAIL: 'nope' }), null);
});

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'SMTP_HOST', 'MAIL_FROM', 'PLATFORM_ADMIN_PHONE', 'PLATFORM_ADMIN_EMAIL']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.SMTP_HOST = 'smtp.aqdi-test.example';
  process.env.MAIL_FROM = 'miaad <noreply@aqdi-test.example>';
  process.env.PLATFORM_ADMIN_PHONE = phone(1);
  process.env.PLATFORM_ADMIN_EMAIL = ADMIN;
  db = require('../config/db');
  await db.ensureSchema();
  require('../services/channels/email').setMailer({ sendMail: async (m) => { sent.push(m); return {}; } });
  emailCode = require('../services/emailCode');
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
  const keys = [ADMIN, 'al-other@aqdi-test.example'].map((a) => emailCode.identify(a));
  await db.pool.query('DELETE FROM otp_codes WHERE phone IN (?, ?)', keys);
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

test('anonymous /admin goes to /admin/login, which is not indexable', { skip }, async () => {
  const r = await http.request('/admin');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/login');
  const page = await http.request('/admin/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /دخول الإدارة/);
  assert.equal(page.response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('another address: same answer, no mail, its code never works', { skip }, async () => {
  routes.limit.counter.reset();
  const before = sent.length;
  const r = await http.request('/admin/login', { method: 'POST', form: { email: 'al-other@aqdi-test.example' } });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/login/verify');
  assert.equal(sent.length, before, 'nothing mailed');
  const v = await http.request('/admin/login/verify', { method: 'POST', cookie: cookieOf(r, 'aqdi_admin_login'), form: { code: '123456' } });
  assert.equal(v.status, 422);
  assert.equal(cookieOf(v, 'aqdi_mfa'), null);
});

test('the admin address: a code, then the authenticator step, never a session yet', { skip }, async () => {
  routes.limit.counter.reset();
  const r = await http.request('/admin/login', { method: 'POST', form: { email: ' AL-Admin@aqdi-test.example ' } });
  assert.equal(r.status, 302);
  const step = cookieOf(r, 'aqdi_admin_login');
  const mail = sent[sent.length - 1];
  assert.equal(mail.to, ADMIN);
  const code = /(\d{6})/.exec(mail.text)[1];

  const wrong = await http.request('/admin/login/verify', { method: 'POST', cookie: step, form: { code: code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.status, 422);

  const ok = await http.request('/admin/login/verify', { method: 'POST', cookie: step, form: { code } });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/login/2fa/setup', 'first time: set up the authenticator');
  assert.ok(cookieOf(ok, 'aqdi_mfa'));
  assert.equal(cookieOf(ok, 'aqdi_session'), null, 'no session before the second factor');

  const [rows] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'auth.admin_login' AND actor_id IN (SELECT id FROM users WHERE phone = ?)", [phone(1)]);
  assert.ok(rows.length > 0);
  for (const row of rows) assert.ok(!String(row.after_json).includes('@'), 'the address is never audited');
});
