'use strict';

// Subscription plans: validation, CRUD for the platform admin, usage against
// the limits and the downgrade check. A plan change applies to subscribers at
// once, because every limit check reads the plan row live (planLimits.js).
//
// plans.features is an object of on/off switches. A missing key, a null value
// or the older array form means "allowed", so existing plans and offices keep
// working until an admin switches something off.

const { scopeToOffice } = require('./scopeToOffice');
const money = require('./money');
const aiUsage = require('./aiUsage');
const { toWesternDigits } = require('../utils/phone');

const FEATURE_FLAGS = Object.freeze({
  whatsapp: 'إرسال التذكيرات عبر واتساب',
  telegram: 'إرسال التذكيرات عبر تيليجرام',
  reports_csv: 'تنزيل التقارير بصيغة CSV',
  ai_reading: 'قراءة العقد بالذكاء الاصطناعي',
});

// plan column -> label, in the order shown. max_members is "max staff" in the
// product language: the active team members, the owner included.
const LIMITS = Object.freeze([
  { key: 'max_units', usage: 'units', label: 'الوحدات', unit: 'وحدة' },
  { key: 'max_contracts', usage: 'contracts', label: 'العقود السارية', unit: 'عقد' },
  { key: 'max_members', usage: 'members', label: 'أعضاء الفريق', unit: 'عضو' },
  { key: 'max_ai_reads_monthly', usage: 'aiReads', label: 'قراءات الذكاء الاصطناعي في الشهر', unit: 'قراءة', monthly: true },
  { key: 'max_photos', usage: 'photos', label: 'صور الصيانة', unit: 'صورة' },
]);

/** The on/off switches of a plan as { flag: boolean } (legacy and empty = all on). */
function normalizeFeatures(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.keys(FEATURE_FLAGS).map((flag) => [flag, object[flag] !== false]));
}

function planAllows(plan, flag) {
  return normalizeFeatures(plan && plan.features)[flag] === true;
}

// ------------------------------------------------------------ validation

function cleanText(value, max) {
  return toWesternDigits(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A price typed in riyals ('0', '99', '99.50') as halalas, or null. */
function parsePrice(input) {
  const text = toWesternDigits(String(input ?? '')).trim();
  if (text === '' || /^0+(\.0+)?$/.test(text)) return 0;
  return money.parseAmount(text);
}

function parseLimit(input) {
  const text = toWesternDigits(String(input ?? '')).trim();
  if (text === '') return { value: null };
  if (!/^\d{1,7}$/.test(text) || Number(text) < 1) return { error: true };
  return { value: Number(text) };
}

/**
 * Checks the plan form. Returns { values, errors }. values: code, name_ar,
 * prices in halalas (priceMonthly, priceYearly), limits (null = unlimited),
 * features, is_public, is_active, sort_order.
 */
function validatePlan(body = {}, { creating = false } = {}) {
  const errors = {};
  const values = {};

  if (creating) {
    values.code = cleanText(body.code, 30).toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(values.code)) errors.code = 'رمز الباقة حروف إنجليزية صغيرة وأرقام فقط (مثل: gold).';
  }
  values.name_ar = cleanText(body.name_ar, 80);
  if (values.name_ar.length < 2) errors.name_ar = 'اكتب اسم الباقة.';

  for (const [field, column] of [['price_monthly', 'priceMonthly'], ['price_yearly', 'priceYearly']]) {
    const parsed = parsePrice(body[field]);
    if (parsed === null) errors[field] = 'اكتب سعراً صحيحاً بالريال (حتى خانتين بعد الفاصلة).';
    else values[column] = parsed;
  }

  for (const limit of LIMITS) {
    const parsed = parseLimit(body[limit.key]);
    if (parsed.error) errors[limit.key] = 'اكتب رقماً صحيحاً أكبر من صفر، أو اتركه فارغاً لعدم وجود حد.';
    else values[limit.key] = parsed.value;
  }

  values.features = Object.fromEntries(Object.keys(FEATURE_FLAGS).map((flag) => [flag, body[`feature_${flag}`] === '1' || body[`feature_${flag}`] === 'on']));
  values.is_public = body.is_public === '1' || body.is_public === 'on' ? 1 : 0;
  values.is_active = body.is_active === '1' || body.is_active === 'on' ? 1 : 0;
  const sort = toWesternDigits(String(body.sort_order ?? '0')).trim() || '0';
  if (!/^-?\d{1,5}$/.test(sort)) errors.sort_order = 'اكتب رقم ترتيب صحيحاً.';
  else values.sort_order = Number(sort);

  return { values, errors };
}

// ------------------------------------------------------------ CRUD (platform admin)

const PLAN_COLUMNS = `id, code, name_ar, price_monthly, price_yearly, currency, max_contracts, max_units, max_members,
  max_ai_reads_monthly, max_photos, is_public, features, is_active, sort_order`;

async function listPlans(pool, { onlyBuyable = false } = {}) {
  const [rows] = await pool.query(
    `SELECT ${PLAN_COLUMNS} FROM plans ${onlyBuyable ? 'WHERE is_active = 1 AND is_public = 1 AND price_monthly > 0' : ''} ORDER BY sort_order ASC, id ASC`,
  );
  return rows;
}

async function getPlan(pool, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[row]] = await pool.query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`, [id]);
  return row || null;
}

async function createPlan(pool, values) {
  const [result] = await pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, currency, max_contracts, max_units, max_members,
        max_ai_reads_monthly, max_photos, is_public, features, is_active, sort_order)
     VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.code, values.name_ar, money.toDecimal(values.priceMonthly), money.toDecimal(values.priceYearly),
      values.max_contracts, values.max_units, values.max_members, values.max_ai_reads_monthly, values.max_photos,
      values.is_public, JSON.stringify(values.features), values.is_active, values.sort_order,
    ],
  );
  return result.insertId;
}

async function updatePlan(pool, id, values) {
  const [result] = await pool.query(
    `UPDATE plans SET name_ar = ?, price_monthly = ?, price_yearly = ?, max_contracts = ?, max_units = ?, max_members = ?,
        max_ai_reads_monthly = ?, max_photos = ?, is_public = ?, features = ?, is_active = ?, sort_order = ?
      WHERE id = ?`,
    [
      values.name_ar, money.toDecimal(values.priceMonthly), money.toDecimal(values.priceYearly),
      values.max_contracts, values.max_units, values.max_members, values.max_ai_reads_monthly, values.max_photos,
      values.is_public, JSON.stringify(values.features), values.is_active, values.sort_order, id,
    ],
  );
  return result.affectedRows === 1;
}

/** Deletes a plan nobody uses. Returns false when an office, order or subscription still points at it. */
async function deletePlan(pool, id) {
  const [result] = await pool.query(
    `DELETE FROM plans WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM offices WHERE plan_id = plans.id)
        AND NOT EXISTS (SELECT 1 FROM orders WHERE plan_id = plans.id)
        AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE plan_id = plans.id)`,
    [id],
  );
  return result.affectedRows === 1;
}

// ------------------------------------------------------------ usage and downgrade

/** What the office uses now: units, live contracts, active members, photos, AI reads this month. */
async function usageFor(pool, officeId, now = new Date()) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT
       (SELECT COUNT(*) FROM units WHERE office_id = :office_id) AS units,
       (SELECT COUNT(*) FROM contracts WHERE office_id = :office_id AND status IN ('calm','soon','urgent','deadline_passed')) AS contracts,
       (SELECT COUNT(*) FROM office_members WHERE office_id = :office_id AND is_active = 1) AS members,
       (SELECT COUNT(*) FROM maintenance_photos ph JOIN maintenance_requests r ON r.id = ph.request_id WHERE r.office_id = :office_id) AS photos`,
  );
  const ai = await aiUsage.usageFor(pool, officeId, now);
  return {
    units: Number(row.units),
    contracts: Number(row.contracts),
    members: Number(row.members),
    photos: Number(row.photos),
    aiReads: ai.used,
  };
}

/** Usage next to each limit of a plan, for the billing page: [{ label, unit, used, limit }]. */
function usageRows(plan, usage) {
  return LIMITS.map((l) => ({
    key: l.key,
    label: l.label,
    unit: l.unit,
    used: usage[l.usage],
    limit: plan && plan[l.key] !== null && plan[l.key] !== undefined ? Number(plan[l.key]) : null,
  }));
}

/**
 * Whether the office may move to `plan`: its current usage must fit the new
 * limits (the monthly AI allowance is not a stock, so it never blocks).
 * Returns { ok, problems: [{ label, unit, used, limit, reduceBy }], message }.
 * Nothing is deleted; the message tells the office what to reduce.
 */
function checkDowngrade(plan, usage) {
  const problems = [];
  for (const l of LIMITS) {
    if (l.monthly) continue;
    const limit = plan[l.key];
    if (limit === null || limit === undefined) continue;
    const used = usage[l.usage];
    if (used > Number(limit)) problems.push({ label: l.label, unit: l.unit, used, limit: Number(limit), reduceBy: used - Number(limit) });
  }
  if (problems.length === 0) return { ok: true, problems, message: null };
  const lines = problems.map((p) => `${p.label}: لديك ${p.used} والحد ${p.limit} (قلّل ${p.reduceBy} ${p.unit})`);
  return {
    ok: false,
    problems,
    message: `لا يمكن الانتقال إلى باقة «${plan.name_ar}» الآن لأن استخدامك أكبر من حدودها. ${lines.join('، ')}. لن يُحذف شيء تلقائياً؛ قلّل الاستخدام ثم حاول مرة أخرى.`,
  };
}

module.exports = {
  FEATURE_FLAGS,
  LIMITS,
  normalizeFeatures,
  planAllows,
  validatePlan,
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  usageFor,
  usageRows,
  checkDowngrade,
};
