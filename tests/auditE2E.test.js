'use strict';

// End-to-end happy path over real HTTP and a real database, the way the people
// of the product use it, with a privacy audit of everything it leaves behind:
// register an office, landlord, building, unit, contract, tenant joins, the
// reminder engine fires, a payment is tracked, a maintenance request is raised,
// a listing is published, a stranger sends an inquiry, a CSV is downloaded and a
// plan is bought by bank transfer and approved by the platform admin.
// Also: the mobile-first CSS check and the AI-reading privacy check.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');
const { installClaudeMock, modelReply, fakePdf } = require('./helpers/claudeMock');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000021NN. NN = 00 is the platform admin.
const phone = (n) => `9665000021${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 30 }, (_, i) => phone(i));
const ROOT = path.join(__dirname, '..');
const saved = {};
const logLines = [];
const consoleOriginals = {};
let db;
let http;
let fx;
let mock;
let uploadDir;
let admin;
let planBuy;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR', 'CLAUDE_API_KEY']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500002100';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  process.env.CLAUDE_API_KEY = 'test-key-not-real';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-e2e-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_ai_reads_monthly, features, is_public, is_active, sort_order) VALUES
       ('e2e_free', 'اختبار شامل', 1, 10, NULL, '{"listings":true,"reports_csv":true,"ai_reading":true}', 0, 1, 551),
       ('e2e_buy', 'اختبار شراء', 99, 990, NULL, '{"listings":true,"reports_csv":true,"ai_reading":true}', 1, 1, 552)
     ON DUPLICATE KEY UPDATE features = VALUES(features), is_public = VALUES(is_public)`,
  );
  [[planBuy]] = await db.pool.query("SELECT * FROM plans WHERE code = 'e2e_buy'");
  mock = installClaudeMock();
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'e2e_free' });
  admin = await http.login(phone(0));

  // Everything the app logs while this file runs is kept for the privacy check.
  for (const level of ['log', 'info', 'warn', 'error']) {
    consoleOriginals[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'e2e\\_%'");
  await db.pool.query("DELETE FROM contact_messages WHERE name LIKE 'رحلة-%'");
}

test.after(async () => {
  for (const [level, fn] of Object.entries(consoleOriginals)) console[level] = fn;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (mock) mock.restore();
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
  if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
});

const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const post = (p, cookie, form) => http.request(p, { method: 'POST', cookie, form });
const jpeg = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#6a8' } }).jpeg().toBuffer();
const png = () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#fff' } }).png().toBuffer();

// ------------------------------------------------------------ the journey

test('happy path: office, landlord, building, unit, contract, tenant, reminder, payment, maintenance, listing, inquiry, CSV, upgrade', { skip }, async () => {
  const today = fx.today();
  const dates = fx.dates;

  // 1. A new phone registers and creates its office.
  const owner = await http.registerOffice(phone(1), 'تجربة-رحلة-1');
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'e2e_free') WHERE id = ?", [owner.office.id]);
  assert.equal((await one('SELECT role FROM users WHERE id = ?', [owner.user.id])).role, 'office_owner');
  assert.match((await http.request('/office', { cookie: owner.cookie })).text, /تجربة-رحلة-1/);

  // 2. Landlord, building and unit through the forms.
  const landlordRes = await post('/office/landlords', owner.cookie, { label: 'مالك الرحلة', city: 'الرياض', phone: '0555000999', notes: 'ملاحظة' });
  assert.equal(landlordRes.status, 302, landlordRes.text.slice(0, 200));
  const landlord = await one('SELECT * FROM landlords WHERE office_id = ?', [owner.office.id]);
  const buildingRes = await post('/office/units/buildings', owner.cookie, { landlord_id: String(landlord.id), name: 'عمارة الرحلة', city: 'الرياض', district: 'الملقا' });
  assert.equal(buildingRes.status, 302, buildingRes.text.slice(0, 200));
  const building = await one('SELECT * FROM buildings WHERE office_id = ?', [owner.office.id]);
  const unitIds = [];
  for (const label of ['شقة 1', 'شقة 2']) {
    const res = await post('/office/units', owner.cookie, {
      landlord_id: String(landlord.id), building_id: String(building.id), label, city: 'الرياض', unit_type: 'apartment', rooms: '3', bathrooms: '2', area_sqm: '140', base_rent: '36000',
    });
    assert.equal(res.status, 302, res.text.slice(0, 200));
    unitIds.push(Number((await one('SELECT id FROM units WHERE office_id = ? AND label = ?', [owner.office.id, label])).id));
  }
  const o = {
    ...owner, city: 'الرياض', landlordId: Number(landlord.id), landlordIds: [Number(landlord.id)], unitsBy: { [landlord.id]: unitIds }, units: unitIds,
    scoped: require('../services/scopeToOffice').scopeToOffice(db.pool, owner.office.id),
  };

  // 3. A contract whose decision deadline is in 7 days; the tenant and the landlord join with their codes.
  // Three whole months ending 67 days from today: the 60-day notice deadline is today + 7.
  const end = dates.addDays(today, 67);
  const start = dates.addMonths(dates.addDays(end, 1), -3);
  const contractId = await fx.contract(o, { start, end });
  const tenant = await fx.tenantOf(contractId, 2);
  const landlordUser = await fx.landlordOf(o, 3);
  assert.equal((await one('SELECT role FROM users WHERE id = ?', [tenant.user.id])).role, 'tenant');
  assert.equal((await one('SELECT role FROM users WHERE id = ?', [landlordUser.user.id])).role, 'landlord');
  assert.match((await http.request(`/tenant`, { cookie: tenant.cookie })).text, /شقة 1/);
  assert.match((await http.request(`/landlord/contracts/${contractId}`, { cookie: landlordUser.cookie })).text, /شقة 1/);

  // 4. The reminder engine creates a notification for the office, the landlord and the tenant.
  const reminders = require('../services/reminders');
  const run = await reminders.computeDueReminders({ pool: db.pool, today, lastRun: null, now: new Date(), officeId: owner.office.id });
  assert.ok(run.created >= 3, JSON.stringify(run));
  for (const u of [owner.user, landlordUser.user, tenant.user]) {
    const n = await one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'decision_60'", [u.id]);
    assert.equal(Number(n.n), 1, `user ${u.id} was not reminded`);
  }
  const note = await one("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'decision_60'", [tenant.user.id]);
  assert.match(note.body, /تطبيق خاص غير تابع لمنصة إيجار/);

  // 5. A payment is tracked.
  const payment = await one('SELECT id, amount FROM contract_payments WHERE contract_id = ? ORDER BY due_date, id LIMIT 1', [contractId]);
  const paid = await post(`/office/contracts/${contractId}/payments/${payment.id}/entries`, owner.cookie, { amount: '', paid_on: today, method: 'cash', reference: 'RC-1001' });
  assert.equal(paid.status, 302, paid.text.slice(0, 300));
  assert.equal((await one('SELECT status FROM contract_payments WHERE id = ?', [payment.id])).status, 'paid');
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM payment_entries WHERE payment_id = ? AND undone_at IS NULL', [payment.id])).n), 1);
  assert.equal((await http.request(`/tenant/contracts/${contractId}/receipt`, { cookie: tenant.cookie })).status, 200);

  // 6. The tenant raises a maintenance request with a photo; the office sees it.
  const maint = await fx.multipart(`/tenant/contracts/${contractId}/maintenance`, tenant.cookie,
    { category: 'plumbing', priority: 'normal', description: 'تسرب في المطبخ' }, [{ field: 'photos', name: 'leak.jpg', type: 'image/jpeg', data: await jpeg() }]);
  assert.equal(maint.status, 302, maint.text.slice(0, 300));
  const request = await one('SELECT id, status FROM maintenance_requests WHERE office_id = ?', [owner.office.id]);
  assert.equal(request.status, 'new');
  assert.match((await http.request(`/office/maintenance/${request.id}`, { cookie: owner.cookie })).text, /تسرب في المطبخ/);

  // 7. A listing for the free unit is created, filled, given a photo and published.
  const created = await post('/office/listings', owner.cookie, { unit_id: String(unitIds[1]) });
  assert.equal(created.status, 302, created.text.slice(0, 300));
  const listingId = Number(/listings\/(\d+)/.exec(created.location)[1]);
  const saveRes = await post(`/office/listings/${listingId}`, owner.cookie, {
    unit_type: 'apartment', city: 'الرياض', neighborhood: 'الملقا', price: '36000', rooms: '3', bathrooms: '2', area_sqm: '140',
    description: 'شقة نظيفة وواسعة في حي هادئ قريبة من الخدمات والمدارس.', features: ['ac', 'parking'],
  });
  assert.equal(saveRes.status, 302, saveRes.text.slice(0, 300));
  const photo = await fx.multipart(`/office/listings/${listingId}/photos`, owner.cookie, {}, [{ field: 'photos', name: 'a.jpg', type: 'image/jpeg', data: await jpeg() }]);
  assert.equal(photo.status, 302);
  const publish = await post(`/office/listings/${listingId}/publish`, owner.cookie, {});
  assert.equal(publish.location, `/office/listings/${listingId}?done=published`);

  // 8. A stranger finds it, sees only public fields, and sends an inquiry.
  const detail = await (await fetch(`${http.base()}/listings/${listingId}`)).text();
  assert.match(detail, /الملقا/);
  for (const secret of ['شقة 2', 'مالك الرحلة', 'عمارة الرحلة', '0555000999', 'ملاحظة']) assert.ok(!detail.includes(secret), `the public page shows ${secret}`);
  const inquiry = await fetch(`${http.base()}/listings/${listingId}/inquiry`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: http.base() }, redirect: 'manual',
    body: new URLSearchParams({ name: 'زائر', phone: '0555000111', message: 'هل ما زالت متاحة؟', website: '' }).toString(),
  });
  assert.equal(inquiry.status, 302);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM listing_inquiries WHERE listing_id = ?', [listingId])).n), 1);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'listing_inquiry'", [owner.user.id])).n), 1, 'the owner is told');

  // 9. The occupancy report downloads as CSV with a BOM.
  const csv = await fx.get('/office/reports/csv/occupancy', owner.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.deepEqual([...csv.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  // 10. The office buys a plan by bank transfer; the platform admin approves it.
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'trial') WHERE id = ?", [owner.office.id]);
  const order = await post('/office/billing/orders', owner.cookie, { plan: String(planBuy.id), interval: 'monthly', method: 'bank_transfer', promo: '' });
  assert.equal(order.status, 302, order.text.slice(0, 300));
  const orderId = Number(/orders\/(\d+)\//.exec(order.location)[1]);
  const sent = await fx.multipart(`/office/billing/orders/${orderId}/transfer`, owner.cookie, { reference: 'TRX-9001' }, [{ field: 'receipt', name: 'r.png', type: 'image/png', data: await png() }]);
  assert.equal(sent.status, 302, sent.text.slice(0, 300));
  const transfer = await one('SELECT id, status FROM bank_transfers WHERE order_id = ?', [orderId]);
  assert.equal(transfer.status, 'pending');
  const approve = await post(`/admin/transfers/${transfer.id}/approve`, admin.cookie, { reason: 'وصل التحويل' });
  assert.equal(approve.status, 302, approve.text.slice(0, 300));
  assert.equal((await one('SELECT status FROM orders WHERE id = ?', [orderId])).status, 'paid');
  assert.equal((await one('SELECT status FROM offices WHERE id = ?', [owner.office.id])).status, 'active');
  assert.equal((await one('SELECT plan_id FROM offices WHERE id = ?', [owner.office.id])).plan_id, planBuy.id);
  const invoice = await one('SELECT id, invoice_no FROM subscription_invoices WHERE order_id = ?', [orderId]);
  assert.match(invoice.invoice_no, /^INV-\d{4}-\d{6}$/);
  const page = await http.request(`/office/billing/invoices/${invoice.id}`, { cookie: owner.cookie });
  assert.equal(page.status, 200);
  // The invoice only disclaims: it is not an approved e-invoice, and it never claims to be official.
  assert.match(page.text, /لا يُعدّ فاتورة إلكترونية معتمدة/);
  assert.doesNotMatch(page.text, /ZATCA|إيجار الرسمي|معتمد من منصة إيجار/);
});

// ------------------------------------------------------------ privacy of the AI reading

test('AI reading: names, ID numbers, IBANs, meters and addresses in the model reply are never stored, shown or logged', { skip }, async () => {
  const o = await fx.office(10, 'تجربة-رحلة-ذكاء', { landlords: 1, units: 1 });
  const today = fx.today();
  const MARKERS = ['TENANT-NAME-MARKER', 'LANDLORD-NAME-MARKER', 'ADDRESS-MARKER-STREET', 'METER-998877', 'SA0380000000608010167519', '1012345678', '2087654321'];
  mock.state.reply = modelReply({
    start_date: today, end_date: fx.dates.addDays(fx.dates.addMonths(today, 12), -1), annual_rent: 48000, payment_frequency: 'monthly',
    city: 'الرياض', property_type: 'apartment', ejar_contract_number: '1012345678',
    tenant_name: MARKERS[0], landlord_name: MARKERS[1], address: MARKERS[2], meter_number: MARKERS[3], iban: MARKERS[4], national_id: MARKERS[5], iqama: MARKERS[6],
  });
  const form = new FormData();
  form.append('contract', new Blob([fakePdf(MARKERS[0])], { type: 'application/pdf' }), 'contract.pdf');
  const res = await fetch(`${http.base()}/office/contracts/new/ai`, { method: 'POST', headers: { Cookie: o.cookie, Origin: http.base() }, body: form, redirect: 'manual' });
  const html = await res.text();
  assert.equal(res.status, 200, html.slice(0, 300));
  assert.match(html, /تمت القراءة بالذكاء الاصطناعي/);
  for (const m of MARKERS) assert.ok(!html.includes(m), `the form shows ${m}`);

  // Save the prefilled contract like the person would, then scan every table.
  const saved = await post('/office/contracts', o.cookie, {
    landlord_id: String(o.landlordId), unit_id: String(o.units[0]), tenant_label: 'مستأجر-مجهول', start_date: today,
    end_date: fx.dates.addDays(fx.dates.addMonths(today, 12), -1), annual_rent: '48000', payment_frequency: 'monthly', city: 'الرياض', auto_renew: '1', ack_warnings: '1', source: 'ai',
  });
  assert.equal(saved.status, 302, saved.text.slice(0, 300));
  const [tables] = await db.pool.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  for (const { t } of tables) {
    if (['plans', 'cron_runs'].includes(t)) continue;
    const [rows] = await db.pool.query(`SELECT * FROM \`${t}\` ORDER BY 1 DESC LIMIT 2000`);
    const text = JSON.stringify(rows);
    for (const m of MARKERS) assert.ok(!text.includes(m), `${t} holds ${m}`);
  }
  // The upload was never written to disk.
  const files = fs.readdirSync(uploadDir);
  assert.ok(!files.some((f) => /pdf/i.test(f)));
  assert.ok(mock.state.calls.length >= 1);
  for (const m of MARKERS) assert.ok(!logLines.some((l) => l.includes(m)), `the log holds ${m}`);
});

// ------------------------------------------------------------ the logs

test('the logs of this whole run hold no full phone number, token, secret or login code', { skip }, async () => {
  assert.ok(logLines.length >= 0);
  const text = logLines.join('\n');
  assert.doesNotMatch(text, /(?<![\d+])(?:\+?966|0)?5\d{8}(?!\d)/, 'a full mobile number reached the log');
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'a JWT reached the log');
  assert.doesNotMatch(text, /123456/, 'the test login code reached the log');
  for (const name of ['JWT_SECRET', 'SECRET_BOX_KEY', 'CRON_SECRET', 'DB_PASSWORD', 'CLAUDE_API_KEY']) {
    const value = process.env[name];
    if (value && value.length >= 8) assert.ok(!text.includes(value), `${name} reached the log`);
  }
  assert.doesNotMatch(text, /Authorization|Bearer [A-Za-z0-9]/i);
});

// ------------------------------------------------------------ mobile first

test('mobile-first: every layout has the viewport tag and the stylesheet sets no fixed width wider than 375px outside media queries', () => {
  for (const layout of fs.readdirSync(path.join(ROOT, 'views', 'layouts'))) {
    const html = fs.readFileSync(path.join(ROOT, 'views', 'layouts', layout), 'utf8');
    if (layout === 'print.ejs') continue;
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/, layout);
    assert.match(html, /<html[^>]*dir="rtl"/, `${layout} is RTL`);
  }
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'main.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  const stack = [];
  const re = /([^{};]*)([{};])/g;
  let m;
  while ((m = re.exec(css))) {
    const text = m[1].trim();
    if (m[2] === '{') stack.push(text);
    else if (m[2] === '}') stack.pop();
    else {
      const d = /^(min-)?width\s*:\s*(\d+)px/.exec(text);
      if (d && Number(d[2]) > 375 && !stack.some((s) => s.startsWith('@media'))) offenders.push(`${stack.join(' > ')} { ${text} }`);
    }
  }
  // Wide tables scroll inside their own box (.table-wrap), never the page.
  assert.deepEqual(offenders.filter((x) => !/^\.table \{ min-width/.test(x)), []);
  assert.match(css, /\.table-wrap[^{]*\{[^}]*overflow-x\s*:\s*auto/);
  // Found by the 375 px browser check: a row of five status tabs widened the whole page.
  assert.match(css, /\.tabs \{[^}]*flex-wrap\s*:\s*wrap/);
  assert.match(css, /overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*break-word/, 'long words wrap');
});
