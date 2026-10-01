'use strict';

// What landlords and tenants send back on a contract, and how the office (or
// the landlord, for payments) answers it:
// - landlord decisions (renew / not renew / undecided + short note)
// - tenant requests (rent reduction) handled by the office
// - "I paid" reports: status 'tenant_reported', confirmed (paid) or rejected
//   (back to due) by the office or the landlord. Never paid by the tenant.
// Every query is scoped to the contract's office. Events and audit rows hold
// ids and statuses only, never the note text.

const engine = require('./contractEngine');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { riyadhDate } = require('./contractDates');

const DECISIONS = { renew: 'سيجدد', not_renew: 'لن يجدد', undecided: 'لم يقرر بعد' };
const REQUEST_TYPES = { rent_reduction: 'طلب تخفيض الإيجار' };
const REQUEST_STATUSES = { pending: 'بانتظار المكتب', accepted: 'مقبول', rejected: 'مرفوض' };
const NOTE_MAX = { decision: 280, request: 500 };

function cleanNote(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim();
  if (text.length > max) return { error: `الملاحظة ${max} حرفاً كحد أقصى.` };
  return { value: text || null };
}

async function event(scoped, contractId, actorId, type, details = null) {
  await scoped.insert('contract_events', {
    contract_id: contractId, actor_id: actorId || null, event_type: type, details: details && JSON.stringify(details),
  });
}

// ------------------------------------------------------------ landlord decisions

/** Checks the decision form. Returns { values, errors }. */
function validateDecision(body = {}) {
  const errors = {};
  const decision = String(body.decision || '');
  if (!Object.hasOwn(DECISIONS, decision)) errors.decision = 'اختر قرارك من القائمة.';
  const note = cleanNote(body.note, NOTE_MAX.decision);
  if (note.error) errors.note = note.error;
  return { values: { decision, note: note.value ?? null }, errors };
}

async function addDecision(pool, officeId, { contractId, landlordId, userId, decision, note, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const id = await scoped.insert('contract_decisions', { contract_id: contractId, landlord_id: landlordId, user_id: userId, decision, note });
  await event(scoped, contractId, userId, 'landlord_decision', { decision });
  await createAudit(pool).log(userId, officeId, 'contract.decision', 'contract', contractId, null, { decision }, ip);
  return id;
}

async function decisionsFor(pool, officeId, contractId, limit = 20) {
  return scopeToOffice(pool, officeId).query(
    `SELECT id, decision, note, created_at FROM contract_decisions
      WHERE contract_id = ? AND office_id = :office_id ORDER BY id DESC LIMIT ${Number(limit)}`,
    [contractId],
  );
}

// ------------------------------------------------------------ tenant requests

/** Whether the tenant may ask for a rent reduction now (engine rentChangePolicy). */
function reductionAvailability(contract, today) {
  if (!engine.LIVE_STAGES.includes(contract.status)) return { allowed: false, reason: 'not_running' };
  const policy = engine.rentChangePolicy({ city: contract.city, today, endDate: contract.end_date });
  if (!policy.reductionAllowed) return { allowed: false, reason: 'not_allowed', policy };
  if (!policy.requestOpen) return { allowed: false, reason: 'deadline_passed', policy };
  return { allowed: true, policy };
}

/**
 * Stores a rent-reduction request (pending). Returns 'created' |
 * 'not_allowed' | 'pending_exists' | 'invalid' (with errors).
 */
async function requestReduction(pool, officeId, { contract, userId, body, today, ip }) {
  const availability = reductionAvailability(contract, today);
  if (!availability.allowed) return { result: 'not_allowed', reason: availability.reason };
  const note = cleanNote(body.note, NOTE_MAX.request);
  if (note.error) return { result: 'invalid', errors: { note: note.error } };
  const scoped = scopeToOffice(pool, officeId);
  const [pending] = await scoped.query(
    "SELECT id FROM contract_requests WHERE contract_id = ? AND user_id = ? AND status = 'pending' AND office_id = :office_id",
    [contract.id, userId],
  );
  if (pending) return { result: 'pending_exists' };
  await scoped.insert('contract_requests', { contract_id: contract.id, user_id: userId, request_type: 'rent_reduction', note: note.value });
  await event(scoped, contract.id, userId, 'tenant_request', { type: 'rent_reduction' });
  await createAudit(pool).log(userId, officeId, 'contract.request', 'contract', contract.id, null, { type: 'rent_reduction' }, ip);
  return { result: 'created' };
}

async function requestsFor(pool, officeId, contractId) {
  return scopeToOffice(pool, officeId).query(
    `SELECT id, request_type, note, status, created_at, handled_at FROM contract_requests
      WHERE contract_id = ? AND office_id = :office_id ORDER BY id DESC`,
    [contractId],
  );
}

/** The office accepts or rejects a pending request. Returns true when it changed. */
async function handleRequest(pool, officeId, { contractId, requestId, status, actorId, ip }) {
  if (!['accepted', 'rejected'].includes(status)) return false;
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    `UPDATE contract_requests SET status = ?, handled_by = ?, handled_at = UTC_TIMESTAMP()
      WHERE id = ? AND contract_id = ? AND status = 'pending' AND office_id = :office_id`,
    [status, actorId, requestId, contractId],
  );
  if (result.affectedRows !== 1) return false;
  await event(scoped, contractId, actorId, 'request_handled', { request_id: requestId, status });
  await createAudit(pool).log(actorId, officeId, 'contract.request_handled', 'contract_request', requestId, { status: 'pending' }, { status }, ip);
  return true;
}

// ------------------------------------------------------------ "I paid"

/** The tenant reports a due or late installment as paid. Returns true when it changed. */
async function reportPayment(pool, officeId, { contractId, paymentId, userId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    `UPDATE contract_payments SET status = 'tenant_reported', reported_at = UTC_TIMESTAMP(), reported_by = ?
      WHERE id = ? AND contract_id = ? AND status IN ('due','late') AND office_id = :office_id`,
    [userId, paymentId, contractId],
  );
  if (result.affectedRows !== 1) return false;
  await event(scoped, contractId, userId, 'payment_reported', { payment_id: paymentId });
  await createAudit(pool).log(userId, officeId, 'payment.reported', 'contract_payment', paymentId, null, { status: 'tenant_reported' }, ip);
  return true;
}

/**
 * Confirms (paid, dated the Riyadh day the tenant reported it) or rejects
 * (back to due; the status recompute marks it late if overdue) a reported
 * payment. by: 'office' | 'landlord'. Returns true when it changed.
 */
async function answerReportedPayment(pool, officeId, { contractId, paymentId, confirm, actorId, by, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const payment = await scoped.selectOne('contract_payments', { id: paymentId, contract_id: contractId, status: 'tenant_reported' });
  if (!payment) return false;
  const result = confirm
    ? await scoped.query(
      `UPDATE contract_payments SET status = 'paid', paid_at = ?
        WHERE id = ? AND contract_id = ? AND status = 'tenant_reported' AND office_id = :office_id`,
      [`${riyadhDate(new Date(payment.reported_at || Date.now()))} 00:00:00`, paymentId, contractId],
    )
    : await scoped.query(
      `UPDATE contract_payments SET status = 'due', reported_at = NULL, reported_by = NULL
        WHERE id = ? AND contract_id = ? AND status = 'tenant_reported' AND office_id = :office_id`,
      [paymentId, contractId],
    );
  if (result.affectedRows !== 1) return false;
  await event(scoped, contractId, actorId, confirm ? 'payment_confirmed' : 'payment_rejected', { payment_id: paymentId, by });
  await createAudit(pool).log(actorId, officeId, confirm ? 'payment.confirmed' : 'payment.rejected', 'contract_payment', paymentId,
    { status: 'tenant_reported' }, { status: confirm ? 'paid' : 'due', by }, ip);
  return true;
}

// ------------------------------------------------------------ office overview

/** Join status, decisions, requests and reported payments of one contract (office view). */
async function contractFeedback(pool, officeId, contract) {
  const scoped = scopeToOffice(pool, officeId);
  const [landlord] = contract.landlord_id
    ? await scoped.query('SELECT user_id FROM landlords WHERE id = ? AND office_id = :office_id', [contract.landlord_id])
    : [null];
  const [{ n: tenants }] = await scoped.query(
    `SELECT COUNT(*) AS n FROM contract_members
      WHERE contract_id = ? AND role = 'tenant' AND contract_id IN (SELECT id FROM contracts WHERE office_id = :office_id)`,
    [contract.id],
  );
  return {
    landlordJoined: Boolean(landlord && landlord.user_id),
    tenantJoined: Number(tenants) > 0,
    decisions: await decisionsFor(pool, officeId, contract.id, 5),
    requests: await requestsFor(pool, officeId, contract.id),
  };
}

/** Dashboard counts: pending requests and reported payments waiting for the office. */
async function pendingCounts(pool, officeId) {
  const [row] = await scopeToOffice(pool, officeId).query(
    `SELECT (SELECT COUNT(*) FROM contract_requests WHERE office_id = :office_id AND status = 'pending') AS requests,
            (SELECT COUNT(*) FROM contract_payments WHERE office_id = :office_id AND status = 'tenant_reported') AS reported`,
  );
  return { requests: Number(row.requests), reported: Number(row.reported) };
}

/** Contracts with a pending request or a reported payment, newest activity first. */
async function pendingContracts(pool, officeId, limit = 10) {
  return scopeToOffice(pool, officeId).query(
    `SELECT c.id, u.label AS unit_label,
            (SELECT COUNT(*) FROM contract_requests r WHERE r.contract_id = c.id AND r.office_id = :office_id AND r.status = 'pending') AS requests,
            (SELECT COUNT(*) FROM contract_payments p WHERE p.contract_id = c.id AND p.office_id = :office_id AND p.status = 'tenant_reported') AS reported
       FROM contracts c LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE c.office_id = :office_id
        AND (EXISTS (SELECT 1 FROM contract_requests r WHERE r.contract_id = c.id AND r.office_id = :office_id AND r.status = 'pending')
          OR EXISTS (SELECT 1 FROM contract_payments p WHERE p.contract_id = c.id AND p.office_id = :office_id AND p.status = 'tenant_reported'))
      ORDER BY c.id DESC LIMIT ${Number(limit)}`,
  );
}

module.exports = {
  DECISIONS,
  REQUEST_TYPES,
  REQUEST_STATUSES,
  validateDecision,
  addDecision,
  decisionsFor,
  reductionAvailability,
  requestReduction,
  requestsFor,
  handleRequest,
  reportPayment,
  answerReportedPayment,
  contractFeedback,
  pendingCounts,
  pendingContracts,
};
