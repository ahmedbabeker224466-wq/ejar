'use strict';

// Team (staff invites by phone, roles, deactivation, plan limit) and the
// internal task board (assignment, comments, due-tomorrow reminders) against
// real MySQL. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000010NN.
const phone = (n) => `9665000010${String(n).padStart(2, '0')}`;
const local = (n) => `0${phone(n).slice(3)}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let joins;
let reminders;

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
     VALUES ('test_team', 'اختبار الفريق', 1, 1, NULL, NULL, NULL, NULL, 0, 101), ('test_team_3', 'اختبار ثلاثة أعضاء', 1, 1, NULL, NULL, 3, NULL, 0, 102)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = VALUES(max_members), max_photos = NULL, is_active = 0`,
  );
  joins = require('../services/joins');
  reminders = require('../services/reminders');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_team' });
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

const invite = (cookie, n, role = 'office_staff') => http.request('/office/team/invite', { method: 'POST', cookie, form: { phone: local(n), role } });
const codeFor = async (n) => (await db.pool.query("SELECT code FROM invites WHERE kind = 'staff' AND phone = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1", [phone(n)]))[0][0]?.code;
const join = (cookie, code) => http.request('/join', { method: 'POST', cookie, form: { code } });
const memberOf = async (n) => (await db.pool.query('SELECT m.* FROM office_members m JOIN users u ON u.id = m.user_id WHERE u.phone = ?', [phone(n)]))[0][0];

/** Invites phone n and joins them. Returns { cookie, user }. */
async function onboard(owner, n, role = 'office_staff') {
  assert.equal((await invite(owner.cookie, n, role)).status, 302);
  const p = await fx.person(n);
  const res = await join(p.cookie, await codeFor(n));
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 300));
  assert.equal(res.location, '/office');
  return { ...p, user: await http.userByPhone(phone(n)) };
}

// ------------------------------------------------------------ team

test('invite staff by phone: the code works for that phone only, makes them a member with the right role', { skip }, async () => {
  const o = await fx.office(1, 'مكتب الفريق');
  const page = await http.request('/office/team', { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /دعوة عضو جديد/);

  assert.equal((await http.request('/office/team/invite', { method: 'POST', cookie: o.cookie, form: { phone: '123', role: 'office_staff' } })).status, 422);
  assert.equal((await http.request('/office/team/invite', { method: 'POST', cookie: o.cookie, form: { phone: local(2), role: 'office_owner' } })).status, 422, 'no owner invites');
  assert.equal((await http.request('/office/team/invite', { method: 'POST', cookie: o.cookie, form: { phone: local(2), role: 'platform_admin' } })).status, 422);
  const res = await invite(o.cookie, 2);
  assert.equal(res.status, 302);
  const [[row]] = await db.pool.query("SELECT * FROM invites WHERE kind = 'staff' AND phone = ?", [phone(2)]);
  assert.equal(row.role_hint, 'office_staff');
  assert.equal(Number(row.office_id), o.office.id);
  const shown = await http.request('/office/team', { cookie: o.cookie });
  assert.match(shown.text, new RegExp(row.code));
  assert.match(shown.text, /wa\.me\/966500001002/);
  const [[audit]] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'invite.create' AND office_id = ? ORDER BY id DESC LIMIT 1", [o.office.id]);
  assert.ok(!JSON.stringify(audit.after_json).includes(row.code), 'audit never holds the code');

  // Someone else (even with the code) cannot use it.
  const stranger = await fx.person(3);
  const bad = await join(stranger.cookie, row.code);
  assert.equal(bad.status, 422);
  assert.match(bad.text, /الرمز غير صحيح أو انتهت صلاحيته/);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE user_id = ?', [stranger.user.id]), 0);
  assert.equal((await http.userByPhone(phone(3))).role, null);

  // The invited phone joins; the code is single-use.
  const staff = await fx.person(2);
  const ok = await join(staff.cookie, row.code);
  assert.equal(ok.location, '/office');
  const user = await http.userByPhone(phone(2));
  assert.equal(user.role, 'office_staff');
  const member = await memberOf(2);
  assert.deepEqual([member.role, Number(member.is_active), Number(member.office_id)], ['office_staff', 1, o.office.id]);
  assert.equal((await http.request('/office', { cookie: staff.cookie })).status, 200);
  assert.equal((await http.request('/office/team', { cookie: staff.cookie })).status, 403, 'staff have no team page');
  assert.equal((await join((await fx.person(4)).cookie, row.code)).status, 422, 'used');
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE office_id = ?', [o.office.id]), 2);

  // Phones that cannot be invited: a current member, a landlord/tenant account, an existing office owner.
  assert.match((await invite(o.cookie, 2)).text, /عضو في مكتبك بالفعل/);
  const o2 = await fx.office(5, 'مكتب آخر');
  assert.match((await invite(o.cookie, 5)).text, /مسجل بحساب آخر/);
  const contractId = await fx.contract(o2);
  await fx.tenantOf(contractId, 6);
  assert.match((await invite(o.cookie, 6)).text, /مسجل بحساب آخر/);
  // A landlord/tenant who somehow holds a staff code still cannot use it.
  await db.pool.query("INSERT INTO invites (code, kind, office_id, role_hint, phone, expires_at) VALUES ('ABCD2345', 'staff', ?, 'office_staff', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [o.office.id, phone(6)]);
  const tenant = await fx.person(6);
  assert.equal((await join(tenant.cookie, 'ABCD2345')).status, 422, 'a tenant account is refused with the generic message');
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE user_id = ?', [tenant.user.id]), 0);

  // A new invite for the same phone revokes the old code; revoking works.
  assert.equal((await invite(o.cookie, 7)).status, 302);
  const first = await codeFor(7);
  assert.equal((await invite(o.cookie, 7, 'office_manager')).status, 302);
  const second = await codeFor(7);
  assert.notEqual(first, second);
  assert.equal((await join((await fx.person(7)).cookie, first)).status, 422, 'the replaced code is dead');
  const [[pending]] = await db.pool.query("SELECT id FROM invites WHERE code = ?", [second]);
  assert.equal((await http.request(`/office/team/invites/${pending.id}/revoke`, { method: 'POST', cookie: o.cookie })).status, 302);
  assert.equal((await join((await fx.person(7)).cookie, second)).status, 422, 'revoked');
});

test('roles: owner changes manager/staff, a manager manages staff only, nobody touches the owner or themselves', { skip }, async () => {
  const o = await fx.office(10, 'مكتب الأدوار');
  const manager = await onboard(o, 11, 'office_manager');
  const staff = await onboard(o, 12);
  const staff2 = await onboard(o, 13);
  const mMember = await memberOf(11);
  const sMember = await memberOf(12);
  const s2Member = await memberOf(13);
  const ownerMember = (await db.pool.query('SELECT * FROM office_members WHERE office_id = ? AND role = ?', [o.office.id, 'office_owner']))[0][0];
  const post = (cookie, id, sub, form = {}) => http.request(`/office/team/${id}/${sub}`, { method: 'POST', cookie, form });

  assert.equal((await http.request('/office/team', { cookie: manager.cookie })).status, 200, 'managers see the team page');
  // A manager can invite staff but not managers, and cannot change roles.
  assert.equal((await invite(manager.cookie, 14)).status, 302);
  assert.equal((await invite(manager.cookie, 15, 'office_manager')).status, 422);
  assert.equal(await fx.count("SELECT COUNT(*) FROM invites WHERE kind = 'staff' AND phone = ?", [phone(15)]), 0);
  assert.equal((await post(manager.cookie, sMember.id, 'role', { role: 'office_manager' })).status, 403);
  assert.equal((await memberOf(12)).role, 'office_staff');

  // Owner promotes and demotes.
  assert.equal((await post(o.cookie, sMember.id, 'role', { role: 'office_manager' })).status, 302);
  assert.equal((await memberOf(12)).role, 'office_manager');
  assert.equal((await http.userByPhone(phone(12))).role, 'office_manager', 'users.role stays in step');
  assert.equal((await http.request('/office/team', { cookie: staff.cookie })).status, 200, 'the new role applies at once');
  assert.equal((await post(o.cookie, sMember.id, 'role', { role: 'office_staff' })).status, 302);
  assert.equal((await http.request('/office/team', { cookie: staff.cookie })).status, 403);
  assert.equal((await post(o.cookie, sMember.id, 'role', { role: 'office_owner' })).status, 403, 'cannot make an owner');

  // Nobody changes the owner or themselves.
  assert.notEqual((await post(o.cookie, ownerMember.id, 'role', { role: 'office_staff' })).status, 302);
  assert.notEqual((await post(o.cookie, ownerMember.id, 'deactivate')).status, 302);
  assert.notEqual((await post(manager.cookie, mMember.id, 'deactivate')).status, 302, 'a manager cannot deactivate themselves');
  assert.notEqual((await post(manager.cookie, ownerMember.id, 'deactivate')).status, 302);
  assert.equal((await memberOf(11)).is_active, 1);
  const stillOwner = (await db.pool.query('SELECT role, is_active FROM office_members WHERE id = ?', [ownerMember.id]))[0][0];
  assert.deepEqual([stillOwner.role, Number(stillOwner.is_active)], ['office_owner', 1]);
  // A manager manages staff: deactivate and reactivate.
  assert.equal((await post(manager.cookie, s2Member.id, 'deactivate')).status, 302);
  assert.equal((await memberOf(13)).is_active, 0);
  assert.equal((await post(manager.cookie, s2Member.id, 'activate')).status, 302);
  assert.equal((await memberOf(13)).is_active, 1);
  // ... but not other managers.
  assert.equal((await post(o.cookie, sMember.id, 'role', { role: 'office_manager' })).status, 302);
  assert.notEqual((await post(manager.cookie, sMember.id, 'deactivate')).status, 302, 'managers cannot touch managers');
  assert.equal((await memberOf(12)).is_active, 1);
  // The promoted manager (member 12) can now manage staff.
  assert.equal((await post(staff.cookie, s2Member.id, 'deactivate')).status, 302);
  assert.equal((await memberOf(13)).is_active, 0);
});

test('deactivated staff lose access immediately; their open work is unassigned; reactivation needs plan room', { skip }, async () => {
  const o = await fx.office(20, 'مكتب الإيقاف');
  const staff = await onboard(o, 21);
  const staffMember = await memberOf(21);
  const contractId = await fx.contract(o);
  const tenant = await fx.tenantOf(contractId, 22);
  const reqRes = await fx.multipart(`/tenant/contracts/${contractId}/maintenance`, tenant.cookie, { category: 'ac', priority: 'normal', description: 'التكييف لا يبرّد' });
  const maintId = Number(/\/maintenance\/(\d+)/.exec(reqRes.location)[1]);
  assert.equal((await http.request(`/office/maintenance/${maintId}/assign`, { method: 'POST', cookie: o.cookie, form: { assignee: String(staff.user.id) } })).status, 302);
  assert.equal((await http.request('/office/tasks', { method: 'POST', cookie: o.cookie, form: { title: 'مهمة للموظف', assignee: String(staff.user.id) } })).status, 302);
  const [[task]] = await db.pool.query('SELECT id FROM office_tasks WHERE office_id = ? ORDER BY id DESC LIMIT 1', [o.office.id]);

  assert.equal((await http.request('/office', { cookie: staff.cookie })).status, 200);
  const epochBefore = (await http.userByPhone(phone(21))).session_epoch;
  assert.equal((await http.request(`/office/team/${staffMember.id}/deactivate`, { method: 'POST', cookie: o.cookie })).status, 302);
  // The same cookie stops working right away (session ended), and a fresh login is refused.
  const after = await http.request('/office', { cookie: staff.cookie });
  assert.equal(after.status, 302);
  assert.equal(after.location, '/login');
  assert.ok((await http.userByPhone(phone(21))).session_epoch > epochBefore);
  assert.equal(await fx.count('SELECT COUNT(*) FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL', [staff.user.id]), 0);
  const relogin = await http.login(phone(21));
  const blocked = await http.request('/office', { cookie: relogin.cookie });
  assert.equal(blocked.status, 403);
  assert.match(blocked.text, /تم إيقاف حسابك/);
  assert.equal((await http.request('/office/tasks', { cookie: relogin.cookie })).status, 403);
  assert.equal((await db.pool.query('SELECT assigned_to FROM maintenance_requests WHERE id = ?', [maintId]))[0][0].assigned_to, null);
  assert.equal((await db.pool.query('SELECT assigned_to FROM office_tasks WHERE id = ?', [task.id]))[0][0].assigned_to, null);
  assert.equal((await http.request(`/office/maintenance/${maintId}/assign`, { method: 'POST', cookie: o.cookie, form: { assignee: String(staff.user.id) } })).status, 422, 'cannot assign to an inactive member');

  // Plan limit: 3 active members (owner + 2). Invites count too.
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_team_3') WHERE id = ?", [o.office.id]);
  const second = await onboard(o, 23);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE office_id = ? AND is_active = 1', [o.office.id]), 2);
  assert.equal((await invite(o.cookie, 24)).status, 302, 'one seat left');
  const full = await invite(o.cookie, 25);
  assert.equal(full.status, 409, 'active members + pending invites fill the plan');
  assert.match(full.text, /حد باقتك: 3 أعضاء/);
  // Reactivating the old member would be the 3rd active + a pending invite: allowed (3 active), then nobody else fits.
  assert.equal((await http.request(`/office/team/${staffMember.id}/activate`, { method: 'POST', cookie: o.cookie })).status, 302);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE office_id = ? AND is_active = 1', [o.office.id]), 3);
  // The pending invite can no longer be redeemed: the plan is full.
  const late = await fx.person(24);
  const refused = await join(late.cookie, await codeFor(24));
  assert.equal(refused.status, 409);
  assert.match(refused.text, /حد باقته من الأعضاء/);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE user_id = ?', [late.user.id]), 0);
  assert.equal((await http.userByPhone(phone(24))).role, null);
  // Deactivating frees a seat for the pending invite and blocks activation at the limit.
  const secondMember = await memberOf(23);
  assert.equal((await http.request(`/office/team/${secondMember.id}/deactivate`, { method: 'POST', cookie: o.cookie })).status, 302);
  assert.equal((await join(late.cookie, await codeFor(24))).location, '/office');
  const blockedActivate = await http.request(`/office/team/${secondMember.id}/activate`, { method: 'POST', cookie: o.cookie });
  assert.equal(blockedActivate.status, 409);
  assert.match(blockedActivate.text, /حد باقتك/);
  void second;
});

test('parallel redemptions of the last seat: exactly one succeeds', { skip }, async () => {
  const o = await fx.office(30, 'مكتب المقعد الأخير');
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_team_3') WHERE id = ?", [o.office.id]);
  await onboard(o, 31);
  // Two invites are possible only while seats remain, so insert the second pair by hand (as if issued earlier).
  const people = [];
  for (const n of [32, 33, 34]) {
    await db.pool.query("INSERT INTO invites (code, kind, office_id, role_hint, phone, expires_at) VALUES (?, 'staff', ?, 'office_staff', ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [`PAR${n}XYZ`.slice(0, 8).replace(/[01OIL]/g, '2'), o.office.id, phone(n)]);
    people.push({ n, ...(await fx.person(n)) });
  }
  const results = await Promise.all(people.map(async (p) => {
    const code = (await db.pool.query("SELECT code FROM invites WHERE phone = ? AND kind = 'staff' ORDER BY id DESC LIMIT 1", [phone(p.n)]))[0][0].code;
    return joins.joinWithCode(db.pool, { userId: p.user.id, code });
  }));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_members WHERE office_id = ? AND is_active = 1', [o.office.id]), 3);
});

test('team isolation: another office cannot see or change these members or invites', { skip }, async () => {
  const a = await fx.office(40, 'مكتب أ');
  const b = await fx.office(45, 'مكتب ب');
  await onboard(a, 41);
  const aMember = await memberOf(41);
  await invite(a.cookie, 42);
  const [[pending]] = await db.pool.query("SELECT id, code FROM invites WHERE phone = ? AND kind = 'staff'", [phone(42)]);
  for (const sub of ['role', 'deactivate', 'activate']) {
    assert.equal((await http.request(`/office/team/${aMember.id}/${sub}`, { method: 'POST', cookie: b.cookie, form: { role: 'office_manager' } })).status, 404, sub);
  }
  assert.equal((await http.request(`/office/team/invites/${pending.id}/revoke`, { method: 'POST', cookie: b.cookie })).status, 302);
  assert.equal(await fx.count('SELECT COUNT(*) FROM invites WHERE id = ? AND revoked_at IS NULL', [pending.id]), 1, 'office B could not revoke it');
  const pageB = (await http.request('/office/team', { cookie: b.cookie })).text;
  assert.ok(!pageB.includes(pending.code) && !pageB.includes('41'));
  assert.equal((await http.request('/office/team/abc/deactivate', { method: 'POST', cookie: a.cookie })).status, 404);
  assert.equal((await memberOf(41)).is_active, 1);
});

// ------------------------------------------------------------ tasks

const addTask = (cookie, form) => http.request('/office/tasks', { method: 'POST', cookie, form });
const lastTask = async (officeId) => (await db.pool.query('SELECT * FROM office_tasks WHERE office_id = ? ORDER BY id DESC LIMIT 1', [officeId]))[0][0];

test('tasks board: create with assignee, due date and link; move; comments; notifications; validation', { skip }, async () => {
  const o = await fx.office(50, 'مكتب المهام');
  const staff = await onboard(o, 51);
  const contractId = await fx.contract(o);
  const board = await http.request('/office/tasks', { cookie: o.cookie });
  assert.equal(board.status, 200);
  assert.match(board.text, /لا توجد مهام. أضف أول مهمة/);
  assert.match(board.text, /تطبيق خاص غير تابع لمنصة إيجار/);

  assert.equal((await addTask(o.cookie, { title: '  ' })).status, 422);
  assert.equal((await addTask(o.cookie, { title: 'ب'.repeat(161) })).status, 422);
  assert.equal((await addTask(o.cookie, { title: 'x', due_date: '2026-13-45' })).status, 422);
  assert.equal((await addTask(o.cookie, { title: 'x', link_type: 'bogus', link_id: '1' })).status, 422);
  assert.equal((await addTask(o.cookie, { title: 'x', link_type: 'contract', link_id: '99999999' })).status, 422, 'the link must exist in this office');
  assert.equal((await addTask(o.cookie, { title: 'x', assignee: '99999999' })).status, 422);
  assert.equal(await fx.count('SELECT COUNT(*) FROM office_tasks WHERE office_id = ?', [o.office.id]), 0);

  const due = fx.dates.addDays(fx.today(), 5);
  const ok = await addTask(o.cookie, { title: 'اتصل بالمالك <b>اليوم</b>', description: 'تفاصيل', due_date: due, assignee: String(staff.user.id), link_type: 'contract', link_id: String(contractId) });
  assert.equal(ok.status, 302);
  const task = await lastTask(o.office.id);
  assert.deepEqual([task.status, Number(task.assigned_to), String(task.due_date).slice(0, 10), task.entity_type, Number(task.entity_id)], ['todo', Number(staff.user.id), due, 'contract', contractId]);
  const [note] = (await db.pool.query("SELECT title, body, link FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [staff.user.id]))[0];
  assert.match(note.title, new RegExp(`مهمة رقم ${task.id}`));
  assert.doesNotMatch(`${note.title} ${note.body}`, /اتصل|المالك/, 'the task text is not in the notification');
  assert.equal(note.link, `/office/tasks/${task.id}`);
  assert.equal((await db.pool.query("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [o.user.id]))[0].length, 0, 'no self notification');

  const page = (await http.request('/office/tasks', { cookie: staff.cookie })).text;
  assert.match(page, /اتصل بالمالك &lt;b&gt;اليوم&lt;\/b&gt;/);
  assert.match(page, new RegExp(`/office/contracts/${contractId}`));
  const mine = (await http.request('/office/tasks?assignee=me', { cookie: o.cookie })).text;
  assert.doesNotMatch(mine, /اتصل بالمالك/, 'my tasks only');

  // Move across the board.
  for (const [status, label] of [['doing', 'قيد التنفيذ'], ['done', 'منجزة'], ['todo', 'للتنفيذ']]) {
    assert.equal((await http.request(`/office/tasks/${task.id}/status`, { method: 'POST', cookie: staff.cookie, form: { status } })).status, 302);
    assert.equal((await lastTask(o.office.id)).status, status, label);
  }
  await http.request(`/office/tasks/${task.id}/status`, { method: 'POST', cookie: staff.cookie, form: { status: 'done' } });
  assert.ok((await lastTask(o.office.id)).completed_at);
  assert.equal((await http.request(`/office/tasks/${task.id}/status`, { method: 'POST', cookie: staff.cookie, form: { status: 'bogus' } })).status, 422);

  // Edit and reassign: the new assignee is told once.
  const edit = await http.request(`/office/tasks/${task.id}`, { method: 'POST', cookie: o.cookie, form: { title: 'عنوان جديد', description: '', due_date: '', assignee: String(o.user.id) } });
  assert.equal(edit.status, 302);
  const edited = await lastTask(o.office.id);
  assert.deepEqual([edited.title, Number(edited.assigned_to), edited.due_date, edited.entity_type], ['عنوان جديد', Number(o.user.id), null, null]);
  assert.equal((await db.pool.query("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'task_assigned'", [o.user.id]))[0].length, 0, 'assigning yourself does not notify you');

  // Comments: escaped, bounded, notify the assignee.
  assert.equal((await http.request(`/office/tasks/${task.id}/comments`, { method: 'POST', cookie: staff.cookie, form: { body: 'تم الاتصال <script>x</script>' } })).status, 302);
  assert.equal((await http.request(`/office/tasks/${task.id}/comments`, { method: 'POST', cookie: staff.cookie, form: { body: '' } })).status, 422);
  assert.equal((await http.request(`/office/tasks/${task.id}/comments`, { method: 'POST', cookie: staff.cookie, form: { body: 'ب'.repeat(1001) } })).status, 422);
  const detail = (await http.request(`/office/tasks/${task.id}`, { cookie: o.cookie })).text;
  assert.match(detail, /تم الاتصال &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(detail, /<script>x/);
  assert.equal((await db.pool.query("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'تعليق جديد%'", [o.user.id]))[0].length, 1);
});

test('tasks isolation: other offices, landlords and tenants cannot see or change them', { skip }, async () => {
  const a = await fx.office(60, 'مكتب أ');
  const b = await fx.office(65, 'مكتب ب');
  const contractId = await fx.contract(a);
  const landlord = await fx.landlordOf(a, 61);
  const tenant = await fx.tenantOf(contractId, 62);
  assert.equal((await addTask(a.cookie, { title: 'سري لمكتب أ' })).status, 302);
  const task = await lastTask(a.office.id);
  assert.equal((await http.request(`/office/tasks/${task.id}`, { cookie: b.cookie })).status, 404, 'GET');
  for (const sub of ['/status', '/comments']) {
    assert.equal((await http.request(`/office/tasks/${task.id}${sub}`, { method: 'POST', cookie: b.cookie, form: { title: 'x', status: 'done', body: 'x' } })).status, 404, sub);
  }
  assert.equal((await http.request(`/office/tasks/${task.id}`, { method: 'POST', cookie: b.cookie, form: { title: 'اختراق' } })).status, 404);
  assert.equal((await lastTask(a.office.id)).title, 'سري لمكتب أ');
  assert.ok(!(await http.request('/office/tasks', { cookie: b.cookie })).text.includes('سري لمكتب أ'));
  // A task cannot link to another office's contract.
  const contractB = await fx.contract(b);
  assert.equal((await addTask(a.cookie, { title: 'ربط خارجي', link_type: 'contract', link_id: String(contractB) })).status, 422);
  for (const who of [landlord, tenant]) {
    assert.equal((await http.request('/office/tasks', { cookie: who.cookie })).status, 403);
    assert.equal((await http.request(`/office/tasks/${task.id}`, { cookie: who.cookie })).status, 403);
    assert.equal((await addTask(who.cookie, { title: 'x' })).status, 403);
  }
  assert.equal((await http.request('/office/tasks/abc', { cookie: a.cookie })).status, 404);
});

test('task due-tomorrow reminder: once per task and person, idempotent, catch-up safe, only open assigned tasks of active members', { skip }, async () => {
  const o = await fx.office(70, 'مكتب التذكير');
  const staff = await onboard(o, 71);
  const staff2 = await onboard(o, 72);
  const today = fx.today();
  const tomorrow = fx.dates.addDays(today, 1);
  const make = async (title, assignee, due, status = 'todo') => {
    await addTask(o.cookie, { title, assignee: assignee ? String(assignee.user.id) : '', due_date: due || '' });
    const t = await lastTask(o.office.id);
    if (status !== 'todo') await db.pool.query('UPDATE office_tasks SET status = ? WHERE id = ?', [status, t.id]);
    return t.id;
  };
  const due1 = await make('تستحق غداً', staff, tomorrow);
  await make('تستحق بعد يومين', staff, fx.dates.addDays(today, 2));
  await make('تستحق اليوم', staff, today);
  await make('منجزة', staff, tomorrow, 'done');
  await make('بلا مسؤول', null, tomorrow);
  const due2 = await make('لموظف آخر', staff2, tomorrow);
  const departed = await onboard(o, 73);
  const due3 = await make('لموظف سيُوقف', departed, tomorrow);
  await http.request(`/office/team/${(await memberOf(73)).id}/deactivate`, { method: 'POST', cookie: o.cookie });
  void due3;

  const run = (lastRun = null) => reminders.computeDueReminders({ pool: db.pool, today, lastRun, now: new Date(), officeId: o.office.id });
  const count = async (user) => (await db.pool.query("SELECT * FROM notifications WHERE user_id = ? AND kind = 'task_due'", [user.id]))[0];
  await run();
  const first = await count(staff.user);
  assert.equal(first.length, 1);
  assert.match(first[0].title, new RegExp(`مهمة رقم ${due1} تستحق غداً`));
  assert.equal(first[0].link, `/office/tasks/${due1}`);
  assert.equal(first[0].dedupe_key, `task_due:t${due1}:u${staff.user.id}:${tomorrow}`);
  assert.doesNotMatch(first[0].body, /تستحق غداً\b.*تستحق/);
  assert.ok(first[0].body.endsWith('تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط'));
  assert.equal((await count(staff2.user)).length, 1);
  assert.equal((await count(departed.user)).length, 0, 'a deactivated assignee gets nothing');
  assert.equal((await count(o.user)).length, 0);

  const again = await run();
  assert.equal((await count(staff.user)).length, 1, 'running twice sends nothing new');
  assert.equal(again.created, 0);
  await Promise.all([run(), run(), run()]);
  assert.equal((await count(staff.user)).length, 1, 'parallel runs too');
  // A catch-up run covering missed days does not repeat it either.
  await run(fx.dates.addDays(today, -3));
  const caught = await count(staff.user);
  assert.equal(caught.length, 2, 'the missed "due tomorrow" of yesterday is sent once, marked late');
  assert.ok(caught.some((n) => /^متأخر: /.test(n.title)));
  assert.equal((await count(staff2.user)).length, 1);
  await run(fx.dates.addDays(today, -3));
  assert.equal((await count(staff.user)).length, 2, 'and not again');
  void due2;

  // Tomorrow's run: the "after two days" task is now due tomorrow.
  const next = await reminders.computeDueReminders({ pool: db.pool, today: tomorrow, lastRun: today, now: new Date(), officeId: o.office.id });
  assert.ok(next.created >= 1);
  assert.equal((await count(staff.user)).length, 3);
  // Marking a task done stops the reminder.
  await db.pool.query("UPDATE office_tasks SET status = 'done' WHERE office_id = ?", [o.office.id]);
  const dayAfter = fx.dates.addDays(today, 2);
  const none = await reminders.computeDueReminders({ pool: db.pool, today: dayAfter, lastRun: tomorrow, now: new Date(), officeId: o.office.id });
  assert.equal(none.created, 0);
});
