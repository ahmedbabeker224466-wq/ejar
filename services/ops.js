'use strict';

// Platform operations: the health check (job health_ping), the SMS balance
// check (job sms_balance) and the monthly platform summary (job reports).
// Everything here is counts, ages and short codes: no phone numbers, names,
// keys or message text. Alerts go to the platform admin once per issue per day.

const fs = require('node:fs');
const https = require('node:https');
const db = require('../config/db');
const logger = require('../utils/logger');
const dates = require('./contractDates');
const money = require('./money');
const pricing = require('./pricing');
const backup = require('./backup');
const smsDrivers = require('./sms');
const { notifyPlatformAdmins } = require('./platformNotify');
const { inTests } = require('./channels/transport');

const SNAPSHOT_KEY = 'ops.health_snapshot';
const SMS_KEY = 'ops.sms_balance';
const MB = 1024 * 1024;

const THRESHOLDS = Object.freeze({
  cronStaleMinutes: 30, // the delivery job runs every 5 minutes
  backupMaxHours: 36,
  diskMinFreeBytes: 200 * MB,
  queueOldestMinutes: 60,
  queueMax: 500,
  failedLastHour: 10,
  suspiciousOrders: 0, // any unresolved suspicious payment is an issue
});

const ISSUE_LABELS = Object.freeze({
  db: 'قاعدة البيانات لا تستجيب',
  cron: 'المهام المجدولة متوقفة',
  backup: 'لا توجد نسخة احتياطية حديثة',
  disk_backup: 'مساحة مجلد النسخ الاحتياطي قليلة',
  disk_uploads: 'مساحة مجلد الصور قليلة',
  queue: 'طابور الرسائل متأخر',
  failed_deliveries: 'رسائل كثيرة فشل إرسالها في الساعة الماضية',
  suspicious_payments: 'دفعات مشبوهة تحتاج مراجعة',
});

async function getSetting(pool, key) {
  const [[row]] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  return row ? row.setting_value : null;
}

async function setSetting(pool, key, value) {
  await pool.query(
    'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, value],
  );
}

const minutesBetween = (from, to) => Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60000));

// ------------------------------------------------------------ health

/** Free bytes of the disk holding `dir`, or null when it cannot be told. */
async function freeBytes(dir, statfs) {
  try {
    if (typeof statfs !== 'function') return null;
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Pure: the issues a set of measurements shows. checks: { db, cronAgeMinutes,
 * backupAgeHours, backupExpected, diskBackup, diskUploads, queue, failedLastHour,
 * suspiciousOrders }; null means "not measured" and is never an issue.
 */
function evaluate(checks, t = THRESHOLDS) {
  const issues = [];
  if (checks.db === false) issues.push({ key: 'db', detail: '' });
  // Never having run is not an alarm (this very job runs from the same scheduler); a long silence is.
  if (typeof checks.cronAgeMinutes === 'number' && checks.cronAgeMinutes > t.cronStaleMinutes) {
    issues.push({ key: 'cron', detail: `آخر تشغيل قبل ${checks.cronAgeMinutes} دقيقة` });
  }
  if (checks.backupExpected && Number.isFinite(t.backupMaxHours) && (checks.backupAgeHours === null || checks.backupAgeHours > t.backupMaxHours)) {
    issues.push({ key: 'backup', detail: checks.backupAgeHours === null ? 'لا توجد نسخة ناجحة' : `آخر نسخة ناجحة قبل ${checks.backupAgeHours} ساعة` });
  }
  if (checks.diskBackup !== null && checks.diskBackup !== undefined && checks.diskBackup < t.diskMinFreeBytes) {
    issues.push({ key: 'disk_backup', detail: `المتاح ${Math.floor(checks.diskBackup / MB)} ميغابايت` });
  }
  if (checks.diskUploads !== null && checks.diskUploads !== undefined && checks.diskUploads < t.diskMinFreeBytes) {
    issues.push({ key: 'disk_uploads', detail: `المتاح ${Math.floor(checks.diskUploads / MB)} ميغابايت` });
  }
  if (checks.queue && (checks.queue.pending > t.queueMax || (checks.queue.pending > 0 && checks.queue.oldestMinutes > t.queueOldestMinutes))) {
    issues.push({ key: 'queue', detail: `${checks.queue.pending} رسالة، أقدمها منذ ${checks.queue.oldestMinutes} دقيقة` });
  }
  if (checks.failedLastHour > t.failedLastHour) issues.push({ key: 'failed_deliveries', detail: `${checks.failedLastHour} رسالة` });
  if (checks.suspiciousOrders > t.suspiciousOrders) issues.push({ key: 'suspicious_payments', detail: `${checks.suspiciousOrders} طلب` });
  return issues;
}

/** Measures the platform. Never throws: a failing probe is reported as an issue or skipped. */
async function collectChecks({ pool = db.pool, now = new Date(), env = process.env, statfs = fs.promises.statfs } = {}) {
  const checks = { db: true };
  try {
    await pool.query('SELECT 1');
  } catch {
    return { db: false };
  }

  // Cron heartbeat: the frequent jobs (health_ping itself is excluded).
  const [[cron]] = await pool.query("SELECT MAX(started_at) AS at FROM cron_runs WHERE job_name IN ('deliver', 'purge_auth') AND status = 'ok'");
  checks.cronAgeMinutes = cron.at ? minutesBetween(cron.at, now) : null;

  // Backups: expected once the platform is a day and a half old.
  const [[lastBackup]] = await pool.query("SELECT MAX(created_at) AS at FROM backups WHERE status = 'ok'");
  const [[firstUser]] = await pool.query('SELECT MIN(created_at) AS at FROM users');
  checks.backupAgeHours = lastBackup.at ? Math.floor(minutesBetween(lastBackup.at, now) / 60) : null;
  checks.backupExpected = Boolean(firstUser.at) && minutesBetween(firstUser.at, now) > THRESHOLDS.backupMaxHours * 60;

  let backupDirPath = null;
  try {
    backupDirPath = backup.backupDir(env);
  } catch {
    backupDirPath = null;
  }
  checks.diskBackup = backupDirPath ? await freeBytes(backupDirPath, statfs) : null;
  const uploads = env.UPLOAD_DIR ? env.UPLOAD_DIR : null;
  checks.diskUploads = uploads ? await freeBytes(uploads, statfs) : null;

  const [[queue]] = await pool.query(
    "SELECT COUNT(*) AS n, MIN(next_retry_at) AS oldest FROM delivery_log WHERE status = 'pending' AND next_retry_at <= ?", [now],
  );
  checks.queue = { pending: Number(queue.n), oldestMinutes: queue.oldest ? minutesBetween(queue.oldest, now) : 0 };
  const [[failed]] = await pool.query("SELECT COUNT(*) AS n FROM delivery_log WHERE status = 'failed' AND updated_at >= ?", [dates.hoursAfter(now, -1)]);
  checks.failedLastHour = Number(failed.n);
  const [[suspicious]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE suspicious = 1 AND status = 'pending'");
  checks.suspiciousOrders = Number(suspicious.n);
  return checks;
}

let pinger = async (url) => {
  if (inTests()) return false;
  return new Promise((resolve) => {
    try {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
};

/** For tests: replaces the uptime-monitor GET. fn(url) -> Promise<boolean>. */
function setPinger(fn) {
  pinger = fn;
}

/** The latest stored health snapshot, or null. */
async function latestSnapshot(pool = db.pool) {
  const raw = await getSetting(pool, SNAPSHOT_KEY);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * One health run: measures, stores the snapshot, notifies the platform admin
 * once per new issue per day, sends an "all clear" for issues that went away,
 * and pings the uptime monitor (HEALTHCHECK_PING_URL) when everything is fine.
 * Returns the number of issues found.
 */
async function runHealthPing({ pool = db.pool, now = new Date(), env = process.env, statfs, thresholds = THRESHOLDS } = {}) {
  const checks = await collectChecks({ pool, now, env, statfs });
  const issues = evaluate(checks, thresholds);
  const previous = await latestSnapshot(pool);
  const day = dates.riyadhDate(now);

  for (const issue of issues) {
    await notifyPlatformAdmins(pool, {
      kind: 'ops_alert',
      title: `تنبيه تشغيلي: ${ISSUE_LABELS[issue.key]}`,
      body: issue.detail ? `${ISSUE_LABELS[issue.key]}. ${issue.detail}.` : `${ISSUE_LABELS[issue.key]}.`,
      dedupeKey: `ops_issue:${issue.key}:${day}`,
      urgent: true,
      now,
    });
  }
  const open = new Set(issues.map((i) => i.key));
  for (const key of previous && Array.isArray(previous.issues) ? previous.issues : []) {
    if (open.has(key) || !Object.hasOwn(ISSUE_LABELS, key)) continue;
    await notifyPlatformAdmins(pool, {
      kind: 'ops_clear',
      title: 'عاد النظام لوضعه الطبيعي',
      body: `زال التنبيه: ${ISSUE_LABELS[key]}.`,
      dedupeKey: `ops_clear:${key}:${day}`,
      now,
    });
  }

  await setSetting(pool, SNAPSHOT_KEY, JSON.stringify({ at: now.toISOString(), ok: issues.length === 0, checks, issues: issues.map((i) => i.key), details: Object.fromEntries(issues.map((i) => [i.key, i.detail])) }));

  const url = (env.HEALTHCHECK_PING_URL || '').trim();
  if (issues.length === 0 && /^https:\/\//i.test(url)) {
    try {
      await pinger(url);
    } catch {
      // the monitor being down must not fail the job
    }
  }
  return issues.length;
}

// ------------------------------------------------------------ SMS balance

const smsWarnLevel = (env = process.env) => {
  const n = Number(env.SMS_BALANCE_WARN);
  return Number.isFinite(n) && n > 0 ? n : 100;
};

/** Reads the provider balance, stores it, and warns the platform admin (once a day) when it is low. Returns 1 when a warning was created. */
async function runSmsBalance({ pool = db.pool, now = new Date(), env = process.env, getBalance = smsDrivers.getBalance } = {}) {
  const result = await getBalance();
  const record = { at: now.toISOString(), supported: Boolean(result && result.supported) };
  if (record.supported) {
    record.ok = Boolean(result.ok);
    if (result.ok) record.balance = Number(result.balance);
    else record.error = String(result.error || 'error').slice(0, 40);
  }
  await setSetting(pool, SMS_KEY, JSON.stringify(record));
  if (!record.supported || !record.ok) return 0;
  const warn = smsWarnLevel(env);
  if (record.balance >= warn) return 0;
  const created = await notifyPlatformAdmins(pool, {
    kind: 'sms_low',
    title: 'رصيد الرسائل منخفض',
    body: `الرصيد المتبقي ${record.balance} وحدة، والحد الأدنى ${warn}. أعد الشحن حتى لا تتوقف رموز الدخول.`,
    dedupeKey: `sms_low:${dates.riyadhDate(now)}`,
    urgent: true,
    now,
  });
  return created > 0 ? 1 : 0;
}

async function latestSmsBalance(pool = db.pool) {
  const raw = await getSetting(pool, SMS_KEY);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ monthly report

/** The numbers of one Riyadh month ('YYYY-MM'): counts and amounts only. */
async function buildReport(pool, period, now) {
  const { start, end } = dates.monthBounds(period);
  const one = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);

  const [paid] = await pool.query(
    `SELECT s.price, s.billing_interval FROM subscriptions s JOIN offices o ON o.id = s.office_id
      WHERE s.status = 'active' AND o.status = 'active' AND s.period_end > ?`,
    [now],
  );
  const mrr = paid.reduce((sum, r) => {
    const price = money.fromDecimal(r.price);
    return sum + (r.billing_interval === 'yearly' ? pricing.divRound(price, 12) : price);
  }, 0);

  const [deliveries] = await pool.query('SELECT status, COUNT(*) AS n FROM delivery_log WHERE created_at >= ? AND created_at < ? GROUP BY status', [start, end]);
  const delivered = Object.fromEntries(deliveries.map((r) => [r.status, Number(r.n)]));
  const [backups] = await pool.query("SELECT status, COUNT(*) AS n FROM backups WHERE created_at >= ? AND created_at < ? AND status IN ('ok','failed') GROUP BY status", [start, end]);
  const backupCounts = Object.fromEntries(backups.map((r) => [r.status, Number(r.n)]));
  const backupRuns = (backupCounts.ok || 0) + (backupCounts.failed || 0);

  return {
    period,
    generated_at: now.toISOString(),
    new_offices: await one('SELECT COUNT(*) AS n FROM offices WHERE created_at >= ? AND created_at < ?', [start, end]),
    active_subscriptions: paid.length,
    mrr_halalas: mrr,
    mrr_sar: money.formatHalalas(mrr),
    churned_offices: await one(
      `SELECT COUNT(DISTINCT s.office_id) AS n FROM subscriptions s JOIN offices o ON o.id = s.office_id
        WHERE s.status IN ('expired', 'canceled') AND s.price > 0 AND s.period_end >= ? AND s.period_end < ? AND o.status <> 'active'`,
      [start, end],
    ),
    notifications_created: await one('SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ? AND created_at < ?', [start, end]),
    deliveries_sent: delivered.sent || 0,
    deliveries_failed: delivered.failed || 0,
    ai_reads: await one('SELECT COALESCE(SUM(`count`), 0) AS n FROM ai_reads_usage WHERE month = ?', [period]),
    backups_ok: backupCounts.ok || 0,
    backups_failed: backupCounts.failed || 0,
    backup_success_pct: backupRuns ? Math.round(((backupCounts.ok || 0) / backupRuns) * 100) : null,
    support_contact_messages: await one('SELECT COUNT(*) AS n FROM contact_messages WHERE created_at >= ? AND created_at < ?', [start, end]),
    support_contact_open: await one('SELECT COUNT(*) AS n FROM contact_messages WHERE handled_at IS NULL'),
    support_abuse_reports_open: await one("SELECT COUNT(*) AS n FROM listing_reports WHERE status = 'open'"),
  };
}

function reportText(r) {
  return [
    `تقرير شهر ${r.period}`,
    `مكاتب جديدة: ${r.new_offices}`,
    `اشتراكات نشطة: ${r.active_subscriptions}`,
    `الدخل الشهري المتكرر: ${r.mrr_sar} ريال`,
    `مكاتب غادرت: ${r.churned_offices}`,
    `إشعارات: ${r.notifications_created} (أُرسلت ${r.deliveries_sent}، فشلت ${r.deliveries_failed})`,
    `قراءات الذكاء الاصطناعي: ${r.ai_reads}`,
    `نجاح النسخ الاحتياطي: ${r.backup_success_pct === null ? 'لا نسخ' : `${r.backup_success_pct}%`}`,
    `رسائل التواصل: ${r.support_contact_messages} (مفتوحة ${r.support_contact_open})، بلاغات مفتوحة: ${r.support_abuse_reports_open}`,
  ].join('\n');
}

/**
 * Creates the report of `period` (default: the month before this one) unless it
 * exists, then notifies the platform admin. Returns 1 when created, 0 when it already existed.
 */
async function generateMonthlyReport({ pool = db.pool, now = new Date(), period = null } = {}) {
  const month = period || dates.previousMonthOf(dates.riyadhDate(now));
  const report = await buildReport(pool, month, now);
  const [insert] = await pool.query('INSERT IGNORE INTO platform_reports (period, report_json) VALUES (?, ?)', [month, JSON.stringify(report)]);
  if (insert.affectedRows !== 1) return 0;
  await notifyPlatformAdmins(pool, {
    kind: 'ops_report',
    title: `التقرير الشهري للمنصة: ${month}`,
    body: reportText(report),
    dedupeKey: `ops_report:${month}`,
    now,
  });
  return 1;
}

async function listReports(pool = db.pool, limit = 12) {
  const [rows] = await pool.query('SELECT period, report_json, created_at FROM platform_reports ORDER BY period DESC LIMIT ?', [limit]);
  return rows.map((r) => ({ period: r.period, createdAt: r.created_at, data: typeof r.report_json === 'string' ? JSON.parse(r.report_json) : r.report_json }));
}

module.exports = {
  THRESHOLDS,
  ISSUE_LABELS,
  evaluate,
  collectChecks,
  runHealthPing,
  latestSnapshot,
  setPinger,
  runSmsBalance,
  latestSmsBalance,
  smsWarnLevel,
  buildReport,
  reportText,
  generateMonthlyReport,
  listReports,
};
