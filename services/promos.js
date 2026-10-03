'use strict';

// Promo codes: percent or fixed amount (halalas), valid from/to, a maximum
// number of redemptions, once per office, limited to some plans.
//
// Redemption is server side and transactional: creating an order locks the
// promo row (FOR UPDATE), counts reserved + redeemed usages, and records a
// 'reserved' usage in the same transaction, so two parallel orders can never
// pass max_redemptions. The usage becomes 'redeemed' when the order is paid
// and is released when the order fails, expires or is rejected.

const money = require('./money');
const { riyadhMidnight, addDays, riyadhDate, isValidYmd } = require('./contractDates');
const { toWesternDigits } = require('../utils/phone');

const REASONS = Object.freeze({
  not_found: 'رمز الخصم غير صحيح.',
  inactive: 'رمز الخصم غير مفعّل.',
  not_started: 'رمز الخصم لم يبدأ بعد.',
  expired: 'انتهت صلاحية رمز الخصم.',
  max_reached: 'استُخدم رمز الخصم الحد الأقصى من المرات.',
  plan_not_applicable: 'رمز الخصم لا ينطبق على هذه الباقة.',
  already_used: 'سبق أن استخدم مكتبك رمز الخصم هذا.',
});

function normalizeCode(input) {
  const code = toWesternDigits(String(input ?? '')).replace(/\s/g, '').toUpperCase();
  return /^[A-Z0-9_-]{3,30}$/.test(code) ? code : null;
}

/** The promo as pricing.quote() wants it: { discount_type, percent_bp | fixed_halalas }. */
function forQuote(row) {
  if (!row) return null;
  return row.discount_type === 'percent'
    ? { discount_type: 'percent', percent_bp: Number(row.percent_bp) }
    : { discount_type: 'fixed', fixed_halalas: money.fromDecimal(row.fixed_amount) };
}

function planIdsOf(row) {
  let ids = row.plan_ids;
  if (typeof ids === 'string') {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = null;
    }
  }
  return Array.isArray(ids) && ids.length > 0 ? ids.map(Number) : null; // null = every plan
}

/**
 * Pure: can this promo be used now? `redeemed` counts reserved + redeemed
 * usages of the code; `usedByOffice` says this office already has one.
 * Returns { ok: true } or { ok: false, reason, message }.
 */
function evaluate({ promo, planId, now, redeemed = 0, usedByOffice = false }) {
  const fail = (reason) => ({ ok: false, reason, message: REASONS[reason] });
  if (!promo) return fail('not_found');
  if (!Number(promo.is_active)) return fail('inactive');
  if (promo.valid_from && now.getTime() < new Date(promo.valid_from).getTime()) return fail('not_started');
  if (promo.valid_to && now.getTime() >= new Date(promo.valid_to).getTime()) return fail('expired');
  const plans = planIdsOf(promo);
  if (plans && !plans.includes(Number(planId))) return fail('plan_not_applicable');
  if (usedByOffice) return fail('already_used');
  if (promo.max_redemptions !== null && promo.max_redemptions !== undefined && redeemed >= Number(promo.max_redemptions)) return fail('max_reached');
  return { ok: true };
}

/** A look for the checkout page: no lock, nothing reserved. */
async function check(pool, { code, officeId, planId, now = new Date() }) {
  const normalized = normalizeCode(code);
  if (!normalized) return evaluate({ promo: null });
  const [[promo]] = await pool.query('SELECT * FROM promo_codes WHERE code = ?', [normalized]);
  if (!promo) return evaluate({ promo: null });
  const [[counts]] = await pool.query(
    'SELECT COUNT(*) AS used, COALESCE(SUM(office_id = ?), 0) AS mine FROM promo_usages WHERE promo_id = ?',
    [officeId, promo.id],
  );
  const result = evaluate({ promo, planId, now, redeemed: Number(counts.used), usedByOffice: Number(counts.mine) > 0 });
  return result.ok ? { ...result, promo } : result;
}

/**
 * Inside the order transaction: locks the promo row, re-checks everything and
 * returns { ok, promo } (or the refusal). The caller then inserts the order
 * and calls recordUsage() in the same transaction.
 */
async function lockAndCheck(conn, { code, officeId, planId, now = new Date() }) {
  const normalized = normalizeCode(code);
  if (!normalized) return evaluate({ promo: null });
  const [[promo]] = await conn.query('SELECT * FROM promo_codes WHERE code = ? FOR UPDATE', [normalized]);
  if (!promo) return evaluate({ promo: null });
  // A locking read: it sees usages committed by orders that waited on this
  // promo row before us (a plain read would use the older transaction snapshot).
  const [[counts]] = await conn.query(
    'SELECT COUNT(*) AS used, COALESCE(SUM(office_id = ?), 0) AS mine FROM promo_usages WHERE promo_id = ? LOCK IN SHARE MODE',
    [officeId, promo.id],
  );
  const result = evaluate({ promo, planId, now, redeemed: Number(counts.used), usedByOffice: Number(counts.mine) > 0 });
  return result.ok ? { ...result, promo } : result;
}

async function recordUsage(conn, { promoId, officeId, orderId }) {
  await conn.query(
    "INSERT INTO promo_usages (promo_id, office_id, order_id, status) VALUES (?, ?, ?, 'reserved')",
    [promoId, officeId, orderId],
  );
}

/** The order was paid: the usage is final. */
async function markRedeemed(conn, { orderId, promoId, officeId }) {
  const [result] = await conn.query("UPDATE promo_usages SET status = 'redeemed' WHERE order_id = ?", [orderId]);
  if (result.affectedRows === 0 && promoId) {
    await conn.query(
      "INSERT IGNORE INTO promo_usages (promo_id, office_id, order_id, status) VALUES (?, ?, ?, 'redeemed')",
      [promoId, officeId, orderId],
    );
  }
}

/** The order failed, expired or was rejected: the code can be used again. */
async function release(conn, orderId) {
  await conn.query("DELETE FROM promo_usages WHERE order_id = ? AND status = 'reserved'", [orderId]);
}

// ------------------------------------------------------------ admin

function dayInput(value) {
  const text = toWesternDigits(String(value ?? '')).trim();
  if (!text) return { value: null };
  return isValidYmd(text) ? { value: text } : { error: true };
}

/**
 * Checks the promo form. Dates are Riyadh days: valid_from is the start of
 * that day, valid_to the end of that day (stored as the start of the next).
 * Returns { values, errors }.
 */
function validatePromo(body = {}, { creating = false } = {}) {
  const errors = {};
  const values = {};
  if (creating) {
    values.code = normalizeCode(body.code);
    if (!values.code) errors.code = 'رمز الخصم من 3 إلى 30 حرفاً إنجليزياً أو رقماً (يمكن استخدام - و _).';
  }
  values.discount_type = body.discount_type === 'fixed' ? 'fixed' : 'percent';
  values.percent_bp = null;
  values.fixed_halalas = null;
  if (values.discount_type === 'percent') {
    const text = toWesternDigits(String(body.percent ?? '')).trim();
    const bp = /^\d{1,3}(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : 0;
    if (bp < 1 || bp > 10000) errors.percent = 'اكتب نسبة من 0.01 إلى 100.';
    else values.percent_bp = bp;
  } else {
    const halalas = money.parseAmount(String(body.fixed ?? ''));
    if (halalas === null) errors.fixed = 'اكتب مبلغاً صحيحاً بالريال أكبر من صفر.';
    else values.fixed_halalas = halalas;
  }
  const from = dayInput(body.valid_from);
  const to = dayInput(body.valid_to);
  if (from.error) errors.valid_from = 'تاريخ البداية غير صحيح.';
  if (to.error) errors.valid_to = 'تاريخ النهاية غير صحيح.';
  values.valid_from = from.value ? riyadhMidnight(from.value) : null;
  values.valid_to = to.value ? riyadhMidnight(addDays(to.value, 1)) : null;
  if (values.valid_from && values.valid_to && values.valid_to <= values.valid_from) errors.valid_to = 'تاريخ النهاية يجب أن يكون بعد البداية.';

  const max = toWesternDigits(String(body.max_redemptions ?? '')).trim();
  if (max === '') values.max_redemptions = null;
  else if (!/^\d{1,7}$/.test(max) || Number(max) < 1) errors.max_redemptions = 'اكتب عدداً صحيحاً أكبر من صفر، أو اتركه فارغاً.';
  else values.max_redemptions = Number(max);

  const planIds = [].concat(body.plan_ids || []).map((v) => String(v)).filter((v) => /^\d+$/.test(v)).map(Number);
  values.plan_ids = planIds.length > 0 ? [...new Set(planIds)] : null;
  values.is_active = body.is_active === '1' || body.is_active === 'on' ? 1 : 0;
  values.note = toWesternDigits(String(body.note ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null;
  return { values, errors };
}

/** The Riyadh day a stored (exclusive) end belongs to, for the edit form. */
function endDay(validTo) {
  return validTo ? riyadhDate(new Date(new Date(validTo).getTime() - 1)) : '';
}

async function list(pool) {
  const [rows] = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM promo_usages u WHERE u.promo_id = c.id) AS used,
            (SELECT COUNT(*) FROM promo_usages u WHERE u.promo_id = c.id AND u.status = 'redeemed') AS redeemed
       FROM promo_codes c ORDER BY c.id DESC`,
  );
  return rows;
}

async function get(pool, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[row]] = await pool.query('SELECT * FROM promo_codes WHERE id = ?', [id]);
  return row || null;
}

async function create(pool, values, createdBy) {
  const [result] = await pool.query(
    `INSERT INTO promo_codes (code, discount_type, percent_bp, fixed_amount, currency, valid_from, valid_to, max_redemptions, plan_ids, is_active, note, created_by)
     VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.code, values.discount_type, values.percent_bp,
      values.fixed_halalas === null ? null : money.toDecimal(values.fixed_halalas),
      values.valid_from, values.valid_to, values.max_redemptions,
      values.plan_ids === null ? null : JSON.stringify(values.plan_ids), values.is_active, values.note, createdBy,
    ],
  );
  return result.insertId;
}

async function update(pool, id, values) {
  const [result] = await pool.query(
    `UPDATE promo_codes SET discount_type = ?, percent_bp = ?, fixed_amount = ?, valid_from = ?, valid_to = ?,
            max_redemptions = ?, plan_ids = ?, is_active = ?, note = ? WHERE id = ?`,
    [
      values.discount_type, values.percent_bp,
      values.fixed_halalas === null ? null : money.toDecimal(values.fixed_halalas),
      values.valid_from, values.valid_to, values.max_redemptions,
      values.plan_ids === null ? null : JSON.stringify(values.plan_ids), values.is_active, values.note, id,
    ],
  );
  return result.affectedRows === 1;
}

module.exports = {
  REASONS,
  normalizeCode,
  forQuote,
  planIdsOf,
  evaluate,
  check,
  lockAndCheck,
  recordUsage,
  markRedeemed,
  release,
  validatePromo,
  endDay,
  list,
  get,
  create,
  update,
};
