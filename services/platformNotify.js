'use strict';

// Notifications for the platform admin(s): backup failures, health alerts, SMS
// balance and the monthly report. Text holds counts and short codes only.
// The dedupe key makes each one idempotent (one per issue per day).

const { createNotification } = require('./notifications');

/** Ids of the active platform_admin users. */
async function adminIds(pool) {
  const [rows] = await pool.query("SELECT id FROM users WHERE role = 'platform_admin' AND is_active = 1 ORDER BY id");
  return rows.map((r) => Number(r.id));
}

/** Creates the notification for every platform admin. Returns how many were new. */
async function notifyPlatformAdmins(pool, { kind, title, body, link = '/admin/ops', dedupeKey, urgent = false, now = new Date() }) {
  let created = 0;
  for (const userId of await adminIds(pool)) {
    const id = await createNotification(pool, { userId, kind, title, body, link, dedupeKey: `${dedupeKey}:u${userId}`, urgent, now });
    if (id) created += 1;
  }
  return created;
}

module.exports = { adminIds, notifyPlatformAdmins };
