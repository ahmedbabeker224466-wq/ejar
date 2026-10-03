'use strict';

// Rent payment TRACKING (the app never moves money). Each received amount is a
// payment_entries row on an installment; contract_payments.paid_amount is the
// sum of the live (not undone) entries and the installment is 'paid' only when
// that sum reaches its amount. Partial payments are exact: all sums are
// integer halalas. An entry can be undone within 24 hours, with a reason; the
// row is kept (undone_at, undo_reason) and the installment is recomputed.
//
// Audit rows and contract events hold ids and statuses, never amounts,
// reference codes or reasons.

const engine = require('./contractEngine');
const money = require('./money');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { withTransaction } = require('./transaction');
const { riyadhDate, hoursAfter, addDays } = require('./contractDates');
const { toWesternDigits } = require('../utils/phone');

const METHODS = { cash: 'نقداً', transfer: 'تحويل', other: 'أخرى' };
const ROLE_LABELS = { office: 'المكتب', landlord: 'المالك' };
const UNDO_HOURS = 24;
const REFERENCE_MAX = 40;
const REASON = { min: 3, max: 200 };
const SETTLED = new Set(['paid', 'waived']);

// ------------------------------------------------------------ validation

/**
 * A reference code is free text up to 40 characters that must not look like an
 * account number: no IBAN (two letters, two digits, then the account part,
 * with or without spaces) and no run of 10 or more digits (spaces, dashes,
 * dots and slashes between digits do not hide it).
 */
function validateReference(input) {
  const text = toWesternDigits(String(input ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return { value: null };
  if (text.length > REFERENCE_MAX) return { error: `رمز المرجع ${REFERENCE_MAX} حرفاً كحد أقصى.` };
  const squeezed = text.replace(/[\s\-._/]/g, '');
  if (/[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}/.test(squeezed) || /\d{10,}/.test(squeezed)) {
    return { error: 'لا تكتب رقم حساب أو آيبان أو رقماً طويلاً. اكتب رمزاً قصيراً تتذكره (مثل رقم الإيصال).' };
  }
  return { value: text };
}

/** Checks the "record a payment" form. Returns { values, errors }; amount is integer halalas or null (= the full remaining). */
function validateEntry(body = {}, today) {
  const errors = {};
  const values = { amount: null, paid_on: String(body.paid_on || '').trim() || today, method: String(body.method || ''), reference: null };
  const rawAmount = String(body.amount ?? '').trim();
  if (rawAmount) {
    values.amount = money.parseAmount(rawAmount);
    if (values.amount === null) errors.amount = 'اكتب مبلغاً صحيحاً أكبر من صفر (حتى خانتين بعد الفاصلة).';
  }
  if (!engine.isValidDate(values.paid_on)) errors.paid_on = 'اختر تاريخ الدفع.';
  else if (engine.isAfter(values.paid_on, today)) errors.paid_on = 'تاريخ الدفع لا يمكن أن يكون في المستقبل.';
  if (!Object.hasOwn(METHODS, values.method)) errors.method = 'اختر طريقة الدفع.';
  const reference = validateReference(body.reference);
  if (reference.error) errors.reference = reference.error;
  else values.reference = reference.value;
  return { values, errors };
}

/** Checks an undo reason. Returns { value } or { error }. */
function validateReason(input) {
  const text = toWesternDigits(String(input ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < REASON.min) return { error: 'اكتب سبب التراجع.' };
  if (text.length > REASON.max) return { error: `السبب ${REASON.max} حرفاً كحد أقصى.` };
  return { value: text };
}

// ------------------------------------------------------------ core (inside a transaction)

async function lockPayment(scoped, contractId, paymentId) {
  const [payment] = await scoped.query(
    'SELECT * FROM contract_payments WHERE id = ? AND contract_id = ? AND office_id = :office_id FOR UPDATE',
    [paymentId, contractId],
  );
  return payment || null;
}

const remainingOf = (payment) => Math.max(0, money.fromDecimal(payment.amount) - money.fromDecimal(payment.paid_amount));

/**
 * Recomputes paid_amount, status, paid_at and method from the live entries.
 * Waived installments are never touched. Returns the new { status, paidAmount }.
 */
async function refreshPayment(scoped, payment, today) {
  const entries = await scoped.query(
    `SELECT amount, paid_on, method FROM payment_entries
      WHERE payment_id = ? AND undone_at IS NULL AND office_id = :office_id ORDER BY paid_on, id`,
    [payment.id],
  );
  const paid = entries.reduce((sum, e) => sum + money.fromDecimal(e.amount), 0);
  const total = money.fromDecimal(payment.amount);
  const last = entries[entries.length - 1] || null;
  let status = payment.status;
  if (status !== 'waived') {
    if (paid >= total && total > 0) status = 'paid';
    else if (status === 'paid' || status === 'tenant_reported') status = engine.paymentDisplayStatus({ ...payment, status: 'due' }, today);
  }
  const reported = status === 'tenant_reported' || status === 'paid'; // a confirmed report keeps its trail
  await scoped.query(
    `UPDATE contract_payments SET paid_amount = ?, status = ?, paid_at = ?, method = ?,
            reported_at = ${reported ? 'reported_at' : 'NULL'}, reported_by = ${reported ? 'reported_by' : 'NULL'}
      WHERE id = ? AND office_id = :office_id`,
    [
      money.toDecimal(paid),
      status,
      status === 'paid' && last ? `${last.paid_on instanceof Date ? riyadhDate(last.paid_on) : String(last.paid_on).slice(0, 10)} 00:00:00` : null,
      status === 'paid' && last ? last.method : null,
      payment.id,
    ],
  );
  return { status, paidAmount: paid };
}

async function addEvent(scoped, contractId, actorId, type, details) {
  await scoped.insert('contract_events', { contract_id: contractId, actor_id: actorId || null, event_type: type, details: JSON.stringify(details) });
}

/**
 * Adds an entry to a locked installment and refreshes it. amount (halalas)
 * must be 1..remaining. Returns { ok, entryId, status } or { ok: false, error }.
 */
async function applyEntry(scoped, payment, { amount, paidOn, method, reference, actorId, role, today, eventType = 'payment_recorded' }) {
  if (SETTLED.has(payment.status)) return { ok: false, error: 'closed' };
  const remaining = remainingOf(payment);
  if (remaining <= 0) return { ok: false, error: 'closed' };
  const halalas = amount === null || amount === undefined ? remaining : amount;
  if (!Number.isInteger(halalas) || halalas <= 0) return { ok: false, error: 'amount' };
  if (halalas > remaining) return { ok: false, error: 'exceeds', remaining };
  const entryId = await scoped.insert('payment_entries', {
    contract_id: payment.contract_id,
    payment_id: payment.id,
    amount: money.toDecimal(halalas),
    currency: payment.currency,
    paid_on: paidOn,
    method: method || null,
    reference_code: reference || null,
    recorded_by: actorId || null,
    recorded_role: role,
  });
  const after = await refreshPayment(scoped, payment, today);
  if (eventType) await addEvent(scoped, payment.contract_id, actorId, eventType, { payment_id: payment.id, entry_id: entryId, status: after.status });
  return { ok: true, entryId, status: after.status };
}

/** Marks every live entry of an installment undone (a manual status change replaces them). */
async function voidEntries(scoped, payment, { actorId, reason }) {
  await scoped.query(
    `UPDATE payment_entries SET undone_at = UTC_TIMESTAMP(), undone_by = ?, undo_reason = ?
      WHERE payment_id = ? AND undone_at IS NULL AND office_id = :office_id`,
    [actorId || null, reason, payment.id],
  );
}

// ------------------------------------------------------------ public operations

/**
 * Records a payment (full or partial). actor: { id, role: 'office' | 'landlord' }.
 * Returns { ok, status } or { ok: false, error: 'not_found' | 'closed' | 'exceeds' | 'amount', remaining? }.
 */
async function recordPayment(pool, officeId, { contractId, paymentId, values, actor, ip, today }) {
  const result = await withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const payment = await lockPayment(scoped, contractId, paymentId);
    if (!payment) return { ok: false, error: 'not_found' };
    const done = await applyEntry(scoped, payment, {
      amount: values.amount, paidOn: values.paid_on, method: values.method, reference: values.reference, actorId: actor.id, role: actor.role, today,
    });
    if (done.ok) {
      await createAudit(conn).write(actor.id, officeId, 'payment.record', 'contract_payment', paymentId, null, { entry_id: done.entryId, status: done.status, by: actor.role }, ip);
    }
    return done;
  });
  return result;
}

/** Whether an entry is still inside its 24-hour undo window. */
function canUndo(entry, now = new Date()) {
  if (entry.undone_at) return false;
  return hoursAfter(new Date(entry.created_at), UNDO_HOURS).getTime() > now.getTime();
}

/**
 * Undoes an entry within 24 hours, with a reason; recomputes the installment.
 * The office may undo any entry of its office; a landlord only the entries
 * they recorded themselves. Returns { ok, status } or { ok: false, error:
 * 'not_found' | 'expired' | 'forbidden' }.
 */
async function undoEntry(pool, officeId, { contractId, paymentId, entryId, reason, actor, ip, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const payment = await lockPayment(scoped, contractId, paymentId);
    if (!payment) return { ok: false, error: 'not_found' };
    const [entry] = await scoped.query(
      'SELECT * FROM payment_entries WHERE id = ? AND payment_id = ? AND office_id = :office_id FOR UPDATE',
      [entryId, paymentId],
    );
    if (!entry || entry.undone_at) return { ok: false, error: 'not_found' };
    if (actor.role === 'landlord' && !(entry.recorded_role === 'landlord' && Number(entry.recorded_by) === Number(actor.id))) {
      return { ok: false, error: 'forbidden' };
    }
    if (!canUndo(entry, now)) return { ok: false, error: 'expired' };
    await scoped.query(
      'UPDATE payment_entries SET undone_at = UTC_TIMESTAMP(), undone_by = ?, undo_reason = ? WHERE id = ? AND office_id = :office_id',
      [actor.id, reason, entryId],
    );
    const after = await refreshPayment(scoped, payment, riyadhDate(now));
    await addEvent(scoped, contractId, actor.id, 'payment_undone', { payment_id: paymentId, entry_id: entryId, status: after.status });
    await createAudit(conn).write(actor.id, officeId, 'payment.undo', 'contract_payment', paymentId, { entry_id: entryId }, { status: after.status, by: actor.role }, ip);
    return { ok: true, status: after.status };
  });
}

// ------------------------------------------------------------ reading

/** The installments of a contract with their live entries and remaining amounts (halalas). */
async function historyFor(pool, officeId, contractId, today, now = new Date()) {
  const scoped = scopeToOffice(pool, officeId);
  const payments = await scoped.select('contract_payments', { contract_id: contractId }, { orderBy: 'due_date' });
  const entries = await scoped.query(
    `SELECT id, payment_id, amount, paid_on, method, reference_code, recorded_role, created_at, undone_at, undo_reason
       FROM payment_entries WHERE contract_id = ? AND office_id = :office_id ORDER BY id`,
    [contractId],
  );
  const byPayment = new Map(payments.map((p) => [Number(p.id), []]));
  for (const e of entries) {
    byPayment.get(Number(e.payment_id)).push({
      ...e,
      halalas: money.fromDecimal(e.amount),
      paidOn: String(e.paid_on).slice(0, 10),
      canUndo: canUndo(e, now),
      undoUntil: hoursAfter(new Date(e.created_at), UNDO_HOURS),
    });
  }
  return payments.map((p) => {
    const total = money.fromDecimal(p.amount);
    const paid = money.fromDecimal(p.paid_amount);
    const shown = engine.paymentDisplayStatus(p, today);
    return {
      ...p,
      totalHalalas: total,
      paidHalalas: paid,
      remainingHalalas: p.status === 'waived' ? 0 : Math.max(0, total - paid),
      shownStatus: shown,
      partial: paid > 0 && paid < total && p.status !== 'paid',
      entries: byPayment.get(Number(p.id)),
    };
  });
}

/** Totals of a history: scheduled (waived left out), collected, remaining (halalas). */
function totalsOf(history) {
  const live = history.filter((p) => p.status !== 'waived');
  const scheduled = live.reduce((s, p) => s + p.totalHalalas, 0);
  const collected = live.reduce((s, p) => s + p.paidHalalas, 0);
  return { scheduled, collected, remaining: Math.max(0, scheduled - collected) };
}

const OVERDUE_BUCKETS = [1, 7, 30, 60, 90];

/** Reads the overdue filters from a query string. */
function parseOverdueFilters(query = {}, today) {
  const filters = { landlordId: null, q: '', minDays: null, from: '', to: '' };
  const id = Number(query.landlord);
  if (Number.isInteger(id) && id > 0) filters.landlordId = id;
  filters.q = String(query.q || '').trim().slice(0, 60);
  const days = Number(query.days);
  if (OVERDUE_BUCKETS.includes(days)) filters.minDays = days;
  for (const key of ['from', 'to']) {
    const value = String(query[key] || '').trim();
    if (value && engine.isValidDate(value)) filters[key] = value;
  }
  if (filters.from && filters.to && engine.isAfter(filters.from, filters.to)) [filters.from, filters.to] = [filters.to, filters.from];
  return filters;
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function overdueWhere(filters, today) {
  const where = [
    'c.office_id = :office_id',
    "p.office_id = :office_id",
    "p.status IN ('due','late','tenant_reported')",
    'p.due_date < ?',
    'p.paid_amount < p.amount',
    "c.status NOT IN ('terminated')",
  ];
  const params = [today];
  if (filters.landlordId) { where.push('c.landlord_id = ?'); params.push(filters.landlordId); }
  if (filters.q) { where.push('u.label LIKE ?'); params.push(`%${escapeLike(filters.q)}%`); }
  if (filters.minDays) { where.push('p.due_date <= ?'); params.push(addDays(today, -filters.minDays)); }
  if (filters.from) { where.push('p.due_date >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('p.due_date <= ?'); params.push(filters.to); }
  return { sql: where.join(' AND '), params };
}

const OVERDUE_FROM = `FROM contract_payments p
  JOIN contracts c ON c.id = p.contract_id
  LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
  LEFT JOIN landlords l ON l.id = c.landlord_id AND l.office_id = :office_id`;

/** One page of overdue installments (oldest first) with the total remaining. */
async function overdueList(pool, officeId, { today, filters, page = 1, pageSize = 20 }) {
  const scoped = scopeToOffice(pool, officeId);
  const { sql, params } = overdueWhere(filters, today);
  const [totals] = await scoped.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(ROUND((p.amount - p.paid_amount) * 100)), 0) AS remaining ${OVERDUE_FROM} WHERE ${sql}`,
    params,
  );
  const total = Number(totals.n);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await scoped.query(
    `SELECT p.id, p.contract_id, p.due_date, p.status, ROUND(p.amount * 100) AS amount_h, ROUND(p.paid_amount * 100) AS paid_h,
            u.label AS unit_label, l.label AS landlord_label
       ${OVERDUE_FROM} WHERE ${sql}
      ORDER BY p.due_date ASC, p.id ASC LIMIT ${Number(pageSize)} OFFSET ${(current - 1) * pageSize}`,
    params,
  );
  return {
    total,
    pages,
    page: current,
    remainingHalalas: Number(totals.remaining),
    rows: rows.map((r) => ({
      ...r,
      daysOverdue: engine.daysUntil(String(r.due_date).slice(0, 10), today) * -1,
      remainingHalalas: Math.max(0, Number(r.amount_h) - Number(r.paid_h)),
      paidHalalas: Number(r.paid_h),
      totalHalalas: Number(r.amount_h),
    })),
  };
}

/** Every overdue row for CSV (capped), same filters. */
async function overdueAll(pool, officeId, { today, filters, limit = 5000 }) {
  const { sql, params } = overdueWhere(filters, today);
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT p.due_date, p.status, ROUND(p.amount * 100) AS amount_h, ROUND(p.paid_amount * 100) AS paid_h,
            u.label AS unit_label, l.label AS landlord_label
       ${OVERDUE_FROM} WHERE ${sql} ORDER BY p.due_date ASC, p.id ASC LIMIT ${Number(limit)}`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    daysOverdue: engine.daysUntil(String(r.due_date).slice(0, 10), today) * -1,
    remainingHalalas: Math.max(0, Number(r.amount_h) - Number(r.paid_h)),
    paidHalalas: Number(r.paid_h),
    totalHalalas: Number(r.amount_h),
  }));
}

module.exports = {
  METHODS,
  ROLE_LABELS,
  UNDO_HOURS,
  OVERDUE_BUCKETS,
  validateReference,
  validateEntry,
  validateReason,
  lockPayment,
  remainingOf,
  refreshPayment,
  applyEntry,
  voidEntries,
  recordPayment,
  undoEntry,
  canUndo,
  historyFor,
  totalsOf,
  parseOverdueFilters,
  overdueList,
  overdueAll,
};
