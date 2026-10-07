'use strict';

// The notification center: one row per person per message (the on-site
// channel, always on), plus a delivery_log row per outside channel the person
// has switched on. Message text holds nicknames, dates and amounts only and
// always ends with the disclaimer. A notification belongs to its user_id:
// every read and write here filters by it.

const { afterQuietHours, isValidClock } = require('./contractDates');

const DISCLAIMER = 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط';
const CHANNELS = ['email', 'whatsapp', 'telegram'];
const DEFAULT_QUIET = { start: '21:00', end: '08:00' };
const PAGE_SIZE = 20;

const KIND_LABELS = {
  decision_60: 'موعد قرار التجديد',
  rent_change_90: 'موعد تغيير الإيجار',
  payment_due: 'دفعة مستحقة',
  payment_late: 'دفعة متأخرة',
  contract_ended: 'انتهاء عقد',
  digest: 'ملخص المكتب اليومي',
  maintenance_new: 'طلب صيانة جديد',
  maintenance_update: 'تحديث طلب صيانة',
  message_new: 'رسالة جديدة',
  task_assigned: 'مهمة مسندة',
  task_due: 'مهمة تستحق غداً',
  trial_expired: 'انتهاء التجربة',
  sub_reminder: 'قرب انتهاء الاشتراك',
  sub_expired: 'انتهاء الاشتراك',
  sub_suspended: 'إيقاف الحساب',
  billing_paid: 'تأكيد دفع الاشتراك',
  billing_transfer: 'قرار الحوالة البنكية',
  billing_alert: 'تنبيه مالي',
  listing_inquiry: 'استفسار على إعلان',
  listing_expiring: 'إعلان على وشك أن يُخفى',
  listing_report: 'بلاغ عن إعلان',
  contact_new: 'رسالة من نموذج التواصل',
  test: 'رسالة تجربة',
};

/** Appends the disclaimer once. */
function withDisclaimer(body) {
  const text = String(body || '').trim();
  return text.endsWith(DISCLAIMER) ? text : `${text}\n\n${DISCLAIMER}`;
}

/** Only links inside the app ('/...') are stored. */
function safeLink(link) {
  return typeof link === 'string' && /^\/(?!\/)[^\s]*$/.test(link) ? link.slice(0, 255) : null;
}

// ------------------------------------------------------------ preferences

/**
 * A person's channel switches (default on), quiet hours (default 21:00-08:00
 * Riyadh) and per-kind opt-outs ('channel:kind').
 */
async function prefsFor(pool, userId) {
  const [rows] = await pool.query(
    'SELECT channel, event_type, enabled, quiet_start, quiet_end FROM notification_prefs WHERE user_id = ?',
    [userId],
  );
  const prefs = {
    channels: Object.fromEntries(CHANNELS.map((c) => [c, true])),
    quietStart: DEFAULT_QUIET.start,
    quietEnd: DEFAULT_QUIET.end,
    optOuts: new Set(),
  };
  for (const row of rows) {
    if (row.event_type === 'all') {
      if (row.channel === 'site') {
        if (isValidClock(row.quiet_start) && isValidClock(row.quiet_end)) {
          prefs.quietStart = row.quiet_start;
          prefs.quietEnd = row.quiet_end;
        }
      } else if (CHANNELS.includes(row.channel)) {
        prefs.channels[row.channel] = Boolean(Number(row.enabled));
      }
    } else if (!Number(row.enabled)) {
      prefs.optOuts.add(`${row.channel}:${row.event_type}`);
    }
  }
  return prefs;
}

/** Checks the settings form. Returns { values, errors }. */
function validatePrefs(body = {}) {
  const errors = {};
  const values = {
    channels: Object.fromEntries(CHANNELS.map((c) => [c, body[c] === '1' || body[c] === 'on'])),
    quietStart: String(body.quiet_start || ''),
    quietEnd: String(body.quiet_end || ''),
  };
  if (!isValidClock(values.quietStart) || !isValidClock(values.quietEnd)) errors.quiet = 'اختر وقت بداية ونهاية صحيحين.';
  return { values, errors };
}

async function savePrefs(pool, userId, { channels, quietStart, quietEnd }) {
  await pool.query(
    `INSERT INTO notification_prefs (user_id, channel, event_type, enabled, quiet_start, quiet_end)
     VALUES (?, 'site', 'all', 1, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = 1, quiet_start = VALUES(quiet_start), quiet_end = VALUES(quiet_end)`,
    [userId, quietStart, quietEnd],
  );
  for (const channel of CHANNELS) {
    await pool.query(
      `INSERT INTO notification_prefs (user_id, channel, event_type, enabled) VALUES (?, ?, 'all', ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
      [userId, channel, channels[channel] ? 1 : 0],
    );
  }
}

// ------------------------------------------------------------ create

/**
 * Queues one delivery_log row per outside channel the person keeps on.
 * Non-urgent messages wait for the end of the person's quiet hours.
 */
async function enqueueDeliveries(pool, { notificationId, userId, officeId = null, kind = null, urgent = false, now = new Date() }) {
  const prefs = await prefsFor(pool, userId);
  // Whole seconds: DATETIME rounds fractions, which could push "now" past the next run.
  const exact = urgent ? now : afterQuietHours(now, prefs.quietStart, prefs.quietEnd);
  const at = new Date(Math.floor(exact.getTime() / 1000) * 1000);
  const channels = CHANNELS.filter((c) => prefs.channels[c] && !prefs.optOuts.has(`${c}:${kind}`));
  for (const channel of channels) {
    await pool.query(
      `INSERT IGNORE INTO delivery_log (notification_id, office_id, channel, status, next_retry_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      [notificationId, officeId, channel, at],
    );
  }
  return channels;
}

/**
 * Creates a notification unless one with the same dedupe key exists, then
 * queues its outside deliveries. Returns the new id, or null for a duplicate.
 */
async function createNotification(pool, {
  userId, officeId = null, kind, title, body, link = null, contractId = null, dedupeKey = null, urgent = false, now = new Date(),
}) {
  const [result] = await pool.query(
    `INSERT IGNORE INTO notifications (user_id, office_id, kind, title, body, link, contract_id, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, officeId, kind, String(title).slice(0, 160), withDisclaimer(body), safeLink(link), contractId, dedupeKey],
  );
  if (result.affectedRows !== 1) return null;
  await enqueueDeliveries(pool, { notificationId: result.insertId, userId, officeId, kind, urgent, now });
  return result.insertId;
}

// ------------------------------------------------------------ read (always by user_id)

async function unreadCount(pool, userId) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
  return Number(row.n);
}

/** One page of a person's notifications, newest first, optionally of one kind. */
async function listFor(pool, userId, { kind = '', page = 1, pageSize = PAGE_SIZE } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (kind && Object.hasOwn(KIND_LABELS, kind)) {
    where.push('kind = ?');
    params.push(kind);
  }
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.join(' AND ')}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const [rows] = await pool.query(
    `SELECT id, kind, title, body, link, read_at, created_at FROM notifications
      WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${Number(pageSize)} OFFSET ${(current - 1) * pageSize}`,
    params,
  );
  return { rows, total, page: current, pages };
}

/** Marks one of the person's notifications read. False when it is not theirs. */
async function markRead(pool, userId, id) {
  const [result] = await pool.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE id = ? AND user_id = ?',
    [id, userId],
  );
  return result.affectedRows === 1;
}

async function markAllRead(pool, userId) {
  const [result] = await pool.query('UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE user_id = ? AND read_at IS NULL', [userId]);
  return result.affectedRows;
}

module.exports = {
  DISCLAIMER,
  CHANNELS,
  DEFAULT_QUIET,
  KIND_LABELS,
  withDisclaimer,
  safeLink,
  prefsFor,
  validatePrefs,
  savePrefs,
  enqueueDeliveries,
  createNotification,
  unreadCount,
  listFor,
  markRead,
  markAllRead,
};
