'use strict';

// Contracts against real MySQL: entry with preview, schedule, tenant invite,
// payments, terminate, renew, delete, status recomputation, isolation.
// Expected dates come from the engine, which has its own tests. Runs only
// when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000004NN.
const phone = (n) => `9665000004${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 60 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let engine;
let dates;
let contracts;
let contractStatus;
let scopeToOffice;
let TODAY;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, is_active, sort_order)
     VALUES ('test_contracts_none', 'اختبار بلا حد', 1, 1, NULL, NULL, 0, 93), ('test_contracts_2', 'اختبار عقدين', 1, 1, NULL, 2, 0, 94)
     ON DUPLICATE KEY UPDATE max_units = VALUES(max_units), max_contracts = VALUES(max_contracts), is_active = 0`,
  );
  engine = require('../services/contractEngine');
  dates = require('../services/contractDates');
  contracts = require('../services/contracts');
  contractStatus = require('../services/contractStatus');
  ({ scopeToOffice } = require('../services/scopeToOffice'));
  TODAY = dates.riyadhDate(new Date());
  http = createOfficeHttp(db);
  await http.start();
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
}

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

// ------------------------------------------------------------ helpers

const idFrom = (location) => Number(/\/office\/contracts\/(\d+)/.exec(location)[1]);
const months = (start, n) => dates.addDays(dates.addMonths(start, n), -1);

async function count(sql, params = []) {
  const [[row]] = await db.pool.query(sql, params);
  return Number(Object.values(row)[0]);
}

async function unitStatusOf(id) {
  return (await db.pool.query('SELECT status FROM units WHERE id = ?', [id]))[0][0].status;
}

/** An office (unlimited plan) with one landlord and `unitCount` vacant units. */
async function officeWithUnits(n, name, { unitCount = 1, plan = 'test_contracts_none', city = 'جدة' } = {}) {
  const owner = await http.registerOffice(phone(n), name);
  await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', [plan, owner.office.id]);
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const landlordId = await scoped.insert('landlords', { label: `مالك ${name}` });
  const unitIds = [];
  for (let i = 1; i <= unitCount; i += 1) unitIds.push(await scoped.insert('units', { landlord_id: landlordId, label: `شقة ${i}`, city }));
  return { ...owner, scoped, landlordId, unitIds, unitId: unitIds[0] };
}

function contractForm(o, extra = {}) {
  const start = extra.start_date || TODAY;
  return {
    landlord_id: String(o.landlordId),
    unit_id: String(o.unitId),
    tenant_label: 'مستأجر-سري',
    contract_number: 'EJ-1001',
    start_date: start,
    end_date: extra.end_date || months(start, 12),
    annual_rent: '36000',
    payment_frequency: 'monthly',
    deposit: '2000',
    city: 'جدة',
    auto_renew: '1',
    ...extra,
  };
}

async function createVia(o, extra = {}, cookie = o.cookie) {
  return http.request('/office/contracts', { method: 'POST', cookie, form: contractForm(o, extra) });
}

async function created(o, extra = {}) {
  const res = await createVia(o, extra);
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 400));
  return idFrom(res.location);
}

const sumHalalas = (rows) => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);

// ------------------------------------------------------------ create

test('create end to end: schedule, deadlines, unit rented, tenant invite, events and audit without sensitive values', { skip }, async () => {
  const o = await officeWithUnits(1, 'مكتب العقود');
  const form = await http.request('/office/contracts/new', { cookie: o.cookie });
  assert.equal(form.status, 200);
  assert.match(form.text, /لا تكتب الاسم الكامل أو رقم الهوية/);
  assert.match(form.text, /name="auto_renew" value="1" checked/, 'auto renew defaults from the rules');
  assert.match(form.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);

  const id = await created(o);
  const [[c]] = await db.pool.query('SELECT * FROM contracts WHERE id = ?', [id]);
  const end = months(TODAY, 12);
  assert.equal(c.office_id, o.office.id);
  assert.equal(c.start_date, TODAY);
  assert.equal(c.end_date, end);
  assert.equal(c.notice_deadline, engine.noticeDeadline(end));
  assert.equal(c.rent_change_deadline, engine.rentChangeDeadline(end));
  assert.equal(c.status, engine.classifyContract({ start_date: TODAY, end_date: end }, TODAY));
  assert.equal(c.annual_rent, '36000.00');
  assert.equal(c.currency, 'SAR');
  assert.equal(c.source, 'manual');
  assert.equal(c.created_by, o.user.id);
  assert.equal(c.tenant_label, 'مستأجر-سري');
  assert.equal(c.city, 'جدة');

  const [payments] = await db.pool.query('SELECT due_date, amount, status FROM contract_payments WHERE contract_id = ? ORDER BY due_date', [id]);
  const schedule = engine.buildSchedule({ start_date: TODAY, end_date: end, annual_rent: '36000', payment_frequency: 'monthly' });
  assert.deepEqual(payments.map((p) => [p.due_date, Number(p.amount), p.status]), schedule.map((p) => [p.due_date, p.amount, 'due']));
  assert.equal(sumHalalas(payments), 3600000);

  assert.equal(await unitStatusOf(o.unitId), 'rented');
  const [inv] = await db.pool.query("SELECT * FROM invites WHERE contract_id = ? AND kind = 'tenant'", [id]);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].office_id, o.office.id);
  assert.equal(inv[0].created_by, o.user.id);
  assert.ok(new Date(inv[0].expires_at) > new Date(), 'active');

  const [events] = await db.pool.query('SELECT event_type, details FROM contract_events WHERE contract_id = ?', [id]);
  assert.ok(events.some((e) => e.event_type === 'contract_created'));
  const [audits] = await db.pool.query("SELECT after_json FROM audit_logs WHERE office_id = ? AND entity_type = 'contract'", [o.office.id]);
  const leaked = JSON.stringify([events, audits]);
  for (const secret of ['36000', '3000', 'مستأجر-سري', '2000']) assert.ok(!leaked.includes(secret), `events/audit leak ${secret}`);

  const page = await http.request(`/office/contracts/${id}`, { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /تقريبي/);
  assert.match(page.text, new RegExp(`<output id="invite-code" dir="ltr">${inv[0].code}</output>`));
  const link = decodeURIComponent(/href="(https:\/\/wa\.me\/[^"]+)"/.exec(page.text)[1].replace(/&amp;/g, '&'));
  assert.ok(link.includes(inv[0].code) && link.includes('https://aqdi.example/join'));
  assert.equal((page.text.match(/class="payment"/g) || []).length, 12);
  assert.match(page.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);

  const list = await http.request('/office/contracts', { cookie: o.cookie });
  assert.match(list.text, /شقة 1 · مستأجر-سري/);
  assert.match(list.text, /36,000 ريال سنوياً/);
});

test('the unit stays vacant when the start is more than 30 days away, and is rented when it is within 30', { skip }, async () => {
  const o = await officeWithUnits(2, 'مكتب البداية', { unitCount: 2 });
  const far = await created(o, { start_date: dates.addDays(TODAY, 45) });
  assert.equal(await unitStatusOf(o.unitIds[0]), 'vacant');
  const [pending] = await db.pool.query("SELECT details FROM contract_events WHERE contract_id = ? AND event_type = 'unit_rent_pending'", [far]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].details.start_date, dates.addDays(TODAY, 45));

  await created({ ...o, unitId: o.unitIds[1] }, { start_date: dates.addDays(TODAY, 30) });
  assert.equal(await unitStatusOf(o.unitIds[1]), 'rented');
});

// ------------------------------------------------------------ validation

test('validation: dates, rent, frequency, landlord/unit links, overlap and back to back', { skip }, async () => {
  const o = await officeWithUnits(3, 'مكتب التحقق', { unitCount: 3 });
  const other = await officeWithUnits(4, 'مكتب آخر');
  const second = await o.scoped.insert('landlords', { label: 'مالك ثان' });
  const before = await count('SELECT COUNT(*) FROM contracts WHERE office_id = ?', [o.office.id]);

  const cases = [
    [{ start_date: '2026-02-30', end_date: '2027-02-27' }, 'اختر تاريخاً صحيحاً'],
    [{ start_date: TODAY, end_date: dates.addDays(TODAY, -1) }, 'قبل تاريخ البداية'],
    [{ end_date: dates.addDays(months(TODAY, 12), -5) }, 'أشهراً كاملة'],
    [{ annual_rent: '0' }, 'الإيجار السنوي'],
    [{ annual_rent: 'abc' }, 'الإيجار السنوي'],
    [{ payment_frequency: 'weekly' }, 'طريقة الدفع'],
    [{ landlord_id: String(second) }, 'الوحدة المختارة لا تتبع هذا المالك'],
    [{ tenant_label: 'ت'.repeat(121) }, '120 حرفاً'],
    [{ contract_number: 'رقم عربي' }, 'رقم العقد'],
  ];
  for (const [extra, message] of cases) {
    const res = await createVia(o, extra);
    assert.equal(res.status, 422, JSON.stringify(extra));
    assert.ok(res.text.includes(message), `${JSON.stringify(extra)} -> ${message}`);
  }
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE office_id = ?', [o.office.id]), before);

  // Another office's landlord or unit: 404, nothing written.
  assert.equal((await createVia(o, { landlord_id: String(other.landlordId), unit_id: String(other.unitId) })).status, 404);
  assert.equal((await createVia(o, { unit_id: String(other.unitId) })).status, 404);
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE unit_id = ?', [other.unitId]), 0);

  // Unit not vacant.
  await db.pool.query("UPDATE units SET status = 'maintenance' WHERE id = ?", [o.unitIds[2]]);
  const busy = await createVia({ ...o, unitId: o.unitIds[2] });
  assert.equal(busy.status, 409);
  assert.match(busy.text, /الوحدة غير شاغرة/);

  // Overlap on a vacant unit that has a future contract; back to back is fine.
  const futureStart = dates.addDays(TODAY, 90);
  await created({ ...o, unitId: o.unitIds[1] }, { start_date: futureStart });
  const overlap = await createVia({ ...o, unitId: o.unitIds[1] }, { start_date: dates.addMonths(futureStart, -1), end_date: months(dates.addMonths(futureStart, -1), 2) });
  assert.equal(overlap.status, 409);
  assert.match(overlap.text, /يوجد عقد آخر على هذه الوحدة في نفس الفترة/);
  const backStart = dates.addMonths(futureStart, -1);
  const backToBack = await createVia({ ...o, unitId: o.unitIds[1] }, { start_date: backStart, end_date: dates.addDays(futureStart, -1) });
  assert.equal(backToBack.status, 302, 'a contract ending the day before the next one starts is fine');
});

test('warnings need the acknowledgement tick; errors block', { skip }, async () => {
  const o = await officeWithUnits(5, 'مكتب التنبيهات');
  const old = { start_date: dates.addMonths(TODAY, -36), end_date: months(dates.addMonths(TODAY, -36), 12) };
  const blocked = await createVia(o, old);
  assert.equal(blocked.status, 422);
  assert.match(blocked.text, /راجعت التنبيهات وأريد المتابعة/);
  assert.match(blocked.text, /انتهت مدة هذا العقد/);
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE office_id = ?', [o.office.id]), 0);

  const ok = await createVia(o, { ...old, ack_warnings: '1' });
  assert.equal(ok.status, 302);
  const [[c]] = await db.pool.query('SELECT status FROM contracts WHERE id = ?', [idFrom(ok.location)]);
  assert.equal(c.status, 'ended');
  assert.equal(await unitStatusOf(o.unitId), 'vacant', 'an ended contract does not rent the unit');
});

// ------------------------------------------------------------ concurrency and limits

test('two parallel saves for one unit give exactly one contract', { skip }, async () => {
  const o = await officeWithUnits(6, 'مكتب السباق');
  const results = await Promise.all([createVia(o), createVia(o), createVia(o)]);
  assert.equal(results.filter((r) => r.status === 302).length, 1);
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE unit_id = ?', [o.unitId]), 1);

  const far = await officeWithUnits(7, 'مكتب السباق البعيد');
  const start = dates.addDays(TODAY, 60); // unit stays vacant: only the overlap check protects it
  const farResults = await Promise.all([createVia(far, { start_date: start }), createVia(far, { start_date: start })]);
  assert.equal(farResults.filter((r) => r.status === 302).length, 1);
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE unit_id = ?', [far.unitId]), 1);
});

test('the contract plan limit holds, also under parallel saves', { skip }, async () => {
  const o = await officeWithUnits(8, 'مكتب الحد', { unitCount: 5, plan: 'test_contracts_2' });
  const results = await Promise.all(o.unitIds.slice(0, 4).map((unitId) => createVia({ ...o, unitId })));
  assert.equal(results.filter((r) => r.status === 302).length, 2);
  assert.ok(results.filter((r) => r.status === 409).every((r) => /حد باقتك: 2 عقداً/.test(r.text) && /href="\/office\/billing"/.test(r.text)));
  assert.equal(await count("SELECT COUNT(*) FROM contracts WHERE office_id = ? AND status IN ('calm','soon','urgent','deadline_passed')", [o.office.id]), 2);
});

for (const failing of ['contract_payments', 'invites']) {
  test(`a failure while writing ${failing} saves nothing`, { skip }, async () => {
    const o = await officeWithUnits(failing === 'invites' ? 9 : 10, `مكتب الفشل ${failing}`);
    const failingPool = {
      async getConnection() {
        const conn = await db.pool.getConnection();
        return new Proxy(conn, {
          get(target, prop) {
            if (prop !== 'query') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
            return (sql, params) => (new RegExp(`INSERT INTO \`?${failing}\`?`).test(sql)
              ? Promise.reject(Object.assign(new Error('simulated failure'), { code: 'ER_SIMULATED' }))
              : target.query(sql, params));
          },
        });
      },
    };
    const { values } = contracts.validateContractFields(contractForm(o));
    await assert.rejects(contracts.createContract(failingPool, o.office.id, { fields: values, actorId: o.user.id, ip: null, today: TODAY }), /simulated failure/);
    assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE office_id = ?', [o.office.id]), 0);
    assert.equal(await count('SELECT COUNT(*) FROM contract_payments WHERE office_id = ?', [o.office.id]), 0);
    assert.equal(await count('SELECT COUNT(*) FROM invites WHERE office_id = ?', [o.office.id]), 0);
    assert.equal(await unitStatusOf(o.unitId), 'vacant', 'unit not marked rented');
  });
}

// ------------------------------------------------------------ preview

test('preview: the engine output, no rows written, invalid input refused, rate limited', { skip }, async () => {
  const o = await officeWithUnits(11, 'مكتب المعاينة');
  // Only this office's rows: other test files write to the same database meanwhile.
  const counts = async () => Promise.all([
    count('SELECT COUNT(*) FROM contracts WHERE office_id = ?', [o.office.id]),
    count('SELECT COUNT(*) FROM contract_payments WHERE office_id = ?', [o.office.id]),
    count('SELECT COUNT(*) FROM invites WHERE office_id = ?', [o.office.id]),
    count('SELECT COUNT(*) FROM audit_logs WHERE office_id = ?', [o.office.id]),
    count('SELECT COUNT(*) FROM contract_events e JOIN contracts c ON c.id = e.contract_id WHERE c.office_id = ?', [o.office.id]),
    count('SELECT COUNT(*) FROM audit_logs WHERE actor_id = ?', [o.user.id]),
  ]);
  const before = await counts();
  const body = { start_date: TODAY, end_date: months(TODAY, 12), annual_rent: '45,000', payment_frequency: 'quarterly', city: 'الرياض' };
  const post = (payload, cookie = o.cookie) => fetch(`${http.base()}/office/contracts/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie, Origin: http.base() },
    body: JSON.stringify(payload),
  });
  const res = await post(body);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, JSON.parse(JSON.stringify(contracts.previewContract(body, TODAY))));
  const end = months(TODAY, 12);
  assert.equal(json.preview.noticeDeadline, engine.noticeDeadline(end));
  assert.equal(json.preview.rentChangeDeadline, engine.rentChangeDeadline(end));
  assert.deepEqual(json.preview.schedule, engine.buildSchedule({ ...body, annual_rent: '45000' }).slice(0, 4));
  assert.equal(json.preview.rentPolicy.reason, 'riyadh_freeze');
  assert.equal(json.preview.startHijri, engine.formatHijri(TODAY));
  assert.deepEqual(await counts(), before, 'no rows written');

  const bad = await (await post({ start_date: '2026-02-30', annual_rent: '-5', payment_frequency: 'weekly' })).json();
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.start_date && bad.errors.annual_rent && bad.errors.payment_frequency);
  assert.equal(bad.preview, null);

  const foreign = await fetch(`${http.base()}/office/contracts/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: o.cookie, Origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(foreign.status, 403, 'cross-site posts are refused');

  const limited = await officeWithUnits(12, 'مكتب المعاينة الكثيرة');
  const statuses = [];
  for (let i = 0; i < 61; i += 1) statuses.push((await post(body, limited.cookie)).status);
  assert.deepEqual(statuses.slice(0, 60), Array(60).fill(200));
  assert.equal(statuses[60], 429);
});

// ------------------------------------------------------------ payments

test('payments: staff can mark paid / late / waived / due; dates and receipts are checked', { skip }, async () => {
  const o = await officeWithUnits(13, 'مكتب الدفعات');
  const staff = await http.addMember(o.office.id, phone(14), 'office_staff');
  const id = await created(o, { start_date: dates.addMonths(TODAY, -2), end_date: months(dates.addMonths(TODAY, -2), 12) });
  const [rows] = await db.pool.query('SELECT id, due_date, status FROM contract_payments WHERE contract_id = ? ORDER BY due_date', [id]);
  const pay = (paymentId, form, cookie = staff) => http.request(`/office/contracts/${id}/payments/${paymentId}`, { method: 'POST', cookie, form });

  const page = await http.request(`/office/contracts/${id}`, { cookie: staff });
  assert.match(page.text, /badge--pay-late">متأخرة/, 'a past due payment reads as late');

  assert.equal((await pay(rows[0].id, { status: 'paid', paid_on: TODAY, method: 'transfer', receipt_no: 'R-77' })).status, 302);
  const [[paid]] = await db.pool.query('SELECT status, paid_at, method, receipt_no FROM contract_payments WHERE id = ?', [rows[0].id]);
  assert.equal(paid.status, 'paid');
  assert.equal(new Date(paid.paid_at).toISOString().slice(0, 10), TODAY);
  assert.deepEqual([paid.method, paid.receipt_no], ['transfer', 'R-77']);

  assert.equal((await pay(rows[1].id, { status: 'paid', paid_on: dates.addDays(TODAY, 1) })).status, 422, 'not in the future');
  assert.equal((await pay(rows[1].id, { status: 'paid', paid_on: TODAY, receipt_no: 'محمد' })).status, 422, 'no names in receipts');
  assert.equal((await pay(rows[1].id, { status: 'paid', paid_on: TODAY, method: 'gold' })).status, 422);
  assert.equal((await pay(rows[1].id, { status: 'lost' })).status, 422);
  assert.equal((await pay(rows[1].id, { status: 'late' })).status, 302);
  assert.equal((await pay(rows[2].id, { status: 'waived' })).status, 302);
  assert.equal((await pay(rows[0].id, { status: 'due' })).status, 302);
  const [[back]] = await db.pool.query('SELECT status, paid_at, method, receipt_no FROM contract_payments WHERE id = ?', [rows[0].id]);
  assert.deepEqual({ ...back }, { status: 'due', paid_at: null, method: null, receipt_no: null });

  const [events] = await db.pool.query("SELECT details FROM contract_events WHERE contract_id = ? AND event_type = 'payment_status' ORDER BY id", [id]);
  assert.deepEqual(events.map((e) => e.details.to), ['paid', 'late', 'waived', 'due']);

  // A payment of another contract cannot be reached through this one.
  const otherContract = await created({ ...o, unitId: await o.scoped.insert('units', { landlord_id: o.landlordId, label: 'شقة 2', city: 'جدة' }) });
  const [[foreignPayment]] = await db.pool.query('SELECT id FROM contract_payments WHERE contract_id = ? LIMIT 1', [otherContract]);
  assert.equal((await pay(foreignPayment.id, { status: 'waived' })).status, 404);

  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord')", [phone(15)]);
  const landlordCookie = (await http.login(phone(15))).cookie;
  assert.equal((await pay(rows[3].id, { status: 'paid', paid_on: TODAY }, landlordCookie)).status, 403);
});

// ------------------------------------------------------------ terminate

test('terminate: owner and manager only; invites revoked, future payments waived, unit freed', { skip }, async () => {
  const o = await officeWithUnits(16, 'مكتب الإنهاء');
  const staff = await http.addMember(o.office.id, phone(17), 'office_staff');
  const manager = await http.addMember(o.office.id, phone(18), 'office_manager');
  const id = await created(o, { start_date: dates.addMonths(TODAY, -2), end_date: months(dates.addMonths(TODAY, -2), 12) });
  const url = `/office/contracts/${id}/terminate`;

  assert.equal((await http.request(url, { cookie: staff })).status, 403);
  assert.equal((await http.request(url, { method: 'POST', cookie: staff, form: { reason: 'سبب', confirm: '1' } })).status, 403);
  assert.ok(!(await http.request(`/office/contracts/${id}`, { cookie: staff })).text.includes(url), 'no terminate button for staff');

  const confirmPage = await http.request(url, { cookie: manager });
  assert.equal(confirmPage.status, 200);
  assert.match(confirmPage.text, /لا تكتب أسماء أو أرقام هوية/);
  assert.equal((await http.request(url, { method: 'POST', cookie: manager, form: { reason: '' , confirm: '1' } })).status, 422);
  assert.equal((await http.request(url, { method: 'POST', cookie: manager, form: { reason: 'إخلاء-سري' } })).status, 422, 'confirmation needed');

  const done = await http.request(url, { method: 'POST', cookie: manager, form: { reason: 'إخلاء-سري مبكر', confirm: '1' } });
  assert.equal(done.location, `/office/contracts/${id}?done=terminated`);
  const [[c]] = await db.pool.query('SELECT status, terminated_at, terminated_reason FROM contracts WHERE id = ?', [id]);
  assert.equal(c.status, 'terminated');
  assert.ok(c.terminated_at);
  assert.equal(c.terminated_reason, 'إخلاء-سري مبكر');
  assert.equal(await count("SELECT COUNT(*) FROM invites WHERE contract_id = ? AND revoked_at IS NULL AND used_at IS NULL", [id]), 0);
  const [payments] = await db.pool.query('SELECT due_date, status, note FROM contract_payments WHERE contract_id = ? ORDER BY due_date', [id]);
  for (const p of payments) {
    if (p.due_date > TODAY) assert.deepEqual([p.status, p.note], ['waived', 'تم الإنهاء'], p.due_date);
    else assert.equal(p.status, 'due', `past payment ${p.due_date} is still owed`);
  }
  assert.equal(await unitStatusOf(o.unitId), 'vacant');
  const [audit] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'contract.terminate' AND entity_id = ?", [id]);
  assert.ok(!JSON.stringify(audit).includes('إخلاء'), 'no reason text in audit');
  assert.equal((await http.request(url, { method: 'POST', cookie: o.cookie, form: { reason: 'مرة ثانية', confirm: '1' } })).status, 409);
});

// ------------------------------------------------------------ renew

test('renew: next term from the engine, Riyadh freeze blocks an increase, old contract becomes renewed', { skip }, async () => {
  const o = await officeWithUnits(19, 'مكتب التجديد', { city: 'الرياض' });
  const id = await created(o, { city: 'الرياض' });
  const [[old]] = await db.pool.query('SELECT * FROM contracts WHERE id = ?', [id]);
  const next = engine.nextTerm(old);

  const form = await http.request(`/office/contracts/${id}/renew`, { cookie: o.cookie });
  assert.match(form.text, new RegExp(next.start_date));
  assert.match(form.text, /الإيجار مجمّد في الرياض/);

  const higher = await http.request(`/office/contracts/${id}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '40000', payment_frequency: 'monthly' } });
  assert.equal(higher.status, 422);
  assert.match(higher.text, /لا يمكن رفعه/);
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE unit_id = ?', [o.unitId]), 1);

  const renewed = await http.request(`/office/contracts/${id}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '30000', payment_frequency: 'quarterly' } });
  assert.equal(renewed.status, 302, 'a reduction is allowed');
  const newId = idFrom(renewed.location);
  const [[fresh]] = await db.pool.query('SELECT * FROM contracts WHERE id = ?', [newId]);
  assert.deepEqual([fresh.start_date, fresh.end_date], [next.start_date, next.end_date]);
  assert.equal(fresh.renewed_from_id, id);
  assert.equal(fresh.annual_rent, '30000.00');
  assert.equal(fresh.source, 'manual');
  assert.equal(sumHalalas((await db.pool.query('SELECT amount FROM contract_payments WHERE contract_id = ?', [newId]))[0]), 3000000);
  assert.equal(await count("SELECT COUNT(*) FROM invites WHERE contract_id = ?", [newId]), 0, 'no new tenant invite');
  const [[after]] = await db.pool.query('SELECT status, renewed_at, renewed_to_id FROM contracts WHERE id = ?', [id]);
  assert.equal(after.status, 'renewed');
  assert.ok(after.renewed_at);
  assert.equal(after.renewed_to_id, newId);
  assert.equal(await unitStatusOf(o.unitId), 'rented');

  assert.equal((await http.request(`/office/contracts/${id}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '30000', payment_frequency: 'monthly' } })).status, 409, 'cannot renew twice');

  // Outside Riyadh an increase is fine; a terminated contract cannot be renewed.
  const j = await officeWithUnits(20, 'مكتب جدة', { unitCount: 2 });
  const jid = await created(j);
  assert.equal((await http.request(`/office/contracts/${jid}/renew`, { method: 'POST', cookie: j.cookie, form: { annual_rent: '40000', payment_frequency: 'monthly' } })).status, 302);
  const tid = await created({ ...j, unitId: j.unitIds[1] });
  await http.request(`/office/contracts/${tid}/terminate`, { method: 'POST', cookie: j.cookie, form: { reason: 'سبب الإنهاء', confirm: '1' } });
  assert.equal((await http.request(`/office/contracts/${tid}/renew`, { method: 'POST', cookie: j.cookie, form: { annual_rent: '36000', payment_frequency: 'monthly' } })).status, 409);
});

// ------------------------------------------------------------ delete and edit

test('delete: owner only, never with a paid payment or for history; deleting a renewal restores the old contract', { skip }, async () => {
  const o = await officeWithUnits(21, 'مكتب الحذف', { unitCount: 3 });
  const staff = await http.addMember(o.office.id, phone(22), 'office_staff');
  const plain = await created(o);
  assert.equal((await http.request(`/office/contracts/${plain}/delete`, { method: 'POST', cookie: staff })).status, 403);

  const [[firstPayment]] = await db.pool.query('SELECT id FROM contract_payments WHERE contract_id = ? ORDER BY due_date LIMIT 1', [plain]);
  await http.request(`/office/contracts/${plain}/payments/${firstPayment.id}`, { method: 'POST', cookie: o.cookie, form: { status: 'paid', paid_on: TODAY } });
  const withPaid = await http.request(`/office/contracts/${plain}/delete`, { method: 'POST', cookie: o.cookie });
  assert.equal(withPaid.status, 409);
  assert.match(withPaid.text, /أنهِ العقد بدلاً من حذفه/);

  await http.request(`/office/contracts/${plain}/payments/${firstPayment.id}`, { method: 'POST', cookie: o.cookie, form: { status: 'due' } });
  assert.equal((await http.request(`/office/contracts/${plain}/delete`, { method: 'POST', cookie: o.cookie })).location, '/office/contracts?done=deleted');
  assert.equal(await count('SELECT COUNT(*) FROM contracts WHERE id = ?', [plain]), 0);
  assert.equal(await count('SELECT COUNT(*) FROM contract_payments WHERE contract_id = ?', [plain]), 0);
  assert.equal(await unitStatusOf(o.unitId), 'vacant', 'unit freed');

  const ended = await created({ ...o, unitId: o.unitIds[1] }, { start_date: dates.addMonths(TODAY, -36), end_date: months(dates.addMonths(TODAY, -36), 12), ack_warnings: '1' });
  const history = await http.request(`/office/contracts/${ended}/delete`, { method: 'POST', cookie: o.cookie });
  assert.equal(history.status, 409);
  assert.match(history.text, /يبقى للسجل/);

  const first = await created({ ...o, unitId: o.unitIds[2] });
  const renewal = idFrom((await http.request(`/office/contracts/${first}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '36000', payment_frequency: 'monthly' } })).location);
  assert.equal((await http.request(`/office/contracts/${first}/delete`, { method: 'POST', cookie: o.cookie })).status, 409, 'a renewed contract is history');
  assert.equal((await http.request(`/office/contracts/${renewal}/delete`, { method: 'POST', cookie: o.cookie })).status, 302);
  const [[restored]] = await db.pool.query('SELECT status, renewed_at, renewed_to_id FROM contracts WHERE id = ?', [first]);
  assert.equal(restored.status, engine.classifyContract({ start_date: TODAY, end_date: months(TODAY, 12) }, TODAY));
  assert.deepEqual([restored.renewed_at, restored.renewed_to_id], [null, null]);
  assert.equal(await unitStatusOf(o.unitIds[2]), 'rented', 'the restored contract still occupies the unit');
});

test('edit changes only the allowed fields', { skip }, async () => {
  const o = await officeWithUnits(23, 'مكتب التعديل');
  const id = await created(o);
  const page = await http.request(`/office/contracts/${id}/edit`, { cookie: o.cookie });
  assert.match(page.text, /لا يمكن تغيير التواريخ أو الإيجار أو الوحدة أو المالك بعد الحفظ/);
  for (const name of ['start_date', 'end_date', 'annual_rent', 'unit_id', 'landlord_id']) assert.ok(!page.text.includes(`name="${name}"`), name);

  const res = await http.request(`/office/contracts/${id}/edit`, {
    method: 'POST', cookie: o.cookie,
    form: { tenant_label: 'مستأجر-جديد', contract_number: 'EJ-2', deposit: '1500', commission: '', start_date: '2020-01-01', annual_rent: '1', unit_id: '1' },
  });
  assert.equal(res.location, `/office/contracts/${id}?done=saved`);
  const [[c]] = await db.pool.query('SELECT tenant_label, contract_number, deposit, commission, auto_renew, start_date, annual_rent, unit_id FROM contracts WHERE id = ?', [id]);
  assert.deepEqual({ ...c }, {
    tenant_label: 'مستأجر-جديد', contract_number: 'EJ-2', deposit: '1500.00', commission: null, auto_renew: 0,
    start_date: TODAY, annual_rent: '36000.00', unit_id: o.unitId,
  });
  const [[audit]] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'contract.update' AND entity_id = ?", [id]);
  assert.ok(!JSON.stringify(audit).includes('مستأجر-جديد'), 'no tenant label in audit');
});

// ------------------------------------------------------------ recompute

test('recomputeStatuses: stages, ended frees the unit, started rents it, late payments; idempotent and per office', { skip }, async () => {
  const o = await officeWithUnits(24, 'مكتب الحساب', { unitCount: 3 });
  const other = await officeWithUnits(25, 'مكتب لا يتأثر');
  // A contract that ended yesterday but is stored as calm, its unit still rented.
  const endedStart = dates.addMonths(TODAY, -12);
  const endedId = await o.scoped.insert('contracts', {
    landlord_id: o.landlordId, unit_id: o.unitIds[0], start_date: endedStart, end_date: dates.addDays(TODAY, -1),
    annual_rent: 1000, status: 'calm',
  });
  await db.pool.query("UPDATE units SET status = 'rented' WHERE id = ?", [o.unitIds[0]]);
  // A contract that started today; its unit still vacant.
  const startedId = await o.scoped.insert('contracts', {
    landlord_id: o.landlordId, unit_id: o.unitIds[1], start_date: TODAY, end_date: months(TODAY, 12), annual_rent: 1000, status: 'calm',
  });
  // A payment due yesterday, still 'due'.
  await o.scoped.insert('contract_payments', { contract_id: startedId, due_date: dates.addDays(TODAY, -1), amount: 100, status: 'due' });
  // The same staleness in another office must not be touched.
  const otherId = await other.scoped.insert('contracts', {
    landlord_id: other.landlordId, unit_id: other.unitId, start_date: endedStart, end_date: dates.addDays(TODAY, -1), annual_rent: 1000, status: 'calm',
  });

  const first = await contractStatus.recomputeStatuses({ pool: db.pool, today: TODAY, officeId: o.office.id });
  assert.equal(first.checked, 2);
  assert.equal(first.changed, 1);
  assert.deepEqual(first.byStage, { ended: 1, calm: 1 });
  assert.equal(first.unitsVacated, 1);
  assert.equal(first.unitsRented, 1);
  assert.equal(first.paymentsLate, 1);
  assert.equal(first.deadlinesFixed, 2, 'rows inserted without deadlines get them from the engine');
  const [[fixed]] = await db.pool.query('SELECT notice_deadline FROM contracts WHERE id = ?', [startedId]);
  assert.equal(fixed.notice_deadline, engine.noticeDeadline(months(TODAY, 12)));
  assert.equal((await db.pool.query('SELECT status FROM contracts WHERE id = ?', [endedId]))[0][0].status, 'ended');
  assert.equal(await unitStatusOf(o.unitIds[0]), 'vacant');
  assert.equal(await unitStatusOf(o.unitIds[1]), 'rented');
  assert.equal(await count("SELECT COUNT(*) FROM contract_payments WHERE contract_id = ? AND status = 'late'", [startedId]), 1);
  assert.equal((await db.pool.query('SELECT status FROM contracts WHERE id = ?', [otherId]))[0][0].status, 'calm', 'other office untouched');

  const second = await contractStatus.recomputeStatuses({ pool: db.pool, today: TODAY, officeId: o.office.id });
  assert.deepEqual([second.changed, second.unitsVacated, second.unitsRented, second.paymentsLate, second.deadlinesFixed], [0, 0, 0, 0, 0], 'idempotent');

  // maybeRecompute: runs once an hour per office.
  const now = new Date();
  assert.ok(await contractStatus.maybeRecompute({ pool: db.pool, officeId: other.office.id, now, today: TODAY }));
  assert.equal((await db.pool.query('SELECT status FROM contracts WHERE id = ?', [otherId]))[0][0].status, 'ended');
  assert.equal(await contractStatus.maybeRecompute({ pool: db.pool, officeId: other.office.id, now, today: TODAY }), null, 'skipped within the hour');
  const later = dates.hoursAfter(now, 2);
  assert.ok(await contractStatus.maybeRecompute({ pool: db.pool, officeId: other.office.id, now: later, today: TODAY }), 'runs again after an hour');
});

// ------------------------------------------------------------ isolation

test('office B gets 404 on every contract route with office A\'s ids', { skip }, async () => {
  const a = await officeWithUnits(26, 'مكتب أ');
  const b = await officeWithUnits(27, 'مكتب ب');
  const id = await created(a);
  const [[payment]] = await db.pool.query('SELECT id FROM contract_payments WHERE contract_id = ? LIMIT 1', [id]);
  const bContract = await created(b);

  for (const path of [`/office/contracts/${id}`, `/office/contracts/${id}/edit`, `/office/contracts/${id}/terminate`, `/office/contracts/${id}/renew`, '/office/contracts/abc']) {
    assert.equal((await http.request(path, { cookie: b.cookie })).status, 404, path);
  }
  const posts = [
    [`/office/contracts/${id}/edit`, { tenant_label: 'اختراق' }],
    [`/office/contracts/${id}/payments/${payment.id}`, { status: 'waived' }],
    [`/office/contracts/${bContract}/payments/${payment.id}`, { status: 'waived' }],
    [`/office/contracts/${id}/terminate`, { reason: 'اختراق', confirm: '1' }],
    [`/office/contracts/${id}/renew`, { annual_rent: '1', payment_frequency: 'monthly' }],
    [`/office/contracts/${id}/delete`, {}],
    [`/office/contracts/${id}/invite`, {}],
    [`/office/contracts/${id}/invite/revoke`, {}],
  ];
  for (const [path, form] of posts) assert.equal((await http.request(path, { method: 'POST', cookie: b.cookie, form })).status, 404, `POST ${path}`);

  const [[c]] = await db.pool.query('SELECT status, tenant_label FROM contracts WHERE id = ?', [id]);
  assert.deepEqual({ ...c }, { status: engine.classifyContract({ start_date: TODAY, end_date: months(TODAY, 12) }, TODAY), tenant_label: 'مستأجر-سري' });
  assert.equal((await db.pool.query('SELECT status FROM contract_payments WHERE id = ?', [payment.id]))[0][0].status, 'due');
  assert.equal(await count("SELECT COUNT(*) FROM invites WHERE contract_id = ? AND revoked_at IS NULL", [id]), 1);
  const list = await http.request('/office/contracts?q=EJ', { cookie: b.cookie });
  assert.ok(!list.text.includes(`/office/contracts/${id}"`));
  assert.equal((await createVia(b, { landlord_id: String(a.landlordId), unit_id: String(a.unitId) })).status, 404);
});

// ------------------------------------------------------------ dashboard and pages

test('dashboard numbers, needs-action board, checklist, landlord and unit pages', { skip }, async () => {
  const o = await officeWithUnits(28, 'مكتب اللوحة', { unitCount: 3 });
  const emptyHome = await http.request('/office', { cookie: o.cookie });
  assert.match(emptyHome.text, /لا يوجد ما يحتاج إجراءً الآن/);

  // Urgent: decision deadline in 3 days -> end = today + 63 days, start one year earlier, whole months.
  const urgentEnd = dates.addDays(TODAY, 63);
  const urgentStart = dates.addDays(dates.addMonths(urgentEnd, -12), 1);
  const urgentId = await created(o, { start_date: urgentStart, end_date: urgentEnd, ack_warnings: '1' });
  const calmId = await created({ ...o, unitId: o.unitIds[1] });

  const home = await http.request('/office', { cookie: o.cookie });
  const stat = (label) => Number(new RegExp(`stat__value">(\\d+)</p>\\s*<p class="stat__label">${label}`).exec(home.text)[1]);
  assert.equal(stat('عقود سارية'), 2);
  assert.equal(stat('موعد القرار خلال 90 يوماً'), 1);
  assert.equal(stat('وحدات شاغرة'), 1);
  assert.ok(stat('دفعات متأخرة') >= 1, 'the urgent contract started a year ago and has past due payments');
  assert.match(home.text, /<a href="\/office\/contracts" class="is-done">/);
  const board = home.text.slice(home.text.indexOf('class="board"'), home.text.indexOf('عرض كل العقود التي تحتاج إجراء'));
  assert.ok(board.includes(`/office/contracts/${urgentId}`));
  assert.ok(!board.includes(`/office/contracts/${calmId}`), 'calm contracts are not on the board');
  assert.match(board, /باقي 3 يوم على موعد القرار/);
  assert.match(board, /badge--stage-urgent/);

  const action = await http.request('/office/contracts?stage=action', { cookie: o.cookie });
  assert.ok(action.text.includes(`/office/contracts/${urgentId}"`) && !action.text.includes(`/office/contracts/${calmId}"`));
  const ends = await http.request('/office/contracts?ends=90', { cookie: o.cookie });
  assert.ok(ends.text.includes(`/office/contracts/${urgentId}"`) && !ends.text.includes(`/office/contracts/${calmId}"`));

  const landlordPage = await http.request(`/office/landlords/${o.landlordId}`, { cookie: o.cookie });
  assert.match(landlordPage.text, /العقود \(2\)/);
  const unitPage = await http.request(`/office/units/${o.unitId}`, { cookie: o.cookie });
  assert.match(unitPage.text, /العقود \(1\)/);
  assert.ok(unitPage.text.includes(`/office/contracts/${urgentId}`));
});
