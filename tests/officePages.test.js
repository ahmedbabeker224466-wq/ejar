'use strict';

// The office tenants page, the office audit log, the unit page's maintenance
// list, the contract file note, and the default-plan backfill against real
// MySQL. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000026NN.
const phone = (n) => `9665000026${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let defaultPlan;

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
     VALUES ('test_pages', 'اختبار الصفحات', 1, 1, NULL, NULL, NULL, NULL, 0, 121)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, is_active = 0`,
  );
  defaultPlan = require('../services/defaultPlan');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_pages' });
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

const get = (path, cookie) => http.request(path, { cookie });

// ------------------------------------------------------------ tenants

test('tenants page: empty state, then one row per contract with unit, stage and join state; staff may open it', { skip }, async () => {
  const a = await fx.office(1, 'تجربة-مستأجرون-أ', { units: 3 });
  const empty = await get('/office/tenants', a.cookie);
  assert.equal(empty.status, 200);
  assert.match(empty.text, /لا يوجد مستأجرون بعد/);
  assert.doesNotMatch(empty.text, /قيد البناء/);

  const invited = await fx.contract(a, { unitIndex: 0 });
  const joined = await fx.contract(a, { unitIndex: 1 });
  await a.scoped.query('UPDATE contracts SET tenant_label = ? WHERE id = ? AND office_id = :office_id', ['أبو سعد', joined]);
  await fx.tenantOf(joined, 2);
  const none = await fx.contract(a, { unitIndex: 2 });
  await a.scoped.query("UPDATE invites SET revoked_at = UTC_TIMESTAMP() WHERE contract_id = ? AND office_id = :office_id", [none]);

  const page = await get('/office/tenants', a.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /3 مستأجر/);
  assert.match(page.text, /أبو سعد/);
  assert.match(page.text, /شقة 1-2/, 'the unit label');
  for (const id of [invited, joined, none]) assert.ok(page.text.includes(`/office/contracts/${id}"`), `contract ${id} listed`);
  assert.match(page.text, /badge--link-joined/);
  assert.match(page.text, /badge--link-invited/);
  assert.match(page.text, /badge--link-not_invited/);
  assert.match(page.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);

  const onlyJoined = await get('/office/tenants?status=joined', a.cookie);
  assert.ok(onlyJoined.text.includes(`/office/contracts/${joined}"`));
  assert.ok(!onlyJoined.text.includes(`/office/contracts/${invited}"`));
  const onlyNone = await get('/office/tenants?status=not_invited', a.cookie);
  assert.ok(onlyNone.text.includes(`/office/contracts/${none}"`));
  assert.ok(!onlyNone.text.includes(`/office/contracts/${joined}"`));
  const search = await get(`/office/tenants?q=${encodeURIComponent('أبو سعد')}`, a.cookie);
  assert.match(search.text, /1 مستأجر/);
  const nothing = await get('/office/tenants?q=zzz-none', a.cookie);
  assert.match(nothing.text, /لا توجد نتائج تطابق البحث/);
  assert.equal((await get('/office/tenants?page=abc&status=bogus', a.cookie)).status, 200);

  const staff = await http.addMember(a.office.id, phone(3), 'office_staff');
  assert.equal((await get('/office/tenants', staff)).status, 200);
  const manager = await http.addMember(a.office.id, phone(4), 'office_manager');
  assert.equal((await get('/office/tenants', manager)).status, 200);

  // The tenant who joined has no office membership: no office pages.
  const tenant = await fx.person(2);
  assert.notEqual((await get('/office/tenants', tenant.cookie)).status, 200);
  assert.equal((await get('/office/tenants')).status, 302, 'anonymous goes to login');
});

test('tenants page never shows another office\'s tenants', { skip }, async () => {
  const a = await fx.office(10, 'تجربة-مستأجرون-عزل-أ', { units: 1 });
  const b = await fx.office(11, 'تجربة-مستأجرون-عزل-ب', { units: 1 });
  const bContract = await fx.contract(b);
  await b.scoped.query('UPDATE contracts SET tenant_label = ? WHERE id = ? AND office_id = :office_id', ['مستأجر-المكتب-ب', bContract]);
  const page = await get('/office/tenants', a.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /لا يوجد مستأجرون بعد/);
  assert.doesNotMatch(page.text, /مستأجر-المكتب-ب/);
  assert.ok(!page.text.includes(`/office/contracts/${bContract}"`));
  assert.equal((await get(`/office/contracts/${bContract}`, a.cookie)).status, 404);
});

// ------------------------------------------------------------ audit

test('office audit: owner and manager read their own office\'s log; staff are refused; no other office, no admin rows, no phone', { skip }, async () => {
  const a = await fx.office(20, 'تجربة-تدقيق-أ', { units: 1 });
  const b = await fx.office(21, 'تجربة-تدقيق-ب', { units: 1 });
  const aContract = await fx.contract(a);
  const bContract = await fx.contract(b);
  await db.pool.query(
    "INSERT INTO audit_logs (office_id, actor_id, action, entity_type, entity_id, after_json) VALUES (?, NULL, 'admin.office.note', 'office', ?, ?)",
    [a.office.id, a.office.id, JSON.stringify({ reason: 'ملاحظة-داخلية-للمنصة' })],
  );

  const page = await get('/office/audit', a.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /سجل التدقيق/);
  assert.match(page.text, /إنشاء المكتب/);
  assert.match(page.text, /إضافة عقد/);
  assert.match(page.text, /مالك المكتب/, 'the role of the actor');
  assert.ok(page.text.includes(`/office/contracts/${aContract}"`));
  assert.ok(!page.text.includes(`/office/contracts/${bContract}"`), 'office B\'s contract is not in A\'s log');
  assert.doesNotMatch(page.text, /ملاحظة-داخلية-للمنصة/);
  const list = page.text.slice(page.text.indexOf('سجل للقراءة فقط'));
  assert.ok(!list.includes(phone(20)) && !list.includes(`0${phone(20).slice(3)}`), 'the phone is masked in the log');
  assert.ok(list.includes('****'), 'a masked phone names the actor');
  assert.doesNotMatch(page.text, /قيد البناء/);

  const manager = await http.addMember(a.office.id, phone(22), 'office_manager');
  assert.equal((await get('/office/audit', manager)).status, 200);
  const staff = await http.addMember(a.office.id, phone(23), 'office_staff');
  assert.equal((await get('/office/audit', staff)).status, 403);
  const staffHome = await get('/office', staff);
  assert.ok(!staffHome.text.includes('href="/office/audit"'), 'staff do not see the audit item');

  // Pagination: 30 per page, newest first.
  const rows = Array.from({ length: 35 }, () => [a.office.id, a.user.id, 'landlord.update', 'landlord', a.landlordId]);
  await db.pool.query('INSERT INTO audit_logs (office_id, actor_id, action, entity_type, entity_id) VALUES ?', [rows]);
  const first = await get('/office/audit', a.cookie);
  assert.match(first.text, /صفحة 1 من 2/);
  assert.equal((first.text.match(/class="card item"/g) || []).length, 30);
  const second = await get('/office/audit?page=2', a.cookie);
  assert.match(second.text, /صفحة 2 من 2/);
  assert.match(second.text, /إنشاء المكتب/, 'the oldest row is on the last page');
  assert.equal((await get('/office/audit?page=999', a.cookie)).status, 200);
});

test('office audit: an office with no rows shows the empty state', { skip }, async () => {
  const a = await fx.office(30, 'تجربة-تدقيق-فارغ', { landlords: 0, units: 0 });
  await db.pool.query('DELETE FROM audit_logs WHERE office_id = ?', [a.office.id]);
  const page = await get('/office/audit', a.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /لا توجد إجراءات مسجلة بعد/);
});

// ------------------------------------------------------------ unit and contract pages

test('unit page lists that unit\'s maintenance requests and no photos section; contract page says the file is not stored', { skip }, async () => {
  const a = await fx.office(40, 'تجربة-صيانة-الوحدة', { units: 2 });
  const b = await fx.office(41, 'تجربة-صيانة-الوحدة-ب', { units: 1 });
  const [unit, other] = a.units;

  const before = await get(`/office/units/${unit}`, a.cookie);
  assert.equal(before.status, 200);
  assert.match(before.text, /الصيانة \(0\)/);
  assert.match(before.text, /لا توجد طلبات صيانة على هذه الوحدة/);
  assert.doesNotMatch(before.text, /<h2>الصور<\/h2>/);
  assert.doesNotMatch(before.text, /قيد البناء/);

  const mine = await a.scoped.insert('maintenance_requests', { unit_id: unit, category: 'plumbing', description: 'وصف-خاص-لا-يظهر', priority: 'high' });
  const elsewhere = await a.scoped.insert('maintenance_requests', { unit_id: other, category: 'ac', description: 'وحدة أخرى' });
  const theirs = await b.scoped.insert('maintenance_requests', { unit_id: b.units[0], category: 'electrical', description: 'مكتب آخر' });

  const page = await get(`/office/units/${unit}`, a.cookie);
  assert.match(page.text, /الصيانة \(1\)/);
  assert.ok(page.text.includes(`href="/office/maintenance/${mine}"`));
  assert.ok(!page.text.includes(`/office/maintenance/${elsewhere}"`), 'another unit\'s request');
  assert.ok(!page.text.includes(`/office/maintenance/${theirs}"`), 'another office\'s request');
  assert.doesNotMatch(page.text, /وصف-خاص-لا-يظهر/, 'the description stays on the request page');
  assert.equal((await get(`/office/units/${b.units[0]}`, a.cookie)).status, 404);

  const contract = await fx.contract(a, { unitIndex: 1 });
  const show = await get(`/office/contracts/${contract}`, a.cookie);
  assert.equal(show.status, 200);
  assert.match(show.text, /لا يحتفظ التطبيق بملف العقد/);
  assert.doesNotMatch(show.text, /قيد البناء/);
});

// ------------------------------------------------------------ default plan

test('an office with plan_id NULL reads the default plan; the backfill stores it once with a subscription row', { skip }, async () => {
  const owner = await http.registerOffice(phone(50), 'تجربة-باقة-فارغة');
  const officeId = owner.office.id;
  const planId = await defaultPlan.defaultPlanId(db.pool);
  assert.ok(planId, 'a default plan exists');
  const [[plan]] = await db.pool.query('SELECT id, name_ar, max_units FROM plans WHERE id = ?', [planId]);

  // Reads, with plan_id NULL held inside an open transaction (a parallel backfill waits on the row lock).
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE offices SET plan_id = NULL WHERE id = ?', [officeId]);
    const offices = require('../services/offices');
    const [membership] = await offices.membershipsFor(conn, owner.user.id);
    assert.equal(membership.plan_name, plan.name_ar, 'the office reads the default plan, not "غير محددة"');
    const usage = await require('../services/planLimits').unitUsage(require('../services/scopeToOffice').scopeToOffice(conn, officeId));
    assert.equal(usage.limit, plan.max_units === null ? null : Number(plan.max_units));
  } finally {
    await conn.rollback();
    conn.release();
  }

  // The migration.
  await db.pool.query('UPDATE offices SET plan_id = NULL WHERE id = ?', [officeId]);
  await db.pool.query('DELETE FROM subscriptions WHERE office_id = ?', [officeId]);
  const [[launchCount]] = await db.pool.query('SELECT COUNT(*) AS n FROM offices WHERE plan_id IS NULL');
  assert.ok(Number(launchCount.n) >= 1, 'the launch check would warn');

  await defaultPlan.backfillOfficePlans(db.pool);
  await defaultPlan.backfillOfficePlans(db.pool);
  await db.ensureSchema();

  const [[office]] = await db.pool.query('SELECT plan_id, status FROM offices WHERE id = ?', [officeId]);
  assert.equal(Number(office.plan_id), planId);
  const [subs] = await db.pool.query('SELECT plan_id, status FROM subscriptions WHERE office_id = ?', [officeId]);
  assert.equal(subs.length, 1, 'exactly one subscription row, however often it runs');
  assert.equal(Number(subs[0].plan_id), planId);
  assert.equal(subs[0].status, 'trialing');
  const [[audits]] = await db.pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE office_id = ? AND action = 'office.plan_backfill'", [officeId]);
  assert.equal(Number(audits.n), 1);

  // An office that already has a plan is never touched; a live subscription without a plan gets it.
  await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', ['test_pages', officeId]);
  await defaultPlan.backfillOfficePlans(db.pool);
  const [[kept]] = await db.pool.query('SELECT p.code FROM offices o JOIN plans p ON p.id = o.plan_id WHERE o.id = ?', [officeId]);
  assert.equal(kept.code, 'test_pages');

  await db.pool.query('UPDATE offices SET plan_id = NULL WHERE id = ?', [officeId]);
  await db.pool.query('UPDATE subscriptions SET plan_id = NULL WHERE office_id = ?', [officeId]);
  await defaultPlan.backfillOfficePlans(db.pool);
  const [after] = await db.pool.query('SELECT plan_id FROM subscriptions WHERE office_id = ?', [officeId]);
  assert.equal(after.length, 1);
  assert.equal(Number(after[0].plan_id), planId);

  const billing = await get('/office/billing', owner.cookie);
  assert.equal(billing.status, 200);
  assert.doesNotMatch(billing.text, /الباقة<\/dt><dd>غير محددة/);
});
