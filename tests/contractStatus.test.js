'use strict';

// planStatusChanges without a database: which stored stages are stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planStatusChanges, planDeadlineFixes } = require('../services/contractStatus');

const TODAY = '2026-10-01';
// end 2026-12-31 -> notice deadline 2026-11-01 (31 days left: calm)
const base = { start_date: '2026-01-01', end_date: '2026-12-31', unit_id: 9 };

const TABLE = [
  ['stored calm, still calm', { ...base, id: 1, status: 'calm' }, null],
  ['stored calm, now soon', { ...base, id: 2, status: 'calm', end_date: '2026-12-20' }, 'soon'],
  ['stored soon, now urgent', { ...base, id: 3, status: 'soon', end_date: '2026-12-05' }, 'urgent'],
  ['stored urgent, deadline passed', { ...base, id: 4, status: 'urgent', end_date: '2026-11-29' }, 'deadline_passed'],
  ['stored deadline_passed, ended', { ...base, id: 5, status: 'deadline_passed', start_date: '2025-10-01', end_date: '2026-09-30' }, 'ended'],
  ['the end day itself is not ended', { ...base, id: 6, status: 'deadline_passed', start_date: '2025-10-02', end_date: '2026-10-01' }, null],
  ['stored ended stays ended', { ...base, id: 7, status: 'ended', start_date: '2024-01-01', end_date: '2024-12-31' }, null],
  ['not started yet, calm', { ...base, id: 8, status: 'calm', start_date: '2027-01-01', end_date: '2027-12-31' }, null],
];

test('planStatusChanges: one row per stale stage, nothing else', () => {
  const plan = planStatusChanges(TABLE.map(([, row]) => row), TODAY);
  const expected = TABLE.filter(([, , to]) => to).map(([, row, to]) => ({ id: row.id, from: row.status, to, unit_id: 9 }));
  assert.deepEqual(plan.changes, expected);
  assert.equal(plan.checked, TABLE.length);
  assert.deepEqual(plan.byStage, { calm: 2, soon: 1, urgent: 1, deadline_passed: 2, ended: 2 });
});

for (const [label, row, to] of TABLE) {
  test(`planStatusChanges: ${label}`, () => {
    const { changes } = planStatusChanges([row], TODAY);
    assert.deepEqual(changes.map((c) => c.to), to ? [to] : []);
  });
}

test('terminated and renewed rows are never touched', () => {
  const plan = planStatusChanges([
    { ...base, id: 1, status: 'terminated', start_date: '2020-01-01', end_date: '2020-12-31' },
    { ...base, id: 2, status: 'renewed', start_date: '2020-01-01', end_date: '2020-12-31' },
  ], TODAY);
  assert.deepEqual(plan, { checked: 0, changes: [], byStage: {} });
});

test('planning is idempotent: applying the plan leaves nothing to change', () => {
  const rows = TABLE.map(([, row]) => ({ ...row }));
  const first = planStatusChanges(rows, TODAY);
  for (const change of first.changes) rows.find((r) => r.id === change.id).status = change.to;
  assert.deepEqual(planStatusChanges(rows, TODAY).changes, []);
});

test('invalid dates are refused, never guessed', () => {
  assert.throws(() => planStatusChanges([{ ...base, id: 1, status: 'calm', end_date: '2026-02-30' }], TODAY), /Invalid date/);
});

test('planDeadlineFixes: missing or wrong stored deadlines are recomputed by the engine', () => {
  const rows = [
    { id: 1, end_date: '2026-12-31', notice_deadline: '2026-11-01', rent_change_deadline: '2026-10-02' },
    { id: 2, end_date: '2026-12-31', notice_deadline: null, rent_change_deadline: null },
    { id: 3, end_date: '2026-12-31', notice_deadline: '2026-11-02', rent_change_deadline: '2026-10-02' },
  ];
  assert.deepEqual(planDeadlineFixes(rows), [
    { id: 2, notice_deadline: '2026-11-01', rent_change_deadline: '2026-10-02' },
    { id: 3, notice_deadline: '2026-11-01', rent_change_deadline: '2026-10-02' },
  ]);
});
