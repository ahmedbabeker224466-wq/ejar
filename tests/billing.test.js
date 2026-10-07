'use strict';

// Billing rules that need no database: price and VAT math, plan limits and the
// downgrade check, the subscription clock (grace and suspension with a fixed
// time), promo rules, invoice titles and numbers, the Moyasar client with a
// mocked network, and the platform settings checks.

const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../services/pricing');
const plans = require('../services/plans');
const promos = require('../services/promos');
const invoices = require('../services/invoices');
const moyasar = require('../services/moyasar');
const platformSettings = require('../services/platformSettings');
const { periodState, planTransition, reminderThreshold } = require('../services/subscriptionState');
const { officeAccess } = require('../services/offices');
const dates = require('../services/contractDates');
const billing = require('../config/billing');

// ------------------------------------------------------------ price and VAT math

test('VAT is 15% in basis points, rounded half up, in whole halalas', () => {
  assert.equal(billing.VAT_RATE_BP, 1500);
  assert.equal(pricing.vatOf(9900), 1485); // 99.00 -> 14.85
  assert.equal(pricing.vatOf(1), 0); // 0.15 halala rounds down
  assert.equal(pricing.vatOf(4), 1); // 0.6 rounds up
  assert.equal(pricing.vatOf(3), 0); // 0.45 rounds down
  assert.equal(pricing.vatOf(10), 2); // 1.5 rounds half up
  assert.equal(pricing.vatOf(0), 0);
  // Deterministic: the same net always gives the same VAT.
  for (const net of [1, 99, 12345, 99999, 249000]) assert.equal(pricing.vatOf(net), pricing.vatOf(net));
  for (const net of [1, 7, 33, 101, 999, 24901]) {
    const vat = pricing.vatOf(net);
    assert.ok(Number.isInteger(vat));
    assert.ok(Math.abs(vat * 10000 - net * 1500) <= 5000, `rounding error under half a halala for ${net}`);
  }
});

test('quote: subtotal, discount, VAT on the discounted net, total', () => {
  assert.deepEqual(pricing.quote({ price: 9900 }), { subtotal: 9900, discount: 0, net: 9900, vat: 1485, vatBp: 1500, total: 11385 });
  const ten = pricing.quote({ price: 9999, promo: { discount_type: 'percent', percent_bp: 1000 } });
  assert.deepEqual([ten.discount, ten.net, ten.vat, ten.total], [1000, 8999, 1350, 10349]);
  const fixed = pricing.quote({ price: 9900, promo: { discount_type: 'fixed', fixed_halalas: 2500 } });
  assert.deepEqual([fixed.discount, fixed.net, fixed.vat, fixed.total], [2500, 7400, 1110, 8510]);
  // A fixed discount never goes below zero.
  const free = pricing.quote({ price: 9900, promo: { discount_type: 'fixed', fixed_halalas: 50000 } });
  assert.deepEqual([free.discount, free.net, free.vat, free.total], [9900, 0, 0, 0]);
  // 100% is free too.
  assert.equal(pricing.quote({ price: 9900, promo: { discount_type: 'percent', percent_bp: 10000 } }).total, 0);
});

test('yearly prices count as one twelfth per month in MRR', () => {
  assert.equal(pricing.monthlyEquivalent({ price_yearly: '990.00' }, 'yearly'), 8250);
  assert.equal(pricing.monthlyEquivalent({ price_monthly: '99.00' }, 'monthly'), 9900);
});

// ------------------------------------------------------------ plans

test('features: missing, null and the older array form mean allowed; false switches off', () => {
  assert.deepEqual(plans.normalizeFeatures(null), { whatsapp: true, telegram: true, reports_csv: true, ai_reading: true, listings: true });
  assert.equal(plans.planAllows({ features: ['contracts', 'reminders'] }, 'whatsapp'), true);
  assert.equal(plans.planAllows({ features: { whatsapp: false } }, 'whatsapp'), false);
  assert.equal(plans.planAllows({ features: '{"ai_reading":false}' }, 'ai_reading'), false);
  assert.equal(plans.planAllows({ features: { whatsapp: false } }, 'telegram'), true);
});

test('plan form: prices, limits (blank = unlimited), flags and the code', () => {
  const ok = plans.validatePlan({
    code: 'gold', name_ar: 'ذهبية', price_monthly: '149.50', price_yearly: '1,490', max_units: '', max_contracts: '300',
    max_members: '5', max_ai_reads_monthly: '', max_photos: '', feature_whatsapp: '1', is_public: '1', is_active: '1', sort_order: '5',
  }, { creating: true });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.priceMonthly, 14950);
  assert.equal(ok.values.priceYearly, 149000);
  assert.equal(ok.values.max_units, null);
  assert.equal(ok.values.max_contracts, 300);
  assert.deepEqual(ok.values.features, { whatsapp: true, telegram: false, reports_csv: false, ai_reading: false, listings: false });
  const bad = plans.validatePlan({ code: 'Bad Code', name_ar: '', price_monthly: 'abc', max_units: '0', sort_order: 'x' }, { creating: true });
  for (const field of ['code', 'name_ar', 'price_monthly', 'max_units', 'sort_order']) assert.ok(bad.errors[field], field);
});

test('downgrade: blocked when usage is above the new limits, with what to reduce; nothing else blocks', () => {
  const small = { name_ar: 'صغيرة', max_units: 10, max_contracts: 5, max_members: 2, max_ai_reads_monthly: 1, max_photos: null };
  const fits = plans.checkDowngrade(small, { units: 10, contracts: 5, members: 2, photos: 999, aiReads: 50 });
  assert.equal(fits.ok, true, 'exactly at the limit is fine; unlimited photos and the monthly AI count never block');
  const over = plans.checkDowngrade(small, { units: 25, contracts: 7, members: 2, photos: 0, aiReads: 0 });
  assert.equal(over.ok, false);
  assert.deepEqual(over.problems.map((p) => [p.label, p.reduceBy]), [['الوحدات', 15], ['العقود السارية', 2]]);
  assert.match(over.message, /قلّل 15 وحدة/);
  assert.match(over.message, /قلّل 2 عقد/);
  assert.match(over.message, /لن يُحذف شيء/);
});

// ------------------------------------------------------------ the subscription clock

test('a monthly period ends at the start of the Riyadh day a month later', () => {
  const start = new Date('2026-10-03T10:00:00Z');
  assert.equal(dates.subscriptionPeriodEnd(start, 1).toISOString(), '2026-11-02T21:00:00.000Z'); // 2026-11-03 00:00 Riyadh
  assert.equal(dates.subscriptionPeriodEnd(start, 12).toISOString(), '2027-10-02T21:00:00.000Z');
  // Month-end clamping: Jan 31 + 1 month = Feb 28.
  assert.equal(dates.subscriptionPeriodEnd(new Date('2027-01-31T08:00:00Z'), 1).toISOString(), '2027-02-27T21:00:00.000Z');
});

test('periodState: active, then 7 days of grace, then expired (fixed clock)', () => {
  const end = new Date('2026-11-02T21:00:00Z');
  const at = (iso) => periodState(end, new Date(iso));
  assert.equal(at('2026-11-02T20:59:59Z').state, 'active');
  assert.equal(at('2026-11-02T20:59:59Z').daysLeft, 0, 'the last day counts as 0 days left');
  assert.equal(at('2026-11-02T21:00:00Z').state, 'grace');
  assert.equal(at('2026-11-02T21:00:00Z').graceDaysLeft, 7);
  assert.equal(at('2026-11-09T20:59:59Z').state, 'grace');
  assert.equal(at('2026-11-09T21:00:00Z').state, 'expired');
});

test('planTransition: active -> past_due -> suspended; trials, no-date and suspended offices are untouched', () => {
  const end = new Date('2026-11-02T21:00:00Z');
  const office = (status, ends = end) => ({ status, subscription_ends_at: ends });
  assert.equal(planTransition(office('active'), new Date('2026-11-02T20:00:00Z')), null);
  assert.equal(planTransition(office('active'), new Date('2026-11-03T10:00:00Z')), 'past_due');
  assert.equal(planTransition(office('past_due'), new Date('2026-11-03T10:00:00Z')), null, 'already past_due');
  assert.equal(planTransition(office('past_due'), new Date('2026-11-10T10:00:00Z')), 'suspended');
  assert.equal(planTransition(office('active'), new Date('2026-12-01T10:00:00Z')), 'suspended', 'a missed day still ends suspended');
  assert.equal(planTransition(office('trial'), new Date('2030-01-01T00:00:00Z')), null);
  assert.equal(planTransition(office('suspended'), new Date('2030-01-01T00:00:00Z')), null);
  assert.equal(planTransition(office('active', null), new Date('2030-01-01T00:00:00Z')), null);
});

test('officeAccess: read-only during the grace, locked after, full while paid', () => {
  const end = new Date('2026-11-02T21:00:00Z');
  const office = { status: 'active', subscription_ends_at: end };
  const paid = officeAccess(office, new Date('2026-10-20T00:00:00Z'));
  assert.deepEqual([paid.locked, Boolean(paid.readOnly), paid.pastDue], [false, false, false]);
  const grace = officeAccess(office, new Date('2026-11-04T00:00:00Z'));
  assert.deepEqual([grace.locked, grace.readOnly, grace.pastDue, grace.graceDaysLeft], [false, true, true, 6]);
  const over = officeAccess(office, new Date('2026-11-10T00:00:00Z'));
  assert.deepEqual([over.locked, over.reason], [true, 'expired']);
  // The older past_due without a date keeps its meaning: access plus a banner.
  const legacy = officeAccess({ status: 'past_due' }, new Date());
  assert.deepEqual([legacy.locked, Boolean(legacy.readOnly), legacy.pastDue], [false, false, true]);
});

test('reminders fire at 7, 3 and 1 days before the last day', () => {
  assert.deepEqual([8, 7, 6, 4, 3, 2, 1, 0].map(reminderThreshold), [null, 7, null, null, 3, null, 1, null]);
});

// ------------------------------------------------------------ promo codes

const NOW = new Date('2026-10-03T10:00:00Z');
const promo = (extra = {}) => ({
  id: 1, code: 'SAVE10', discount_type: 'percent', percent_bp: 1000, fixed_amount: null, valid_from: null, valid_to: null,
  max_redemptions: null, plan_ids: null, is_active: 1, ...extra,
});

test('promo evaluate: inactive, not started, expired, wrong plan, once per office, max reached', () => {
  const check = (p, extra = {}) => promos.evaluate({ promo: p, planId: 2, now: NOW, ...extra });
  assert.equal(check(promo()).ok, true);
  assert.equal(check(null).reason, 'not_found');
  assert.equal(check(promo({ is_active: 0 })).reason, 'inactive');
  assert.equal(check(promo({ valid_from: new Date('2026-10-04T00:00:00Z') })).reason, 'not_started');
  assert.equal(check(promo({ valid_to: new Date('2026-10-03T10:00:00Z') })).reason, 'expired', 'valid_to is exclusive');
  assert.equal(check(promo({ valid_to: new Date('2026-10-03T10:00:01Z') })).ok, true);
  assert.equal(check(promo({ plan_ids: [1, 3] })).reason, 'plan_not_applicable');
  assert.equal(check(promo({ plan_ids: '[1,2]' })).ok, true);
  assert.equal(check(promo(), { usedByOffice: true }).reason, 'already_used');
  assert.equal(check(promo({ max_redemptions: 1 }), { redeemed: 1 }).reason, 'max_reached');
  assert.equal(check(promo({ max_redemptions: 2 }), { redeemed: 1 }).ok, true);
});

test('promo form: percent to basis points, fixed to halalas, Riyadh days, plans', () => {
  const ok = promos.validatePromo({ code: ' save-10 ', discount_type: 'percent', percent: '12.5', valid_from: '2026-10-01', valid_to: '2026-10-31', max_redemptions: '50', plan_ids: ['2', '3'], is_active: '1' }, { creating: true });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.code, 'SAVE-10');
  assert.equal(ok.values.percent_bp, 1250);
  assert.equal(ok.values.valid_from.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(ok.values.valid_to.toISOString(), '2026-10-31T21:00:00.000Z', 'the end day is included');
  assert.deepEqual(ok.values.plan_ids, [2, 3]);
  assert.equal(promos.endDay(ok.values.valid_to), '2026-10-31');
  const fixed = promos.validatePromo({ code: 'FIX25', discount_type: 'fixed', fixed: '25.50' }, { creating: true });
  assert.equal(fixed.values.fixed_halalas, 2550);
  for (const body of [{ code: 'x', discount_type: 'percent', percent: '0' }, { code: 'GOOD', discount_type: 'percent', percent: '101' }, { code: 'GOOD', discount_type: 'fixed', fixed: '-1' }, { code: 'GOOD', discount_type: 'percent', percent: '10', valid_from: '2026-11-01', valid_to: '2026-10-01' }]) {
    assert.ok(Object.keys(promos.validatePromo(body, { creating: true }).errors).length > 0, JSON.stringify(body));
  }
  assert.equal(promos.normalizeCode('a b c'), 'ABC');
  assert.equal(promos.normalizeCode('!!'), null);
});

// ------------------------------------------------------------ invoices

test('invoice numbers, titles and the VAT-number rule', () => {
  assert.equal(invoices.formatNumber('invoice', 2026, 7), 'INV-2026-000007');
  assert.equal(invoices.formatNumber('credit_note', 2026, 12), 'CN-2026-000012');
  assert.equal(invoices.titleFor({ vat_number: '300000000000003' }), 'فاتورة ضريبية مبسطة');
  assert.equal(invoices.titleFor({ vat_number: '' }), 'إيصال دفع');
  assert.equal(invoices.titleFor({}), 'إيصال دفع');
  assert.equal(invoices.titleFor(null), 'إيصال دفع');
  assert.equal(invoices.titleFor({ vat_number: '300000000000003' }, true), 'إشعار دائن');
  assert.equal(dates.riyadhYear(new Date('2026-12-31T22:00:00Z')), 2027, 'the year is the Riyadh year');
});

test('invoice lines: plan line, then the discount as a negative line', () => {
  const lines = invoices.linesFor({ planName: 'الأساسية', interval: 'monthly', periodFrom: '2026-10-03', periodTo: '2026-11-02', subtotal: 9900, discount: 1000, promoCode: 'SAVE10' });
  assert.deepEqual(lines.map((l) => l.net), [9900, -1000]);
  assert.match(lines[0].description, /الأساسية/);
});

// ------------------------------------------------------------ Moyasar (mocked network)

test('moyasar config: off without keys, test keys only, live refused unless explicitly allowed', () => {
  assert.equal(moyasar.config({}).enabled, false);
  assert.equal(moyasar.config({ MOYASAR_SECRET_KEY: 'sk_test_abc' }).enabled, false, 'both keys are needed');
  assert.equal(moyasar.config({ MOYASAR_SECRET_KEY: 'sk_test_abc', MOYASAR_PUBLISHABLE_KEY: 'pk_test_abc' }).enabled, true);
  const live = { MOYASAR_SECRET_KEY: 'sk_live_abc', MOYASAR_PUBLISHABLE_KEY: 'pk_live_abc' };
  assert.equal(moyasar.config(live).enabled, false);
  assert.equal(moyasar.config(live).reason, 'live_refused');
  assert.equal(moyasar.config({ ...live, MOYASAR_ALLOW_LIVE: '1' }).enabled, true);
  assert.equal(moyasar.config({ MOYASAR_SECRET_KEY: 'nonsense', MOYASAR_PUBLISHABLE_KEY: 'pk_test_abc' }).enabled, false);
});

test('moyasar: constant-time secret check', () => {
  assert.equal(moyasar.secretsMatch('abc', 'abc'), true);
  assert.equal(moyasar.secretsMatch('abd', 'abc'), false);
  assert.equal(moyasar.secretsMatch('', ''), false, 'an empty secret never matches');
  assert.equal(moyasar.secretsMatch(undefined, 'abc'), false);
});

test('moyasar fetchPayment: basic auth with the secret key, only the fields we use, bad ids never reach the network', async () => {
  const env = { MOYASAR_SECRET_KEY: 'sk_test_secretvalue', MOYASAR_PUBLISHABLE_KEY: 'pk_test_pub' };
  const calls = [];
  moyasar.setTransport(async (req) => {
    calls.push(req);
    return {
      status: 200,
      body: JSON.stringify({
        id: 'a1b2c3d4-0000-4000-8000-000000000001', status: 'paid', amount: 11385, currency: 'sar',
        source: { type: 'creditcard', number: '411111XXXXXX1111', name: 'SHOULD NOT BE KEPT', company: 'visa' },
        metadata: { order_id: '42' },
      }),
    };
  });
  try {
    const ok = await moyasar.fetchPayment('a1b2c3d4-0000-4000-8000-000000000001', env);
    assert.deepEqual(ok, { ok: true, payment: { id: 'a1b2c3d4-0000-4000-8000-000000000001', status: 'paid', amount: 11385, currency: 'SAR', orderId: '42', last4: '1111' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /^https:\/\/api\.moyasar\.com\/v1\/payments\/a1b2c3d4/);
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('sk_test_secretvalue:').toString('base64')}`);
    assert.equal(JSON.stringify(ok).includes('SHOULD NOT BE KEPT'), false, 'no cardholder data is kept');

    assert.deepEqual(await moyasar.fetchPayment('../../etc/passwd', env), { ok: false, error: 'bad_id' });
    assert.equal(calls.length, 1, 'the bad id made no request');
    assert.deepEqual(await moyasar.fetchPayment('a1b2c3d4-0000-4000-8000-000000000001', {}), { ok: false, error: 'no_keys' });

    moyasar.setTransport(async () => ({ status: 404, body: '{}' }));
    assert.deepEqual(await moyasar.fetchPayment('a1b2c3d4-0000-4000-8000-000000000001', env), { ok: false, error: 'http_404' });
    moyasar.setTransport(async () => ({ error: 'timeout' }));
    assert.deepEqual(await moyasar.fetchPayment('a1b2c3d4-0000-4000-8000-000000000001', env), { ok: false, error: 'network' });
    moyasar.setTransport(async () => ({ status: 200, body: 'not json' }));
    assert.deepEqual(await moyasar.fetchPayment('a1b2c3d4-0000-4000-8000-000000000001', env), { ok: false, error: 'bad_reply' });
  } finally {
    moyasar.setTransport(null);
  }
});

test('moyasar form config carries only the publishable key and our own callback', () => {
  const env = { MOYASAR_SECRET_KEY: 'sk_test_secretvalue', MOYASAR_PUBLISHABLE_KEY: 'pk_test_pub' };
  const config = moyasar.formConfig({ order: { id: 9, totalHalalas: 11385, currency: 'SAR' }, description: 'اشتراك', callbackUrl: 'https://aqdi.example/office/billing/moyasar/callback', env });
  assert.equal(config.publishable_api_key, 'pk_test_pub');
  assert.equal(config.amount, 11385);
  assert.deepEqual(config.metadata, { order_id: '9' });
  assert.equal(JSON.stringify(config).includes('secretvalue'), false);
});

// ------------------------------------------------------------ platform settings

test('seller settings are empty-safe and validated; nothing is hardcoded', () => {
  const empty = platformSettings.validateDetails({});
  assert.deepEqual(empty.errors, {});
  assert.ok(Object.values(empty.values).every((v) => v === ''));
  const ok = platformSettings.validateDetails({ legal_name: 'شركة', vat_number: '300000000000003', cr_number: '1010101010', bank_iban: 'sa0380000000608010167519', support_email: 'A@B.CO' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values[platformSettings.KEYS.bankIban], 'SA0380000000608010167519');
  assert.equal(ok.values[platformSettings.KEYS.supportEmail], 'a@b.co');
  const bad = platformSettings.validateDetails({ vat_number: '123', cr_number: '12', bank_iban: 'XX1', support_email: 'no', support_phone: 'abc' });
  for (const field of ['vat_number', 'cr_number', 'bank_iban', 'support_email', 'support_phone']) assert.ok(bad.errors[field], field);
});

test('no company name, VAT number or card number is hardcoded in the billing code', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['config/billing.js', 'services/pricing.js', 'services/invoices.js', 'services/orders.js', 'services/subscriptions.js', 'services/moyasar.js', 'services/platformSettings.js', 'routes/billing.js', 'routes/admin.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /\b3\d{13}3\b/, `${file}: a 15-digit VAT-like number`);
    assert.doesNotMatch(source, /\bSA\d{22}\b/, `${file}: an IBAN`);
    assert.doesNotMatch(source, /ZATCA\s*(compliant|certified)/i, `${file}: a compliance claim`);
    assert.doesNotMatch(source, /sk_(test|live)_[A-Za-z0-9]{8,}/, `${file}: a secret key`);
  }
});

test('older databases get promo_codes.currency from the registered migration', () => {
  const { COLUMN_ADDITIONS } = require('../database/schema');
  assert.ok(COLUMN_ADDITIONS.some((c) => c.table === 'promo_codes' && c.column === 'currency'));
});
