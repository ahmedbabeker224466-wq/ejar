'use strict';

// The email sign-in code (services/emailCode.js, /login/email with
// AUTH_EMAIL_TEST off) and the licence check of new offices
// (services/officeReview.js): a code is mailed, only the right code signs in
// or creates the account, the address is never stored in otp_codes, five
// wrong codes lock; a new office needs its FAL licence and commercial
// registration, waits on the review page, the admins are told, approval starts
// the trial and rejection shows the reason. Database parts run only when
// TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { retryOnDeadlock } = require('../services/transaction');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file uses: 9665000033NN. Every email: ec-...@aqdi-test.example.
const phone = (n) => `9665000033${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const mail = (name) => `ec-${name}@aqdi-test.example`;
const saved = {};
const sent = [];
let db;
let http;
let authRoutes;
let emailCode;
let officeReview;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';

// ------------------------------------------------------------ pure

test('email code keys: stable, never the address, refused for a bad address', () => {
  const code = require('../services/emailCode');
  const a = code.identify('  Owner@Example.SA ');
  assert.equal(a, code.identify('owner@example.sa'), 'case and spaces do not matter');
  assert.match(a, /^e:[0-9a-f]{18}$/);
  assert.ok(a.length <= 20, 'fits otp_codes.phone');
  assert.ok(!a.includes('owner') && !a.includes('@'));
  assert.notEqual(a, code.identify('other@example.sa'));
  assert.equal(code.identify('not-an-email'), null);

  assert.equal(code.enabled({}), false, 'off without SMTP');
  assert.equal(code.enabled({ SMTP_HOST: 'mail.example', MAIL_FROM: 'x <a@b.example>' }), true, 'on once mail is configured');
  assert.equal(code.enabled({ SMTP_HOST: 'mail.example', MAIL_FROM: 'a@b.example', AUTH_EMAIL_LOGIN: 'false' }), false, 'can be switched off');

  const msg = code.messageFor('123456', 'ar');
  assert.match(msg.text, /123456/);
  assert.match(msg.subject, /رمز الدخول/);
});

test('office form: the licence numbers are required for a new office only', () => {
  const { validateOfficeFields } = require('../services/offices');
  const base = { name: 'مكتب', city: 'الرياض', phone: '0112345678' };
  assert.deepEqual(Object.keys(validateOfficeFields(base).errors), [], 'settings keep them optional');
  const required = validateOfficeFields(base, { requireLicence: true }).errors;
  assert.ok(required.cr_number && required.rega_license);
  const ok = validateOfficeFields({ ...base, cr_number: '7001-234-567', rega_license: '1200 0012' }, { requireLicence: true });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.cr_number, '7001234567');
  assert.equal(ok.values.rega_license, '12000012');
});

test('access: pending and rejected offices are locked before anything else', () => {
  const { officeAccess } = require('../services/offices');
  const live = { status: 'active' };
  assert.equal(officeAccess({ ...live, verification: 'pending' }).reason, 'pending_review');
  assert.equal(officeAccess({ ...live, verification: 'rejected' }).reason, 'rejected');
  assert.equal(officeAccess({ ...live, verification: 'approved' }).locked, false);
  assert.equal(officeAccess(live).locked, false, 'rows read without the column count as approved');
});

// ------------------------------------------------------------ database

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'AUTH_EMAIL_TEST', 'AUTH_EMAIL_LOGIN', 'SMTP_HOST', 'MAIL_FROM', 'PLATFORM_ADMIN_PHONE']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  delete process.env.AUTH_EMAIL_TEST;
  process.env.SMTP_HOST = 'smtp.aqdi-test.example';
  process.env.MAIL_FROM = 'miaad <noreply@aqdi-test.example>';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  require('../services/channels/email').setMailer({ sendMail: async (m) => { sent.push(m); return {}; } });
  emailCode = require('../services/emailCode');
  officeReview = require('../services/officeReview');
  authRoutes = require('../routes/auth');
  http = createOfficeHttp(db);
  await http.start();
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  const owners = `SELECT id FROM users WHERE phone IN (${marks}) OR email LIKE 'ec-%@aqdi-test.example'`;
  await db.pool.query(`DELETE FROM notifications WHERE user_id IN (${owners}) OR dedupe_key LIKE 'office_review:%' AND link IN (SELECT CONCAT('/admin/offices/', id) FROM offices WHERE owner_id IN (${owners}))`, [...PHONES, ...PHONES]);
  await db.pool.query(`DELETE FROM audit_logs WHERE actor_id IN (${owners}) OR (entity_type = 'user' AND entity_id IN (${owners})) OR office_id IN (SELECT id FROM offices WHERE owner_id IN (${owners}))`, [...PHONES, ...PHONES, ...PHONES]);
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (${owners})`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM users WHERE phone IN (${marks}) OR email LIKE 'ec-%@aqdi-test.example'`, PHONES), { retries: 5 });
  const keys = ['owner', 'login', 'lock', 'admin', 'office'].map((n) => emailCode && emailCode.identify(mail(n))).filter(Boolean);
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${[...PHONES, ...keys].map(() => '?').join(',')})`, [...PHONES, ...keys]), { retries: 5 });
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

const reset = () => authRoutes.emailLimit.counter.reset();
const stepOf = (res) => {
  const c = res.response.headers.getSetCookie().find((x) => x.startsWith('aqdi_login_email='));
  return c ? c.split(';')[0] : null;
};
const sessionOf = (res) => {
  const c = res.response.headers.getSetCookie().find((x) => x.startsWith('aqdi_session='));
  return c ? c.split(';')[0] : null;
};
const lastCode = (to) => {
  const m = [...sent].reverse().find((x) => x.to === to);
  return m ? /(\d{6})/.exec(m.text)[1] : null;
};
const ask = (email, intent) => http.request('/login/email', { method: 'POST', form: { email, intent } });
const verify = (cookie, code) => http.request('/login/email/verify', { method: 'POST', cookie, form: { code } });
const userByEmail = async (email) => (await db.pool.query('SELECT * FROM users WHERE email = ?', [email]))[0][0];

test('register by email: a code is mailed, the account exists only after the right code', { skip }, async () => {
  reset();
  const page = await http.request('/register');
  assert.match(page.text, /action="\/login\/email"/, 'email page while mail is configured');
  assert.match(page.text, /رمز تحقق/);

  const asked = await ask(`  EC-Owner@AQDI-Test.example `, 'register');
  assert.equal(asked.status, 302, asked.text.slice(0, 200));
  assert.equal(asked.location, '/login/email/verify');
  const step = stepOf(asked);
  assert.ok(step);
  const code = lastCode(mail('owner'));
  assert.match(code, /^\d{6}$/);
  const message = sent[sent.length - 1];
  assert.ok(message.html.includes('email-logo.png'), 'the HTML template with the logo');
  assert.equal(await userByEmail(mail('owner')), undefined, 'no account before the code');

  const [rows] = await db.pool.query('SELECT phone FROM otp_codes WHERE phone = ?', [emailCode.identify(mail('owner'))]);
  assert.equal(rows.length, 1);
  const [leak] = await db.pool.query("SELECT COUNT(*) AS n FROM otp_codes WHERE phone LIKE '%@%'");
  assert.equal(Number(leak[0].n), 0, 'the address is never stored with the code');

  const form = await http.request('/login/email/verify', { cookie: step });
  assert.equal(form.status, 200);
  assert.ok(form.text.includes(mail('owner')));
  assert.match(form.text, /action="\/login\/email\/verify"/);

  const wrong = await verify(step, code === '000000' ? '111111' : '000000');
  assert.equal(wrong.status, 422);
  assert.equal(await userByEmail(mail('owner')), undefined);

  const ok = await verify(step, code);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/office/new');
  assert.ok(sessionOf(ok));
  const user = await userByEmail(mail('owner'));
  assert.equal(user.role, null);
  assert.equal(user.phone, null);

  const again = await verify(step, code);
  assert.notEqual(again.location, '/office/new', 'a used code never works twice');
  assert.equal((await ask(mail('owner'), 'register')).status, 409, 'registered already');
});

test('login by email: unknown address refused, the platform admin refused, a code signs in', { skip }, async () => {
  reset();
  const unknown = await ask(mail('nobody'), 'login');
  assert.equal(unknown.status, 422);
  assert.match(unknown.text, /لا يوجد حساب/);

  await db.pool.query("INSERT INTO users (phone, email, role) VALUES (?, ?, 'platform_admin')", [phone(90), mail('admin')]);
  const admin = await ask(mail('admin'), 'login');
  assert.equal(admin.status, 403);
  assert.equal(stepOf(admin), null);

  await db.pool.query('INSERT INTO users (phone, email, role) VALUES (NULL, ?, NULL)', [mail('login')]);
  const asked = await ask('EC-LOGIN@aqdi-test.example', 'login');
  assert.equal(asked.status, 302);
  const ok = await verify(stepOf(asked), lastCode(mail('login')));
  assert.equal(ok.status, 302);
  assert.ok(sessionOf(ok));
  const [audits] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'auth.email_login' AND entity_id = ? ORDER BY id DESC LIMIT 1", [(await userByEmail(mail('login'))).id]);
  const after = typeof audits[0].after_json === 'string' ? JSON.parse(audits[0].after_json) : audits[0].after_json;
  assert.deepEqual(after, { outcome: 'ok', method: 'email_code' });
  assert.ok(!JSON.stringify(after).includes('@'), 'never the address');
});

test('five wrong codes lock the address', { skip }, async () => {
  reset();
  await db.pool.query('INSERT INTO users (phone, email, role) VALUES (NULL, ?, NULL)', [mail('lock')]);
  const asked = await ask(mail('lock'), 'login');
  const step = stepOf(asked);
  const right = lastCode(mail('lock'));
  const bad = right === '999999' ? '888888' : '999999';
  for (let i = 0; i < 5; i += 1) assert.equal((await verify(step, bad)).status, 422);
  const locked = await verify(step, right);
  assert.equal(locked.status, 422, 'even the right code waits out the lock');
  assert.match(locked.text, /انتظر/);
});

test('a new office needs its licence, waits for review, the admins are told; approval starts the trial', { skip }, async () => {
  reset();
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'platform_admin') ON DUPLICATE KEY UPDATE role = 'platform_admin'", [phone(91)]);
  const [[admin]] = await db.pool.query('SELECT id FROM users WHERE phone = ?', [phone(91)]);
  const { cookie } = await http.login(phone(1));

  const missing = await http.request('/office/new', { method: 'POST', cookie, form: { name: 'تجربة-مراجعة', city: 'الرياض', phone: '0112345678' } });
  assert.equal(missing.status, 422);
  assert.match(missing.text, /رقم ترخيص فال/);

  const form = { name: 'تجربة-مراجعة', city: 'الرياض', phone: '0112345678', rega_license: '1200000033', cr_number: '7000000033' };
  const created = await http.request('/office/new', { method: 'POST', cookie, form });
  assert.equal(created.status, 302);
  const [[office]] = await db.pool.query('SELECT * FROM offices WHERE owner_id = (SELECT id FROM users WHERE phone = ?)', [phone(1)]);
  assert.equal(office.verification, 'pending');

  for (const path of ['/office', '/office/contracts', '/office/billing', '/office/settings']) {
    const res = await http.request(path, { cookie });
    assert.equal(res.status, 403, path);
    assert.match(res.text, /طلبك قيد المراجعة/);
  }

  const [notes] = await db.pool.query("SELECT * FROM notifications WHERE user_id = ? AND kind = 'office_review' AND link = ?", [admin.id, `/admin/offices/${office.id}`]);
  assert.equal(notes.length, 1, 'every platform admin is told');
  assert.ok(!notes[0].body.includes('1200000033'), 'never the licence number');

  // Rejection shows the reason; approval later works from there.
  await officeReview.reject(db.pool, { officeId: office.id, adminId: admin.id, reason: 'الرخصة منتهية', ip: null });
  const refused = await http.request('/office', { cookie });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /لم تتم الموافقة على المكتب/);
  assert.match(refused.text, /الرخصة منتهية/);
  await assert.rejects(officeReview.reject(db.pool, { officeId: office.id, adminId: admin.id, reason: 'مرة ثانية', ip: null }), /not_pending/);

  const before = Date.now();
  await officeReview.approve(db.pool, { officeId: office.id, adminId: admin.id, reason: 'سارية', ip: null });
  const [[after]] = await db.pool.query('SELECT * FROM offices WHERE id = ?', [office.id]);
  assert.equal(after.verification, 'approved');
  assert.equal(after.verification_note, null);
  const days = (new Date(after.trial_ends_at).getTime() - before) / 86400000;
  assert.ok(days > 13.99 && days < 14.01, `the trial starts at approval (got ${days})`);
  const [[sub]] = await db.pool.query("SELECT period_end FROM subscriptions WHERE office_id = ? AND status = 'trialing'", [office.id]);
  assert.equal(new Date(sub.period_end).getTime(), new Date(after.trial_ends_at).getTime());
  assert.equal((await http.request('/office', { cookie })).status, 200, 'the office opens');
  await assert.rejects(officeReview.approve(db.pool, { officeId: office.id, adminId: admin.id, reason: 'x', ip: null }), /already_approved/);

  const [owner] = await db.pool.query("SELECT title FROM notifications WHERE user_id = (SELECT id FROM users WHERE phone = ?) AND kind = 'office_verified' ORDER BY id", [phone(1)]);
  assert.deepEqual(owner.map((n) => n.title), ['لم تتم الموافقة على مكتبك', 'تمت الموافقة على مكتبك']);
  const [audit] = await db.pool.query("SELECT action FROM audit_logs WHERE office_id = ? AND action IN ('admin.office.verify','admin.office.reject') ORDER BY id", [office.id]);
  assert.deepEqual(audit.map((a) => a.action), ['admin.office.reject', 'admin.office.verify']);

  // Settings cannot change the checked numbers.
  await http.request('/office/settings', { method: 'POST', cookie, form: { ...form, rega_license: '1299999999', cr_number: '7099999999' } });
  const [[kept]] = await db.pool.query('SELECT rega_license, cr_number FROM offices WHERE id = ?', [office.id]);
  assert.deepEqual({ ...kept }, { rega_license: '1200000033', cr_number: '7000000033' });
});
