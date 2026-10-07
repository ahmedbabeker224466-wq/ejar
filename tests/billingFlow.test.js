'use strict';

// Subscription billing against real MySQL with Moyasar mocked (the real API is
// never called): checkout, redirect callback and webhook, amount checks,
// idempotency, concurrency, promo codes, invoices and credit notes, bank
// transfers, the plan lifecycle with a fixed clock, plan features and the
// "no secrets or card data anywhere" check. Runs only when TEST_DB_NAME is set.

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

// Every phone this file signs in with: 9665000014NN.
const phone = (n) => `9665000014${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const ADMIN = 99;

const KEYS = { MOYASAR_SECRET_KEY: 'sk_test_flowsecret0001', MOYASAR_PUBLISHABLE_KEY: 'pk_test_flowpub0001', MOYASAR_WEBHOOK_SECRET: 'whsec_flow_0001' };
const saved = {};
const logs = [];
const realLog = { log: console.log, error: console.error };
let db;
let http;
let fx;
let mod; // the services under test
let uploadDir;
let basic; // plan rows
let small;
let adminUser;

// What the mocked Moyasar knows: payment id -> payment body.
const payments = new Map();
let paymentSeq = 0;
const newPaymentId = () => `00000000-0000-4000-8000-${String(++paymentSeq + Date.now() % 100000).padStart(12, '0')}`;

function setPayment(order, { status = 'paid', amount = order.totalHalalas ?? order.total, currency = 'SAR', last4 = '1111', orderId = order.id } = {}) {
  const id = newPaymentId();
  payments.set(id, {
    id, status, amount, currency, source: { type: 'creditcard', number: `411111XXXXXX${last4}`, name: 'CARD HOLDER NAME', company: 'visa' }, metadata: { order_id: String(orderId) },
  });
  return id;
}

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'UPLOAD_DIR', 'CLAUDE_API_KEY', ...Object.keys(KEYS)]) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  Object.assign(process.env, KEYS);
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-receipts-'));
  process.env.UPLOAD_DIR = uploadDir;
  // Capture what the app logs, to check later that no secret or card data is in it.
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { logs.push(args.join(' ')); };

  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_members, max_ai_reads_monthly, max_photos, features, is_public, is_active, sort_order)
     VALUES ('bt_basic', 'اختبار أساسية', 99, 990, NULL, NULL, NULL, NULL, NULL, '{"whatsapp":true,"telegram":true,"reports_csv":true,"ai_reading":true}', 1, 1, 201),
            ('bt_small', 'اختبار صغيرة', 49, 490, 2, 1, 1, NULL, NULL, '{"whatsapp":false,"telegram":false,"reports_csv":false,"ai_reading":false}', 1, 1, 202)
     ON DUPLICATE KEY UPDATE price_monthly = VALUES(price_monthly), price_yearly = VALUES(price_yearly), max_units = VALUES(max_units),
       max_contracts = VALUES(max_contracts), max_members = VALUES(max_members), features = VALUES(features), is_public = 1, is_active = 1`,
  );
  [[basic]] = await db.pool.query("SELECT * FROM plans WHERE code = 'bt_basic'");
  [[small]] = await db.pool.query("SELECT * FROM plans WHERE code = 'bt_small'");
  await db.pool.query("INSERT INTO users (phone, role, phone_verified) VALUES (?, 'platform_admin', 1)", [phone(ADMIN)]);
  adminUser = await (async () => (await db.pool.query('SELECT * FROM users WHERE phone = ?', [phone(ADMIN)]))[0][0])();

  mod = {
    moyasar: require('../services/moyasar'),
    orders: require('../services/orders'),
    promos: require('../services/promos'),
    invoices: require('../services/invoices'),
    subs: require('../services/subscriptions'),
    transfers: require('../services/bankTransfers'),
    settings: require('../services/platformSettings'),
    plans: require('../services/plans'),
    planLimits: require('../services/planLimits'),
    scope: require('../services/scopeToOffice'),
    notifications: require('../services/notifications'),
    delivery: require('../services/delivery'),
    dates: require('../services/contractDates'),
  };
  mod.moyasar.setTransport(async ({ url }) => {
    const id = decodeURIComponent(url.split('/').pop());
    return payments.has(id) ? { status: 200, body: JSON.stringify(payments.get(id)) } : { status: 404, body: '{}' };
  });
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'trial' });
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM promo_codes WHERE code LIKE 'BTF%'");
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'bt\\_%'");
  await db.pool.query("DELETE FROM settings WHERE setting_key = 'seller.vat_number'");
}

test.after(async () => {
  console.log = realLog.log;
  console.error = realLog.error;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (mod) mod.moyasar.setTransport(null);
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
  if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ helpers

const post = (p, cookie, form) => http.request(p, { method: 'POST', cookie, form });
const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const count = async (sql, params = []) => Number(Object.values(await one(sql, params))[0]);

async function webhook(body) {
  const res = await fetch(`${http.base()}/webhooks/moyasar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual',
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const hook = (paymentId, secret = KEYS.MOYASAR_WEBHOOK_SECRET) => webhook({ id: 'evt', type: 'payment_paid', secret_token: secret, data: { id: paymentId } });

/** An office on the trial plan. */
const newOffice = (n, name = `تجربة-دفع-${n}`) => fx.office(n, name, { landlords: 0, units: 0 });

/** Creates an order over HTTP. Returns the order row. */
async function buy(office, plan, { interval = 'monthly', method = 'moyasar', promo = '' } = {}) {
  const res = await post('/office/billing/orders', office.cookie, { plan: String(plan.id), interval, method, promo });
  assert.equal(res.status, 302, res.text.slice(0, 400));
  const id = Number(/orders\/(\d+)\//.exec(res.location)[1]);
  return mod.orders.getAny(db.pool, id);
}

const officeRow = (id) => one('SELECT * FROM offices WHERE id = ?', [id]);

// ------------------------------------------------------------ the trial row

test('a new office gets a trialing subscription row that ends with its trial', { skip }, async () => {
  const o = await newOffice(1);
  const rows = (await db.pool.query('SELECT * FROM subscriptions WHERE office_id = ?', [o.office.id]))[0];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'trialing');
  assert.equal(new Date(rows[0].period_end).getTime(), new Date((await officeRow(o.office.id)).trial_ends_at).getTime());
  assert.equal(Number(rows[0].price), 0);
});

// ------------------------------------------------------------ billing page and checkout

test('billing page: plan, usage, plans to buy, quote with VAT and promo before payment; owner only', { skip }, async () => {
  const o = await newOffice(2);
  const page = await http.request('/office/billing', { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /تجربة مجانية/);
  assert.match(page.text, /اختبار أساسية/);
  assert.match(page.text, /فيما يلي|الفواتير/);

  const checkout = await http.request(`/office/billing/checkout?plan=${basic.id}&interval=monthly`, { cookie: o.cookie });
  assert.equal(checkout.status, 200);
  assert.match(checkout.text, /99\.00/);
  assert.match(checkout.text, /14\.85/); // 15% VAT
  assert.match(checkout.text, /113\.85/);
  assert.match(checkout.text, /ادفع بالبطاقة/);

  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, is_active) VALUES ('BTFPREVIEW', 'percent', 1000, 1)");
  const withPromo = await http.request(`/office/billing/checkout?plan=${basic.id}&interval=monthly&promo=btfpreview`, { cookie: o.cookie });
  assert.match(withPromo.text, /9\.90/); // 10% of 99.00
  assert.match(withPromo.text, /13\.36|13\.37/); // VAT of 89.10
  assert.match(withPromo.text, /102\.46|102\.47/);
  const bad = await http.request(`/office/billing/checkout?plan=${basic.id}&interval=monthly&promo=NOPE`, { cookie: o.cookie });
  assert.match(bad.text, /رمز الخصم غير صحيح/);

  // Managers and staff cannot open billing (server side).
  const manager = await http.addMember(o.office.id, phone(90), 'office_manager');
  assert.equal((await http.request('/office/billing', { cookie: manager })).status, 403);
  assert.equal((await post('/office/billing/orders', manager, { plan: String(basic.id), interval: 'monthly', method: 'moyasar' })).status, 403);
  assert.equal((await http.request('/office/billing')).status, 302, 'signed out goes to login');
});

// ------------------------------------------------------------ Moyasar: callback, webhook, idempotency

test('card payment: the redirect is verified by fetching the payment; the plan, invoice and notice follow', { skip }, async () => {
  const o = await newOffice(3);
  const order = await buy(o, basic);
  assert.equal(order.status, 'pending');
  assert.equal(order.total, 11385);

  const pay = await fx.get(`/office/billing/orders/${order.id}/pay`, o.cookie);
  assert.equal(pay.status, 200);
  const html = pay.body.toString('utf8');
  assert.match(html, /pk_test_flowpub0001/);
  assert.equal(html.includes('sk_test_flowsecret0001'), false, 'the secret key is never sent to the browser');
  assert.equal(html.includes('whsec_flow_0001'), false);
  const csp = pay.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/cdn\.moyasar\.com/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.moyasar\.com/);

  const paymentId = setPayment(order);
  const back = await http.request(`/office/billing/moyasar/callback?id=${paymentId}&status=paid&message=ok`, { cookie: o.cookie });
  assert.equal(back.location, '/office/billing?notice=paid');

  const after = await officeRow(o.office.id);
  assert.equal(after.status, 'active');
  assert.equal(Number(after.plan_id), Number(basic.id));
  assert.ok(new Date(after.subscription_ends_at) > new Date());
  const paid = await mod.orders.getAny(db.pool, order.id);
  assert.equal(paid.status, 'paid');
  const payment = await one('SELECT * FROM platform_payments WHERE provider_ref = ?', [paymentId]);
  assert.equal(payment.status, 'paid');
  assert.equal(payment.card_last4, '1111');
  assert.equal(Number(payment.amount), 113.85);
  const invoice = await one('SELECT * FROM subscription_invoices WHERE order_id = ?', [order.id]);
  assert.match(invoice.invoice_no, /^INV-\d{4}-\d{6}$/);
  assert.equal(invoice.doc_title, 'إيصال دفع', 'no seller VAT number is set, so it is a receipt');
  assert.equal(invoice.buyer_name, o.office.name);
  assert.equal(Number(invoice.vat_amount), 14.85);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_paid'", [o.user.id]), 1);
  const subs = (await db.pool.query('SELECT status, ended_reason FROM subscriptions WHERE office_id = ? ORDER BY id', [o.office.id]))[0];
  assert.deepEqual(subs.map((s) => [s.status, s.ended_reason]), [['expired', 'trial_converted'], ['active', null]]);

  // The page now shows the plan, the invoice and the notice.
  const page = await http.request('/office/billing?notice=paid', { cookie: o.cookie });
  assert.match(page.text, /تم تأكيد الدفع/);
  assert.match(page.text, new RegExp(invoice.invoice_no));
});

test('a forged redirect proves nothing: an unknown payment id activates nothing', { skip }, async () => {
  const o = await newOffice(4);
  const order = await buy(o, basic);
  const forged = await http.request('/office/billing/moyasar/callback?id=11111111-1111-4111-8111-111111111111&status=paid', { cookie: o.cookie });
  assert.equal(forged.location, '/office/billing?notice=unverified');
  const garbage = await http.request('/office/billing/moyasar/callback?id=../../etc&status=paid', { cookie: o.cookie });
  assert.equal(garbage.location, '/office/billing?notice=unverified');
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'pending');
  assert.equal((await officeRow(o.office.id)).status, 'trial');
  // A paid payment of ANOTHER order, replayed here, cannot activate this one either.
  const other = await newOffice(5);
  const otherOrder = await buy(other, basic);
  const pid = setPayment(otherOrder, { orderId: otherOrder.id });
  const mine = await http.request(`/office/billing/moyasar/callback?id=${pid}&status=paid`, { cookie: o.cookie });
  assert.equal(mine.status, 404, 'another office\'s payment is not shown to this office');
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'pending');
});

test('webhook: wrong or missing secret is 404; a replay changes nothing', { skip }, async () => {
  const o = await newOffice(6);
  const order = await buy(o, basic);
  const pid = setPayment(order);

  assert.equal((await hook(pid, 'wrong')).status, 404);
  assert.equal((await webhook({ type: 'payment_paid', data: { id: pid } })).status, 404, 'no secret at all');
  assert.equal((await webhook({ secret_token: ['whsec_flow_0001'], data: { id: pid } })).status, 404);
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'pending', 'bad secrets did nothing');

  assert.equal((await hook(pid)).status, 200);
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'paid');
  const snapshot = async () => ({
    payments: await count('SELECT COUNT(*) FROM platform_payments WHERE office_id = ?', [o.office.id]),
    invoices: await count('SELECT COUNT(*) FROM subscription_invoices WHERE office_id = ?', [o.office.id]),
    subs: await count('SELECT COUNT(*) FROM subscriptions WHERE office_id = ?', [o.office.id]),
    ends: String((await officeRow(o.office.id)).subscription_ends_at),
    notes: await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_paid'", [o.user.id]),
  });
  const first = await snapshot();
  for (let i = 0; i < 3; i += 1) assert.equal((await hook(pid)).status, 200);
  assert.equal((await http.request(`/office/billing/moyasar/callback?id=${pid}`, { cookie: o.cookie })).location, '/office/billing?notice=paid');
  assert.deepEqual(await snapshot(), first, 'replays are no-ops');
});

test('webhook is off (404) when no webhook secret is configured', { skip }, async () => {
  const keep = process.env.MOYASAR_WEBHOOK_SECRET;
  process.env.MOYASAR_WEBHOOK_SECRET = '';
  try {
    assert.equal((await webhook({ secret_token: '', data: { id: 'x' } })).status, 404);
  } finally {
    process.env.MOYASAR_WEBHOOK_SECRET = keep;
  }
});

test('amount mismatch: suspicious, nothing activated, the platform admin is alerted', { skip }, async () => {
  const o = await newOffice(7);
  const order = await buy(o, basic);
  const pid = setPayment(order, { amount: 100 }); // paid 1.00 instead of 113.85
  assert.equal((await hook(pid)).status, 200);
  const row = await one('SELECT * FROM orders WHERE id = ?', [order.id]);
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.suspicious), 1);
  assert.equal(row.fail_reason, 'amount_mismatch');
  assert.equal((await officeRow(o.office.id)).status, 'trial', 'the plan was not activated');
  assert.equal(await count('SELECT COUNT(*) FROM subscription_invoices WHERE order_id = ?', [order.id]), 0);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_alert'", [adminUser.id]) >= 1, true);
  // Wrong currency and a payment that names another order are suspicious / refused too.
  const order2 = await buy(o, basic);
  assert.equal((await hook(setPayment(order2, { currency: 'USD' }))).status, 200);
  assert.equal(Number((await one('SELECT suspicious FROM orders WHERE id = ?', [order2.id])).suspicious), 1);
  // A suspicious order is not expired by the daily job.
  await db.pool.query("UPDATE orders SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?", [order.id]);
  await mod.subs.expireOrders({ pool: db.pool, officeId: o.office.id });
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'pending');
});

test('a failed payment marks the order failed and gives the promo back', { skip }, async () => {
  const o = await newOffice(8);
  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, max_redemptions, is_active) VALUES ('BTFFAIL', 'percent', 1000, 1, 1)");
  const order = await buy(o, basic, { promo: 'BTFFAIL' });
  assert.equal(order.discount, 990);
  assert.equal(await count("SELECT COUNT(*) FROM promo_usages WHERE order_id = ? AND status = 'reserved'", [order.id]), 1);
  const pid = setPayment(order, { status: 'failed' });
  assert.equal((await http.request(`/office/billing/moyasar/callback?id=${pid}&status=failed`, { cookie: o.cookie })).location, '/office/billing?notice=failed');
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'failed');
  assert.equal(await count('SELECT COUNT(*) FROM promo_usages WHERE order_id = ?', [order.id]), 0, 'the promo can be used again');
  assert.equal((await officeRow(o.office.id)).status, 'trial');
});

test('callback and webhook at the same moment activate once', { skip }, async () => {
  const o = await newOffice(9);
  const order = await buy(o, basic);
  const pid = setPayment(order);
  const results = await Promise.all([
    http.request(`/office/billing/moyasar/callback?id=${pid}`, { cookie: o.cookie }),
    hook(pid),
    hook(pid),
    http.request(`/office/billing/moyasar/callback?id=${pid}`, { cookie: o.cookie }),
  ]);
  assert.equal(results[1].status, 200);
  assert.equal(await count('SELECT COUNT(*) FROM platform_payments WHERE provider_ref = ?', [pid]), 1);
  assert.equal(await count('SELECT COUNT(*) FROM subscription_invoices WHERE order_id = ?', [order.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM subscriptions WHERE office_id = ? AND status = 'active'", [o.office.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_paid'", [o.user.id]), 1);
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'paid');
});

test('a second payment for an order that is already paid is flagged, not applied twice', { skip }, async () => {
  const o = await newOffice(10);
  const order = await buy(o, basic);
  await hook(setPayment(order));
  const endsBefore = String((await officeRow(o.office.id)).subscription_ends_at);
  await hook(setPayment(order)); // another payment id for the same order
  assert.equal(String((await officeRow(o.office.id)).subscription_ends_at), endsBefore);
  assert.equal(await count('SELECT COUNT(*) FROM subscription_invoices WHERE order_id = ?', [order.id]), 1);
  assert.equal(Number((await one('SELECT suspicious FROM orders WHERE id = ?', [order.id])).suspicious), 1);
});

test('payment keys missing: card payment is off with the Arabic message and bank transfer still works', { skip }, async () => {
  const o = await newOffice(11);
  const keep = process.env.MOYASAR_SECRET_KEY;
  process.env.MOYASAR_SECRET_KEY = '';
  try {
    const page = await http.request(`/office/billing/checkout?plan=${basic.id}&interval=monthly`, { cookie: o.cookie });
    assert.match(page.text, /الدفع الإلكتروني غير مفعّل/);
    assert.doesNotMatch(page.text, /ادفع بالبطاقة/);
    assert.match(page.text, /الدفع بالحوالة البنكية/);
    const card = await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'moyasar' });
    assert.equal(card.status, 422);
    assert.match(card.text, /الدفع الإلكتروني غير مفعّل/);
    assert.equal(await count('SELECT COUNT(*) FROM orders WHERE office_id = ?', [o.office.id]), 0);
    const transfer = await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'bank_transfer' });
    assert.equal(transfer.status, 302);
  } finally {
    process.env.MOYASAR_SECRET_KEY = keep;
  }
  // Live keys are refused.
  process.env.MOYASAR_SECRET_KEY = 'sk_live_notforthis0001';
  try {
    assert.equal(mod.moyasar.config().enabled, false);
  } finally {
    process.env.MOYASAR_SECRET_KEY = keep;
  }
});

// ------------------------------------------------------------ promo codes

test('promo: exact math on the order, per-office once, expired and inapplicable codes', { skip }, async () => {
  await db.pool.query(
    `INSERT INTO promo_codes (code, discount_type, percent_bp, fixed_amount, valid_from, valid_to, plan_ids, is_active) VALUES
       ('BTFPCT', 'percent', 1000, NULL, NULL, NULL, NULL, 1),
       ('BTFFIX', 'fixed', NULL, 25.50, NULL, NULL, NULL, 1),
       ('BTFOLD', 'percent', 1000, NULL, NULL, UTC_TIMESTAMP() - INTERVAL 1 HOUR, NULL, 1),
       ('BTFLATER', 'percent', 1000, NULL, UTC_TIMESTAMP() + INTERVAL 1 DAY, NULL, NULL, 1),
       ('BTFOFF', 'percent', 1000, NULL, NULL, NULL, NULL, 0),
       ('BTFOTHER', 'percent', 1000, NULL, NULL, NULL, JSON_ARRAY(${Number(small.id)}), 1)`,
  );
  const o = await newOffice(12);
  const pct = await buy(o, basic, { promo: 'btfpct' });
  assert.deepEqual([pct.subtotal, pct.discount, pct.vat, pct.total, pct.promoCode], [9900, 990, 1337, 10247, 'BTFPCT']);
  const fix = await buy(o, basic, { promo: 'BTFFIX' }); // replaces the unpaid order above and frees its code
  assert.deepEqual([fix.subtotal, fix.discount, fix.vat, fix.total], [9900, 2550, 1103, 8453]);
  assert.equal((await mod.orders.getAny(db.pool, pct.id)).status, 'expired');
  assert.equal(await count('SELECT COUNT(*) FROM promo_usages WHERE order_id = ?', [pct.id]), 0);

  for (const [code, reason] of [['BTFOLD', /انتهت/], ['BTFLATER', /لم يبدأ/], ['BTFOFF', /غير مفعّل/], ['BTFOTHER', /لا ينطبق/], ['NOPE', /غير صحيح/]]) {
    const res = await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'moyasar', promo: code });
    assert.equal(res.status, 422, code);
    assert.match(res.text, reason, code);
  }

  // Paid once, never again for the same office.
  await hook(setPayment(fix));
  assert.equal(await count("SELECT COUNT(*) FROM promo_usages WHERE order_id = ? AND status = 'redeemed'", [fix.id]), 1);
  const again = await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'moyasar', promo: 'BTFFIX' });
  assert.equal(again.status, 422);
  assert.match(again.text, /سبق أن استخدم/);
});

test('promo with max redemptions 1: two offices at the same moment, exactly one gets it', { skip }, async () => {
  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, max_redemptions, is_active) VALUES ('BTFMAX1', 'percent', 2000, 1, 1)");
  const offices = await Promise.all([newOffice(13), newOffice(14), newOffice(15), newOffice(16)]);
  const results = await Promise.all(offices.map((o) => mod.orders.createOrder(db.pool, {
    officeId: o.office.id, userId: o.user.id, planId: basic.id, interval: 'monthly', method: 'bank_transfer', promoCode: 'BTFMAX1',
  })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.error), ['promo', 'promo', 'promo']);
  assert.equal(await count("SELECT COUNT(*) FROM promo_usages WHERE promo_id = (SELECT id FROM promo_codes WHERE code = 'BTFMAX1')"), 1);
});

test('a 100% promo needs no payment: the plan is activated and a zero invoice is issued', { skip }, async () => {
  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, is_active) VALUES ('BTFFREE', 'percent', 10000, 1)");
  const o = await newOffice(17);
  const res = await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'bank_transfer', promo: 'BTFFREE' });
  assert.equal(res.location, '/office/billing?notice=free');
  assert.equal((await officeRow(o.office.id)).status, 'active');
  const invoice = await one('SELECT * FROM subscription_invoices WHERE office_id = ?', [o.office.id]);
  assert.equal(Number(invoice.total), 0);
});

// ------------------------------------------------------------ invoices

async function pendingOrder(office, plan = basic, total = '113.85') {
  const [result] = await db.pool.query(
    `INSERT INTO orders (office_id, plan_id, plan_code, billing_interval, method, status, subtotal, discount, vat_rate_bp, vat_amount, total, currency, created_by, expires_at)
     VALUES (?, ?, ?, 'monthly', 'moyasar', 'pending', 99.00, 0, 1500, 14.85, ?, 'SAR', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
    [office.office.id, plan.id, plan.code, total, office.user.id],
  );
  return Number(result.insertId);
}

test('invoice numbers are gap-free under parallel payments, and a rollback gives its number back', { skip }, async () => {
  const offices = await Promise.all([newOffice(20), newOffice(21), newOffice(22)]);
  const year = mod.dates.riyadhYear(new Date());
  const [before] = (await db.pool.query("SELECT last_number FROM invoice_counters WHERE series = 'INV' AND year = ?", [year]))[0];
  const start = before ? Number(before.last_number) : 0;
  const jobs = [];
  for (const o of offices) for (let i = 0; i < 4; i += 1) jobs.push(pendingOrder(o).then((orderId) => mod.orders.settle(db.pool, {
    orderId, provider: 'manual', providerRef: `flow-${orderId}`, amount: 11385, currency: 'SAR',
  })));
  const outcomes = await Promise.all(jobs);
  assert.ok(outcomes.every((r) => r.status === 'paid'), JSON.stringify(outcomes.map((r) => r.status)));
  const numbers = outcomes.map((r) => Number(r.invoiceNo.split('-')[2])).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => start + 1 + i), 'consecutive, none skipped, none repeated');
  assert.equal(new Set(outcomes.map((r) => r.invoiceNo)).size, 12);

  // A transaction that takes a number and rolls back leaves no hole.
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const taken = await mod.invoices.nextNumber(conn, 'invoice', year);
    assert.equal(taken, mod.invoices.formatNumber('invoice', year, start + 13));
    await conn.rollback();
  } finally {
    conn.release();
  }
  const next = await mod.invoices.nextNumber(db.pool, 'invoice', year);
  assert.equal(next, mod.invoices.formatNumber('invoice', year, start + 13), 'the rolled-back number was reused');
  await db.pool.query("UPDATE invoice_counters SET last_number = last_number - 1 WHERE series = 'INV' AND year = ?", [year]);
});

test('credit notes: negative lines, their own gap-free sequence, once per invoice', { skip }, async () => {
  const o = await newOffice(23);
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const orderId = await pendingOrder(o);
    const r = await mod.orders.settle(db.pool, { orderId, provider: 'manual', providerRef: `cn-${orderId}`, amount: 11385, currency: 'SAR' });
    ids.push(r.invoiceId);
  }
  const results = await Promise.all(ids.map((id) => mod.invoices.issueCreditNote(db.pool, { invoiceId: id, reason: 'استرداد تجريبي', issuedBy: adminUser.id })));
  assert.ok(results.every((r) => r.ok));
  const nums = results.map((r) => Number(r.invoiceNo.split('-')[2])).sort((a, b) => a - b);
  assert.equal(nums[1], nums[0] + 1, 'credit notes are consecutive');
  assert.match(results[0].invoiceNo, /^CN-\d{4}-\d{6}$/);
  const note = await one('SELECT * FROM subscription_invoices WHERE id = ?', [results[0].id]);
  assert.equal(note.kind, 'credit_note');
  assert.equal(Number(note.total), -113.85);
  assert.equal(Number(note.vat_amount), -14.85);
  assert.equal(Number(note.subtotal), -99);
  assert.ok(JSON.parse(typeof note.lines_json === 'string' ? note.lines_json : JSON.stringify(note.lines_json)).every((l) => l.net < 0));
  assert.equal((await one('SELECT status FROM subscription_invoices WHERE id = ?', [ids[0]])).status, 'credited');
  assert.equal((await one('SELECT status FROM platform_payments WHERE invoice_id = ?', [ids[0]])).status, 'refunded');
  assert.deepEqual(await mod.invoices.issueCreditNote(db.pool, { invoiceId: ids[0], reason: 'مرة ثانية', issuedBy: adminUser.id }), { ok: false, error: 'already_credited' });
  assert.deepEqual(await mod.invoices.issueCreditNote(db.pool, { invoiceId: results[0].id, reason: 'إشعار على إشعار', issuedBy: adminUser.id }), { ok: false, error: 'not_an_invoice' });
});

test('invoice page: owner only, ownership checked, receipt vs tax invoice follows the seller VAT number', { skip }, async () => {
  const a = await newOffice(24);
  const b = await newOffice(25);
  const order = await buy(a, basic);
  await hook(setPayment(order));
  const invoice = await one('SELECT * FROM subscription_invoices WHERE order_id = ?', [order.id]);

  const mine = await fx.get(`/office/billing/invoices/${invoice.id}`, a.cookie);
  assert.equal(mine.status, 200);
  const html = mine.body.toString('utf8');
  assert.match(html, /إيصال دفع/);
  assert.match(html, new RegExp(invoice.invoice_no));
  assert.doesNotMatch(html, /فاتورة ضريبية مبسطة/);
  assert.doesNotMatch(html, /ZATCA|زاتكا الإلكترونية المعتمدة|متوافق/);

  assert.equal((await fx.get(`/office/billing/invoices/${invoice.id}`, b.cookie)).status, 404, 'another office');
  assert.equal((await fx.get('/office/billing/invoices/abc', a.cookie)).status, 404);
  assert.equal((await fx.get(`/office/billing/invoices/${invoice.id}`)).status, 302, 'signed out');
  const staff = await http.addMember(a.office.id, phone(91), 'office_staff');
  assert.equal((await fx.get(`/office/billing/invoices/${invoice.id}`, staff)).status, 403);

  // With a seller VAT number set, the next one is a tax invoice; the old one keeps its snapshot.
  await mod.settings.save(db.pool, { [mod.settings.KEYS.sellerVatNumber]: '300000000000003' });
  try {
    const order2 = await buy(a, basic);
    await hook(setPayment(order2));
    const second = await one('SELECT * FROM subscription_invoices WHERE order_id = ?', [order2.id]);
    assert.equal(second.doc_title, 'فاتورة ضريبية مبسطة');
    assert.match((await fx.get(`/office/billing/invoices/${second.id}`, a.cookie)).body.toString('utf8'), /300000000000003/);
    assert.equal((await one('SELECT doc_title FROM subscription_invoices WHERE id = ?', [invoice.id])).doc_title, 'إيصال دفع');
  } finally {
    await mod.settings.save(db.pool, { [mod.settings.KEYS.sellerVatNumber]: '' });
  }
});

// ------------------------------------------------------------ bank transfer

async function receiptPng() {
  const sharp = require('sharp');
  return sharp({ create: { width: 30, height: 30, channels: 3, background: '#cccccc' } }).png().toBuffer();
}

test('bank transfer: reference rules, receipt re-encoded and served only to its office, admin approves, both sides notified', { skip }, async () => {
  const a = await newOffice(26);
  const b = await newOffice(27);
  const order = await buy(a, basic, { method: 'bank_transfer' });
  assert.equal(order.method, 'bank_transfer');
  const transferPage = await http.request(`/office/billing/orders/${order.id}/transfer`, { cookie: a.cookie });
  assert.equal(transferPage.status, 200);
  assert.match(transferPage.text, /113\.85/);

  for (const reference of ['SA0380000000608010167519', '1234567890123', '12 3456 7890 12', '', 'ab']) {
    const res = await fx.multipart(`/office/billing/orders/${order.id}/transfer`, a.cookie, { reference });
    assert.equal(res.status, 422, reference);
  }
  assert.equal(await count('SELECT COUNT(*) FROM bank_transfers WHERE order_id = ?', [order.id]), 0);
  const badImage = await fx.multipart(`/office/billing/orders/${order.id}/transfer`, a.cookie, { reference: 'REF-1' }, [{ field: 'receipt', name: 'x.png', type: 'image/png', data: Buffer.from('not an image at all, just text') }]);
  assert.equal(badImage.status, 422);

  const sent = await fx.multipart(`/office/billing/orders/${order.id}/transfer`, a.cookie, { reference: 'TRX-778' }, [{ field: 'receipt', name: 'r.png', type: 'image/png', data: await receiptPng() }]);
  assert.equal(sent.status, 302, sent.text.slice(0, 300));
  const transfer = await one('SELECT * FROM bank_transfers WHERE order_id = ?', [order.id]);
  assert.equal(transfer.status, 'pending');
  assert.equal(transfer.reference, 'TRX-778');
  assert.match(transfer.receipt_path, /^[0-9a-f-]{36}\.jpg$/);
  assert.ok(fs.existsSync(path.join(uploadDir, transfer.receipt_path)), 'stored outside public, under a random name');
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'pending');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_alert'", [adminUser.id]) >= 1, true, 'the admin is told');
  const dupe = await fx.multipart(`/office/billing/orders/${order.id}/transfer`, a.cookie, { reference: 'TRX-779' });
  assert.equal(dupe.status, 422);

  const receipt = await fx.get(`/office/billing/receipts/${transfer.id}`, a.cookie);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.type, 'image/jpeg');
  assert.equal((await fx.get(`/office/billing/receipts/${transfer.id}`, b.cookie)).status, 404, 'another office');
  assert.equal((await fx.get(`/office/billing/receipts/${transfer.id}`)).status, 302);
  assert.equal((await fx.get('/office/billing/orders/999999999/transfer', a.cookie)).status, 404);
  assert.equal((await fx.get(`/office/billing/orders/${order.id}/transfer`, b.cookie)).status, 404, 'another office\'s order');

  const approved = await mod.transfers.approve(db.pool, { transferId: transfer.id, adminId: adminUser.id, note: 'وصلت' });
  assert.equal(approved.ok, true);
  assert.equal((await officeRow(a.office.id)).status, 'active');
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'paid');
  assert.equal((await one('SELECT status FROM bank_transfers WHERE id = ?', [transfer.id])).status, 'approved');
  assert.equal(await count('SELECT COUNT(*) FROM subscription_invoices WHERE order_id = ?', [order.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'billing_paid'", [a.user.id]), 1, 'the office is told');
  assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE office_id = ? AND action = 'billing.transfer_approve' AND actor_id = ?", [a.office.id, adminUser.id]), 1);
  assert.deepEqual(await mod.transfers.approve(db.pool, { transferId: transfer.id, adminId: adminUser.id }), { ok: false, error: 'already_decided' });
  assert.equal((await mod.transfers.reject(db.pool, { transferId: transfer.id, adminId: adminUser.id, reason: 'متأخر' })).error, 'already_decided');
});

test('bank transfer rejected: the order fails, the promo is freed, the office is told with the reason', { skip }, async () => {
  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, max_redemptions, is_active) VALUES ('BTFREJ', 'percent', 1000, 1, 1)");
  const o = await newOffice(28);
  const order = await buy(o, basic, { method: 'bank_transfer', promo: 'BTFREJ' });
  const sent = await fx.multipart(`/office/billing/orders/${order.id}/transfer`, o.cookie, { reference: 'REJ-1' });
  assert.equal(sent.status, 302);
  const transfer = await one('SELECT * FROM bank_transfers WHERE order_id = ?', [order.id]);
  assert.equal((await mod.transfers.reject(db.pool, { transferId: transfer.id, adminId: adminUser.id, reason: '' })).error, 'reason');
  const rejected = await mod.transfers.reject(db.pool, { transferId: transfer.id, adminId: adminUser.id, reason: 'المبلغ غير مطابق' });
  assert.equal(rejected.ok, true);
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'failed');
  assert.equal(await count('SELECT COUNT(*) FROM promo_usages WHERE order_id = ?', [order.id]), 0);
  assert.equal((await officeRow(o.office.id)).status, 'trial');
  const note = await one("SELECT body FROM notifications WHERE user_id = ? AND kind = 'billing_transfer'", [o.user.id]);
  assert.match(note.body, /المبلغ غير مطابق/);
  assert.deepEqual(await mod.transfers.approve(db.pool, { transferId: transfer.id, adminId: adminUser.id }), { ok: false, error: 'already_decided' });
  // An unsent bank order expires on its own time; a sent one never does.
  const unsent = await buy(o, basic, { method: 'bank_transfer' });
  await db.pool.query('UPDATE orders SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [unsent.id]);
  await mod.subs.expireOrders({ pool: db.pool, officeId: o.office.id });
  assert.equal((await mod.orders.getAny(db.pool, unsent.id)).status, 'expired');
});

// ------------------------------------------------------------ plans: downgrade, immediate changes, features

test('downgrade is blocked with what to reduce, and nothing is deleted', { skip }, async () => {
  const o = await fx.office(29, 'تجربة-دفع-29', { landlords: 1, units: 3 });
  const before = await count('SELECT COUNT(*) FROM units WHERE office_id = ?', [o.office.id]);
  const res = await post('/office/billing/orders', o.cookie, { plan: String(small.id), interval: 'monthly', method: 'moyasar' });
  assert.equal(res.status, 422);
  assert.match(res.text, /الوحدات: لديك 3 والحد 2 \(قلّل 1 وحدة\)/);
  assert.match(res.text, /لن يُحذف شيء/);
  assert.equal(await count('SELECT COUNT(*) FROM orders WHERE office_id = ?', [o.office.id]), 0);
  assert.equal(await count('SELECT COUNT(*) FROM units WHERE office_id = ?', [o.office.id]), before);
  // The checkout page shows the same message and no pay buttons.
  const page = await http.request(`/office/billing/checkout?plan=${small.id}&interval=monthly`, { cookie: o.cookie });
  assert.match(page.text, /قلّل 1 وحدة/);
  assert.doesNotMatch(page.text, /ادفع بالبطاقة/);
  // Unavailable plans cannot be bought.
  await db.pool.query("UPDATE plans SET is_active = 0 WHERE code = 'bt_small'");
  try {
    assert.equal((await post('/office/billing/orders', o.cookie, { plan: String(small.id), interval: 'monthly', method: 'moyasar' })).location, '/office/billing');
  } finally {
    await db.pool.query("UPDATE plans SET is_active = 1 WHERE code = 'bt_small'");
  }
});

test('a plan edit applies to subscribers at once (limits are read live)', { skip }, async () => {
  const o = await newOffice(30);
  await db.pool.query('UPDATE offices SET plan_id = ? WHERE id = ?', [small.id, o.office.id]);
  const scoped = mod.scope.scopeToOffice(db.pool, o.office.id);
  assert.equal((await mod.planLimits.unitUsage(scoped)).limit, 2);
  try {
    await db.pool.query("UPDATE plans SET max_units = 50 WHERE code = 'bt_small'");
    assert.equal((await mod.planLimits.unitUsage(scoped)).limit, 50, 'no restart, no re-subscribe');
  } finally {
    await db.pool.query("UPDATE plans SET max_units = 2 WHERE code = 'bt_small'");
  }
});

test('plan features: AI reading, CSV downloads and WhatsApp/Telegram follow the plan', { skip }, async () => {
  const o = await newOffice(31);
  await db.pool.query('UPDATE offices SET plan_id = ? WHERE id = ?', [small.id, o.office.id]);
  process.env.CLAUDE_API_KEY = 'test-key-not-used';
  const aiPost = await fx.multipart('/office/contracts/new/ai', o.cookie, {}, [{ field: 'contract', name: 'c.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 fake pdf content here') }]);
  assert.equal(aiPost.status, 403);
  assert.match(aiPost.text, /باقتك لا تشمل قراءة العقد بالذكاء الاصطناعي/);
  assert.equal((await fx.get('/office/reports/csv/occupancy', o.cookie)).status, 403);
  assert.equal((await fx.get('/office/payments.csv', o.cookie)).status, 403);
  const wa = await post('/office/settings/reminders/whatsapp', o.cookie, { phone_number_id: '123', token: 'x', template_name: 't' });
  assert.equal(wa.status, 403);
  assert.match(wa.text, /باقتك لا تشمل واتساب/);
  assert.equal((await post('/office/settings/reminders/telegram', o.cookie, { token: 'x' })).status, 403);
  // On a plan that has them, the same requests go through.
  await db.pool.query('UPDATE offices SET plan_id = ? WHERE id = ?', [basic.id, o.office.id]);
  assert.equal((await fx.get('/office/reports/csv/occupancy', o.cookie)).status, 200);
  assert.equal((await fx.get('/office/payments.csv', o.cookie)).status, 200);
  delete process.env.CLAUDE_API_KEY;
});

// ------------------------------------------------------------ lifecycle with a fixed clock

test('lifecycle: renewal extends, reminders at 7/3/1 once each, expiry -> read-only grace -> suspended, payment restores', { skip }, async () => {
  const o = await newOffice(32);
  const T = new Date('2026-10-03T10:00:00Z');
  const orderId = await pendingOrder(o);
  const first = await mod.orders.settle(db.pool, { orderId, provider: 'manual', providerRef: `life-${orderId}`, amount: 11385, currency: 'SAR', now: T });
  assert.equal(first.status, 'paid');
  assert.equal(new Date(first.periodEnd).toISOString(), '2026-11-02T21:00:00.000Z');

  // Renewing while it runs starts where the old period ends.
  const orderId2 = await pendingOrder(o);
  const renewed = await mod.orders.settle(db.pool, { orderId: orderId2, provider: 'manual', providerRef: `life-${orderId2}`, amount: 11385, currency: 'SAR', now: new Date('2026-10-10T10:00:00Z') });
  assert.equal(new Date(renewed.periodEnd).toISOString(), '2026-12-02T21:00:00.000Z', 'one more month from the old end, nothing lost');
  assert.equal(await count("SELECT COUNT(*) FROM subscriptions WHERE office_id = ? AND status = 'active'", [o.office.id]), 1);
  assert.equal((await one("SELECT ended_reason FROM subscriptions WHERE office_id = ? AND status = 'expired' ORDER BY id DESC LIMIT 1", [o.office.id])).ended_reason, 'renewed');

  // Put the end back to 2026-11-02 for the clock walk below.
  await db.pool.query("UPDATE offices SET subscription_ends_at = '2026-11-02 21:00:00' WHERE id = ?", [o.office.id]);
  await db.pool.query("UPDATE subscriptions SET period_end = '2026-11-02 21:00:00' WHERE office_id = ? AND status = 'active'", [o.office.id]);
  const run = (iso) => mod.subs.runDaily({ pool: db.pool, officeId: o.office.id, now: new Date(iso) });
  const reminders = () => count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'sub_reminder'", [o.user.id]);

  assert.equal(await run('2026-10-20T06:00:00Z'), 0, 'nothing 13 days before');
  assert.equal(await run('2026-10-26T04:00:00Z'), 1, '7 days before the last day');
  assert.equal(await run('2026-10-26T05:00:00Z'), 0, 'idempotent the same day');
  assert.equal(await run('2026-10-30T04:00:00Z'), 1, '3 days before');
  assert.equal(await run('2026-11-01T04:00:00Z'), 1, '1 day before');
  assert.equal(await run('2026-11-01T05:00:00Z'), 0);
  assert.equal(await reminders(), 3);
  assert.equal((await officeRow(o.office.id)).status, 'active');

  // Expiry: past_due (read-only grace), owner told once.
  assert.equal(await run('2026-11-03T04:00:00Z'), 2, 'status change + notice');
  assert.equal(await run('2026-11-03T05:00:00Z'), 0, 'idempotent');
  assert.equal((await officeRow(o.office.id)).status, 'past_due');
  assert.equal(await count("SELECT COUNT(*) FROM subscriptions WHERE office_id = ? AND status = 'past_due'", [o.office.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'sub_expired'", [o.user.id]), 1);
  assert.equal(await run('2026-11-08T04:00:00Z'), 0, 'still inside the 7 days');
  assert.equal((await officeRow(o.office.id)).status, 'past_due');

  // After the grace: suspended, data kept.
  assert.equal(await run('2026-11-10T04:00:00Z'), 2);
  assert.equal(await run('2026-11-11T04:00:00Z'), 0);
  assert.equal((await officeRow(o.office.id)).status, 'suspended');
  assert.equal(await count("SELECT COUNT(*) FROM subscriptions WHERE office_id = ? AND status = 'expired' AND ended_reason = 'grace_over'", [o.office.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'sub_suspended'", [o.user.id]), 1);
  assert.equal(await count('SELECT COUNT(*) FROM office_members WHERE office_id = ?', [o.office.id]), 1, 'nothing was deleted');

  // Paying again brings it back.
  const orderId3 = await pendingOrder(o);
  const back = await mod.orders.settle(db.pool, { orderId: orderId3, provider: 'manual', providerRef: `life-${orderId3}`, amount: 11385, currency: 'SAR', now: new Date('2026-11-12T10:00:00Z') });
  assert.equal(back.status, 'paid');
  assert.equal((await officeRow(o.office.id)).status, 'active');
  assert.equal(new Date(back.periodEnd).toISOString(), '2026-12-11T21:00:00.000Z', 'a lapsed plan restarts from the payment day');
});

test('the daily job moves trial reminders too, and expires old unpaid orders (the card order, its promo)', { skip }, async () => {
  const o = await newOffice(33);
  await db.pool.query("UPDATE offices SET trial_ends_at = '2026-10-10 10:00:00' WHERE id = ?", [o.office.id]);
  assert.equal(await mod.subs.runDaily({ pool: db.pool, officeId: o.office.id, now: new Date('2026-10-07T04:00:00Z') }), 1, '3 days before the trial ends');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'sub_reminder'", [o.user.id]), 1);
  await db.pool.query("INSERT INTO promo_codes (code, discount_type, percent_bp, max_redemptions, is_active) VALUES ('BTFEXP', 'percent', 1000, 1, 1)");
  const order = await buy(o, basic, { promo: 'BTFEXP' });
  await db.pool.query('UPDATE orders SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [order.id]);
  await mod.subs.runDaily({ pool: db.pool, officeId: o.office.id, now: new Date() });
  assert.equal((await mod.orders.getAny(db.pool, order.id)).status, 'expired');
  assert.equal(await count('SELECT COUNT(*) FROM promo_usages WHERE order_id = ?', [order.id]), 0);
  // Cron wiring: the reserved placeholder is a real job now.
  const { JOBS } = require('../services/cron');
  assert.equal(Boolean(JOBS.plan_renewal.placeholder), false);
});

test('read-only grace blocks changes but keeps every page readable; after the grace everything but billing and settings is locked', { skip }, async () => {
  const o = await newOffice(34);
  await db.pool.query(
    "UPDATE offices SET status = 'active', plan_id = ?, subscription_ends_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?",
    [basic.id, o.office.id],
  );
  assert.equal((await http.request('/office/contracts', { cookie: o.cookie })).status, 200);
  assert.equal((await http.request('/office/landlords', { cookie: o.cookie })).status, 200);
  const home = await http.request('/office', { cookie: o.cookie });
  assert.match(home.text, /وضع القراءة فقط/);
  const blocked = await post('/office/landlords', o.cookie, { label: 'مالك جديد', city: 'جدة', phone: '0555555555' });
  assert.equal(blocked.status, 402);
  assert.match(blocked.text, /وضع القراءة فقط/);
  assert.equal(await count('SELECT COUNT(*) FROM landlords WHERE office_id = ?', [o.office.id]), 0);
  assert.equal((await http.request('/office/billing', { cookie: o.cookie })).status, 200, 'the owner can still pay');
  assert.equal((await post('/office/billing/orders', o.cookie, { plan: String(basic.id), interval: 'monthly', method: 'bank_transfer' })).status, 302);

  await db.pool.query('UPDATE offices SET subscription_ends_at = UTC_TIMESTAMP() - INTERVAL 9 DAY WHERE id = ?', [o.office.id]);
  const locked = await http.request('/office/contracts', { cookie: o.cookie });
  assert.equal(locked.status, 402);
  assert.match(locked.text, /اشتراكك منتهي/);
  assert.equal((await http.request('/office/billing', { cookie: o.cookie })).status, 200);
  assert.equal((await http.request('/office/settings', { cookie: o.cookie })).status, 200);
});

test('the amounts on orders and payments are exact decimals, and money columns carry SAR', { skip }, async () => {
  const o = await one("SELECT * FROM orders WHERE promo_code = 'BTFPCT' ORDER BY id DESC LIMIT 1");
  assert.equal(o.currency, 'SAR');
  assert.equal(o.total, '102.47');
  assert.equal(o.vat_rate_bp, 1500);
  const p = await one('SELECT currency FROM platform_payments ORDER BY id DESC LIMIT 1');
  assert.equal(p.currency, 'SAR');
});

// ------------------------------------------------------------ secrets and card data

test('no secret key, webhook secret, card number or cardholder name in the logs or the database', { skip }, async () => {
  const forbidden = [KEYS.MOYASAR_SECRET_KEY, KEYS.MOYASAR_WEBHOOK_SECRET, '411111XXXXXX1111', '4111111111111111', 'CARD HOLDER NAME'];
  const output = logs.join('\n');
  for (const needle of forbidden) assert.equal(output.includes(needle), false, `logs contain ${needle}`);

  const tables = {
    platform_payments: ['provider_ref', 'card_last4', 'currency', 'status'],
    orders: ['plan_code', 'fail_reason', 'promo_code'],
    audit_logs: ['action', 'before_json', 'after_json'],
    notifications: ['title', 'body'],
    delivery_log: ['error_code'],
    subscription_invoices: ['invoice_no', 'seller_json', 'lines_json', 'buyer_name', 'reason'],
    bank_transfers: ['reference', 'decision_note'],
  };
  for (const [table, columns] of Object.entries(tables)) {
    const [rows] = await db.pool.query(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id DESC LIMIT 5000`);
    const dump = JSON.stringify(rows);
    for (const needle of forbidden) assert.equal(dump.includes(needle), false, `${table} contains ${needle}`);
    assert.doesNotMatch(dump, /\b4\d{15}\b/, `${table}: a card-like number`);
  }
  // platform_payments has no column that could hold more than the id, status, amount and last 4.
  const [cols] = await db.pool.query("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'platform_payments'");
  assert.deepEqual(cols.map((c) => c.name).sort(), ['amount', 'card_last4', 'confirmed_by', 'created_at', 'currency', 'id', 'invoice_id', 'office_id', 'order_id', 'provider', 'provider_ref', 'status', 'updated_at']);
  // No page of the billing area leaks the keys either.
  const o = await newOffice(35);
  for (const p of ['/office/billing', `/office/billing/checkout?plan=${basic.id}`]) {
    const html = (await http.request(p, { cookie: o.cookie })).text;
    for (const needle of [KEYS.MOYASAR_SECRET_KEY, KEYS.MOYASAR_WEBHOOK_SECRET]) assert.equal(html.includes(needle), false, p);
  }
});
