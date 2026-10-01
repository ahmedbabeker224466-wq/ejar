'use strict';

// Contracts of one office: form validation, preview, create, renew, edit,
// terminate, delete, payments. Every query goes through scopeToOffice(); the
// office id always comes from req.office. Every date, deadline, stage and
// installment comes from services/contractEngine.js.
//
// The save logic does not care where the numbers came from (typed by hand
// now, read by AI later): it re-validates everything with the engine.
//
// Once saved, dates, rent, frequency, unit and landlord never change: the
// schedule and deadlines stay consistent. To change them, terminate the
// contract and create a new one (or renew it).
//
// Privacy: tenant_label is a nickname. Events and audit rows never contain
// the rent amount, the tenant label, the termination reason or notes.

const engine = require('./contractEngine');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { withTransaction } = require('./transaction');
const planLimits = require('./planLimits');
const invites = require('./invites');
const unitStatus = require('./unitStatus');
const { parseId } = require('./landlords');
const { SAUDI_CITIES } = require('../config/saudiCities');
const { toWesternDigits } = require('../utils/phone');

const PAGE_SIZE = 20;
const MAX_MONEY_HALALAS = 999999999999; // DECIMAL(12,2)
const ENDS_WITHIN = [30, 60, 90, 180];

const STAGE_LABELS = {
  calm: 'مستقر',
  soon: 'يقترب الموعد',
  urgent: 'عاجل',
  deadline_passed: 'فات موعد القرار',
  ended: 'منتهٍ',
  renewed: 'مُجدَّد',
  terminated: 'مُنهى',
};
const FREQUENCY_LABELS = { monthly: 'شهري', quarterly: 'كل 3 أشهر', semiannual: 'كل 6 أشهر', annual: 'سنوي' };
const PAYMENT_LABELS = { due: 'مستحقة', paid: 'مدفوعة', late: 'متأخرة', waived: 'ملغاة' };
const PAYMENT_METHODS = { cash: 'نقداً', transfer: 'تحويل بنكي', cheque: 'شيك', card: 'بطاقة', other: 'أخرى' };

// Engine error codes -> the form field and the Arabic message.
const ENGINE_ERRORS = {
  invalid_date: ['end_date', 'تاريخ غير صحيح.'],
  end_before_start: ['end_date', 'تاريخ النهاية قبل تاريخ البداية.'],
  invalid_rent: ['annual_rent', 'اكتب الإيجار السنوي بالريال، رقماً أكبر من صفر.'],
  unknown_frequency: ['payment_frequency', 'اختر طريقة الدفع من القائمة.'],
  term_not_whole_months: ['end_date', 'مدة العقد يجب أن تكون أشهراً كاملة (مثال: من 2025-03-01 إلى 2026-02-28).'],
};

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function clean(value, max) {
  return toWesternDigits(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function moneyString(halalas) {
  return `${Math.floor(halalas / 100)}.${String(halalas % 100).padStart(2, '0')}`;
}

/** Optional non-negative money field: { value (DECIMAL string | null), error }. */
function optionalMoney(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: null };
  const halalas = engine.toHalalas(String(raw));
  if (halalas === null || halalas < 0 || halalas > MAX_MONEY_HALALAS) return { error: true };
  return { value: moneyString(halalas) };
}

function checkbox(value) {
  return ['1', 'on', 'true'].includes(String(value));
}

// ------------------------------------------------------------ validation and preview

/**
 * Shape checks of the contract form (no database). Returns { values, errors }.
 * Dates must be strict 'YYYY-MM-DD'; money is a DECIMAL string.
 */
function validateContractFields(body = {}) {
  const errors = {};
  const values = {};

  values.landlord_id = parseId(body.landlord_id);
  if (!values.landlord_id) errors.landlord_id = 'اختر المالك.';
  values.unit_id = parseId(body.unit_id);
  if (!values.unit_id) errors.unit_id = 'اختر الوحدة.';

  values.contract_number = clean(body.contract_number, 100) || null;
  if (values.contract_number && (values.contract_number.length > 40 || !/^[A-Za-z0-9\-/ ]+$/.test(values.contract_number))) {
    errors.contract_number = 'رقم العقد حروف إنجليزية وأرقام فقط (حتى 40).';
  }

  values.tenant_label = clean(body.tenant_label, 200).replace(/\s+/g, ' ') || null;
  if (values.tenant_label && values.tenant_label.length > 120) errors.tenant_label = 'اسم المستأجر المختصر حتى 120 حرفاً.';

  for (const field of ['start_date', 'end_date']) {
    values[field] = clean(body[field], 20);
    if (!engine.isValidDate(values[field])) errors[field] = 'اختر تاريخاً صحيحاً.';
  }

  const rent = engine.toHalalas(clean(body.annual_rent, 30));
  values.annual_rent = rent !== null && rent > 0 && rent <= MAX_MONEY_HALALAS ? moneyString(rent) : null;
  if (!values.annual_rent) errors.annual_rent = ENGINE_ERRORS.invalid_rent[1];

  values.payment_frequency = String(body.payment_frequency || '');
  if (!has(engine.FREQUENCIES, values.payment_frequency)) errors.payment_frequency = ENGINE_ERRORS.unknown_frequency[1];

  for (const field of ['deposit', 'commission']) {
    const money = optionalMoney(body[field]);
    values[field] = money.value ?? null;
    if (money.error) errors[field] = 'اكتب مبلغاً صحيحاً بالريال.';
  }

  values.city = clean(body.city, 80) || null;
  if (values.city && !SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';

  values.auto_renew = checkbox(body.auto_renew) ? 1 : 0;
  values.acknowledged = checkbox(body.ack_warnings);
  return { values, errors };
}

/**
 * Runs the engine on validated values: schedule, deadlines, stage, rent policy
 * and sanity warnings. Pure. Returns { ok, errors, warnings, needsAck, result }
 * where result holds everything the preview shows and the save stores.
 */
function evaluateContract(values, today) {
  const errors = {};
  let schedule;
  try {
    schedule = engine.buildSchedule(values);
  } catch (err) {
    if (!(err instanceof engine.ContractDateError)) throw err;
    const [field, message] = ENGINE_ERRORS[err.code] || ['end_date', 'تحقق من التواريخ والمبالغ.'];
    errors[field] = message;
    return { ok: false, errors, warnings: [], needsAck: false, result: null };
  }
  const all = engine.sanityWarnings(values, today);
  const blocking = all.filter((w) => w.severity === 'error');
  for (const w of blocking) errors[w.code] = w.message_ar;
  const warnings = all.filter((w) => w.severity === 'warn');

  const described = engine.describeContract(values, today);
  const total = schedule.reduce((sum, p) => sum + engine.toHalalas(p.amount), 0);
  return {
    ok: blocking.length === 0,
    errors,
    warnings,
    needsAck: warnings.length > 0,
    result: {
      termMonths: engine.termMonths(values.start_date, values.end_date),
      startHijri: engine.formatHijri(values.start_date),
      endHijri: engine.formatHijri(values.end_date),
      noticeDeadline: described.noticeDeadline,
      rentChangeDeadline: described.rentChangeDeadline,
      daysToNotice: described.daysToNotice,
      daysToRentChange: described.daysToRentChange,
      stage: described.stage,
      stageLabel: STAGE_LABELS[described.stage],
      notStarted: described.notStarted,
      schedule,
      scheduleTotal: moneyString(total),
      rentPolicy: engine.rentChangePolicy({ city: values.city, today, endDate: values.end_date }),
    },
  };
}

/** The JSON the live preview shows: validation, then the real engine. No database. */
function previewContract(body, today) {
  const { values, errors } = validateContractFields(body);
  const dateErrors = ['start_date', 'end_date', 'annual_rent', 'payment_frequency', 'deposit', 'city'].filter((f) => errors[f]);
  if (dateErrors.length) {
    return { ok: false, errors: Object.fromEntries(dateErrors.map((f) => [f, errors[f]])), warnings: [], needsAck: false, preview: null };
  }
  const evaluated = evaluateContract(values, today);
  const preview = evaluated.result && {
    ...evaluated.result,
    schedule: evaluated.result.schedule.slice(0, 4),
    scheduleCount: evaluated.result.schedule.length,
  };
  return { ok: evaluated.ok, errors: evaluated.errors, warnings: evaluated.warnings, needsAck: evaluated.needsAck, preview };
}

// ------------------------------------------------------------ shared database steps

function auditLog(scoped, ...args) {
  return createAudit({ query: (sql, params) => scoped.query(sql, params) }).write(...args);
}

async function addEvent(scoped, contractId, actorId, type, details = null) {
  await scoped.insert('contract_events', {
    contract_id: contractId,
    actor_id: actorId || null,
    event_type: type,
    details: details === null ? null : JSON.stringify(details),
  });
}

/** Locks a unit row of this office. */
async function lockUnit(scoped, unitId) {
  const [unit] = await scoped.query(
    'SELECT id, landlord_id, status, city, label FROM units WHERE id = ? AND office_id = :office_id FOR UPDATE',
    [unitId],
  );
  return unit || null;
}

/** True when another non-terminated contract on the unit shares a day with the range. */
async function overlapsOnUnit(scoped, unitId, start, end, excludeId = 0) {
  const rows = await scoped.query(
    `SELECT id, start_date, end_date FROM contracts
      WHERE unit_id = ? AND id <> ? AND status <> 'terminated' AND office_id = :office_id LOCK IN SHARE MODE`,
    [unitId, excludeId],
  );
  return rows.some((c) => engine.rangesOverlap(c.start_date, c.end_date, start, end));
}

/** Whether another running contract keeps the unit occupied today. */
async function unitHasOtherActiveContract(scoped, unitId, excludeId, today) {
  const rows = await scoped.query(
    `SELECT id, start_date, end_date FROM contracts
      WHERE unit_id = ? AND id <> ? AND status IN ('calm','soon','urgent','deadline_passed') AND office_id = :office_id`,
    [unitId, excludeId],
  );
  return rows.some((c) => engine.unitShouldBeRented(c, today));
}

/** Frees the unit unless another running contract occupies it. */
async function freeUnitIfIdle(scoped, unitId, contractId, today, actorId = null) {
  if (!unitId) return false;
  if (await unitHasOtherActiveContract(scoped, unitId, contractId, today)) return false;
  return unitStatus.setVacant(scoped, unitId, { actorId });
}

/** Inserts the contract and its schedule; marks the unit rented now or records that it will be. */
async function insertContract(scoped, { values, unit, evaluated, actorId, today, renewedFromId = null }) {
  const status = evaluated.result.stage;
  const id = await scoped.insert('contracts', {
    landlord_id: values.landlord_id,
    unit_id: values.unit_id,
    tenant_label: values.tenant_label,
    contract_number: values.contract_number,
    start_date: values.start_date,
    end_date: values.end_date,
    annual_rent: values.annual_rent,
    payment_frequency: values.payment_frequency,
    deposit: values.deposit,
    commission: values.commission,
    city: values.city || unit.city,
    status,
    auto_renew: values.auto_renew,
    notice_deadline: evaluated.result.noticeDeadline,
    rent_change_deadline: evaluated.result.rentChangeDeadline,
    renewed_from_id: renewedFromId,
    source: 'manual',
    warnings: evaluated.warnings.length ? JSON.stringify(evaluated.warnings.map((w) => w.code)) : null,
    created_by: actorId,
  });
  for (const payment of evaluated.result.schedule) {
    await scoped.insert('contract_payments', {
      contract_id: id,
      due_date: payment.due_date,
      amount: payment.amount.toFixed(2),
      status: 'due',
    });
  }
  if (engine.unitShouldBeRented(values, today)) {
    await unitStatus.setRented(scoped, unit.id, { actorId });
  } else if (engine.compareDates(values.end_date, today) >= 0) {
    await addEvent(scoped, id, actorId, 'unit_rent_pending', { start_date: values.start_date });
  }
  return { id, status };
}

// ------------------------------------------------------------ create

/**
 * Saves a new contract in ONE transaction: plan limit, unit lock and checks,
 * no overlap on the unit, contract, schedule, unit status, tenant invite,
 * event and audit row. Returns { ok: true, id } or { ok: false, status,
 * errors?, message? } (status 404 when the landlord or unit is not this
 * office's).
 */
async function createContract(pool, officeId, { fields, actorId, ip, today }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const usage = await planLimits.contractUsage(scoped, { lock: true }); // first: see planLimits
    const check = planLimits.checkLimit({ ...usage, adding: 1 });
    if (!check.ok) return { ok: false, status: 409, limit: planLimits.contractLimitMessage(check) };

    const [landlord] = await scoped.query(
      'SELECT id, is_active FROM landlords WHERE id = ? AND office_id = :office_id',
      [fields.landlord_id],
    );
    const unit = await lockUnit(scoped, fields.unit_id);
    if (!landlord || !unit) return { ok: false, status: 404 };
    if (!landlord.is_active) return { ok: false, status: 422, errors: { landlord_id: 'المالك موقوف. أعد تفعيله أولاً.' } };
    if (Number(unit.landlord_id) !== Number(landlord.id)) {
      return { ok: false, status: 422, errors: { unit_id: 'الوحدة المختارة لا تتبع هذا المالك.' } };
    }
    if (unit.status !== 'vacant') {
      return { ok: false, status: 409, errors: { unit_id: 'الوحدة غير شاغرة. اختر وحدة شاغرة.' } };
    }

    const values = { ...fields, city: fields.city || unit.city };
    const evaluated = evaluateContract(values, today);
    if (!evaluated.ok) return { ok: false, status: 422, errors: evaluated.errors };
    if (await overlapsOnUnit(scoped, unit.id, values.start_date, values.end_date)) {
      return { ok: false, status: 409, errors: { start_date: 'يوجد عقد آخر على هذه الوحدة في نفس الفترة.' } };
    }

    const { id, status } = await insertContract(scoped, { values, unit, evaluated, actorId, today });
    await invites.createTenantInvite(scoped, { contractId: id, createdBy: actorId, ip });
    await addEvent(scoped, id, actorId, 'contract_created', {
      source: 'manual', months: evaluated.result.termMonths, payments: evaluated.result.schedule.length, stage: status,
    });
    await auditLog(scoped, actorId, officeId, 'contract.create', 'contract', id, null, {
      landlord_id: values.landlord_id, unit_id: values.unit_id, start_date: values.start_date,
      end_date: values.end_date, payment_frequency: values.payment_frequency, status,
    }, ip);
    return { ok: true, id };
  });
}

// ------------------------------------------------------------ read

const SELECT_CONTRACT = `
  SELECT c.*, u.label AS unit_label, u.status AS unit_status, l.label AS landlord_label, b.name AS building_name
    FROM contracts c
    LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
    LEFT JOIN landlords l ON l.id = c.landlord_id AND l.office_id = :office_id
    LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id`;

/** One contract of this office with names, or null. */
async function getContract(pool, officeId, id) {
  if (!id) return null;
  const [row] = await scopeToOffice(pool, officeId).query(`${SELECT_CONTRACT} WHERE c.id = ? AND c.office_id = :office_id`, [id]);
  return row || null;
}

async function paymentsFor(pool, officeId, contractId) {
  return scopeToOffice(pool, officeId).select('contract_payments', { contract_id: contractId }, { orderBy: 'due_date' });
}

async function eventsFor(pool, officeId, contractId) {
  return scopeToOffice(pool, officeId).query(
    `SELECT e.id, e.event_type, e.details, e.created_at FROM contract_events e
      WHERE e.contract_id = ? AND e.contract_id IN (SELECT id FROM contracts WHERE office_id = :office_id)
      ORDER BY e.id DESC LIMIT 100`,
    [contractId],
  );
}

/**
 * One page of contracts. stage: a stage, or 'action' (urgent, deadline
 * passed, soon). endsWithin: 30/60/90/180 days. sort: 'deadline' (running
 * first, soonest decision deadline first), 'end' or 'created'.
 */
async function listContracts(pool, officeId, { q = '', stage = '', landlordId = null, unitId = null, endsWithin = null, sort = 'deadline', page = 1, pageSize = PAGE_SIZE } = {}, today) {
  const scoped = scopeToOffice(pool, officeId);
  const where = [];
  const params = [];
  const search = clean(q, 60);
  if (search) {
    where.push('(c.contract_number LIKE ? OR u.label LIKE ? OR c.tenant_label LIKE ?)');
    params.push(...Array(3).fill(`%${escapeLike(search)}%`));
  }
  if (stage === 'action') {
    where.push("c.status IN ('urgent','deadline_passed','soon')");
  } else if (engine.STAGES.includes(stage)) {
    where.push('c.status = ?');
    params.push(stage);
  }
  if (landlordId) {
    where.push('c.landlord_id = ?');
    params.push(landlordId);
  }
  if (unitId) {
    where.push('c.unit_id = ?');
    params.push(unitId);
  }
  if (ENDS_WITHIN.includes(Number(endsWithin))) {
    const window = engine.dateWindow(today, Number(endsWithin));
    where.push('c.end_date BETWEEN ? AND ?');
    params.push(window.from, window.to);
  }
  const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
  const order = {
    deadline: "(c.status IN ('calm','soon','urgent','deadline_passed')) DESC, c.notice_deadline ASC, c.id ASC",
    end: 'c.end_date ASC, c.id ASC',
    created: 'c.created_at DESC, c.id DESC',
  }[sort] || 'c.notice_deadline ASC';

  const [{ n }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM contracts c LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE c.office_id = :office_id${filter}`,
    params,
  );
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const rows = await scoped.query(
    `${SELECT_CONTRACT} WHERE c.office_id = :office_id${filter} ORDER BY ${order}
      LIMIT ${pageSize} OFFSET ${(current - 1) * pageSize}`,
    params,
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      daysToNotice: engine.LIVE_STAGES.includes(r.status) ? engine.daysUntil(today, engine.noticeDeadline(r.end_date)) : null,
    })),
    total,
    page: current,
    pages,
  };
}

/**
 * The "needs action" board: urgent and deadline-passed contracts first, then
 * soon, each group by decision deadline. At most `limit` rows.
 */
async function needsActionContracts(pool, officeId, today, limit = 10) {
  const rows = await scopeToOffice(pool, officeId).query(
    `${SELECT_CONTRACT}
      WHERE c.office_id = :office_id AND c.status IN ('urgent','deadline_passed','soon')
      ORDER BY (c.status = 'soon') ASC, c.notice_deadline ASC, c.id ASC LIMIT ${Number(limit)}`,
  );
  // Deadlines always come from the engine; the stored copy is only for sorting.
  return rows.map((r) => ({ ...r, daysToNotice: engine.daysUntil(today, engine.noticeDeadline(r.end_date)) }));
}

// ------------------------------------------------------------ edit

const EDITABLE = ['tenant_label', 'contract_number', 'deposit', 'commission', 'auto_renew'];

/** Checks the edit form (only the fields that may change after saving). */
function validateEditFields(body = {}) {
  const { values, errors } = validateContractFields(body);
  const allowed = Object.fromEntries(EDITABLE.map((f) => [f, values[f]]));
  const allowedErrors = Object.fromEntries(Object.entries(errors).filter(([f]) => EDITABLE.includes(f)));
  return { values: allowed, errors: allowedErrors };
}

/** Saves the editable fields. Returns the changed field names, or null when not in this office. */
async function editContract(pool, officeId, id, { fields, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const before = await scoped.selectOne('contracts', { id }, { columns: ['id', ...EDITABLE] });
  if (!before) return null;
  const changed = EDITABLE.filter((f) => String(before[f] ?? '') !== String(fields[f] ?? ''));
  if (!changed.length) return [];
  await scoped.update('contracts', { id }, Object.fromEntries(changed.map((f) => [f, fields[f]])));
  await addEvent(scoped, id, actorId, 'contract_edited', { fields: changed });
  await createAudit(pool).log(actorId, officeId, 'contract.update', 'contract', id, null, { changed }, ip);
  return changed;
}

// ------------------------------------------------------------ payments

/** Checks a payment status change. Returns { values, errors }. */
function validatePaymentChange(body = {}, today) {
  const errors = {};
  const values = { status: String(body.status || '') };
  if (!has(PAYMENT_LABELS, values.status)) errors.status = 'اختر حالة صحيحة.';
  if (values.status === 'paid') {
    values.paid_on = clean(body.paid_on, 20) || today;
    if (!engine.isValidDate(values.paid_on)) errors.paid_on = 'اختر تاريخ الدفع.';
    else if (engine.isAfter(values.paid_on, today)) errors.paid_on = 'تاريخ الدفع لا يمكن أن يكون في المستقبل.';
    values.method = String(body.method || '') || null;
    if (values.method && !has(PAYMENT_METHODS, values.method)) errors.method = 'اختر طريقة الدفع من القائمة.';
    values.receipt_no = clean(body.receipt_no, 100) || null;
    if (values.receipt_no && (values.receipt_no.length > 40 || !/^[A-Za-z0-9\-/]+$/.test(values.receipt_no))) {
      errors.receipt_no = 'رقم الإيصال حروف إنجليزية وأرقام فقط (حتى 40).';
    }
  }
  return { values, errors };
}

/** Changes one payment's status. Returns true, or null when the payment is not in this contract and office. */
async function setPaymentStatus(pool, officeId, contractId, paymentId, { values, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const payment = await scoped.selectOne('contract_payments', { id: paymentId, contract_id: contractId });
  if (!payment) return null;
  const paid = values.status === 'paid';
  await scoped.update('contract_payments', { id: paymentId, contract_id: contractId }, {
    status: values.status,
    paid_at: paid ? `${values.paid_on} 00:00:00` : null,
    method: paid ? values.method : null,
    receipt_no: paid ? values.receipt_no : null,
  });
  await addEvent(scoped, contractId, actorId, 'payment_status', {
    payment_id: paymentId, due_date: payment.due_date, from: payment.status, to: values.status,
  });
  await createAudit(pool).log(actorId, officeId, 'payment.status', 'contract_payment', paymentId,
    { status: payment.status }, { status: values.status }, ip);
  return true;
}

// ------------------------------------------------------------ terminate

/**
 * Terminates a running contract: status, terminated_at and reason; revokes
 * its tenant invites; waives future 'due' payments; frees the unit unless
 * another running contract occupies it. Returns 'terminated' | 'not_found' | 'not_running'.
 */
async function terminateContract(pool, officeId, id, { reason, actorId, ip, today }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [contract] = await scoped.query(
      'SELECT id, unit_id, status FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE',
      [id],
    );
    if (!contract) return 'not_found';
    if (!engine.LIVE_STAGES.includes(contract.status)) return 'not_running';
    await scoped.query(
      `UPDATE contracts SET status = 'terminated', terminated_at = UTC_TIMESTAMP(), terminated_reason = ?
        WHERE id = ? AND office_id = :office_id`,
      [reason, id],
    );
    await invites.revokeActiveTenantInvites(scoped, { contractId: id });
    const waived = await scoped.query(
      `UPDATE contract_payments SET status = 'waived', note = 'تم الإنهاء'
        WHERE contract_id = ? AND status = 'due' AND due_date > ? AND office_id = :office_id`,
      [id, today],
    );
    if (contract.unit_id) await lockUnit(scoped, contract.unit_id);
    await freeUnitIfIdle(scoped, contract.unit_id, id, today, actorId);
    await addEvent(scoped, id, actorId, 'contract_terminated', { waived_payments: waived.affectedRows });
    await auditLog(scoped, actorId, officeId, 'contract.terminate', 'contract', id,
      { status: contract.status }, { status: 'terminated', reason_given: true }, ip);
    return 'terminated';
  });
}

// ------------------------------------------------------------ renew

/** Prefill for the renewal form: the engine's next term, same rent and frequency. */
function renewalDefaults(contract, today) {
  const term = engine.nextTerm(contract);
  return {
    start_date: term.start_date,
    end_date: term.end_date,
    months: term.months,
    annual_rent: contract.annual_rent,
    payment_frequency: contract.payment_frequency,
    rentPolicy: engine.rentChangePolicy({ city: contract.city, today, endDate: contract.end_date }),
  };
}

/**
 * Renews a contract in ONE transaction: a NEW contract for the next term
 * (renewed_from_id set, new schedule, no new tenant invite), the old one
 * becomes 'renewed' (renewed_at, renewed_to_id), the unit stays rented.
 * A rent increase is refused while the Riyadh freeze applies.
 * Returns { ok: true, id } or { ok: false, status, errors?, limit?, reason? }.
 */
async function renewContract(pool, officeId, id, { fields, actorId, ip, today }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const usage = await planLimits.contractUsage(scoped, { lock: true }); // first: see planLimits
    const [old] = await scoped.query('SELECT * FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE', [id]);
    if (!old) return { ok: false, status: 404 };
    if (['terminated', 'renewed'].includes(old.status)) return { ok: false, status: 409, reason: 'closed' };

    const defaults = renewalDefaults(old, today);
    const rent = engine.toHalalas(String(fields.annual_rent ?? ''));
    if (rent === null || rent <= 0 || rent > MAX_MONEY_HALALAS) {
      return { ok: false, status: 422, errors: { annual_rent: ENGINE_ERRORS.invalid_rent[1] } };
    }
    if (!has(engine.FREQUENCIES, String(fields.payment_frequency))) {
      return { ok: false, status: 422, errors: { payment_frequency: ENGINE_ERRORS.unknown_frequency[1] } };
    }
    if (!defaults.rentPolicy.increaseAllowed && rent > engine.toHalalas(old.annual_rent)) {
      return {
        ok: false,
        status: 422,
        errors: { annual_rent: `الإيجار مجمّد في الرياض حتى ${defaults.rentPolicy.freezeUntil}: لا يمكن رفعه، ويمكن تخفيضه أو إبقاؤه كما هو.` },
      };
    }
    const oldCounts = engine.LIVE_STAGES.includes(old.status);
    const check = planLimits.checkLimit({ ...usage, adding: oldCounts ? 0 : 1 });
    if (!check.ok) return { ok: false, status: 409, limit: planLimits.contractLimitMessage(check) };

    const unit = old.unit_id ? await lockUnit(scoped, old.unit_id) : null;
    if (!unit) return { ok: false, status: 409, reason: 'no_unit' };
    const values = {
      landlord_id: old.landlord_id,
      unit_id: old.unit_id,
      tenant_label: old.tenant_label,
      contract_number: null,
      start_date: defaults.start_date,
      end_date: defaults.end_date,
      annual_rent: moneyString(rent),
      payment_frequency: String(fields.payment_frequency),
      deposit: old.deposit,
      commission: old.commission,
      city: old.city,
      auto_renew: old.auto_renew,
    };
    const evaluated = evaluateContract(values, today);
    if (!evaluated.ok) return { ok: false, status: 422, errors: evaluated.errors };
    if (await overlapsOnUnit(scoped, unit.id, values.start_date, values.end_date, old.id)) {
      return { ok: false, status: 409, reason: 'overlap' };
    }

    const created = await insertContract(scoped, { values, unit, evaluated, actorId, today, renewedFromId: old.id });
    await scoped.query(
      `UPDATE contracts SET status = 'renewed', renewed_at = UTC_TIMESTAMP(), renewed_to_id = ?
        WHERE id = ? AND office_id = :office_id`,
      [created.id, old.id],
    );
    await addEvent(scoped, old.id, actorId, 'contract_renewed', { to_id: created.id });
    await addEvent(scoped, created.id, actorId, 'contract_created', {
      source: 'renewal', from_id: old.id, months: evaluated.result.termMonths, payments: evaluated.result.schedule.length, stage: created.status,
    });
    await auditLog(scoped, actorId, officeId, 'contract.renew', 'contract', created.id, { contract_id: old.id, status: old.status }, {
      contract_id: created.id, start_date: values.start_date, end_date: values.end_date, status: created.status,
    }, ip);
    return { ok: true, id: created.id };
  });
}

// ------------------------------------------------------------ delete

/**
 * Deletes a contract that has no paid payment and is not ended or renewed
 * (history stays). The paid check is inside the DELETE. Deleting a renewal
 * restores the contract it renewed. Returns 'deleted' | 'not_found' |
 * 'history' | 'has_paid'.
 */
async function deleteContract(pool, officeId, id, { actorId, ip, today }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [contract] = await scoped.query('SELECT * FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE', [id]);
    if (!contract) return 'not_found';
    const stageNow = engine.classifyContract(contract, today);
    if (['ended', 'renewed'].includes(contract.status) || stageNow === 'ended') return 'history';

    const result = await scoped.query(
      `DELETE FROM contracts WHERE id = ? AND office_id = :office_id
          AND NOT EXISTS (SELECT 1 FROM contract_payments p WHERE p.contract_id = ? AND p.status = 'paid')`,
      [id, id],
    );
    if (result.affectedRows !== 1) return 'has_paid';

    if (contract.renewed_from_id) {
      const [previous] = await scoped.query(
        'SELECT * FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE',
        [contract.renewed_from_id],
      );
      if (previous && previous.status === 'renewed') {
        const restored = engine.classifyContract({ ...previous, status: null, renewed_at: null }, today);
        await scoped.query(
          `UPDATE contracts SET status = ?, renewed_at = NULL, renewed_to_id = NULL WHERE id = ? AND office_id = :office_id`,
          [restored, previous.id],
        );
        await addEvent(scoped, previous.id, actorId, 'renewal_deleted', { deleted_id: id });
      }
    }
    if (contract.unit_id) await lockUnit(scoped, contract.unit_id);
    await freeUnitIfIdle(scoped, contract.unit_id, id, today, actorId);
    await auditLog(scoped, actorId, officeId, 'contract.delete', 'contract', id,
      { unit_id: contract.unit_id, start_date: contract.start_date, end_date: contract.end_date, status: contract.status }, null, ip);
    return 'deleted';
  });
}

// ------------------------------------------------------------ tenant invite

async function createTenantInviteFor(pool, officeId, contractId, { actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const result = await invites.createTenantInvite(scoped, { contractId, createdBy: actorId, ip });
    if (result.ok) await addEvent(scoped, contractId, actorId, 'tenant_invite_created');
    return result;
  });
}

async function revokeTenantInviteFor(pool, officeId, contractId, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const revoked = await invites.revokeTenantInvite(scoped, { contractId, actorId, ip });
  if (revoked) await addEvent(scoped, contractId, actorId, 'tenant_invite_revoked');
  return revoked;
}

module.exports = {
  PAGE_SIZE,
  ENDS_WITHIN,
  STAGE_LABELS,
  FREQUENCY_LABELS,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  EDITABLE,
  validateContractFields,
  evaluateContract,
  previewContract,
  createContract,
  getContract,
  paymentsFor,
  eventsFor,
  listContracts,
  needsActionContracts,
  validateEditFields,
  editContract,
  validatePaymentChange,
  setPaymentStatus,
  terminateContract,
  renewalDefaults,
  renewContract,
  deleteContract,
  createTenantInviteFor,
  revokeTenantInviteFor,
  freeUnitIfIdle,
  addEvent,
};
