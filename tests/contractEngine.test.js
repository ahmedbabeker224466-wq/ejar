'use strict';

// The contract date engine. Expected dates in the tables were computed
// independently (Python datetime), not with the code under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const engine = require('../services/contractEngine');
const RULES = require('../config/ejarRules');
const { normalizeCity, SAUDI_CITIES } = require('../config/saudiCities');
const { isValidYmd, compareYmd, addMonths } = require('../services/contractDates');

const isCode = (code) => (err) => err instanceof engine.ContractDateError && err.code === code;

// ------------------------------------------------------------ rules

test('rules are frozen data with the agreed values', () => {
  assert.equal(RULES.NON_RENEWAL_NOTICE_DAYS, 60);
  assert.equal(RULES.RENT_CHANGE_NOTICE_DAYS, 90);
  assert.equal(RULES.AUTO_RENEW_DEFAULT, true);
  assert.deepEqual({ ...RULES.RIYADH_RENT_FREEZE }, { city: 'riyadh', from: '2025-09-25', years: 5 });
  assert.deepEqual({ ...RULES.STAGE_THRESHOLDS }, { soonDays: 30, urgentDays: 7 });
  for (const value of [RULES, RULES.RIYADH_RENT_FREEZE, RULES.STAGE_THRESHOLDS]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { 'use strict'; RULES.NON_RENEWAL_NOTICE_DAYS = 1; }, TypeError);
});

test('no rule number is hard-coded in the engine; every rule carries the VERIFY note', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/contractEngine.js'), 'utf8');
  for (const literal of [/\b60\b/, /\b90\b/, /2025-09-25/, /soonDays:\s*\d/, /urgentDays:\s*\d/]) {
    assert.ok(!literal.test(source), `contractEngine.js must read ${literal} from config/ejarRules.js`);
  }
  const rules = fs.readFileSync(path.join(__dirname, '../config/ejarRules.js'), 'utf8');
  assert.equal((rules.match(/VERIFY against the official Ejar\/REGA source before launch/g) || []).length, 6, 'header + 5 rules');
});

// ------------------------------------------------------------ deadlines

test('notice and rent-change deadlines', () => {
  assert.equal(engine.noticeDeadline('2026-03-31'), '2026-01-30');
  assert.equal(engine.rentChangeDeadline('2026-03-31'), '2025-12-31');
  assert.equal(engine.noticeDeadline('2028-04-29'), '2028-02-29', 'leap day deadline');
  assert.equal(engine.noticeDeadline('2026-03-01'), '2025-12-31', 'across New Year');
  assert.equal(engine.noticeDeadline('2026-03-31', { ...RULES, NON_RENEWAL_NOTICE_DAYS: 30 }), '2026-03-01', 'rules can be overridden');
  assert.throws(() => engine.noticeDeadline('2026-02-30'), isCode('invalid_date'));
});

test('daysUntil: zero on the day, negative after', () => {
  assert.equal(engine.daysUntil('2026-01-30', '2026-01-30'), 0);
  assert.equal(engine.daysUntil('2026-01-29', '2026-01-30'), 1);
  assert.equal(engine.daysUntil('2026-01-31', '2026-01-30'), -1);
  assert.equal(engine.daysUntil('2025-12-31', '2026-03-31'), 90);
});

test('describeDeadlines: open on the deadline day, closed the day after', () => {
  const contract = { start_date: '2025-04-01', end_date: '2026-03-31' };
  const onRentDay = engine.describeDeadlines(contract, '2025-12-31');
  assert.deepEqual(onRentDay, {
    noticeDeadline: '2026-01-30', rentChangeDeadline: '2025-12-31',
    daysToNotice: 30, daysToRentChange: 0, daysToEnd: 90,
    noticeOpen: true, rentChangeOpen: true, notStarted: false,
  });
  const after = engine.describeDeadlines(contract, '2026-01-31');
  assert.equal(after.rentChangeOpen, false);
  assert.equal(after.noticeOpen, false);
  assert.equal(after.daysToNotice, -1);
  assert.equal(engine.describeDeadlines(contract, '2026-01-30').noticeOpen, true);
  assert.equal(engine.describeDeadlines(contract, '2025-03-31').notStarted, true);
  assert.equal(engine.describeDeadlines(contract, '2025-04-01').notStarted, false);
});

// ------------------------------------------------------------ stages

const E = '2026-03-31'; // notice deadline 2026-01-30
const STAGE_TABLE = [
  ['91 days before end', E, '2025-12-30', 'calm'],
  ['90 days before end', E, '2025-12-31', 'soon'],
  ['61 days before end', E, '2026-01-29', 'urgent'],
  ['60 days before end (the deadline day)', E, '2026-01-30', 'urgent'],
  ['59 days before end', E, '2026-01-31', 'deadline_passed'],
  ['1 day before end', E, '2026-03-30', 'deadline_passed'],
  ['the end day itself is still running', E, '2026-03-31', 'deadline_passed'],
  ['the day after end', E, '2026-04-01', 'ended'],
  ['a year after end', E, '2027-03-31', 'ended'],
  ['31 days before the deadline', E, '2025-12-30', 'calm'],
  ['30 days before the deadline', E, '2025-12-31', 'soon'],
  ['29 days before the deadline', E, '2026-01-01', 'soon'],
  ['8 days before the deadline', E, '2026-01-22', 'soon'],
  ['7 days before the deadline', E, '2026-01-23', 'urgent'],
  ['6 days before the deadline', E, '2026-01-24', 'urgent'],
  ['1 day before the deadline', E, '2026-01-29', 'urgent'],
  ['0 days: the deadline day', E, '2026-01-30', 'urgent'],
  ['-1: the day after the deadline', E, '2026-01-31', 'deadline_passed'],
  ['leap year: deadline day', '2028-03-31', '2028-01-31', 'urgent'],
  ['leap year: day after deadline', '2028-03-31', '2028-02-01', 'deadline_passed'],
  ['leap year: 7 days before', '2028-03-31', '2028-01-24', 'urgent'],
  ['leap year: 8 days before', '2028-03-31', '2028-01-23', 'soon'],
  ['leap-day deadline: on Feb 29', '2028-04-29', '2028-02-29', 'urgent'],
  ['leap-day deadline: Feb 28', '2028-04-29', '2028-02-28', 'urgent'],
  ['leap-day deadline: Mar 1', '2028-04-29', '2028-03-01', 'deadline_passed'],
  ['deadline Dec 31: on it', '2026-03-01', '2025-12-31', 'urgent'],
  ['deadline Dec 31: Jan 1 after', '2026-03-01', '2026-01-01', 'deadline_passed'],
  ['deadline in the previous year: on it', '2026-02-15', '2025-12-17', 'urgent'],
  ['deadline in the previous year: 8 days before', '2026-02-15', '2025-12-09', 'soon'],
  ['end in the next year: day after deadline', '2025-01-10', '2024-11-12', 'deadline_passed'],
  ['end in the next year: 7 days before', '2025-01-10', '2024-11-04', 'urgent'],
];

for (const [label, end, today, expected] of STAGE_TABLE) {
  test(`stage: ${label} -> ${expected}`, () => {
    const contract = { start_date: addMonths(end, -12).replace(/-\d\d$/, '-01'), end_date: end };
    assert.equal(engine.classifyContract(contract, today), expected);
  });
}

test('the stage table has at least 25 boundary rows', () => {
  assert.ok(STAGE_TABLE.length >= 25);
});

test('terminated beats renewed beats every date rule; flags come in several forms', () => {
  const running = { start_date: '2025-04-01', end_date: E };
  const today = '2025-06-01'; // calm
  assert.equal(engine.classifyContract(running, today), 'calm');
  assert.equal(engine.classifyContract({ ...running, terminated_at: '2025-05-01 10:00:00' }, today), 'terminated');
  assert.equal(engine.classifyContract({ ...running, terminated: true }, today), 'terminated');
  assert.equal(engine.classifyContract({ ...running, status: 'terminated' }, today), 'terminated');
  assert.equal(engine.classifyContract({ ...running, renewed_at: new Date() }, today), 'renewed');
  assert.equal(engine.classifyContract({ ...running, renewed: true }, today), 'renewed');
  assert.equal(engine.classifyContract({ ...running, status: 'renewed' }, '2030-01-01'), 'renewed', 'renewed wins over ended');
  assert.equal(engine.classifyContract({ ...running, renewed: true, terminated: true }, today), 'terminated');
  assert.equal(engine.classifyContract({ ...running, renewed: false, terminated: false, status: 'calm' }, '2026-04-01'), 'ended');
});

test('auto_renew does not change the stage; describeContract reports it with the default', () => {
  const contract = { start_date: '2025-04-01', end_date: E };
  assert.equal(engine.classifyContract({ ...contract, auto_renew: 0 }, '2026-01-30'), 'urgent');
  assert.equal(engine.describeContract(contract, '2026-01-30').autoRenew, true);
  assert.equal(engine.describeContract({ ...contract, auto_renew: 0 }, '2026-01-30').autoRenew, false);
  assert.equal(engine.describeContract({ ...contract, auto_renew: '1' }, '2026-01-30').autoRenew, true);
  const described = engine.describeContract(contract, '2025-03-01');
  assert.equal(described.stage, 'calm');
  assert.equal(described.notStarted, true, 'not started yet: same rule, flagged');
});

test('stage thresholds can be overridden for tests', () => {
  const rules = { ...RULES, STAGE_THRESHOLDS: { soonDays: 10, urgentDays: 2 } };
  const contract = { start_date: '2025-04-01', end_date: E };
  assert.equal(engine.classifyContract(contract, '2026-01-19', rules), 'calm'); // 11 days
  assert.equal(engine.classifyContract(contract, '2026-01-20', rules), 'soon'); // 10 days
  assert.equal(engine.classifyContract(contract, '2026-01-28', rules), 'urgent'); // 2 days
});

test('bad input is refused with a code, never guessed', () => {
  assert.throws(() => engine.classifyContract({ start_date: '2025-02-30', end_date: E }, '2025-06-01'), isCode('invalid_date'));
  assert.throws(() => engine.classifyContract({ start_date: '2025-04-01', end_date: E }, '2025-6-1'), isCode('invalid_date'));
  assert.throws(() => engine.classifyContract({ start_date: E, end_date: '2025-04-01' }, '2025-06-01'), isCode('end_before_start'));
  assert.throws(() => engine.classifyContract({ end_date: E }, '2025-06-01'), isCode('invalid_date'));
  assert.deepEqual(engine.STAGES, ['calm', 'soon', 'urgent', 'deadline_passed', 'ended', 'renewed', 'terminated']);
});

// ------------------------------------------------------------ rent change

test('city names match in Arabic and English, any case and spacing', () => {
  for (const input of ['الرياض', 'الرياض ', ' الرياض', 'Riyadh', 'riyadh', ' RIYADH ', 'Ar-Riyadh', 'al riyadh']) {
    assert.equal(normalizeCity(input), 'riyadh', JSON.stringify(input));
  }
  assert.equal(normalizeCity('جده'), 'jeddah', 'taa marbuta written as haa');
  assert.equal(normalizeCity('الاحساء'), 'ahsa', 'alef without hamza');
  for (const input of ['مدينة أخرى', 'Paris', '', '   ', null, undefined, 42]) assert.equal(normalizeCity(input), null, String(input));
  for (const name of SAUDI_CITIES.slice(0, -1)) assert.ok(normalizeCity(name), `${name} is known`);
});

test('Riyadh freeze: no increase inside the window, reduction always allowed', () => {
  for (const city of ['الرياض', 'الرياض ', 'Riyadh', 'riyadh']) {
    const policy = engine.rentChangePolicy({ city, today: '2025-10-01', endDate: '2025-12-31' });
    assert.deepEqual(policy, {
      increaseAllowed: false, reductionAllowed: true, effectiveDate: '2026-01-01', requestOpen: true,
      reason: 'riyadh_freeze', freezeUntil: '2030-09-24',
    }, city);
  }
  const jeddah = engine.rentChangePolicy({ city: 'جدة', today: '2025-10-01', endDate: '2025-12-31' });
  assert.equal(jeddah.increaseAllowed, true);
  assert.equal(jeddah.reason, 'not_frozen');
  for (const city of ['مدينة أخرى', 'Atlantis', '', null]) {
    const unknown = engine.rentChangePolicy({ city, today: '2025-10-01', endDate: '2025-12-31' });
    assert.equal(unknown.reason, 'unknown_city', String(city));
    assert.equal(unknown.increaseAllowed, true);
    assert.equal(unknown.reductionAllowed, true);
  }
});

test('the freeze is judged on the effective date (end_date + 1), not today', () => {
  const policy = (today, endDate) => engine.rentChangePolicy({ city: 'Riyadh', today, endDate });
  // Window edges: effective 2025-09-25 .. 2030-09-24 frozen.
  assert.equal(policy('2025-01-01', '2025-09-23').increaseAllowed, true, 'effective 2025-09-24: before the freeze');
  assert.equal(policy('2025-01-01', '2025-09-24').increaseAllowed, false, 'effective 2025-09-25: first frozen day');
  assert.equal(policy('2025-01-01', '2030-09-23').increaseAllowed, false, 'effective 2030-09-24: last frozen day');
  assert.equal(policy('2025-01-01', '2030-09-24').increaseAllowed, true, 'effective 2030-09-25: freeze over');
  // Today before the freeze started, change effective inside it: frozen.
  assert.equal(policy('2025-06-01', '2026-06-30').reason, 'riyadh_freeze');
  // Today inside the freeze, change effective after it: allowed.
  assert.equal(policy('2026-01-01', '2031-01-31').reason, 'not_frozen');
  // Today after the freeze, change effective inside it: still frozen.
  assert.equal(policy('2031-01-01', '2030-06-30').reason, 'riyadh_freeze');
});

test('rent-change policy says whether the request window is still open', () => {
  const policy = (today) => engine.rentChangePolicy({ city: 'جدة', today, endDate: '2026-03-31' });
  assert.equal(policy('2025-12-31').requestOpen, true, 'the deadline day');
  assert.equal(policy('2026-01-01').requestOpen, false);
});

test('rent-change policy follows the rules argument', () => {
  const rules = { ...RULES, RIYADH_RENT_FREEZE: { city: 'jeddah', from: '2020-01-01', years: 1 } };
  assert.equal(engine.rentChangePolicy({ city: 'جدة', today: '2020-01-01', endDate: '2020-06-30' }, rules).reason, 'riyadh_freeze');
  assert.equal(engine.rentChangePolicy({ city: 'الرياض', today: '2020-01-01', endDate: '2020-06-30' }, rules).reason, 'not_frozen');
});

// ------------------------------------------------------------ terms and renewal

test('termMonths recognises whole-month terms only', () => {
  const cases = [
    ['2025-03-01', '2026-02-28', 12],
    ['2024-03-01', '2025-02-28', 12],
    ['2023-03-01', '2024-02-29', 12],
    ['2025-01-15', '2025-02-14', 1],
    ['2025-01-01', '2025-06-30', 6],
    ['2025-01-01', '2027-12-31', 36],
    ['2025-01-31', '2025-02-27', 1],
    ['2025-01-31', '2025-02-28', 1],
    ['2024-02-29', '2025-02-28', 12],
    ['2025-08-31', '2025-11-29', 3],
    ['2025-01-01', '2025-01-20', null],
    ['2025-01-01', '2025-12-30', null],
    ['2025-01-01', '2026-01-01', null],
    ['2025-06-01', '2025-05-31', null],
  ];
  for (const [start, end, months] of cases) assert.equal(engine.termMonths(start, end), months, `${start}..${end}`);
  assert.throws(() => engine.termMonths('2025-02-30', '2025-03-31'), isCode('invalid_date'));
});

test('nextTerm: the day after end, same length', () => {
  const cases = [
    [['2025-03-01', '2026-02-28'], ['2026-03-01', '2027-02-28', 12]],
    [['2027-03-01', '2028-02-29'], ['2028-03-01', '2029-02-28', 12]],
    [['2024-02-29', '2025-02-28'], ['2025-03-01', '2026-02-28', 12]],
    [['2025-01-15', '2025-07-14'], ['2025-07-15', '2026-01-14', 6]],
    [['2025-01-31', '2025-02-27'], ['2025-02-28', '2025-03-27', 1]],
    [['2025-12-01', '2025-12-31'], ['2026-01-01', '2026-01-31', 1]],
    [['2025-01-01', '2025-01-20'], ['2025-01-21', '2025-02-09', null]],
    [['2025-02-10', '2025-02-10'], ['2025-02-11', '2025-02-11', null]],
  ];
  for (const [[start, end], [nextStart, nextEnd, months]] of cases) {
    assert.deepEqual(engine.nextTerm({ start_date: start, end_date: end }), { start_date: nextStart, end_date: nextEnd, months }, `${start}..${end}`);
  }
  assert.throws(() => engine.nextTerm({ start_date: '2026-01-01', end_date: '2025-01-01' }), isCode('end_before_start'));
});

const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

test('twenty yearly renewals never drift: always March 1 to the last day of February', () => {
  let term = { start_date: '2025-03-01', end_date: '2026-02-28' };
  for (let i = 1; i <= 20; i += 1) {
    term = engine.nextTerm(term);
    const year = 2025 + i;
    assert.equal(term.start_date, `${year}-03-01`);
    assert.equal(term.end_date, `${year + 1}-02-${isLeap(year + 1) ? 29 : 28}`);
  }
});

test('twenty renewals of other terms stay contiguous and never drift', () => {
  // Monthly from the 15th: the anchor stays the 15th.
  let term = { start_date: '2025-01-15', end_date: '2025-02-14' };
  for (let i = 0; i < 20; i += 1) {
    const next = engine.nextTerm(term);
    assert.equal(compareYmd(next.start_date, term.end_date), 1);
    assert.equal(next.start_date.slice(8), '15');
    assert.equal(engine.termMonths(next.start_date, next.end_date), 1);
    term = next;
  }
  // Exact days (45): after 20 renewals the end is start + 21*45 - 1 = 2027-08-03.
  term = { start_date: '2025-01-01', end_date: '2025-02-14' };
  for (let i = 0; i < 20; i += 1) term = engine.nextTerm(term);
  assert.equal(term.end_date, '2027-08-03');
  // Month-end start: clamps once (31 -> 28) by the rule, then stays put.
  term = { start_date: '2025-01-31', end_date: '2025-02-27' };
  const anchors = [];
  for (let i = 0; i < 20; i += 1) {
    term = engine.nextTerm(term);
    anchors.push(term.start_date.slice(8));
    assert.equal(term.months, 1);
  }
  assert.deepEqual([...new Set(anchors)], ['28']);
});

// ------------------------------------------------------------ schedule

const sum = (items) => items.reduce((total, item) => total + Math.round(item.amount * 100), 0);

test('schedule: count, amounts and dates per frequency', () => {
  const year = { start_date: '2025-03-01', end_date: '2026-02-28', annual_rent: 12000 };
  const monthly = engine.buildSchedule({ ...year, payment_frequency: 'monthly' });
  assert.equal(monthly.length, 12);
  assert.deepEqual(monthly.slice(0, 3), [
    { due_date: '2025-03-01', amount: 1000 }, { due_date: '2025-04-01', amount: 1000 }, { due_date: '2025-05-01', amount: 1000 },
  ]);
  assert.equal(monthly[11].due_date, '2026-02-01');
  assert.deepEqual(engine.buildSchedule({ ...year, payment_frequency: 'quarterly' }).map((p) => [p.due_date, p.amount]), [
    ['2025-03-01', 3000], ['2025-06-01', 3000], ['2025-09-01', 3000], ['2025-12-01', 3000],
  ]);
  assert.deepEqual(engine.buildSchedule({ ...year, payment_frequency: 'semiannual' }).map((p) => p.due_date), ['2025-03-01', '2025-09-01']);
  assert.deepEqual(engine.buildSchedule({ ...year, payment_frequency: 'annual' }), [{ due_date: '2025-03-01', amount: 12000 }]);
});

test('schedule: short and long terms use the real length in months', () => {
  const half = engine.buildSchedule({ start_date: '2025-01-01', end_date: '2025-06-30', annual_rent: '24000', payment_frequency: 'monthly' });
  assert.equal(half.length, 6);
  assert.equal(sum(half), 1200000, 'half a year of rent');
  const longAnnual = engine.buildSchedule({ start_date: '2025-01-01', end_date: '2026-06-30', annual_rent: 12000, payment_frequency: 'annual' });
  assert.deepEqual(longAnnual, [{ due_date: '2025-01-01', amount: 9000 }, { due_date: '2026-01-01', amount: 9000 }]);
  const odd = engine.buildSchedule({ start_date: '2025-01-01', end_date: '2025-07-31', annual_rent: 12000, payment_frequency: 'quarterly' });
  assert.deepEqual(odd.map((p) => p.due_date), ['2025-01-01', '2025-04-01', '2025-07-01'], '7 months quarterly = 3 payments');
  assert.equal(sum(odd), 700000);
});

test('schedule: the remainder goes on the last installment, to the halala', () => {
  const items = engine.buildSchedule({ start_date: '2025-01-01', end_date: '2025-12-31', annual_rent: 10000, payment_frequency: 'monthly' });
  assert.deepEqual(items.slice(0, 11).map((p) => p.amount), Array(11).fill(833.33));
  assert.equal(items[11].amount, 833.37);
  assert.equal(sum(items), 1000000);
  const cents = engine.buildSchedule({ start_date: '2025-01-01', end_date: '2025-12-31', annual_rent: '1000.01', payment_frequency: 'quarterly' });
  assert.deepEqual(cents.map((p) => p.amount), [250, 250, 250, 250.01]);
});

test('schedule: due dates clamp to month ends and are counted from the start', () => {
  const items = engine.buildSchedule({ start_date: '2024-01-31', end_date: '2025-01-30', annual_rent: 12000, payment_frequency: 'monthly' });
  assert.deepEqual(items.slice(0, 4).map((p) => p.due_date), ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
});

test('schedule: bad input gets a clear error code', () => {
  const ok = { start_date: '2025-01-01', end_date: '2025-12-31', annual_rent: 12000, payment_frequency: 'monthly' };
  assert.throws(() => engine.buildSchedule({ ...ok, annual_rent: 0 }), isCode('invalid_rent'));
  assert.throws(() => engine.buildSchedule({ ...ok, annual_rent: -5 }), isCode('invalid_rent'));
  assert.throws(() => engine.buildSchedule({ ...ok, annual_rent: 'abc' }), isCode('invalid_rent'));
  assert.throws(() => engine.buildSchedule({ ...ok, annual_rent: null }), isCode('invalid_rent'));
  assert.throws(() => engine.buildSchedule({ ...ok, payment_frequency: 'weekly' }), isCode('unknown_frequency'));
  assert.throws(() => engine.buildSchedule({ ...ok, payment_frequency: 'toString' }), isCode('unknown_frequency'));
  assert.throws(() => engine.buildSchedule({ ...ok, end_date: '2024-12-31' }), isCode('end_before_start'));
  assert.throws(() => engine.buildSchedule({ ...ok, start_date: '2025-02-29' }), isCode('invalid_date'));
  assert.throws(() => engine.buildSchedule({ ...ok, end_date: '2025-12-20' }), isCode('term_not_whole_months'));
});

// Tiny seeded PRNG so the property test is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: 500 random contracts, schedules add up to the halala', () => {
  const random = mulberry32(20250925);
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const frequencies = Object.keys(engine.FREQUENCIES);
  for (let i = 0; i < 500; i += 1) {
    const year = int(2000, 2090);
    const month = int(1, 12);
    const day = int(1, 31);
    const start = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate())).padStart(2, '0')}`;
    const months = int(1, 60);
    // End = start + n months - 1 day (the day subtraction done with plain Date).
    const endDate = new Date(Date.parse(`${addMonths(start, months)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const annualHalalas = int(1, 500000000);
    const rent = random() < 0.5 ? annualHalalas / 100 : `${Math.floor(annualHalalas / 100)}.${String(annualHalalas % 100).padStart(2, '0')}`;
    const frequency = frequencies[int(0, frequencies.length - 1)];
    const label = `${start}..${endDate} ${months}m ${rent} ${frequency}`;

    const items = engine.buildSchedule({ start_date: start, end_date: endDate, annual_rent: rent, payment_frequency: frequency });
    assert.equal(items.length, Math.ceil(months / engine.FREQUENCIES[frequency]), label);
    assert.equal(sum(items), Math.round((annualHalalas * months) / 12), `total ${label}`);
    assert.equal(items[0].due_date, start, label);
    for (let k = 0; k < items.length; k += 1) {
      const { due_date: due, amount } = items[k];
      assert.ok(isValidYmd(due), `${due} ${label}`);
      assert.ok(due >= start && due <= endDate, `${due} inside ${label}`);
      if (k > 0) assert.ok(due > items[k - 1].due_date, `increasing ${label}`);
      assert.equal(Math.round(amount * 100) / 100, amount, 'two decimals at most');
      assert.ok(amount >= 0, label);
    }
    const base = Math.round(items[0].amount * 100);
    for (const item of items.slice(0, -1)) assert.equal(Math.round(item.amount * 100), base, `equal installments ${label}`);
  }
});

// ------------------------------------------------------------ money

test('toHalalas reads numbers and Arabic or grouped strings exactly', () => {
  assert.equal(engine.toHalalas(45000), 4500000);
  assert.equal(engine.toHalalas(0.1 + 0.2), 30);
  assert.equal(engine.toHalalas('45,000.5'), 4500050);
  assert.equal(engine.toHalalas('٤٥٬٠٠٠٫٥٠'), 4500050);
  assert.equal(engine.toHalalas('-100'), -10000);
  for (const bad of ['', 'abc', '1.234', '1e5', null, undefined, NaN, Infinity, {}]) assert.equal(engine.toHalalas(bad), null, String(bad));
});

// ------------------------------------------------------------ sanity warnings

const TODAY = '2025-09-30';
const codes = (fields) => engine.sanityWarnings(fields, TODAY).map((w) => w.code).sort();

test('a normal contract has no warnings', () => {
  assert.deepEqual(engine.sanityWarnings({ start_date: '2025-09-01', end_date: '2026-08-31', annual_rent: '45000', deposit: 5000 }, TODAY), []);
});

test('sanity warnings: each check, with severity and an Arabic message', () => {
  assert.deepEqual(codes({ annual_rent: 45000 }), ['end_date_invalid', 'start_date_invalid']);
  assert.deepEqual(codes({ start_date: '2025-02-30', end_date: '2026-01-01', annual_rent: 45000 }), ['start_date_invalid']);
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2025-09-01', annual_rent: 45000 }), ['end_not_after_start']);
  assert.deepEqual(codes({ start_date: '2026-01-01', end_date: '2026-01-20', annual_rent: 45000 }), ['term_too_short']);
  assert.deepEqual(codes({ start_date: '2026-01-01', end_date: '2026-01-31', annual_rent: 45000 }), [], 'exactly one month is fine');
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2035-09-01', annual_rent: 45000 }), ['term_too_long']);
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2035-08-31', annual_rent: 45000 }), [], 'exactly ten years is fine');
  assert.deepEqual(codes({ start_date: '2023-09-01', end_date: '2026-08-31', annual_rent: 45000 }), ['start_far_past']);
  assert.deepEqual(codes({ start_date: '2027-10-01', end_date: '2028-09-30', annual_rent: 45000 }), ['start_far_future']);
  for (const rent of [undefined, 0, -5, 'abc']) assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2026-08-31', annual_rent: rent }), ['rent_invalid'], String(rent));
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2026-08-31', annual_rent: 999 }), ['rent_too_low']);
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2026-08-31', annual_rent: 10000001 }), ['rent_too_high']);
  assert.deepEqual(codes({ start_date: '2025-09-01', end_date: '2026-08-31', annual_rent: 1000, deposit: 1000.01 }), ['deposit_above_rent']);
  assert.deepEqual(codes({ start_date: '2025-01-01', end_date: '2025-10-31', annual_rent: 45000 }), ['notice_passed']);
  assert.deepEqual(codes({ start_date: '2024-10-01', end_date: '2025-09-29', annual_rent: 45000 }), ['contract_ended']);

  const all = engine.sanityWarnings({ start_date: '2025-09-01', end_date: '2025-08-01', annual_rent: 0 }, TODAY);
  assert.deepEqual(all.map((w) => [w.code, w.severity]), [['end_not_after_start', 'error'], ['rent_invalid', 'error']]);
  for (const w of engine.sanityWarnings({ start_date: '2020-01-01', end_date: '2020-01-02', annual_rent: 5, deposit: 10 }, TODAY)) {
    assert.ok(['warn', 'error'].includes(w.severity));
    assert.match(w.message_ar, /[؀-ۿ]/, `${w.code} has an Arabic message`);
  }
  assert.throws(() => engine.sanityWarnings({}, '2025-9-30'), isCode('invalid_date'));
});

// ------------------------------------------------------------ display

test('Hijri and Arabic Gregorian are display strings, stable for the same input', () => {
  const hijri = engine.formatHijri('2025-09-25');
  assert.match(hijri, /^[٠-٩]{4}\/[٠-٩]{2}\/[٠-٩]{2} هـ$/);
  assert.ok(hijri.startsWith('١٤٤٧/'));
  assert.equal(engine.formatHijri('2025-09-25'), hijri);
  const gregorian = engine.formatGregorianAr('2025-09-25');
  assert.ok(gregorian.length > 0);
  assert.match(gregorian, /سبتمبر/);
  assert.equal(engine.formatGregorianAr('2025-09-25'), gregorian);
  assert.throws(() => engine.formatHijri('2025-02-30'), isCode('invalid_date'));
});
