'use strict';

// Per-contract message threads against real MySQL: participants from the
// database only, escaping, length and rate limits, unread counts, mute,
// soft delete within 5 minutes, notifications without text, isolation.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000009NN.
const phone = (n) => `9665000009${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;

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
     VALUES ('test_threads', 'اختبار الرسائل', 1, 1, NULL, NULL, NULL, NULL, 0, 100)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, is_active = 0`,
  );
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_threads' });
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

async function setup(base, name) {
  const o = await fx.office(base, name);
  const contractId = await fx.contract(o);
  const landlord = await fx.landlordOf(o, base + 1);
  const tenant = await fx.tenantOf(contractId, base + 2);
  return { o, contractId, landlord, tenant };
}

const say = (who, kind, contractId, body, extra = {}) => http.request(`/${kind}/messages/${contractId}`, { method: 'POST', cookie: who.cookie || who, form: { body, ...extra } });
const notes = async (user, where = '') => (await db.pool.query(`SELECT kind, title, body, link FROM notifications WHERE user_id = ? AND kind = 'message_new' ${where} ORDER BY id`, [user.id]))[0];

test('thread: office, landlord and tenant talk; others are notified (no text); html escaped; lengths checked', { skip }, async () => {
  const { o, contractId, landlord, tenant } = await setup(1, 'مكتب الرسائل');
  const staff = await http.addMember(o.office.id, phone(5), 'office_staff');
  const staffUser = await http.userByPhone(phone(5));

  const sent = await say(tenant, 'tenant', contractId, 'السلام عليكم <script>alert(1)</script> & "اختبار"');
  assert.equal(sent.status, 302);
  assert.equal(sent.location, `/tenant/messages/${contractId}#end`);
  const [[row]] = await db.pool.query('SELECT * FROM messages ORDER BY id DESC LIMIT 1');
  assert.equal(row.sender_role, 'tenant');
  assert.equal(Number(row.sender_id), Number(tenant.user.id));

  // The creator (owner) and the landlord are told; the tenant (sender) is not; staff only after writing.
  const ownerNote = (await notes(o.user))[0];
  assert.equal(ownerNote.link, `/office/messages/${contractId}`);
  assert.doesNotMatch(`${ownerNote.title} ${ownerNote.body}`, /السلام|script|اختبار/);
  assert.ok(ownerNote.body.endsWith('تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'));
  assert.equal((await notes(landlord.user))[0].link, `/landlord/messages/${contractId}`);
  assert.equal((await notes(tenant.user)).length, 0);
  assert.equal((await notes(staffUser)).length, 0);

  for (const [who, kind] of [[o, 'office'], [landlord, 'landlord'], [tenant, 'tenant']]) {
    const page = await http.request(`/${kind}/messages/${contractId}`, { cookie: who.cookie });
    assert.equal(page.status, 200, kind);
    assert.match(page.text, /السلام عليكم &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &#34;اختبار&#34;/);
    assert.doesNotMatch(page.text, /<script>alert/);
    assert.match(page.text, /تطبيق خاص غير تابع لمنصة إيجار/);
  }
  assert.equal((await say(staff, 'office', contractId, 'تم استلام رسالتك')).status, 302);
  assert.equal((await say(landlord, 'landlord', contractId, 'أوافق')).status, 302);
  // Staff wrote in the thread, so now gets notified of replies.
  assert.equal((await notes(staffUser)).length, 1, 'staff is told about the landlord reply');
  assert.equal((await notes(tenant.user)).length, 2, 'the tenant is told about both replies');

  const roles = (await db.pool.query('SELECT sender_role FROM messages ORDER BY id DESC LIMIT 3'))[0].map((r) => r.sender_role).reverse();
  assert.deepEqual(roles, ['tenant', 'office', 'landlord']);

  // Lengths: exactly 1000 is fine, 1001 and empty are refused, control characters are stripped.
  assert.equal((await say(tenant, 'tenant', contractId, 'ب'.repeat(1000))).status, 302);
  assert.equal((await say(tenant, 'tenant', contractId, 'ب'.repeat(1001))).status, 422);
  assert.equal((await say(tenant, 'tenant', contractId, '   ')).status, 422);
  assert.equal((await say(tenant, 'tenant', contractId, '')).status, 422);
  await say(tenant, 'tenant', contractId, 'نص\u0000مع\u0007رموز');
  const [[clean]] = await db.pool.query('SELECT body FROM messages ORDER BY id DESC LIMIT 1');
  assert.equal(clean.body, 'نصمعرموز');
});

test('rate limit: 10 messages per minute per person', { skip }, async () => {
  const { contractId, tenant, landlord } = await setup(10, 'مكتب المعدل');
  for (let i = 0; i < 10; i += 1) assert.equal((await say(tenant, 'tenant', contractId, `رسالة ${i}`)).status, 302);
  const limited = await say(tenant, 'tenant', contractId, 'الحادية عشرة');
  assert.equal(limited.status, 429);
  assert.match(limited.text, /رسائل كثيرة/);
  assert.match(limited.text, /الحادية عشرة/, 'the draft is kept');
  assert.equal(await fx.count('SELECT COUNT(*) FROM messages WHERE sender_id = ?', [tenant.user.id]), 10);
  assert.equal((await say(landlord, 'landlord', contractId, 'رد المالك')).status, 302, 'another person is not limited');
});

test('participants come from the database: other tenants, landlords and offices get 404 and cannot post', { skip }, async () => {
  const a = await setup(20, 'مكتب أ');
  const b = await setup(30, 'مكتب ب');
  const o2 = await fx.office(40, 'مكتب بمالكين', { landlords: 2 });
  const c1 = await fx.contract(o2, { unitIndex: 0 });
  const c2 = await fx.contract(o2, { landlordId: o2.landlordIds[1], unitIndex: 0 });
  const t1 = await fx.tenantOf(c1, 41);
  const t2 = await fx.tenantOf(c2, 42);
  const l2 = await fx.landlordOf(o2, 43, o2.landlordIds[1]);
  await say(a.tenant, 'tenant', a.contractId, 'سري جداً بين أطراف أ');

  for (const [who, kind, id] of [
    [b.tenant, 'tenant', a.contractId], [b.landlord, 'landlord', a.contractId], [b.o, 'office', a.contractId],
    [a.tenant, 'tenant', b.contractId], [a.landlord, 'landlord', b.contractId], [a.o, 'office', b.contractId],
    [t2, 'tenant', c1], [l2, 'landlord', c1], [t1, 'tenant', c2],
  ]) {
    assert.equal((await http.request(`/${kind}/messages/${id}`, { cookie: who.cookie })).status, 404, `GET ${kind} ${id}`);
    assert.equal((await say(who, kind, id, 'اختراق', { contract_id: String(id), user_id: '1', sender_role: 'office' })).status, 404, `POST ${kind} ${id}`);
  }
  assert.equal(await fx.count("SELECT COUNT(*) FROM messages WHERE body LIKE '%اختراق%'"), 0);
  const [[spoof]] = await db.pool.query('SELECT sender_role, sender_id FROM messages WHERE sender_id = ? ORDER BY id DESC LIMIT 1', [a.tenant.user.id]);
  assert.equal(spoof.sender_role, 'tenant', 'the role comes from the link, never from the body');

  // Same-contract participants still work; area pages are separate.
  assert.equal((await http.request(`/tenant/messages/${a.contractId}`, { cookie: a.tenant.cookie })).status, 200);
  assert.equal((await http.request(`/office/messages/${a.contractId}`, { cookie: a.tenant.cookie })).status, 403, 'a tenant has no office area');
  assert.equal((await http.request(`/landlord/messages/${a.contractId}`, { cookie: a.tenant.cookie })).status !== 200, true);
  // Lists only show own threads.
  const listB = (await http.request('/office/messages', { cookie: b.o.cookie })).text;
  assert.ok(!listB.includes(`/office/messages/${a.contractId}"`));
  for (const bad of ['abc', '0', '99999999', '1e3']) assert.equal((await http.request(`/office/messages/${bad}`, { cookie: a.o.cookie })).status, 404, bad);
});

test('unread counts per person; opening a thread marks it read', { skip }, async () => {
  const { o, contractId, tenant, landlord } = await setup(50, 'مكتب غير المقروء');
  await say(tenant, 'tenant', contractId, 'الأولى');
  await say(tenant, 'tenant', contractId, 'الثانية');
  await say(landlord, 'landlord', contractId, 'الثالثة');
  const unread = async (who, kind) => {
    const text = (await http.request(`/${kind}/messages`, { cookie: who.cookie })).text;
    const m = /(\d+) جديدة/.exec(text);
    return m ? Number(m[1]) : 0;
  };
  assert.equal(await unread(o, 'office'), 3);
  assert.equal(await unread(landlord, 'landlord'), 0, 'replying counts as reading');
  assert.equal(await unread(tenant, 'tenant'), 1);
  assert.equal((await http.request(`/office/messages/${contractId}`, { cookie: o.cookie })).status, 200);
  assert.equal(await unread(o, 'office'), 0);
  assert.equal(await unread(tenant, 'tenant'), 1, 'reading is per person');
  await say(tenant, 'tenant', contractId, 'الرابعة');
  assert.equal(await unread(o, 'office'), 1);
  assert.equal(await unread(landlord, 'landlord'), 1);
  assert.equal(await unread(tenant, 'tenant'), 0, 'your own message is never unread');
});

test('soft delete: the author within 5 minutes only; the text is gone', { skip }, async () => {
  const { contractId, tenant, landlord } = await setup(60, 'مكتب الحذف');
  await say(tenant, 'tenant', contractId, 'رسالة ستُحذف');
  const [[msg]] = await db.pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1');
  const del = (who, kind, id = msg.id) => http.request(`/${kind}/messages/${contractId}/${id}/delete`, { method: 'POST', cookie: who.cookie });
  const page = (await http.request(`/tenant/messages/${contractId}`, { cookie: tenant.cookie })).text;
  assert.match(page, /حذف \(خلال 5 دقائق\)/);
  assert.doesNotMatch((await http.request(`/landlord/messages/${contractId}`, { cookie: landlord.cookie })).text, /حذف \(خلال 5 دقائق\)/, 'only the author sees the button');
  assert.equal((await del(landlord, 'landlord')).status, 409, 'not the author');
  assert.equal((await del(tenant, 'tenant', 99999999)).status, 409);
  const ok = await del(tenant, 'tenant');
  assert.equal(ok.status, 302);
  const [[after]] = await db.pool.query('SELECT body, deleted_at FROM messages WHERE id = ?', [msg.id]);
  assert.equal(after.body, '');
  assert.ok(after.deleted_at);
  for (const [who, kind] of [[tenant, 'tenant'], [landlord, 'landlord']]) {
    const text = (await http.request(`/${kind}/messages/${contractId}`, { cookie: who.cookie })).text;
    assert.match(text, /تم حذف هذه الرسالة/);
    assert.doesNotMatch(text, /رسالة ستُحذف/);
  }
  assert.equal((await del(tenant, 'tenant')).status, 409, 'cannot delete twice');

  // After 5 minutes the window is closed.
  await say(tenant, 'tenant', contractId, 'رسالة قديمة');
  const [[old]] = await db.pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1');
  await db.pool.query('UPDATE messages SET created_at = UTC_TIMESTAMP() - INTERVAL 6 MINUTE WHERE id = ?', [old.id]);
  assert.equal((await del(tenant, 'tenant', old.id)).status, 409);
  assert.doesNotMatch((await http.request(`/tenant/messages/${contractId}`, { cookie: tenant.cookie })).text, /action="[^"]*\/${old.id}\/delete"/);
  assert.equal((await db.pool.query('SELECT deleted_at FROM messages WHERE id = ?', [old.id]))[0][0].deleted_at, null);
  // 4 minutes is still inside.
  await say(tenant, 'tenant', contractId, 'رسالة حديثة');
  const [[recent]] = await db.pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1');
  await db.pool.query('UPDATE messages SET created_at = UTC_TIMESTAMP() - INTERVAL 4 MINUTE WHERE id = ?', [recent.id]);
  assert.equal((await del(tenant, 'tenant', recent.id)).status, 302);
});

test('the office can mute a thread: no office notifications, landlord and tenant unaffected', { skip }, async () => {
  const { o, contractId, tenant, landlord } = await setup(70, 'مكتب الكتم');
  const staff = await http.addMember(o.office.id, phone(75), 'office_staff');
  assert.equal((await http.request(`/office/messages/${contractId}/mute`, { method: 'POST', cookie: staff, form: { muted: '1' } })).status, 302);
  assert.match((await http.request(`/office/messages/${contractId}`, { cookie: o.cookie })).text, /إلغاء الكتم/);
  await say(tenant, 'tenant', contractId, 'هل من خبر؟');
  assert.equal((await notes(o.user)).length, 0, 'muted');
  assert.equal((await notes(landlord.user)).length, 1);
  await say(landlord, 'landlord', contractId, 'لا جديد');
  assert.equal((await notes(tenant.user)).length, 1);
  assert.equal((await http.request(`/office/messages/${contractId}/mute`, { method: 'POST', cookie: o.cookie, form: { muted: '0' } })).status, 302);
  await say(tenant, 'tenant', contractId, 'شكراً');
  assert.equal((await notes(o.user)).length, 1, 'unmuted');
  // Landlords and tenants cannot mute (no such route).
  assert.notEqual((await http.request(`/tenant/messages/${contractId}/mute`, { method: 'POST', cookie: tenant.cookie, form: { muted: '1' } })).status, 302);
  assert.equal(await fx.count('SELECT office_muted FROM conversations WHERE contract_id = ?', [contractId]), 0);
});
