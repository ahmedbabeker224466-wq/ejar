'use strict';

// Multi-office isolation matrix: every table that carries office_id is either
// scoped through scopeToOffice or on a reviewed list, and an office scoped to B
// can never read, change or delete a row that belongs to A, for every scoped
// table that has rows. Runs only when TEST_DB_NAME is set.

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

// Every phone this file signs in with: 9665000020NN.
const phone = (n) => `9665000020${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 30 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let scopeMod;
let uploadDir;
let A;
let B;
let contractA;

// Tables with an office_id column that are NOT reached through scopeToOffice, with the reason.
const UNSCOPED_ALLOWED = {
  audit_logs: 'append-only trail written by services/audit.js, read by office_id in /office/audit and by the platform admin',
  notifications: 'addressed to one user_id; every read and change is filtered by the signed-in user id',
  delivery_log: 'queue rows of notifications; read only by the delivery worker and the user-id filtered pages',
  message_templates: 'platform-wide templates; office_id NULL means global',
  testimonials: 'marketing quotes written by the platform admin',
};

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500002000';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-iso-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, features, is_public, is_active, sort_order)
     VALUES ('iso_plan', 'اختبار عزل', 1, 10, '{"listings":true}', 0, 1, 541)
     ON DUPLICATE KEY UPDATE features = VALUES(features)`,
  );
  scopeMod = require('../services/scopeToOffice');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'iso_plan' });
  A = await fx.office(1, 'تجربة-عزل-أ', { landlords: 1, units: 3 });
  B = await fx.office(2, 'تجربة-عزل-ب', { landlords: 1, units: 3 });
  contractA = await fx.contract(A);
  await fx.contract(B);

  // Rows in the less common tables, owned by A.
  const s = A.scoped;
  const owner = A.user.id;
  await s.insert('office_tasks', { title: 'مهمة', description: 'وصف', status: 'todo', created_by: owner }).catch(() => {});
  await s.insert('vendors', { name: 'مورد', category: 'other' }).catch(() => {});
  await db.pool.query(
    `INSERT INTO listings (office_id, unit_id, title, description, price, currency, status, unit_type, city, neighborhood, rooms, bathrooms, area_sqm, features)
     VALUES (?, ?, 'عنوان', 'وصف', 36000, 'SAR', 'draft', 'apartment', 'الرياض', 'الملقا', 3, 2, 100, '[]')`,
    [A.office.id, A.units[1]],
  ).catch(() => {});
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'iso\\_%'");
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

test('every table with an office_id column is scoped or on the reviewed list', { skip }, async () => {
  const [rows] = await db.pool.query(
    "SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'office_id'",
  );
  assert.ok(rows.length >= 30);
  const unknown = rows.map((r) => r.t).filter((t) => !scopeMod.OFFICE_TABLES.has(t) && !Object.hasOwn(UNSCOPED_ALLOWED, t));
  assert.deepEqual(unknown, [], `tables with office_id that nothing scopes: ${unknown.join(', ')}`);
  // And the other way round: a scoped table must exist and carry office_id (children carry their parent's).
  const have = new Set(rows.map((r) => r.t));
  for (const t of scopeMod.OFFICE_TABLES) assert.ok(have.has(t), `OFFICE_TABLES lists ${t} but it has no office_id column`);
  const [tables] = await db.pool.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  const existing = new Set(tables.map((r) => r.t));
  for (const [child, { parent, key }] of Object.entries(scopeMod.CHILD_TABLES)) {
    assert.ok(existing.has(child), `${child} does not exist`);
    assert.ok(have.has(parent) || scopeMod.OFFICE_TABLES.has(parent), `${child}'s parent ${parent} is not office-owned`);
    const [[col]] = await db.pool.query(
      'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [child, key],
    );
    assert.equal(Number(col.n), 1, `${child}.${key} is missing`);
  }
});

test('an office scoped to B can not read, change or delete any row of A in any scoped table', { skip }, async () => {
  const scopedB = scopeMod.scopeToOffice(db.pool, B.office.id);
  const scopedA = scopeMod.scopeToOffice(db.pool, A.office.id);
  const tables = [...scopeMod.OFFICE_TABLES, ...Object.keys(scopeMod.CHILD_TABLES)];
  let checked = 0;
  for (const table of tables) {
    const [[hasId]] = await db.pool.query(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'id'", [table],
    );
    if (!Number(hasId.n)) continue;
    // A's rows: seen through A's own scope.
    const own = await scopedA.select(table, {}, { columns: ['id'], limit: 5 });
    if (!own.length) continue;
    for (const { id } of own) {
      assert.equal((await scopedB.select(table, { id })).length, 0, `${table} ${id} readable by another office`);
      assert.equal(await scopedB.selectOne(table, { id }), null, `${table} ${id} readable (selectOne)`);
      const upd = await scopedB.update(table, { id }, { updated_at: new Date() }).catch((e) => e);
      assert.ok(upd instanceof Error || Number(upd) === 0 || Number(upd?.affectedRows ?? upd) === 0, `${table} ${id} changed by another office`);
      const del = await scopedB.remove(table, { id }).catch((e) => e);
      assert.ok(del instanceof Error || Number(del) === 0 || Number(del?.affectedRows ?? del) === 0, `${table} ${id} deleted by another office`);
    }
    // Still there for the owner.
    assert.equal((await scopedA.select(table, { id: own[0].id })).length, 1, `${table} ${own[0].id} vanished`);
    checked += 1;
  }
  assert.ok(checked >= 10, `only ${checked} scoped tables had data to check`);
  // The raw escape hatch refuses a query that does not pin the office.
  for (const sql of ['SELECT * FROM contracts', 'SELECT * FROM units u JOIN landlords l ON l.id = u.landlord_id', 'DELETE FROM payment_entries', 'SELECT * FROM unit_photos']) {
    await assert.rejects(scopedB.query(sql), scopeMod.OfficeScopeError, sql);
  }
  // With :office_id the rows are only B's.
  const rows = await scopedB.query('SELECT office_id FROM contracts WHERE office_id = :office_id');
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => Number(r.office_id) === Number(B.office.id)));
  // A write that names another office is refused.
  await assert.rejects(scopedB.insert('landlords', { label: 'x', city: 'جدة', office_id: A.office.id }), scopeMod.OfficeScopeError);
  await assert.rejects(scopedB.update('landlords', { id: A.landlordId }, { office_id: B.office.id }), scopeMod.OfficeScopeError);
  // A child row can not be added under another office's parent.
  await assert.rejects(scopedB.insert('unit_amenities', { unit_id: A.units[0], amenity: 'ac' }), scopeMod.OfficeScopeError);
});

test('an owner of office B gets 404 for every id of office A over HTTP', { skip }, async () => {
  const [[pay]] = await db.pool.query('SELECT id FROM contract_payments WHERE contract_id = ? ORDER BY id LIMIT 1', [contractA]);
  const [[listing]] = await db.pool.query('SELECT id FROM listings WHERE office_id = ? LIMIT 1', [A.office.id]);
  const [[task]] = await db.pool.query('SELECT id FROM office_tasks WHERE office_id = ? LIMIT 1', [A.office.id]);
  const paths = [
    ['GET', `/office/contracts/${contractA}`], ['GET', `/office/contracts/${contractA}/edit`], ['GET', `/office/contracts/${contractA}/terminate`],
    ['GET', `/office/contracts/${contractA}/renew`], ['GET', `/office/contracts/${contractA}/receipt`],
    ['POST', `/office/contracts/${contractA}/terminate`], ['POST', `/office/contracts/${contractA}/delete`], ['POST', `/office/contracts/${contractA}/invite`],
    ['POST', `/office/contracts/${contractA}/payments/${pay.id}`], ['POST', `/office/contracts/${contractA}/payments/${pay.id}/entries`],
    ['GET', `/office/landlords/${A.landlordId}`], ['GET', `/office/landlords/${A.landlordId}/edit`], ['POST', `/office/landlords/${A.landlordId}`],
    ['POST', `/office/landlords/${A.landlordId}/deactivate`], ['POST', `/office/landlords/${A.landlordId}/delete`], ['POST', `/office/landlords/${A.landlordId}/invite`],
    ['GET', `/office/units/${A.units[0]}`], ['GET', `/office/units/${A.units[0]}/edit`], ['POST', `/office/units/${A.units[0]}`],
    ['POST', `/office/units/${A.units[0]}/status`], ['POST', `/office/units/${A.units[0]}/delete`],
  ];
  if (listing) paths.push(['GET', `/office/listings/${listing.id}`], ['POST', `/office/listings/${listing.id}`], ['POST', `/office/listings/${listing.id}/publish`], ['POST', `/office/listings/${listing.id}/delete`]);
  if (task) paths.push(['GET', `/office/tasks/${task.id}`]);
  for (const [method, p] of paths) {
    const res = await http.request(p, { method, cookie: B.cookie, form: method === 'POST' ? { x: '1', reason: 'اختبار' } : undefined });
    assert.equal(res.status, 404, `${method} ${p} answered ${res.status} to another office`);
  }
  // Nothing of A changed.
  const [[still]] = await db.pool.query('SELECT status FROM contracts WHERE id = ?', [contractA]);
  assert.notEqual(still.status, 'terminated');
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS c FROM landlords WHERE id = ?', [A.landlordId]))[0][0].c), 1);

  // And the lists of B never show A's nicknames.
  for (const p of ['/office', '/office/landlords', '/office/units', '/office/contracts', '/office/payments', '/office/listings', '/office/tenants', '/office/audit']) {
    const res = await http.request(p, { cookie: B.cookie });
    assert.ok(res.status < 500, p);
    assert.ok(!res.text.includes('تجربة-عزل-أ'), `${p} shows the other office's name`);
    assert.ok(!res.text.includes(`مالك 1 تجربة-عزل-أ`), `${p} shows the other office's landlord`);
  }
});
