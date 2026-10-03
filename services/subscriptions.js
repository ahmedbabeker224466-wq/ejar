'use strict';

// Subscription lifecycle in the database: one `subscriptions` row per period
// (history; the newest live row is current), activation after a payment, and
// the daily job that moves statuses and sends reminders.
//
// offices.status / plan_id / subscription_ends_at stay the fast source for
// access checks (services/offices.js officeAccess); this module keeps them and
// the subscription rows in step.

const billing = require('../config/billing');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createNotification } = require('./notifications');
const { planTransition, periodState, reminderThreshold } = require('./subscriptionState');
const { subscriptionPeriodEnd, periodDaysLeft, riyadhDate, daysAfter } = require('./contractDates');
const { createAudit } = require('./audit');

const LIVE = "('trialing','active','past_due')";
// An admin suspension survives payments and the daily job: the office stays
// suspended until the admin lifts it.
const ADMIN_SUSPENDED_KEY = 'billing.admin_suspended';

/** The office's current subscription row (newest live one), or null. */
async function currentFor(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT s.*, p.code AS plan_code, p.name_ar AS plan_name FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.office_id = :office_id AND s.status IN ${LIVE} ORDER BY s.id DESC LIMIT 1`,
  );
  return row || null;
}

async function isAdminSuspended(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const row = await scoped.selectOne('office_settings', { setting_key: ADMIN_SUSPENDED_KEY }, { columns: ['setting_value'] });
  return Boolean(row && row.setting_value === '1');
}

/**
 * Makes a plan active for an office after a confirmed payment (call inside a
 * transaction on `conn`). The office row is locked first.
 *  - same plan still running: the new period starts where the old one ends
 *    (renewal, nothing lost)
 *  - another plan, an ended period or a trial: the new period starts now
 * The previous live row is closed (ended_reason). Returns the new period.
 */
async function activate(conn, { officeId, planId, interval, orderId = null, price, now = new Date() }) {
  const months = billing.INTERVAL_MONTHS[interval];
  if (!months) throw new Error('Unknown billing interval');
  const scoped = scopeToOffice(conn, officeId);
  const [office] = await scoped.query('SELECT id, status, plan_id, subscription_ends_at FROM offices WHERE id = :office_id FOR UPDATE');
  if (!office) throw new Error('Office not found');

  const [previous] = await scoped.query(
    `SELECT id, plan_id, status, period_end FROM subscriptions WHERE office_id = :office_id AND status IN ${LIVE} ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  const sameRunning = previous && previous.status === 'active'
    && Number(previous.plan_id) === Number(planId)
    && new Date(previous.period_end).getTime() > now.getTime();
  const start = sameRunning ? new Date(previous.period_end) : now;
  const end = subscriptionPeriodEnd(start, months);

  if (previous) {
    await scoped.query(
      'UPDATE subscriptions SET status = ?, ended_reason = ? WHERE id = ? AND office_id = :office_id',
      ['expired', sameRunning ? 'renewed' : previous.status === 'trialing' ? 'trial_converted' : 'plan_changed', previous.id],
    );
  }
  const subscriptionId = await scoped.insert('subscriptions', {
    plan_id: planId,
    status: 'active',
    billing_interval: interval,
    period_start: start,
    period_end: end,
    price: (Number(price) / 100).toFixed(2),
    order_id: orderId,
  });
  const keepSuspended = await isAdminSuspended(conn, officeId);
  await scoped.query(
    'UPDATE offices SET plan_id = ?, status = ?, subscription_ends_at = ? WHERE id = :office_id',
    [planId, keepSuspended ? 'suspended' : 'active', end],
  );
  return { subscriptionId, periodStart: start, periodEnd: end, renewed: Boolean(sameRunning) };
}

// ------------------------------------------------------------ admin actions

/**
 * Adds days to an office's trial (from now when it already ended). Only for
 * an office on trial. Returns the new end, or null when the office is not on trial.
 */
async function extendTrial(pool, { officeId, days, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [office] = await scoped.query('SELECT status, trial_ends_at FROM offices WHERE id = :office_id FOR UPDATE');
    if (!office || office.status !== 'trial') return null;
    const base = office.trial_ends_at && new Date(office.trial_ends_at).getTime() > now.getTime() ? new Date(office.trial_ends_at) : now;
    const end = daysAfter(base, days);
    await scoped.query('UPDATE offices SET trial_ends_at = ? WHERE id = :office_id', [end]);
    await scoped.query(
      "UPDATE subscriptions SET period_end = ? WHERE office_id = :office_id AND status = 'trialing'",
      [end],
    );
    return end;
  });
}

/** Suspends an office by hand (survives payments until lifted). */
async function suspend(pool, { officeId }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    await scoped.query('SELECT id FROM offices WHERE id = :office_id FOR UPDATE');
    await scoped.query("UPDATE offices SET status = 'suspended' WHERE id = :office_id");
    await conn.query(
      `INSERT INTO office_settings (office_id, setting_key, setting_value) VALUES (?, ?, '1')
       ON DUPLICATE KEY UPDATE setting_value = '1'`,
      [officeId, ADMIN_SUSPENDED_KEY],
    );
  });
}

/**
 * Lifts a manual suspension: the office goes back to the status its dates
 * say (active while a paid period runs, otherwise trial, whose own end date decides).
 * Returns the new status.
 */
async function unsuspend(pool, { officeId, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [office] = await scoped.query('SELECT subscription_ends_at FROM offices WHERE id = :office_id FOR UPDATE');
    await scoped.query("DELETE FROM office_settings WHERE office_id = :office_id AND setting_key = ?", [ADMIN_SUSPENDED_KEY]);
    const paid = office && office.subscription_ends_at;
    const status = paid ? 'active' : 'trial';
    await scoped.query('UPDATE offices SET status = ? WHERE id = :office_id', [status]);
    return status;
  });
}

/** Moves an office to another plan by hand (the plan row is the only thing that changes). */
async function setPlan(pool, { officeId, planId }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    await scoped.query('SELECT id FROM offices WHERE id = :office_id FOR UPDATE');
    await scoped.query('UPDATE offices SET plan_id = ? WHERE id = :office_id', [planId]);
    await scoped.query(
      `UPDATE subscriptions SET plan_id = ? WHERE office_id = :office_id AND status IN ${LIVE}`,
      [planId],
    );
  });
}

// ------------------------------------------------------------ the daily job

async function notifyOwner(pool, office, { kind, title, body, dedupeKey, urgent = false, now }) {
  if (!office.owner_id) return false;
  const id = await createNotification(pool, {
    userId: office.owner_id, officeId: office.id, kind, title, body, link: '/office/billing', dedupeKey, urgent, now,
  });
  return Boolean(id);
}

/**
 * The daily subscription job (cron 'plan_renewal'). Idempotent:
 *  1. a paid period that ended -> 'past_due' (the read-only grace), owner told
 *  2. after the grace -> 'suspended', owner told
 *  3. reminders 7 / 3 / 1 days before the last day, for paid periods and trials
 *  4. unpaid orders past their expiry -> 'expired', promo reservations released
 * Returns the number of changes and notifications made. `officeId` limits the
 * run to one office (tests, support).
 */
async function runDaily({ pool, now = new Date(), officeId = null }) {
  let processed = 0;
  const [offices] = await pool.query(
    `SELECT id, name, status, owner_id, trial_ends_at, subscription_ends_at FROM offices
      WHERE status IN ('trial','active','past_due') ${officeId ? 'AND id = ?' : ''} ORDER BY id`,
    officeId ? [officeId] : [],
  );
  for (const office of offices) {
    const to = planTransition(office, now);
    if (to) {
      const scoped = scopeToOffice(pool, office.id);
      const moved = await scoped.query(
        'UPDATE offices SET status = ? WHERE id = :office_id AND status = ?',
        [to, office.status],
      );
      if (moved.affectedRows === 1) {
        processed += 1;
        const period = riyadhDate(new Date(office.subscription_ends_at));
        await scoped.query(
          `UPDATE subscriptions SET status = ?, ended_reason = ? WHERE office_id = :office_id AND status IN ('active','past_due')`,
          to === 'suspended' ? ['expired', 'grace_over'] : ['past_due', null],
        );
        await createAudit(pool).log(null, office.id, to === 'suspended' ? 'subscription.suspend' : 'subscription.past_due', 'office', office.id, { status: office.status }, { status: to }, null);
        if (to === 'past_due') {
          if (await notifyOwner(pool, office, {
            kind: 'sub_expired',
            title: 'انتهى اشتراك مكتبك',
            body: `انتهى اشتراك ${office.name}. حسابك الآن في وضع القراءة فقط لمدة ${billing.GRACE_DAYS} أيام. جدّد الاشتراك لتعود إلى التعديل.`,
            dedupeKey: `sub_expired:o${office.id}:${period}`,
            urgent: true,
            now,
          })) processed += 1;
        } else if (await notifyOwner(pool, office, {
          kind: 'sub_suspended',
          title: 'تم إيقاف حساب مكتبك',
          body: `أُوقف حساب ${office.name} لانتهاء مهلة التجديد. بياناتك محفوظة ${billing.DATA_KEEP_DAYS} يوماً؛ جدّد الاشتراك لإعادة التشغيل.`,
          dedupeKey: `sub_suspended:o${office.id}:${period}`,
          urgent: true,
          now,
        })) processed += 1;
        continue;
      }
    }

    // Reminders before the last day of a running period (paid or trial).
    const endsAt = office.status === 'trial' ? office.trial_ends_at : office.status === 'active' ? office.subscription_ends_at : null;
    if (!endsAt || periodState(endsAt, now).state !== 'active') continue;
    const threshold = reminderThreshold(periodDaysLeft(endsAt, now));
    if (threshold === null) continue;
    const label = threshold === 1 ? 'غداً' : `بعد ${threshold} أيام`;
    const what = office.status === 'trial' ? 'تجربتك المجانية' : 'اشتراكك';
    if (await notifyOwner(pool, office, {
      kind: 'sub_reminder',
      title: `${what} ينتهي ${label}`,
      body: `${what} في ${office.name} ينتهي ${label}. ${office.status === 'trial' ? 'اشترك' : 'جدّد'} من صفحة الاشتراك حتى لا يتوقف الحساب.`,
      dedupeKey: `sub_remind:o${office.id}:${riyadhDate(new Date(endsAt))}:${threshold}`,
      urgent: threshold === 1,
      now,
    })) processed += 1;
  }
  processed += await expireOrders({ pool, now, officeId });
  return processed;
}

/** Expires unpaid orders past their time (a bank order that has a transfer waits for the admin). */
async function expireOrders({ pool, now = new Date(), officeId = null }) {
  const [stale] = await pool.query(
    `SELECT o.id FROM orders o
      WHERE o.status = 'pending' AND o.suspicious = 0 AND o.expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM bank_transfers t WHERE t.order_id = o.id) ${officeId ? 'AND o.office_id = ?' : ''}`,
    officeId ? [now, officeId] : [now],
  );
  let expired = 0;
  for (const { id } of stale) {
    const changed = await withTransaction(pool, async (conn) => {
      const [[order]] = await conn.query("SELECT id, status FROM orders WHERE id = ? FOR UPDATE", [id]);
      if (!order || order.status !== 'pending') return false;
      await conn.query("UPDATE orders SET status = 'expired' WHERE id = ?", [id]);
      await conn.query("DELETE FROM promo_usages WHERE order_id = ? AND status = 'reserved'", [id]);
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

module.exports = {
  ADMIN_SUSPENDED_KEY,
  currentFor,
  isAdminSuspended,
  activate,
  extendTrial,
  suspend,
  unsuspend,
  setPlan,
  runDaily,
  expireOrders,
};
