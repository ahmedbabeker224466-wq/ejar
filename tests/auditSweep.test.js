'use strict';

// Final security sweep against the real app and a real database:
// every route against anonymous and wrong-role visitors, cross-site posts,
// security headers, cookie flags, rate limits, path traversal, SQL injection
// payloads and HTML escaping of user text. Runs only when TEST_DB_NAME is set.

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

// Every phone this file signs in with: 9665000019NN. NN = 00 is the platform admin.
const phone = (n) => `9665000019${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 40 }, (_, i) => phone(i));
const XSS = ['<script>alert(7)</script>', '<img src=x onerror=alert(7)>'];
const saved = {};
let db;
let http;
let fx;
let app;
let uploadDir;
let owner;
let staff;
let tenant;
let landlord;
let admin;
let contractId;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR', 'CRON_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500001900';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'audit-cron-secret-0123456789';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-sweep-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, features, is_public, is_active, sort_order)
     VALUES ('swp_plan', 'اختبار فحص', 1, 10, '{"listings":true}', 0, 1, 531)
     ON DUPLICATE KEY UPDATE features = VALUES(features)`,
  );
  http = createOfficeHttp(db);
  await http.start();
  app = require('../app');
  fx = createFixtures({ db, http, phone, planCode: 'swp_plan' });
  owner = await fx.office(1, 'تجربة-فحص-1', { landlords: 1, units: 3 });
  staff = { cookie: await http.addMember(owner.office.id, phone(2), 'office_staff') };
  contractId = await fx.contract(owner);
  tenant = await fx.tenantOf(contractId, 3);
  landlord = await fx.landlordOf(owner, 4);
  admin = await http.login(phone(0));
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'swp\\_%'");
  await db.pool.query("DELETE FROM blog_posts WHERE slug LIKE 'swp-%'");
  await db.pool.query("DELETE FROM contact_messages WHERE name LIKE 'فحص-%'");
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

// ------------------------------------------------------------ route table

function routeTable() {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: p });
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app._router.stack);
  return out;
}

// Routes that answer a visitor who is not signed in, by design.
const PUBLIC = [
  /^GET \/(health|health\/detail|features|pricing|about|privacy|terms|disclaimer|contact|blog|blog\/feed\.xml|blog\/:slug|blog\/:slug\/cover|sitemap\.xml|robots\.txt|listings|listings\/:id|listings\/photos\/:id\/:variant|listings\/:id\/report|login|register|join|login\/verify|login\/2fa|login\/2fa\/setup|logout)?$/,
  /^POST \/(contact|listings\/:id\/inquiry|listings\/:id\/report|login|login\/verify|login\/resend|login\/2fa|login\/2fa\/setup|register|webhooks\/moyasar|webhooks\/telegram\/:secret|cron\/run\/:job)$/,
];
const isPublic = (r) => PUBLIC.some((re) => re.test(`${r.method} ${r.path}`));
const fill = (p) => p.replace(/:(\w+)/g, (m, name) => (/token|slug|secret|variant/.test(name) ? 'x' : '1'));
const isWrite = (r) => r.method !== 'GET';

test('the route table is large and every route is either public by design or protected', { skip }, async () => {
  const routes = routeTable();
  assert.ok(routes.length > 200, `only ${routes.length} routes found`);
  const hidden = routes.filter((r) => !isPublic(r));
  assert.ok(hidden.length > 150);
  for (const r of hidden) {
    const res = await http.request(fill(r.path), { method: r.method, form: isWrite(r) ? { x: '1' } : undefined });
    assert.ok([301, 302, 401, 403, 404].includes(res.status), `${r.method} ${r.path} answered ${res.status} to a visitor`);
    if (res.status === 302) assert.match(res.location, /^\/(login|register|join)/, `${r.method} ${r.path} redirects to ${res.location}`);
  }
});

test('tenants and landlords get nothing from /office and /admin, staff nothing from owner-only pages', { skip }, async () => {
  const routes = routeTable().filter((r) => /^\/(office|admin|platform)(\/|$)/.test(r.path));
  assert.ok(routes.length > 150);
  for (const who of [tenant, landlord]) {
    for (const r of routes) {
      const res = await http.request(fill(r.path), { method: r.method, cookie: who.cookie, form: isWrite(r) ? { x: '1' } : undefined });
      assert.ok([302, 403, 404].includes(res.status), `${r.method} ${r.path} answered ${res.status}`);
      if (res.status === 302) assert.doesNotMatch(res.location, /^\/(office|admin)\//, `${r.method} ${r.path} -> ${res.location}`);
    }
  }
  // An office member is no platform admin.
  for (const who of [owner, staff]) {
    for (const r of routes.filter((x) => /^\/(admin|platform)/.test(x.path))) {
      const res = await http.request(fill(r.path), { method: r.method, cookie: who.cookie, form: isWrite(r) ? { x: '1' } : undefined });
      assert.ok([302, 403, 404].includes(res.status), `${r.method} ${r.path} answered ${res.status} to an office member`);
    }
  }
  // Staff cannot reach owner or manager pages.
  for (const p of ['/office/team', '/office/billing', '/office/audit', '/office/reports', '/office/settings/reminders']) {
    const res = await http.request(p, { cookie: staff.cookie });
    assert.ok([403, 404].includes(res.status), `${p} answered ${res.status} to staff`);
  }
  for (const p of ['/office/team', '/office/billing/orders']) {
    const res = await http.request(p, { method: 'POST', cookie: staff.cookie, form: { x: '1' } });
    assert.ok([403, 404].includes(res.status), `${p} answered ${res.status} to staff`);
  }
});

test('a cross-site state-changing request is refused everywhere', { skip }, async () => {
  const writes = routeTable().filter((r) => isWrite(r) && !/^\/(webhooks|cron)\//.test(r.path));
  assert.ok(writes.length > 100);
  for (const cookie of [owner.cookie, admin.cookie]) {
    for (const r of writes) {
      const response = await fetch(`${http.base()}${fill(r.path)}`, {
        method: r.method,
        headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'x=1',
        redirect: 'manual',
      });
      assert.equal(response.status, 403, `${r.method} ${r.path} accepted a foreign Origin`);
    }
  }
  // A foreign Referer without Origin is refused too.
  const response = await fetch(`${http.base()}/contact`, { method: 'POST', headers: { Referer: 'https://evil.example/x', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(response.status, 403);
});

// ------------------------------------------------------------ headers and cookies

test('security headers on public and private pages, no X-Powered-By', { skip }, async () => {
  for (const [p, cookie] of [['/', null], ['/listings', null], ['/login', null], ['/office', owner.cookie], ['/tenant', tenant.cookie]]) {
    const res = await fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.match(csp, /object-src 'none'/, p);
    assert.doesNotMatch(csp, /unsafe-inline.*script-src|script-src[^;]*unsafe-inline/, p);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/, p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('x-powered-by'), null, p);
    assert.ok(res.headers.get('strict-transport-security'), p);
    await res.arrayBuffer();
  }
  // Private pages are never cached.
  for (const [p, cookie] of [['/office', owner.cookie], ['/tenant', tenant.cookie], ['/login', null]]) {
    const res = await fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    assert.match(res.headers.get('cache-control') || '', /no-store/, p);
    await res.arrayBuffer();
  }
});

test('session cookies are HttpOnly, SameSite and Secure in production', { skip }, async () => {
  const auth = require('../services/auth');
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const prod = auth.cookieOptions(3600);
    assert.equal(prod.httpOnly, true);
    assert.equal(prod.secure, true);
    assert.equal(prod.sameSite, 'lax');
    assert.equal(prod.path, '/');
  } finally {
    process.env.NODE_ENV = before;
  }
  // The cookie a real login sets carries the flags.
  const { hashCode } = require('../services/otp');
  await db.pool.query('DELETE FROM otp_codes WHERE phone = ?', [phone(9)]);
  await db.pool.query("INSERT INTO otp_codes (phone, code_hash, purpose, expires_at) VALUES (?, ?, 'login', UTC_TIMESTAMP() + INTERVAL 5 MINUTE)", [phone(9), hashCode(phone(9), '123456')]);
  const step = auth.signStepToken({ phone: phone(9), sentAt: Date.now() }, 'login-phone', 600);
  const res = await http.request('/login/verify', { method: 'POST', cookie: `aqdi_login=${step}`, form: { code: '123456' } });
  const cookie = res.response.headers.getSetCookie().find((c) => c.startsWith('aqdi_session='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

// ------------------------------------------------------------ rate limits

test('rate limits answer 429: OTP request, join code, public inquiry, contact form', { skip }, async () => {
  const site = require('../routes/site');
  const pubListings = require('../routes/publicListings');
  const joins = require('../services/joins');
  for (const l of Object.values({ ...site.limiters, ...pubListings.limiters })) l.counter.reset();

  // Contact form: the sixth post within an hour from one address.
  const codes = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await http.request('/contact', { method: 'POST', form: { name: `فحص-${i}`, message: 'رسالة تجريبية طويلة بما يكفي', phone: '0555000111', website: '' } });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `contact: ${codes}`);
  assert.ok(codes.slice(0, 3).every((c) => c !== 429));

  // Inquiries: limited per address even for an unknown listing id (counted before the lookup).
  const inq = [];
  for (let i = 0; i < 12; i += 1) inq.push((await http.request('/listings/999999/inquiry', { method: 'POST', form: { name: 'x', phone: '0555000111', message: 'مرحبا' } })).status);
  assert.ok(inq.includes(429), `inquiry: ${inq}`);

  // OTP: repeated code requests for one phone are stopped.
  const otp = [];
  for (let i = 0; i < 12; i += 1) otp.push((await http.request('/login', { method: 'POST', form: { phone: '0500001939' } })).status);
  assert.ok(otp.includes(429), `otp: ${otp}`);

  // Join: 5 attempts per user, then the guard answers with the limit message.
  const user = await http.userByPhone(phone(3));
  joins.joinGuard.reset();
  let limited = false;
  for (let i = 0; i < 8; i += 1) {
    const r = await joins.joinWithCode(db.pool, { userId: user.id, code: 'ABCDEFGH', ip: '203.0.113.9' });
    if (r.reason === 'rate_limited' || r.error === 'rate_limited') limited = true;
  }
  joins.joinGuard.reset();
  if (!limited) {
    // The guard may sit in the route: use the HTTP form with the tenant's session.
    const res = [];
    for (let i = 0; i < 8; i += 1) res.push((await http.request('/join', { method: 'POST', cookie: tenant.cookie, form: { code: 'ABCDEFGH' } })).status);
    assert.ok(res.includes(429), `join: ${res}`);
  }
  for (const l of Object.values({ ...site.limiters, ...pubListings.limiters })) l.counter.reset();
  joins.joinGuard.reset();
});

// ------------------------------------------------------------ path traversal

test('file routes cannot be walked out of their folder', { skip }, async () => {
  const secret = path.join(os.tmpdir(), 'aqdi-sweep-secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET-FILE');
  try {
    const attacks = [
      '/maintenance/photos/..%2f..%2fetc%2fpasswd', '/maintenance/photos/../../etc/passwd', '/maintenance/photos/1%00.jpg',
      '/listings/photos/..%2f..%2fetc%2fpasswd/full', '/listings/photos/1/..%2f..%2fx', '/listings/photos/1/%2e%2e',
      '/blog/..%2f..%2fetc%2fpasswd/cover', '/blog/%2e%2e/cover',
      '/css/..%2f..%2fpackage.json', '/..%2f..%2f.env', '/%2e%2e/%2e%2e/.env', '/css/..%5c..%5cpackage.json', '/.env', '/.git/config',
      '/office/billing/receipts/..%2f..%2fx', '/office/contracts/..%2f..%2fx/receipt', '/office/listings/1/photos/..%2fx',
    ];
    for (const cookie of [owner.cookie, tenant.cookie, null]) {
      for (const p of attacks) {
        const res = await fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
        const body = await res.text();
        assert.notEqual(res.status, 200, `${p} answered 200`);
        assert.ok(res.status < 500, `${p} answered ${res.status}`);
        assert.doesNotMatch(body, /root:|TOP-SECRET|JWT_SECRET|"dependencies"/, p);
      }
    }
  } finally {
    fs.rmSync(secret, { force: true });
  }
});

// ------------------------------------------------------------ SQL injection

test('SQL injection payloads in search and filter parameters change nothing', { skip }, async () => {
  const payloads = ["' OR '1'='1", "'; DROP TABLE contracts; --", "1 UNION SELECT phone,2,3 FROM users --", "' AND SLEEP(4) -- ", '%', '_', '\\', "1' OR 1=1#", '{"$ne":1}', 'q[]=1'];
  const lists = [
    ['/office/contracts', 'q'], ['/office/contracts', 'landlord'], ['/office/contracts', 'stage'], ['/office/contracts', 'sort'],
    ['/office/landlords', 'q'], ['/office/landlords', 'status'], ['/office/units', 'q'], ['/office/units', 'building'], ['/office/units', 'status'],
    ['/office/units', 'type'], ['/office/payments', 'q'], ['/office/payments', 'landlord'], ['/office/listings', 'status'],
    ['/office/tenants', 'q'], ['/office/maintenance', 'status'], ['/office/audit', 'action'],
  ];
  // Counted for this file's own rows only: other test files write to the same database in parallel.
  const mine = [owner.office.id];
  const [[{ contracts }]] = await db.pool.query('SELECT COUNT(*) AS contracts FROM contracts WHERE office_id = ?', mine);
  const [[{ users }]] = await db.pool.query(`SELECT COUNT(*) AS users FROM users WHERE phone IN (${PHONES.map(() => '?').join(',')})`, PHONES);
  for (const [p, key] of lists) {
    for (const payload of payloads) {
      const started = Date.now();
      const res = await http.request(`${p}?${key}=${encodeURIComponent(payload)}`, { cookie: owner.cookie });
      assert.ok(res.status < 500, `${p}?${key}=${payload} answered ${res.status}`);
      assert.ok(Date.now() - started < 3500, `${p}?${key} took too long (SLEEP executed?)`);
      assert.doesNotMatch(res.text, /ER_[A-Z_]+|You have an error in your SQL|SQLSTATE/, `${p}?${key}`);
    }
  }
  for (const [p, key] of [['/listings', 'q'], ['/listings', 'city'], ['/listings', 'neighborhood'], ['/listings', 'type'], ['/listings', 'min'], ['/listings', 'max'], ['/listings', 'rooms'], ['/listings', 'page'], ['/blog', 'page']]) {
    for (const payload of payloads) {
      const started = Date.now();
      const res = await http.request(`${p}?${key}=${encodeURIComponent(payload)}`);
      assert.ok(res.status < 500, `${p}?${key}=${payload} answered ${res.status}`);
      assert.ok(Date.now() - started < 3500, `${p}?${key} took too long`);
      assert.doesNotMatch(res.text, /ER_[A-Z_]+|SQLSTATE/, `${p}?${key}`);
    }
  }
  for (const [p, key] of [['/admin/offices', 'q'], ['/admin/offices', 'status'], ['/admin/audit', 'action'], ['/admin/audit', 'actor'], ['/admin/audit', 'office'], ['/admin/orders', 'status'], ['/admin/reports', 'status']]) {
    for (const payload of payloads) {
      const res = await http.request(`${p}?${key}=${encodeURIComponent(payload)}`, { cookie: admin.cookie });
      assert.ok(res.status < 500, `${p}?${key}=${payload} answered ${res.status}`);
      assert.doesNotMatch(res.text, /ER_[A-Z_]+|SQLSTATE/, `${p}?${key}`);
    }
  }
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS c FROM contracts WHERE office_id = ?', mine))[0][0].c), Number(contracts));
  assert.equal(Number((await db.pool.query(`SELECT COUNT(*) AS c FROM users WHERE phone IN (${PHONES.map(() => '?').join(',')})`, PHONES))[0][0].c), Number(users));
  // A quote in the search box finds nothing rather than everything.
  const res = await http.request(`/office/landlords?q=${encodeURIComponent("' OR '1'='1")}`, { cookie: owner.cookie });
  assert.doesNotMatch(res.text, /مالك 1 تجربة-فحص-1/);
});

// ------------------------------------------------------------ HTML escaping

test('user text with script payloads is escaped on every page that shows it', { skip }, async () => {
  const [x1, x2] = XSS;
  const mark = (label) => `${label}${x1}${x2}`;
  const o = owner.office.id;
  const unitId = owner.units[1];
  const lid = owner.landlordId;
  await db.pool.query('UPDATE offices SET name = ?, phone = ? WHERE id = ?', [mark('م'), '0112345678', o]);
  await db.pool.query('UPDATE landlords SET label = ?, notes = ? WHERE id = ? AND office_id = ?', [mark('ل'), mark('ن'), lid, o]);
  await db.pool.query('UPDATE units SET label = ?, notes = ? WHERE id = ? AND office_id = ?', [mark('و'), mark('ن'), unitId, o]);
  const [bres] = await db.pool.query('INSERT INTO buildings (office_id, landlord_id, name, city, district, notes) VALUES (?, ?, ?, ?, ?, ?)', [o, lid, mark('ب'), 'جدة', mark('ح'), mark('ن')]);
  await db.pool.query('UPDATE contracts SET tenant_label = ? WHERE id = ? AND office_id = ?', [mark('ع'), contractId, o]);
  await db.pool.query('UPDATE plans SET name_ar = ? WHERE code = ?', [mark('خ'), 'swp_plan']);
  await db.pool.query("INSERT INTO office_tasks (office_id, title, description, status, created_by) SELECT ?, ?, ?, 'todo', id FROM users WHERE phone = ?", [o, mark('م'), mark('و'), phone(1)]).catch(() => {});

  // A listing for the second unit, published directly, with hostile text.
  await db.pool.query(
    `INSERT INTO listings (office_id, unit_id, title, description, price, currency, status, published_at, expires_at, unit_type, city, neighborhood, rooms, bathrooms, area_sqm, features)
     VALUES (?, ?, ?, ?, 36000, 'SAR', 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, 'apartment', 'الرياض', 'الملقا', 3, 2, 120, '[]')`,
    [o, owner.units[2], mark('ع'), mark('و')],
  );
  const [[listing]] = await db.pool.query('SELECT id FROM listings WHERE unit_id = ?', [owner.units[2]]);
  await db.pool.query('INSERT INTO listing_inquiries (listing_id, office_id, name, phone, message) VALUES (?, ?, ?, ?, ?)', [listing.id, o, mark('س'), '0555000222', mark('ر')]);
  await db.pool.query("INSERT INTO listing_reports (listing_id, reason, note) VALUES (?, 'other', ?)", [listing.id, mark('ب')]);
  await db.pool.query('INSERT INTO contact_messages (name, phone, email, message) VALUES (?, ?, ?, ?)', [mark('فحص-'), '0555000333', 'a@example.com', mark('ر')]);
  await db.pool.query(
    "INSERT INTO blog_posts (slug, title_ar, excerpt_ar, body_ar, status, published_at) VALUES ('swp-xss', ?, ?, ?, 'published', UTC_TIMESTAMP() - INTERVAL 1 DAY)",
    [mark('ع'), mark('م'), `${x1}\n\n${x2}\n\n[رابط](javascript:alert(7))\n\n**غامق**`],
  );
  await db.pool.query("INSERT INTO audit_logs (office_id, actor_id, action, entity_type, entity_id, after_json, ip) VALUES (?, NULL, 'admin.test', 'x', 1, ?, '127.0.0.1')", [o, JSON.stringify({ reason: mark('س') })]);
  const platformSettings = require('../services/platformSettings');
  const bannerBefore = platformSettings.bannerNow();
  const settingsSave = platformSettings.save && platformSettings.save.length >= 0;

  const pages = [
    ['/office', owner.cookie], ['/office/landlords', owner.cookie], [`/office/landlords/${lid}`, owner.cookie], [`/office/landlords/${lid}/edit`, owner.cookie],
    ['/office/units', owner.cookie], ['/office/units?tab=buildings', owner.cookie], [`/office/units/${unitId}`, owner.cookie], [`/office/units/${unitId}/edit`, owner.cookie],
    [`/office/units/buildings/${bres.insertId}/edit`, owner.cookie], ['/office/contracts', owner.cookie], [`/office/contracts/${contractId}`, owner.cookie],
    [`/office/contracts/${contractId}/edit`, owner.cookie], ['/office/tenants', owner.cookie], ['/office/payments', owner.cookie], ['/office/listings', owner.cookie],
    [`/office/listings/${listing.id}`, owner.cookie], ['/office/tasks', owner.cookie], ['/office/audit', owner.cookie], ['/office/team', owner.cookie],
    ['/office/settings', owner.cookie], ['/office/billing', owner.cookie], ['/office/reports', owner.cookie],
    ['/landlord', landlord.cookie], [`/landlord/contracts/${contractId}`, landlord.cookie], ['/tenant', tenant.cookie],
    ['/listings', null], [`/listings/${listing.id}`, null], [`/listings/${listing.id}/report`, null], ['/blog', null], ['/blog/swp-xss', null], ['/blog/feed.xml', null],
    ['/', null], ['/pricing', null], ['/features', null], ['/about', null], ['/contact', null], ['/privacy', null], ['/terms', null], ['/disclaimer', null],
    ['/admin', admin.cookie], ['/admin/offices', admin.cookie], [`/admin/offices/${o}`, admin.cookie], ['/admin/plans', admin.cookie], ['/admin/orders', admin.cookie],
    ['/admin/audit', admin.cookie], ['/admin/reports', admin.cookie], ['/admin/messages', admin.cookie], ['/admin/blog', admin.cookie], ['/admin/settings', admin.cookie],
    ['/admin/promos', admin.cookie], ['/admin/transfers', admin.cookie],
  ];
  let withPayload = 0;
  for (const [p, cookie] of pages) {
    const res = await fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    const body = await res.text();
    assert.ok(res.status < 500, `${p} answered ${res.status}`);
    assert.ok(!body.includes('<script>alert(7)'), `${p} shows a raw <script> payload`);
    assert.ok(!body.includes('<img src=x onerror'), `${p} shows a raw <img onerror> payload`);
    assert.ok(!/href="javascript:/i.test(body), `${p} has a javascript: link`);
    if (body.includes('&lt;script&gt;alert(7)') || body.includes('&lt;img src=x onerror')) withPayload += 1;
  }
  assert.ok(withPayload >= 25, `the payload appeared (escaped) on only ${withPayload} pages: the matrix is not testing what it should`);
  void bannerBefore;
  void settingsSave;
  void bres;
});

test('the admin banner, seller details and analytics snippet are escaped or refused', { skip }, async () => {
  const platformSettings = require('../services/platformSettings');
  const analytics = require('../services/analytics');
  const [x1, x2] = XSS;
  const K = platformSettings.KEYS;
  const keys = [K.bannerMessage, K.sellerLegalName].filter(Boolean);
  const previous = {};
  for (const k of keys) previous[k] = (await db.pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [k]))[0][0]?.setting_value || '';
  try {
    const values = { [K.bannerMessage]: `${x1}${x2}` };
    if (K.sellerLegalName) values[K.sellerLegalName] = `${x1}${x2}`;
    await platformSettings.save(db.pool, values);
    for (const p of ['/pricing', '/privacy', '/', '/office/billing']) {
      const html = (await http.request(p, { cookie: p === '/office/billing' ? owner.cookie : undefined })).text;
      assert.ok(!html.includes('<script>alert(7)'), p);
      assert.ok(!html.includes('<img src=x onerror'), p);
    }
  } finally {
    await platformSettings.save(db.pool, previous);
  }
  // The analytics snippet is rebuilt from an allowlist: inline code, unknown hosts and event handlers are refused.
  for (const bad of ['<script>alert(7)</script>', '<script src="https://evil.example/x.js"></script>', '<script src="javascript:alert(7)"></script>',
    '<img src=x onerror=alert(7)>', '<script src="https://plausible.io/js/x.js" onload="alert(7)"></script>']) {
    const out = analytics.sanitizeSnippet(bad);
    assert.ok(!out.ok || !/onload|onerror|evil|alert|javascript/i.test(out.snippet), bad);
  }
});

// ------------------------------------------------------------ schema self-check

test('the schema self-check reports every table, and the count matches the definitions and CLAUDE.md', { skip }, async () => {
  const { TABLES } = require('../database/schema');
  const res = await fetch(`${http.base()}/health/detail`, { headers: { 'X-Cron-Secret': process.env.CRON_SECRET } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.live.schema.found, TABLES.length);
  assert.equal(body.live.schema.total, TABLES.length);
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  const listed = /# Fixed table names\n([^\n]+)/.exec(claude)[1].split(',').map((t) => t.trim());
  assert.equal(listed.length, TABLES.length, 'CLAUDE.md "Fixed table names" must list every table');
  // Without the secret the details stay private.
  assert.equal((await fetch(`${http.base()}/health/detail`)).status, 403);
});
