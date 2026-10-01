'use strict';

// Pure parts of reminders and delivery: threshold math against the engine
// (leap years and month ends included), catch-up, Riyadh wording, quiet
// hours, retry schedule and channel drivers with the network mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../services/contractEngine');
const dates = require('../services/contractDates');
const reminders = require('../services/reminders');
const delivery = require('../services/delivery');
const notifications = require('../services/notifications');
const transport = require('../services/channels/transport');
const whatsapp = require('../services/channels/whatsapp');
const telegram = require('../services/channels/telegram');
const email = require('../services/channels/email');
const contacts = require('../services/contacts');

const DEFAULT_RULES = Object.fromEntries(Object.entries(reminders.RULE_KINDS).map(([k, r]) => [k, { enabled: true, days: [...r.days] }]));
const yearContract = (start, extra = {}) => ({
  id: 1, status: 'calm', city: 'جدة', start_date: start, end_date: dates.addDays(dates.addMonths(start, 12), -1), ...extra,
});

function hitDays(contract, kind, from, to, payments = []) {
  const found = [];
  for (let day = from; engine.compareDates(day, to) <= 0; day = dates.addDays(day, 1)) {
    for (const hit of reminders.hitsFor(contract, payments, DEFAULT_RULES, day)) if (hit.kind === kind) found.push([day, hit.n]);
  }
  return found;
}

for (const [label, start] of [['plain', '2026-03-10'], ['starts on Feb 28 before a leap year', '2027-02-28'], ['leap day end', '2027-03-01'], ['month end start', '2026-01-31']]) {
  test(`decision thresholds 60/45/30/14/7/3/1 before the engine deadline: ${label}`, () => {
    const c = yearContract(start);
    const deadline = engine.noticeDeadline(c.end_date);
    const expected = [60, 45, 30, 14, 7, 3, 1].map((n) => [engine.thresholdDate(deadline, n), n]);
    assert.deepEqual(hitDays(c, 'decision_60', dates.addDays(deadline, -70), c.end_date), expected);
    for (const [day, n] of expected) assert.equal(engine.daysUntil(day, deadline), n);
  });

  test(`rent-change thresholds 90/60/30 before the engine deadline: ${label}`, () => {
    const c = yearContract(start);
    const deadline = engine.rentChangeDeadline(c.end_date);
    const expected = [90, 60, 30].map((n) => [dates.addDays(deadline, -n), n]);
    assert.deepEqual(hitDays(c, 'rent_change_90', dates.addDays(deadline, -100), c.end_date), expected);
  });
}

test('leap-year contract: deadlines and reminder days come from the engine', () => {
  const c = yearContract('2027-03-01'); // ends 2028-02-29
  assert.equal(c.end_date, '2028-02-29');
  assert.equal(engine.noticeDeadline(c.end_date), '2027-12-31');
  assert.equal(engine.thresholdDate('2027-12-31', 60), '2027-11-01');
  assert.equal(engine.rentChangeDeadline(c.end_date), '2027-12-01');
  assert.deepEqual(reminders.hitsFor(c, [], DEFAULT_RULES, '2027-11-01').map((h) => [h.kind, h.n]), [['decision_60', 60], ['rent_change_90', 30]]);
});

test('payments: due 7/3/0 days before, late 1/3/7 days after; nothing once the contract is not running', () => {
  const c = yearContract('2026-01-01');
  const p = { id: 9, due_date: '2026-05-01', amount: '1000.00', status: 'due' };
  assert.deepEqual(hitDays(c, 'payment_due', '2026-04-20', '2026-05-10', [p]).map((h) => h[1]), [7, 3, 0]);
  assert.deepEqual(hitDays(c, 'payment_late', '2026-04-20', '2026-05-10', [p]).map((h) => h[1]), [1, 3, 7]);
  for (const status of ['terminated', 'renewed']) {
    assert.deepEqual(reminders.hitsFor({ ...c, status }, [p], DEFAULT_RULES, '2026-04-24'), [], status);
  }
});

test('contract ended: one reminder the day after the end; none for terminated or renewed', () => {
  const c = yearContract('2025-06-01');
  const after = dates.addDays(c.end_date, 1);
  assert.deepEqual(reminders.hitsFor(c, [], DEFAULT_RULES, c.end_date).filter((h) => h.kind === 'contract_ended'), [], 'the end day is still running');
  assert.deepEqual(reminders.hitsFor(c, [], DEFAULT_RULES, after).map((h) => [h.kind, h.n]), [['contract_ended', 1]]);
  assert.deepEqual(reminders.hitsFor({ ...c, status: 'terminated' }, [], DEFAULT_RULES, after), []);
  assert.deepEqual(reminders.hitsFor({ ...c, status: 'renewed' }, [], DEFAULT_RULES, after), []);
});

test('disabled rules and custom days are respected', () => {
  const c = yearContract('2026-03-10');
  const deadline = engine.noticeDeadline(c.end_date);
  const rules = { ...DEFAULT_RULES, decision_60: { enabled: false, days: [7] } };
  assert.deepEqual(reminders.hitsFor(c, [], rules, dates.addDays(deadline, -7)), []);
  const custom = { ...DEFAULT_RULES, decision_60: { enabled: true, days: [10] } };
  assert.deepEqual(reminders.hitsFor(c, [], custom, dates.addDays(deadline, -10)).map((h) => h.n), [10]);
});

test('catch-up: missed days are marked late and capped at 3 days back; first run has none', () => {
  assert.deepEqual(engine.reminderDays('2026-10-10', null), [{ day: '2026-10-10', late: false }]);
  assert.deepEqual(engine.reminderDays('2026-10-10', '2026-10-09'), [{ day: '2026-10-10', late: false }]);
  assert.deepEqual(engine.reminderDays('2026-10-10', '2026-10-08'), [{ day: '2026-10-10', late: false }, { day: '2026-10-09', late: true }]);
  const far = engine.reminderDays('2026-10-10', '2026-09-01');
  assert.deepEqual(far.map((d) => d.day), ['2026-10-10', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.ok(far.slice(1).every((d) => d.late));
  const c = { unit_label: 'شقة 1', end_date: '2027-01-31', city: 'جدة' };
  assert.match(reminders.messageFor({ kind: 'decision_60', audience: 'office', n: 7, contract: c, officeName: 'م', late: true }).title, /^متأخر: /);
});

test('Riyadh freeze: no rent-increase wording; freeze notice for office and landlord, reduction reminder for the tenant', () => {
  const riyadh = { unit_label: 'شقة الرياض', end_date: '2027-09-30', city: 'الرياض' };
  assert.equal(engine.rentChangePolicy({ city: riyadh.city, today: '2026-10-01', endDate: riyadh.end_date }).reason, 'riyadh_freeze');
  for (const audience of ['office', 'landlord', 'tenant']) {
    const { title, body } = reminders.messageFor({ kind: 'rent_change_90', audience, n: 30, contract: riyadh, officeName: 'مكتب' });
    const text = `${title} ${body}`;
    assert.doesNotMatch(text, /رفع|زيادة|تغيير الإيجار/, audience);
    assert.match(text, audience === 'tenant' ? /تخفيض/ : /مجمّد في الرياض/, audience);
  }
  const jeddah = { ...riyadh, city: 'جدة' };
  assert.match(reminders.messageFor({ kind: 'rent_change_90', audience: 'landlord', n: 30, contract: jeddah, officeName: 'م' }).body, /تغيير الإيجار/);
});

test('messages hold nicknames, dates and amounts only, and get the disclaimer', () => {
  const c = { unit_label: 'شقة 3', end_date: '2027-01-31', city: 'جدة', tenant_label: 'سري جداً' };
  const { title, body } = reminders.messageFor({ kind: 'payment_due', audience: 'tenant', n: 3, contract: c, payment: { amount: '3000', due_date: '2026-10-04' }, officeName: 'مكتب النخبة' });
  assert.match(title, /شقة 3/);
  assert.match(body, /3,000\.00 ريال/);
  assert.match(body, /2026-10-04/);
  assert.doesNotMatch(body, /سري/);
  assert.ok(notifications.withDisclaimer(body).endsWith('تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'));
  assert.equal(notifications.withDisclaimer(notifications.withDisclaimer('x')), notifications.withDisclaimer('x'), 'added once');
});

test('rule days parsing: Arabic digits and commas, ranges, limits', () => {
  assert.deepEqual(reminders.parseDays('٦٠، 30 ,7', 'before'), { days: [60, 30, 7] });
  assert.deepEqual(reminders.parseDays('0', 'before'), { days: [0] });
  assert.ok(reminders.parseDays('0', 'after').error, 'after-kinds start at 1');
  assert.ok(reminders.parseDays('', 'before').error);
  assert.ok(reminders.parseDays('400', 'before').error);
  assert.ok(reminders.parseDays('1,2,3,4,5,6,7,8,9,10,11', 'before').error);
  assert.ok(reminders.parseDays('7; DROP TABLE', 'before').error);
});

test('quiet hours 21:00-08:00 Riyadh: non-urgent messages wait until 08:00', () => {
  const at = (iso) => new Date(iso);
  assert.equal(dates.inQuietHours(at('2026-10-01T17:59:00Z'), '21:00', '08:00'), false, '20:59 Riyadh');
  assert.equal(dates.inQuietHours(at('2026-10-01T18:00:00Z'), '21:00', '08:00'), true, '21:00 Riyadh');
  assert.equal(dates.inQuietHours(at('2026-10-02T04:59:00Z'), '21:00', '08:00'), true, '07:59 Riyadh');
  assert.equal(dates.inQuietHours(at('2026-10-02T05:00:00Z'), '21:00', '08:00'), false, '08:00 Riyadh');
  assert.equal(dates.afterQuietHours(at('2026-10-01T19:30:00Z'), '21:00', '08:00').toISOString(), '2026-10-02T05:00:00.000Z');
  assert.equal(dates.afterQuietHours(at('2026-10-02T01:00:00Z'), '21:00', '08:00').toISOString(), '2026-10-02T05:00:00.000Z');
  assert.equal(dates.afterQuietHours(at('2026-10-02T09:00:00Z'), '21:00', '08:00').toISOString(), '2026-10-02T09:00:00.000Z');
  assert.equal(dates.inQuietHours(at('2026-10-02T10:30:00Z'), '13:00', '14:00'), true, 'a window inside one day (13:30)');
  assert.equal(dates.inQuietHours(at('2026-10-02T09:00:00Z'), '13:00', '14:00'), false, '12:00 is outside it');
  assert.equal(dates.inQuietHours(at('2026-10-02T09:00:00Z'), '08:00', '08:00'), false, 'same start and end = none');
  assert.equal(reminders.isUrgent('decision_60', 1), true);
  assert.equal(reminders.isUrgent('decision_60', 7), false);
  assert.equal(reminders.isUrgent('payment_late', 1), false);
});

test('retry schedule: 1 min, 10 min, 1 hour, then failed; skips and successes are final', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const fail = { ok: false, error: 'http_500', retryable: true };
  assert.deepEqual(delivery.nextState(fail, 1, now), { status: 'pending', error_code: 'http_500', next_retry_at: new Date('2026-10-01T10:01:00Z') });
  assert.deepEqual(delivery.nextState(fail, 2, now).next_retry_at, new Date('2026-10-01T10:10:00Z'));
  assert.deepEqual(delivery.nextState(fail, 3, now).next_retry_at, new Date('2026-10-01T11:00:00Z'));
  assert.equal(delivery.nextState(fail, 4, now).status, 'failed');
  assert.equal(delivery.nextState({ ok: false, error: 'http_400', retryable: false }, 1, now).status, 'failed');
  assert.equal(delivery.nextState({ ok: false, error: 'no_contact', skip: true }, 1, now).status, 'skipped');
  assert.equal(delivery.nextState({ ok: true }, 1, now).status, 'sent');
});

test('drivers: no network in tests, missing SMTP is skipped, outcomes map to retry or not', async () => {
  transport.setMock(null);
  assert.deepEqual(await transport.postJson('https://example.invalid', {}).then((r) => r.error), 'network_disabled_in_tests');
  assert.deepEqual(await email.send({ to: 'a@b.sa', subject: 's', text: 't' }, {}), { ok: false, error: 'smtp_not_configured', skip: true });
  assert.equal(email.smtpConfig({ SMTP_HOST: 'h', MAIL_FROM: 'f', SMTP_PASSWORD: 'p', SMTP_USER: 'u' }).auth.pass, 'p', 'old name still works');
  assert.deepEqual(transport.outcome({ status: 200 }), { ok: true });
  assert.equal(transport.outcome({ status: 503 }).retryable, true);
  assert.equal(transport.outcome({ status: 429 }).retryable, true);
  assert.equal(transport.outcome({ status: 401 }).retryable, false);
  assert.equal(transport.outcome({ error: 'timeout' }).error, 'timeout');

  const calls = [];
  transport.setMock(async (url, options) => {
    calls.push({ url, options });
    return { status: 200, body: '{"ok":true}' };
  });
  try {
    const sent = await whatsapp.send({ config: { phone_number_id: '123456', token: 'T'.repeat(30) }, settings: {}, to: '+966500000001', title: 'عنوان', body: 'سطر\n\nسطر    ثاني' });
    assert.deepEqual(sent, { ok: true });
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.type, 'template', 'template messages only');
    assert.equal(payload.to, '966500000001');
    assert.equal(payload.template.components[0].parameters[1].text, 'سطر - سطر ثاني');
    assert.match(calls[0].options.headers.Authorization, /^Bearer /);
    assert.equal((await telegram.send({ token: '12345:' + 'a'.repeat(35), chatId: '42', text: 'x' })).ok, true);
    assert.equal(JSON.parse(calls[1].options.body).parse_mode, undefined, 'plain text, no markup');
    assert.equal((await telegram.send({ token: 'bad', chatId: '42', text: 'x' })).skip, true);
    assert.equal((await whatsapp.send({ config: {}, to: '+966500000001', title: 't', body: 'b' })).skip, true);
  } finally {
    transport.setMock(null);
  }
});

test('Telegram link code parsing', () => {
  assert.equal(contacts.codeFromMessage('/start ab2c-d3ef'), 'AB2CD3EF');
  assert.equal(contacts.codeFromMessage('AB2CD3EF'), 'AB2CD3EF');
  assert.equal(contacts.codeFromMessage('/start'), null);
  assert.equal(contacts.codeFromMessage('hello there'), null);
});
