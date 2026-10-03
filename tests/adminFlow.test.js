'use strict';

// The platform admin area (/admin) against real MySQL: access control (signed
// out, office roles, admin without 2FA), the dashboard, offices and their
// actions (each with a reason and an audit row), orders / payments / credit
// notes, the bank-transfer queue, promo codes, plans, platform settings, the
// kill-switch mapping and the audit viewer. Runs only when TEST_DB_NAME is set.
//
// The kill switches themselves are never flipped in the shared database
// (other test files run at the same time); their effect is tested through
// injected settings, and the form mapping through a pure function.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000015NN. NN = 00 is the platform admin.
const phone = (n) => `9665000015${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let mod;
let admin; // { cookie, user }
let planA;
let uploadDir;
let auditStart = 0;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500001500';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-admin-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, is_public, is_active, sort_order)
     VALUES ('adm_small', 'اختبار إدارة صغيرة', 10, 100, 2, 1, 1, 301), ('adm_big', 'اختبار إدارة كبيرة', 20, 200, NULL, 1, 1, 302)
     ON DUPLICATE KEY UPDATE max_units = VALUES(max_units), is_public = 1, is_active = 1`,
  );
  [[planA]] = await db.pool.query("SELECT * FROM plans WHERE code = 'adm_small'");
  mod = {
    admin: require('../services/admin'),
    orders: require('../services/orders'),
    subs: require('../services/subscriptions'),
    invoices: require('../services/invoices'),
    transfers: require('../services/bankTransfers'),
    settings: require('../services/platformSettings'),
    features: require('../services/features'),
    auth: require('../services/auth'),
    pricing: require('../services/pricing'),
  };
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'trial' });
  admin = { ...(await http.login(phone(0))) };
  admin.user = await http.userByPhone(phone(0));
  assert.equal(admin.user.role, 'platform_admin');
  [[{ n: auditStart }]] = await db.pool.query('SELECT COALESCE(MAX(id), 0) AS n FROM audit_logs');
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM promo_codes WHERE code LIKE 'ADM%'");
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'adm\\_%'");
  await db.pool.query("DELETE FROM settings WHERE setting_key IN ('seller.legal_name', 'seller.address')");
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
  if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
});

const aget = (p) => http.request(p, { cookie: admin.cookie });
const apost = (p, form) => http.request(p, { method: 'POST', cookie: admin.cookie, form });
const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const count = async (sql, params = []) => Number(Object.values(await one(sql, params))[0]);
const officeRow = (id) => one('SELECT * FROM offices WHERE id = ?', [id]);
const newOffice = (n, name = `اختبار-إدارة-${n}`, opts = { landlords: 0, units: 0 }) => fx.office(n, name, opts);
const lastAudit = (action, officeId = null) => one(
  `SELECT * FROM audit_logs WHERE id > ? AND action = ? ${officeId ? 'AND office_id = ?' : ''} ORDER BY id DESC LIMIT 1`,
  officeId ? [auditStart, action, officeId] : [auditStart, action],
);
const afterOf = (row) => (typeof row.after_json === 'string' ? JSON.parse(row.after_json) : row.after_json);

const PAGES = ['/admin', '/admin/offices', '/admin/orders', '/admin/transfers', '/admin/promos', '/admin/promos/new', '/admin/plans', '/admin/plans/new', '/admin/settings', '/admin/audit'];

// ------------------------------------------------------------ access

test('only a signed-in platform admin opens /admin; everyone else is refused on the server', { skip }, async () => {
  const owner = await newOffice(1);
  const staff = await http.addMember(owner.office.id, phone(2), 'office_staff');
  const manager = await http.addMember(owner.office.id, phone(3), 'office_manager');
  for (const p of PAGES) {
    assert.equal((await http.request(p)).status, 302, `${p} signed out`);
    assert.equal((await http.request(p)).location, '/login');
    for (const cookie of [owner.cookie, staff, manager]) assert.equal((await http.request(p, { cookie })).status, 403, `${p} office role`);
    assert.equal((await aget(p)).status, 200, `${p} admin`);
  }
  // Writes are refused for non-admins too, and nothing happens.
  const before = await count('SELECT COUNT(*) FROM promo_codes');
  const res = await http.request('/admin/promos', { method: 'POST', cookie: owner.cookie, form: { code: 'ADMNOPE', discount_type: 'percent', percent: '10', reason: 'محاولة' } });
  assert.equal(res.status, 403);
  assert.equal(await count('SELECT COUNT(*) FROM promo_codes'), before);
  assert.equal((await http.request(`/admin/offices/${owner.office.id}/suspend`, { method: 'POST', cookie: owner.cookie, form: { reason: 'محاولة' } })).status, 403);
  assert.equal((await officeRow(owner.office.id)).status, 'trial');
  // The office area does not accept the admin as an office member.
  assert.notEqual((await http.request('/office/billing', { cookie: admin.cookie })).status, 200);
  // /platform (where the admin lands after login) goes to /admin.
  assert.equal((await aget('/platform')).location, '/admin');
  assert.equal((await http.request('/platform', { cookie: owner.cookie })).status, 403);
  // Another site cannot post for the admin.
  const cross = await fetch(`${http.base()}/admin/settings/switches`, {
    method: 'POST', headers: { Cookie: admin.cookie, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'reason=xxx', redirect: 'manual',
  });
  assert.equal(cross.status, 403);
  // Unknown ids answer 404, not an error page.
  for (const p of ['/admin/offices/abc', '/admin/offices/999999999', '/admin/promos/abc', '/admin/plans/999999999', '/admin/invoices/abc', '/admin/transfers/abc/receipt']) {
    assert.equal((await aget(p)).status, 404, p);
  }
});

test('admin without 2FA is blocked: no session at login, and a leftover session is refused', { skip }, async () => {
  // Login with 2FA required: the phone code leads to setup, not to a session.
  process.env.REQUIRE_ADMIN_2FA = 'true';
  try {
    await db.pool.query("INSERT INTO users (phone, role, phone_verified) VALUES (?, 'platform_admin', 1) ON DUPLICATE KEY UPDATE role = 'platform_admin', twofa_enabled = 0", [phone(50)]);
    const login = await http.login(phone(50));
    assert.equal(login.cookie, null, 'no session before the second factor');
    assert.equal(login.location, '/login/2fa/setup');
    assert.equal((await http.request('/admin')).status, 302);
  } finally {
    process.env.REQUIRE_ADMIN_2FA = 'false';
  }
  // A session that exists while 2FA is not required is refused once it is.
  const session = await http.login(phone(0));
  assert.equal((await http.request('/admin', { cookie: session.cookie })).status, 200);
  process.env.REQUIRE_ADMIN_2FA = 'true';
  try {
    const blocked = await http.request('/admin', { cookie: session.cookie });
    assert.equal(blocked.status, 403);
    assert.match(blocked.text, /المصادقة الثنائية/);
    await db.pool.query('UPDATE users SET twofa_enabled = 1, twofa_secret = ? WHERE id = ?', ['x', admin.user.id]);
    assert.equal((await http.request('/admin', { cookie: session.cookie })).status, 200, 'with 2FA enabled the session is fine');
  } finally {
    await db.pool.query('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE id = ?', [admin.user.id]);
    process.env.REQUIRE_ADMIN_2FA = 'false';
  }
});

// ------------------------------------------------------------ dashboard

test('dashboard: the cards render from real counts', { skip }, async () => {
  const o1 = await newOffice(4);
  const o2 = await newOffice(5);
  await mod.subs.suspend(db.pool, { officeId: o2.office.id });
  const data = await mod.admin.overview(db.pool);
  assert.equal(data.totalOffices, Object.values(data.byStatus).reduce((a, b) => a + b, 0));
  assert.ok(data.byStatus.trial >= 1 && data.byStatus.suspended >= 1);
  assert.ok(data.newOffices >= 2, 'both offices were created this Riyadh month');
  for (const key of ['mrr', 'contracts', 'notifications', 'aiReads', 'pendingTransfers', 'suspiciousOrders']) assert.ok(Number.isInteger(data[key]) && data[key] >= 0, key);
  const page = await aget('/admin');
  assert.match(page.text, /الإيراد الشهري المتكرر/);
  assert.match(page.text, /مكاتب جديدة هذا الشهر/);
  assert.match(page.text, /<meter /);
  assert.ok(o1);
});

// ------------------------------------------------------------ offices

test('offices list and detail: search, filter, no party data, no impersonation', { skip }, async () => {
  const o = await newOffice(6, 'اختبار-إدارة-ظاهر', { landlords: 1, units: 2 });
  await fx.contract(o, { unitIndex: 0 }); // tenant label 'اسم-سري'
  const list = await aget('/admin/offices?q=%D8%A7%D8%AE%D8%AA%D8%A8%D8%A7%D8%B1-%D8%A5%D8%AF%D8%A7%D8%B1%D8%A9-%D8%B8%D8%A7%D9%87%D8%B1');
  assert.match(list.text, /اختبار-إدارة-ظاهر/);
  assert.match((await aget('/admin/offices?status=suspended')).text, /مكتب/);
  assert.doesNotMatch((await aget('/admin/offices?q=zzzz-nothing-zzzz')).text, /اختبار-إدارة-ظاهر/);
  const detail = await aget(`/admin/offices/${o.office.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /اختبار-إدارة-ظاهر/);
  assert.match(detail.text, /الاستخدام/);
  for (const secret of ['اسم-سري', 'مالك 1', 'شقة 1-1', '36000']) {
    assert.equal(detail.text.includes(secret), false, `no party data: ${secret}`);
    assert.equal(list.text.includes(secret), false, secret);
  }
  assert.doesNotMatch(detail.text, /انتحال|تسجيل الدخول كـ|impersonat/i);
  assert.equal((await apost(`/admin/offices/${o.office.id}/impersonate`, {})).status, 404, 'there is no such route');
  assert.equal((await aget(`/admin/offices/${o.office.id}/login`)).status, 404);
});

test('office actions: a reason is required, each change is real and audit-logged with that reason', { skip }, async () => {
  const o = await fx.office(7, 'اختبار-إدارة-إجراءات', { landlords: 1, units: 3 });
  const id = o.office.id;
  const trialBefore = new Date((await officeRow(id)).trial_ends_at);

  // Extend trial.
  const noReason = await apost(`/admin/offices/${id}/extend-trial`, { days: '5', reason: '' });
  assert.equal(noReason.status, 422);
  assert.equal(new Date((await officeRow(id)).trial_ends_at).getTime(), trialBefore.getTime(), 'unchanged without a reason');
  assert.equal((await apost(`/admin/offices/${id}/extend-trial`, { days: '0', reason: 'سبب صحيح' })).status, 422);
  assert.equal((await apost(`/admin/offices/${id}/extend-trial`, { days: '500', reason: 'سبب صحيح' })).status, 422);
  const ok = await apost(`/admin/offices/${id}/extend-trial`, { days: '5', reason: 'طلب العميل' });
  assert.equal(ok.location, `/admin/offices/${id}?done=trial`);
  const trialAfter = new Date((await officeRow(id)).trial_ends_at);
  assert.equal(Math.round((trialAfter - trialBefore) / 86400000), 5, 'exactly 5 days later');
  assert.equal(new Date((await one("SELECT period_end FROM subscriptions WHERE office_id = ? AND status = 'trialing'", [id])).period_end).getTime(), trialAfter.getTime());
  let row = await lastAudit('admin.office.extend_trial', id);
  assert.equal(row.actor_id, admin.user.id);
  assert.equal(afterOf(row).reason, 'طلب العميل');
  assert.equal(afterOf(row).days, 5);

  // An expired trial can be extended from today.
  await db.pool.query('UPDATE offices SET trial_ends_at = UTC_TIMESTAMP() - INTERVAL 10 DAY WHERE id = ?', [id]);
  await apost(`/admin/offices/${id}/extend-trial`, { days: '3', reason: 'تمديد بعد الانتهاء' });
  const revived = new Date((await officeRow(id)).trial_ends_at);
  assert.ok(Math.abs(revived - (Date.now() + 3 * 86400000)) < 60000, 'counted from now when it had already ended');

  // Change plan: blocked while usage is above the new limits, nothing deleted.
  const blocked = await apost(`/admin/offices/${id}/plan`, { plan_id: String(planA.id), reason: 'خفض الباقة' });
  assert.equal(blocked.status, 422);
  assert.match(blocked.text, /قلّل 1 وحدة/);
  assert.equal(await count('SELECT COUNT(*) FROM units WHERE office_id = ?', [id]), 3);
  assert.equal(await lastAudit('admin.office.change_plan', id), undefined);
  const [[big]] = await db.pool.query("SELECT id FROM plans WHERE code = 'adm_big'");
  assert.equal((await apost(`/admin/offices/${id}/plan`, { plan_id: String(big.id), reason: 'ترقية مجانية' })).location, `/admin/offices/${id}?done=plan`);
  assert.equal(Number((await officeRow(id)).plan_id), Number(big.id));
  row = await lastAudit('admin.office.change_plan', id);
  assert.equal(afterOf(row).reason, 'ترقية مجانية');
  assert.equal((await apost(`/admin/offices/${id}/plan`, { plan_id: '999999999', reason: 'سبب صحيح' })).status, 422);

  // Suspend / unsuspend.
  assert.equal((await apost(`/admin/offices/${id}/suspend`, {})).status, 422);
  assert.equal((await officeRow(id)).status, 'trial');
  assert.equal((await apost(`/admin/offices/${id}/suspend`, { reason: 'مخالفة الشروط' })).location, `/admin/offices/${id}?done=suspend`);
  assert.equal((await officeRow(id)).status, 'suspended');
  assert.equal((await http.request('/office/contracts', { cookie: o.cookie })).status, 402, 'the office is locked at once');
  assert.equal(afterOf(await lastAudit('admin.office.suspend', id)).reason, 'مخالفة الشروط');

  // A payment while suspended by the admin does not lift the suspension, and checkout is closed.
  const created = await mod.orders.createOrder(db.pool, { officeId: id, userId: o.user.id, planId: big.id, interval: 'monthly', method: 'bank_transfer' });
  assert.equal(created.error, 'admin_suspended');
  await db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [id]);
  const [ins] = await db.pool.query(
    `INSERT INTO orders (office_id, plan_id, plan_code, billing_interval, method, status, subtotal, vat_rate_bp, vat_amount, total, currency, created_by, expires_at)
     VALUES (?, ?, 'adm_big', 'monthly', 'moyasar', 'pending', 20.00, 1500, 3.00, 23.00, 'SAR', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
    [id, big.id, o.user.id],
  );
  const paid = await mod.orders.settle(db.pool, { orderId: ins.insertId, provider: 'manual', providerRef: `adm-${ins.insertId}`, amount: 2300, currency: 'SAR' });
  assert.equal(paid.status, 'paid');
  assert.equal((await officeRow(id)).status, 'suspended', 'still suspended by the admin');

  assert.equal((await apost(`/admin/offices/${id}/unsuspend`, { reason: '' })).status, 422);
  assert.equal((await apost(`/admin/offices/${id}/unsuspend`, { reason: 'تمت التسوية' })).location, `/admin/offices/${id}?done=unsuspend`);
  assert.equal((await officeRow(id)).status, 'active', 'it has a paid period, so it is active again');
  assert.equal(afterOf(await lastAudit('admin.office.unsuspend', id)).reason, 'تمت التسوية');
  assert.equal((await http.request('/office/contracts', { cookie: o.cookie })).status, 200);

  // Extending a trial only works for trial offices.
  assert.equal((await apost(`/admin/offices/${id}/extend-trial`, { days: '3', reason: 'محاولة' })).status, 422);

  // Notes: stored for the admin, the audit row carries the reason, the page shows them.
  assert.equal((await apost(`/admin/offices/${id}/note`, { body: 'x' })).status, 422);
  assert.equal((await apost(`/admin/offices/${id}/note`, { body: 'اتصلنا بالمالك واتفقنا على التجديد' })).location, `/admin/offices/${id}?done=note`);
  assert.equal(await count("SELECT COUNT(*) FROM internal_notes WHERE office_id = ? AND entity_type = 'office'", [id]), 1);
  assert.match((await aget(`/admin/offices/${id}`)).text, /اتفقنا على التجديد/);
  assert.equal(afterOf(await lastAudit('admin.office.note', id)).reason, 'اتصلنا بالمالك واتفقنا على التجديد');
  // Notes are office-scoped: a landlord/tenant/office user never sees them (no route for them).
  assert.equal((await http.request(`/office/billing`, { cookie: o.cookie })).text.includes('اتفقنا على التجديد'), false);
});

// ------------------------------------------------------------ orders, invoices, credit notes, transfers

test('orders page, invoices and credit notes through the admin UI', { skip }, async () => {
  const o = await newOffice(8, 'اختبار-إدارة-طلبات');
  const [ins] = await db.pool.query(
    `INSERT INTO orders (office_id, plan_id, plan_code, billing_interval, method, status, subtotal, vat_rate_bp, vat_amount, total, currency, created_by, expires_at)
     VALUES (?, ?, 'adm_small', 'monthly', 'moyasar', 'pending', 10.00, 1500, 1.50, 11.50, 'SAR', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
    [o.office.id, planA.id, o.user.id],
  );
  const settled = await mod.orders.settle(db.pool, { orderId: ins.insertId, provider: 'moyasar', providerRef: `adm-pay-${ins.insertId}`, amount: 1150, currency: 'SAR', last4: '4242' });
  assert.equal(settled.status, 'paid');
  const orders = await aget('/admin/orders?status=paid&method=moyasar');
  assert.match(orders.text, /اختبار-إدارة-طلبات/);
  assert.match(orders.text, new RegExp(settled.invoiceNo));
  assert.match(orders.text, /\*\*\*\*4242/);
  assert.equal((await aget('/admin/orders?suspicious=1')).status, 200);

  const invoicePage = await aget(`/admin/invoices/${settled.invoiceId}`);
  assert.equal(invoicePage.status, 200);
  assert.match(invoicePage.text, new RegExp(settled.invoiceNo));

  assert.equal((await apost(`/admin/invoices/${settled.invoiceId}/credit-note`, { reason: '' })).status, 422);
  assert.equal(await count("SELECT COUNT(*) FROM subscription_invoices WHERE kind = 'credit_note' AND credit_for_id = ?", [settled.invoiceId]), 0);
  const credit = await apost(`/admin/invoices/${settled.invoiceId}/credit-note`, { reason: 'استرداد بناءً على طلب العميل' });
  assert.equal(credit.location, '/admin/orders?done=credit');
  const note = await one("SELECT * FROM subscription_invoices WHERE kind = 'credit_note' AND credit_for_id = ?", [settled.invoiceId]);
  assert.match(note.invoice_no, /^CN-/);
  assert.equal(Number(note.total), -11.5);
  const row = await lastAudit('admin.invoice.credit_note', o.office.id);
  assert.equal(afterOf(row).reason, 'استرداد بناءً على طلب العميل');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_paid' AND title LIKE '%إشعار دائن%'", [o.user.id]), 1);
  const again = await apost(`/admin/invoices/${settled.invoiceId}/credit-note`, { reason: 'مرة ثانية' });
  assert.equal(again.status, 409);
  // The office sees its credit note and its original invoice.
  const mine = await http.request('/office/billing', { cookie: o.cookie });
  assert.match(mine.text, new RegExp(note.invoice_no));
  assert.equal((await http.request(`/office/billing/invoices/${note.id}`, { cookie: o.cookie })).status, 200);
});

test('bank-transfer queue: approve and reject need a reason, both are audit-logged, the receipt opens for the admin', { skip }, async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aaaaaa' } }).png().toBuffer();
  const o = await newOffice(9, 'اختبار-إدارة-حوالة');
  const [[plan]] = await db.pool.query("SELECT id FROM plans WHERE code = 'adm_big'");
  const mk = async (reference, withReceipt) => {
    const created = await mod.orders.createOrder(db.pool, { officeId: o.office.id, userId: o.user.id, planId: plan.id, interval: 'monthly', method: 'bank_transfer' });
    assert.equal(created.ok, true, JSON.stringify(created));
    const sent = await mod.transfers.submit(db.pool, {
      officeId: o.office.id, orderId: created.order.id, userId: o.user.id, reference, receipt: withReceipt ? { data: png } : null,
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    return sent.id;
  };
  const first = await mk('ADM-REF-1', true);
  const queue = await aget('/admin/transfers?status=pending');
  assert.match(queue.text, /ADM-REF-1/);
  assert.match(queue.text, /اختبار-إدارة-حوالة/);
  assert.match(queue.text, new RegExp(`/admin/transfers/${first}/receipt`));
  const receipt = await fx.get(`/admin/transfers/${first}/receipt`, admin.cookie);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.type, 'image/jpeg');
  assert.equal((await fx.get(`/admin/transfers/${first}/receipt`, o.cookie)).status, 403);

  assert.equal((await apost(`/admin/transfers/${first}/approve`, { reason: '' })).status, 422);
  assert.equal((await one('SELECT status FROM bank_transfers WHERE id = ?', [first])).status, 'pending');
  assert.equal((await apost(`/admin/transfers/${first}/approve`, { reason: 'وصلت الحوالة في كشف البنك' })).location, '/admin/transfers?done=approved');
  assert.equal((await one('SELECT status FROM bank_transfers WHERE id = ?', [first])).status, 'approved');
  assert.equal(afterOf(await lastAudit('billing.transfer_approve', o.office.id)).reason, 'وصلت الحوالة في كشف البنك');
  assert.equal((await apost(`/admin/transfers/${first}/approve`, { reason: 'مرة ثانية' })).status, 422);

  const second = await mk('ADM-REF-2', false);
  assert.equal((await apost(`/admin/transfers/${second}/reject`, { reason: '' })).status, 422);
  assert.equal((await apost(`/admin/transfers/${second}/reject`, { reason: 'المبلغ ناقص' })).location, '/admin/transfers?done=rejected');
  assert.equal(afterOf(await lastAudit('billing.transfer_reject', o.office.id)).reason, 'المبلغ ناقص');
  assert.match((await aget('/admin/transfers?status=rejected')).text, /ADM-REF-2/);
});

// ------------------------------------------------------------ promos and plans

test('promo codes: create, validate, edit, deactivate, with a reason and an audit row each time', { skip }, async () => {
  const form = { code: 'admpromo1', discount_type: 'percent', percent: '15', fixed: '', valid_from: '2026-01-01', valid_to: '2026-12-31', max_redemptions: '10', is_active: '1', note: 'حملة', reason: 'حملة الافتتاح' };
  assert.equal((await apost('/admin/promos', { ...form, reason: '' })).status, 422);
  assert.equal((await apost('/admin/promos', { ...form, percent: '150' })).status, 422);
  assert.equal(await count("SELECT COUNT(*) FROM promo_codes WHERE code = 'ADMPROMO1'"), 0);
  const created = await apost('/admin/promos', form);
  assert.equal(created.location, '/admin/promos?done=created');
  const promo = await one("SELECT * FROM promo_codes WHERE code = 'ADMPROMO1'");
  assert.equal(promo.percent_bp, 1500);
  assert.equal(promo.max_redemptions, 10);
  assert.equal(afterOf(await lastAudit('admin.promo.create')).reason, 'حملة الافتتاح');
  assert.equal((await apost('/admin/promos', form)).status, 422, 'the same code twice');
  assert.match((await aget('/admin/promos')).text, /ADMPROMO1/);
  assert.match((await aget(`/admin/promos/${promo.id}`)).text, /ADMPROMO1/);
  // Edit (the code itself cannot change), then deactivate.
  assert.equal((await apost(`/admin/promos/${promo.id}`, { ...form, code: 'ADMOTHER', percent: '20', reason: '' })).status, 422);
  assert.equal((await apost(`/admin/promos/${promo.id}`, { ...form, code: 'ADMOTHER', percent: '20', is_active: '', reason: 'إيقاف الحملة' })).location, '/admin/promos?done=saved');
  const edited = await one('SELECT * FROM promo_codes WHERE id = ?', [promo.id]);
  assert.equal(edited.code, 'ADMPROMO1');
  assert.equal(edited.percent_bp, 2000);
  assert.equal(edited.is_active, 0);
  assert.equal(afterOf(await lastAudit('admin.promo.update')).reason, 'إيقاف الحملة');
});

test('plans: create, edit (applies at once), delete only when unused, each with a reason and an audit row', { skip }, async () => {
  const form = {
    code: 'adm_new', name_ar: 'اختبار باقة جديدة', price_monthly: '30', price_yearly: '300', max_units: '5', max_contracts: '', max_members: '2', max_ai_reads_monthly: '', max_photos: '',
    feature_whatsapp: '1', feature_reports_csv: '1', is_public: '1', is_active: '1', sort_order: '9', reason: 'باقة جديدة',
  };
  assert.equal((await apost('/admin/plans', { ...form, reason: '' })).status, 422);
  assert.equal((await apost('/admin/plans', { ...form, price_monthly: 'abc' })).status, 422);
  assert.equal((await apost('/admin/plans', { ...form, code: 'Bad Code' })).status, 422);
  assert.equal((await apost('/admin/plans', form)).location, '/admin/plans?done=created');
  const plan = await one("SELECT * FROM plans WHERE code = 'adm_new'");
  assert.equal(Number(plan.price_monthly), 30);
  assert.equal(plan.max_units, 5);
  assert.equal(plan.max_contracts, null);
  const features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;
  assert.deepEqual(features, { whatsapp: true, telegram: false, reports_csv: true, ai_reading: false });
  assert.equal((await apost('/admin/plans', form)).status, 422, 'duplicate code');
  assert.equal(afterOf(await lastAudit('admin.plan.create')).reason, 'باقة جديدة');
  assert.match((await aget('/admin/plans')).text, /اختبار باقة جديدة/);

  // Edit: a subscriber sees the new limit immediately.
  const o = await newOffice(10, 'اختبار-إدارة-باقة');
  await db.pool.query('UPDATE offices SET plan_id = ? WHERE id = ?', [plan.id, o.office.id]);
  const scoped = require('../services/scopeToOffice').scopeToOffice(db.pool, o.office.id);
  const planLimits = require('../services/planLimits');
  assert.equal((await planLimits.unitUsage(scoped)).limit, 5);
  assert.equal((await apost(`/admin/plans/${plan.id}`, { ...form, max_units: '8', reason: '' })).status, 422);
  assert.equal((await apost(`/admin/plans/${plan.id}`, { ...form, max_units: '8', reason: 'رفع حد الوحدات' })).location, '/admin/plans?done=saved');
  assert.equal((await planLimits.unitUsage(scoped)).limit, 8);
  const row = await lastAudit('admin.plan.update');
  assert.equal(afterOf(row).max_units, 8);
  assert.equal(typeof row.before_json === 'string' ? JSON.parse(row.before_json).max_units : row.before_json.max_units, 5);
  assert.equal(afterOf(row).reason, 'رفع حد الوحدات');

  // Delete: refused while an office uses it, allowed once nothing points at it.
  assert.equal((await apost(`/admin/plans/${plan.id}/delete`, { reason: '' })).status, 422);
  assert.equal((await apost(`/admin/plans/${plan.id}/delete`, { reason: 'حذف تجريبي' })).status, 409);
  await db.pool.query('UPDATE offices SET plan_id = NULL WHERE id = ?', [o.office.id]);
  await db.pool.query('DELETE FROM subscriptions WHERE plan_id = ?', [plan.id]);
  assert.equal((await apost(`/admin/plans/${plan.id}/delete`, { reason: 'حذف تجريبي' })).location, '/admin/plans?done=deleted');
  assert.equal(await count("SELECT COUNT(*) FROM plans WHERE code = 'adm_new'"), 0);
  assert.equal(afterOf(await lastAudit('admin.plan.delete')).reason, 'حذف تجريبي');
});

// ------------------------------------------------------------ platform settings and kill switches

test('seller details: editable by the platform admin only, validated, empty-safe, audit holds names not values', { skip }, async () => {
  const owner = await newOffice(11, 'اختبار-إدارة-إعدادات');
  assert.equal((await http.request('/admin/settings/details', { method: 'POST', cookie: owner.cookie, form: { legal_name: 'شركة', reason: 'محاولة' } })).status, 403);
  assert.equal(await count("SELECT COUNT(*) FROM settings WHERE setting_key = 'seller.legal_name' AND setting_value = 'شركة'"), 0);

  const base = { legal_name: 'شركة اختبار للبرمجيات', vat_number: '', address: 'الرياض - حي تجريبي', cr_number: '', bank_name: '', bank_account_name: '', bank_iban: '', support_phone: '', support_email: '', reason: 'ضبط بيانات الفاتورة' };
  assert.equal((await apost('/admin/settings/details', { ...base, reason: '' })).status, 422);
  const bad = await apost('/admin/settings/details', { ...base, vat_number: '12345' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /الرقم الضريبي يتكون من 15 رقماً/);
  assert.equal((await apost('/admin/settings/details', { ...base, bank_iban: 'XX12' })).status, 422);
  assert.equal((await apost('/admin/settings/details', base)).location, '/admin/settings?done=saved');
  mod.settings.invalidate();
  const seller = await mod.settings.seller(db.pool);
  assert.equal(seller.legal_name, 'شركة اختبار للبرمجيات');
  assert.equal(seller.vat_number, '', 'an empty VAT number stays empty: invoices are receipts');
  const row = await lastAudit('admin.settings.details');
  assert.equal(afterOf(row).reason, 'ضبط بيانات الفاتورة');
  assert.ok(afterOf(row).changed.includes('seller.legal_name'));
  assert.equal(JSON.stringify(row).includes('شركة اختبار للبرمجيات'), false, 'values are not in the audit row');
  assert.match((await aget('/admin/settings')).text, /شركة اختبار للبرمجيات/);
  await db.pool.query("DELETE FROM settings WHERE setting_key IN ('seller.legal_name', 'seller.address')");
  mod.settings.invalidate();
});

test('kill switches: the form maps to stored values, the banner is cleaned and shown; the switches act through the services', { skip }, async () => {
  const k = mod.settings.KEYS;
  assert.deepEqual(mod.settings.switchValues({ signups_disabled: '1', banner: '  صيانة  مجدولة\n الليلة ' }), { [k.signupsDisabled]: '1', [k.aiDisabled]: '0', [k.bannerMessage]: 'صيانة مجدولة الليلة' });
  assert.deepEqual(mod.settings.switchValues({}), { [k.signupsDisabled]: '0', [k.aiDisabled]: '0', [k.bannerMessage]: '' });

  // The form needs a reason; with one it saves exactly what is on the form (all off here, so no other test is affected).
  assert.equal((await apost('/admin/settings/switches', { banner: 'رسالة' })).status, 422);
  const saved = await apost('/admin/settings/switches', { banner: 'صيانة قصيرة الليلة', reason: 'إعلان صيانة' });
  assert.equal(saved.location, '/admin/settings?done=saved');
  assert.equal(await count("SELECT COUNT(*) FROM settings WHERE setting_key = 'banner.message' AND setting_value = 'صيانة قصيرة الليلة'"), 1);
  const row = await lastAudit('admin.settings.switches');
  assert.equal(afterOf(row).reason, 'إعلان صيانة');
  assert.equal(afterOf(row).signups_disabled, false);
  // The banner shows on every page of this process, signed in or not.
  assert.match((await http.request('/login')).text, /صيانة قصيرة الليلة/);
  assert.match((await aget('/admin')).text, /صيانة قصيرة الليلة/);
  assert.match((await http.request('/office', { cookie: (await newOffice(12, 'اختبار-إدارة-بانر')).cookie })).text, /صيانة قصيرة الليلة/);
  await apost('/admin/settings/switches', { banner: '', reason: 'إزالة الإعلان' });
  assert.doesNotMatch((await http.request('/login')).text, /صيانة قصيرة الليلة/);

  // Signups off: a NEW phone is refused, an existing user and the admin phone are not (injected switch; the shared setting is untouched).
  const off = mod.auth.createAuthService({ signupsDisabled: async () => true });
  await assert.rejects(off.findOrCreateUser('966500001560'), (err) => err.code === 'signups_disabled');
  assert.equal(await count("SELECT COUNT(*) FROM users WHERE phone = '966500001560'"), 0, 'no user was created');
  const existing = await off.findOrCreateUser(phone(0));
  assert.equal(existing.role, 'platform_admin');
  const on = mod.auth.createAuthService({ signupsDisabled: async () => false });
  const fresh = await on.findOrCreateUser(phone(60));
  assert.equal(fresh.role, null);

  // AI reading off: the availability check says so before any plan or API key matters (stubbed settings read).
  const stub = { query: async () => [[{ setting_key: 'kill.ai_disabled', setting_value: '1' }]] };
  mod.settings.invalidate();
  const paused = await mod.features.aiAvailability(stub, 1);
  assert.deepEqual(paused, { available: false, message: mod.features.AI_PAUSED_MESSAGE });
  mod.settings.invalidate();
  const o = await newOffice(13, 'اختبار-إدارة-ذكاء');
  assert.equal((await mod.features.aiAvailability(db.pool, o.office.id)).available, true, 'on by default');
});

// ------------------------------------------------------------ audit viewer and the reason rule

test('audit viewer: filters by action, office, actor and date; non-admins cannot read it', { skip }, async () => {
  const o = await newOffice(14, 'اختبار-إدارة-سجل');
  await apost(`/admin/offices/${o.office.id}/extend-trial`, { days: '2', reason: 'سبب ظاهر في السجل' });
  const all = await aget(`/admin/audit?action=admin.office&office=${o.office.id}`);
  assert.equal(all.status, 200);
  assert.match(all.text, /admin\.office\.extend_trial/);
  assert.match(all.text, /سبب ظاهر في السجل/);
  assert.match(all.text, /اختبار-إدارة-سجل/);
  const other = await aget(`/admin/audit?action=admin.promo&office=${o.office.id}`);
  assert.doesNotMatch(other.text, /extend_trial/);
  const byActor = await aget(`/admin/audit?actor=${phone(0)}&office=${o.office.id}`);
  assert.match(byActor.text, /extend_trial/);
  const none = await aget(`/admin/audit?actor=966500009999&office=${o.office.id}`);
  assert.doesNotMatch(none.text, /extend_trial/);
  const today = new Date().toISOString().slice(0, 10);
  assert.match((await aget(`/admin/audit?office=${o.office.id}&from=${today}&to=${today}`)).text, /extend_trial/);
  assert.doesNotMatch((await aget(`/admin/audit?office=${o.office.id}&from=2020-01-01&to=2020-01-02`)).text, /extend_trial/);
  assert.equal((await aget('/admin/audit?page=999&from=garbage')).status, 200, 'bad filters fall back instead of failing');
  assert.equal((await http.request('/admin/audit', { cookie: o.cookie })).status, 403);
});

test('every admin action in this run was audit-logged with a reason and the admin as actor', { skip }, async () => {
  const [rows] = await db.pool.query(
    "SELECT action, actor_id, after_json FROM audit_logs WHERE id > ? AND (action LIKE 'admin.%' OR action IN ('billing.transfer_approve', 'billing.transfer_reject'))",
    [auditStart],
  );
  const actions = new Set(rows.map((r) => r.action));
  for (const expected of [
    'admin.office.extend_trial', 'admin.office.change_plan', 'admin.office.suspend', 'admin.office.unsuspend', 'admin.office.note',
    'admin.invoice.credit_note', 'admin.promo.create', 'admin.promo.update', 'admin.plan.create', 'admin.plan.update', 'admin.plan.delete',
    'admin.settings.details', 'admin.settings.switches', 'billing.transfer_approve', 'billing.transfer_reject',
  ]) assert.ok(actions.has(expected), `${expected} was audit-logged`);
  for (const r of rows) {
    assert.equal(r.actor_id, admin.user.id, `${r.action}: actor`);
    const reason = afterOf(r).reason;
    assert.equal(typeof reason, 'string', `${r.action}: reason`);
    assert.ok(reason.trim().length >= 3, `${r.action}: reason length`);
  }
});
