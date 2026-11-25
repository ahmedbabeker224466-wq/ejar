'use strict';

// Pure checks for the Nov 2026 additions: vendors form, contract calendar,
// landlord insights helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const vendors = require('../services/vendors');
const calendar = require('../services/calendar');
const insights = require('../services/landlordInsights');

test('vendor form: name, trade and a Saudi mobile are required; account-like notes are refused', () => {
  const ok = vendors.validateVendor({ name: 'أبو سالم', trade: 'plumbing', phone: '0551234567', notes: 'يعمل مساءً' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.phone, '966551234567');
  const bad = vendors.validateVendor({ name: 'x', trade: 'nope', phone: '123', notes: 'SA0380000000608010167519' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['name', 'notes', 'phone', 'trade']);
});

test('calendar: unpaid installments, deadlines and the end date as all-day events', () => {
  const text = calendar.contractCalendar({
    contract: { id: 7, unit_label: 'شقة 1, الدور 2', end_date: '2027-01-31' },
    described: { noticeDeadline: '2026-12-02', rentChangeDeadline: '2026-11-02' },
    payments: [{ id: 1, due_date: '2026-02-01', amount: '6000.00', status: 'paid' }, { id: 2, due_date: '2026-05-01', amount: '6000.00', status: 'due' }],
    host: 'mi3aad.com',
    now: new Date('2026-11-25T10:00:00Z'),
  });
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 4, 'one unpaid installment + notice + rent change + end');
  assert.match(text, /DTSTART;VALUE=DATE:20260501\r\nDTEND;VALUE=DATE:20260502/);
  assert.match(text, /DTSTART;VALUE=DATE:20270131/);
  assert.match(text, /شقة 1\\, الدور 2/, 'commas are escaped');
  assert.ok(text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded');
});

test('insights: the last 12 months and bar percents', () => {
  const months = insights.lastMonths('2026-11-25');
  assert.equal(months.length, 12);
  assert.equal(months[0], '2025-12');
  assert.equal(months[11], '2026-11');
  assert.deepEqual(insights.barPercents([0, 50, 100]), [0, 50, 100]);
  assert.deepEqual(insights.barPercents([0, 0]), [0, 0]);
});
