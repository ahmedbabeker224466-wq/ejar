'use strict';

// Launch readiness (/admin/launch, services/launch.js): every check with a fake
// database and a fixed clock, then the page over HTTP (admin only, reasons,
// audit, the legal notice, the test email). No secret value may appear anywhere.
// The HTTP part runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const launch = require('../services/launch');
const logger = require('../utils/logger');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
const NOW = new Date('2026-12-01T09:00:00Z');
const hex = (n) => crypto.randomBytes(n).toString('hex');

let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-launch-'));
  fs.mkdirSync(path.join(tmp, 'up'));
  fs.mkdirSync(path.join(tmp, 'bk'));
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ------------------------------------------------------------ a fake database

const confirmed = (extra = {}) => ({ on: '2026-11-30', at: '2026-11-30T08:00:00.000Z', ...extra });
const ALL_RECORDS = () => ({
  secrets_rotated: confirmed(), db_password_rotated: confirmed(), admin_backup_codes: confirmed(),
  restore_drill: confirmed({ note: 'استعدنا نسخة الأمس' }), ejar_rules: confirmed({ source: 'دليل إيجار الرسمي - الإصدار 3' }),
  legal_review: confirmed({ note: 'المحامي أحمد' }), npm_audit: confirmed(),
  smtp_test: { at: '2026-11-29T08:00:00.000Z', ok: true },
});

function fakePool(o = {}) {
  const opts = {
    records: ALL_RECORDS(), seller: { 'seller.legal_name': 'شركة', 'seller.address': 'الرياض', 'seller.vat_number': '300000000000003' },
    admins: { total: 1, enabled: 1 }, backupAt: new Date('2026-12-01T00:00:00Z'), cronAt: new Date('2026-12-01T08:50:00Z'), stuck: 0, failed: 0, ...o,
  };
  const pool = {
    async query(sql) {
      if (sql.includes("LIKE 'launch.%'")) return [Object.entries(opts.records).map(([k, v]) => ({ setting_key: `launch.${k}`, setting_value: JSON.stringify(v) }))];
      if (sql.includes('setting_key IN')) return [Object.entries(opts.seller).map(([k, v]) => ({ setting_key: k, setting_value: v }))];
      if (sql.includes('FROM users')) return [[opts.admins]];
      if (sql.includes('FROM backups')) return [[{ at: opts.backupAt }]];
      if (sql.includes('FROM cron_runs')) return [[{ at: opts.cronAt }]];
      if (sql.includes("status = 'pending'")) return [[{ n: opts.stuck }]];
      if (sql.includes("status = 'failed'")) return [[{ n: opts.failed }]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pool;
}

const goodEnv = () => ({
  NODE_ENV: 'production', APP_URL: 'https://aqdi.example', SMS_PROVIDER: 'unifonic', SMS_API_KEY: hex(16), SMS_SENDER: 'Aqdi',
  JWT_SECRET: hex(32), SECRET_BOX_KEY: hex(32), CRON_SECRET: hex(24),
  SMTP_HOST: 'mail.example', MAIL_FROM: 'a@example.com', MOYASAR_SECRET_KEY: `sk_live_${hex(8)}`, MOYASAR_PUBLISHABLE_KEY: `pk_live_${hex(8)}`, MOYASAR_WEBHOOK_SECRET: hex(16),
  UPLOAD_DIR: path.join(tmp || os.tmpdir(), 'up'), BACKUP_DIR: path.join(tmp || os.tmpdir(), 'bk'),
});

const run = (pool, env, extra = {}) => launch.runChecks({ pool, env, now: NOW, host: 'aqdi.example', hsts: 'max-age=15552000', ...extra });
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

// ------------------------------------------------------------ strength

test('secret strength: length, pattern, variety and obvious values; never the value', () => {
  assert.equal(launch.secretProblem(undefined), 'missing');
  assert.equal(launch.secretProblem('   '), 'missing');
  assert.equal(launch.secretProblem('a'.repeat(31)), 'short');
  assert.equal(launch.secretProblem('ab'.repeat(20)), 'repeated');
  assert.equal(launch.secretProblem('abcdefgh'.repeat(5)), 'repeated');
  assert.equal(launch.secretProblem('aaaaabbbbbaaaaabbbbbcaaaaabbbbbaaaaabbbbb'), 'low_variety');
  assert.equal(launch.secretProblem('please-change-me-to-a-long-value-0123456789'), 'common');
  assert.equal(launch.secretProblem('Password-Password-1234567890abcdef!!'), 'common');
  assert.equal(launch.secretProblem(hex(32)), 'ok');
  assert.equal(launch.secretProblem(crypto.randomBytes(48).toString('base64')), 'ok');
  assert.equal(launch.secretProblem('a'.repeat(64), { hex64: true }), 'repeated');
  assert.equal(launch.secretProblem('0123456789abcdef'.repeat(4), { hex64: true }), 'repeated');
  assert.equal(launch.secretProblem('g'.repeat(64), { hex64: true }), 'format');
  assert.equal(launch.secretProblem(hex(16), { hex64: true }), 'format');
  assert.equal(launch.secretProblem(hex(32), { hex64: true }), 'ok');
});

test('confirmation forms: a date that is real and not in the future, a source of 10+ characters, a note', () => {
  const v = (key, body) => launch.validateConfirm(key, body, NOW);
  assert.equal(v('nope', {}).ok, false);
  assert.deepEqual(v('secrets_rotated', {}), { ok: true, record: { on: '2026-12-01' } });
  assert.equal(v('restore_drill', { on: '2026-11-20', note: 'ok' }).ok, false, 'note too short');
  assert.deepEqual(v('restore_drill', { on: '2026-11-20', note: 'استعادة ناجحة' }), { ok: true, record: { on: '2026-11-20', note: 'استعادة ناجحة' } });
  assert.equal(v('restore_drill', { on: '2026-12-02', note: 'استعادة ناجحة' }).ok, false, 'future');
  assert.equal(v('restore_drill', { on: '2026-02-30', note: 'استعادة ناجحة' }).ok, false, 'impossible date');
  assert.equal(v('ejar_rules', { source: 'قصير' }).ok, false);
  assert.equal(v('ejar_rules', {}).ok, false);
  const ok = v('ejar_rules', { on: '2026-11-01', source: 'دليل إيجار الرسمي رقم 5\n\t' });
  assert.deepEqual(ok.record, { on: '2026-11-01', source: 'دليل إيجار الرسمي رقم 5' });
  assert.equal(v('npm_audit', {}).ok, true, 'the npm audit note is optional');
  assert.equal(v('legal_review', { note: ' ' }).ok, false);
});

// ------------------------------------------------------------ the checks

test('everything in order: every check passes and the platform is ready', async () => {
  const checks = await run(fakePool(), goodEnv());
  assert.deepEqual(checks.map((c) => c.id), [
    'node_env', 'sms_provider', 'secrets_strength', 'secrets_rotated', 'db_password_rotated', 'admin_2fa', 'admin_backup_codes', 'backup_recent', 'restore_drill',
    'backup_dir', 'seller_details', 'ejar_rules', 'legal_review', 'smtp', 'moyasar', 'app_url', 'cron_heartbeat', 'uploads_dir', 'npm_audit',
  ]);
  for (const c of checks) {
    assert.equal(c.status, 'pass', `${c.id}: ${c.detailAr}`);
    assert.ok(c.titleAr && c.detailAr, c.id);
  }
  assert.deepEqual(launch.summarize(checks), { pass: 19, warn: 0, fail: 0, ready: true });
});

test('each check turns warn or fail for its own reason, and nothing else changes', async () => {
  const expectOnly = async (id, status, pool, env, extra) => {
    const checks = byId(await run(pool || fakePool(), env || goodEnv(), extra));
    assert.equal(checks[id].status, status, `${id}: ${checks[id].detailAr}`);
    for (const [other, c] of Object.entries(checks)) if (other !== id) assert.equal(c.status, 'pass', `${other} changed while testing ${id}: ${c.detailAr}`);
    return checks[id];
  };

  // 1-2
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), NODE_ENV: 'development' })).node_env.status, 'warn');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), SMS_PROVIDER: 'console' })).sms_provider.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), SMS_PROVIDER: 'console', NODE_ENV: 'development' })).sms_provider.status, 'warn');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), SMS_PROVIDER: '' })).sms_provider.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), SMS_SENDER: '' })).sms_provider.status, 'fail', 'real provider without its sender');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), SMS_PROVIDER: 'msegat' })).sms_provider.status, 'fail', 'msegat also needs SMS_USERNAME');
  // 3
  for (const [name, value] of [['JWT_SECRET', 'short'], ['SECRET_BOX_KEY', hex(16)], ['CRON_SECRET', 'a'.repeat(40)], ['JWT_SECRET', undefined]]) {
    const c = byId(await run(fakePool(), { ...goodEnv(), [name]: value })).secrets_strength;
    assert.equal(c.status, 'fail', name);
    assert.ok(c.detailAr.includes(name));
  }
  await expectOnly('secrets_rotated', 'fail', fakePool({ records: { ...ALL_RECORDS(), secrets_rotated: undefined } }));
  // 4
  const noDb = ALL_RECORDS();
  delete noDb.db_password_rotated;
  await expectOnly('db_password_rotated', 'fail', fakePool({ records: noDb }));
  // 5
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), REQUIRE_ADMIN_2FA: 'false' })).admin_2fa.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), REQUIRE_ADMIN_2FA: 'true' })).admin_2fa.status, 'pass');
  assert.match(byId(await run(fakePool({ admins: { total: 3, enabled: 2 } }), goodEnv())).admin_2fa.detailAr, /1 من 3/);
  assert.equal(byId(await run(fakePool({ admins: { total: 0, enabled: 0 } }), goodEnv())).admin_2fa.status, 'fail');
  const noCodes = ALL_RECORDS();
  delete noCodes.admin_backup_codes;
  await expectOnly('admin_backup_codes', 'fail', fakePool({ records: noCodes }));
  // 6
  await expectOnly('backup_recent', 'fail', fakePool({ backupAt: new Date('2026-11-29T20:00:00Z') }));
  await expectOnly('backup_recent', 'fail', fakePool({ backupAt: null }));
  await expectOnly('backup_recent', 'pass', fakePool({ backupAt: new Date('2026-11-30T00:00:00Z') }));
  const noDrill = ALL_RECORDS();
  delete noDrill.restore_drill;
  await expectOnly('restore_drill', 'fail', fakePool({ records: noDrill }));
  await expectOnly('backup_dir', 'fail', null, { ...goodEnv(), BACKUP_DIR: path.join(__dirname, '..', 'public', 'bk') });
  await expectOnly('backup_dir', 'warn', null, { ...goodEnv(), BACKUP_DIR: path.join(tmp, 'not-created-yet') });
  // 7
  await expectOnly('seller_details', 'fail', fakePool({ seller: { 'seller.address': 'الرياض' } }));
  await expectOnly('seller_details', 'fail', fakePool({ seller: { 'seller.legal_name': 'شركة' } }));
  const noVat = await expectOnly('seller_details', 'warn', fakePool({ seller: { 'seller.legal_name': 'شركة', 'seller.address': 'الرياض' } }));
  assert.match(noVat.detailAr, /إيصال دفع/);
  // 8
  const noEjar = ALL_RECORDS();
  delete noEjar.ejar_rules;
  await expectOnly('ejar_rules', 'fail', fakePool({ records: noEjar }));
  // 9
  const noLegal = ALL_RECORDS();
  delete noLegal.legal_review;
  await expectOnly('legal_review', 'fail', fakePool({ records: noLegal }));
  // 10
  await expectOnly('smtp', 'fail', null, { ...goodEnv(), SMTP_HOST: '' });
  const noTest = ALL_RECORDS();
  delete noTest.smtp_test;
  await expectOnly('smtp', 'fail', fakePool({ records: noTest }));
  await expectOnly('smtp', 'fail', fakePool({ records: { ...ALL_RECORDS(), smtp_test: { at: '2026-11-29T08:00:00.000Z', ok: false, error: 'EAUTH' } } }));
  await expectOnly('smtp', 'fail', fakePool({ records: { ...ALL_RECORDS(), smtp_test: { at: '2026-11-20T08:00:00.000Z', ok: true } } }));
  await expectOnly('smtp', 'pass', fakePool({ records: { ...ALL_RECORDS(), smtp_test: { at: '2026-11-24T10:00:00.000Z', ok: true } } }));
  // 11
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), MOYASAR_PUBLISHABLE_KEY: '' })).moyasar.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), MOYASAR_SECRET_KEY: '' })).moyasar.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), MOYASAR_WEBHOOK_SECRET: '' })).moyasar.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), MOYASAR_SECRET_KEY: 'sk_test_abcdef' })).moyasar.status, 'warn');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), MOYASAR_SECRET_KEY: '', MOYASAR_PUBLISHABLE_KEY: '' })).moyasar.status, 'warn');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), NODE_ENV: 'development', MOYASAR_SECRET_KEY: 'sk_test_abcdef', MOYASAR_PUBLISHABLE_KEY: 'pk_test_abcdef' })).moyasar.status, 'pass', 'test keys are fine outside production');
  // 12
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), APP_URL: 'http://aqdi.example' })).app_url.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), APP_URL: '' })).app_url.status, 'fail');
  assert.equal(byId(await run(fakePool(), { ...goodEnv(), APP_URL: 'https://other.example' })).app_url.status, 'fail');
  await expectOnly('app_url', 'warn', null, null, { hsts: null });
  assert.equal(byId(await run(fakePool(), goodEnv(), { host: null })).app_url.status, 'pass', 'no request: the host is not compared');
  // 13
  await expectOnly('cron_heartbeat', 'fail', fakePool({ cronAt: new Date('2026-12-01T08:30:00Z') }));
  await expectOnly('cron_heartbeat', 'fail', fakePool({ cronAt: null }));
  await expectOnly('cron_heartbeat', 'fail', fakePool({ stuck: 2 }));
  await expectOnly('cron_heartbeat', 'warn', fakePool({ failed: 4 }));
  await expectOnly('cron_heartbeat', 'pass', fakePool({ cronAt: new Date('2026-12-01T08:41:00Z') }));
  // 14
  await expectOnly('uploads_dir', 'fail', null, { ...goodEnv(), UPLOAD_DIR: path.join(__dirname, '..', 'public', 'u') });
  await expectOnly('uploads_dir', 'warn', null, { ...goodEnv(), UPLOAD_DIR: path.join(tmp, 'missing') });
  const unwritable = await run(fakePool(), goodEnv(), { fsApi: { exists: () => true, access: () => { throw new Error('EACCES'); } } });
  assert.equal(byId(unwritable).uploads_dir.status, 'fail');
  assert.equal(byId(unwritable).backup_dir.status, 'fail');
  // 15
  const noAudit = ALL_RECORDS();
  delete noAudit.npm_audit;
  await expectOnly('npm_audit', 'fail', fakePool({ records: noAudit }));
  await expectOnly('npm_audit', 'warn', fakePool({ records: { ...ALL_RECORDS(), npm_audit: confirmed({ on: '2026-10-15' }) } }));
  await expectOnly('npm_audit', 'pass', fakePool({ records: { ...ALL_RECORDS(), npm_audit: confirmed({ on: '2026-11-05' }) } }));
});

test('no secret value appears in the results, whatever the secrets are', async () => {
  const env = { ...goodEnv(), JWT_SECRET: 'weak', CRON_SECRET: 'password-password-password-password', MOYASAR_SECRET_KEY: 'sk_test_VISIBLE_NOWHERE_1', SMS_API_KEY: 'sms-key-VISIBLE_NOWHERE_2', DB_PASSWORD: 'db-VISIBLE_NOWHERE_3' };
  const text = JSON.stringify(await run(fakePool(), env));
  for (const secret of [env.JWT_SECRET, env.SECRET_BOX_KEY, env.CRON_SECRET, env.MOYASAR_SECRET_KEY, env.MOYASAR_PUBLISHABLE_KEY, env.MOYASAR_WEBHOOK_SECRET, env.SMS_API_KEY, env.DB_PASSWORD, 'VISIBLE_NOWHERE']) {
    assert.ok(!text.includes(secret), 'a secret value is in the output');
  }
  // The rule values on the page come from config/ejarRules.js, so they exist exactly there.
  const rules = launch.ruleSummary();
  assert.equal(rules.filter((r) => r.highlight).length, 1);
  assert.match(rules.find((r) => r.highlight).value, /2025-09-25/);
});

test('production guard: logs failing check ids only, nothing outside production, never throws', async () => {
  const lines = [];
  const warn = logger.warn;
  const info = logger.info;
  const error = logger.error;
  logger.warn = (m) => lines.push(m);
  logger.info = (m) => lines.push(m);
  logger.error = (m) => lines.push(m);
  try {
    assert.equal(await launch.logStartupGuard({ pool: fakePool(), env: { ...goodEnv(), NODE_ENV: 'development' } }), null);
    assert.deepEqual(lines, []);
    const env = { ...goodEnv(), JWT_SECRET: 'weak-value-VISIBLE_NOWHERE' };
    const failing = await launch.logStartupGuard({ pool: fakePool(), env });
    assert.ok(failing.includes('secrets_strength'));
    assert.ok(lines.some((l) => /Launch readiness: \d+ checks fail \(.*secrets_strength/.test(l)));
    assert.ok(!lines.join('\n').includes('VISIBLE_NOWHERE'));
    lines.length = 0;
    assert.equal(await launch.logStartupGuard({ pool: { query: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } }, env: goodEnv() }), null);
    assert.ok(lines.some((l) => /ECONNREFUSED/.test(l)));
  } finally {
    logger.warn = warn;
    logger.info = info;
    logger.error = error;
  }
});

test('config/ejarRules.js has the verification fields and the rules themselves are untouched', () => {
  const RULES = require('../config/ejarRules');
  assert.ok(Object.hasOwn(RULES, 'verifiedAt'));
  assert.ok(Object.hasOwn(RULES, 'verifiedSource'));
  assert.equal(RULES.verifiedAt, null);
  assert.equal(RULES.verifiedSource, null);
  assert.ok(Object.isFrozen(RULES));
  assert.deepEqual([RULES.NON_RENEWAL_NOTICE_DAYS, RULES.RENT_CHANGE_NOTICE_DAYS, RULES.AUTO_RENEW_DEFAULT], [60, 90, true]);
  assert.deepEqual({ ...RULES.RIYADH_RENT_FREEZE }, { city: 'riyadh', from: '2025-09-25', years: 5 });
  assert.deepEqual({ ...RULES.STAGE_THRESHOLDS }, { soonDays: 30, urgentDays: 7 });
});

// ------------------------------------------------------------ the page over HTTP

const { createOfficeHttp } = require('./helpers/officeHttp');
const phone = (n) => `9665000025${String(n).padStart(2, '0')}`; // 9665000025NN; 00 is the platform admin
const PHONES = [phone(0), phone(1), phone(2)];
const saved = {};
let db;
let http;
let admin;
let mailer;

test.describe('/admin/launch', { skip }, () => {
  test.before(async () => {
    for (const k of ['NODE_ENV', 'JWT_SECRET', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'SMTP_HOST', 'MAIL_FROM', 'APP_URL']) saved[k] = process.env[k];
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
    process.env.PLATFORM_ADMIN_PHONE = '0500002500';
    process.env.REQUIRE_ADMIN_2FA = 'false';
    process.env.SMTP_HOST = 'mail.example';
    process.env.MAIL_FROM = 'عقدي <no-reply@example.com>';
    db = require('../config/db');
    await db.ensureSchema();
    await cleanup();
    http = createOfficeHttp(db);
    await http.start();
    process.env.APP_URL = http.base();
    admin = await http.login(phone(0));
    mailer = { sent: [], fail: null, async sendMail(m) { if (this.fail) throw Object.assign(new Error('x'), { code: this.fail }); this.sent.push(m); } };
    require('../services/channels/email').setMailer(mailer);
  });

  async function cleanup() {
    const marks = PHONES.map(() => '?').join(',');
    await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
    await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
    await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
    await db.pool.query("DELETE FROM settings WHERE setting_key LIKE 'launch.%'");
  }

  test.after(async () => {
    require('../services/channels/email').setMailer(null);
    require('../services/platformSettings').setLegalReviewed(false);
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

  const post = (p, cookie, form, headers = {}) => fetch(`${http.base()}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie || '', Origin: http.base(), 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];

  test('platform admin only; anyone else is refused; the page lists every check and leaks no secret', async () => {
    assert.equal((await http.request('/admin/launch')).status, 302);
    const owner = await http.registerOffice(phone(1), 'تجربة-إطلاق-1');
    await db.pool.query("INSERT INTO users (phone, role, is_active) VALUES (?, 'tenant', 1) ON DUPLICATE KEY UPDATE role = 'tenant'", [phone(2)]);
    const tenant = await http.login(phone(2));
    for (const cookie of [owner.cookie, tenant.cookie]) {
      const res = await http.request('/admin/launch', { cookie });
      assert.ok([302, 403, 404].includes(res.status), `got ${res.status}`);
      const attempt = await post('/admin/launch/confirm/secrets_rotated', cookie, { reason: 'اختبار' });
      assert.ok([302, 403, 404].includes(attempt.status));
      if (attempt.status === 302) assert.doesNotMatch(attempt.headers.get('location'), /\/admin\/launch/);
    }
    assert.equal(await one("SELECT COUNT(*) AS n FROM settings WHERE setting_key = 'launch.secrets_rotated'").then((r) => Number(r.n)), 0);

    const page = await http.request('/admin/launch', { cookie: admin.cookie });
    assert.equal(page.status, 200);
    assert.equal((page.text.match(/id="check-/g) || []).length, 19);
    assert.match(page.text, /جاهزية الإطلاق/);
    assert.match(page.text, /غير جاهز للإطلاق/);
    assert.match(page.text, /2025-09-25/, 'the Riyadh freeze value is shown for comparison');
    for (const name of ['JWT_SECRET', 'SECRET_BOX_KEY', 'CRON_SECRET', 'DB_PASSWORD']) {
      const value = process.env[name];
      if (value && value.length >= 8) assert.ok(!page.text.includes(value), `${name} value is on the page`);
    }
    assert.ok(!page.text.includes('sk_'), 'no payment key text');
  });

  test('a confirmation needs a reason and valid fields, is stored, audit-logged without the note, and turns its check green', async () => {
    const noReason = await post('/admin/launch/confirm/secrets_rotated', admin.cookie, { reason: ' ' });
    assert.equal(noReason.status, 422);
    assert.match(await noReason.text(), /اكتب سبباً/);
    assert.equal((await post('/admin/launch/confirm/not_a_key', admin.cookie, { reason: 'سبب صحيح' })).status, 404);
    assert.equal((await post('/admin/launch/confirm/secrets_rotated', admin.cookie, { reason: 'سبب صحيح' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/admin/launch/confirm/ejar_rules', admin.cookie, { reason: 'سبب صحيح', source: 'قصير', on: '2026-01-01' })).status, 422);
    assert.equal((await post('/admin/launch/confirm/ejar_rules', admin.cookie, { reason: 'سبب صحيح', source: 'دليل إيجار الرسمي رقم 5', on: '2999-01-01' })).status, 422);

    const ok = await post('/admin/launch/confirm/secrets_rotated', admin.cookie, { reason: 'غيّرتها اليوم' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/admin/launch?done=launch_confirmed');
    const stored = JSON.parse((await one("SELECT setting_value FROM settings WHERE setting_key = 'launch.secrets_rotated'")).setting_value);
    assert.equal(stored.by, (await http.userByPhone(phone(0))).id);
    assert.match(stored.on, /^\d{4}-\d{2}-\d{2}$/);

    const source = 'دليل إيجار الرسمي - المادة 12 - SOURCE-MARKER';
    const ejar = await post('/admin/launch/confirm/ejar_rules', admin.cookie, { reason: 'قارنتها بالمصدر', source, on: '2026-10-01' });
    assert.equal(ejar.status, 302);
    const audit = await one("SELECT after_json, actor_id FROM audit_logs WHERE action = 'admin.launch.confirm' ORDER BY id DESC LIMIT 1");
    const after = typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json;
    assert.deepEqual(after, { key: 'ejar_rules', on: '2026-10-01', reason: 'قارنتها بالمصدر' });
    assert.ok(!JSON.stringify(after).includes('SOURCE-MARKER'));

    const page = await http.request('/admin/launch', { cookie: admin.cookie });
    assert.match(page.text, /id="check-secrets_rotated"[\s\S]*?ناجح/);
    const ejarBlock = /id="check-ejar_rules"[\s\S]*?<\/li>/.exec(page.text)[0];
    assert.match(ejarBlock, /ناجح/);
    assert.match(ejarBlock, /SOURCE-MARKER/, 'the recorded source is shown');
  });

  test('legal pages show the lawyer notice until the review is confirmed', async () => {
    const platformSettings = require('../services/platformSettings');
    platformSettings.setLegalReviewed(false);
    for (const p of ['/privacy', '/terms', '/disclaimer']) {
      assert.match((await http.request(p)).text, /يراجعها محامٍ قبل الإطلاق/, p);
    }
    assert.equal((await post('/admin/launch/confirm/legal_review', admin.cookie, { reason: 'تمت المراجعة', note: ' ' })).status, 422);
    const ok = await post('/admin/launch/confirm/legal_review', admin.cookie, { reason: 'تمت المراجعة', note: 'المحامي خالد', on: '2026-10-05' });
    assert.equal(ok.status, 302);
    assert.equal(platformSettings.legalReviewedNow(), true);
    for (const p of ['/privacy', '/terms', '/disclaimer']) {
      const text = (await http.request(p)).text;
      assert.doesNotMatch(text, /يراجعها محامٍ قبل الإطلاق/, p);
      assert.match(text, /الجهة المشغّلة|بيانات الجهة المشغّلة/, 'the rest of the page is intact');
    }
    platformSettings.setLegalReviewed(false);
  });

  test('test email: needs a reason and an address, records only the result (not the address), 5 an hour', async () => {
    assert.equal((await post('/admin/launch/smtp-test', admin.cookie, { to: 'me@example.com', reason: ' ' })).status, 422);
    assert.equal((await post('/admin/launch/smtp-test', admin.cookie, { to: 'not-an-address', reason: 'تجربة البريد' })).status, 422);
    assert.equal(mailer.sent.length, 0);
    const ok = await post('/admin/launch/smtp-test', admin.cookie, { to: 'me@example.com', reason: 'تجربة البريد' });
    assert.equal(ok.headers.get('location'), '/admin/launch?done=smtp_ok');
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, 'me@example.com');
    const row = (await one("SELECT setting_value FROM settings WHERE setting_key = 'launch.smtp_test'")).setting_value;
    assert.equal(JSON.parse(row).ok, true);
    assert.ok(!row.includes('me@example.com'), 'the address is not stored');
    const audit = await one("SELECT after_json FROM audit_logs WHERE action = 'admin.launch.smtp_test' ORDER BY id DESC LIMIT 1");
    assert.ok(!JSON.stringify(audit.after_json).includes('me@example.com'));
    const checks = await launch.runChecks({ pool: db.pool, env: process.env, now: new Date(), host: null });
    assert.equal(byId(checks).smtp.status, 'pass');

    mailer.fail = 'EAUTH';
    const bad = await post('/admin/launch/smtp-test', admin.cookie, { to: 'me@example.com', reason: 'تجربة ثانية' });
    assert.equal(bad.headers.get('location'), '/admin/launch?done=smtp_failed');
    assert.deepEqual(JSON.parse((await one("SELECT setting_value FROM settings WHERE setting_key = 'launch.smtp_test'")).setting_value).error, 'EAUTH');
    mailer.fail = null;
    let limited = 0;
    for (let i = 0; i < 5; i += 1) if ((await post('/admin/launch/smtp-test', admin.cookie, { to: 'me@example.com', reason: 'تجربة أخرى' })).status === 429) limited += 1;
    assert.ok(limited >= 1, 'the sixth attempt in an hour is refused');
  });

  test('two-factor guard still applies to the page', async () => {
    process.env.REQUIRE_ADMIN_2FA = 'true';
    try {
      assert.equal((await http.request('/admin/launch', { cookie: admin.cookie })).status, 403);
      assert.equal((await post('/admin/launch/confirm/secrets_rotated', admin.cookie, { reason: 'سبب صحيح' })).status, 403);
    } finally {
      process.env.REQUIRE_ADMIN_2FA = 'false';
    }
  });
});
