'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../services/contractDates');

test('riyadhDate uses the Riyadh calendar day (UTC+3)', () => {
  assert.equal(d.riyadhDate(new Date('2026-09-30T20:59:59Z')), '2026-09-30');
  assert.equal(d.riyadhDate(new Date('2026-09-30T21:00:00Z')), '2026-10-01');
});

test('addDays and daysBetween cross months, years and leap days', () => {
  assert.equal(d.addDays('2026-12-25', 10), '2027-01-04');
  assert.equal(d.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(d.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(d.daysBetween('2026-01-01', '2026-04-01'), 90);
  assert.equal(d.daysBetween('2026-04-01', '2026-01-01'), -90);
  assert.throws(() => d.addDays('01/02/2026', 1), /Invalid date/);
});

test('a trial ends exactly 14 days after it starts', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  assert.equal(d.trialEndsAt(now).toISOString(), '2026-10-14T10:00:00.000Z');
});

test('a trial is expired from its end time on, and without an end time', () => {
  const end = new Date('2026-10-14T10:00:00Z');
  assert.equal(d.isTrialExpired(end, new Date('2026-10-14T09:59:59Z')), false);
  assert.equal(d.isTrialExpired(end, new Date('2026-10-14T10:00:00Z')), true);
  assert.equal(d.isTrialExpired(null, new Date()), true);
});

test('days left are counted on the Riyadh calendar', () => {
  const start = new Date('2026-09-30T10:00:00Z');
  const end = d.trialEndsAt(start);
  assert.equal(d.trialDaysLeft(end, start), 14);
  // 23:30 Riyadh on the first day is still day one.
  assert.equal(d.trialDaysLeft(end, new Date('2026-09-30T20:30:00Z')), 14);
  // 00:30 Riyadh the next day: one day fewer, although 24 hours have not passed.
  assert.equal(d.trialDaysLeft(end, new Date('2026-09-30T21:30:00Z')), 13);
  assert.equal(d.trialDaysLeft(end, new Date('2026-10-14T09:00:00Z')), 0, 'last day');
  assert.equal(d.trialDaysLeft(end, new Date('2026-10-20T09:00:00Z')), 0, 'never negative');
});

// ------------------------------------------------------------ strict dates

test('parseYmd accepts only real dates (leap years included)', () => {
  for (const good of ['2024-02-29', '2000-02-29', '2025-12-31', '2025-01-01', '1900-01-01', '2200-12-31']) {
    assert.equal(d.isValidYmd(good), true, good);
    assert.doesNotThrow(() => d.parseYmd(good), good);
  }
  const bad = [
    '2025-02-29', '1900-02-29', '2100-02-29', '2025-02-30', '2025-04-31', '2025-13-01', '2025-00-10', '2025-01-00',
    '2025-01-32', '2025-1-5', '25-01-05', '2025/01/05', '2025-01-05T00:00', ' 2025-01-05', '1899-12-31', '2201-01-01',
    '', null, undefined, 20250105, new Date(),
  ];
  for (const value of bad) {
    assert.equal(d.isValidYmd(value), false, String(value));
    assert.throws(() => d.parseYmd(value), (err) => err instanceof d.ContractDateError && err.code === 'invalid_date', String(value));
  }
});

test('date math refuses impossible input instead of rolling over', () => {
  assert.throws(() => d.addDays('2025-02-30', 1), /Invalid date/);
  assert.throws(() => d.daysBetween('2025-02-29', '2025-03-01'), /Invalid date/);
  assert.throws(() => d.addMonths('2025-13-01', 1), /Invalid date/);
  assert.throws(() => d.addDays('2200-12-31', 1), /Invalid date/, 'results stay inside the supported years');
});

test('daysInMonth knows leap years', () => {
  assert.equal(d.daysInMonth(2024, 2), 29);
  assert.equal(d.daysInMonth(2025, 2), 28);
  assert.equal(d.daysInMonth(1900, 2), 28);
  assert.equal(d.daysInMonth(2000, 2), 29);
  assert.equal(d.daysInMonth(2025, 4), 30);
  assert.equal(d.daysInMonth(2025, 12), 31);
});

test('addMonths clamps to the last day of the target month', () => {
  assert.equal(d.addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(d.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(d.addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(d.addMonths('2024-02-29', 48), '2028-02-29');
  assert.equal(d.addMonths('2025-03-31', 1), '2025-04-30');
  assert.equal(d.addMonths('2025-03-31', -1), '2025-02-28');
  assert.equal(d.addMonths('2025-12-15', 1), '2026-01-15');
  assert.equal(d.addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(d.addMonths('2025-01-15', -13), '2023-12-15');
  assert.equal(d.addMonths('2025-05-20', 0), '2025-05-20');
  assert.equal(d.addMonths('2025-09-25', 60), '2030-09-25');
});

test('compareYmd orders dates', () => {
  assert.equal(d.compareYmd('2025-01-01', '2025-01-02'), -1);
  assert.equal(d.compareYmd('2025-01-02', '2025-01-02'), 0);
  assert.equal(d.compareYmd('2026-01-01', '2025-12-31'), 1);
});
