'use strict';

// Pure parts of the landlord / tenant areas: the needs-action order, payment
// summaries, decision validation and when a rent reduction may be asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../services/contractEngine');
const { addDays, addMonths } = require('../services/contractDates');
const portal = require('../services/portal');
const feedback = require('../services/feedback');
const joins = require('../services/joins');

const TODAY = '2026-10-01';

function contractView(id, stage, daysToNotice, { decision = null, reported = [], late = [] } = {}) {
  return { id, described: { stage, daysToNotice }, decision, reported, latePayments: late };
}

test('needs action: overdue first, then the nearest deadline; decided and calm contracts are left out', () => {
  const offices = [{
    office_name: 'أ',
    contracts: [
      contractView(1, 'soon', 20),
      contractView(2, 'urgent', 3),
      contractView(3, 'deadline_passed', -5),
      contractView(4, 'calm', 120),
      contractView(5, 'urgent', 1, { decision: { decision: 'renew' } }),
      contractView(6, 'soon', 25, { decision: { decision: 'undecided' } }),
      contractView(7, 'calm', 200, { reported: [{ id: 70, due_date: '2026-09-01' }], late: [{ id: 71, due_date: '2026-09-21' }] }),
    ],
  }];
  const actions = portal.landlordActions(offices, TODAY);
  assert.deepEqual(actions.map((a) => [a.type, a.contract.id, a.days]), [
    ['late', 7, -10],
    ['decision', 3, -5],
    ['reported', 7, 0],
    ['decision', 2, 3],
    ['decision', 1, 20],
    ['decision', 6, 25],
  ]);
});

test('payment summary: totals in halalas, waived ignored, next open installment', () => {
  const summary = portal.paymentSummary([
    { amount: '1000.10', shownStatus: 'paid' },
    { amount: '1000.10', shownStatus: 'late' },
    { amount: '999.80', shownStatus: 'tenant_reported' },
    { amount: '500.00', shownStatus: 'waived' },
    { amount: '1000.00', shownStatus: 'due' },
  ]);
  assert.deepEqual(summary.counts, { paid: 1, due: 1, late: 1, tenant_reported: 1 });
  assert.deepEqual(summary.totals, { paid: '1000.10', due: '1000.00', late: '1000.10', tenant_reported: '999.80' });
  assert.equal(summary.next.shownStatus, 'late');
  assert.equal(portal.paymentSummary([{ amount: '1', shownStatus: 'paid' }]).next, null);
});

test('decision form: only the three decisions, note up to 280 characters', () => {
  assert.deepEqual(feedback.validateDecision({ decision: 'renew', note: '  نعم  ' }), { values: { decision: 'renew', note: 'نعم' }, errors: {} });
  assert.deepEqual(feedback.validateDecision({ decision: 'not_renew' }).values, { decision: 'not_renew', note: null });
  for (const decision of ['', 'sell', 'constructor', 'toString', undefined]) {
    assert.ok(feedback.validateDecision({ decision }).errors.decision, String(decision));
  }
  assert.ok(feedback.validateDecision({ decision: 'renew', note: 'x'.repeat(281) }).errors.note);
  assert.deepEqual(feedback.validateDecision({ decision: 'renew', note: 'x'.repeat(280) }).errors, {});
});

test('reduction: allowed for a running contract up to the rent-change deadline (engine), in Riyadh too', () => {
  const end = addDays(addMonths(TODAY, 12), -1);
  const base = { id: 1, status: 'calm', city: 'الرياض', end_date: end };
  const open = feedback.reductionAvailability(base, TODAY);
  assert.equal(open.allowed, true);
  assert.equal(open.policy.reason, 'riyadh_freeze');
  assert.equal(open.policy.increaseAllowed, false);

  const deadline = engine.rentChangeDeadline(end);
  assert.equal(feedback.reductionAvailability(base, deadline).allowed, true, 'the deadline day itself is still open');
  assert.deepEqual(
    { allowed: feedback.reductionAvailability(base, addDays(deadline, 1)).allowed, reason: feedback.reductionAvailability(base, addDays(deadline, 1)).reason },
    { allowed: false, reason: 'deadline_passed' },
  );
  for (const status of ['ended', 'renewed', 'terminated']) {
    assert.equal(feedback.reductionAvailability({ ...base, status }, TODAY).reason, 'not_running');
  }
  assert.equal(feedback.reductionAvailability({ ...base, city: 'جدة' }, TODAY).allowed, true);
});

test('join guard and messages: one generic message for every bad code', () => {
  assert.match(joins.MESSAGES.invalid, /غير صحيح أو انتهت صلاحيته أو استُخدم/);
  for (const role of ['platform_admin', 'office_owner', 'office_manager', 'office_staff']) assert.ok(joins.OFFICE_ROLES.has(role));
  for (const role of ['landlord', 'tenant', null]) assert.ok(!joins.OFFICE_ROLES.has(role));
});
