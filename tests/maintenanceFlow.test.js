'use strict';

// Maintenance requests against real MySQL: tenant requests with photos
// (magic bytes, size, EXIF stripped, stored outside the public folder), the
// status flow, assignment, internal notes vs public replies, notifications,
// the photo plan limit, and isolation across two offices, two landlords and
// two tenants. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000008NN.
const phone = (n) => `9665000008${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const MARKER = 'SECRET-EXIF-GPS-MARKER';
const saved = {};
let db;
let http;
let fx;
let uploadDir;
let images;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'UPLOAD_DIR']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_members, max_photos, is_active, sort_order)
     VALUES ('test_maint', 'اختبار الصيانة', 1, 1, NULL, NULL, NULL, NULL, 0, 98), ('test_maint_3', 'اختبار ثلاث صور', 1, 1, NULL, NULL, NULL, 3, 0, 99)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = VALUES(max_photos), is_active = 0`,
  );
  images = require('../services/images');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_maint' });
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
  if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
});

// ------------------------------------------------------------ helpers

const jpeg = (w = 2400, h = 1800) => sharp({ create: { width: w, height: h, channels: 3, background: '#7a8' } })
  .withExif({ IFD0: { ImageDescription: MARKER } }).jpeg().toBuffer();
const png = () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#a87' } }).png().toBuffer();
const files = (...buffers) => buffers.map((data, i) => ({ data, name: `photo-${i}.jpg`, type: 'image/jpeg' }));

async function ask(tenant, contractId, extra = {}, photos = []) {
  return fx.multipart(`/tenant/contracts/${contractId}/maintenance`, tenant.cookie,
    { category: 'plumbing', priority: 'normal', description: 'تسرب في الحمام <b>مهم</b>', ...extra }, photos);
}

const requestIdFrom = (location) => Number(/\/maintenance\/(\d+)/.exec(location)[1]);
const storedFiles = () => fs.readdirSync(uploadDir);

/** An office, a contract, a landlord and a tenant who joined. */
async function setup(base, name, extra = {}) {
  const o = await fx.office(base, name, extra);
  const contractId = await fx.contract(o);
  const landlord = await fx.landlordOf(o, base + 1);
  const tenant = await fx.tenantOf(contractId, base + 2);
  return { o, contractId, landlord, tenant };
}

// ------------------------------------------------------------ create with photos

test('tenant request with photos: re-encoded JPEG <= 1600 px, EXIF removed, stored outside public, notifications sent', { skip }, async () => {
  const { o, contractId, landlord, tenant } = await setup(1, 'مكتب الصيانة');
  assert.ok(!path.resolve(uploadDir).startsWith(path.resolve(__dirname, '..', 'public')), 'uploads are outside the public folder');
  const before = storedFiles().length;
  const original = await jpeg();
  assert.ok(original.includes(MARKER), 'fixture carries EXIF');
  const res = await ask(tenant, contractId, {}, files(original, await png()));
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const id = requestIdFrom(res.location);
  const [[row]] = await db.pool.query('SELECT * FROM maintenance_requests WHERE id = ?', [id]);
  assert.deepEqual([row.status, row.category, row.priority, Number(row.reported_by)], ['new', 'plumbing', 'normal', Number(tenant.user.id)]);
  assert.equal(Number(row.contract_id), contractId);
  assert.equal(Number(row.office_id), o.office.id);

  const [photos] = await db.pool.query('SELECT * FROM maintenance_photos WHERE request_id = ? ORDER BY id', [id]);
  assert.equal(photos.length, 2);
  assert.equal(storedFiles().length, before + 2);
  for (const photo of photos) {
    assert.match(photo.path, /^[0-9a-f-]{36}\.jpg$/, 'random name, never the uploaded one');
    const data = fs.readFileSync(path.join(uploadDir, photo.path));
    assert.equal(images.sniffImage(data), 'jpeg');
    assert.ok(!data.includes(MARKER), 'EXIF is gone');
    const meta = await sharp(data).metadata();
    assert.ok(meta.width <= 1600 && meta.height <= 1600);
    assert.equal(meta.exif, undefined);
    assert.equal(photo.size_bytes, data.length);
  }
  assert.equal((await sharp(fs.readFileSync(path.join(uploadDir, photos[0].path))).metadata()).width, 1600, 'big photos are resized');

  // Office and landlord were told; the tenant (the actor) was not.
  const notes = async (user) => (await db.pool.query("SELECT kind, title, body, link FROM notifications WHERE user_id = ? AND kind LIKE 'maintenance%'", [user.id]))[0];
  const [ownerNote] = await notes(o.user);
  assert.equal(ownerNote.kind, 'maintenance_new');
  assert.equal(ownerNote.link, `/office/maintenance/${id}`);
  assert.doesNotMatch(`${ownerNote.title} ${ownerNote.body}`, /تسرب|مهم/, 'the description never goes into a notification');
  assert.ok(ownerNote.body.endsWith('تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'));
  assert.equal((await notes(landlord.user))[0].link, `/landlord/maintenance/${id}`);
  assert.equal((await notes(tenant.user)).length, 0);

  // The description is shown escaped.
  const detail = await http.request(`/tenant/maintenance/${id}`, { cookie: tenant.cookie });
  assert.equal(detail.status, 200);
  assert.match(detail.text, /&lt;b&gt;مهم&lt;\/b&gt;/);
  assert.match(detail.text, /تطبيق خاص غير تابع لمنصة إيجار/);
  assert.equal((detail.text.match(/\/maintenance\/photos\/\d+"/g) || []).length / 2, 2);
  const list = await http.request('/tenant/maintenance', { cookie: tenant.cookie });
  assert.match(list.text, /شقة 1-1 · سباكة/);
});

test('photo checks: wrong magic bytes, oversized, too many, corrupt, empty; nothing is stored or created', { skip }, async () => {
  const { o, contractId, tenant } = await setup(5, 'مكتب الفحص');
  const filesBefore = storedFiles().length;
  const rowsBefore = await fx.count('SELECT COUNT(*) FROM maintenance_requests WHERE office_id = ?', [o.office.id]);
  const good = await png();

  const fake = await ask(tenant, contractId, {}, [{ data: Buffer.from('هذا ليس صورة <script>alert(1)</script>'), name: 'x.jpg', type: 'image/jpeg' }]);
  assert.equal(fake.status, 422);
  assert.match(fake.text, /JPG أو PNG أو WebP/);
  const renamed = await ask(tenant, contractId, {}, [{ data: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200)]), name: 'x.jpg', type: 'image/jpeg' }]);
  assert.equal(renamed.status, 422, 'a PDF with a .jpg name is refused');
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024 + 1024, 1)]);
  const huge = await ask(tenant, contractId, {}, [{ data: big, name: 'big.jpg', type: 'image/jpeg' }]);
  assert.equal(huge.status, 422);
  assert.match(huge.text, /أكبر من 5 ميجابايت/);
  const many = await ask(tenant, contractId, {}, files(good, good, good, good));
  assert.equal(many.status, 422);
  assert.match(many.text, /3 صور كحد أقصى/);
  const corrupt = await ask(tenant, contractId, {}, [{ data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg at all, just bytes')]), name: 'c.jpg', type: 'image/jpeg' }]);
  assert.equal(corrupt.status, 422);
  const noText = await ask(tenant, contractId, { description: '  ' }, files(good));
  assert.equal(noText.status, 422);
  const longText = await ask(tenant, contractId, { description: 'ب'.repeat(501) });
  assert.equal(longText.status, 422);
  const badCategory = await ask(tenant, contractId, { category: 'roof' });
  assert.equal(badCategory.status, 422);

  assert.equal(storedFiles().length, filesBefore, 'nothing was written to disk');
  assert.equal(await fx.count('SELECT COUNT(*) FROM maintenance_requests WHERE office_id = ?', [o.office.id]), rowsBefore);
  const ok = await ask(tenant, contractId, { description: 'x'.repeat(500) });
  assert.equal(ok.status, 302, 'exactly 500 characters is fine');
});

// ------------------------------------------------------------ photo access

test('photos are served only to people linked to the request; everyone else gets 404, signed out is sent to login', { skip }, async () => {
  const a = await setup(10, 'مكتب أ');
  const b = await setup(20, 'مكتب ب');
  const id = requestIdFrom((await ask(a.tenant, a.contractId, {}, files(await jpeg(800, 600)))).location);
  const [[photo]] = await db.pool.query('SELECT id FROM maintenance_photos WHERE request_id = ?', [id]);
  const url = `/maintenance/photos/${photo.id}`;

  for (const [who, cookie] of [['office owner', a.o.cookie], ['tenant', a.tenant.cookie], ['landlord', a.landlord.cookie]]) {
    const res = await fx.get(url, cookie);
    assert.equal(res.status, 200, who);
    assert.equal(res.type, 'image/jpeg');
    assert.equal(images.sniffImage(res.body), 'jpeg');
    assert.match(res.headers.get('cache-control'), /no-store/);
  }
  const staff = await http.addMember(a.o.office.id, phone(15), 'office_staff');
  assert.equal((await fx.get(url, staff)).status, 200, 'office staff of the same office');

  const anonymous = await fx.get(url);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.location, '/login');
  assert.notEqual(anonymous.type, 'image/jpeg');
  for (const [who, cookie] of [['other tenant', b.tenant.cookie], ['other landlord', b.landlord.cookie], ['other office', b.o.cookie]]) {
    assert.equal((await fx.get(url, cookie)).status, 404, who);
  }
  // Another landlord of the SAME office, and another tenant of the same office on another contract.
  const o2 = await fx.office(30, 'مكتب بمالكين', { landlords: 2 });
  const otherLandlordId = o2.landlordIds[1];
  const c1 = await fx.contract(o2, { unitIndex: 0 });
  const c2 = await fx.contract(o2, { landlordId: otherLandlordId, unitIndex: 0 });
  const t1 = await fx.tenantOf(c1, 31);
  const t2 = await fx.tenantOf(c2, 32);
  const l2 = await fx.landlordOf(o2, 33, otherLandlordId);
  const rid = requestIdFrom((await ask(t1, c1, {}, files(await png()))).location);
  const [[p2]] = await db.pool.query('SELECT id FROM maintenance_photos WHERE request_id = ?', [rid]);
  assert.equal((await fx.get(`/maintenance/photos/${p2.id}`, t1.cookie)).status, 200);
  assert.equal((await fx.get(`/maintenance/photos/${p2.id}`, t2.cookie)).status, 404, 'tenant of another contract in the same office');
  assert.equal((await fx.get(`/maintenance/photos/${p2.id}`, l2.cookie)).status, 404, 'landlord of other units in the same office');
  for (const bad of ['abc', '0', '99999999', '1e3', `${photo.id}x`]) assert.equal((await fx.get(`/maintenance/photos/${bad}`, a.o.cookie)).status, 404, bad);
  assert.equal(images.imagePath('../../etc/passwd'), null);
  assert.equal(images.imagePath('x.jpg'), null);
});

// ------------------------------------------------------------ status flow, assignment, notes

test('status flow with timestamps and who; assignment; internal notes hidden from tenant and landlord; replies visible', { skip }, async () => {
  const { o, contractId, landlord, tenant } = await setup(40, 'مكتب الحالات');
  const staff = await http.addMember(o.office.id, phone(44), 'office_staff');
  const staffUser = await http.userByPhone(phone(44));
  const id = requestIdFrom((await ask(tenant, contractId)).location);
  const base = `/office/maintenance/${id}`;
  const post = (sub, form, cookie = o.cookie) => http.request(`${base}${sub}`, { method: 'POST', cookie, form });
  const row = async () => (await db.pool.query('SELECT * FROM maintenance_requests WHERE id = ?', [id]))[0][0];

  assert.equal((await http.request('/office/maintenance', { cookie: o.cookie })).status, 200);
  assert.equal((await post('/status', { status: 'done' })).status, 422, 'new -> done is not allowed');
  assert.equal((await post('/status', { status: 'bogus' })).status, 422);
  assert.equal((await post('/status', { status: 'seen' })).status, 302);
  let r = await row();
  assert.equal(r.status, 'seen');
  assert.ok(r.seen_at && r.status_changed_at);
  assert.equal(Number(r.seen_by), Number(o.user.id));
  assert.equal(Number(r.status_changed_by), Number(o.user.id));
  assert.equal(r.started_at, null);

  assert.equal((await post('/status', { status: 'in_progress' }, staff)).status, 302, 'staff may work requests');
  r = await row();
  assert.ok(r.started_at);
  assert.equal(Number(r.status_changed_by), Number(staffUser.id));

  // Assignment: only active members of this office.
  assert.equal((await post('/assign', { assignee: String(staffUser.id) })).status, 302);
  assert.equal(Number((await row()).assigned_to), Number(staffUser.id));
  assert.equal((await post('/assign', { assignee: String(tenant.user.id) })).status, 422, 'a tenant is not a team member');
  assert.equal((await post('/assign', { assignee: 'abc' })).status, 422);
  const [assignedNote] = (await db.pool.query("SELECT title, link FROM notifications WHERE user_id = ? AND kind = 'maintenance_update'", [staffUser.id]))[0];
  assert.match(assignedNote.title, /أُسند إليك/);
  assert.equal(assignedNote.link, base);

  // Internal note vs public reply vs landlord comment.
  assert.equal((await post('/messages', { body: 'ملاحظة داخلية سرية', visibility: 'internal' })).status, 302);
  assert.equal((await post('/messages', { body: 'سيصلك الفني غداً <i>إن شاء الله</i>', visibility: 'public' })).status, 302);
  assert.equal((await post('/messages', { body: '' })).status, 422);
  assert.equal((await post('/messages', { body: 'ب'.repeat(1001) })).status, 422);
  const landlordMsg = await http.request(`/landlord/maintenance/${id}/messages`, { method: 'POST', cookie: landlord.cookie, form: { body: 'تعليق المالك الخاص' } });
  assert.equal(landlordMsg.status, 302);
  const tenantMsg = await http.request(`/tenant/maintenance/${id}/messages`, { method: 'POST', cookie: tenant.cookie, form: { body: 'شكراً' } });
  assert.equal(tenantMsg.status, 302);

  const officePage = (await http.request(base, { cookie: o.cookie })).text;
  assert.match(officePage, /ملاحظة داخلية سرية/);
  assert.match(officePage, /تعليق المالك الخاص/);
  assert.match(officePage, /سيصلك الفني غداً &lt;i&gt;إن شاء الله&lt;\/i&gt;/, 'escaped');
  const tenantPage = (await http.request(`/tenant/maintenance/${id}`, { cookie: tenant.cookie })).text;
  assert.match(tenantPage, /سيصلك الفني غداً/);
  assert.doesNotMatch(tenantPage, /ملاحظة داخلية سرية|تعليق المالك الخاص/);
  assert.doesNotMatch(tenantPage, /action="[^"]*\/status"|\/assign"/, 'tenants have no office controls');
  const landlordPage = (await http.request(`/landlord/maintenance/${id}`, { cookie: landlord.cookie })).text;
  assert.match(landlordPage, /سيصلك الفني غداً/);
  assert.match(landlordPage, /تعليق المالك الخاص/);
  assert.doesNotMatch(landlordPage, /ملاحظة داخلية سرية/);

  // The tenant was told about the status change and the public reply, never about the internal note.
  const tenantNotes = (await db.pool.query("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'maintenance_update'", [tenant.user.id]))[0];
  assert.ok(tenantNotes.some((n) => /قيد التنفيذ|تمت المشاهدة/.test(n.body)));
  assert.ok(tenantNotes.some((n) => /رد جديد/.test(n.title)));
  assert.ok(!tenantNotes.some((n) => /سرية/.test(`${n.title} ${n.body}`)));
  // The office was told about the tenant's reply (the one in charge: staff).
  assert.ok((await db.pool.query("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'رد من المستأجر%'", [staffUser.id]))[0].length >= 1);

  assert.equal((await post('/status', { status: 'done' })).status, 302);
  r = await row();
  assert.ok(r.closed_at);
  assert.equal((await post('/status', { status: 'seen' })).status, 422, 'a closed request stays closed');
  assert.equal((await post('/assign', { assignee: '' })).status, 302);
  assert.equal((await row()).assigned_to, null);
  const [audit] = (await db.pool.query("SELECT after_json FROM audit_logs WHERE entity_type = 'maintenance_request' AND entity_id = ?", [id]))[0].map((a) => JSON.stringify(a.after_json));
  assert.ok(audit);
  const allAudit = JSON.stringify((await db.pool.query("SELECT after_json FROM audit_logs WHERE entity_type = 'maintenance_request' AND entity_id = ?", [id]))[0]);
  assert.doesNotMatch(allAudit, /سرية|تسرب|الفني/, 'audit rows hold no text');
});

// ------------------------------------------------------------ isolation

test('isolation: two offices, two landlords, two tenants never see or touch each other\'s requests', { skip }, async () => {
  const a = await setup(50, 'مكتب العزل أ');
  const b = await setup(60, 'مكتب العزل ب');
  const idA = requestIdFrom((await ask(a.tenant, a.contractId, {}, files(await png()))).location);
  const idB = requestIdFrom((await ask(b.tenant, b.contractId)).location);

  for (const [who, cookie, urls] of [
    ['tenant B', b.tenant.cookie, [`/tenant/maintenance/${idA}`]],
    ['landlord B', b.landlord.cookie, [`/landlord/maintenance/${idA}`]],
    ['office B', b.o.cookie, [`/office/maintenance/${idA}`]],
    ['tenant A on B', a.tenant.cookie, [`/tenant/maintenance/${idB}`]],
    ['landlord A on B', a.landlord.cookie, [`/landlord/maintenance/${idB}`]],
    ['office A on B', a.o.cookie, [`/office/maintenance/${idB}`]],
  ]) {
    for (const url of urls) assert.equal((await http.request(url, { cookie })).status, 404, `${who} GET ${url}`);
  }
  for (const [cookie, id] of [[b.o.cookie, idA], [a.o.cookie, idB]]) {
    for (const [sub, form] of [['/status', { status: 'seen' }], ['/assign', { assignee: '' }], ['/messages', { body: 'اختراق' }]]) {
      assert.equal((await http.request(`/office/maintenance/${id}${sub}`, { method: 'POST', cookie, form })).status, 404, sub);
    }
  }
  assert.equal((await http.request(`/tenant/maintenance/${idA}/messages`, { method: 'POST', cookie: b.tenant.cookie, form: { body: 'اختراق' } })).status, 404);
  assert.equal((await http.request(`/landlord/maintenance/${idA}/messages`, { method: 'POST', cookie: b.landlord.cookie, form: { body: 'اختراق' } })).status, 404);
  // A tenant cannot raise a request on another contract.
  assert.equal((await ask(b.tenant, a.contractId)).status, 404);
  assert.equal(await fx.count('SELECT COUNT(*) FROM maintenance_messages WHERE request_id IN (?, ?)', [idA, idB]), 0);

  // Lists show only their own.
  const tenantList = (await http.request('/tenant/maintenance', { cookie: b.tenant.cookie })).text;
  assert.ok(tenantList.includes(`/tenant/maintenance/${idB}"`) && !tenantList.includes(`/tenant/maintenance/${idA}"`));
  const landlordList = (await http.request('/landlord/maintenance', { cookie: a.landlord.cookie })).text;
  assert.ok(landlordList.includes(`/landlord/maintenance/${idA}"`) && !landlordList.includes(`/landlord/maintenance/${idB}"`));
  const officeList = (await http.request('/office/maintenance', { cookie: a.o.cookie })).text;
  assert.ok(officeList.includes(`/office/maintenance/${idA}"`) && !officeList.includes(`/office/maintenance/${idB}"`));

  // Landlords and tenants have no office area; a tenant cannot open the landlord's pages.
  assert.equal((await http.request('/office/maintenance', { cookie: a.tenant.cookie })).status, 403);
  assert.equal((await http.request('/office/maintenance', { cookie: a.landlord.cookie })).status, 403);
  assert.notEqual((await http.request('/landlord/maintenance', { cookie: a.tenant.cookie })).status, 200);
  assert.equal((await http.request(`/landlord/maintenance/${idA}/messages`, { method: 'POST', cookie: a.tenant.cookie, form: { body: 'x' } })).status, 403);
  // A malformed id is 404.
  for (const bad of ['abc', '0', '9999999', '1e2']) assert.equal((await http.request(`/office/maintenance/${bad}`, { cookie: a.o.cookie })).status, 404);
});

// ------------------------------------------------------------ plan limit

test('photo plan limit: refused past max_photos, files cleaned up, parallel uploads cannot pass it', { skip }, async () => {
  const { o, contractId, tenant } = await setup(70, 'مكتب الحد');
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_maint_3') WHERE id = ?", [o.office.id]);
  const filesBefore = storedFiles().length;
  const small = await png();
  assert.equal((await ask(tenant, contractId, {}, files(small, small))).status, 302);
  const over = await ask(tenant, contractId, {}, files(small, small));
  assert.equal(over.status, 409);
  assert.match(over.text, /حد باقته من الصور \(3 صورة\)/);
  assert.equal(storedFiles().length, filesBefore + 2, 'the refused upload left no file');
  assert.equal((await ask(tenant, contractId, {})).status, 302, 'a request without photos is always fine');
  assert.equal((await ask(tenant, contractId, {}, files(small))).status, 302, 'exactly at the limit');
  assert.equal(await fx.count('SELECT COUNT(*) FROM maintenance_photos ph JOIN maintenance_requests r ON r.id = ph.request_id WHERE r.office_id = ?', [o.office.id]), 3);

  // Parallel: two uploads of 2 photos each against a limit of 3 -> one request.
  const fresh = await setup(75, 'مكتب الحد المتوازي');
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_maint_3') WHERE id = ?", [fresh.o.office.id]);
  const results = await Promise.all([
    ask(fresh.tenant, fresh.contractId, {}, files(small, small)),
    ask(fresh.tenant, fresh.contractId, {}, files(small, small)),
    ask(fresh.tenant, fresh.contractId, {}, files(small, small)),
  ]);
  assert.equal(results.filter((r) => r.status === 302).length, 1);
  assert.equal(await fx.count('SELECT COUNT(*) FROM maintenance_photos ph JOIN maintenance_requests r ON r.id = ph.request_id WHERE r.office_id = ?', [fresh.o.office.id]), 2);
});

test('terminated contracts take no new requests; the request rate limit is 10 per hour', { skip }, async () => {
  const { o, contractId, tenant } = await setup(80, 'مكتب الإنهاء');
  for (let i = 0; i < 10; i += 1) assert.equal((await ask(tenant, contractId)).status, 302);
  const limited = await ask(tenant, contractId);
  assert.equal(limited.status, 429);
  const other = await setup(85, 'مكتب الإنهاء ٢');
  await http.request(`/office/contracts/${other.contractId}/terminate`, { method: 'POST', cookie: other.o.cookie, form: { reason: 'سبب الإنهاء', confirm: '1' } });
  assert.equal((await ask(other.tenant, other.contractId)).status, 404);
});

test('cross-site and signed-out uploads are refused and create nothing', { skip }, async () => {
  const { o, contractId, tenant } = await setup(90, 'مكتب الحماية');
  const form = () => {
    const f = new FormData();
    f.append('category', 'plumbing');
    f.append('priority', 'normal');
    f.append('description', 'طلب من موقع آخر');
    return f;
  };
  const evil = await fetch(`${http.base()}/tenant/contracts/${contractId}/maintenance`, { method: 'POST', headers: { Cookie: tenant.cookie, Origin: 'https://evil.example' }, body: form(), redirect: 'manual' });
  assert.equal(evil.status, 403);
  const anonymous = await fetch(`${http.base()}/tenant/contracts/${contractId}/maintenance`, { method: 'POST', headers: { Origin: http.base() }, body: form(), redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/login');
  assert.equal(await fx.count('SELECT COUNT(*) FROM maintenance_requests WHERE office_id = ?', [o.office.id]), 0);
});
