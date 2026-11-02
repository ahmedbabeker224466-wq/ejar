'use strict';

// The approved pricing (Prompt 21): the values match the approved table, the
// migration replaces only old placeholders (admin edits survive, idempotent,
// office plan assignments untouched), the public pricing page, the office
// settings plan section and the launch check helper. Database parts run only
// when TEST_DB_NAME is set; the migration test runs inside a transaction that
// is rolled back, because the plan rows are shared with other test files.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../services/officialPricing');
const { checkLimit } = require('../services/planLimits');
const money = require('../services/money');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000029NN.
const phone = (n) => `9665000029${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;

// ------------------------------------------------------------ pure

test('the official values are exactly the approved table', () => {
  const { trial, basic, pro, enterprise } = pricing.OFFICIAL;
  const pick = (p) => [p.price_monthly, p.price_yearly, p.max_units, p.max_members, p.max_ai_reads_monthly, p.max_listings];
  assert.deepEqual(pick(basic), [149, 1490, 30, 2, 20, 10]);
  assert.deepEqual(pick(pro), [349, 3490, 150, 6, 100, 50]);
  assert.deepEqual(pick(enterprise), [799, 7990, 600, 20, 400, 200]);
  assert.deepEqual(pick(trial), [0, 0, 150, 6, 100, 50], 'trial limits equal Pro, price 0');
  for (const p of [basic, pro, enterprise]) assert.equal(p.price_yearly, p.price_monthly * 10, 'a year costs 10 months');

  assert.deepEqual([basic.features.telegram, basic.features.whatsapp], [true, false], 'basic: site + email + Telegram');
  assert.deepEqual([pro.features.telegram, pro.features.whatsapp], [true, true], 'pro adds WhatsApp');
  assert.deepEqual([basic.custom_domain, pro.custom_domain, enterprise.custom_domain], ['none', 'addon', 'included']);
  assert.deepEqual([basic.audit_level, pro.audit_level], ['basic', 'full']);
  assert.deepEqual([basic.support_level, pro.support_level, enterprise.support_level], ['email', 'email_whatsapp', 'priority']);
  assert.deepEqual(pricing.CUSTOM_DOMAIN_ADDON, { name_ar: 'نطاق مخصص', price_monthly: '49.00', currency: 'SAR', plans: ['pro'] });
  assert.equal(pricing.CUSTOM_PLAN_FROM_UNITS, 600);
});

test('limits at the boundary with the official numbers', () => {
  const { basic, pro } = pricing.OFFICIAL;
  assert.equal(checkLimit({ limit: basic.max_units, current: 29, adding: 1 }).ok, true);
  assert.equal(checkLimit({ limit: basic.max_units, current: 30, adding: 1 }).ok, false, 'the 31st unit is refused on basic');
  assert.equal(checkLimit({ limit: basic.max_members, current: 2, adding: 1 }).ok, false, 'a third member is refused on basic');
  assert.equal(checkLimit({ limit: pro.max_listings, current: 49, adding: 1 }).ok, true);
  assert.equal(checkLimit({ limit: pro.max_listings, current: 50, adding: 1 }).ok, false);
});

const placeholderRow = (code, extra = {}) => ({
  ...pricing.PLACEHOLDERS[code], code, custom_domain: 'none', audit_level: 'full', support_level: 'email', is_active: 1, is_public: 1,
  features: JSON.stringify(pricing.PLACEHOLDERS[code].features), price_monthly: Number(pricing.PLACEHOLDERS[code].price_monthly).toFixed(2), ...extra,
});

test('migration (pure): placeholders become the official values; admin edits and unknown plans are kept', () => {
  const basic = pricing.planUpdates('basic', placeholderRow('basic'), { firstTime: true });
  assert.equal(basic.price_monthly, 149);
  assert.equal(basic.price_yearly, 1490);
  assert.equal(basic.max_units, 30);
  assert.equal(basic.max_members, 2);
  assert.equal(basic.max_ai_reads_monthly, 20);
  assert.equal(basic.max_contracts, null);
  assert.equal(basic.features.telegram, true);
  assert.equal(basic.audit_level, 'basic');
  assert.ok(!('max_photos' in basic), 'photos are not in the table: kept');

  const edited = pricing.planUpdates('basic', placeholderRow('basic', { price_monthly: '175.00', max_units: 45 }), { firstTime: true });
  assert.ok(!('price_monthly' in edited), 'an admin price is never overwritten');
  assert.ok(!('max_units' in edited), 'an admin limit is never overwritten');
  assert.equal(edited.price_yearly, 1490, 'the untouched placeholder still moves');

  const enterprise = pricing.planUpdates('enterprise', placeholderRow('enterprise'), { firstTime: true });
  assert.deepEqual([enterprise.price_monthly, enterprise.max_units, enterprise.max_members, enterprise.max_listings], [799, 600, 20, 200]);

  // A trial created by hand with no limits keeps them; only the one-time columns change.
  const handTrial = pricing.planUpdates('trial', { code: 'trial', price_monthly: '0.00', price_yearly: '0.00', max_units: null, max_members: null, features: null, custom_domain: 'none', audit_level: 'full', support_level: 'email', is_active: 1, is_public: 1 }, { firstTime: true });
  assert.deepEqual(handTrial, {});

  // Second run: nothing left to change.
  const after = { ...placeholderRow('pro'), ...pricing.OFFICIAL.pro, features: JSON.stringify(pricing.OFFICIAL.pro.features) };
  assert.deepEqual(pricing.planUpdates('pro', after, { firstTime: false }), {});
  // After the one-time part an admin may change the descriptive columns freely.
  assert.deepEqual(pricing.planUpdates('pro', { ...after, custom_domain: 'none', is_public: 0 }, { firstTime: false }), {});
  assert.deepEqual(pricing.planUpdates('gold', placeholderRow('pro'), { firstTime: true }), {}, 'other plans are never touched');
});

test('pricing cards: honest lines per plan and the yearly months', () => {
  const fmt = money.formatHalalas;
  const addon = pricing.CUSTOM_DOMAIN_ADDON;
  const row = (code) => ({ code, ...pricing.OFFICIAL[code], features: JSON.stringify(pricing.OFFICIAL[code].features) });
  const basic = pricing.cardLines(row('basic'), addon, fmt);
  assert.ok(basic.includes('الوحدات: حتى 30'));
  assert.ok(basic.includes('أعضاء الفريق مع المالك: حتى 2'));
  assert.ok(basic.includes('الإعلانات العامة المنشورة: حتى 10'));
  assert.ok(basic.includes('قراءة العقود بالذكاء الاصطناعي: حتى 20 شهرياً'));
  assert.ok(basic.includes('التذكيرات: الموقع + البريد الإلكتروني + تيليجرام'));
  assert.ok(basic.includes('النطاق المخصص: غير متاح'));
  assert.ok(basic.includes('سجل العمليات: أساسي'));
  const pro = pricing.cardLines(row('pro'), addon, fmt);
  assert.ok(pro.includes('التذكيرات: الموقع + البريد الإلكتروني + تيليجرام + واتساب'));
  assert.ok(pro.includes('النطاق المخصص: إضافة اختيارية بـ 49.00 ريال شهرياً (قريباً)'));
  assert.ok(pro.includes('الدعم: البريد الإلكتروني وواتساب'));
  const enterprise = pricing.cardLines(row('enterprise'), addon, fmt);
  assert.ok(enterprise.includes('نطاق مخصص واحد مشمول (قريباً)'));
  assert.ok(enterprise.includes('دعم بأولوية'));
  assert.ok(enterprise.includes('الوحدات: حتى 600'));
  assert.ok(pricing.cardLines({ ...row('pro'), max_units: null }, addon, fmt).includes('الوحدات: بلا حد'));
  // The add-on shows only where the add-on record allows it.
  assert.ok(pricing.cardLines(row('pro'), { ...addon, plans: [] }, fmt).includes('النطاق المخصص: غير متاح'));

  assert.equal(pricing.paidMonths(14900, 149000), 10);
  assert.equal(pricing.paidMonths(14900, 178800), null, '12 months is not a saving');
  assert.equal(pricing.paidMonths(14900, 150000), null, 'not a whole number of months');
  assert.equal(pricing.paidMonths(0, 0), null);
});

test('launch helper: price 0 outside the trial, a missing limit, or no paid plan', () => {
  const plans = () => Object.entries(pricing.OFFICIAL).map(([code, p]) => ({ code, ...p, is_active: 1, is_public: code === 'trial' ? 0 : 1 }));
  assert.deepEqual(pricing.planProblems(plans()), []);
  assert.equal(pricing.planProblems(plans().map((p) => (p.code === 'basic' ? { ...p, price_monthly: 0 } : p))).length, 1);
  assert.equal(pricing.planProblems(plans().map((p) => (p.code === 'pro' ? { ...p, max_ai_reads_monthly: null } : p))).length, 1);
  assert.equal(pricing.planProblems(plans().map((p) => (p.code === 'basic' ? { ...p, is_active: 0, price_monthly: 0 } : p))).length, 0, 'inactive plans do not count');
  assert.match(pricing.planProblems([plans()[0]]).join(' '), /لا توجد باقة مدفوعة منشورة/);
});

// ------------------------------------------------------------ database

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await require('../database/seed').seed(db.pool);
  http = createOfficeHttp(db);
  await http.start();
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

test('migration on MySQL: placeholders move, admin edits stay, idempotent, offices keep their plan (rolled back)', { skip }, async () => {
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [before] = await conn.query('SELECT id, plan_id FROM offices ORDER BY id');
    // Back to the old seeded state, with two admin edits.
    for (const code of Object.keys(pricing.PLACEHOLDERS)) {
      const p = pricing.PLACEHOLDERS[code];
      await conn.query(
        `UPDATE plans SET price_monthly = ?, price_yearly = ?, max_contracts = ?, max_units = ?, max_members = ?, max_ai_reads_monthly = ?,
                max_photos = ?, max_listings = ?, features = ?, custom_domain = 'none', audit_level = 'full', support_level = 'email', is_public = 0
          WHERE code = ?`,
        [p.price_monthly, p.price_yearly, p.max_contracts, p.max_units, p.max_members, p.max_ai_reads_monthly, p.max_photos, p.max_listings, JSON.stringify(p.features), code],
      );
    }
    await conn.query("UPDATE plans SET price_monthly = 175 WHERE code = 'basic'");
    await conn.query("UPDATE plans SET max_units = 999 WHERE code = 'pro'");
    await conn.query('DELETE FROM settings WHERE setting_key LIKE ?', [`${pricing.MARKER}%`]);
    await conn.query('DELETE FROM settings WHERE setting_key = ?', [pricing.ADDON_KEY]);

    const first = await pricing.applyOfficialPricing(conn);
    assert.deepEqual(first.updated.sort(), ['basic', 'enterprise', 'pro', 'trial']);
    assert.equal(first.addon, true);
    const second = await pricing.applyOfficialPricing(conn);
    assert.deepEqual(second, { updated: [], addon: false }, 'idempotent');

    const [rows] = await conn.query("SELECT * FROM plans WHERE code IN ('trial','basic','pro','enterprise')");
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    assert.equal(Number(by.basic.price_monthly), 175, 'admin price kept');
    assert.equal(Number(by.basic.price_yearly), 1490);
    assert.equal(Number(by.basic.max_units), 30);
    assert.equal(Number(by.pro.max_units), 999, 'admin limit kept');
    assert.equal(Number(by.pro.price_monthly), 349);
    assert.equal(by.pro.custom_domain, 'addon');
    assert.equal(by.pro.support_level, 'email_whatsapp');
    assert.equal(Number(by.pro.is_public), 1, 'paid plans published once');
    assert.equal(Number(by.enterprise.max_units), 600);
    assert.equal(by.enterprise.custom_domain, 'included');
    assert.equal(Number(by.trial.max_units), 150);
    assert.equal(Number(by.trial.price_monthly), 0);
    const basicFeatures = typeof by.basic.features === 'string' ? JSON.parse(by.basic.features) : by.basic.features;
    assert.equal(basicFeatures.telegram, true);
    assert.equal(basicFeatures.whatsapp, false);

    // An admin change after the migration is not reverted by the next start.
    await conn.query("UPDATE plans SET custom_domain = 'none', is_public = 0 WHERE code = 'pro'");
    assert.deepEqual(await pricing.applyOfficialPricing(conn), { updated: [], addon: false });

    const addon = await pricing.customDomainAddon(conn);
    assert.equal(addon.price_monthly, '49.00');
    assert.deepEqual(addon.plans, ['pro']);
    const [after] = await conn.query('SELECT id, plan_id FROM offices ORDER BY id');
    assert.deepEqual(after, before, 'no office changed plan');
  } finally {
    await conn.rollback();
    conn.release();
  }
});

test('public pricing page: the three plans, monthly/yearly toggle, VAT and trial notes, custom plan', { skip }, async () => {
  const res = await http.request('/pricing');
  assert.equal(res.status, 200);
  const text = res.text;
  assert.doesNotMatch(text, /تُعلَن الباقات قريباً/);
  assert.match(text, /id="period-monthly"[^>]*checked/);
  assert.match(text, /id="period-yearly"/);
  assert.match(text, /for="period-yearly"[^>]*>سنوي</);
  assert.match(text, /الأسعار لا تشمل ضريبة القيمة المضافة 15%/);
  assert.match(text, /التجربة المجانية 14 يوماً بدون بطاقة/);
  assert.match(text, /id="plan-custom"[\s\S]*لأكثر من 600 وحدة[\s\S]*href="\/contact"/);
  const card = (code) => {
    const found = text.split('<li class="plan-card').find((part) => part.startsWith(`" id="plan-${code}"`));
    assert.ok(found, `card ${code}`);
    return found;
  };
  const basic = card('basic');
  assert.match(basic, /الأساسية/);
  assert.match(basic, /149\.00<\/strong> ريال \/ شهرياً/);
  assert.match(basic, /1,490\.00<\/strong> ريال \/ سنوياً/);
  assert.match(basic, /تدفع 10 أشهر/);
  assert.doesNotMatch(basic, /واتساب/, 'no WhatsApp on basic');
  assert.match(card('pro'), /349\.00[\s\S]*3,490\.00[\s\S]*واتساب[\s\S]*49\.00 ريال شهرياً/);
  assert.match(card('enterprise'), /799\.00[\s\S]*7,990\.00[\s\S]*الوحدات: حتى 600/);
  assert.doesNotMatch(text, /تقييم|★|خصم \d+%/, 'no fake reviews or discounts');
  assert.match(text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);
});

test('office settings show the plan, its limits and the usage to every office role', { skip }, async () => {
  const owner = await http.registerOffice(phone(1), 'تجربة-باقة-الإعدادات');
  await db.pool.query("INSERT INTO landlords (office_id, label, city) VALUES (?, 'مالك', 'الرياض')", [owner.office.id]);
  const [[landlord]] = await db.pool.query('SELECT id FROM landlords WHERE office_id = ?', [owner.office.id]);
  await db.pool.query("INSERT INTO units (office_id, landlord_id, label, city) VALUES (?, ?, 'شقة 1', 'الرياض'), (?, ?, 'شقة 2', 'الرياض')", [owner.office.id, landlord.id, owner.office.id, landlord.id]);
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'basic') WHERE id = ?", [owner.office.id]);
  const [[basic]] = await db.pool.query("SELECT max_units, name_ar FROM plans WHERE code = 'basic'");

  const page = await http.request('/office/settings', { cookie: owner.cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`باقتك: ${basic.name_ar}`));
  assert.match(page.text, new RegExp(`id="usage-max_units"[\\s\\S]*?<strong>2 من ${basic.max_units}</strong>`));
  assert.match(page.text, /id="usage-max_ai_reads_monthly"/);
  assert.match(page.text, /التذكيرات: الموقع/);
  assert.match(page.text, /href="\/office\/billing"/, 'the owner gets the billing link');

  const staff = await http.addMember(owner.office.id, phone(2), 'office_staff');
  const staffPage = await http.request('/office/settings', { cookie: staff });
  assert.equal(staffPage.status, 200);
  assert.ok(staffPage.text.includes(`باقتك: ${basic.name_ar}`));
  assert.doesNotMatch(staffPage.text, /href="\/office\/billing"/, 'no billing link without the billing capability');
});
