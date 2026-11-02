'use strict';

// The TESTING-ONLY email sign-in (AUTH_EMAIL_TEST): the pure flag and guard
// functions, the production start-up refusal, and against real MySQL: flag off
// keeps the phone login, flag on shows the email pages and the banner, login
// and register (through the normal /office/new flow, trial plan), unknown
// email, case-insensitive email, platform_admin and inactive accounts refused,
// audit rows without the address, the per-IP limit, the migration and the
// set-user-email script. Database parts run only when TEST_DB_NAME is set.

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

test('flag, launch mode and start-up guard', () => {
  assert.equal(emailAuth.flagOn({}), false, 'off by default');
  assert.equal(emailAuth.flagOn({ AUTH_EMAIL_TEST: 'true' }), true);
  assert.equal(emailAuth.flagOn({ AUTH_EMAIL_TEST: ' TRUE ' }), true);
  for (const v of ['1', 'yes', 'false', '']) assert.equal(emailAuth.flagOn({ AUTH_EMAIL_TEST: v }), false, v);

  assert.equal(emailAuth.launchMode({}), 'open', 'open unless said otherwise');
  assert.equal(emailAuth.launchMode({ LAUNCH_MODE: 'Testing' }), 'testing');
  assert.equal(emailAuth.launchMode({ LAUNCH_MODE: 'beta' }), 'open');

  const on = { AUTH_EMAIL_TEST: 'true' };
  assert.equal(emailAuth.startupProblem({ ...on, NODE_ENV: 'development' }), null);
  assert.match(emailAuth.startupProblem({ ...on, NODE_ENV: 'production' }), /refused/);
  assert.match(emailAuth.startupProblem({ ...on, NODE_ENV: 'production', LAUNCH_MODE: 'open' }), /refused/);
  assert.equal(emailAuth.startupProblem({ ...on, NODE_ENV: 'production', LAUNCH_MODE: 'testing' }), null);
  assert.equal(emailAuth.startupProblem({ NODE_ENV: 'production' }), null, 'flag off: nothing to refuse');

  assert.equal(emailAuth.enabled({ ...on, NODE_ENV: 'development' }), true);
  assert.equal(emailAuth.enabled({ ...on, NODE_ENV: 'production' }), false, 'never live in an open production site');
  assert.equal(emailAuth.enabled({ NODE_ENV: 'development' }), false);
});

test('emails are trimmed, lower-cased and validated', () => {
  assert.equal(emailAuth.normalizeEmail('  Owner@Example.SA '), 'owner@example.sa');
  for (const bad of ['', 'no-at', 'a@b', 'a@b.c', '@example.com', 'a b@example.com', 'a@exa mple.com', `${'x'.repeat(190)}@e.com`, null, 5, ['a@b.com']]) {
    assert.equal(emailAuth.normalizeEmail(bad), null, String(bad));
  }
});

test('production guard: the server refuses to start with the flag on while launch mode is open', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', AUTH_EMAIL_TEST: 'true', LAUNCH_MODE: 'open' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /AUTH_EMAIL_TEST=true is refused/);
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
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks}) OR email LIKE 'ea-%@aqdi-test.example'`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
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
  const c = res.response.headers.getSetCookie().find((x) => x.startsWith('aqdi_session='));
  return c ? c.split(';')[0] : null;
};
const userByEmail = async (email) => (await db.pool.query('SELECT * FROM users WHERE email = ?', [email]))[0][0];
const auditRows = async (action, userId) => (await db.pool.query(
  'SELECT * FROM audit_logs WHERE action = ? AND entity_id <=> ? ORDER BY id', [action, userId],
))[0];
const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const BANNER = 'وضع تجريبي: الدخول بالبريد بدون رمز';

test('flag off: /login and /register are the phone pages, the email route does not exist, phone login works', { skip }, async () => {
  flag(false);
  for (const page of ['/login', '/register']) {
    const res = await http.request(page);
    assert.equal(res.status, 200);
    assert.match(res.text, /رقم الجوال/);
    assert.doesNotMatch(res.text, /البريد الإلكتروني/, `${page} has no email wording`);
    assert.ok(!res.text.includes(BANNER), 'no banner');
  }
  const post = await emailPost(mail('nobody'));
  assert.equal(post.status, 404);

  const { location, cookie } = await http.login(phone(1));
  assert.ok(cookie, 'phone login still issues a session');
  assert.equal(location, '/office/new');
});

test('flag on: email pages with consistent wording and the banner on every page', { skip }, async () => {
  flag(true);
  try {
    const login = await http.request('/login');
    assert.equal(login.status, 200);
    assert.match(login.text, /البريد الإلكتروني/);
    assert.match(login.text, /action="\/login\/email"/);
    assert.doesNotMatch(login.text, /رقم الجوال|رمز دخول|برسالة نصية/, 'no phone wording on the email page');
    assert.ok(login.text.includes(BANNER));

    const register = await http.request('/register');
    assert.match(register.text, /سجّل مكتبك/);
    assert.match(register.text, /name="intent" value="register"/);
    assert.doesNotMatch(register.text, /رقم الجوال|برسالة نصية/);

    const phonePage = await http.request('/login?method=phone');
    assert.match(phonePage.text, /رقم الجوال/, 'the platform admin keeps the phone page');
    assert.ok(phonePage.text.includes(BANNER));

    for (const page of ['/', '/pricing', '/no-such-page-ea']) {
      assert.ok((await http.request(page)).text.includes(BANNER), `banner on ${page}`);
    }
    const { cookie } = await http.login(phone(2));
    const created = await http.request('/office/new', { method: 'POST', cookie, form: { name: 'تجربة-بريد-لافتة', city: 'الرياض', phone: '0112345678' } });
    assert.equal(created.status, 302);
    assert.ok((await http.request('/office', { cookie })).text.includes(BANNER), 'banner in the office area');
  } finally {
    flag(false);
  }
  assert.ok(!(await http.request('/')).text.includes(BANNER), 'banner gone with the flag');
});

test('register by email creates an owner through the normal office flow (trial plan); login is case-insensitive', { skip }, async () => {
  flag(true);
  try {
    const reg = await emailPost('  EA-Owner@AQDI-Test.example ', 'register');
    assert.equal(reg.status, 302, reg.text.slice(0, 300));
    assert.equal(reg.location, '/office/new');
    const cookie = sessionOf(reg);
    assert.ok(cookie);

    const user = await userByEmail(mail('owner'));
    assert.ok(user, 'stored lower-case');
    assert.equal(user.email, mail('owner'));
    assert.equal(user.phone, null);
    assert.equal(user.role, null);

    const form = await http.request('/office/new', { cookie });
    assert.equal(form.status, 200);
    const created = await http.request('/office/new', { method: 'POST', cookie, form: { name: 'تجربة-بريد-مكتب', city: 'الرياض', phone: '0112345678' } });
    assert.equal(created.status, 302);
    assert.equal(created.location, '/office');
    const [[office]] = await db.pool.query(
      'SELECT o.*, p.code AS plan_code FROM offices o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.owner_id = ?', [user.id],
    );
    assert.equal(office.status, 'trial');
    assert.equal(office.plan_code, 'trial');
    assert.equal((await userByEmail(mail('owner'))).role, 'office_owner');
    const home = await http.request('/office', { cookie });
    assert.equal(home.status, 200);
    assert.ok(home.text.includes(mail('owner')), 'the header shows the email when there is no name or phone');

    const again = await emailPost(mail('owner'), 'register');
    assert.equal(again.status, 409);
    assert.match(again.text, /مسجّل من قبل/);

    const login = await emailPost('Ea-OWNER@aqdi-test.EXAMPLE');
    assert.equal(login.status, 302);
    assert.equal(login.location, '/office', 'same role routing as the phone login');
    const session = sessionOf(login);
    assert.ok(session);
    assert.equal((await http.request('/office', { cookie: session })).status, 200);

    const regAudit = await auditRows('auth.email_register', user.id);
    const loginAudit = await auditRows('auth.email_login', user.id);
    assert.equal(regAudit.length, 1);
    assert.equal(loginAudit.length, 1);
    assert.equal(jsonOf(loginAudit[0].after_json).outcome, 'ok');
    for (const row of [...regAudit, ...loginAudit]) assert.ok(!JSON.stringify(row).toLowerCase().includes('aqdi-test.example'), 'never the address');
  } finally {
    flag(false);
  }
});

test('unknown email, bad email, platform_admin and inactive accounts are refused with a clear message and no session', { skip }, async () => {
  flag(true);
  try {
    const unknown = await emailPost(mail('nobody'));
    assert.equal(unknown.status, 422);
    assert.match(unknown.text, /لا يوجد حساب بهذا البريد الإلكتروني/);
    assert.equal(sessionOf(unknown), null);
    assert.equal(await userByEmail(mail('nobody')), undefined, 'login never creates a user');

    const bad = await emailPost('not-an-email');
    assert.equal(bad.status, 422);
    assert.match(bad.text, /البريد الإلكتروني غير صحيح/);

    await db.pool.query("INSERT INTO users (phone, email, role, phone_verified) VALUES (?, ?, 'platform_admin', 1)", [phone(50), mail('admin')]);
    const admin = await emailPost(mail('admin'));
    assert.equal(admin.status, 403);
    assert.match(admin.text, /مدير المنصة/);
    assert.equal(sessionOf(admin), null);
    const adminUser = await userByEmail(mail('admin'));
    assert.equal(jsonOf((await auditRows('auth.email_login', adminUser.id))[0].after_json).outcome, 'platform_admin');

    await db.pool.query("INSERT INTO users (phone, email, role, is_active) VALUES (?, ?, 'office_owner', 0)", [phone(51), mail('inactive')]);
    const inactive = await emailPost(mail('inactive'));
    assert.equal(inactive.status, 403);
    assert.equal(sessionOf(inactive), null);
  } finally {
    flag(false);
  }
});

test('an owner with 2FA switched on still gets the authenticator step', { skip }, async () => {
  flag(true);
  try {
    await db.pool.query("INSERT INTO users (phone, email, role, twofa_enabled) VALUES (?, ?, 'office_owner', 1)", [phone(52), mail('twofa')]);
    const res = await emailPost(mail('twofa'));
    assert.equal(res.status, 302);
    assert.equal(res.location, '/login/2fa');
    assert.equal(sessionOf(res), null);
  } finally {
    flag(false);
  }
});

test('email attempts are limited per IP (invalid ones count too)', { skip }, async () => {
  flag(true);
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await emailPost(`bad-${i}`)).status, 422);
    const blocked = await emailPost(mail('nobody'));
    assert.equal(blocked.status, 429);
    assert.match(blocked.text, /محاولات كثيرة/);
    assert.ok(blocked.response.headers.get('retry-after'));
  } finally {
    flag(false);
  }
});

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

  // The owner can now sign in by email while the flag is on.
  flag(true);
  try {
    const login = await emailPost(mail('live-owner'));
    assert.equal(login.status, 302);
    assert.ok(sessionOf(login));
  } finally {
    flag(false);
  }

  const usage = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'set-user-email.js')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /Usage: node scripts\/set-user-email\.js <phone> <email>/);
});
