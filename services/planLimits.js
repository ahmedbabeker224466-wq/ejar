'use strict';

// Plan limits (plans.max_units, plans.max_contracts, later max_members).
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

/** Arabic refusal for the contract limit. */
function contractLimitMessage({ limit, current }) {
  return `وصلت إلى حد باقتك: ${limit} عقداً سارياً (لديك ${current}). رقِّ اشتراكك لإضافة عقود أكثر.`;
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

// Contracts that count against max_contracts: the running ones. Ended,
// terminated and renewed contracts do not (a renewal replaces its contract).
const LIVE_SQL = "status IN ('calm','soon','urgent','deadline_passed')";

/**
 * Like unitUsage, for contracts: max_contracts and the running contracts.
 * With { lock: true } it must be the FIRST statement of the transaction.
 */
async function contractUsage(scoped, { lock = false } = {}) {
  const [office] = await scoped.query(
    `SELECT o.id, p.max_contracts FROM offices o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = :office_id${lock ? ' FOR UPDATE' : ''}`,
  );
  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM contracts WHERE office_id = :office_id AND ${LIVE_SQL}${lock ? ' LOCK IN SHARE MODE' : ''}`,
  );
  return { limit: office && office.max_contracts !== null ? Number(office.max_contracts) : null, current: Number(n) };
}

/**
 * Like unitUsage, for maintenance photos (plans.max_photos, NULL = unlimited):
 * the photos stored for this office. With { lock: true } it must be the FIRST
 * statement of the transaction.
 */
async function photoUsage(scoped, { lock = false } = {}) {
  const [office] = await scoped.query(
    `SELECT o.id, p.max_photos FROM offices o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = :office_id${lock ? ' FOR UPDATE' : ''}`,
  );
  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM maintenance_photos ph
       JOIN maintenance_requests r ON r.id = ph.request_id
      WHERE r.office_id = :office_id${lock ? ' LOCK IN SHARE MODE' : ''}`,
  );
  return { limit: office && office.max_photos !== null && office.max_photos !== undefined ? Number(office.max_photos) : null, current: Number(n) };
}

/**
 * Like unitUsage, for team members (plans.max_members, NULL = unlimited): the
 * active office members, the owner included. With { lock: true } it must be
 * the FIRST statement of the transaction.
 */
async function memberUsage(scoped, { lock = false } = {}) {
  const [office] = await scoped.query(
    `SELECT o.id, p.max_members FROM offices o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = :office_id${lock ? ' FOR UPDATE' : ''}`,
  );
  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM office_members WHERE office_id = :office_id AND is_active = 1${lock ? ' LOCK IN SHARE MODE' : ''}`,
  );
  return { limit: office && office.max_members !== null && office.max_members !== undefined ? Number(office.max_members) : null, current: Number(n) };
}

/**
 * Like unitUsage, for public listings (plans.max_listings, NULL = unlimited):
 * the office's listings that are not rented. With { lock: true } it must be
 * the FIRST statement of the transaction.
 */
async function listingUsage(scoped, { lock = false } = {}) {
  const [office] = await scoped.query(
    `SELECT o.id, p.max_listings FROM offices o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = :office_id${lock ? ' FOR UPDATE' : ''}`,
  );
  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM listings WHERE office_id = :office_id AND status <> 'rented'${lock ? ' LOCK IN SHARE MODE' : ''}`,
  );
  return { limit: office && office.max_listings !== null && office.max_listings !== undefined ? Number(office.max_listings) : null, current: Number(n) };
}

/** Arabic refusal for the listing limit. */
function listingLimitMessage({ limit, current }) {
  return `وصلت إلى حد باقتك: ${limit} إعلانات (لديك ${current}). احذف إعلاناً قديماً أو رقِّ اشتراكك.`;
}

/** Arabic refusal for the photo limit. */
function photoLimitMessage({ limit }) {
  return `وصل المكتب إلى حد باقته من الصور (${limit} صورة). أرسل الطلب بدون صور أو تواصل مع المكتب.`;
}

/** Arabic refusal for the team limit. */
function memberLimitMessage({ limit, current }) {
  return `وصلت إلى حد باقتك: ${limit} أعضاء فعّالين (لديك ${current}). رقِّ اشتراكك لإضافة أعضاء أكثر.`;
}

module.exports = {
  checkLimit, unitLimitMessage, contractLimitMessage, usageText, unitUsage, contractUsage,
  photoUsage, memberUsage, listingUsage, photoLimitMessage, memberLimitMessage, listingLimitMessage,
};
