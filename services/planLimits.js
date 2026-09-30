'use strict';

// Plan limits (plans.max_units, and later max_contracts / max_members).
// The decision is pure; the database side reads the office's plan while
// locking the office row, so parallel creates inside one office queue up and
// cannot pass the limit together.

/**
 * Whether `adding` more rows fit. limit null/undefined = unlimited.
 * Returns { ok, limit, current, remaining } (remaining null when unlimited).
 */
function checkLimit({ limit, current, adding = 1 }) {
  const used = Math.max(0, Number(current) || 0);
  if (limit === null || limit === undefined) return { ok: true, limit: null, current: used, remaining: null };
  const max = Number(limit);
  const remaining = Math.max(0, max - used);
  return { ok: adding <= remaining, limit: max, current: used, remaining };
}

/** Arabic refusal for the unit limit, e.g. "باقتك تسمح بـ 20 وحدة ...". */
function unitLimitMessage({ limit, current, remaining }) {
  if (remaining === 0) {
    return `وصلت إلى حد باقتك: ${limit} وحدة (لديك ${current}). رقِّ اشتراكك لإضافة وحدات أكثر.`;
  }
  return `باقتك تسمح بـ ${limit} وحدة، لديك ${current}، ويمكنك إضافة ${remaining} فقط. رقِّ اشتراكك لإضافة المزيد.`;
}

/** "N من M وحدة", or null when the plan has no limit. */
function usageText({ limit, current }) {
  if (limit === null || limit === undefined) return null;
  return `${current} من ${limit} وحدة`;
}

/**
 * Reads the unit limit and the current unit count for the scoped office.
 *
 * With { lock: true } (inside a transaction) the office row is locked, so a
 * second creator waits until this transaction ends, and the count is a
 * locking read, which sees rows committed by the one before it. (A plain
 * COUNT would read the transaction's snapshot and could miss them.) Call it
 * as the FIRST statement of the transaction.
 */
async function unitUsage(scoped, { lock = false } = {}) {
  const [office] = await scoped.query(
    `SELECT o.id, p.max_units FROM offices o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = :office_id${lock ? ' FOR UPDATE' : ''}`,
  );
  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM units WHERE office_id = :office_id${lock ? ' LOCK IN SHARE MODE' : ''}`,
  );
  return { limit: office && office.max_units !== null ? Number(office.max_units) : null, current: Number(n) };
}

module.exports = { checkLimit, unitLimitMessage, usageText, unitUsage };
