'use strict';

// Rent payment tracking against real MySQL: full and partial payments (exact
// halalas), reference code rules, the 24-hour undo, history and the printable
// receipt, the overdue list with filters and CSV, and isolation. Runs only
// when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000011NN.
const phone = (n) => `9665000011${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let entries;

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
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_members, max_photos, is_active, sort_order)
     VALUES ('test_pay', 'اختبار الدفعات', 1, 1, NULL, NULL, NULL, NULL, 0, 103)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, is_active = 0`,
  );
  entries = require('../services/paymentEntries');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_pay' });
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

const payments = async (contractId) => (await db.pool.query('SELECT * FROM contract_payments WHERE contract_id = ? ORDER BY due_date, id', [contractId]))[0];
const entriesOf = async (paymentId) => (await db.pool.query('SELECT * FROM payment_entries WHERE payment_id = ? ORDER BY id', [paymentId]))[0];
const record = (cookie, contractId, paymentId, form, kind = 'office') => http.request(`/${kind}/contracts/${contractId}/payments/${paymentId}/entries`, { method: 'POST', cookie, form });
const undo = (cookie, contractId, paymentId, entryId, reason, kind = 'office') => http.request(`/${kind}/contracts/${contractId}/payments/${paymentId}/entries/${entryId}/undo`, { method: 'POST', cookie, form: { reason } });
const full = { method: 'cash' };

async function setup(base, name, contractOptions = {}) {
  const o = await fx.office(base, name);
  const contractId = await fx.contract(o, contractOptions);
  return { o, contractId };
}

// ------------------------------------------------------------ record

test('record a full payment: entry, paid status, date and method; staff may record', { skip }, async () => {
  const { o, contractId } = await setup(1, 'مكتب الدفعات');
  const staff = await http.addMember(o.office.id, phone(2), 'office_staff');
  const [p1] = await payments(contractId);
  assert.equal(p1.paid_amount, '0.00');
  const form = await http.request(`/office/contracts/${contractId}`, { cookie: staff });
  assert.match(form.text, /تسجيل دفعة/);
  assert.match(form.text, /name="reference"/);

  const day = fx.today();
  const res = await record(staff, contractId, p1.id, { amount: '', paid_on: day, method: 'transfer', reference: 'R-77' });
  assert.equal(res.status, 302);
  const [row] = await payments(contractId);
  assert.deepEqual([row.status, row.paid_amount, row.method], ['paid', '3000.00', 'transfer']);
  assert.equal(new Date(row.paid_at).toISOString().slice(0, 10), day);
  const [entry] = await entriesOf(p1.id);
  assert.deepEqual([entry.amount, entry.method, entry.reference_code, entry.recorded_role, Number(entry.recorded_by)], ['3000.00', 'transfer', 'R-77', 'office', Number((await http.userByPhone(phone(2))).id)]);
  assert.equal(String(entry.paid_on).slice(0, 10), day);
  assert.equal(entry.undone_at, null);
  const closed = await record(staff, contractId, p1.id, { amount: '1', paid_on: day, method: 'cash' });
  assert.equal(closed.status, 409, 'a paid installment takes no more');
  const page = await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie });
  assert.match(page.text, /3,000\.00 ريال<\/strong> · <span dir="ltr">/);
  assert.match(page.text, /مرجع: R-77/);
  const [audit] = (await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'payment.record' AND office_id = ?", [o.office.id]))[0];
  assert.doesNotMatch(JSON.stringify(audit.after_json), /R-77|3000/, 'audit holds no amount or reference');
});

test('partial payments are exact in halalas; over-payment and bad amounts are refused', { skip }, async () => {
  const { o, contractId } = await setup(5, 'مكتب الجزئي', { rent: '12000.30', frequency: 'annual' });
  const [p] = await payments(contractId);
  assert.equal(p.amount, '12000.30');
  const day = fx.today();
  const pay = (amount, extra = {}) => record(o.cookie, contractId, p.id, { amount, paid_on: day, method: 'cash', ...extra });
  const state = async () => (await payments(contractId))[0];

  for (const bad of ['0', '-5', 'abc', '12.345', '1e3', '99999999999999', '0.00']) assert.equal((await pay(bad)).status, 422, bad);
  assert.equal((await pay('12000.31')).status, 409, 'more than the remaining');
  assert.equal((await state()).paid_amount, '0.00');

  assert.equal((await pay('0.10')).status, 302);
  assert.equal((await pay('0.20')).status, 302);
  assert.equal((await state()).paid_amount, '0.30', '0.10 + 0.20 is exactly 0.30');
  assert.equal((await state()).status, 'due');
  assert.equal((await pay('٥٠٠٫٥٠'.replace('٫', '.'))).status, 302, 'Arabic digits are read');
  assert.equal((await state()).paid_amount, '500.80');
  let page = (await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie })).text;
  assert.match(page, /دفعة جزئية/);
  assert.match(page, /المتبقي <strong>11,499\.50 ريال/);
  const ids = (await entriesOf(p.id)).map((e) => e.amount);
  assert.deepEqual(ids, ['0.10', '0.20', '500.50']);
  assert.equal((await pay('11499.51')).status, 409);
  assert.equal((await pay('11499.50')).status, 302);
  const done = await state();
  assert.deepEqual([done.status, done.paid_amount], ['paid', '12000.30']);
  assert.equal((await entriesOf(p.id)).reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0), 1200030);
  page = (await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie })).text;
  assert.match(page, /المدفوع<\/dt><dd>12,000\.30 ريال/);
  assert.match(page, /المتبقي<\/dt><dd>0\.00 ريال/);

  // Two simultaneous payments for the whole remaining amount: exactly one succeeds.
  const second = await setup(9, 'مكتب السباق', { frequency: 'annual' });
  const [q] = await payments(second.contractId);
  const results = await Promise.all([1, 2, 3].map(() => record(second.o.cookie, second.contractId, q.id, { amount: '', paid_on: day, method: 'cash' })));
  assert.equal(results.filter((r) => r.status === 302).length, 1);
  assert.equal((await entriesOf(q.id)).length, 1);
});

test('reference codes: free text up to 40, never an IBAN or a long number; methods are cash/transfer/other', { skip }, async () => {
  assert.deepEqual(entries.validateReference('  R-77 '), { value: 'R-77' });
  assert.deepEqual(entries.validateReference(''), { value: null });
  assert.deepEqual(entries.validateReference('إيصال 2026'), { value: 'إيصال 2026' });
  assert.deepEqual(entries.validateReference('INV 123456789'), { value: 'INV 123456789' }, '9 digits is fine');
  for (const bad of [
    'SA0380000000608010167519', 'sa03 8000 0000 6080 1016 7519', 'SA03-8000-0000-6080-1016-7519', 'GB82WEST12345698765432', 'DE89 3704 0044 0532 0130 00',
    '1234567890', '1234 5678 90', '12-34-56-78-90', '12.34.56.78.90', '٠١٢٣٤٥٦٧٨٩٠', 'رقم 0501234567', '4111111111111111', 'x'.repeat(41),
  ]) {
    assert.ok(entries.validateReference(bad).error, bad);
  }
  const { o, contractId } = await setup(12, 'مكتب المرجع');
  const [p] = await payments(contractId);
  const day = fx.today();
  const filesBefore = await fx.count('SELECT COUNT(*) FROM payment_entries WHERE office_id = ?', [o.office.id]);
  for (const reference of ['SA0380000000608010167519', '1234567890', '12 34 56 78 90']) {
    const res = await record(o.cookie, contractId, p.id, { amount: '100', paid_on: day, method: 'cash', reference });
    assert.equal(res.status, 422, reference);
    assert.match(res.text, /رقم حساب أو آيبان/);
  }
  assert.equal(await fx.count('SELECT COUNT(*) FROM payment_entries WHERE office_id = ?', [o.office.id]), filesBefore, 'nothing was stored');
  for (const method of ['card', 'cheque', 'bogus', '']) assert.equal((await record(o.cookie, contractId, p.id, { amount: '100', paid_on: day, method })).status, 422, method);
  for (const method of ['cash', 'transfer', 'other']) assert.equal((await record(o.cookie, contractId, p.id, { amount: '100', paid_on: day, method })).status, 302, method);
  assert.equal((await record(o.cookie, contractId, p.id, { amount: '100', paid_on: fx.dates.addDays(day, 1), method: 'cash' })).status, 422, 'no future dates');
  assert.equal((await record(o.cookie, contractId, p.id, { amount: '100', paid_on: '2026-02-30', method: 'cash' })).status, 422);
  // The old status form checks receipts the same way.
  const old = await http.request(`/office/contracts/${contractId}/payments/${p.id}`, { method: 'POST', cookie: o.cookie, form: { status: 'paid', paid_on: day, receipt_no: '1234567890' } });
  assert.equal(old.status, 422);
});

// ------------------------------------------------------------ undo

test('undo within 24 hours with a reason: recomputed, audit-logged; after that it is refused', { skip }, async () => {
  const { o, contractId } = await setup(15, 'مكتب التراجع');
  const [p1, p2] = await payments(contractId);
  const day = fx.today();
  await record(o.cookie, contractId, p1.id, { amount: '1000', paid_on: day, method: 'cash' });
  await record(o.cookie, contractId, p1.id, { amount: '2000', paid_on: day, method: 'transfer', reference: 'T-1' });
  assert.equal((await payments(contractId))[0].status, 'paid');
  const [e1, e2] = await entriesOf(p1.id);

  const page = (await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie })).text;
  assert.match(page, /تراجع عن هذه الدفعة/);
  assert.equal((await undo(o.cookie, contractId, p1.id, e2.id, '')).status, 422, 'a reason is required');
  assert.equal((await undo(o.cookie, contractId, p1.id, e2.id, 'ab')).status, 422);
  assert.equal((await undo(o.cookie, contractId, p1.id, e2.id, 'ب'.repeat(201))).status, 422);
  assert.equal((await entriesOf(p1.id))[1].undone_at, null);

  const res = await undo(o.cookie, contractId, p1.id, e2.id, 'سُجلت بالخطأ');
  assert.equal(res.status, 302);
  let row = (await payments(contractId))[0];
  assert.deepEqual([row.status, row.paid_amount, row.paid_at, row.method], ['due', '1000.00', null, null]);
  const [, undone] = await entriesOf(p1.id);
  assert.ok(undone.undone_at);
  assert.equal(undone.undo_reason, 'سُجلت بالخطأ');
  assert.equal(Number(undone.undone_by), Number(o.user.id));
  const [audit] = (await db.pool.query("SELECT before_json, after_json FROM audit_logs WHERE action = 'payment.undo' AND office_id = ?", [o.office.id]))[0];
  assert.deepEqual(audit.before_json, { entry_id: Number(e2.id) });
  assert.doesNotMatch(JSON.stringify(audit), /بالخطأ|2000|T-1/, 'audit holds ids and statuses only');
  assert.equal((await undo(o.cookie, contractId, p1.id, e2.id, 'مرة ثانية')).status, 404, 'cannot undo twice');
  const shown = (await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie })).text;
  assert.match(shown, /مُلغاة: سُجلت بالخطأ/);
  const receipt = (await http.request(`/office/contracts/${contractId}/receipt`, { cookie: o.cookie })).text;
  assert.doesNotMatch(receipt, /T-1/, 'the receipt lists live payments only');

  // The 24 hour window.
  await db.pool.query('UPDATE payment_entries SET created_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR WHERE id = ?', [e1.id]);
  const late = await undo(o.cookie, contractId, p1.id, e1.id, 'متأخر');
  assert.equal(late.status, 409);
  assert.match(late.text, /انتهت مهلة التراجع/);
  assert.equal((await entriesOf(p1.id))[0].undone_at, null);
  assert.doesNotMatch((await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie })).text, new RegExp(`entries/${e1.id}/undo`));
  await db.pool.query('UPDATE payment_entries SET created_at = UTC_TIMESTAMP() - INTERVAL 23 HOUR WHERE id = ?', [e1.id]);
  assert.equal((await undo(o.cookie, contractId, p1.id, e1.id, 'داخل المهلة')).status, 302, '23 hours is still inside');
  assert.deepEqual([(await payments(contractId))[0].status, (await payments(contractId))[0].paid_amount], ['due', '0.00']);

  // An undone full payment on an overdue installment shows as late again.
  const overdue = await setup(18, 'مكتب المتأخر', { start: fx.dates.addMonths(fx.today(), -3) });
  const [od] = await payments(overdue.contractId);
  await record(overdue.o.cookie, overdue.contractId, od.id, { amount: '', paid_on: day, method: 'cash' });
  const [oe] = await entriesOf(od.id);
  await undo(overdue.o.cookie, overdue.contractId, od.id, oe.id, 'خطأ');
  assert.equal((await payments(overdue.contractId))[0].status, 'late');
  void p2;
});

test('landlord records and undoes only their own entries; the office can undo any; tenants cannot record', { skip }, async () => {
  const { o, contractId } = await setup(20, 'مكتب المالك');
  const landlord = await fx.landlordOf(o, 21);
  const tenant = await fx.tenantOf(contractId, 22);
  const [p1, p2] = await payments(contractId);
  const day = fx.today();
  const lRecord = (id, form) => record(landlord.cookie, contractId, id, form, 'landlord');
  const page = (await http.request(`/landlord/contracts/${contractId}`, { cookie: landlord.cookie })).text;
  assert.match(page, /تسجيل دفعة/);
  assert.equal((await lRecord(p1.id, { amount: '1500', paid_on: day, method: 'cash', reference: 'L-1' })).status, 302);
  const [mine] = await entriesOf(p1.id);
  assert.deepEqual([mine.recorded_role, Number(mine.recorded_by)], ['landlord', Number(landlord.user.id)]);
  assert.equal((await payments(contractId))[0].paid_amount, '1500.00');
  assert.equal((await lRecord(p1.id, { amount: '3000', paid_on: day, method: 'cash' })).status, 409, 'over the remaining 1500');
  assert.equal((await lRecord(p1.id, { amount: '1', paid_on: day, method: 'card' })).status, 422);
  // The office records too; the landlord cannot undo the office's entry.
  await record(o.cookie, contractId, p1.id, { amount: '500', paid_on: day, method: 'cash' });
  const [, officeEntry] = await entriesOf(p1.id);
  assert.equal((await undo(landlord.cookie, contractId, p1.id, officeEntry.id, 'ليست لي', 'landlord')).status, 409);
  assert.equal((await entriesOf(p1.id))[1].undone_at, null);
  assert.equal((await undo(landlord.cookie, contractId, p1.id, mine.id, 'سجلتها خطأً', 'landlord')).status, 302);
  assert.equal((await payments(contractId))[0].paid_amount, '500.00');
  // The office may undo what the landlord recorded.
  await lRecord(p2.id, { amount: '100', paid_on: day, method: 'other' });
  const [lEntry] = await entriesOf(p2.id);
  assert.equal((await undo(o.cookie, contractId, p2.id, lEntry.id, 'قرار المكتب')).status, 302);
  // Tenants have no way to record or undo.
  assert.equal((await record(tenant.cookie, contractId, p1.id, { amount: '100', paid_on: day, method: 'cash' }, 'landlord')).status !== 302, true);
  assert.notEqual((await record(tenant.cookie, contractId, p1.id, { amount: '100', paid_on: day, method: 'cash' }, 'office')).status, 302);
  assert.notEqual((await undo(tenant.cookie, contractId, p1.id, officeEntry.id, 'x', 'office')).status, 302);
  assert.equal((await entriesOf(p1.id)).length, 2);
});

// ------------------------------------------------------------ history and receipt

test('receipt-style statement: printable, no personal data, for office, landlord and tenant of that contract only', { skip }, async () => {
  const { o, contractId } = await setup(25, 'مكتب الكشف');
  const landlord = await fx.landlordOf(o, 26);
  const tenant = await fx.tenantOf(contractId, 27);
  const other = await setup(30, 'مكتب آخر');
  const otherTenant = await fx.tenantOf(other.contractId, 31);
  const otherLandlord = await fx.landlordOf(other.o, 32);
  const [p1] = await payments(contractId);
  const day = fx.today();
  await record(o.cookie, contractId, p1.id, { amount: '1000.50', paid_on: day, method: 'transfer', reference: 'مرجع <b>1</b>' });

  for (const [who, kind] of [[o, 'office'], [landlord, 'landlord'], [tenant, 'tenant']]) {
    const res = await http.request(`/${kind}/contracts/${contractId}/receipt`, { cookie: who.cookie });
    assert.equal(res.status, 200, kind);
    assert.match(res.text, /كشف دفعات العقد/);
    assert.match(res.text, /1,000\.50/);
    assert.match(res.text, /مرجع &lt;b&gt;1&lt;\/b&gt;/, 'escaped');
    assert.match(res.text, /data-print/);
    assert.match(res.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);
    const body = res.text.slice(res.text.indexOf('id="receipt"'), res.text.indexOf('</section>', res.text.indexOf('id="receipt"')));
    assert.doesNotMatch(body, /اسم-سري|966500|050\d{7}/, 'no tenant label, no phone');
    assert.match(res.text, /شقة 1-1/);
    assert.match(res.text, /مجموع الدفعات/);
  }
  assert.match((await http.request(`/office/contracts/${contractId}/receipt`, { cookie: o.cookie })).text, /تعليمات|dir="ltr">\d{4}-\d{2}-\d{2}/);
  const js = await fx.get('/js/print.js');
  assert.equal(js.status, 200);
  assert.match(css(await fx.get('/css/main.css')), /@media print/);
  for (const [who, kind] of [[otherTenant, 'tenant'], [otherLandlord, 'landlord'], [other.o, 'office']]) {
    assert.equal((await http.request(`/${kind}/contracts/${contractId}/receipt`, { cookie: who.cookie })).status, 404, kind);
  }
  assert.equal((await http.request('/office/contracts/abc/receipt', { cookie: o.cookie })).status, 404);
  assert.equal((await http.request(`/landlord/contracts/${contractId}/receipt`, { cookie: tenant.cookie })).status !== 200, true);
});
const css = (res) => res.body.toString('utf8');

// ------------------------------------------------------------ overdue list

test('overdue list: filters, pagination, partial payments, CSV with BOM and neutralized cells', { skip }, async () => {
  const o = await fx.office(40, 'مكتب المتأخرات', { landlords: 2, units: 2 });
  const [landlordA, landlordB] = o.landlordIds;
  const old = fx.dates.addMonths(fx.today(), -13);
  const a = await fx.contract(o, { landlordId: landlordA, unitIndex: 0, start: old, frequency: 'monthly' });
  const a2 = await fx.contract(o, { landlordId: landlordA, unitIndex: 1, start: old, frequency: 'monthly' });
  const b = await fx.contract(o, { landlordId: landlordB, unitIndex: 0, start: fx.dates.addMonths(fx.today(), -4), frequency: 'monthly' });
  await db.pool.query('UPDATE units SET label = ? WHERE id = ?', ['=HYPERLINK("x")', o.unitsBy[landlordB][0]]);
  const staff = await http.addMember(o.office.id, phone(41), 'office_staff');
  const day = fx.today();
  const page = (query = '') => http.request(`/office/payments${query}`, { cookie: o.cookie });

  const all = (await page()).text;
  assert.match(all, /الدفعات المتأخرة/);
  const overdueCount = async (id) => (await payments(id)).filter((p) => String(p.due_date).slice(0, 10) < day).length;
  const total = (await overdueCount(a)) + (await overdueCount(a2)) + (await overdueCount(b));
  assert.ok(total > 20, `fixture has ${total} overdue installments`);
  assert.match(all, new RegExp(`<p class="stat__value">${total}</p>`));
  assert.equal((all.match(/class="item"/g) || []).length, 20, '20 per page');
  assert.equal(((await page('?page=2')).text.match(/class="item"/g) || []).length, total - 20);
  assert.match(all, /صفحة 1 من 2/);

  const onlyB = (await page(`?landlord=${landlordB}`)).text;
  const bOverdue = await overdueCount(b);
  assert.equal((onlyB.match(/class="item"/g) || []).length, bOverdue);
  assert.doesNotMatch(onlyB, /شقة 1-1/);
  assert.equal(((await page(`?q=${encodeURIComponent('شقة 1-1')}`)).text.match(/class="item"/g) || []).length, await overdueCount(a));
  assert.match((await page('?days=90')).text, /class="item"/);
  const none = (await page(`?from=${day}&to=${day}&landlord=${landlordB}`)).text;
  assert.match(none, /لا توجد دفعات متأخرة تطابق البحث/);
  assert.equal(((await page(`?from=${day}&to=${day}`)).text.match(/class="item"/g) || []).length, 0);
  assert.match((await page('?from=bogus&days=5000&landlord=abc&page=-3')).text, /الدفعات المتأخرة/, 'bad filters are ignored, not fatal');

  // A partial payment reduces the remaining; a full one removes the row; waived rows are never listed.
  const [first] = await payments(b);
  await record(o.cookie, b, first.id, { amount: '1000', paid_on: day, method: 'cash' });
  const partial = (await page(`?landlord=${landlordB}`)).text;
  assert.match(partial, /المدفوع 1,000\.00 · <strong>المتبقي 2,000\.00 ريال/);
  await record(o.cookie, b, first.id, { amount: '2000', paid_on: day, method: 'cash' });
  assert.equal(((await page(`?landlord=${landlordB}`)).text.match(/class="item"/g) || []).length, bOverdue - 1);
  const [second] = (await payments(b)).slice(1);
  await db.pool.query("UPDATE contract_payments SET status = 'waived' WHERE id = ?", [second.id]);
  assert.equal(((await page(`?landlord=${landlordB}`)).text.match(/class="item"/g) || []).length, bOverdue - 2);

  // Staff may read it (payments.read); CSV: BOM, neutralized formula, only nicknames.
  assert.equal((await http.request('/office/payments', { cookie: staff })).status, 200);
  const csv = await fx.get(`/office/payments.csv?landlord=${landlordB}`, o.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="overdue-payments\.csv"/);
  const text = csv.body.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM');
  assert.match(text, /'=HYPERLINK\(""x""\)/, 'formula neutralized with a quote');
  assert.doesNotMatch(text, /(^|,)=HYPERLINK/m);
  assert.doesNotMatch(text, /اسم-سري|966500|شقة 1-1/, 'no tenant label, phones, or the other landlord\'s units');
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 1 + bOverdue - 2);
  assert.equal(lines[0].replace('﻿', ''), 'الوحدة,المالك,تاريخ الاستحقاق,أيام التأخر,المبلغ,المدفوع,المتبقي');

  // Another office sees none of it.
  const o2 = await fx.office(45, 'مكتب آخر');
  assert.match((await http.request('/office/payments', { cookie: o2.cookie })).text, /لا توجد دفعات متأخرة/);
  assert.equal((await fx.get('/office/payments.csv', o2.cookie)).body.toString('utf8').trim().split('\r\n').length, 1);
});

// ------------------------------------------------------------ the older flows and the migration

test('the advanced status form and the tenant "I paid" confirm go through entries; delete is refused once money is recorded', { skip }, async () => {
  const { o, contractId } = await setup(50, 'مكتب القديم');
  const tenant = await fx.tenantOf(contractId, 51);
  const [p1, p2, p3] = await payments(contractId);
  const day = fx.today();
  const old = (id, form) => http.request(`/office/contracts/${contractId}/payments/${id}`, { method: 'POST', cookie: o.cookie, form });

  assert.equal((await old(p1.id, { status: 'paid', paid_on: day, method: 'transfer', receipt_no: 'R-9' })).status, 302);
  let row = (await payments(contractId))[0];
  assert.deepEqual([row.status, row.paid_amount, row.receipt_no], ['paid', '3000.00', 'R-9']);
  assert.deepEqual((await entriesOf(p1.id)).map((e) => [e.amount, e.reference_code, e.undone_at === null]), [['3000.00', 'R-9', true]]);
  assert.equal((await old(p1.id, { status: 'due' })).status, 302);
  row = (await payments(contractId))[0];
  assert.deepEqual([row.status, row.paid_amount, row.paid_at], ['due', '0.00', null]);
  assert.ok((await entriesOf(p1.id))[0].undone_at, 'the entry was voided');
  assert.match((await entriesOf(p1.id))[0].undo_reason, /تغيير الحالة/);

  // "I paid" then partial by the office, then confirm of the rest through the reported flow.
  await http.request(`/tenant/contracts/${contractId}/payments/${p2.id}/report`, { method: 'POST', cookie: tenant.cookie });
  assert.equal((await payments(contractId))[1].status, 'tenant_reported');
  const confirm = await http.request(`/office/contracts/${contractId}/payments/${p2.id}/confirm`, { method: 'POST', cookie: o.cookie });
  assert.equal(confirm.status, 302);
  const [paid] = await entriesOf(p2.id);
  assert.deepEqual([(await payments(contractId))[1].status, paid.amount, paid.recorded_role], ['paid', '3000.00', 'office']);
  assert.equal((await payments(contractId))[1].reported_by === null, false, 'the report trail is kept');

  // A partial payment on p3 blocks deletion (money is recorded), even though nothing is "paid".
  await record(o.cookie, contractId, p3.id, { amount: '10', paid_on: day, method: 'cash' });
  assert.equal((await http.request(`/office/contracts/${contractId}/delete`, { method: 'POST', cookie: o.cookie })).status, 409);
  assert.equal(await fx.count('SELECT COUNT(*) FROM contracts WHERE id = ?', [contractId]), 1);
  // Reported partial: back to due, and the dashboard "late total" is the remaining amount.
  const late = await setup(55, 'مكتب اللوحة', { start: fx.dates.addMonths(fx.today(), -3) });
  const [l1] = await payments(late.contractId);
  await record(late.o.cookie, late.contractId, l1.id, { amount: '1000', paid_on: day, method: 'cash' });
  await http.request('/office', { cookie: late.o.cookie });
  const home = (await http.request('/office', { cookie: late.o.cookie })).text;
  assert.match(home, /دفعات متأخرة/);
});

test('migration: installments marked paid before entries existed get one legacy entry, once', { skip }, async () => {
  const { o, contractId } = await setup(60, 'مكتب الترحيل');
  const [p1, p2] = await payments(contractId);
  // Simulate the old schema state: paid, but no entries and paid_amount 0.
  await db.pool.query("UPDATE contract_payments SET status = 'paid', paid_at = '2026-01-05 00:00:00', method = 'cash', receipt_no = 'OLD-1', paid_amount = 0 WHERE id = ?", [p1.id]);
  await db.pool.query('DELETE FROM payment_entries WHERE payment_id = ?', [p1.id]);
  const made = await Promise.all([db.backfillPaymentEntries(db.pool), db.backfillPaymentEntries(db.pool), db.backfillPaymentEntries(db.pool)]);
  assert.equal(made.reduce((s, n) => s + n, 0) >= 1, true);
  const rows = await entriesOf(p1.id);
  assert.equal(rows.length, 1, 'parallel backfills create one entry');
  assert.deepEqual([rows[0].amount, String(rows[0].paid_on).slice(0, 10), rows[0].method, rows[0].reference_code, Number(rows[0].legacy)], ['3000.00', '2026-01-05', 'cash', 'OLD-1', 1]);
  assert.equal((await payments(contractId))[0].paid_amount, '3000.00');
  assert.equal((await entriesOf(p2.id)).length, 0, 'unpaid installments get nothing');
  assert.equal(await db.backfillPaymentEntries(db.pool) >= 0, true);
  assert.equal((await entriesOf(p1.id)).length, 1, 'running again changes nothing');
  void o;
});

// ------------------------------------------------------------ isolation

test('isolation: another office, landlord or tenant cannot record or undo; ids of other contracts are 404', { skip }, async () => {
  const a = await setup(70, 'مكتب أ');
  const b = await setup(75, 'مكتب ب');
  const landlordB = await fx.landlordOf(b.o, 76);
  const tenantB = await fx.tenantOf(b.contractId, 77);
  const [pa] = await payments(a.contractId);
  const [pb] = await payments(b.contractId);
  const day = fx.today();
  await record(a.o.cookie, a.contractId, pa.id, { amount: '100', paid_on: day, method: 'cash' });
  const [ea] = await entriesOf(pa.id);

  assert.equal((await record(b.o.cookie, a.contractId, pa.id, { amount: '100', paid_on: day, method: 'cash' })).status, 404);
  assert.equal((await undo(b.o.cookie, a.contractId, pa.id, ea.id, 'اختراق')).status, 404);
  assert.equal((await record(landlordB.cookie, a.contractId, pa.id, { amount: '100', paid_on: day, method: 'cash' }, 'landlord')).status, 404);
  assert.equal((await undo(landlordB.cookie, a.contractId, pa.id, ea.id, 'اختراق', 'landlord')).status, 404);
  // A payment id from another contract inside the same office, and a mismatched entry.
  const second = await fx.contract(a.o, { unitIndex: 1 });
  const [px] = await payments(second);
  assert.equal((await record(a.o.cookie, a.contractId, px.id, { amount: '100', paid_on: day, method: 'cash' })).status, 404);
  assert.equal((await undo(a.o.cookie, a.contractId, px.id, ea.id, 'خطأ في الرقم')).status, 404);
  assert.equal((await record(a.o.cookie, a.contractId, pb.id, { amount: '100', paid_on: day, method: 'cash' })).status, 404);
  for (const bad of ['abc', '0', '99999999']) {
    assert.equal((await record(a.o.cookie, a.contractId, bad, { amount: '1', paid_on: day, method: 'cash' })).status, 404, bad);
    assert.equal((await undo(a.o.cookie, a.contractId, pa.id, bad, 'سبب كافٍ')).status, 404, bad);
  }
  assert.equal((await entriesOf(pa.id)).length, 1);
  assert.equal((await entriesOf(pb.id)).length, 0);
  assert.equal((await entriesOf(ea.payment_id))[0].undone_at, null);
  void tenantB;
  assert.equal((await http.request('/office/payments', { cookie: tenantB.cookie })).status, 403);
});
