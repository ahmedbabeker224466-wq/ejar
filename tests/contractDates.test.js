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
