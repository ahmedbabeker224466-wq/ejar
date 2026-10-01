'use strict';

// Landlords and invite codes against real MySQL, over HTTP where a person
// would click, and through services/invites.js for the join-side functions.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000002NN. Landlord phones: 9665111100NN.
const phone = (n) => `9665000002${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 60 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let invites;
let scopeToOffice;

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
  invites = require('../services/invites');
  ({ scopeToOffice } = require('../services/scopeToOffice'));
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
const idFrom = (location) => Number(/\/office\/landlords\/(\d+)/.exec(location)[1]);

async function activeInvites(landlordId) {
  const [rows] = await db.pool.query(
    `SELECT * FROM invites WHERE landlord_id = ? AND used_at IS NULL AND revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP()`,
    [landlordId],
  );
  return rows;
}

/** The same transaction the "create invite" button runs. */
function createInviteFor(officeId, landlordId, createdBy) {
  const { withTransaction } = require('../services/transaction');
  return withTransaction(db.pool, (conn) =>
    invites.createLandlordInvite(scopeToOffice(conn, officeId), { landlordId, createdBy }),
  );
}

// ------------------------------------------------------------ schema

test('invites.revoked_at is a registered migration and exists after ensureSchema', { skip }, async () => {
  // Never drop a shared column here: other test files use the same database at
  // the same time. The migration mechanism itself is tested on a scratch table.
  const { COLUMN_ADDITIONS } = require('../database/schema');
  assert.ok(COLUMN_ADDITIONS.some((c) => c.table === 'invites' && c.column === 'revoked_at'));
  assert.equal((await db.ensureSchema()).ok, true);
  const [cols] = await db.pool.query(
    `SELECT is_nullable AS nullable, data_type AS type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'invites' AND column_name = 'revoked_at'`,
  );
  assert.deepEqual(cols.map((c) => [c.nullable, c.type]), [['YES', 'datetime']]);
});

test('missing columns are added once, even when several workers start together', { skip }, async () => {
  const table = 'zz_test_migration_landlords';
  await db.pool.query(`DROP TABLE IF EXISTS ${table}`);
  await db.pool.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, used_at DATETIME NULL)`);
  try {
    const additions = [{ table, column: 'revoked_at', definition: 'DATETIME NULL AFTER used_at' }];
    const results = await Promise.all([1, 2, 3].map(() => db.addMissingColumns(db.pool, additions)));
    assert.deepEqual(results.flat(), [`${table}.revoked_at`], 'exactly one worker added it; none failed');
    const [cols] = await db.pool.query(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [table],
    );
    assert.deepEqual(cols.map((c) => c.name), ['id', 'used_at', 'revoked_at']);
    assert.deepEqual(await db.addMissingColumns(db.pool, additions), [], 'running again adds nothing');
  } finally {
    await db.pool.query(`DROP TABLE IF EXISTS ${table}`);
  }
});

// ------------------------------------------------------------ CRUD

test('create, validate, edit, deactivate and reactivate a landlord; audit rows hold no phone or notes', { skip }, async () => {
  const owner = await http.registerOffice(phone(1), 'مكتب الملاك');

  const empty = await http.request('/office/landlords', { cookie: owner.cookie });
  assert.equal(empty.status, 200);
  assert.match(empty.text, /لا يوجد ملاك بعد/);
  assert.match(empty.text, /href="\/office\/landlords\/new"/);

  const form = await http.request('/office/landlords/new', { cookie: owner.cookie });
  assert.match(form.text, /اكتب اسماً مختصراً للتعريف فقط، لا تكتب الهوية أو الحساب البنكي/);
  for (const field of ['national_id', 'iqama', 'iban', 'address']) assert.ok(!form.text.includes(`name="${field}"`), field);

  const bad = await http.request('/office/landlords', {
    method: 'POST', cookie: owner.cookie, form: { label: '', phone: '12345', notes: 'x'.repeat(1001) },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /اكتب اسماً مختصراً للمالك/);
  assert.match(bad.text, /اكتب رقم جوال سعودي صحيح/);
  assert.match(bad.text, /1000 حرف/);

  const created = await http.request('/office/landlords', {
    method: 'POST', cookie: owner.cookie,
    form: { label: 'أبو فهد', city: 'الرياض', phone: '٠٥٠ ١١١ ٢٢٣٣', notes: 'ملاحظة-سرية-1' },
  });
  assert.equal(created.status, 302);
  const id = idFrom(created.location);
  const [[row]] = await db.pool.query('SELECT * FROM landlords WHERE id = ?', [id]);
  assert.equal(row.office_id, owner.office.id);
  assert.equal(row.phone, '966501112233', 'phone normalised');
  assert.equal(row.label, 'أبو فهد');

  const detail = await http.request(`/office/landlords/${id}`, { cookie: owner.cookie });
  assert.equal(detail.status, 200);
  assert.match(detail.text, /أبو فهد/);
  assert.match(detail.text, /0501112233/);
  assert.match(detail.text, /غير مدعو/);
  assert.match(detail.text, /إنشاء رمز دعوة/);

  const edited = await http.request(`/office/landlords/${id}`, {
    method: 'POST', cookie: owner.cookie,
    form: { label: 'أبو فهد الكبير', city: 'جدة', phone: '0502223344', notes: 'ملاحظة-سرية-2' },
  });
  assert.equal(edited.location, `/office/landlords/${id}?done=saved`);
  const [[after]] = await db.pool.query('SELECT label, city, phone, notes FROM landlords WHERE id = ?', [id]);
  assert.deepEqual({ ...after }, { label: 'أبو فهد الكبير', city: 'جدة', phone: '966502223344', notes: 'ملاحظة-سرية-2' });

  await http.request(`/office/landlords/${id}/deactivate`, { method: 'POST', cookie: owner.cookie });
  assert.equal((await db.pool.query('SELECT is_active FROM landlords WHERE id = ?', [id]))[0][0].is_active, 0);
  assert.match((await http.request(`/office/landlords/${id}`, { cookie: owner.cookie })).text, /موقوف/);
  await http.request(`/office/landlords/${id}/activate`, { method: 'POST', cookie: owner.cookie });
  assert.equal((await db.pool.query('SELECT is_active FROM landlords WHERE id = ?', [id]))[0][0].is_active, 1);

  const [audits] = await db.pool.query(
    "SELECT action, before_json, after_json FROM audit_logs WHERE entity_type = 'landlord' AND entity_id = ? ORDER BY id",
    [id],
  );
  assert.deepEqual(audits.map((a) => a.action), ['landlord.create', 'landlord.update', 'landlord.deactivate', 'landlord.activate']);
  const text = JSON.stringify(audits);
  for (const secret of ['501112233', '502223344', 'ملاحظة-سرية']) assert.ok(!text.includes(secret), `audit leaks ${secret}`);
  assert.deepEqual(audits[1].before_json, { label: 'أبو فهد', city: 'الرياض' });
  assert.deepEqual(audits[1].after_json, { label: 'أبو فهد الكبير', city: 'جدة', also_changed: ['phone', 'notes'] });

  // The dashboard ticks "add first landlord" and counts landlords.
  const home = await http.request('/office', { cookie: owner.cookie });
  assert.match(home.text, /<a href="\/office\/landlords" class="is-done">/);
  assert.match(home.text, /class="stat__value">1<\/p>\s*<p class="stat__label">الملّاك/);
});

test('the list pages by 20 and searches by label and phone; status filter works', { skip }, async () => {
  const owner = await http.registerOffice(phone(2), 'مكتب الصفحات');
  const scoped = scopeToOffice(db.pool, owner.office.id);
  for (let i = 1; i <= 25; i += 1) {
    await scoped.insert('landlords', { label: `مالك ${String(i).padStart(2, '0')}`, phone: `9665111100${String(i).padStart(2, '0')}` });
  }
  const page1 = await http.request('/office/landlords', { cookie: owner.cookie });
  assert.equal(itemCount(page1.text), 20);
  assert.match(page1.text, /صفحة 1 من 2/);
  assert.match(page1.text, /href="\/office\/landlords\?page=2"/);
  const page2 = await http.request('/office/landlords?page=2', { cookie: owner.cookie });
  assert.equal(itemCount(page2.text), 5);
  assert.match(page2.text, /مالك 25/);
  assert.equal(itemCount((await http.request('/office/landlords?page=99', { cookie: owner.cookie })).text), 5, 'page is clamped');

  const byLabel = await http.request(`/office/landlords?q=${encodeURIComponent('مالك 07')}`, { cookie: owner.cookie });
  assert.equal(itemCount(byLabel.text), 1);
  assert.match(byLabel.text, /مالك 07/);
  const byPhone = await http.request('/office/landlords?q=0511110013', { cookie: owner.cookie });
  assert.equal(itemCount(byPhone.text), 1);
  assert.match(byPhone.text, /مالك 13/);
  const none = await http.request('/office/landlords?q=%25', { cookie: owner.cookie });
  assert.equal(itemCount(none.text), 0, '% is literal, not a wildcard');
  assert.match(none.text, /لا توجد نتائج/);

  // Status: one joined, one invited, the rest not invited.
  const [[l1]] = await db.pool.query("SELECT id FROM landlords WHERE office_id = ? AND label = 'مالك 01'", [owner.office.id]);
  const [[l2]] = await db.pool.query("SELECT id FROM landlords WHERE office_id = ? AND label = 'مالك 02'", [owner.office.id]);
  const [u] = await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord')", [phone(3)]);
  await db.pool.query('UPDATE landlords SET user_id = ? WHERE id = ?', [u.insertId, l1.id]);
  await createInviteFor(owner.office.id, l2.id, owner.user.id);
  const joined = await http.request('/office/landlords?status=joined', { cookie: owner.cookie });
  assert.equal(itemCount(joined.text), 1);
  assert.match(joined.text, /مالك 01/);
  const invited = await http.request('/office/landlords?status=invited', { cookie: owner.cookie });
  assert.equal(itemCount(invited.text), 1);
  assert.match(invited.text, /مالك 02/);
  const notInvited = await http.request('/office/landlords?status=not_invited', { cookie: owner.cookie });
  assert.match(notInvited.text, /23 مالك/);
});

// ------------------------------------------------------------ permissions and delete

test('staff can view and create but not delete; a landlord with units or contracts is never deleted', { skip }, async () => {
  const owner = await http.registerOffice(phone(4), 'مكتب الحذف');
  const staff = await http.addMember(owner.office.id, phone(5), 'office_staff');
  const scoped = scopeToOffice(db.pool, owner.office.id);

  const created = await http.request('/office/landlords', { method: 'POST', cookie: staff, form: { label: 'مالك الموظف' } });
  assert.equal(created.status, 302, 'staff can create');
  const plain = idFrom(created.location);
  const staffView = await http.request(`/office/landlords/${plain}`, { cookie: staff });
  assert.equal(staffView.status, 200);
  assert.ok(!staffView.text.includes('/delete"'), 'no delete button for staff');
  assert.equal((await http.request(`/office/landlords/${plain}/delete`, { method: 'POST', cookie: staff })).status, 403);

  const withUnit = await scoped.insert('landlords', { label: 'مالك له وحدة' });
  await scoped.insert('units', { landlord_id: withUnit, label: 'شقة 1', city: 'الرياض' });
  const withContract = await scoped.insert('landlords', { label: 'مالك له عقد' });
  await scoped.insert('contracts', { landlord_id: withContract, start_date: '2026-01-01', end_date: '2026-12-31', annual_rent: 30000 });

  for (const id of [withUnit, withContract]) {
    const view = await http.request(`/office/landlords/${id}`, { cookie: owner.cookie });
    assert.ok(!view.text.includes('/delete"'), 'no delete button when linked');
    const attempt = await http.request(`/office/landlords/${id}/delete`, { method: 'POST', cookie: owner.cookie });
    assert.equal(attempt.status, 409);
    assert.match(attempt.text, /لا يمكن حذف مالك مرتبط/);
    const [[still]] = await db.pool.query('SELECT COUNT(*) AS n FROM landlords WHERE id = ?', [id]);
    assert.equal(Number(still.n), 1);
  }
  const [[units]] = await db.pool.query('SELECT COUNT(*) AS n FROM units WHERE landlord_id = ?', [withUnit]);
  assert.equal(Number(units.n), 1, 'the unit survived');

  const ownerView = await http.request(`/office/landlords/${plain}`, { cookie: owner.cookie });
  assert.ok(ownerView.text.includes(`action="/office/landlords/${plain}/delete"`));
  const deleted = await http.request(`/office/landlords/${plain}/delete`, { method: 'POST', cookie: owner.cookie });
  assert.equal(deleted.location, '/office/landlords?done=deleted');
  const [[gone]] = await db.pool.query('SELECT COUNT(*) AS n FROM landlords WHERE id = ?', [plain]);
  assert.equal(Number(gone.n), 0);
  const [[audit]] = await db.pool.query("SELECT before_json FROM audit_logs WHERE action = 'landlord.delete' AND entity_id = ?", [plain]);
  assert.deepEqual(audit.before_json, { label: 'مالك الموظف', city: null, is_active: 1 });
});

// ------------------------------------------------------------ isolation

test('office B cannot read, edit, deactivate, delete, invite or revoke office A\'s landlord (404)', { skip }, async () => {
  const a = await http.registerOffice(phone(6), 'مكتب أ');
  const b = await http.registerOffice(phone(7), 'مكتب ب');
  const scopedA = scopeToOffice(db.pool, a.office.id);
  const id = await scopedA.insert('landlords', { label: 'مالك أ', phone: '966511110099', notes: 'خاص بمكتب أ' });
  const invite = await createInviteFor(a.office.id, id, a.user.id);
  assert.equal(invite.ok, true);

  for (const path of [`/office/landlords/${id}`, `/office/landlords/${id}/edit`, '/office/landlords/abc', '/office/landlords/0']) {
    const res = await http.request(path, { cookie: b.cookie });
    assert.equal(res.status, 404, path);
    assert.ok(!res.text.includes('مالك أ'));
  }
  for (const action of ['', '/deactivate', '/activate', '/delete', '/invite', '/invite/revoke']) {
    const res = await http.request(`/office/landlords/${id}${action}`, {
      method: 'POST', cookie: b.cookie, form: { label: 'اختراق', office_id: String(a.office.id) },
    });
    assert.equal(res.status, 404, `POST ${action || '(edit)'}`);
  }
  const list = await http.request(`/office/landlords?q=${encodeURIComponent('مالك أ')}&office_id=${a.office.id}`, { cookie: b.cookie });
  assert.equal(itemCount(list.text), 0);
  assert.ok(!list.text.includes(`/office/landlords/${id}"`), 'no link to A\'s landlord');

  const [[row]] = await db.pool.query('SELECT label, is_active FROM landlords WHERE id = ?', [id]);
  assert.deepEqual({ ...row }, { label: 'مالك أ', is_active: 1 });
  assert.equal((await activeInvites(id)).length, 1, 'A\'s invite is untouched');
  const [[count]] = await db.pool.query('SELECT COUNT(*) AS n FROM invites WHERE landlord_id = ?', [id]);
  assert.equal(Number(count.n), 1, 'B created no invite for A\'s landlord');

  // The service refuses too, even when called with a guessed id.
  const conn = await db.pool.getConnection();
  try {
    const refused = await invites.createLandlordInvite(scopeToOffice(conn, b.office.id), { landlordId: id, createdBy: b.user.id });
    assert.deepEqual(refused, { ok: false, reason: 'not_found' });
    assert.equal(await invites.revokeInvite(scopeToOffice(conn, b.office.id), { landlordId: id, actorId: b.user.id }), false);
  } finally {
    conn.release();
  }
});

// ------------------------------------------------------------ invites

test('invite lifecycle: create, replace, revoke, expire, use, and every validation reason', { skip }, async () => {
  const owner = await http.registerOffice(phone(8), 'مكتب الدعوات');
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const id = await scoped.insert('landlords', { label: 'مالك مدعو', phone: '966511110088' });

  const first = await http.request(`/office/landlords/${id}/invite`, { method: 'POST', cookie: owner.cookie });
  assert.equal(first.location, `/office/landlords/${id}?done=invite_created#invite`);
  const [one] = await activeInvites(id);
  assert.equal(one.kind, 'landlord');
  assert.equal(one.office_id, owner.office.id);
  assert.equal(one.created_by, owner.user.id);
  assert.match(one.code, /^[A-HJKMNP-Z2-9]{8}$/);
  const days = (new Date(one.expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 29.99 && days < 30.01, `expires in 30 days (${days})`);

  const page = await http.request(`/office/landlords/${id}`, { cookie: owner.cookie });
  assert.match(page.text, new RegExp(`<output id="invite-code" dir="ltr">${one.code}</output>`));
  assert.match(page.text, /data-copy="#invite-code"/);
  const link = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(page.text)[1].replace(/&amp;/g, '&');
  assert.ok(link.startsWith('https://wa.me/966511110088?text='));
  const message = decodeURIComponent(link.split('?text=')[1]);
  assert.ok(message.includes(one.code));
  assert.ok(message.includes('https://aqdi.example/join'));
  assert.match(page.text, /فعّال/);

  // A second create revokes the first: exactly one active invite.
  await http.request(`/office/landlords/${id}/invite`, { method: 'POST', cookie: owner.cookie });
  const active = await activeInvites(id);
  assert.equal(active.length, 1);
  assert.notEqual(active[0].code, one.code);
  const [[old]] = await db.pool.query('SELECT revoked_at FROM invites WHERE id = ?', [one.id]);
  assert.ok(old.revoked_at, 'first invite revoked');
  assert.deepEqual(await invites.validateInviteCode(db.pool, one.code), { ok: false, reason: 'revoked' });

  const valid = await invites.validateInviteCode(db.pool, ` ${active[0].code.toLowerCase().replace(/(....)/, '$1-')} `);
  assert.equal(valid.ok, true);
  assert.deepEqual(
    { id: valid.invite.id, kind: valid.invite.kind, officeId: valid.invite.officeId, landlordId: valid.invite.landlordId },
    { id: Number(active[0].id), kind: 'landlord', officeId: owner.office.id, landlordId: id },
  );

  // Revoke button.
  const revoked = await http.request(`/office/landlords/${id}/invite/revoke`, { method: 'POST', cookie: owner.cookie });
  assert.equal(revoked.location, `/office/landlords/${id}?done=invite_revoked#invite`);
  assert.equal((await activeInvites(id)).length, 0);
  assert.deepEqual(await invites.validateInviteCode(db.pool, active[0].code), { ok: false, reason: 'revoked' });
  const afterRevoke = await http.request(`/office/landlords/${id}`, { cookie: owner.cookie });
  assert.match(afterRevoke.text, /ملغى/);
  assert.ok(!afterRevoke.text.includes(active[0].code), 'a revoked code is not shown');

  // Expired.
  const third = await createInviteFor(owner.office.id, id, owner.user.id);
  await db.pool.query('UPDATE invites SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [third.invite.id]);
  assert.deepEqual(await invites.validateInviteCode(db.pool, third.invite.code), { ok: false, reason: 'expired' });
  assert.equal(await invites.markInviteUsed(db.pool, third.invite.code, owner.user.id), false, 'expired codes cannot be used');
  assert.match((await http.request(`/office/landlords/${id}`, { cookie: owner.cookie })).text, /منتهي/);

  // Used, shown with a masked phone.
  const fourth = await createInviteFor(owner.office.id, id, owner.user.id);
  const [joiner] = await db.pool.query('INSERT INTO users (phone) VALUES (?)', [phone(9)]);
  assert.equal(await invites.markInviteUsed(db.pool, fourth.invite.code, joiner.insertId), true);
  assert.equal(await invites.markInviteUsed(db.pool, fourth.invite.code, owner.user.id), false, 'only once');
  assert.deepEqual(await invites.validateInviteCode(db.pool, fourth.invite.code), { ok: false, reason: 'used' });
  const usedPage = await http.request(`/office/landlords/${id}`, { cookie: owner.cookie });
  assert.match(usedPage.text, /مستخدم/);
  assert.match(usedPage.text, /050\*\*\*\*209/);
  assert.ok(!usedPage.text.includes('0500000209'), 'full phone of the user not shown');

  // Unknown and malformed codes all read as not_found.
  for (const input of ['ZZZZ9999', 'abc', '', null, 'ABCD0000', 'ABCDEFGHJ', "' OR 1=1 --"]) {
    assert.deepEqual(await invites.validateInviteCode(db.pool, input), { ok: false, reason: 'not_found' }, String(input));
  }

  // Audit rows for invites never hold the code.
  const [audits] = await db.pool.query(
    "SELECT action, before_json, after_json FROM audit_logs WHERE office_id = ? AND entity_type = 'invite' ORDER BY id",
    [owner.office.id],
  );
  assert.deepEqual(audits.map((a) => a.action), ['invite.create', 'invite.create', 'invite.revoke', 'invite.create', 'invite.create']);
  const auditText = JSON.stringify(audits);
  for (const code of [one.code, active[0].code, third.invite.code, fourth.invite.code]) assert.ok(!auditText.includes(code));
});

test('inactive and already-joined landlords get no invite', { skip }, async () => {
  const owner = await http.registerOffice(phone(10), 'مكتب الموقوفين');
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const inactive = await scoped.insert('landlords', { label: 'موقوف', is_active: 0 });
  const [u] = await db.pool.query('INSERT INTO users (phone, role) VALUES (?, ?)', [phone(11), 'landlord']);
  const joined = await scoped.insert('landlords', { label: 'منضم', user_id: u.insertId });
  const r1 = await http.request(`/office/landlords/${inactive}/invite`, { method: 'POST', cookie: owner.cookie });
  assert.equal(r1.status, 409);
  assert.match(r1.text, /المالك موقوف/);
  const r2 = await http.request(`/office/landlords/${joined}/invite`, { method: 'POST', cookie: owner.cookie });
  assert.equal(r2.status, 409);
  const [[n]] = await db.pool.query('SELECT COUNT(*) AS n FROM invites WHERE landlord_id IN (?, ?)', [inactive, joined]);
  assert.equal(Number(n.n), 0);
});

test('invite creation is limited to 20 per office per hour', { skip }, async () => {
  const owner = await http.registerOffice(phone(12), 'مكتب الحد');
  const other = await http.registerOffice(phone(13), 'مكتب آخر');
  const id = await scopeToOffice(db.pool, owner.office.id).insert('landlords', { label: 'مالك' });
  const otherId = await scopeToOffice(db.pool, other.office.id).insert('landlords', { label: 'مالك' });
  const statuses = [];
  for (let i = 0; i < 21; i += 1) {
    statuses.push((await http.request(`/office/landlords/${id}/invite`, { method: 'POST', cookie: owner.cookie })).status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(302));
  assert.equal(statuses[20], 429);
  assert.equal((await activeInvites(id)).length, 1, 'still exactly one active invite');
  const otherRes = await http.request(`/office/landlords/${otherId}/invite`, { method: 'POST', cookie: other.cookie });
  assert.equal(otherRes.status, 302, 'the limit is per office');
});

test('wrong codes are limited to 5 per IP per 15 minutes and 10 per phone per hour', { skip }, async () => {
  const owner = await http.registerOffice(phone(14), 'مكتب التخمين');
  const id = await scopeToOffice(db.pool, owner.office.id).insert('landlords', { label: 'مالك' });
  const { invite } = await createInviteFor(owner.office.id, id, owner.user.id);

  const guard = invites.createInviteGuard();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await guard.check(db.pool, 'ZZZZ9999', { ip: '203.0.113.50' })).reason, 'not_found');
  }
  const blocked = await guard.check(db.pool, invite.code, { ip: '203.0.113.50' });
  assert.equal(blocked.reason, 'rate_limited', 'even the right code is refused after 5 wrong ones');
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 900);
  assert.equal((await guard.check(db.pool, invite.code, { ip: '203.0.113.51' })).ok, true, 'another IP is fine');

  // Correct codes never count.
  for (let i = 0; i < 8; i += 1) assert.equal((await guard.check(db.pool, invite.code, { ip: '203.0.113.52' })).ok, true);

  // Per phone: 10 wrong tries from different IPs, then blocked.
  const phoneGuard = invites.createInviteGuard();
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await phoneGuard.check(db.pool, 'ZZZZ9999', { ip: `198.51.100.${i}`, phone: '966500000299' })).reason, 'not_found');
  }
  assert.equal((await phoneGuard.check(db.pool, invite.code, { ip: '198.51.100.99', phone: '966500000299' })).reason, 'rate_limited');
  assert.equal((await phoneGuard.check(db.pool, invite.code, { ip: '198.51.100.99', phone: '966500000298' })).ok, true);
});

test('10 parallel redemptions of one code: exactly one succeeds', { skip }, async () => {
  const owner = await http.registerOffice(phone(15), 'مكتب السباق');
  const id = await scopeToOffice(db.pool, owner.office.id).insert('landlords', { label: 'مالك' });
  const { invite } = await createInviteFor(owner.office.id, id, owner.user.id);
  const userIds = [];
  for (let i = 0; i < 10; i += 1) {
    const [u] = await db.pool.query('INSERT INTO users (phone) VALUES (?)', [phone(30 + i)]);
    userIds.push(u.insertId);
  }
  const results = await Promise.all(userIds.map((userId) => invites.markInviteUsed(db.pool, invite.code, userId)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = userIds[results.indexOf(true)];
  const [[row]] = await db.pool.query('SELECT used_by, used_at FROM invites WHERE id = ?', [invite.id]);
  assert.equal(row.used_by, winner);
  assert.ok(row.used_at);
});

test('two simultaneous "create invite" clicks still leave one active invite', { skip }, async () => {
  const owner = await http.registerOffice(phone(16), 'مكتب النقرتين');
  const id = await scopeToOffice(db.pool, owner.office.id).insert('landlords', { label: 'مالك' });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => http.request(`/office/landlords/${id}/invite`, { method: 'POST', cookie: owner.cookie })),
  );
  assert.deepEqual(results.map((r) => r.status), Array(5).fill(302));
  assert.equal((await activeInvites(id)).length, 1);
});
