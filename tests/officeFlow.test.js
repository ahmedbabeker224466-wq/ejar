'use strict';

// Office registration and the office area, end to end over HTTP against real
// MySQL. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file uses: 9665000001NN.
const phone = (n) => `9665000001${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 40 }, (_, i) => phone(i));
const saved = {};
let db;
let server;
let base;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'REQUIRE_ADMIN_2FA', 'PLATFORM_ADMIN_PHONE', 'JWT_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.PLATFORM_ADMIN_PHONE = '0500000139';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  // The plans the seed script creates, in case this database was never seeded.
  await db.pool.query(
    `INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order)
     VALUES ('trial', 'تجربة', 0, 0, 1), ('basic', 'أساسية', 99, 990, 2)`,
  );
  const app = require('../app');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query("DELETE FROM offices WHERE name LIKE 'اختبار-%'");
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
}

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (server) server.close();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

// ------------------------------------------------------------ helpers

async function request(path, { cookie, method = 'GET', form } = {}) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = cookie;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(`${base}${path}`, { method, headers, body, redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), text: await response.text(), response };
}

/** Signs in with a valid phone code, exactly like a person would. */
async function login(canonicalPhone) {
  const { hashCode } = require('../services/otp');
  const auth = require('../services/auth');
  await db.pool.query('DELETE FROM otp_codes WHERE phone = ?', [canonicalPhone]);
  await db.pool.query(
    "INSERT INTO otp_codes (phone, code_hash, purpose, expires_at) VALUES (?, ?, 'login', UTC_TIMESTAMP() + INTERVAL 5 MINUTE)",
    [canonicalPhone, hashCode(canonicalPhone, '123456')],
  );
  const step = auth.signStepToken({ phone: canonicalPhone, sentAt: Date.now() }, 'login-phone', 600);
  const result = await request('/login/verify', { method: 'POST', cookie: `aqdi_login=${step}`, form: { code: '123456' } });
  const setCookie = result.response.headers.getSetCookie().find((c) => c.startsWith('aqdi_session='));
  return { location: result.location, cookie: setCookie ? setCookie.split(';')[0] : null };
}

async function userByPhone(p) {
  const [[user]] = await db.pool.query('SELECT * FROM users WHERE phone = ?', [p]);
  return user;
}

const OFFICE_FORM = {
  name: 'مكتب اختبار التسجيل',
  city: 'الرياض',
  phone: '0112345678',
  email: 'office@example.sa',
  cr_number: '1010123456',
  rega_license: '1200001234',
};

/** Registers a new office through the real pages; returns the owner's cookie and office id. */
async function registerOffice(p, form = OFFICE_FORM) {
  const { cookie } = await login(p);
  const created = await request('/office/new', { method: 'POST', cookie, form });
  assert.equal(created.status, 302, created.text.slice(0, 200));
  const user = await userByPhone(p);
  const [[office]] = await db.pool.query('SELECT * FROM offices WHERE owner_id = ?', [user.id]);
  return { cookie, user, office };
}

/** Adds an existing-or-new user to an office with a role, directly in the database. */
async function addMember(officeId, p, role, { active = 1, userRole = role } = {}) {
  await db.pool.query('INSERT INTO users (phone, role) VALUES (?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [p, userRole]);
  const user = await userByPhone(p);
  await db.pool.query('INSERT INTO office_members (office_id, user_id, role, is_active) VALUES (?, ?, ?, ?)', [
    officeId, user.id, role, active,
  ]);
  return (await login(p)).cookie;
}

function navHrefs(html) {
  const nav = html.slice(html.indexOf('<nav id="office-nav"'), html.indexOf('</nav>', html.indexOf('<nav id="office-nav"')));
  return [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

// ------------------------------------------------------------ registration

test('register end to end: new phone -> code -> /office/new -> office, owner, member, 14-day trial, audit', { skip }, async () => {
  const page = await request('/register');
  assert.equal(page.status, 200);
  assert.match(page.text, /سجّل مكتبك/);
  assert.match(page.text, /name="intent" value="register"/);
  assert.match((await request('/')).text, /href="\/register"/, 'linked from the home page and header');

  const p = phone(1);
  const { location, cookie } = await login(p);
  assert.equal(location, '/office/new', 'a new phone goes to office creation');
  assert.equal((await userByPhone(p)).role, null, 'no role until the office exists');

  assert.equal((await request('/office', { cookie })).location, '/office/new');
  const form = await request('/office/new', { cookie });
  assert.equal(form.status, 200);
  assert.match(form.text, /value="0500000101"/, 'office phone defaults to the login phone');
  assert.match(form.text, /<option value="الرياض" selected>/, 'Riyadh first and selected');

  const before = Date.now();
  const created = await request('/office/new', { method: 'POST', cookie, form: OFFICE_FORM });
  assert.equal(created.status, 302);
  assert.equal(created.location, '/office');

  const user = await userByPhone(p);
  assert.equal(user.role, 'office_owner');
  const [offices] = await db.pool.query('SELECT * FROM offices WHERE owner_id = ?', [user.id]);
  assert.equal(offices.length, 1);
  const office = offices[0];
  assert.equal(office.name, OFFICE_FORM.name);
  assert.equal(office.city, 'الرياض');
  assert.equal(office.phone, '966112345678');
  assert.equal(office.email, 'office@example.sa');
  assert.equal(office.cr_number, '1010123456');
  assert.equal(office.rega_license, '1200001234');
  assert.equal(office.status, 'trial');
  const days = (new Date(office.trial_ends_at).getTime() - before) / 86400000;
  assert.ok(days > 13.99 && days < 14.01, `trial ends in 14 days (got ${days})`);
  const [[cheapest]] = await db.pool.query(
    'SELECT id FROM plans WHERE is_active = 1 ORDER BY price_monthly ASC, sort_order ASC, id ASC LIMIT 1',
  );
  assert.equal(office.plan_id, cheapest.id, 'lowest-priced active plan');

  const [members] = await db.pool.query('SELECT * FROM office_members WHERE office_id = ?', [office.id]);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, user.id);
  assert.equal(members[0].role, 'office_owner');
  assert.equal(members[0].is_active, 1);

  const [settings] = await db.pool.query(
    'SELECT setting_key, setting_value FROM office_settings WHERE office_id = ? ORDER BY setting_key',
    [office.id],
  );
  assert.deepEqual(Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value])), {
    'reminders.channel.email': '1',
    'reminders.channel.site': '1',
    'reminders.channel.telegram': '0',
    'reminders.channel.whatsapp': '0',
  });

  const [audits] = await db.pool.query("SELECT * FROM audit_logs WHERE office_id = ? AND action = 'office.create'", [office.id]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, user.id);

  const home = await request('/office', { cookie });
  assert.equal(home.status, 200);
  assert.match(home.text, /مكتب اختبار التسجيل/);
  assert.match(home.text, /تجربتك المجانية تنتهي بعد 14 يوم/);
  assert.match(home.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);
  assert.equal((home.text.match(/class="stat__value">0</g) || []).length, 6, 'six stats, all zero');
  assert.match(home.text, /يحتاج إجراء/);
  for (const href of ['/office/landlords', '/office/units', '/office/contracts', '/office/team', '/office/settings']) {
    assert.ok(home.text.includes(`<a href="${href}">`), `checklist links ${href}`);
  }

  // Never again: back to /office, and a second submit creates nothing.
  assert.equal((await request('/office/new', { cookie })).location, '/office');
  const again = await request('/office/new', { method: 'POST', cookie, form: { ...OFFICE_FORM, name: 'مكتب ثان' } });
  assert.equal(again.location, '/office');
  const [[count]] = await db.pool.query('SELECT COUNT(*) AS n FROM offices WHERE owner_id = ?', [user.id]);
  assert.equal(Number(count.n), 1);
  assert.equal((await request('/register', { cookie })).location, '/office');
});

test('the office form is validated on the server', { skip }, async () => {
  const p = phone(2);
  const { cookie } = await login(p);
  const bad = await request('/office/new', {
    method: 'POST',
    cookie,
    form: { name: '', city: 'Paris', phone: '12', email: 'nope', cr_number: '12', rega_license: 'x' },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /اكتب اسم المكتب/);
  assert.match(bad.text, /اختر المدينة من القائمة/);
  assert.match(bad.text, /البريد الإلكتروني غير صحيح/);
  const user = await userByPhone(p);
  assert.equal(user.role, null);
  const [[count]] = await db.pool.query('SELECT COUNT(*) AS n FROM offices WHERE owner_id = ?', [user.id]);
  assert.equal(Number(count.n), 0);
});

test('the office form is rate limited', { skip }, async () => {
  const { cookie } = await login(phone(3));
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push((await request('/office/new', { method: 'POST', cookie, form: { name: '' } })).status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(422));
  assert.equal(statuses[10], 429);
});

for (const failingStep of ['office_members', 'office_settings', 'audit_logs']) {
  test(`a failure while writing ${failingStep} rolls the whole office back`, { skip }, async () => {
    const { createOffice } = require('../services/offices');
    const p = phone(failingStep === 'office_members' ? 4 : failingStep === 'office_settings' ? 5 : 6);
    await db.pool.query('INSERT INTO users (phone, role) VALUES (?, NULL)', [p]);
    const user = await userByPhone(p);

    // A pool whose connection fails on the chosen INSERT, like a real database error.
    const failingPool = {
      async getConnection() {
        const conn = await db.pool.getConnection();
        return new Proxy(conn, {
          get(target, prop) {
            if (prop !== 'query') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
            return (sql, params) => {
              if (new RegExp(`INSERT INTO \`?${failingStep}\`?`).test(sql)) {
                return Promise.reject(Object.assign(new Error('simulated failure'), { code: 'ER_SIMULATED' }));
              }
              return target.query(sql, params);
            };
          },
        });
      },
    };

    const name = `اختبار-${failingStep}`;
    await assert.rejects(
      createOffice(failingPool, { userId: user.id, fields: { ...OFFICE_FORM, name, phone: '966112345678' }, ip: null }),
      /simulated failure/,
    );

    const [[offices]] = await db.pool.query('SELECT COUNT(*) AS n FROM offices WHERE name = ? OR owner_id = ?', [name, user.id]);
    assert.equal(Number(offices.n), 0, 'no office row');
    assert.equal((await userByPhone(p)).role, null, 'role not granted');
    const [[members]] = await db.pool.query('SELECT COUNT(*) AS n FROM office_members WHERE user_id = ?', [user.id]);
    assert.equal(Number(members.n), 0, 'no member row');
    const [[audits]] = await db.pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id = ? AND action = 'office.create'", [user.id]);
    assert.equal(Number(audits.n), 0, 'no audit row');
    const [[orphans]] = await db.pool.query(
      'SELECT COUNT(*) AS n FROM office_settings s LEFT JOIN offices o ON o.id = s.office_id WHERE o.id IS NULL',
    );
    assert.equal(Number(orphans.n), 0, 'no settings rows');
  });
}

// ------------------------------------------------------------ platform_admin

test('nobody becomes platform_admin through /register or /office/new', { skip }, async () => {
  // A normal phone posting role/office fields gets office_owner, nothing more.
  const p = phone(7);
  const { cookie } = await login(p);
  await request('/office/new', {
    method: 'POST',
    cookie,
    form: { ...OFFICE_FORM, role: 'platform_admin', owner_id: '1', status: 'active', plan_id: '999' },
  });
  const user = await userByPhone(p);
  assert.equal(user.role, 'office_owner');
  const [[office]] = await db.pool.query('SELECT status FROM offices WHERE owner_id = ?', [user.id]);
  assert.equal(office.status, 'trial', 'status cannot be chosen by the form');

  // The admin phone never gets an office through this flow, and keeps its role.
  const admin = await login('966500000139');
  assert.equal(admin.location, '/platform');
  assert.equal((await request('/office/new', { cookie: admin.cookie })).location, '/platform');
  const post = await request('/office/new', { method: 'POST', cookie: admin.cookie, form: OFFICE_FORM });
  assert.equal(post.location, '/platform');
  const adminUser = await userByPhone('966500000139');
  assert.equal(adminUser.role, 'platform_admin');
  const [[n]] = await db.pool.query('SELECT COUNT(*) AS n FROM office_members WHERE user_id = ?', [adminUser.id]);
  assert.equal(Number(n.n), 0);

  // Registering again with a phone that already has an office changes nothing.
  assert.equal((await login(p)).location, '/office');
});

// ------------------------------------------------------------ isolation

test('office A cannot see or change anything of office B, even by guessing ids', { skip }, async () => {
  const a = await registerOffice(phone(10), { ...OFFICE_FORM, name: 'مكتب أ' });
  const b = await registerOffice(phone(11), { ...OFFICE_FORM, name: 'مكتب ب', city: 'جدة' });

  // Data in office B only.
  const today = new Date().toISOString().slice(0, 10);
  const [contract] = await db.pool.query(
    "INSERT INTO contracts (office_id, start_date, end_date, annual_rent, status) VALUES (?, ?, DATE_ADD(?, INTERVAL 30 DAY), 12000, 'soon')",
    [b.office.id, today, today],
  );
  await db.pool.query(
    "INSERT INTO contract_payments (contract_id, office_id, due_date, amount, status) VALUES (?, ?, DATE_SUB(?, INTERVAL 5 DAY), 1000, 'due')",
    [contract.insertId, b.office.id, today],
  );

  const homeA = await request('/office', { cookie: a.cookie });
  assert.equal((homeA.text.match(/class="stat__value">0</g) || []).length, 6, 'A sees none of B\'s numbers');
  assert.ok(!homeA.text.includes('مكتب ب'));
  const homeB = await request('/office', { cookie: b.cookie });
  assert.match(homeB.text, /class="stat__value">1</, 'B sees its own contract');
  assert.match(homeB.text, /دفعات متأخرة/);

  // Guessing: office ids in the query, the body and a cookie are all ignored.
  const guessed = await request(`/office/settings?office_id=${b.office.id}`, { cookie: `${a.cookie}; office_id=${b.office.id}` });
  assert.match(guessed.text, /value="مكتب أ"/);
  assert.ok(!guessed.text.includes('مكتب ب'));

  const post = await request(`/office/settings?office_id=${b.office.id}`, {
    method: 'POST',
    cookie: `${a.cookie}; office_id=${b.office.id}`,
    form: { ...OFFICE_FORM, name: 'مكتب أ الجديد', office_id: String(b.office.id), id: String(b.office.id) },
  });
  assert.equal(post.location, '/office/settings?saved=1');
  const [[rowA]] = await db.pool.query('SELECT name FROM offices WHERE id = ?', [a.office.id]);
  const [[rowB]] = await db.pool.query('SELECT name, city FROM offices WHERE id = ?', [b.office.id]);
  assert.equal(rowA.name, 'مكتب أ الجديد');
  assert.equal(rowB.name, 'مكتب ب', 'B untouched');
  assert.equal(rowB.city, 'جدة');

  const [[audit]] = await db.pool.query(
    "SELECT office_id, before_json, after_json FROM audit_logs WHERE action = 'office.update' AND office_id = ? ORDER BY id DESC LIMIT 1",
    [a.office.id],
  );
  assert.deepEqual(audit.before_json, { name: 'مكتب أ' });
  assert.deepEqual(audit.after_json, { name: 'مكتب أ الجديد' });
});

test('staff and managers cannot open pages their capabilities do not allow', { skip }, async () => {
  const owner = await registerOffice(phone(12), { ...OFFICE_FORM, name: 'مكتب الصلاحيات' });
  const staff = await addMember(owner.office.id, phone(13), 'office_staff');
  const manager = await addMember(owner.office.id, phone(14), 'office_manager');

  for (const path of ['/office/team', '/office/billing', '/office/audit', '/office/listings', '/office/reports']) {
    assert.equal((await request(path, { cookie: staff })).status, 403, `staff ${path}`);
  }
  for (const path of ['/office', '/office/contracts', '/office/landlords', '/office/units', '/office/tenants',
    '/office/payments', '/office/maintenance', '/office/messages', '/office/settings']) {
    const page = await request(path, { cookie: staff });
    assert.equal(page.status, 200, `staff ${path}`);
  }
  assert.match((await request('/office/tenants', { cookie: staff })).text, /هذه الصفحة قيد البناء/);

  // Staff sees settings read-only and cannot save.
  const settings = await request('/office/settings', { cookie: staff });
  assert.ok(!settings.text.includes('action="/office/settings"'));
  const post = await request('/office/settings', { method: 'POST', cookie: staff, form: { ...OFFICE_FORM, name: 'تغيير' } });
  assert.equal(post.status, 403);
  const [[row]] = await db.pool.query('SELECT name FROM offices WHERE id = ?', [owner.office.id]);
  assert.equal(row.name, 'مكتب الصلاحيات');

  assert.equal((await request('/office/team', { cookie: manager })).status, 200, 'managers manage the team (staff only)');
  assert.equal((await request('/office/billing', { cookie: manager })).status, 403);
  assert.equal((await request('/office/audit', { cookie: manager })).status, 200);
  for (const path of ['/office/team', '/office/billing', '/office/audit']) {
    assert.equal((await request(path, { cookie: owner.cookie })).status, 200, `owner ${path}`);
  }
});

test('the office member role wins over users.role inside /office', { skip }, async () => {
  const owner = await registerOffice(phone(15), { ...OFFICE_FORM, name: 'مكتب الأدوار' });
  // users.role says owner, but in this office the person is only staff.
  const cookie = await addMember(owner.office.id, phone(16), 'office_staff', { userRole: 'office_owner' });
  assert.equal((await request('/office/team', { cookie })).status, 403);
  assert.equal((await request('/office/billing', { cookie })).status, 403);
});

test('an inactive member gets a 403 page', { skip }, async () => {
  const owner = await registerOffice(phone(17), { ...OFFICE_FORM, name: 'مكتب الإيقاف' });
  const cookie = await addMember(owner.office.id, phone(18), 'office_staff', { active: 0 });
  const page = await request('/office', { cookie });
  assert.equal(page.status, 403);
  assert.match(page.text, /تم إيقاف حسابك في هذا المكتب/);
  assert.equal((await request('/office/contracts', { cookie })).status, 403);
});

test('landlords and tenants cannot enter the office area', { skip }, async () => {
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord'), (?, 'tenant')", [phone(19), phone(20)]);
  for (const p of [phone(19), phone(20)]) {
    const { cookie } = await login(p);
    assert.equal((await request('/office', { cookie })).status, 403);
    assert.equal((await request('/office/new', { cookie })).status, 302);
  }
});

// ------------------------------------------------------------ status rules

test('suspended and expired-trial offices are locked except billing and settings', { skip }, async () => {
  const owner = await registerOffice(phone(21), { ...OFFICE_FORM, name: 'مكتب القفل' });
  const staff = await addMember(owner.office.id, phone(22), 'office_staff');
  const setStatus = (status, trialSql = 'trial_ends_at') =>
    db.pool.query(`UPDATE offices SET status = ?, trial_ends_at = ${trialSql} WHERE id = ?`, [status, owner.office.id]);

  for (const [status, trialSql] of [['suspended', 'trial_ends_at'], ['trial', 'UTC_TIMESTAMP() - INTERVAL 1 MINUTE']]) {
    await setStatus(status, trialSql);
    for (const path of ['/office', '/office/contracts', '/office/team', '/office/audit']) {
      const page = await request(path, { cookie: owner.cookie });
      assert.equal(page.status, 402, `${status} ${path}`);
      assert.match(page.text, /اشتراكك منتهي/);
      assert.match(page.text, /href="\/office\/billing"/);
    }
    assert.equal((await request('/office/billing', { cookie: owner.cookie })).status, 200, `${status} billing open`);
    assert.equal((await request('/office/settings', { cookie: owner.cookie })).status, 200, `${status} settings open`);
    const save = await request('/office/settings', { method: 'POST', cookie: owner.cookie, form: { ...OFFICE_FORM, name: `مكتب القفل ${status}` } });
    assert.equal(save.status, 302, 'settings can still be saved');

    const staffPage = await request('/office', { cookie: staff });
    assert.equal(staffPage.status, 402);
    assert.match(staffPage.text, /تواصل مع مالك المكتب/);
  }

  // A trial with time left is open, and shows the days in the banner.
  await setStatus('trial', 'UTC_TIMESTAMP() + INTERVAL 3 DAY');
  const open = await request('/office', { cookie: owner.cookie });
  assert.equal(open.status, 200);
  assert.match(open.text, /تجربتك المجانية تنتهي بعد 3 يوم/);

  await setStatus('past_due');
  const pastDue = await request('/office', { cookie: owner.cookie });
  assert.equal(pastDue.status, 200);
  assert.match(pastDue.text, /office-banner--danger/);

  await setStatus('active');
  const active = await request('/office', { cookie: owner.cookie });
  assert.equal(active.status, 200);
  assert.ok(!active.text.includes('office-banner'), 'no banner when active');
});

// ------------------------------------------------------------ redirects and navigation

test('after login every role lands in its own area', { skip }, async () => {
  const owner = await registerOffice(phone(23), { ...OFFICE_FORM, name: 'مكتب التوجيه' });
  await addMember(owner.office.id, phone(24), 'office_manager');
  await addMember(owner.office.id, phone(25), 'office_staff');
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord'), (?, 'tenant')", [phone(26), phone(27)]);

  assert.equal((await login('966500000139')).location, '/platform');
  assert.equal((await login(phone(23))).location, '/office');
  assert.equal((await login(phone(24))).location, '/office');
  assert.equal((await login(phone(25))).location, '/office');
  assert.equal((await login(phone(26))).location, '/landlord');
  assert.equal((await login(phone(27))).location, '/tenant');
  assert.equal((await login(phone(28))).location, '/office/new', 'no role yet');
});

test('the sidebar shows only the items each role may open', { skip }, async () => {
  const owner = await registerOffice(phone(29), { ...OFFICE_FORM, name: 'مكتب القائمة' });
  const manager = await addMember(owner.office.id, phone(30), 'office_manager');
  const staff = await addMember(owner.office.id, phone(31), 'office_staff');
  const all = ['/office', '/office/contracts', '/office/landlords', '/office/units', '/office/tenants',
    '/office/payments', '/office/maintenance', '/office/listings', '/office/reports', '/office/messages',
    '/office/tasks', '/office/team', '/office/audit', '/office/settings', '/office/billing'];

  assert.deepEqual(navHrefs((await request('/office', { cookie: owner.cookie })).text), all);
  assert.deepEqual(
    navHrefs((await request('/office', { cookie: manager })).text),
    all.filter((h) => !['/office/billing'].includes(h)),
  );
  assert.deepEqual(navHrefs((await request('/office', { cookie: staff })).text), [
    '/office', '/office/contracts', '/office/landlords', '/office/units', '/office/tenants',
    '/office/payments', '/office/maintenance', '/office/messages', '/office/tasks', '/office/settings',
  ]);

  const page = await request('/office/payments', { cookie: staff });
  assert.match(page.text, /<a href="\/office\/payments" aria-current="page">/);
  assert.equal((page.text.match(/aria-current="page"/g) || []).length, 1);
});
