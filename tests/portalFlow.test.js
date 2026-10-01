'use strict';

// Join by code, the landlord and tenant areas, and the office side of their
// feedback, against real MySQL. Expected dates come from the engine (it has
// its own tests). Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000006NN.
const phone = (n) => `9665000006${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let engine;
let dates;
let joins;
let feedback;
let scopeToOffice;
let TODAY;

const GENERIC = 'الرمز غير صحيح أو انتهت صلاحيته أو استُخدم من قبل';
const DISCLAIMER = 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط';

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
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, is_active, sort_order)
     VALUES ('test_portal_none', 'اختبار البوابة', 1, 1, NULL, NULL, 0, 96)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, is_active = 0`,
  );
  engine = require('../services/contractEngine');
  dates = require('../services/contractDates');
  joins = require('../services/joins');
  feedback = require('../services/feedback');
  ({ scopeToOffice } = require('../services/scopeToOffice'));
  TODAY = dates.riyadhDate(new Date());
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

test.beforeEach(() => {
  if (joins) joins.joinGuard.reset();
});

// ------------------------------------------------------------ helpers

const months = (start, n) => dates.addDays(dates.addMonths(start, n), -1);
const contractIdFrom = (location) => Number(/\/office\/contracts\/(\d+)/.exec(location)[1]);

async function count(sql, params = []) {
  const [[row]] = await db.pool.query(sql, params);
  return Number(Object.values(row)[0]);
}

/** An office with one landlord and `unitCount` units in `city`. */
async function office(n, name, { city = 'جدة', unitCount = 2, landlords = 1 } = {}) {
  const owner = await http.registerOffice(phone(n), name);
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_portal_none') WHERE id = ?", [owner.office.id]);
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const landlordIds = [];
  const unitsByLandlord = {};
  for (let l = 1; l <= landlords; l += 1) {
    const landlordId = await scoped.insert('landlords', { label: `مالك ${l} ${name}`, city });
    landlordIds.push(landlordId);
    unitsByLandlord[landlordId] = [];
    for (let i = 1; i <= unitCount; i += 1) {
      unitsByLandlord[landlordId].push(await scoped.insert('units', { landlord_id: landlordId, label: `شقة ${l}-${i}`, city }));
    }
  }
  return { ...owner, scoped, city, landlordIds, landlordId: landlordIds[0], unitsByLandlord, units: unitsByLandlord[landlordIds[0]] };
}

/** Creates a contract through the office form; returns its id. */
async function contract(o, { landlordId = o.landlordId, unitId, start = TODAY, end, rent = '36000', frequency = 'monthly' } = {}) {
  const res = await http.request('/office/contracts', {
    method: 'POST',
    cookie: o.cookie,
    form: {
      landlord_id: String(landlordId),
      unit_id: String(unitId || o.unitsByLandlord[landlordId][0]),
      tenant_label: 'مستأجر',
      start_date: start,
      end_date: end || months(start, 12),
      annual_rent: rent,
      payment_frequency: frequency,
      city: o.city,
      auto_renew: '1',
      ack_warnings: '1',
    },
  });
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 300));
  return contractIdFrom(res.location);
}

async function landlordCode(o, landlordId = o.landlordId) {
  const res = await http.request(`/office/landlords/${landlordId}/invite`, { method: 'POST', cookie: o.cookie });
  assert.equal(res.status, 302);
  const [[row]] = await db.pool.query(
    'SELECT code FROM invites WHERE landlord_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1',
    [landlordId],
  );
  return row.code;
}

async function tenantCode(contractId) {
  const [[row]] = await db.pool.query(
    "SELECT code FROM invites WHERE contract_id = ? AND kind = 'tenant' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1",
    [contractId],
  );
  return row.code;
}

async function join(cookie, code) {
  return http.request('/join', { method: 'POST', cookie, form: { code } });
}

/** A new person (role NULL) signed in with phone n. */
async function person(n) {
  const { cookie, location } = await http.login(phone(n));
  return { cookie, location, user: await http.userByPhone(phone(n)) };
}

async function joined(n, code) {
  const p = await person(n);
  const res = await join(p.cookie, code);
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 300));
  return { ...p, location: res.location, user: await http.userByPhone(phone(n)) };
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabicDigits = (s) => s.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);

async function paymentsOf(contractId) {
  const [rows] = await db.pool.query('SELECT * FROM contract_payments WHERE contract_id = ? ORDER BY due_date, id', [contractId]);
  return rows;
}

// ------------------------------------------------------------ join page

test('join page: signed out asks to sign in and comes back to /join', { skip }, async () => {
  const page = await http.request('/join');
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/login\?next=\/join"/);
  assert.match(page.text, new RegExp(DISCLAIMER));
  const post = await http.request('/join', { method: 'POST', form: { code: 'ABCDEFGH' } });
  assert.equal(post.status, 302);
  assert.equal(post.location, '/login?next=/join');

  const login = await http.request('/login?next=/join');
  assert.match(login.text, /name="next" value="\/join"/);
  const p = await person(1);
  assert.equal(p.location, '/office/new', 'a fresh login without next still goes to /office/new');
  const back = await http.request('/login?next=/join', { cookie: p.cookie });
  assert.equal(back.location, '/join');
  const evil = await http.request('/login?next=https://evil.example', { cookie: p.cookie });
  assert.equal(evil.location, '/office/new', 'only known paths are followed');
  const form = await http.request('/join', { cookie: p.cookie });
  assert.match(form.text, /name="code"/);
  const officeNew = await http.request('/office/new', { cookie: p.cookie });
  assert.match(officeNew.text, /href="\/join"/);
});

// ------------------------------------------------------------ landlord happy path

test('landlord joins with a code (normalized input) and sees their dashboard with engine deadlines', { skip }, async () => {
  const o = await office(2, 'مكتب الملاك', { city: 'جدة' });
  const contractId = await contract(o);
  const code = await landlordCode(o);
  const typed = ` ${toArabicDigits(code.toLowerCase().slice(0, 4))}-${toArabicDigits(code.toLowerCase().slice(4))} `;
  const l = await joined(3, typed);
  assert.equal(l.location, '/landlord?done=joined');
  assert.equal(l.user.role, 'landlord');
  const [[landlord]] = await db.pool.query('SELECT user_id FROM landlords WHERE id = ?', [o.landlordId]);
  assert.equal(Number(landlord.user_id), Number(l.user.id));
  const [[invite]] = await db.pool.query('SELECT used_at, used_by FROM invites WHERE code = ?', [code]);
  assert.ok(invite.used_at);
  assert.equal(Number(invite.used_by), Number(l.user.id));
  const [[audit]] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'invite.use' AND actor_id = ?", [l.user.id]);
  assert.ok(!JSON.stringify(audit.after_json).includes(code), 'audit never holds the code');

  const page = await http.request('/landlord', { cookie: l.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /صفحة المالك/);
  assert.match(page.text, /مكتب الملاك/, 'managing office name');
  assert.match(page.text, /شقة 1-1/);
  assert.match(page.text, /شقة 1-2/);
  const [[c]] = await db.pool.query('SELECT end_date FROM contracts WHERE id = ?', [contractId]);
  assert.ok(page.text.includes(engine.noticeDeadline(c.end_date)), 'decision deadline = end - 60 from the engine');
  assert.ok(page.text.includes(engine.rentChangeDeadline(c.end_date)), 'rent change deadline = end - 90 from the engine');
  assert.ok(page.text.includes(`باقي ${engine.daysUntil(TODAY, c.end_date)} يوم`), 'days left from the engine');
  assert.match(page.text, /تقريبي/);
  assert.match(page.text, new RegExp(DISCLAIMER));
  assert.doesNotMatch(page.text, /الإيجار مجمّد في الرياض/, 'no freeze outside Riyadh');
  assert.doesNotMatch(page.text, /name="status"/, 'read only: no office forms');

  // Landlord cannot reach the office area.
  const officePage = await http.request('/office', { cookie: l.cookie });
  assert.equal(officePage.status, 403);
  const officeContract = await http.request(`/office/contracts/${contractId}`, { cookie: l.cookie });
  assert.equal(officeContract.status, 403);

  // The same code cannot be used again, by anyone.
  const again = await join(l.cookie, code);
  assert.equal(again.status, 422);
  const other = await person(4);
  const reuse = await join(other.cookie, code);
  assert.equal(reuse.status, 422);
  assert.match(reuse.text, new RegExp(GENERIC));
  assert.equal((await http.userByPhone(phone(4))).role, null);
});

// ------------------------------------------------------------ tenant happy path

test('tenant joins with the contract code and sees dates, countdown, decision deadline and payments', { skip }, async () => {
  const o = await office(5, 'مكتب المستأجرين');
  const contractId = await contract(o, { frequency: 'quarterly' });
  const t = await joined(6, await tenantCode(contractId));
  assert.equal(t.location, '/tenant?done=joined');
  assert.equal(t.user.role, 'tenant');
  assert.equal(await count("SELECT COUNT(*) FROM contract_members WHERE contract_id = ? AND user_id = ? AND role = 'tenant'", [contractId, t.user.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM contract_events WHERE contract_id = ? AND event_type = 'tenant_joined'", [contractId]), 1);

  const page = await http.request('/tenant', { cookie: t.cookie });
  assert.equal(page.status, 200);
  const [[c]] = await db.pool.query('SELECT start_date, end_date FROM contracts WHERE id = ?', [contractId]);
  assert.ok(page.text.includes(c.start_date) && page.text.includes(c.end_date));
  assert.ok(page.text.includes(`باقي ${engine.daysUntil(TODAY, c.end_date)} يوم على نهاية العقد`));
  assert.ok(page.text.includes(engine.noticeDeadline(c.end_date)));
  assert.ok(page.text.includes(`${engine.formatHijri(c.end_date)} تقريبي`));
  assert.match(page.text, /36,000\.00 ريال/);
  assert.match(page.text, /كل 3 أشهر/);
  assert.equal((page.text.match(/class="payment"/g) || []).length, 4);
  assert.match(page.text, /دفعت هذه الدفعة/);
  assert.match(page.text, /مكتب المستأجرين/);

  // A tenant cannot reach the landlord or office areas.
  const landlordPage = await http.request('/landlord', { cookie: t.cookie });
  assert.notEqual(landlordPage.status, 200);
  assert.equal(landlordPage.location, '/tenant', 'sent to the area they do have');
  const decision = await http.request(`/landlord/contracts/${contractId}/decision`, { method: 'POST', cookie: t.cookie, form: { decision: 'renew' } });
  assert.equal(decision.status, 403);
  assert.equal(await count('SELECT COUNT(*) FROM contract_decisions WHERE contract_id = ?', [contractId]), 0);
  assert.equal((await http.request('/office', { cookie: t.cookie })).status, 403);

  // Office detail shows the join status.
  const detail = await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie });
  assert.match(detail.text, /المستأجر<\/dt><dd><span class="badge badge--link-joined">منضم/);
  assert.match(detail.text, /انضم المستأجر بالرمز/);
});

test('a tenant code from before a renewal joins the renewed contract; renewal keeps the tenant link', { skip }, async () => {
  const o = await office(7, 'مكتب التجديد');
  const first = await contract(o, { start: dates.addMonths(TODAY, -11), end: months(dates.addMonths(TODAY, -11), 12) });
  const code = await tenantCode(first);
  // Simulate an old code that is still active when the contract is renewed.
  const renewed = await http.request(`/office/contracts/${first}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '36000', payment_frequency: 'monthly' } });
  assert.equal(renewed.status, 302);
  const second = contractIdFrom(renewed.location);
  await db.pool.query('UPDATE invites SET revoked_at = NULL WHERE code = ?', [code]);
  const t = await joined(8, code);
  assert.equal(await count("SELECT COUNT(*) FROM contract_members WHERE contract_id = ? AND user_id = ?", [second, t.user.id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM contract_members WHERE contract_id = ? AND user_id = ?", [first, t.user.id]), 0);

  // Renewing again copies the tenant link to the next contract.
  await db.pool.query("UPDATE contracts SET status = 'urgent' WHERE id = ?", [second]);
  const again = await http.request(`/office/contracts/${second}/renew`, { method: 'POST', cookie: o.cookie, form: { annual_rent: '36000', payment_frequency: 'monthly' } });
  assert.equal(again.status, 302);
  const third = contractIdFrom(again.location);
  assert.equal(await count("SELECT COUNT(*) FROM contract_members WHERE contract_id = ? AND user_id = ? AND role = 'tenant'", [third, t.user.id]), 1);
  const page = await http.request('/tenant', { cookie: t.cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`id="contract-${third}"`));
  assert.ok(!page.text.includes(`id="contract-${second}"`), 'the replaced contract is not shown');
});

// ------------------------------------------------------------ bad codes

test('wrong, malformed, expired, revoked, used and wrong-role codes all give one generic message', { skip }, async () => {
  const o = await office(9, 'مكتب الرموز');
  const contractId = await contract(o);
  const p = await person(10);
  const expired = await landlordCode(o);
  await db.pool.query('UPDATE invites SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE code = ?', [expired]);
  const revoked = await tenantCode(contractId);
  await db.pool.query('UPDATE invites SET revoked_at = UTC_TIMESTAMP() WHERE code = ?', [revoked]);
  const used = await landlordCode(o, o.landlordId);
  await db.pool.query('UPDATE invites SET used_at = UTC_TIMESTAMP() WHERE code = ?', [used]);
  const staff = 'STAFF234';
  await db.pool.query("INSERT INTO invites (code, kind, office_id, expires_at) VALUES (?, 'staff', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [staff, o.office.id]);

  for (const code of ['ABCDEFGH'.replace(/[ILO]/g, 'X'), 'short', '', 'A1B2C3D4', expired, revoked, used, staff, "' OR 1=1 --"]) {
    joins.joinGuard.reset();
    const res = await join(p.cookie, code);
    assert.equal(res.status, 422, `code ${code}`);
    assert.match(res.text, new RegExp(GENERIC));
    assert.doesNotMatch(res.text, /منتهي|ملغى|مستخدم\b/);
  }
  assert.equal((await http.userByPhone(phone(10))).role, null);
  assert.equal(await count('SELECT COUNT(*) FROM landlords WHERE user_id = ?', [p.user.id]), 0);
  assert.equal(await count('SELECT COUNT(*) FROM contract_members WHERE user_id = ?', [p.user.id]), 0);
  assert.equal(await count('SELECT COUNT(*) FROM invites WHERE used_by = ?', [p.user.id]), 0);

  // An inactive landlord's code is refused too.
  const inactive = await landlordCode(o);
  await db.pool.query('UPDATE landlords SET is_active = 0 WHERE id = ?', [o.landlordId]);
  assert.equal((await join(p.cookie, inactive)).status, 422);
});

test('staff, owners and the platform admin are refused and keep their role', { skip }, async () => {
  const o = await office(11, 'مكتب الموظفين');
  const code = await landlordCode(o);
  const staffCookie = await http.addMember(o.office.id, phone(12), 'office_staff');
  for (const cookie of [o.cookie, staffCookie]) {
    const page = await http.request('/join', { cookie });
    assert.match(page.text, /حسابك حساب مكتب عقار/);
    assert.doesNotMatch(page.text, /name="code"/);
    const res = await join(cookie, code);
    assert.equal(res.status, 403);
    assert.match(res.text, /حسابك حساب مكتب عقار/);
  }
  assert.equal((await http.userByPhone(phone(11))).role, 'office_owner');
  assert.equal((await http.userByPhone(phone(12))).role, 'office_staff');
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'platform_admin')", [phone(13)]);
  const admin = await http.userByPhone(phone(13));
  assert.deepEqual(await joins.joinWithCode(db.pool, { userId: admin.id, code }), { ok: false, reason: 'office_user' });
  assert.equal((await http.userByPhone(phone(13))).role, 'platform_admin');
  assert.equal(await count('SELECT COUNT(*) FROM invites WHERE code = ? AND used_at IS NULL', [code]), 1, 'the code is still unused');
  // Admin and office users have no landlord or tenant area.
  assert.equal((await http.request('/landlord', { cookie: o.cookie })).status, 403);
  assert.equal((await http.request('/tenant', { cookie: staffCookie })).status, 403);
});

// ------------------------------------------------------------ rate limits and race

test('rate limits: 5 attempts per user per 10 minutes, 20 per IP per hour, Arabic message', { skip }, async () => {
  const p = await person(14);
  for (let i = 0; i < 5; i += 1) assert.equal((await join(p.cookie, 'ABCDEFGH')).status, 422);
  const blocked = await join(p.cookie, 'ABCDEFGH');
  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /محاولات كثيرة/);
  assert.ok(Number(blocked.response.headers.get('retry-after')) > 0);

  joins.joinGuard.reset();
  const people = [];
  for (let n = 15; n < 20; n += 1) people.push(await person(n));
  let attempts = 0;
  for (const q of people.slice(0, 4)) {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await join(q.cookie, 'ABCDEFGH')).status, 422);
      attempts += 1;
    }
  }
  assert.equal(attempts, 20);
  assert.equal((await join(people[4].cookie, 'ABCDEFGH')).status, 429, 'the IP limit applies across users');

  // The guard itself: separate windows per user and IP.
  const guard = joins.createJoinGuard({ userLimit: { windowMs: 1000, max: 2 }, ipLimit: { windowMs: 1000, max: 3 } });
  assert.equal(guard.attempt({ userId: 1, ip: 'a' }), 0);
  assert.equal(guard.attempt({ userId: 1, ip: 'a' }), 0);
  assert.ok(guard.attempt({ userId: 1, ip: 'a' }) > 0);
  assert.equal(guard.attempt({ userId: 2, ip: 'a' }), 0);
  assert.ok(guard.attempt({ userId: 3, ip: 'a' }) > 0);
  assert.equal(guard.attempt({ userId: 3, ip: 'b' }), 0);
});

test('race: the same code redeemed in parallel succeeds exactly once', { skip }, async () => {
  const o = await office(20, 'مكتب السباق');
  const code = await landlordCode(o);
  const people = [];
  for (let n = 21; n < 26; n += 1) people.push(await person(n));
  const results = await Promise.all(people.map((p) => joins.joinWithCode(db.pool, { userId: p.user.id, code })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.reason === 'invalid').length, 4);
  assert.equal(await count('SELECT COUNT(*) FROM users WHERE phone IN (?) AND role = ?', [people.map((p) => p.user.phone), 'landlord']), 1);

  const contractId = await contract(o);
  const tcode = await tenantCode(contractId);
  const more = [];
  for (let n = 26; n < 29; n += 1) more.push(await person(n));
  const http3 = await Promise.all(more.map((p) => join(p.cookie, tcode)));
  assert.equal(http3.filter((r) => r.status === 302).length, 1);
  assert.equal(await count("SELECT COUNT(*) FROM contract_members WHERE contract_id = ? AND role = 'tenant'", [contractId]), 1);
});

// ------------------------------------------------------------ several links and the switcher

test('one person: landlord in two offices and tenant in one, with an area switcher', { skip }, async () => {
  const a = await office(30, 'المكتب الأول');
  const b = await office(31, 'المكتب الثاني');
  const p = await joined(32, await landlordCode(a));
  const bContract = await contract(b);
  const asTenant = await join(p.cookie, await tenantCode(bContract));
  assert.equal(asTenant.location, '/tenant?done=joined');
  assert.equal(await join(p.cookie, await landlordCode(b)).then((r) => r.status), 302);
  assert.equal((await http.userByPhone(phone(32))).role, 'landlord', 'the first role stays');

  const page = await http.request('/landlord', { cookie: p.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /المكتب الأول/);
  assert.match(page.text, /المكتب الثاني/);
  assert.match(page.text, /class="area-switch"/);
  assert.match(page.text, /href="\/tenant"/);
  assert.match(page.text, /href="\/landlord"[^>]*aria-current="page"/);
  const tenant = await http.request('/tenant', { cookie: p.cookie });
  assert.equal(tenant.status, 200);
  assert.match(tenant.text, /href="\/tenant"[^>]*aria-current="page"/);

  // A person with one area sees no switcher.
  const single = await joined(33, await tenantCode(await contract(a)));
  const singlePage = await http.request('/tenant', { cookie: single.cookie });
  assert.doesNotMatch(singlePage.text, /class="area-switch"/);
});

// ------------------------------------------------------------ isolation

test('isolation: landlord A never reads landlord B or another office; tenants only their contract', { skip }, async () => {
  const one = await office(40, 'مكتب واحد', { landlords: 2 });
  const two = await office(41, 'مكتب اثنان');
  const [landlordA, landlordB] = one.landlordIds;
  const contractA = await contract(one, { landlordId: landlordA });
  const contractB = await contract(one, { landlordId: landlordB });
  const contractOther = await contract(two);
  const a = await joined(42, await landlordCode(one, landlordA));
  const b = await joined(43, await landlordCode(one, landlordB));
  const t = await joined(44, await tenantCode(contractA));
  const tOther = await joined(45, await tenantCode(contractOther));

  const pageA = await http.request('/landlord', { cookie: a.cookie });
  assert.ok(pageA.text.includes(`/landlord/contracts/${contractA}"`));
  assert.ok(!pageA.text.includes(`/landlord/contracts/${contractB}"`));
  assert.doesNotMatch(pageA.text, /شقة 2-1/, 'landlord B units are not listed');
  assert.equal((await http.request(`/landlord/contracts/${contractA}`, { cookie: a.cookie })).status, 200);
  for (const id of [contractB, contractOther, 'abc', '0', '99999999', `${contractA}x`]) {
    assert.equal((await http.request(`/landlord/contracts/${id}`, { cookie: a.cookie })).status, 404, `contract ${id}`);
    const post = await http.request(`/landlord/contracts/${id}/decision`, { method: 'POST', cookie: a.cookie, form: { decision: 'renew' } });
    assert.equal(post.status, 404);
  }
  assert.equal(await count('SELECT COUNT(*) FROM contract_decisions WHERE contract_id IN (?)', [[contractB, contractOther]]), 0);
  assert.equal((await http.request(`/landlord/contracts/${contractB}`, { cookie: b.cookie })).status, 200);

  // Payment ids from another contract are 404 too.
  const [otherPayment] = await paymentsOf(contractOther);
  const [paymentB] = await paymentsOf(contractB);
  for (const pid of [otherPayment.id, paymentB.id]) {
    const res = await http.request(`/tenant/contracts/${contractA}/payments/${pid}/report`, { method: 'POST', cookie: t.cookie });
    assert.equal(res.status, 404);
    const conf = await http.request(`/landlord/contracts/${contractA}/payments/${pid}/confirm`, { method: 'POST', cookie: a.cookie });
    assert.equal(conf.status, 404);
  }
  const crossTenant = await http.request(`/tenant/contracts/${contractOther}/payments/${otherPayment.id}/report`, { method: 'POST', cookie: t.cookie });
  assert.equal(crossTenant.status, 404);
  const crossRequest = await http.request(`/tenant/contracts/${contractA}/requests`, { method: 'POST', cookie: tOther.cookie, form: { note: 'x' } });
  assert.equal(crossRequest.status, 404);
  assert.equal(await count("SELECT COUNT(*) FROM contract_payments WHERE status = 'tenant_reported' AND contract_id IN (?)", [[contractA, contractB, contractOther]]), 0);
  assert.equal(await count('SELECT COUNT(*) FROM contract_requests WHERE contract_id = ?', [contractA]), 0);

  const tenantPage = await http.request('/tenant', { cookie: tOther.cookie });
  assert.ok(tenantPage.text.includes(`id="contract-${contractOther}"`));
  assert.ok(!tenantPage.text.includes(`id="contract-${contractA}"`));
  assert.doesNotMatch(tenantPage.text, /مكتب واحد/);

  // The other office does not see this office's feedback counts.
  await http.request(`/tenant/contracts/${contractA}/payments/${(await paymentsOf(contractA))[0].id}/report`, { method: 'POST', cookie: t.cookie });
  assert.deepEqual(await feedback.pendingCounts(db.pool, two.office.id), { requests: 0, reported: 0 });
  assert.deepEqual(await feedback.pendingCounts(db.pool, one.office.id), { requests: 0, reported: 1 });
  // Another office cannot confirm it through its own URL.
  const foreign = await http.request(`/office/contracts/${contractA}/payments/${(await paymentsOf(contractA))[0].id}/confirm`, { method: 'POST', cookie: two.cookie });
  assert.equal(foreign.status, 404);
  assert.equal((await paymentsOf(contractA))[0].status, 'tenant_reported');
});

// ------------------------------------------------------------ decision note

test('landlord decision note is saved with a timestamp and shown to the office', { skip }, async () => {
  const o = await office(50, 'مكتب القرارات');
  const contractId = await contract(o);
  const l = await joined(51, await landlordCode(o));
  const bad = await http.request(`/landlord/contracts/${contractId}/decision`, { method: 'POST', cookie: l.cookie, form: { decision: 'sell' } });
  assert.equal(bad.status, 422);
  const long = await http.request(`/landlord/contracts/${contractId}/decision`, { method: 'POST', cookie: l.cookie, form: { decision: 'renew', note: 'x'.repeat(281) } });
  assert.equal(long.status, 422);
  assert.equal(await count('SELECT COUNT(*) FROM contract_decisions WHERE contract_id = ?', [contractId]), 0);

  const note = 'أرغب بالتجديد <b>بنفس</b> الإيجار';
  const res = await http.request(`/landlord/contracts/${contractId}/decision`, { method: 'POST', cookie: l.cookie, form: { decision: 'renew', note } });
  assert.equal(res.status, 302);
  const [[row]] = await db.pool.query('SELECT * FROM contract_decisions WHERE contract_id = ?', [contractId]);
  assert.equal(row.decision, 'renew');
  assert.equal(row.note, note);
  assert.ok(row.created_at);
  assert.equal(Number(row.landlord_id), o.landlordId);
  assert.equal(Number(row.office_id), o.office.id);
  const [[audit]] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'contract.decision' AND entity_id = ?", [contractId]);
  assert.ok(!JSON.stringify(audit.after_json).includes('أرغب'), 'audit holds no note text');

  const detail = await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie });
  assert.match(detail.text, /سيجدد/);
  assert.match(detail.text, /&lt;b&gt;بنفس&lt;\/b&gt;/, 'the note is escaped');
  assert.match(detail.text, /سجّل المالك قراره: سيجدد/);
  const mine = await http.request(`/landlord/contracts/${contractId}`, { cookie: l.cookie });
  assert.match(mine.text, /آخر قرار: <strong>سيجدد/);

  await http.request(`/landlord/contracts/${contractId}/decision`, { method: 'POST', cookie: l.cookie, form: { decision: 'not_renew' } });
  const again = await http.request('/landlord', { cookie: l.cookie });
  assert.match(again.text, /قرارك: لن يجدد/);
});

test('landlord needs-action list: undecided near deadlines and reported payments, most urgent first', { skip }, async () => {
  const o = await office(52, 'مكتب الإجراءات', { unitCount: 3 });
  const [u1, u2, u3] = o.units;
  // Decision deadline in 20 days (soon), in 3 days (urgent), and far away (calm).
  const endSoon = dates.addDays(TODAY, 80);
  const endUrgent = dates.addDays(TODAY, 63);
  const soon = await contract(o, { unitId: u1, start: dates.addDays(dates.addMonths(endSoon, -12), 1), end: endSoon });
  const urgent = await contract(o, { unitId: u2, start: dates.addDays(dates.addMonths(endUrgent, -12), 1), end: endUrgent });
  await contract(o, { unitId: u3 });
  const l = await joined(53, await landlordCode(o));
  await http.request('/office', { cookie: o.cookie }); // recompute stages
  const page = await http.request('/landlord', { cookie: l.cookie });
  const first = page.text.indexOf(`/landlord/contracts/${urgent}"`);
  const second = page.text.indexOf(`/landlord/contracts/${soon}"`);
  assert.ok(first > 0 && second > first, 'urgent before soon');
  assert.ok(page.text.includes(`باقي ${engine.daysUntil(TODAY, engine.noticeDeadline(endUrgent))} يوم على آخر موعد لقرار التجديد`));

  assert.match(page.text, /متأخرة منذ \d+ يوم/, 'late installments are listed too');

  // Once paid and decided, the contract leaves the list.
  await db.pool.query("UPDATE contract_payments SET status = 'paid', paid_at = UTC_TIMESTAMP() WHERE contract_id IN (?)", [[urgent, soon]]);
  await http.request(`/landlord/contracts/${urgent}/decision`, { method: 'POST', cookie: l.cookie, form: { decision: 'renew' } });
  const after = await http.request('/landlord', { cookie: l.cookie });
  const board = after.text.slice(after.text.indexOf('يحتاج إجراء'), after.text.indexOf('عقاراتك مع'));
  assert.ok(!board.includes(`/landlord/contracts/${urgent}"`), 'decided contracts leave the list');
  assert.ok(board.includes(`/landlord/contracts/${soon}"`));
});

// ------------------------------------------------------------ I paid

test('tenant "I paid" sets tenant_reported; the office or landlord confirms (paid) or rejects (due)', { skip }, async () => {
  const o = await office(60, 'مكتب الدفعات');
  const contractId = await contract(o, { start: dates.addMonths(TODAY, -2), end: months(dates.addMonths(TODAY, -2), 12) });
  const t = await joined(61, await tenantCode(contractId));
  const l = await joined(62, await landlordCode(o));
  const [p1, p2, p3] = await paymentsOf(contractId);

  const report = await http.request(`/tenant/contracts/${contractId}/payments/${p1.id}/report`, { method: 'POST', cookie: t.cookie });
  assert.equal(report.status, 302);
  let [row] = (await paymentsOf(contractId)).filter((p) => p.id === p1.id);
  assert.equal(row.status, 'tenant_reported', 'never paid by the tenant');
  assert.ok(row.reported_at);
  assert.equal(Number(row.reported_by), Number(t.user.id));
  assert.equal(row.paid_at, null);
  const twice = await http.request(`/tenant/contracts/${contractId}/payments/${p1.id}/report`, { method: 'POST', cookie: t.cookie });
  assert.match(twice.location, /done=unchanged/);
  const tenantPage = await http.request('/tenant', { cookie: t.cookie });
  assert.match(tenantPage.text, /بانتظار تأكيد المكتب أو المالك/);

  // Office board counts it; the office cannot set tenant_reported by hand.
  const home = await http.request('/office', { cookie: o.cookie });
  assert.match(home.text, /class="pending-reported">1</);
  const manual = await http.request(`/office/contracts/${contractId}/payments/${p2.id}`, { method: 'POST', cookie: o.cookie, form: { status: 'tenant_reported' } });
  assert.equal(manual.status, 422);
  const detail = await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie });
  assert.match(detail.text, /تأكيد الدفع/);
  assert.doesNotMatch(detail.text, /<option value="tenant_reported"/);

  // Office confirms: paid on the Riyadh day it was reported.
  const confirm = await http.request(`/office/contracts/${contractId}/payments/${p1.id}/confirm`, { method: 'POST', cookie: o.cookie });
  assert.equal(confirm.status, 302);
  [row] = (await paymentsOf(contractId)).filter((p) => p.id === p1.id);
  assert.equal(row.status, 'paid');
  assert.equal(new Date(row.paid_at).toISOString().slice(0, 10), dates.riyadhDate(new Date(row.reported_at)));
  const repeat = await http.request(`/office/contracts/${contractId}/payments/${p1.id}/reject`, { method: 'POST', cookie: o.cookie });
  assert.match(repeat.location, /done=unchanged/);
  assert.equal((await paymentsOf(contractId)).find((p) => p.id === p1.id).status, 'paid');

  // Office rejects: back to due, report cleared.
  await http.request(`/tenant/contracts/${contractId}/payments/${p2.id}/report`, { method: 'POST', cookie: t.cookie });
  await http.request(`/office/contracts/${contractId}/payments/${p2.id}/reject`, { method: 'POST', cookie: o.cookie });
  [row] = (await paymentsOf(contractId)).filter((p) => p.id === p2.id);
  assert.ok(['due', 'late'].includes(row.status));
  assert.equal(row.reported_at, null);
  assert.equal(row.reported_by, null);

  // The landlord can confirm too.
  await http.request(`/tenant/contracts/${contractId}/payments/${p3.id}/report`, { method: 'POST', cookie: t.cookie });
  const landlordPage = await http.request('/landlord', { cookie: l.cookie });
  assert.match(landlordPage.text, /أكّد الاستلام أو ارفضه/);
  const byLandlord = await http.request(`/landlord/contracts/${contractId}/payments/${p3.id}/confirm`, { method: 'POST', cookie: l.cookie });
  assert.equal(byLandlord.status, 302);
  assert.equal((await paymentsOf(contractId)).find((p) => p.id === p3.id).status, 'paid');
  const [[event]] = await db.pool.query("SELECT details FROM contract_events WHERE contract_id = ? AND event_type = 'payment_confirmed' ORDER BY id DESC LIMIT 1", [contractId]);
  assert.equal(event.details.by, 'landlord');

  // A tenant cannot report a paid installment.
  const paid = await http.request(`/tenant/contracts/${contractId}/payments/${p1.id}/report`, { method: 'POST', cookie: t.cookie });
  assert.match(paid.location, /done=unchanged/);
  assert.equal((await paymentsOf(contractId)).find((p) => p.id === p1.id).status, 'paid');
});

// ------------------------------------------------------------ rent reduction and the Riyadh freeze

test('Riyadh: freeze notice from the engine; reduction request allowed, stored once and handled by the office', { skip }, async () => {
  const o = await office(70, 'مكتب الرياض', { city: 'الرياض' });
  const contractId = await contract(o);
  const t = await joined(71, await tenantCode(contractId));
  const l = await joined(72, await landlordCode(o));
  const [[c]] = await db.pool.query('SELECT city, end_date FROM contracts WHERE id = ?', [contractId]);
  const policy = engine.rentChangePolicy({ city: c.city, today: TODAY, endDate: c.end_date });
  assert.equal(policy.reason, 'riyadh_freeze', 'fixture: the next term starts inside the freeze');

  const tenantPage = await http.request('/tenant', { cookie: t.cookie });
  assert.match(tenantPage.text, /الإيجار مجمّد في الرياض حتى/);
  assert.ok(tenantPage.text.includes(policy.freezeUntil));
  assert.match(tenantPage.text, /طلب تخفيض الإيجار عند التجديد/);
  assert.doesNotMatch(tenantPage.text, /زيادة|رفع الإيجار<\/summary>/, 'no rent increase flow');
  const landlordPage = await http.request('/landlord', { cookie: l.cookie });
  assert.match(landlordPage.text, /الإيجار مجمّد في الرياض حتى/);

  const tooLong = await http.request(`/tenant/contracts/${contractId}/requests`, { method: 'POST', cookie: t.cookie, form: { note: 'x'.repeat(501) } });
  assert.equal(tooLong.status, 422);
  const wrongType = await http.request(`/tenant/contracts/${contractId}/requests`, { method: 'POST', cookie: t.cookie, form: { request_type: 'rent_increase' } });
  assert.equal(wrongType.status, 404);
  const sent = await http.request(`/tenant/contracts/${contractId}/requests`, { method: 'POST', cookie: t.cookie, form: { note: 'الوضع الاقتصادي' } });
  assert.match(sent.location, /done=requested/);
  const second = await http.request(`/tenant/contracts/${contractId}/requests`, { method: 'POST', cookie: t.cookie, form: { note: 'مرة ثانية' } });
  assert.match(second.location, /done=pending_exists/);
  const [rows] = await db.pool.query('SELECT * FROM contract_requests WHERE contract_id = ?', [contractId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_type, 'rent_reduction');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].note, 'الوضع الاقتصادي');
  const afterPage = await http.request('/tenant', { cookie: t.cookie });
  assert.doesNotMatch(afterPage.text, /طلب تخفيض الإيجار عند التجديد<\/summary>/, 'no second form while pending');
  assert.match(afterPage.text, /بانتظار المكتب/);

  const home = await http.request('/office', { cookie: o.cookie });
  assert.match(home.text, /class="pending-requests">1</);
  const detail = await http.request(`/office/contracts/${contractId}`, { cookie: o.cookie });
  assert.match(detail.text, /طلب تخفيض الإيجار/);
  assert.match(detail.text, /الوضع الاقتصادي/);
  const bogus = await http.request(`/office/contracts/${contractId}/requests/${rows[0].id}`, { method: 'POST', cookie: o.cookie, form: { status: 'pending' } });
  assert.match(bogus.location, /done=unchanged/);
  const accept = await http.request(`/office/contracts/${contractId}/requests/${rows[0].id}`, { method: 'POST', cookie: o.cookie, form: { status: 'accepted' } });
  assert.match(accept.location, /done=request_handled/);
  const [[handled]] = await db.pool.query('SELECT status, handled_by, handled_at FROM contract_requests WHERE id = ?', [rows[0].id]);
  assert.equal(handled.status, 'accepted');
  assert.equal(Number(handled.handled_by), Number(o.user.id));
  assert.ok(handled.handled_at);
  assert.equal((await feedback.pendingCounts(db.pool, o.office.id)).requests, 0);
});

test('reduction request is blocked after the rent-change deadline (button hidden, POST refused)', { skip }, async () => {
  const o = await office(73, 'مكتب المهلة');
  const start = dates.addMonths(TODAY, -10); // ends in about 2 months: past end - 90
  const contractId = await contract(o, { start, end: months(start, 12) });
  const t = await joined(74, await tenantCode(contractId));
  const [[c]] = await db.pool.query('SELECT city, status, end_date FROM contracts WHERE id = ?', [contractId]);
  assert.equal(engine.rentChangePolicy({ city: c.city, today: TODAY, endDate: c.end_date }).requestOpen, false);
  assert.equal(feedback.reductionAvailability(c, TODAY).allowed, false);
  const page = await http.request('/tenant', { cookie: t.cookie });
  assert.doesNotMatch(page.text, /طلب تخفيض الإيجار عند التجديد/);
  const res = await http.request(`/tenant/contracts/${contractId}/requests`, { method: 'POST', cookie: t.cookie, form: { note: 'x' } });
  assert.match(res.location, /done=not_allowed/);
  assert.equal(await count('SELECT COUNT(*) FROM contract_requests WHERE contract_id = ?', [contractId]), 0);

  // A terminated contract allows no request either.
  assert.equal(feedback.reductionAvailability({ ...c, status: 'terminated', end_date: dates.addMonths(TODAY, 12) }, TODAY).allowed, false);
  assert.equal(feedback.reductionAvailability({ ...c, status: 'calm', end_date: dates.addMonths(TODAY, 12) }, TODAY).allowed, true);
});

test('session epoch: logging out everywhere also closes the landlord and tenant areas', { skip }, async () => {
  const o = await office(80, 'مكتب الجلسات');
  const l = await joined(81, await landlordCode(o));
  assert.equal((await http.request('/landlord', { cookie: l.cookie })).status, 200);
  await http.request('/logout-all', { method: 'POST', cookie: l.cookie });
  const after = await http.request('/landlord', { cookie: l.cookie });
  assert.equal(after.status, 302);
  assert.equal(after.location, '/login');
});

// ------------------------------------------------------------ migration

test('migration: the payment status enum gains tenant_reported in place, rows kept, once', { skip }, async () => {
  const [[real]] = await db.pool.query(
    `SELECT column_type AS type FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'contract_payments' AND column_name = 'status'`,
  );
  assert.match(real.type, /'tenant_reported'/);
  const [reportedCols] = await db.pool.query(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'contract_payments' AND column_name IN ('reported_at','reported_by') ORDER BY column_name`,
  );
  assert.deepEqual(reportedCols.map((c) => c.name), ['reported_at', 'reported_by']);

  const table = 'zz_test_migration_payments';
  await db.pool.query(`DROP TABLE IF EXISTS ${table}`);
  await db.pool.query(`CREATE TABLE ${table} (id INT PRIMARY KEY, status ENUM('due','paid') NOT NULL DEFAULT 'due')`);
  try {
    await db.pool.query(`INSERT INTO ${table} VALUES (1, 'paid'), (2, 'due')`);
    const additions = [{ table, column: 'status', value: 'tenant_reported', definition: "ENUM('due','paid','tenant_reported') NOT NULL DEFAULT 'due'" }];
    assert.deepEqual(await db.addMissingEnumValues(db.pool, additions), [`${table}.status=tenant_reported`]);
    assert.deepEqual(await db.addMissingEnumValues(db.pool, additions), [], 'running again changes nothing');
    const [rows] = await db.pool.query(`SELECT id, status FROM ${table} ORDER BY id`);
    assert.deepEqual(rows.map((r) => r.status), ['paid', 'due']);
    await db.pool.query(`UPDATE ${table} SET status = 'tenant_reported' WHERE id = 2`);
  } finally {
    await db.pool.query(`DROP TABLE IF EXISTS ${table}`);
  }
});
