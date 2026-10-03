'use strict';

// Reports, CSV exports and the landlord statement against real MySQL:
// numbers, date-range validation, permissions, scoping to the office,
// Excel-safe CSV (BOM, neutralized formulas), the download rate limit.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000012NN.
const phone = (n) => `9665000012${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let csvLib;

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
     VALUES ('test_reports', 'اختبار التقارير', 1, 1, NULL, NULL, NULL, NULL, 0, 104)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, is_active = 0`,
  );
  csvLib = require('../services/csv');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_reports' });
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

/** A small CSV reader for the tests: quotes, doubled quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += c;
  }
  return rows;
}

const csv = async (path, cookie) => {
  const res = await fx.get(path, cookie);
  return { ...res, text: res.body.toString('utf8') };
};

// ------------------------------------------------------------ the Excel-safe CSV writer (pure)

test('csv: BOM, CRLF, quoting, and cells that start with = + - @ tab or CR get a single quote', () => {
  assert.equal(csvLib.csvCell('=1+1'), "'=1+1");
  assert.equal(csvLib.csvCell('+966'), "'+966");
  assert.equal(csvLib.csvCell('-5'), "'-5");
  assert.equal(csvLib.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvLib.csvCell('\t=x'), "'\t=x");
  assert.equal(csvLib.csvCell('\r=x'), '"\'\r=x"');
  assert.equal(csvLib.csvCell('a,b'), '"a,b"');
  assert.equal(csvLib.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvLib.csvCell('=HYPERLINK("u")'), '"\'=HYPERLINK(""u"")"');
  assert.equal(csvLib.csvCell('سطر\nثاني'), '"سطر\nثاني"');
  assert.equal(csvLib.csvCell(null), '');
  assert.equal(csvLib.csvCell(undefined), '');
  assert.equal(csvLib.csvCell(12.5), '12.5');
  assert.equal(csvLib.csvCell(0), '0');
  assert.equal(csvLib.csvCell(NaN), '');
  assert.equal(csvLib.csvCell('1234.50'), '1234.50');
  assert.equal(csvLib.csvCell('ملف'), 'ملف');
  const out = csvLib.toCsv(['أ', 'ب'], [['=x', 'ok'], ['1', '2']]);
  assert.equal(out, "﻿أ,ب\r\n'=x,ok\r\n1,2\r\n");
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.deepEqual(parseCsv(out), [['أ', 'ب'], ["'=x", 'ok'], ['1', '2']]);
});

// ------------------------------------------------------------ office reports

async function fixture() {
  const o = await fx.office(1, 'مكتب التقارير', { landlords: 2, units: 3 });
  const [landlordA, landlordB] = o.landlordIds;
  // Buildings: one named like a formula, one plain; the third unit of A has no building.
  const b1 = await o.scoped.insert('buildings', { landlord_id: landlordA, name: '=cmd|\' /C calc\'!A1', city: 'جدة' });
  const b2 = await o.scoped.insert('buildings', { landlord_id: landlordB, name: 'برج النخيل', city: 'جدة' });
  const [a1, a2, a3] = o.unitsBy[landlordA];
  const [b1u, b2u, b3u] = o.unitsBy[landlordB];
  await db.pool.query('UPDATE units SET building_id = ? WHERE id IN (?, ?)', [b1, a1, a2]);
  await db.pool.query('UPDATE units SET building_id = ? WHERE id IN (?, ?, ?)', [b2, b1u, b2u, b3u]);
  await db.pool.query("UPDATE units SET status = 'maintenance' WHERE id = ?", [b3u]);
  await db.pool.query("UPDATE landlords SET label = '+SUM(1)' WHERE id = ?", [landlordA]);
  await db.pool.query("UPDATE units SET label = '@evil' WHERE id = ?", [a3]);
  return { o, landlordA, landlordB, units: { a1, a2, a3, b1u, b2u, b3u } };
}

test('reports page and CSVs: numbers, permissions, scoped data only', { skip }, async () => {
  const { o, landlordA, landlordB } = await fixture();
  const today = fx.today();
  const manager = await http.addMember(o.office.id, phone(2), 'office_manager');
  const staff = await http.addMember(o.office.id, phone(3), 'office_staff');
  const other = await fx.office(10, 'مكتب آخر مختلف');
  await other.scoped.insert('buildings', { landlord_id: other.landlordId, name: 'مبنى المكتب الآخر', city: 'جدة' });

  // Contracts: ends in 20, 50, 80 and 120 days (only the first three count), plus an ended one.
  const endIn = (days) => fx.dates.addDays(today, days);
  const make = (landlordId, unitIndex, days) => fx.contract(o, { landlordId, unitIndex, start: fx.dates.addDays(fx.dates.addMonths(endIn(days), -12), 1), end: endIn(days), frequency: 'annual' });
  const c20 = await make(landlordA, 0, 20);
  const c50 = await make(landlordA, 1, 50);
  const c80 = await make(landlordB, 0, 80);
  await make(landlordB, 1, 120);
  await fx.contract(o, { landlordId: landlordA, unitIndex: 2, start: fx.dates.addMonths(today, -14), end: fx.dates.addDays(fx.dates.addMonths(today, -2), -1), frequency: 'annual' });
  void c50; void c80;

  // Access: owner and manager yes; staff, landlord and tenant no.
  assert.equal((await http.request('/office/reports', { cookie: o.cookie })).status, 200);
  assert.equal((await http.request('/office/reports', { cookie: manager })).status, 200);
  assert.equal((await http.request('/office/reports', { cookie: staff })).status, 403);
  assert.equal((await fx.get('/office/reports/csv/occupancy', staff)).status, 403);
  const landlord = await fx.landlordOf(o, 4, landlordB);
  const tenant = await fx.tenantOf(c20, 5);
  for (const who of [landlord, tenant]) {
    assert.equal((await http.request('/office/reports', { cookie: who.cookie })).status, 403);
    assert.equal((await fx.get('/office/reports/csv/occupancy', who.cookie)).status, 403);
  }
  assert.equal((await fx.get('/office/reports')).status, 302);
  assert.equal((await fx.get('/office/reports/csv/occupancy')).status, 302);

  const page = (await http.request('/office/reports', { cookie: o.cookie })).text;
  for (const title of ['الإشغال حسب المبنى', 'عقود تنتهي خلال 30 / 60 / 90 يوماً', 'الدفعات المتأخرة', 'المحصّل مقابل المتوقع شهرياً', 'الصيانة حسب الحالة والنوع', 'عبء عمل الفريق']) assert.ok(page.includes(title), title);
  assert.equal((page.match(/تصدير CSV/g) || []).length, 6, 'one export per report');
  assert.match(page, /تطبيق خاص غير تابع لمنصة إيجار/);
  assert.doesNotMatch(page, /<script>|=cmd\|' \/C/, 'labels are escaped, formulas stay text');
  assert.doesNotMatch(page, /مبنى المكتب الآخر/);

  // Occupancy: buildings, a unit without a building, and the rented count follows the contracts.
  const occ = parseCsv((await csv('/office/reports/csv/occupancy', o.cookie)).text);
  assert.deepEqual(occ[0], ['المبنى', 'عدد الوحدات', 'مؤجرة', 'شاغرة', 'تحت الصيانة', 'نسبة الإشغال %']);
  const byName = Object.fromEntries(occ.slice(1).map((r) => [r[0], r.slice(1).map(Number)]));
  assert.ok(Object.hasOwn(byName, "'=cmd|' /C calc'!A1"), 'a building named like a formula is neutralized');
  assert.deepEqual(byName["'=cmd|' /C calc'!A1"].slice(0, 1), [2]);
  assert.deepEqual(byName['برج النخيل'].slice(0, 1), [3]);
  assert.deepEqual(byName['بدون مبنى'].slice(0, 1), [1]);
  assert.equal(Object.values(byName).reduce((s, r) => s + r[0], 0), 6, 'every unit once');
  assert.equal(Object.values(byName).reduce((s, r) => s + r[3], 0), 1, 'one unit in maintenance');
  assert.equal(occ.slice(1).some((r) => r.some((cell) => /^[=+\-@]/.test(cell))), false);
  assert.equal(JSON.stringify(occ).includes('مبنى المكتب الآخر'), false, 'another office\'s building never appears');

  // Expiring: 20/50/80 are in; 120 and the ended one are out; unit and landlord nicknames are neutralized.
  const exp = parseCsv((await csv('/office/reports/csv/expiring', o.cookie)).text);
  assert.equal(exp.length - 1, 3);
  assert.deepEqual(exp.slice(1).map((r) => [Number(r[3]), r[4]]), [[20, 'خلال 30 يوماً'], [50, '31 إلى 60 يوماً'], [80, '61 إلى 90 يوماً']]);
  assert.ok(exp.slice(1).some((r) => r[0] === "'@evil" || r[1] === "'+SUM(1)"), 'formula-like nicknames get the quote');
  for (const row of exp.slice(1)) for (const cell of row) assert.ok(!/^[=+\-@]/.test(cell), cell);
  assert.match(page, /<strong>1<\/strong> خلال 30 يوماً/);
});

test('collections: expected by due month vs collected by payment month, exact; undone payments do not count', { skip }, async () => {
  const o = await fx.office(20, 'مكتب المحصّل');
  const today = fx.today();
  const start = fx.dates.addMonths(today, -3);
  const contractId = await fx.contract(o, { start, rent: '24000', frequency: 'monthly' });
  const rows = (await db.pool.query('SELECT * FROM contract_payments WHERE contract_id = ? ORDER BY due_date', [contractId]))[0];
  const rec = (p, amount, paidOn) => http.request(`/office/contracts/${contractId}/payments/${p.id}/entries`, { method: 'POST', cookie: o.cookie, form: { amount, paid_on: paidOn, method: 'cash' } });
  await rec(rows[0], '1000', rows[0].due_date.slice(0, 10));
  await rec(rows[0], '0.10', rows[0].due_date.slice(0, 10));
  await rec(rows[1], '1000', rows[1].due_date.slice(0, 10));
  await rec(rows[2], '1000', rows[1].due_date.slice(0, 10)); // paid early, in the second month
  const [[bad]] = await db.pool.query('SELECT id, payment_id FROM payment_entries WHERE office_id = ? ORDER BY id DESC LIMIT 1', [o.office.id]);
  await http.request(`/office/contracts/${contractId}/payments/${bad.payment_id}/entries/${bad.id}/undo`, { method: 'POST', cookie: o.cookie, form: { reason: 'غير صحيحة' } });

  const range = { from: fx.dates.addMonths(`${today.slice(0, 7)}-01`, -4), to: today };
  const res = parseCsv((await csv(`/office/reports/csv/collections?from=${range.from}&to=${range.to}`, o.cookie)).text);
  assert.deepEqual(res[0], ['الشهر', 'المتوقع', 'المحصّل', 'نسبة التحصيل %']);
  const expected = {};
  for (const p of rows) {
    const due = String(p.due_date).slice(0, 10);
    if (due >= range.from && due <= range.to) expected[due.slice(0, 7)] = (expected[due.slice(0, 7)] || 0) + Math.round(Number(p.amount) * 100);
  }
  const month = (row) => row[0];
  const got = Object.fromEntries(res.slice(1).map((r) => [month(r), r]));
  for (const [m, h] of Object.entries(expected)) assert.equal(got[m][1], (h / 100).toFixed(2), `expected ${m}`);
  const firstMonth = rows[0].due_date.slice(0, 7);
  const secondMonth = rows[1].due_date.slice(0, 7);
  assert.equal(got[firstMonth][2], '1000.10', '1000 + 0.10 is exact');
  assert.equal(got[firstMonth][3], String(Math.round((100010 / expected[firstMonth]) * 100)));
  assert.equal(got[secondMonth][2], '1000.00', 'the undone entry is not counted');
  const totalCollected = res.slice(1).reduce((s, r) => s + Math.round(Number(r[2]) * 100), 0);
  assert.equal(totalCollected, 100010 + 100000);
  // A narrower range leaves the other months out.
  const narrow = parseCsv((await csv(`/office/reports/csv/collections?from=${rows[0].due_date.slice(0, 10)}&to=${rows[0].due_date.slice(0, 10)}`, o.cookie)).text);
  assert.equal(narrow.length, 2);
  assert.equal(narrow[1][0], firstMonth);
  const html = (await http.request(`/office/reports?from=${range.from}&to=${range.to}`, { cookie: o.cookie })).text;
  assert.match(html, /1,000\.10/);
  assert.match(html, /المبالغ بالريال/);
});

test('maintenance by status and category, staff workload, overdue and date-range validation', { skip }, async () => {
  const o = await fx.office(30, 'مكتب الصيانة والعبء');
  const staffCookie = await http.addMember(o.office.id, phone(31), 'office_staff');
  const staffUser = await http.userByPhone(phone(31));
  await db.pool.query("UPDATE users SET name = '=EVIL()' WHERE id = ?", [staffUser.id]);
  const contractId = await fx.contract(o, { start: fx.dates.addMonths(fx.today(), -3), frequency: 'monthly' });
  const tenant = await fx.tenantOf(contractId, 32);
  const ask = (category) => fx.multipart(`/tenant/contracts/${contractId}/maintenance`, tenant.cookie, { category, priority: 'normal', description: 'وصف' });
  const ids = [];
  for (const category of ['plumbing', 'plumbing', 'electrical', 'ac', 'other']) ids.push(Number(/\/maintenance\/(\d+)/.exec((await ask(category)).location)[1]));
  const move = (id, status) => http.request(`/office/maintenance/${id}/status`, { method: 'POST', cookie: o.cookie, form: { status } });
  await move(ids[0], 'seen'); await move(ids[0], 'in_progress'); await move(ids[0], 'done');
  await move(ids[2], 'rejected');
  await http.request(`/office/maintenance/${ids[1]}/assign`, { method: 'POST', cookie: o.cookie, form: { assignee: String(staffUser.id) } });
  await http.request(`/office/maintenance/${ids[0]}/assign`, { method: 'POST', cookie: o.cookie, form: { assignee: String(staffUser.id) } });
  await http.request('/office/tasks', { method: 'POST', cookie: o.cookie, form: { title: 'مهمة 1', assignee: String(staffUser.id), due_date: fx.dates.addDays(fx.today(), -1) } });
  await http.request('/office/tasks', { method: 'POST', cookie: o.cookie, form: { title: 'مهمة 2', assignee: String(staffUser.id) } });
  const [[t2]] = await db.pool.query('SELECT id FROM office_tasks WHERE office_id = ? ORDER BY id DESC LIMIT 1', [o.office.id]);
  await http.request(`/office/tasks/${t2.id}/status`, { method: 'POST', cookie: staffCookie, form: { status: 'done' } });

  const mt = parseCsv((await csv('/office/reports/csv/maintenance', o.cookie)).text);
  assert.deepEqual(mt[0], ['الحالة', 'سباكة', 'كهرباء', 'تكييف', 'أخرى', 'المجموع']);
  const rowFor = (label) => mt.find((r) => r[0] === label);
  assert.deepEqual(rowFor('جديد').slice(1).map(Number), [1, 0, 1, 1, 3]);
  assert.deepEqual(rowFor('تم الإنجاز').slice(1).map(Number), [1, 0, 0, 0, 1]);
  assert.deepEqual(rowFor('مرفوض').slice(1).map(Number), [0, 1, 0, 0, 1]);
  assert.equal(mt.slice(1).reduce((s, r) => s + Number(r[5]), 0), 5);

  const wl = parseCsv((await csv('/office/reports/csv/workload', o.cookie)).text);
  assert.deepEqual(wl[0], ['العضو', 'الدور', 'صيانة مفتوحة', 'صيانة أُنجزت', 'مهام مفتوحة', 'مهام متأخرة', 'مهام أُنجزت']);
  const staffRow = wl.find((r) => r[0] === "'=EVIL()");
  assert.ok(staffRow, 'a display name that looks like a formula is neutralized');
  assert.deepEqual(staffRow.slice(1), ['موظف', '1', '1', '1', '1', '1']);
  assert.equal(wl.slice(1).some((r) => /^[=+\-@]/.test(r[0])), false);

  // Overdue: three installments are past due (start, +1, +2 months... the third is today).
  const od = parseCsv((await csv('/office/reports/csv/overdue', o.cookie)).text);
  assert.ok(od.length - 1 >= 2);
  assert.equal(od[0].length, 7);

  // Date ranges are validated on the server.
  // Downloads are limited to 10 a minute per person, so use separate managers.
  const m1 = await http.addMember(o.office.id, phone(33), 'office_manager');
  const m2 = await http.addMember(o.office.id, phone(34), 'office_manager');
  const bad = ['from=2026-02-30&to=2026-03-01', 'from=abc', 'from=2026-05-01&to=2026-04-01', 'from=2010-01-01&to=2026-01-01', 'to=nonsense', 'from=2026-1-1'];
  for (const q of bad) {
    const res = await csv(`/office/reports/csv/maintenance?${q}`, m1);
    assert.equal(res.status, 400, q);
    assert.doesNotMatch(res.text, /<|SELECT|at /, 'a plain message, nothing internal');
    const page = (await http.request(`/office/reports?${q}`, { cookie: o.cookie }));
    assert.equal(page.status, 200, `${q} falls back to the default range`);
    assert.match(page.text, /عرضنا المدة الافتراضية/);
  }
  assert.equal((await csv('/office/reports/csv/maintenance?from=2026-01-01&to=2026-01-02', m2)).status, 200);
  assert.equal((await csv('/office/reports/csv/nonsense', m2)).status, 404);
  assert.equal((await csv('/office/reports/csv/occupancy.csv', m2)).status, 404);
  const dl = await fx.get('/office/reports/csv/occupancy', m2);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="occupancy-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.match(dl.type, /^text\/csv; charset=utf-8$/);
  assert.equal(dl.body[0], 0xef);
  assert.equal(dl.body[1], 0xbb);
  assert.equal(dl.body[2], 0xbf);
});

test('reports are scoped: another office sees none of this office\'s data in pages or CSVs', { skip }, async () => {
  const a = await fx.office(40, 'مكتب الأول السري');
  const b = await fx.office(45, 'مكتب الثاني');
  const contractId = await fx.contract(a, { start: fx.dates.addMonths(fx.today(), -2) });
  await db.pool.query("UPDATE units SET label = 'وحدة-سرية-أ' WHERE id = ?", [a.units[0]]);
  assert.ok((await csv('/office/reports/csv/overdue', a.cookie)).text.includes('وحدة-سرية-أ'));
  for (const name of ['occupancy', 'expiring', 'overdue', 'collections', 'maintenance', 'workload']) {
    const res = await csv(`/office/reports/csv/${name}`, b.cookie);
    assert.equal(res.status, 200, name);
    assert.ok(!res.text.includes('وحدة-سرية-أ') && !res.text.includes('مالك 1 مكتب الأول'), name);
  }
  assert.ok(!(await http.request('/office/reports', { cookie: b.cookie })).text.includes('وحدة-سرية-أ'));
  void contractId;
});

test('CSV downloads are limited to 10 per minute per person', { skip }, async () => {
  const o = await fx.office(50, 'مكتب الحد');
  const manager = await http.addMember(o.office.id, phone(51), 'office_manager');
  for (let i = 0; i < 10; i += 1) assert.equal((await fx.get('/office/reports/csv/occupancy', manager)).status, 200, `download ${i + 1}`);
  const limited = await fx.get('/office/reports/csv/occupancy', manager);
  assert.equal(limited.status, 429);
  assert.match(limited.body.toString('utf8'), /طلبات تصدير كثيرة/);
  assert.equal((await fx.get('/office/payments.csv', manager)).status, 429, 'the limit is shared by every CSV');
  assert.equal((await fx.get('/office/reports/csv/occupancy', o.cookie)).status, 200, 'another person is not limited');
  assert.equal((await http.request('/office/reports', { cookie: manager })).status, 200, 'pages are not limited');
});

// ------------------------------------------------------------ landlord statement

test('landlord statement: own units only, exact totals, same CSV rules, tenants and offices excluded', { skip }, async () => {
  const o = await fx.office(60, 'مكتب الكشف', { landlords: 2, units: 2 });
  const [landlordA, landlordB] = o.landlordIds;
  await db.pool.query("UPDATE units SET label = '=دفعة' WHERE id = ?", [o.unitsBy[landlordA][0]]);
  const today = fx.today();
  const start = fx.dates.addMonths(today, -3);
  const cA = await fx.contract(o, { landlordId: landlordA, unitIndex: 0, start, rent: '12000.30', frequency: 'monthly' });
  const cB = await fx.contract(o, { landlordId: landlordB, unitIndex: 0, start, rent: '24000', frequency: 'monthly' });
  const la = await fx.landlordOf(o, 61, landlordA);
  const lb = await fx.landlordOf(o, 62, landlordB);
  const tenant = await fx.tenantOf(cA, 63);
  const pays = (await db.pool.query('SELECT * FROM contract_payments WHERE contract_id = ? ORDER BY due_date', [cA]))[0];
  await http.request(`/landlord/contracts/${cA}/payments/${pays[0].id}/entries`, { method: 'POST', cookie: la.cookie, form: { amount: '500.25', paid_on: today, method: 'cash' } });
  await http.request(`/office/contracts/${cA}/payments/${pays[1].id}/entries`, { method: 'POST', cookie: o.cookie, form: { amount: '', paid_on: today, method: 'transfer' } });
  void cB;

  const page = await http.request('/landlord/statement', { cookie: la.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /كشف الحساب/);
  assert.match(page.text, /مكتب الكشف/);
  assert.match(page.text, /500\.25/);
  assert.match(page.text, /تطبيق خاص غير تابع لمنصة إيجار/);
  assert.match(page.text, /href="\/landlord\/statement"/, 'the statement is in the landlord navigation');
  assert.doesNotMatch(page.text, /شقة 2-1/, 'the other landlord\'s unit is not listed');

  const file = await csv('/landlord/statement/csv', la.cookie);
  assert.equal(file.status, 200);
  assert.equal(file.text.charCodeAt(0), 0xfeff);
  const rows = parseCsv(file.text);
  assert.deepEqual(rows[0], ['المكتب', 'الوحدة', 'تاريخ الاستحقاق', 'المبلغ', 'المدفوع', 'المتبقي', 'الحالة']);
  assert.ok(rows.slice(1).every((r) => r[1] === "'=دفعة"), 'only this landlord\'s unit, formula neutralized');
  assert.equal(rows.length - 1, pays.filter((p) => String(p.due_date).slice(0, 10) <= today).length);
  const sum = (col) => rows.slice(1).reduce((s, r) => s + Math.round(Number(r[col]) * 100), 0);
  assert.equal(sum(3), sum(4) + sum(5), 'amount = paid + remaining, to the halala');
  assert.equal(sum(4), 50025 + Math.round(Number(pays[1].amount) * 100));
  assert.equal(rows[1][6], 'جزئية');
  assert.equal(rows[2][6], 'مدفوعة');
  assert.equal(rows[1][3], pays[0].amount);
  for (const row of rows.slice(1)) for (const cell of row) assert.ok(!/^[=+\-@]/.test(cell), cell);
  const otherCsv = (await csv('/landlord/statement/csv', lb.cookie)).text;
  assert.ok(!otherCsv.includes('=دفعة'));
  assert.ok(otherCsv.includes('شقة 2-1'));
  assert.ok(!(await http.request('/landlord/statement', { cookie: lb.cookie })).text.includes('500.25'));

  // Range validation and access.
  assert.equal((await csv('/landlord/statement/csv?from=2026-02-30', la.cookie)).status, 400);
  assert.match((await http.request('/landlord/statement?from=zzz', { cookie: la.cookie })).text, /عرضنا المدة الافتراضية/);
  assert.notEqual((await http.request('/landlord/statement', { cookie: tenant.cookie })).status, 200);
  assert.notEqual((await fx.get('/landlord/statement/csv', tenant.cookie)).status, 200);
  assert.notEqual((await fx.get('/landlord/statement/csv', o.cookie)).status, 200, 'office users have no landlord statement');
  assert.equal((await fx.get('/landlord/statement/csv')).status, 302);
  // 10 per minute, shared with the other CSVs.
  const spam = await fx.office(70, 'مكتب الإغراق');
  const spamLandlord = await fx.landlordOf(spam, 71);
  for (let i = 0; i < 10; i += 1) assert.equal((await fx.get('/landlord/statement/csv', spamLandlord.cookie)).status, 200);
  assert.equal((await fx.get('/landlord/statement/csv', spamLandlord.cookie)).status, 429);
});
