'use strict';

// Scheduled jobs (node-cron, Asia/Riyadh). server.js starts them unless
// RUN_CRON=false; cPanel Cron Jobs can also call POST /cron/run/:job.
// Every job is idempotent and runs under its own MySQL advisory lock
// (GET_LOCK), so two app processes or servers never run the same job at the
// same time; the one that does not get the lock skips. Each run is recorded
// in cron_runs (status, count, duration; an error code only).

const cron = require('node-cron');
const db = require('../config/db');
const logger = require('../utils/logger');
const { riyadhDate, isTrialExpired } = require('./contractDates');
const { scopeToOffice } = require('./scopeToOffice');
const reminders = require('./reminders');
const delivery = require('./delivery');
const contractStatus = require('./contractStatus');
const { createNotification } = require('./notifications');
const { officeAccess } = require('./offices');

const TIMEZONE = 'Asia/Riyadh';
const LAST_RUN_KEY = 'reminders.last_run_date';

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

// ------------------------------------------------------------ jobs

async function runReminders({ pool, now }) {
  const today = riyadhDate(now);
  const lastRun = await getSetting(pool, LAST_RUN_KEY);
  const result = await reminders.computeDueReminders({ pool, today, lastRun, now });
  await setSetting(pool, LAST_RUN_KEY, today);
  return result.created;
}

async function runDigest({ pool, now }) {
  const today = riyadhDate(now);
  const [offices] = await pool.query('SELECT id, name, status, trial_ends_at, owner_id FROM offices WHERE owner_id IS NOT NULL ORDER BY id');
  let sent = 0;
  for (const office of offices) {
    if (officeAccess(office, now).locked) continue;
    const [c] = await scopeToOffice(pool, office.id).query(
      `SELECT (SELECT COUNT(*) FROM contracts WHERE office_id = :office_id AND status IN ('urgent','deadline_passed','soon')) AS action,
              (SELECT COUNT(*) FROM contract_payments WHERE office_id = :office_id AND status = 'late') AS late,
              (SELECT COUNT(*) FROM contract_requests WHERE office_id = :office_id AND status = 'pending') AS requests,
              (SELECT COUNT(*) FROM contract_payments WHERE office_id = :office_id AND status = 'tenant_reported') AS reported`,
    );
    const counts = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)]));
    if (!Object.values(counts).some((n) => n > 0)) continue;
    const id = await createNotification(pool, {
      userId: office.owner_id,
      officeId: office.id,
      kind: 'digest',
      title: `ملخص اليوم: ${office.name}`,
      body: `عقود تحتاج قراراً: ${counts.action}\nدفعات متأخرة: ${counts.late}\nطلبات جديدة من المستأجرين: ${counts.requests}\nدفعات بانتظار التأكيد: ${counts.reported}`,
      link: '/office',
      dedupeKey: `digest:o${office.id}:${today}`,
      now,
    });
    if (id) sent += 1;
  }
  return sent;
}

async function runTrialCheck({ pool, now }) {
  const [offices] = await pool.query("SELECT id, name, owner_id, trial_ends_at FROM offices WHERE status = 'trial' AND owner_id IS NOT NULL");
  let sent = 0;
  for (const office of offices) {
    if (!office.trial_ends_at || !isTrialExpired(office.trial_ends_at, now)) continue;
    const id = await createNotification(pool, {
      userId: office.owner_id,
      officeId: office.id,
      kind: 'trial_expired',
      title: 'انتهت الفترة التجريبية لمكتبك',
      body: `انتهت التجربة المجانية لـ ${office.name}. اشترك لتستمر التذكيرات وإدارة العقود.`,
      link: '/office/billing',
      dedupeKey: `trial_expired:o${office.id}:${riyadhDate(new Date(office.trial_ends_at))}`,
      urgent: true,
      now,
    });
    if (id) sent += 1;
  }
  return sent;
}

// Unused invite codes that expired more than 30 days ago are removed; a
// recently expired code stays so the office still sees "منتهي".
async function runExpireInvites({ pool }) {
  const [offices] = await pool.query('SELECT id FROM offices ORDER BY id');
  let removed = 0;
  for (const { id } of offices) {
    const result = await scopeToOffice(pool, id).query(
      `DELETE FROM invites WHERE office_id = :office_id AND used_at IS NULL
          AND expires_at < UTC_TIMESTAMP() - INTERVAL 30 DAY`,
    );
    removed += result.affectedRows;
  }
  return removed;
}

async function runPurgeNotifications({ pool }) {
  const [deliveries] = await pool.query('DELETE FROM delivery_log WHERE created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY');
  const [notes] = await pool.query('DELETE FROM notifications WHERE created_at < UTC_TIMESTAMP() - INTERVAL 180 DAY');
  return deliveries.affectedRows + notes.affectedRows;
}

// Kept a day past expiry: the login limits count recent codes.
async function runPurgeAuth({ pool }) {
  const [otp] = await pool.query('DELETE FROM otp_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  const [sessions] = await pool.query('DELETE FROM user_sessions WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  return otp.affectedRows + sessions.affectedRows;
}

// name -> { schedule (Riyadh time), run }. Placeholders are registered but off.
const JOBS = {
  reminders: { schedule: '0 7 * * *', label: 'إنشاء التذكيرات', run: runReminders },
  deliver: { schedule: '*/5 * * * *', label: 'إرسال الرسائل المعلقة', run: ({ pool, now }) => delivery.deliverPending({ pool, now }).then((r) => r.processed) },
  recompute: { schedule: '10 0 * * *', label: 'تحديث حالات العقود', run: ({ pool, now }) => contractStatus.recomputeStatuses({ pool, today: riyadhDate(now) }).then((r) => r.changed) },
  late_payments: { schedule: '20 0 * * *', label: 'تعليم الدفعات المتأخرة', run: ({ pool, now }) => contractStatus.markLatePayments({ pool, today: riyadhDate(now) }) },
  digest: { schedule: '0 8 * * *', label: 'ملخص المكتب اليومي', run: runDigest },
  expire_invites: { schedule: '15 * * * *', label: 'تنظيف رموز الدعوة القديمة', run: runExpireInvites },
  trial_check: { schedule: '30 9 * * *', label: 'فحص انتهاء التجربة', run: runTrialCheck },
  purge_notifications: { schedule: '0 3 * * 5', label: 'حذف الإشعارات القديمة', run: runPurgeNotifications },
  purge_auth: { schedule: '*/10 * * * *', label: 'حذف رموز الدخول والجلسات المنتهية', run: runPurgeAuth },
  backup: { schedule: '0 2 * * *', placeholder: true },
  plan_renewal: { schedule: '0 6 * * *', placeholder: true },
  sms_balance: { schedule: '0 10 * * *', placeholder: true },
  health_ping: { schedule: '*/15 * * * *', placeholder: true },
  reports: { schedule: '0 5 1 * *', placeholder: true },
};

// ------------------------------------------------------------ locking and running

/**
 * Runs fn under the advisory lock 'aqdi:job:<name>' on one connection.
 * Returns { ok, processed } or { ok: true, skipped: 'locked', processed: 0 }.
 */
async function runWithLock(pool, name, fn) {
  const conn = await pool.getConnection();
  const lockName = `aqdi:job:${name}`;
  try {
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [lockName]);
    if (Number(got) !== 1) return { ok: true, skipped: 'locked', processed: 0 };
    try {
      return { ok: true, processed: Number(await fn()) || 0 };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    conn.release();
  }
}

/** Runs one job now (scheduler or /cron/run). Never throws. */
async function runJob(name, { pool = db.pool, now = () => new Date() } = {}) {
  const job = Object.hasOwn(JOBS, name) ? JOBS[name] : null;
  if (!job) return { ok: false, error: 'unknown_job', processed: 0 };
  if (job.placeholder) return { ok: false, error: 'not_implemented', processed: 0 };
  const started = Date.now();
  let runId = null;
  try {
    return await runWithLock(pool, name, async () => {
      const [insert] = await pool.query("INSERT INTO cron_runs (job_name, started_at, status) VALUES (?, UTC_TIMESTAMP(), 'running')", [name]);
      runId = insert.insertId;
      const processed = await job.run({ pool, now: now() });
      await pool.query(
        "UPDATE cron_runs SET finished_at = UTC_TIMESTAMP(), duration_ms = ?, processed = ?, status = 'ok' WHERE id = ?",
        [Date.now() - started, Number(processed) || 0, runId],
      );
      return processed;
    });
  } catch (err) {
    const code = String(err.code || err.name || 'error').slice(0, 60);
    logger.error(`Cron job ${name} failed: ${code}`);
    if (runId) {
      await pool.query(
        "UPDATE cron_runs SET finished_at = UTC_TIMESTAMP(), duration_ms = ?, status = 'failed', error = ? WHERE id = ?",
        [Date.now() - started, code, runId],
      ).catch(() => {});
    }
    return { ok: false, error: 'failed', processed: 0 };
  }
}

/** Schedules every real job. Returns { stop }. Placeholders log once. */
function start({ pool = db.pool } = {}) {
  const tasks = [];
  const missing = [];
  for (const [name, job] of Object.entries(JOBS)) {
    if (job.placeholder) {
      missing.push(name);
      continue;
    }
    tasks.push(cron.schedule(job.schedule, () => runJob(name, { pool }), { name: `aqdi-${name}`, timezone: TIMEZONE, noOverlap: true }));
  }
  logger.info(`Cron started: ${tasks.length} jobs (Asia/Riyadh). Not implemented yet: ${missing.join(', ')}`);
  return {
    stop() {
      for (const task of tasks) task.destroy();
    },
  };
}

module.exports = { JOBS, TIMEZONE, LAST_RUN_KEY, runJob, runWithLock, start };
