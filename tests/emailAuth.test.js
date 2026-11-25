'use strict';

// Email account helpers (services/emailAuth.js): address validation, the
// migration (nullable phone, unique case-insensitive email), notification
// settings and the set-user-email script. The code-less test sign-in
// (AUTH_EMAIL_TEST) was removed before launch (Nov 2026); the email-code
// sign-in is tested in tests/emailCodeReview.test.js. Database parts run only
// when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const emailAuth = require('../services/emailAuth');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file uses: 9665000028NN. Every email: ea-...@aqdi-test.example.
const phone = (n) => `9665000028${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const mail = (name) => `ea-${name}@aqdi-test.example`;
const saved = {};
let db;
let http;
let authRoutes;

// ------------------------------------------------------------ pure

test('emails are trimmed, lower-cased and validated', () => {
  assert.equal(emailAuth.normalizeEmail('  Owner@Example.SA '), 'owner@example.sa');
  for (const bad of ['', 'no-at', 'a@b', 'a@b.c', '@example.com', 'a b@example.com', 'a@exa mple.com', `${'x'.repeat(190)}@e.com`, null, 5, ['a@b.com']]) {
    assert.equal(emailAuth.normalizeEmail(bad), null, String(bad));
  }
});

// ------------------------------------------------------------ database

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'AUTH_EMAIL_TEST', 'LAUNCH_MODE', 'PLATFORM_ADMIN_PHONE']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  delete process.env.AUTH_EMAIL_TEST;
  delete process.env.LAUNCH_MODE;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  authRoutes = require('../routes/auth');
  http = createOfficeHttp(db);
  await http.start();
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  const owners = `SELECT id FROM users WHERE phone IN (${marks}) OR email LIKE 'ea-%@aqdi-test.example'`;
  await db.pool.query(`DELETE FROM audit_logs WHERE actor_id IN (${owners}) OR (entity_type = 'user' AND entity_id IN (${owners}))`, [...PHONES, ...PHONES]);
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (${owners})`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM users WHERE phone IN (${marks}) OR email LIKE 'ea-%@aqdi-test.example'`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES), { retries: 5 });
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

const flag = (on) => {
  if (on) process.env.AUTH_EMAIL_TEST = 'true';
  else delete process.env.AUTH_EMAIL_TEST;
  authRoutes.emailLimit.counter.reset();
};
const emailPost = (email, intent = 'login') => http.request('/login/email', { method: 'POST', form: { email, intent } });
const sessionOf = (res) => {
  const c = res.response.headers.getSetCookie().find((x) => /^aqdi_(admin_|landlord_|tenant_)?session=/.test(x));
  return c ? c.split(';')[0] : null;
};
const userByEmail = async (email) => (await db.pool.query('SELECT * FROM users WHERE email = ?', [email]))[0][0];
const auditRows = async (action, userId) => (await db.pool.query(
  'SELECT * FROM audit_logs WHERE action = ? AND entity_id <=> ? ORDER BY id', [action, userId],
))[0];
const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const BANNER = 'وضع تجريبي: الدخول بالبريد بدون رمز';
// The red email-test banner was removed at the owner's request (Nov 2026); the launch check still fails while AUTH_EMAIL_TEST is on.

test('migration: phone nullable, unique case-insensitive email, idempotent', { skip }, async () => {
  const [[col]] = await db.pool.query(
    "SELECT is_nullable AS is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'phone'",
  );
  assert.equal(col.is_nullable, 'YES');
  const [[idx]] = await db.pool.query(
    "SELECT non_unique AS non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uq_users_email'",
  );
  assert.equal(Number(idx.non_unique), 0);

  // Several users without phone or email are fine (NULLs never collide).
  await db.pool.query('INSERT INTO users (phone, email) VALUES (NULL, ?), (NULL, ?)', [mail('n1'), mail('n2')]);
  await db.pool.query('INSERT INTO users (phone, email) VALUES (?, NULL), (?, NULL)', [phone(60), phone(61)]);
  await assert.rejects(db.pool.query('INSERT INTO users (phone, email) VALUES (NULL, ?)', [mail('N1').toUpperCase()]), { code: 'ER_DUP_ENTRY' });

  // Older rows with mixed case or blanks are normalized on the next start.
  await db.pool.query('INSERT INTO users (phone, email) VALUES (?, ?), (?, ?)', [phone(62), `  ${mail('Mixed').toUpperCase()} `, phone(63), '  ']);
  assert.equal(await db.ensureUserEmailIndex(db.pool), 'present');
  const [[mixed]] = await db.pool.query('SELECT email FROM users WHERE phone = ?', [phone(62)]);
  const [[blank]] = await db.pool.query('SELECT email FROM users WHERE phone = ?', [phone(63)]);
  assert.equal(mixed.email, mail('mixed'));
  assert.equal(blank.email, null);

  for (let i = 0; i < 2; i += 1) {
    const result = await db.ensureSchema();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.created, 0);
  }
  assert.equal(await db.ensureUserEmailIndex(db.pool), 'present');
});

test('notification settings: an email used by another account is refused, not a crash', { skip }, async () => {
  await db.pool.query('INSERT INTO users (phone, email, role) VALUES (?, ?, NULL)', [phone(70), mail('taken')]);
  const { cookie } = await http.registerOffice(phone(71), 'تجربة-بريد-إعدادات');
  const res = await http.request('/settings/notifications', { method: 'POST', cookie, form: { email: mail('TAKEN').toUpperCase(), quiet_start: '21:00', quiet_end: '08:00' } });
  assert.equal(res.status, 422);
  assert.match(res.text, /مستخدم في حساب آخر/);
  const ok = await http.request('/settings/notifications', { method: 'POST', cookie, form: { email: mail('Mine'), quiet_start: '21:00', quiet_end: '08:00' } });
  assert.equal(ok.status, 302);
  assert.equal((await http.userByPhone(phone(71))).email, mail('mine'), 'stored lower-case');
});

test('set-user-email: gives an existing phone user an email, with clear refusals', { skip }, async () => {
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'office_owner')", [phone(80)]);
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'platform_admin')", [phone(81)]);
  await db.pool.query('INSERT INTO users (phone, email) VALUES (?, ?)', [phone(82), mail('other')]);
  const set = (p, e) => emailAuth.setUserEmail(db.pool, p, e);
  const local = (n) => `0${phone(n).slice(3)}`;

  assert.deepEqual(await set('12345', mail('x')), { ok: false, error: 'invalid_phone' });
  assert.deepEqual(await set(local(80), 'nope'), { ok: false, error: 'invalid_email' });
  assert.deepEqual(await set(local(89), mail('x')), { ok: false, error: 'no_user' });
  assert.deepEqual(await set(local(81), mail('x')), { ok: false, error: 'platform_admin' });
  assert.deepEqual(await set(local(80), mail('OTHER')), { ok: false, error: 'taken' });

  const done = await set(local(80), ` ${mail('Live-Owner')} `);
  assert.equal(done.ok, true);
  assert.equal(done.changed, true);
  assert.equal((await http.userByPhone(phone(80))).email, mail('live-owner'));
  assert.equal((await set(local(80), mail('live-owner'))).changed, false, 'repeating is harmless');
  const rows = await auditRows('user.email_set', done.userId);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows[0].after_json).includes('aqdi-test'), 'never the address');

  const usage = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'set-user-email.js')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /Usage: node scripts\/set-user-email\.js <phone> <email>/);
});
