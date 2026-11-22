'use strict';

// Office accounting (ledger, commission, owner statement, landlord account)
// and the leads board, against real MySQL. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { retryOnDeadlock } = require('../services/transaction');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000032NN.
const phone = (n) => `9665000032${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let accounting;
let leads;

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
     VALUES ('test_acc', 'اختبار المحاسبة', 1, 1, NULL, NULL, NULL, NULL, 0, 103)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, is_active = 0`,
  );
  accounting = require('../services/accounting');
  leads = require('../services/leads');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_acc' });
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES), { retries: 5 });
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

const post = (path, cookie, form) => http.request(path, { method: 'POST', cookie, form });

test('pure helpers: percent, commission rounding, month parsing, entry validation', { skip }, () => {
  assert.equal(accounting.parsePercent('5'), 500);
  assert.equal(accounting.parsePercent('2.5'), 250);
  assert.equal(accounting.parsePercent('٥'), 500);
  assert.equal(accounting.parsePercent('51'), null);
  assert.equal(accounting.parsePercent('abc'), null);
  assert.equal(accounting.commissionOn(300000, 500), 15000);
  assert.equal(accounting.commissionOn(333, 500), 17); // 16.65 halalas rounds half up
  assert.equal(accounting.parseMonth('2099-01', '2026-11-22'), '2026-11');
  assert.equal(accounting.parseMonth('2026-13', '2026-11-22'), '2026-11');
  assert.equal(accounting.parseMonth('2026-02', '2026-11-22'), '2026-02');
  const ok = accounting.validateEntry({ kind: 'expense', category: 'maintenance', amount: '850', entry_date: '2026-11-01' }, '2026-11-22');
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.amount, 85000);
  assert.ok(accounting.validateEntry({ kind: 'expense', category: 'maintenance', amount: '10', description: 'SA03 8000 0000 6080 1016 7519' }, '2026-11-22').errors.description);
  assert.ok(accounting.validateEntry({ kind: 'expense', category: 'maintenance', amount: '10', entry_date: '2026-12-01' }, '2026-11-22').errors.entry_date);
  assert.ok(accounting.validateEntry({ kind: 'owner_payout', amount: '10' }, '2026-11-22').errors.landlord_id);
  assert.ok(accounting.validateEntry({ kind: 'expense', category: 'nope', amount: '10' }, '2026-11-22').errors.category);
  assert.ok(accounting.validateEntry({ kind: 'expense', category: 'fees', amount: '0' }, '2026-11-22').errors.amount);
});

test('ledger, commission, owner statement, voiding, landlord account and isolation', { skip }, async () => {
  const o = await fx.office(1, 'تجربة-محاسبة-أ', { landlords: 2, units: 2 });
  const b = await fx.office(2, 'تجربة-محاسبة-ب', { landlords: 1, units: 1 });
  const day = fx.today();
  const period = day.slice(0, 7);
  const contractId = await fx.contract(o, { rent: '36000', frequency: 'monthly' });
  const [[pay]] = await db.pool.query('SELECT id FROM contract_payments WHERE contract_id = ? ORDER BY due_date LIMIT 1', [contractId]);
  const rec = await post(`/office/contracts/${contractId}/payments/${pay.id}/entries`, o.cookie, { amount: '3000', paid_on: day, method: 'cash' });
  assert.equal(rec.status, 302);

  // Commission 5%.
  assert.equal((await post('/office/accounting/commission', o.cookie, { percent: '5' })).location, '/office/accounting?done=commission');
  assert.equal((await post('/office/accounting/commission', o.cookie, { percent: '80' })).location, '/office/accounting?error=commission');

  // Entries.
  const l1 = o.landlordIds[0];
  const unit = o.unitsBy[l1][1];
  let res = await post('/office/accounting', o.cookie, { kind: 'expense', category: 'maintenance', amount: '850', entry_date: day, landlord_id: '', unit_id: String(unit), description: 'تغيير قطعة المكيف' });
  assert.equal(res.status, 302, res.text.slice(0, 300));
  res = await post('/office/accounting', o.cookie, { kind: 'expense', category: 'fees', amount: '200', entry_date: day });
  assert.equal(res.status, 302);
  res = await post('/office/accounting', o.cookie, { kind: 'owner_payout', amount: '1000', entry_date: day, landlord_id: String(l1) });
  assert.equal(res.status, 302);
  // Refusals: IBAN text, another office's landlord, unit of another landlord.
  assert.equal((await post('/office/accounting', o.cookie, { kind: 'expense', category: 'fees', amount: '5', entry_date: day, description: 'SA0380000000608010167519' })).status, 422);
  assert.equal((await post('/office/accounting', o.cookie, { kind: 'owner_payout', amount: '5', entry_date: day, landlord_id: String(b.landlordId) })).status, 422);
  assert.equal((await post('/office/accounting', o.cookie, { kind: 'expense', category: 'fees', amount: '5', entry_date: day, landlord_id: String(o.landlordIds[1]), unit_id: String(unit) })).status, 422);

  // The expense on a unit is charged to its landlord.
  const [[charged]] = await db.pool.query("SELECT landlord_id FROM ledger_entries WHERE office_id = ? AND category = 'maintenance'", [o.office.id]);
  assert.equal(Number(charged.landlord_id), l1);

  const summary = await accounting.monthSummary(db.pool, o.office.id, period);
  assert.equal(summary.totals.collected, 300000);
  assert.equal(summary.totals.expenses, 105000);
  assert.equal(summary.totals.ownerExpenses, 85000);
  assert.equal(summary.totals.commission, 15000);
  assert.equal(summary.totals.payouts, 100000);
  assert.equal(summary.totals.ownersNet, 300000 - 85000 - 15000);

  let st = await accounting.ownerStatement(db.pool, o.office.id, l1, period);
  assert.equal(st.closing, 300000 - 85000 - 15000 - 100000);
  assert.equal(st.lines.length, 4);

  const page = await http.request(`/office/accounting?month=${period}`, { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /3,000\.00/);
  assert.match(page.text, /1,050\.00/);
  assert.match(page.text, /تغيير قطعة المكيف/);
  const stPage = await http.request(`/office/accounting/owners/${l1}?month=${period}`, { cookie: o.cookie });
  assert.equal(stPage.status, 200);
  assert.match(stPage.text, /1,000\.00/);
  assert.equal((await http.request(`/office/accounting/owners/${l1}?month=${period}&print=1`, { cookie: o.cookie })).status, 200);
  assert.equal((await http.request(`/office/accounting/owners?month=${period}`, { cookie: o.cookie })).status, 200);
  const csv = await fx.get(`/office/accounting/csv?month=${period}`, o.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.body.toString('utf8'), /دفعة إيجار/);

  // Landlord sees their own monthly account only.
  const la = await fx.landlordOf(o, 10, l1);
  const acc = await http.request(`/landlord/account?month=${period}`, { cookie: la.cookie });
  assert.equal(acc.status, 200);
  assert.match(acc.text, /1,000\.00/);

  // Void the payout: the balance goes back up.
  const [[payout]] = await db.pool.query("SELECT id FROM ledger_entries WHERE office_id = ? AND kind = 'owner_payout'", [o.office.id]);
  assert.equal((await post(`/office/accounting/${payout.id}/void`, o.cookie, { reason: 'x', month: period })).status, 422);
  assert.equal((await post(`/office/accounting/${payout.id}/void`, b.cookie, { reason: 'خطأ في المبلغ', month: period })).status, 404);
  assert.equal((await post(`/office/accounting/${payout.id}/void`, o.cookie, { reason: 'خطأ في المبلغ', month: period })).status, 302);
  st = await accounting.ownerStatement(db.pool, o.office.id, l1, period);
  assert.equal(st.closing, 300000 - 85000 - 15000);
  assert.match((await http.request(`/landlord/account?month=${period}`, { cookie: la.cookie })).text, /2,000\.00/);

  // Isolation and roles.
  assert.equal((await http.request(`/office/accounting/owners/${l1}`, { cookie: b.cookie })).status, 404);
  assert.equal((await http.request('/office/accounting/owners/abc', { cookie: o.cookie })).status, 404);
  assert.doesNotMatch((await http.request(`/office/accounting?month=${period}`, { cookie: b.cookie })).text, /تغيير قطعة المكيف/);
  await http.addMember(o.office.id, phone(20), 'office_staff');
  const staff = await http.login(phone(20));
  assert.equal((await http.request('/office/accounting', { cookie: staff.cookie })).status, 403);
  assert.equal((await post('/office/accounting', staff.cookie, { kind: 'expense', category: 'fees', amount: '5' })).status, 403);
  assert.equal((await http.request('/office/accounting', {})).status, 302);

  // Audit rows hold no amount or description.
  const [audits] = await db.pool.query("SELECT after_json FROM audit_logs WHERE office_id = ? AND action LIKE 'ledger.%'", [o.office.id]);
  assert.ok(audits.length >= 4);
  for (const a of audits) assert.doesNotMatch(String(a.after_json), /850|1000|المكيف/);
});

test('leads: create, validate, move, from an inquiry, isolation and purge', { skip }, async () => {
  const o = await fx.office(30, 'تجربة-عملاء-أ', { landlords: 1, units: 1 });
  const b = await fx.office(31, 'تجربة-عملاء-ب', { landlords: 1, units: 1 });
  const res = await post('/office/leads', o.cookie, { label: 'شقة 3 غرف في حي الملقا', contact_label: 'أبو سعد', phone: '0551234567', source: 'phone', budget: '45000', next_date: fx.today(), note: 'يفضل الدور الأول' });
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const [[lead]] = await db.pool.query('SELECT * FROM leads WHERE office_id = ?', [o.office.id]);
  assert.equal(lead.phone, '966551234567');
  assert.equal(lead.stage, 'new');

  // Refusals.
  assert.equal((await post('/office/leads', o.cookie, { label: '' })).status, 422);
  assert.equal((await post('/office/leads', o.cookie, { label: 'فيلا', phone: '123' })).status, 422);
  assert.equal((await post('/office/leads', o.cookie, { label: 'فيلا', note: 'هوية 1012345678' })).status, 422);
  assert.equal((await post('/office/leads', o.cookie, { label: 'فيلا', unit_id: String(b.units[0]) })).status, 422);

  const board = await http.request('/office/leads', { cookie: o.cookie });
  assert.equal(board.status, 200);
  assert.match(board.text, /شقة 3 غرف في حي الملقا/);
  assert.match(board.text, /45,000\.00/);

  // Move along the board, then close as won.
  assert.equal((await post(`/office/leads/${lead.id}/stage`, o.cookie, { stage: 'contacted' })).status, 302);
  assert.equal((await post(`/office/leads/${lead.id}/stage`, o.cookie, { stage: 'won' })).status, 302);
  const [[won]] = await db.pool.query('SELECT stage, closed_at FROM leads WHERE id = ?', [lead.id]);
  assert.equal(won.stage, 'won');
  assert.ok(won.closed_at);

  // Another office cannot see, edit or move it.
  assert.equal((await http.request(`/office/leads/${lead.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await post(`/office/leads/${lead.id}/stage`, b.cookie, { stage: 'lost' })).status, 404);
  assert.equal((await post(`/office/leads/${lead.id}`, b.cookie, { label: 'x' })).status, 404);
  assert.doesNotMatch((await http.request('/office/leads', { cookie: b.cookie })).text, /حي الملقا/);

  // Staff may use the board.
  await http.addMember(o.office.id, phone(40), 'office_staff');
  const staff = await http.login(phone(40));
  assert.equal((await http.request('/office/leads', { cookie: staff.cookie })).status, 200);

  // From a listing inquiry, once.
  const listingId = await o.scoped.insert('listings', { unit_id: o.units[0], title: 'شقة للإيجار في حي النرجس، الرياض', description: 'شقة واسعة', city: 'الرياض', price: '40000.00', status: 'draft' });
  const inquiryId = await o.scoped.insert('listing_inquiries', { listing_id: listingId, name: 'زائر', phone: '0559876543', message: 'متاحة؟' });
  const first = await post(`/office/leads/from-inquiry/${inquiryId}`, o.cookie, {});
  assert.equal(first.status, 302);
  const again = await post(`/office/leads/from-inquiry/${inquiryId}`, o.cookie, {});
  assert.match(again.location, /done=existed/);
  assert.equal(await fx.count('SELECT COUNT(*) FROM leads WHERE inquiry_id = ?', [inquiryId]), 1);
  assert.equal((await post(`/office/leads/from-inquiry/${inquiryId}`, b.cookie, {})).status, 404);

  // Purge clears the contact of leads closed long ago.
  await db.pool.query('UPDATE leads SET closed_at = UTC_TIMESTAMP() - INTERVAL 100 DAY WHERE id = ?', [lead.id]);
  await leads.purgeContacts({ pool: db.pool });
  const [[purged]] = await db.pool.query('SELECT phone, contact_label, label FROM leads WHERE id = ?', [lead.id]);
  assert.equal(purged.phone, null);
  assert.equal(purged.contact_label, null);
  assert.equal(purged.label, 'شقة 3 غرف في حي الملقا');
});
