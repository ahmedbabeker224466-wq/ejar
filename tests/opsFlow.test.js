'use strict';

// Platform operations against a throwaway database: the health check and its
// alerts (once per issue per day, "all clear" on recovery), the SMS balance
// warning, the monthly platform report (idempotent, counts only), the minimal
// /healthz, and the manual /cron/run endpoint for these jobs.
// Nothing here writes to the `backups` table or starts a backup (backup.test.js
// does, and the two files run in parallel against one database).
// Runs only when TEST_DB_NAME is set (the pure parts always run).

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000024NN. NN = 00 is the platform admin.
const phone = (n) => `9665000024${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 6 }, (_, i) => phone(i));
const PERIOD = '2020-03';
const logLines = [];
const consoleOriginals = {};
const saved = {};
const MB = 1024 * 1024;

let db;
let http;
let ops;
let dates;
let smsDrivers;
let tmp;
let adminId;
let adminCookie;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'CRON_SECRET', 'BACKUP_DIR', 'UPLOAD_DIR', 'SMS_BALANCE_WARN', 'SMS_PROVIDER', 'SMS_API_KEY', 'SMS_USERNAME']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.PLATFORM_ADMIN_PHONE = '0500002400';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'ops-cron-secret-0123456789';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-ops-'));
  process.env.BACKUP_DIR = path.join(tmp, 'backups');
  process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
  db = require('../config/db');
  await db.ensureSchema();
  ops = require('../services/ops');
  dates = require('../services/contractDates');
  smsDrivers = require('../services/sms');
  await cleanup();
  http = createOfficeHttp(db);
  await http.start();
  const login = await http.login(phone(0));
  adminCookie = login.cookie;
  adminId = (await http.userByPhone(phone(0))).id;
  assert.equal((await http.userByPhone(phone(0))).role, 'platform_admin');
  for (const level of ['log', 'info', 'warn', 'error']) {
    consoleOriginals[level] = console[level];
    console[level] = (...args) => logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query('DELETE FROM platform_reports WHERE period = ?', [PERIOD]);
  await db.pool.query("DELETE FROM contact_messages WHERE name LIKE 'عمليات-%'");
}

test.after(async () => {
  for (const [level, fn] of Object.entries(consoleOriginals)) console[level] = fn;
  if (ops) ops.setPinger(async () => false);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const alertsFor = async (kind, like) => Number((await one(
  'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = ? AND dedupe_key LIKE ?', [adminId, kind, like],
)).n);

// ------------------------------------------------------------ pure: thresholds

test('health thresholds: each measurement crosses its line exactly once, unmeasured values are never alarms', () => {
  const ops2 = require('../services/ops');
  const base = { db: true, cronAgeMinutes: 5, backupAgeHours: 3, backupExpected: true, diskBackup: 5000 * MB, diskUploads: 5000 * MB, queue: { pending: 3, oldestMinutes: 10 }, failedLastHour: 0, suspiciousOrders: 0 };
  const keys = (changes) => ops2.evaluate({ ...base, ...changes }).map((i) => i.key);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ db: false }), ['db']);
  assert.deepEqual(keys({ cronAgeMinutes: 30 }), []);
  assert.deepEqual(keys({ cronAgeMinutes: 31 }), ['cron']);
  assert.deepEqual(keys({ cronAgeMinutes: null }), [], 'never run yet: not an alarm');
  assert.deepEqual(keys({ backupAgeHours: 36 }), []);
  assert.deepEqual(keys({ backupAgeHours: 37 }), ['backup']);
  assert.deepEqual(keys({ backupAgeHours: null }), ['backup']);
  assert.deepEqual(keys({ backupAgeHours: null, backupExpected: false }), [], 'a brand new platform has no backup yet');
  assert.deepEqual(keys({ diskBackup: 199 * MB }), ['disk_backup']);
  assert.deepEqual(keys({ diskBackup: 200 * MB }), []);
  assert.deepEqual(keys({ diskBackup: null, diskUploads: null }), [], 'statfs missing: skipped');
  assert.deepEqual(keys({ diskUploads: 10 * MB }), ['disk_uploads']);
  assert.deepEqual(keys({ queue: { pending: 5, oldestMinutes: 61 } }), ['queue']);
  assert.deepEqual(keys({ queue: { pending: 0, oldestMinutes: 999 } }), []);
  assert.deepEqual(keys({ queue: { pending: 501, oldestMinutes: 1 } }), ['queue']);
  assert.deepEqual(keys({ failedLastHour: 10 }), []);
  assert.deepEqual(keys({ failedLastHour: 11 }), ['failed_deliveries']);
  assert.deepEqual(keys({ suspiciousOrders: 1 }), ['suspicious_payments']);
  assert.deepEqual(keys({ db: false, cronAgeMinutes: 99 }), ['db', 'cron']);
  for (const key of ['db', 'cron', 'backup', 'disk_backup', 'disk_uploads', 'queue', 'failed_deliveries', 'suspicious_payments']) assert.ok(ops2.ISSUE_LABELS[key], key);
});

test('collectChecks reads each measurement from the right place (stub database, fixed clock)', async () => {
  const ops2 = require('../services/ops');
  const now = new Date('2026-12-01T12:00:00Z');
  const stub = {
    async query(sql) {
      if (/^SELECT 1/.test(sql)) return [[{ 1: 1 }]];
      if (sql.includes('FROM cron_runs')) return [[{ at: new Date('2026-12-01T11:15:00Z') }]];
      if (sql.includes('FROM backups')) return [[{ at: new Date('2026-11-29T20:00:00Z') }]];
      if (sql.includes('FROM users')) return [[{ at: new Date('2026-01-01T00:00:00Z') }]];
      if (sql.includes('FROM orders')) return [[{ n: 1 }]];
      if (sql.includes("status = 'pending'")) return [[{ n: 4, oldest: new Date('2026-12-01T10:30:00Z') }]];
      if (sql.includes("status = 'failed'")) return [[{ n: 2 }]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const statfs = async (dir) => ({ bavail: dir.includes('bk') ? 100 : 1000, bsize: MB });
  const checks = await ops2.collectChecks({ pool: stub, now, env: { BACKUP_DIR: '/srv/bk', UPLOAD_DIR: '/srv/up' }, statfs });
  assert.deepEqual(checks, {
    db: true, cronAgeMinutes: 45, backupAgeHours: 40, backupExpected: true, diskBackup: 100 * MB, diskUploads: 1000 * MB,
    queue: { pending: 4, oldestMinutes: 90 }, failedLastHour: 2, suspiciousOrders: 1,
  });
  assert.deepEqual(ops2.evaluate(checks).map((i) => i.key), ['cron', 'backup', 'disk_backup', 'queue', 'suspicious_payments']);
  // Without statfs the disk checks are skipped; a dead database is reported alone.
  const noDisk = await ops2.collectChecks({ pool: stub, now, env: { BACKUP_DIR: '/srv/bk' }, statfs: undefined });
  assert.equal(noDisk.diskBackup, null);
  assert.equal(noDisk.diskUploads, null);
  const dead = await ops2.collectChecks({ pool: { query: async () => { throw new Error('down'); } }, now, env: {} });
  assert.deepEqual(dead, { db: false });
});

// ------------------------------------------------------------ health_ping with the database

const RELAXED = { cronStaleMinutes: Infinity, backupMaxHours: Infinity, diskMinFreeBytes: 0, queueOldestMinutes: Infinity, queueMax: Infinity, failedLastHour: Infinity, suspiciousOrders: Infinity };

test('health_ping: an alert once per issue per day, the snapshot is stored, an "all clear" on recovery, the monitor is pinged only when healthy', { skip }, async () => {
  await db.pool.query("DELETE FROM settings WHERE setting_key = 'ops.health_snapshot'");
  const pings = [];
  ops.setPinger(async (url) => { pings.push(url); return true; });
  const env = { ...process.env, BACKUP_DIR: path.join(tmp, 'bk'), UPLOAD_DIR: path.join(tmp, 'up'), HEALTHCHECK_PING_URL: 'https://uptime.example/ping/secret-token' };
  const day1 = new Date('2026-12-05T08:00:00Z');
  const lowDisk = async () => ({ bavail: 50, bsize: MB });
  const tight = { ...RELAXED, diskMinFreeBytes: 200 * MB };
  const keyDay = (key, d) => `ops_issue:${key}:${dates.riyadhDate(d)}:u${adminId}`;

  const found = await ops.runHealthPing({ pool: db.pool, now: day1, env, statfs: lowDisk, thresholds: tight });
  assert.equal(found, 2);
  assert.equal(await alertsFor('ops_alert', keyDay('disk_backup', day1)), 1);
  assert.equal(await alertsFor('ops_alert', keyDay('disk_uploads', day1)), 1);
  assert.deepEqual(pings, [], 'not healthy: the monitor is not pinged');
  const snap = await ops.latestSnapshot(db.pool);
  assert.equal(snap.ok, false);
  assert.deepEqual(snap.issues, ['disk_backup', 'disk_uploads']);
  assert.equal(snap.at, day1.toISOString());
  const note = await one("SELECT title, body, link FROM notifications WHERE user_id = ? AND dedupe_key = ?", [adminId, keyDay('disk_backup', day1)]);
  assert.match(note.title, /تنبيه تشغيلي/);
  assert.match(note.body, /50 ميغابايت/);
  assert.equal(note.link, '/admin/ops');

  // Same day, again: no new alerts.
  await ops.runHealthPing({ pool: db.pool, now: new Date('2026-12-05T08:15:00Z'), env, statfs: lowDisk, thresholds: tight });
  assert.equal(await alertsFor('ops_alert', keyDay('disk_backup', day1)), 1);
  const total = await alertsFor('ops_alert', 'ops_issue:disk%');
  assert.equal(total, 2);

  // Recovery: one "all clear" per resolved issue, the snapshot is ok, the monitor is pinged.
  const day1Later = new Date('2026-12-05T09:00:00Z');
  const healthy = await ops.runHealthPing({ pool: db.pool, now: day1Later, env, statfs: async () => ({ bavail: 100000, bsize: MB }), thresholds: tight });
  assert.equal(healthy, 0);
  assert.equal(await alertsFor('ops_clear', `ops_clear:disk_backup:${dates.riyadhDate(day1Later)}:u${adminId}`), 1);
  assert.equal(await alertsFor('ops_clear', `ops_clear:disk_uploads:${dates.riyadhDate(day1Later)}:u${adminId}`), 1);
  assert.equal((await ops.latestSnapshot(db.pool)).ok, true);
  assert.deepEqual(pings, ['https://uptime.example/ping/secret-token']);
  // Healthy again: nothing more to clear, one more ping.
  await ops.runHealthPing({ pool: db.pool, now: new Date('2026-12-05T09:15:00Z'), env, statfs: async () => ({ bavail: 100000, bsize: MB }), thresholds: tight });
  assert.equal(await alertsFor('ops_clear', 'ops_clear:%'), 2);
  assert.equal(pings.length, 2);

  // The next day the same problem alerts again.
  const day2 = new Date('2026-12-06T08:00:00Z');
  await ops.runHealthPing({ pool: db.pool, now: day2, env, statfs: lowDisk, thresholds: tight });
  assert.equal(await alertsFor('ops_alert', keyDay('disk_backup', day2)), 1);
  // A monitor URL that is not https is never called.
  pings.length = 0;
  await ops.runHealthPing({ pool: db.pool, now: new Date('2026-12-06T09:00:00Z'), env: { ...env, HEALTHCHECK_PING_URL: 'http://insecure.example/x' }, statfs: async () => ({ bavail: 100000, bsize: MB }), thresholds: tight });
  assert.deepEqual(pings, []);
  // A monitor that throws never fails the job.
  ops.setPinger(async () => { throw new Error('monitor down'); });
  assert.equal(await ops.runHealthPing({ pool: db.pool, now: new Date('2026-12-06T10:00:00Z'), env, statfs: async () => ({ bavail: 100000, bsize: MB }), thresholds: tight }), 0);
  ops.setPinger(async () => false);
  assert.ok(!JSON.stringify(await ops.latestSnapshot(db.pool)).includes('secret-token'));
});

// ------------------------------------------------------------ /healthz

test('/healthz answers {"ok":true} and nothing else; /health/detail stays behind the secret', { skip }, async () => {
  const res = await fetch(`${http.base()}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(res.headers.get('x-powered-by'), null);
  const post = await fetch(`${http.base()}/healthz`, { method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal((await fetch(`${http.base()}/health/detail`)).status, 403);
  const robots = await (await fetch(`${http.base()}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/health/, '/health also covers /healthz');
});

// ------------------------------------------------------------ sms_balance

test('SMS drivers: the console driver has no balance; Unifonic and Msegat read one from the provider reply', async () => {
  const sms = require('../services/sms');
  assert.deepEqual(await sms.getBalance(sms.selectDriver({ NODE_ENV: 'development', SMS_PROVIDER: 'console' })), { supported: false });
  assert.deepEqual(await sms.getBalance({ name: 'none' }), { supported: false });
  assert.deepEqual(await sms.getBalance({ async getBalance() { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); } }), { supported: true, ok: false, error: 'ECONNRESET' });

  const unifonic = require('../services/sms/unifonic');
  const msegat = require('../services/sms/msegat');
  const env = { SMS_API_KEY: process.env.SMS_API_KEY, SMS_USERNAME: process.env.SMS_USERNAME };
  try {
    delete process.env.SMS_API_KEY;
    delete process.env.SMS_USERNAME;
    assert.deepEqual(await unifonic.getBalance(async () => assert.fail('no call without a key')), { supported: true, ok: false, error: 'not_configured' });
    assert.deepEqual(await msegat.getBalance(async () => assert.fail('no call without a key')), { supported: true, ok: false, error: 'not_configured' });
    process.env.SMS_API_KEY = 'test-key-not-real-123';
    process.env.SMS_USERNAME = 'test-user';
    const seen = [];
    const reply = (status, body) => async (url, options) => { seen.push({ url, options }); return { status, body: typeof body === 'string' ? body : JSON.stringify(body) }; };
    assert.deepEqual(await unifonic.getBalance(reply(200, { success: true, data: { Balance: '42.5' } })), { supported: true, ok: true, balance: 42.5 });
    assert.equal((await unifonic.getBalance(reply(200, { success: false }))).error, 'bad_response');
    assert.equal((await unifonic.getBalance(reply(500, ''))).error, 'http_500');
    assert.equal((await unifonic.getBalance(async () => ({ error: 'timeout' }))).error, 'timeout');
    assert.deepEqual(await msegat.getBalance(reply(200, '1234')), { supported: true, ok: true, balance: 1234 });
    assert.deepEqual(await msegat.getBalance(reply(200, { balance: 77 })), { supported: true, ok: true, balance: 77 });
    assert.equal((await msegat.getBalance(reply(200, 'oops'))).error, 'bad_response');
    assert.equal((await msegat.getBalance(reply(403, ''))).error, 'http_403');
    assert.ok(seen.every((s) => s.url.startsWith('https://')));
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('sms_balance: unsupported provider is recorded quietly; a low balance warns the platform admin once a day', { skip }, async () => {
  const run = (now, result, env = {}) => ops.runSmsBalance({ pool: db.pool, now, env: { ...process.env, ...env }, getBalance: async () => result });
  const day = new Date('2026-12-10T07:00:00Z');
  assert.equal(await run(day, { supported: false }), 0);
  assert.deepEqual(await ops.latestSmsBalance(db.pool), { at: day.toISOString(), supported: false });
  assert.equal(await alertsFor('sms_low', 'sms_low:%'), 0);

  assert.equal(await run(day, { supported: true, ok: true, balance: 250 }), 0, 'above the default 100');
  assert.equal(await run(day, { supported: true, ok: true, balance: 99 }), 1);
  assert.equal(await run(new Date('2026-12-10T12:00:00Z'), { supported: true, ok: true, balance: 90 }), 0, 'once per day');
  assert.equal(await alertsFor('sms_low', `sms_low:${dates.riyadhDate(day)}:u${adminId}`), 1);
  assert.equal(await run(new Date('2026-12-11T07:00:00Z'), { supported: true, ok: true, balance: 90 }), 1, 'a new day warns again');
  const stored = await ops.latestSmsBalance(db.pool);
  assert.deepEqual([stored.supported, stored.ok, stored.balance], [true, true, 90]);
  const note = await one("SELECT body FROM notifications WHERE user_id = ? AND kind = 'sms_low' ORDER BY id DESC", [adminId]);
  assert.match(note.body, /90/);

  // SMS_BALANCE_WARN changes the line; a failed read warns nobody and never stores a key.
  assert.equal(await run(new Date('2026-12-12T07:00:00Z'), { supported: true, ok: true, balance: 150 }, { SMS_BALANCE_WARN: '200' }), 1);
  assert.equal(ops.smsWarnLevel({ SMS_BALANCE_WARN: 'abc' }), 100);
  assert.equal(ops.smsWarnLevel({ SMS_BALANCE_WARN: '-5' }), 100);
  assert.equal(ops.smsWarnLevel({}), 100);
  assert.equal(await run(new Date('2026-12-13T07:00:00Z'), { supported: true, ok: false, error: 'http_500' }), 0);
  assert.deepEqual((await ops.latestSmsBalance(db.pool)).error, 'http_500');
  // The unsupported driver through the real selection.
  assert.equal(await ops.runSmsBalance({ pool: db.pool, now: new Date('2026-12-14T07:00:00Z'), env: process.env, getBalance: () => smsDrivers.getBalance(smsDrivers.selectDriver({ NODE_ENV: 'development', SMS_PROVIDER: 'console' })) }), 0);
});

// ------------------------------------------------------------ monthly report

test('monthly report: counts only, idempotent per period, one notification, no phone or name data', { skip }, async () => {
  // Two offices created in the period, one contact message inside and one outside it.
  const o1 = await http.registerOffice(phone(1), 'تجربة-تقرير-سري-1');
  const o2 = await http.registerOffice(phone(2), 'تجربة-تقرير-سري-2');
  await db.pool.query("UPDATE offices SET created_at = '2020-03-15 10:00:00' WHERE id IN (?, ?)", [o1.office.id, o2.office.id]);
  await db.pool.query("INSERT INTO contact_messages (name, phone, email, message, created_at) VALUES ('عمليات-زائر', '0555000777', 'visitor@example.com', 'رسالة سرية للتقرير', '2020-03-20 10:00:00'), ('عمليات-خارج', '0555000888', NULL, 'خارج الفترة', '2020-04-01 10:00:00')");
  await db.pool.query('DELETE FROM notifications WHERE user_id = ?', [adminId]);

  const now = new Date('2020-04-01T02:30:00Z'); // 05:30 in Riyadh on the 1st
  assert.equal(dates.previousMonthOf(dates.riyadhDate(now)), PERIOD);
  assert.equal(await ops.generateMonthlyReport({ pool: db.pool, now }), 1);
  assert.equal(await ops.generateMonthlyReport({ pool: db.pool, now }), 0, 'the same period is never created twice');
  assert.equal(await ops.generateMonthlyReport({ pool: db.pool, now: new Date('2020-04-02T02:30:00Z') }), 0);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM platform_reports WHERE period = ?', [PERIOD])).n), 1);
  assert.equal(await alertsFor('ops_report', `ops_report:${PERIOD}:u%`), 1);

  const row = await one('SELECT report_json FROM platform_reports WHERE period = ?', [PERIOD]);
  const report = typeof row.report_json === 'string' ? JSON.parse(row.report_json) : row.report_json;
  assert.equal(report.period, PERIOD);
  assert.equal(report.new_offices, 2);
  assert.equal(report.support_contact_messages, 1);
  assert.equal(report.backup_success_pct === null || typeof report.backup_success_pct === 'number', true);
  for (const [key, value] of Object.entries(report)) {
    assert.ok(['string', 'number'].includes(typeof value) || value === null, `${key} is a plain value`);
  }
  for (const key of ['active_subscriptions', 'mrr_halalas', 'churned_offices', 'notifications_created', 'deliveries_sent', 'deliveries_failed', 'ai_reads', 'backups_ok', 'backups_failed', 'support_contact_open', 'support_abuse_reports_open']) {
    assert.ok(Number.isInteger(report[key]) && report[key] >= 0, key);
  }
  assert.match(report.mrr_sar, /^[\d,]+\.\d{2}$|^\d+(\.\d{2})?$/);

  // Grep test: nothing personal in the stored JSON or the notification text.
  const stored = JSON.stringify(report);
  const note = await one("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'ops_report'", [adminId]);
  for (const text of [stored, note.title, note.body]) {
    assert.doesNotMatch(text, /(?<![\d+])(?:\+?966|0)?5\d{8}(?!\d)/, 'a phone number');
    assert.doesNotMatch(text, /@/, 'an email address');
    for (const secret of ['تجربة-تقرير', 'عمليات-', 'visitor', 'رسالة سرية', '0555000777']) assert.ok(!text.includes(secret), `${secret} leaked into the report`);
  }
  assert.match(note.body, /مكاتب جديدة: 2/);
  assert.match(note.body, new RegExp(PERIOD));

  // The list for the admin page.
  const listed = await ops.listReports(db.pool, 50);
  assert.ok(listed.some((r) => r.period === PERIOD && r.data.new_offices === 2));
});

// ------------------------------------------------------------ the manual cron endpoint and the jobs

test('the four reserved jobs are real: scheduled, runnable by name, and /cron/run answers only { ok, processed }', { skip }, async () => {
  const cron = require('../services/cron');
  for (const name of ['backup', 'sms_balance', 'health_ping', 'reports']) {
    assert.equal(typeof cron.JOBS[name].run, 'function', name);
    assert.equal(Boolean(cron.JOBS[name].placeholder), false, name);
  }
  assert.equal(cron.JOBS.backup.schedule, '0 2 * * *');
  assert.equal(cron.JOBS.sms_balance.schedule, '0 10 * * *');
  assert.equal(cron.JOBS.health_ping.schedule, '*/15 * * * *');
  assert.equal(cron.JOBS.reports.schedule, '0 5 1 * *');
  assert.equal(cron.TIMEZONE, 'Asia/Riyadh');

  const call = (job, secret) => fetch(`${http.base()}/cron/run/${job}`, { method: 'POST', headers: secret === undefined ? {} : { 'X-Cron-Secret': secret } });
  for (const job of ['health_ping', 'sms_balance', 'reports']) {
    assert.equal((await call(job)).status, 403, `${job} without the secret`);
    assert.equal((await call(job, 'wrong')).status, 403, `${job} with a wrong secret`);
    const ok = await call(job, process.env.CRON_SECRET);
    assert.equal(ok.status, 200, job);
    const body = await ok.json();
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'processed']);
    assert.equal(body.ok, true);
    assert.equal(await one("SELECT status FROM cron_runs WHERE job_name = ? ORDER BY id DESC LIMIT 1", [job]).then((r) => r.status), 'ok');
  }
  // The report job just wrote last month's report; remove it so the shared database stays as it was.
  await db.pool.query('DELETE FROM platform_reports WHERE period = ?', [dates.previousMonthOf(dates.riyadhDate(new Date()))]);
  assert.equal((await call('no_such_job', process.env.CRON_SECRET)).status, 404);
});

// ------------------------------------------------------------ logs

test('the logs of this file hold no URL token, phone number, name or email', { skip }, () => {
  const text = logLines.join('\n');
  assert.ok(!text.includes('secret-token'), 'the monitor URL token');
  assert.ok(!text.includes('test-key-not-real-123'), 'the SMS key');
  assert.doesNotMatch(text, /(?<![\d+])(?:\+?966|0)?5\d{8}(?!\d)/, 'a phone number');
  for (const secret of ['تجربة-تقرير', 'visitor@example.com', 'رسالة سرية']) assert.ok(!text.includes(secret), secret);
});
