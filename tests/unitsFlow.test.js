'use strict';

// Buildings and units against real MySQL, over HTTP where a person would
// click, plus services/unitStatus.js for the contract system's helpers.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000003NN.
const phone = (n) => `9665000003${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 40 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let scopeToOffice;
let unitStatus;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  // Inactive test plans (never chosen for new offices) with known limits.
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, is_active, sort_order)
     VALUES ('test_units_3', 'اختبار 3', 1, 1, 3, 0, 90), ('test_units_5', 'اختبار 5', 1, 1, 5, 0, 91),
            ('test_units_none', 'اختبار بلا حد', 1, 1, NULL, 0, 92)
     ON DUPLICATE KEY UPDATE max_units = VALUES(max_units), is_active = 0`,
  );
  ({ scopeToOffice } = require('../services/scopeToOffice'));
  unitStatus = require('../services/unitStatus');
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

const itemCount = (html) => (html.match(/<li class="card item/g) || []).length;
const idFrom = (location, kind = 'units') => Number(new RegExp(`/office/${kind}/(\\d+)`).exec(location)[1]);

async function usePlan(officeId, code) {
  await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', [code, officeId]);
}

async function unitCount(officeId) {
  const [[row]] = await db.pool.query('SELECT COUNT(*) AS n FROM units WHERE office_id = ?', [officeId]);
  return Number(row.n);
}

/** An office with one landlord, unlimited plan unless told otherwise. */
async function officeWithLandlord(n, name, plan = 'test_units_none') {
  const owner = await http.registerOffice(phone(n), name);
  await usePlan(owner.office.id, plan);
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const landlordId = await scoped.insert('landlords', { label: `مالك ${name}` });
  return { ...owner, scoped, landlordId };
}

const unitForm = (landlordId, extra = {}) => ({ landlord_id: String(landlordId), label: 'شقة 1', city: 'الرياض', unit_type: 'apartment', ...extra });

// ------------------------------------------------------------ buildings

test('buildings: validation, other offices\' landlords, landlord moves, delete rules, audit', { skip }, async () => {
  const a = await officeWithLandlord(1, 'مكتب المباني');
  const other = await officeWithLandlord(2, 'مكتب آخر');
  const staff = await http.addMember(a.office.id, phone(3), 'office_staff');
  const secondLandlord = await a.scoped.insert('landlords', { label: 'مالك ثان' });

  const form = await http.request('/office/units/buildings/new', { cookie: a.cookie });
  assert.equal(form.status, 200);
  assert.match(form.text, /اكتب اسماً مختصراً للتعريف، لا تكتب العنوان التفصيلي أو أرقام العدادات/);
  for (const field of ['address', 'street', 'deed', 'plot', 'lat', 'lng', 'meter']) assert.ok(!form.text.includes(`name="${field}`), field);
  assert.ok(form.text.indexOf('<option value="الرياض"') < form.text.indexOf('<option value="جدة"'), 'Riyadh first');

  const bad = await http.request('/office/units/buildings', { method: 'POST', cookie: a.cookie, form: { name: 'x', city: 'Paris' } });
  assert.equal(bad.status, 422);
  const foreign = await http.request('/office/units/buildings', {
    method: 'POST', cookie: a.cookie, form: { landlord_id: String(other.landlordId), name: 'عمارة مسروقة', city: 'الرياض' },
  });
  assert.equal(foreign.status, 422, 'a landlord of another office is refused');
  const [[none]] = await db.pool.query("SELECT COUNT(*) AS n FROM buildings WHERE name = 'عمارة مسروقة'");
  assert.equal(Number(none.n), 0);

  const created = await http.request('/office/units/buildings', {
    method: 'POST', cookie: staff, form: { landlord_id: String(a.landlordId), name: 'عمارة الملقا', city: 'الرياض', district: 'الملقا', notes: 'ملاحظة-مبنى-سرية' },
  });
  assert.equal(created.location, '/office/units?tab=buildings&done=building_created', 'staff can create');
  const [[building]] = await db.pool.query("SELECT * FROM buildings WHERE office_id = ? AND name = 'عمارة الملقا'", [a.office.id]);

  const list = await http.request('/office/units?tab=buildings', { cookie: a.cookie });
  assert.equal(itemCount(list.text), 1);
  assert.match(list.text, /0 وحدة/);

  // Empty building: the landlord may change.
  const moved = await http.request(`/office/units/buildings/${building.id}`, {
    method: 'POST', cookie: staff, form: { landlord_id: String(secondLandlord), name: 'عمارة الملقا', city: 'الرياض' },
  });
  assert.equal(moved.status, 302, 'staff can edit');
  // With a unit inside: moving is refused and nothing changes.
  await a.scoped.insert('units', { landlord_id: secondLandlord, building_id: building.id, label: 'شقة 1', city: 'الرياض' });
  const refused = await http.request(`/office/units/buildings/${building.id}`, {
    method: 'POST', cookie: a.cookie, form: { landlord_id: String(a.landlordId), name: 'اسم جديد', city: 'جدة' },
  });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /لا يمكن نقل مبنى فيه وحدات/);
  const [[still]] = await db.pool.query('SELECT landlord_id, name, city FROM buildings WHERE id = ?', [building.id]);
  assert.deepEqual({ ...still }, { landlord_id: secondLandlord, name: 'عمارة الملقا', city: 'الرياض' }, 'no partial update');

  assert.match((await http.request('/office/units?tab=buildings', { cookie: a.cookie })).text, /1 وحدة/);

  assert.equal((await http.request(`/office/units/buildings/${building.id}/delete`, { method: 'POST', cookie: staff })).status, 403);
  const withUnits = await http.request(`/office/units/buildings/${building.id}/delete`, { method: 'POST', cookie: a.cookie });
  assert.equal(withUnits.status, 409);
  assert.match(withUnits.text, /لا يمكن حذف مبنى فيه وحدات/);

  await db.pool.query('DELETE FROM units WHERE building_id = ?', [building.id]);
  const deleted = await http.request(`/office/units/buildings/${building.id}/delete`, { method: 'POST', cookie: a.cookie });
  assert.equal(deleted.location, '/office/units?tab=buildings&done=building_deleted');

  const [audits] = await db.pool.query(
    "SELECT action, before_json, after_json FROM audit_logs WHERE entity_type = 'building' AND entity_id = ? ORDER BY id", [building.id],
  );
  assert.deepEqual(audits.map((r) => r.action), ['building.create', 'building.update', 'building.delete']);
  assert.ok(!JSON.stringify(audits).includes('ملاحظة-مبنى-سرية'), 'no notes in audit');
});

// ------------------------------------------------------------ units

test('units: validation, building of another landlord or office, city from building, amenities, edit, audit', { skip }, async () => {
  const a = await officeWithLandlord(4, 'مكتب الوحدات');
  const other = await officeWithLandlord(5, 'مكتب غريب');
  const secondLandlord = await a.scoped.insert('landlords', { label: 'مالك ثان' });
  const buildingA = await a.scoped.insert('buildings', { landlord_id: a.landlordId, name: 'عمارة أ', city: 'جدة' });
  const buildingOfSecond = await a.scoped.insert('buildings', { landlord_id: secondLandlord, name: 'عمارة ب', city: 'الدمام' });
  const foreignBuilding = await other.scoped.insert('buildings', { landlord_id: other.landlordId, name: 'عمارة غريبة', city: 'الرياض' });

  const bad = await http.request('/office/units', {
    method: 'POST', cookie: a.cookie,
    form: unitForm(a.landlordId, { unit_type: 'castle', rooms: '-1', area_sqm: '-5', base_rent: '-100', notes: 'ن'.repeat(1001) }),
  });
  assert.equal(bad.status, 422);
  for (const text of ['اختر نوع الوحدة', 'عدد الغرف', 'المساحة رقم موجب', 'الإيجار رقم موجب', '1000 حرف']) assert.ok(bad.text.includes(text), text);
  assert.match(bad.text, /value="-1"/, 'typed values are shown again');

  for (const [form, field] of [
    [unitForm(a.landlordId, { building_id: String(buildingOfSecond) }), 'المبنى المختار لا يتبع هذا المالك'],
    [unitForm(a.landlordId, { building_id: String(foreignBuilding) }), 'المبنى المختار لا يتبع هذا المالك'],
    [unitForm(other.landlordId), 'اختر مالكاً من ملاك مكتبك'],
  ]) {
    const res = await http.request('/office/units', { method: 'POST', cookie: a.cookie, form });
    assert.equal(res.status, 422);
    assert.ok(res.text.includes(field), field);
  }
  assert.equal(await unitCount(a.office.id), 0);
  assert.equal(await unitCount(other.office.id), 0);

  const created = await http.request('/office/units', {
    method: 'POST', cookie: a.cookie,
    form: {
      ...unitForm(a.landlordId, { building_id: String(buildingA), city: '', label: 'شقة 3', base_rent: '45,000', rooms: '3', floor_no: '2', is_furnished: '1', notes: 'ملاحظة-وحدة-سرية' }),
      amenities: ['ac', 'parking'],
    },
  });
  assert.equal(created.status, 302, created.text.slice(0, 300));
  const id = idFrom(created.location);
  const [[row]] = await db.pool.query('SELECT * FROM units WHERE id = ?', [id]);
  assert.equal(row.city, 'جدة', 'city from the building');
  assert.equal(row.base_rent, '45000.00');
  assert.equal(row.currency, 'SAR');
  assert.equal(row.status, 'vacant');
  assert.equal(row.office_id, a.office.id);
  const [amen] = await db.pool.query('SELECT amenity FROM unit_amenities WHERE unit_id = ? ORDER BY amenity', [id]);
  assert.deepEqual(amen.map((r) => r.amenity), ['ac', 'parking']);

  const page = await http.request(`/office/units/${id}`, { cookie: a.cookie });
  assert.equal(page.status, 200);
  for (const text of ['شقة 3', 'مكيف', 'موقف سيارة', 'عمارة أ', '45,000', 'شاغرة', 'العقود', 'الصيانة', 'الصور']) assert.ok(page.text.includes(text), text);

  const edited = await http.request(`/office/units/${id}`, {
    method: 'POST', cookie: a.cookie,
    form: { ...unitForm(a.landlordId, { building_id: String(buildingA), label: 'شقة 3 أ', city: 'جدة', base_rent: '45000', rooms: '3', floor_no: '2', is_furnished: '1', notes: 'ملاحظة-وحدة-سرية-2' }), amenities: ['pool'] },
  });
  assert.equal(edited.location, `/office/units/${id}?done=saved`);
  const [amen2] = await db.pool.query('SELECT amenity FROM unit_amenities WHERE unit_id = ?', [id]);
  assert.deepEqual(amen2.map((r) => r.amenity), ['pool']);

  const [audits] = await db.pool.query("SELECT action, before_json, after_json FROM audit_logs WHERE entity_type = 'unit' AND entity_id = ? ORDER BY id", [id]);
  assert.deepEqual(audits.map((r) => r.action), ['unit.create', 'unit.update']);
  assert.deepEqual(audits[1].before_json, { label: 'شقة 3' });
  assert.deepEqual(audits[1].after_json, { label: 'شقة 3 أ', also_changed: ['notes', 'amenities'] });
  assert.ok(!JSON.stringify(audits).includes('ملاحظة-وحدة-سرية'), 'no notes in audit');

  // Quick add from the landlord page preselects the landlord.
  const landlordPage = await http.request(`/office/landlords/${a.landlordId}`, { cookie: a.cookie });
  assert.match(landlordPage.text, new RegExp(`href="/office/units/new\\?landlord=${a.landlordId}"`));
  assert.match(landlordPage.text, new RegExp(`href="/office/units/bulk\\?landlord=${a.landlordId}"`));
  assert.match(landlordPage.text, /الوحدات \(1\)/);
  assert.match(landlordPage.text, /شقة 3 أ/);
  const quick = await http.request(`/office/units/new?landlord=${a.landlordId}`, { cookie: a.cookie });
  assert.match(quick.text, new RegExp(`<option value="${a.landlordId}" selected>`));
  assert.match((await http.request('/office/landlords', { cookie: a.cookie })).text, /1 وحدة/);
});

test('the unit list searches, filters and pages by 20', { skip }, async () => {
  const a = await officeWithLandlord(6, 'مكتب القائمة');
  const second = await a.scoped.insert('landlords', { label: 'مالك آخر' });
  const building = await a.scoped.insert('buildings', { landlord_id: a.landlordId, name: 'عمارة الفلتر', city: 'الرياض' });
  const bulk = await http.request('/office/units/bulk', {
    method: 'POST', cookie: a.cookie,
    form: { landlord_id: String(a.landlordId), building_id: String(building), prefix: 'شقة', count: '22', start: '1', unit_type: 'apartment', base_rent: '30000' },
  });
  assert.equal(bulk.status, 302);
  await http.request('/office/units', { method: 'POST', cookie: a.cookie, form: unitForm(second, { label: 'محل 1', unit_type: 'shop' }) });
  await db.pool.query("UPDATE units SET status = 'maintenance' WHERE office_id = ? AND label = 'شقة 5'", [a.office.id]);

  const page1 = await http.request('/office/units', { cookie: a.cookie });
  assert.equal(itemCount(page1.text), 20);
  assert.match(page1.text, /23 وحدة/);
  assert.equal(itemCount((await http.request('/office/units?page=2', { cookie: a.cookie })).text), 3);
  const search = await http.request(`/office/units?q=${encodeURIComponent('شقة 1')}`, { cookie: a.cookie });
  assert.equal(itemCount(search.text), 11, 'شقة 1 and شقة 10..19');
  assert.equal(itemCount((await http.request(`/office/units?landlord=${second}`, { cookie: a.cookie })).text), 1);
  assert.equal(itemCount((await http.request(`/office/units?building=${building}`, { cookie: a.cookie })).text), 20);
  const maintenance = await http.request('/office/units?status=maintenance', { cookie: a.cookie });
  assert.equal(itemCount(maintenance.text), 1);
  assert.match(maintenance.text, /badge--unit-maintenance/);
  assert.equal(itemCount((await http.request('/office/units?type=shop', { cookie: a.cookie })).text), 1);
  assert.equal(itemCount((await http.request('/office/units?type=castle', { cookie: a.cookie })).text), 20, 'unknown filter ignored');
});

// ------------------------------------------------------------ isolation

test('office B gets 404 on every route with office A\'s unit or building ids', { skip }, async () => {
  const a = await officeWithLandlord(7, 'مكتب أ');
  const b = await officeWithLandlord(8, 'مكتب ب');
  const buildingA = await a.scoped.insert('buildings', { landlord_id: a.landlordId, name: 'عمارة أ', city: 'الرياض' });
  const unitA = await a.scoped.insert('units', { landlord_id: a.landlordId, building_id: buildingA, label: 'وحدة أ', city: 'الرياض' });
  await a.scoped.insert('unit_amenities', { unit_id: unitA, amenity: 'ac' });

  for (const path of [`/office/units/${unitA}`, `/office/units/${unitA}/edit`, `/office/units/buildings/${buildingA}/edit`, '/office/units/abc', '/office/units/0']) {
    assert.equal((await http.request(path, { cookie: b.cookie })).status, 404, path);
  }
  const posts = [
    [`/office/units/${unitA}`, { ...unitForm(b.landlordId, { label: 'اختراق' }), amenities: ['pool'] }],
    [`/office/units/${unitA}/status`, { status: 'maintenance' }],
    [`/office/units/${unitA}/delete`, {}],
    [`/office/units/buildings/${buildingA}`, { landlord_id: String(b.landlordId), name: 'اختراق', city: 'الرياض' }],
    [`/office/units/buildings/${buildingA}/delete`, {}],
  ];
  for (const [path, form] of posts) {
    assert.equal((await http.request(path, { method: 'POST', cookie: b.cookie, form })).status, 404, `POST ${path}`);
  }
  const [[unit]] = await db.pool.query('SELECT label, status FROM units WHERE id = ?', [unitA]);
  assert.deepEqual({ ...unit }, { label: 'وحدة أ', status: 'vacant' });
  const [amen] = await db.pool.query('SELECT amenity FROM unit_amenities WHERE unit_id = ?', [unitA]);
  assert.deepEqual(amen.map((r) => r.amenity), ['ac'], 'amenities untouched');
  const [[bld]] = await db.pool.query('SELECT name FROM buildings WHERE id = ?', [buildingA]);
  assert.equal(bld.name, 'عمارة أ');

  // Creating in B with A's landlord or building is refused and creates nothing anywhere.
  const bulk = await http.request('/office/units/bulk', {
    method: 'POST', cookie: b.cookie, form: { landlord_id: String(a.landlordId), prefix: 'شقة', count: '3', city: 'الرياض' },
  });
  assert.equal(bulk.status, 422);
  const bulkBuilding = await http.request('/office/units/bulk', {
    method: 'POST', cookie: b.cookie, form: { landlord_id: String(b.landlordId), building_id: String(buildingA), prefix: 'شقة', count: '3' },
  });
  assert.equal(bulkBuilding.status, 422);
  assert.equal(await unitCount(b.office.id), 0);
  assert.equal(await unitCount(a.office.id), 1);

  const list = await http.request(`/office/units?landlord=${a.landlordId}&building=${buildingA}`, { cookie: b.cookie });
  assert.equal(itemCount(list.text), 0);
  assert.ok(!list.text.includes('وحدة أ'));

  // The contract-system helpers refuse other offices' units too.
  const scopedB = scopeToOffice(db.pool, b.office.id);
  assert.equal(await unitStatus.setRented(scopedB, unitA), false);
  assert.equal(await unitStatus.setVacant(scopedB, unitA), false);
  assert.equal((await db.pool.query('SELECT status FROM units WHERE id = ?', [unitA]))[0][0].status, 'vacant');
});

// ------------------------------------------------------------ status

test('status: vacant <-> maintenance by hand; rented only through setRented / setVacant', { skip }, async () => {
  const a = await officeWithLandlord(9, 'مكتب الحالة');
  const staff = await http.addMember(a.office.id, phone(10), 'office_staff');
  const id = await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'شقة', city: 'الرياض' });
  const status = async () => (await db.pool.query('SELECT status FROM units WHERE id = ?', [id]))[0][0].status;
  const post = (value, cookie = staff) => http.request(`/office/units/${id}/status`, { method: 'POST', cookie, form: { status: value } });

  assert.equal((await post('maintenance')).location, `/office/units/${id}?done=status`);
  assert.equal(await status(), 'maintenance');
  assert.equal((await post('vacant')).status, 302);
  assert.equal(await status(), 'vacant');

  const toRented = await post('rented');
  assert.equal(toRented.status, 409);
  assert.match(toRented.text, /لا يمكن اختيارها يدوياً/);
  assert.equal((await post('sold')).status, 409);
  assert.equal(await status(), 'vacant');

  assert.equal(await unitStatus.setRented(a.scoped, id), true);
  assert.equal(await status(), 'rented');
  for (const value of ['vacant', 'maintenance']) {
    const res = await post(value, a.cookie);
    assert.equal(res.status, 409);
    assert.match(res.text, /الوحدة مؤجرة/);
  }
  assert.equal(await status(), 'rented');
  assert.ok(!(await http.request(`/office/units/${id}`, { cookie: a.cookie })).text.includes(`action="/office/units/${id}/status"`));

  assert.equal(await unitStatus.setVacant(a.scoped, id), true);
  assert.equal(await status(), 'vacant');

  // setVacant leaves a unit under maintenance alone; setRented works from maintenance.
  await post('maintenance');
  assert.equal(await unitStatus.setVacant(a.scoped, id), true);
  assert.equal(await status(), 'maintenance');
  assert.equal(await unitStatus.setRented(a.scoped, id), true);
  assert.equal(await status(), 'rented');
  assert.equal(await unitStatus.setRented(a.scoped, 999999999), false);

  const [audits] = await db.pool.query("SELECT before_json, after_json FROM audit_logs WHERE action = 'unit.status' AND entity_id = ? ORDER BY id", [id]);
  assert.deepEqual(audits.map((r) => `${r.before_json.status}>${r.after_json.status}`), [
    'vacant>maintenance', 'maintenance>vacant', 'vacant>rented', 'rented>vacant', 'vacant>maintenance', 'maintenance>rented',
  ]);
});

// ------------------------------------------------------------ plan limits

test('plan limit: single create stops at the limit, with the limit and a billing link', { skip }, async () => {
  const a = await officeWithLandlord(11, 'مكتب الحد', 'test_units_3');
  for (let i = 1; i <= 3; i += 1) {
    assert.equal((await http.request('/office/units', { method: 'POST', cookie: a.cookie, form: unitForm(a.landlordId, { label: `شقة ${i}` }) })).status, 302);
  }
  const fourth = await http.request('/office/units', { method: 'POST', cookie: a.cookie, form: unitForm(a.landlordId, { label: 'شقة 4' }) });
  assert.equal(fourth.status, 409);
  assert.match(fourth.text, /حد باقتك: 3 وحدة/);
  assert.match(fourth.text, /href="\/office\/billing"/);
  assert.equal(await unitCount(a.office.id), 3);
  assert.match((await http.request('/office/units', { cookie: a.cookie })).text, /3 من 3 وحدة/);
  assert.match((await http.request('/office', { cookie: a.cookie })).text, /حد الباقة: 3 من 3 وحدة/);
});

test('plan limit: a bulk create that would cross the limit creates nothing', { skip }, async () => {
  const a = await officeWithLandlord(12, 'مكتب الدفعة', 'test_units_5');
  await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'قديمة 1', city: 'الرياض' });
  await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'قديمة 2', city: 'الرياض' });
  const bulk = (count) => http.request('/office/units/bulk', {
    method: 'POST', cookie: a.cookie, form: { landlord_id: String(a.landlordId), prefix: 'شقة', count: String(count), start: '1', city: 'الرياض' },
  });
  const tooMany = await bulk(4);
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.text, /يمكنك إضافة 3 فقط/);
  assert.equal(await unitCount(a.office.id), 2, 'none of the 4 was created');
  assert.equal((await bulk(3)).status, 302);
  assert.equal(await unitCount(a.office.id), 5);
  const [audit] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'unit.bulk_create' AND office_id = ?", [a.office.id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after_json.count, 3);
  assert.equal(audit[0].after_json.first_label, 'شقة 1');
  assert.equal(audit[0].after_json.last_label, 'شقة 3');
});

test('plan limit: parallel creates cannot pass the limit', { skip }, async () => {
  const a = await officeWithLandlord(13, 'مكتب السباق', 'test_units_5');
  const singles = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    http.request('/office/units', { method: 'POST', cookie: a.cookie, form: unitForm(a.landlordId, { label: `سباق ${i}` }) })));
  assert.equal(singles.filter((r) => r.status === 302).length, 5);
  assert.equal(singles.filter((r) => r.status === 409).length, 5);
  assert.equal(await unitCount(a.office.id), 5);

  const b = await officeWithLandlord(14, 'مكتب سباق الدفعات', 'test_units_5');
  const bulks = await Promise.all(Array.from({ length: 4 }, () =>
    http.request('/office/units/bulk', {
      method: 'POST', cookie: b.cookie, form: { landlord_id: String(b.landlordId), prefix: 'شقة', count: '2', city: 'الرياض' },
    })));
  assert.equal(bulks.filter((r) => r.status === 302).length, 2);
  assert.equal(await unitCount(b.office.id), 4, 'two batches of 2; a third would pass 5');
});

// ------------------------------------------------------------ delete and capabilities

test('delete rules: rented units and units with a contract stay; staff cannot delete', { skip }, async () => {
  const a = await officeWithLandlord(15, 'مكتب الحذف');
  const staff = await http.addMember(a.office.id, phone(16), 'office_staff');
  const plain = await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'عادية', city: 'الرياض' });
  const rented = await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'مؤجرة', city: 'الرياض' });
  await unitStatus.setRented(a.scoped, rented);
  const withContract = await a.scoped.insert('units', { landlord_id: a.landlordId, label: 'لها عقد', city: 'الرياض' });
  await a.scoped.insert('contracts', { landlord_id: a.landlordId, unit_id: withContract, start_date: '2025-01-01', end_date: '2025-12-31', annual_rent: 30000, status: 'ended' });

  const staffEdit = await http.request(`/office/units/${plain}`, { method: 'POST', cookie: staff, form: unitForm(a.landlordId, { label: 'عادية معدلة' }) });
  assert.equal(staffEdit.status, 302, 'staff can edit');
  const staffPage = await http.request(`/office/units/${plain}`, { cookie: staff });
  assert.ok(!staffPage.text.includes('/delete"'), 'no delete button for staff');
  assert.equal((await http.request(`/office/units/${plain}/delete`, { method: 'POST', cookie: staff })).status, 403);

  const r1 = await http.request(`/office/units/${rented}/delete`, { method: 'POST', cookie: a.cookie });
  assert.equal(r1.status, 409);
  assert.match(r1.text, /لا يمكن حذف وحدة مؤجرة/);
  const r2 = await http.request(`/office/units/${withContract}/delete`, { method: 'POST', cookie: a.cookie });
  assert.equal(r2.status, 409);
  assert.match(r2.text, /لا يمكن حذف وحدة لها عقد/);
  assert.ok(!(await http.request(`/office/units/${withContract}`, { cookie: a.cookie })).text.includes('/delete"'));

  const ok = await http.request(`/office/units/${plain}/delete`, { method: 'POST', cookie: a.cookie });
  assert.equal(ok.location, '/office/units?done=deleted');
  const [[left]] = await db.pool.query('SELECT COUNT(*) AS n FROM units WHERE id IN (?, ?, ?)', [plain, rented, withContract]);
  assert.equal(Number(left.n), 2);
  const [[audit]] = await db.pool.query("SELECT before_json FROM audit_logs WHERE action = 'unit.delete' AND entity_id = ?", [plain]);
  assert.equal(audit.before_json.label, 'عادية معدلة');
});

test('landlord and tenant roles get 403 on /office/units', { skip }, async () => {
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord'), (?, 'tenant')", [phone(17), phone(18)]);
  for (const p of [phone(17), phone(18)]) {
    const { cookie } = await http.login(p);
    for (const path of ['/office/units', '/office/units/new', '/office/units/bulk']) {
      assert.equal((await http.request(path, { cookie })).status, 403, `${p} ${path}`);
    }
    assert.equal((await http.request('/office/units', { method: 'POST', cookie, form: { label: 'x' } })).status, 403);
  }
});

// ------------------------------------------------------------ dashboard and sidebar

test('dashboard unit numbers, checklist tick and sidebar highlight', { skip }, async () => {
  const a = await officeWithLandlord(19, 'مكتب اللوحة', 'test_units_5');
  const before = await http.request('/office', { cookie: a.cookie });
  assert.match(before.text, /<a href="\/office\/units">\s*<span class="checklist__box" aria-hidden="true"><\/span>/, 'not ticked yet');

  const ids = [];
  for (const label of ['و1', 'و2', 'و3', 'و4']) ids.push(await a.scoped.insert('units', { landlord_id: a.landlordId, label, city: 'الرياض' }));
  await unitStatus.setRented(a.scoped, ids[0]);
  await unitStatus.setRented(a.scoped, ids[1]);
  await unitStatus.changeStatusByHand(a.scoped, ids[2], 'maintenance');

  const home = await http.request('/office', { cookie: a.cookie });
  const summary = home.text.slice(home.text.indexOf('units-summary'), home.text.indexOf('يحتاج إجراء'));
  assert.match(summary, /<strong class="stat__units-total">4<\/strong> كل الوحدات/);
  assert.match(summary, /<strong>1<\/strong> شاغرة/);
  assert.match(summary, /<strong>2<\/strong> مؤجرة/);
  assert.match(summary, /<strong>1<\/strong> تحت الصيانة/);
  assert.match(summary, /4 من 5 وحدة/);
  assert.match(home.text, /<a href="\/office\/units" class="is-done">/);

  const page = await http.request(`/office/units/${ids[0]}`, { cookie: a.cookie });
  assert.match(page.text, /<a href="\/office\/units" aria-current="page">العقارات والوحدات<\/a>/);
  assert.equal((page.text.match(/aria-current="page"/g) || []).length, 1);
});
