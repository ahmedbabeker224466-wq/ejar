'use strict';

// The default plan: the 'trial' plan when it is active, otherwise the cheapest
// active plan. An office whose plan_id is NULL (created before any plan
// existed) is read as being on this plan, and backfillOfficePlans() stores it
// once, together with the matching subscription row.
//
// No requires of config/db here: config/db.js calls the backfill from ensureSchema.

const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { trialEndsAt } = require('./contractDates');

const DEFAULT_PLAN_ORDER = "dp.code = 'trial' DESC, dp.price_monthly ASC, dp.sort_order ASC, dp.id ASC";

/** Scalar subquery: the default plan's id (NULL when no plan is active). */
const DEFAULT_PLAN_ID_SQL = `(SELECT dp.id FROM plans dp WHERE dp.is_active = 1 ORDER BY ${DEFAULT_PLAN_ORDER} LIMIT 1)`;

/** The plan id an office reads: its own, or the default when NULL. `alias` is the offices alias. */
function effectivePlanIdSql(alias = 'o') {
  return `COALESCE(${alias}.plan_id, ${DEFAULT_PLAN_ID_SQL})`;
}

/** `LEFT JOIN plans p` on the office's effective plan. */
function planJoin(alias = 'o', planAlias = 'p') {
  return `LEFT JOIN plans ${planAlias} ON ${planAlias}.id = ${effectivePlanIdSql(alias)}`;
}

/** The default plan's id, or null when no plan is active. */
async function defaultPlanId(pool) {
  const [[row]] = await pool.query(`SELECT ${DEFAULT_PLAN_ID_SQL} AS id`);
  return row && row.id !== null ? Number(row.id) : null;
}

// The live subscription row a backfilled office gets, from offices.status.
const SUBSCRIPTION_STATUS = { trial: 'trialing', active: 'active', past_due: 'past_due', suspended: 'expired' };

/**
 * Migration (run by ensureSchema and the seed): every office with plan_id NULL
 * gets the default plan, its subscription rows without a plan get it too, and
 * an office with no subscription row at all gets one that matches its status.
 * Idempotent: offices that already have a plan are never touched, and each
 * office is changed in one transaction with its row locked. Returns counts.
 */
async function backfillOfficePlans(pool, { now = new Date() } = {}) {
  const counts = { offices: 0, subscriptions: 0 };
  const planId = await defaultPlanId(pool);
  if (!planId) return counts;
  const [rows] = await pool.query('SELECT id FROM offices WHERE plan_id IS NULL ORDER BY id');
  for (const { id } of rows) {
    await withTransaction(pool, async (conn) => {
      const scoped = scopeToOffice(conn, id);
      const [office] = await scoped.query(
        'SELECT id, status, plan_id, trial_ends_at, subscription_ends_at, created_at FROM offices WHERE id = :office_id FOR UPDATE',
      );
      if (!office || office.plan_id !== null) return;
      await scoped.query('UPDATE offices SET plan_id = ? WHERE id = :office_id AND plan_id IS NULL', [planId]);
      await scoped.query('UPDATE subscriptions SET plan_id = ? WHERE office_id = :office_id AND plan_id IS NULL', [planId]);
      const [{ n }] = await scoped.query('SELECT COUNT(*) AS n FROM subscriptions WHERE office_id = :office_id');
      if (Number(n) === 0) {
        const status = SUBSCRIPTION_STATUS[office.status] || 'trialing';
        const start = office.created_at ? new Date(office.created_at) : now;
        const end = office.status === 'trial'
          ? (office.trial_ends_at ? new Date(office.trial_ends_at) : trialEndsAt(start))
          : (office.subscription_ends_at || office.trial_ends_at || now);
        await scoped.insert('subscriptions', {
          plan_id: planId,
          status,
          billing_interval: 'monthly',
          period_start: start,
          period_end: new Date(Math.max(new Date(end).getTime(), start.getTime())),
          price: 0,
        });
        counts.subscriptions += 1;
      }
      await conn.query(
        `INSERT INTO audit_logs (office_id, actor_id, action, entity_type, entity_id, before_json, after_json, ip)
         VALUES (?, NULL, 'office.plan_backfill', 'office', ?, ?, ?, NULL)`,
        [id, id, JSON.stringify({ plan_id: null }), JSON.stringify({ plan_id: planId })],
      );
      counts.offices += 1;
    });
  }
  return counts;
}

module.exports = { DEFAULT_PLAN_ID_SQL, effectivePlanIdSql, planJoin, defaultPlanId, backfillOfficePlans };
