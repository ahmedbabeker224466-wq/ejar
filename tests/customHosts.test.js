'use strict';

// Serving an office's public page on its own domain (Prompt 24): host
// normalization, main hosts untouched, unknown hosts 404 (one cached lookup),
// the www redirect, the allow-list (page, own listings, inquiry, robots,
// sitemap) and the 302 of everything else to the main host, cross-office
// isolation, no session cookie on custom hosts, /health everywhere, requests
// that are not active (or offices that are not live) not served, the cache
// TTL and its invalidation, the per-IP lookup limit, rel=canonical on /<slug>,
// and the admin "فحص الدومين" check with a stub.
// Database parts run only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const customHosts = require('../services/customHosts');
const { hostResolver, NOT_FOUND_HTML } = require('../middleware/customHost');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000031NN. Domains: tch-*.com. Slugs: tch-*.
const phone = (n) => `9665000031${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const MAIN = 'aqdi-main.net';
const saved = {};
let db;
let httpApp;
let fx;
let A;
let B;
let listingA;
let listingB;
let requestA;

// ------------------------------------------------------------ pure

test('host normalization: lower-case, no port, no trailing dot, IPv6 brackets, junk refused', () => {
  const n = customHosts.normalizeHost;
  assert.equal(n('Example.COM:443'), 'example.com');
  assert.equal(n('shop.example.com.'), 'shop.example.com');
  assert.equal(n('[::1]:3000'), '::1');
  assert.equal(n('127.0.0.1:8080'), '127.0.0.1');
  for (const bad of ['', 'a b.com', 'evil.com:abc', 'evil.com:99999999', 'a..b.com', '-x.com', 'x.com/path', '[::1']) assert.equal(n(bad), null, bad);
});

test('main hosts: APP_URL, local hosts and ALLOWED_HOSTS; without APP_URL nothing is custom', () => {
  const env = { APP_URL: 'https://aqdi.phillote.com', ALLOWED_HOSTS: ' Temp.Server.net , other.example.org:8443 ' };
  for (const h of ['aqdi.phillote.com', 'localhost', '127.0.0.1', '::1', 'temp.server.net', 'other.example.org']) assert.equal(customHosts.classify(h, env), 'main', h);
  assert.equal(customHosts.classify('myoffice.sa', env), 'custom');
  assert.equal(customHosts.classify('www.aqdi.phillote.com', env), 'custom', 'only the exact platform host is main');
  assert.equal(customHosts.classify('myoffice.sa', {}), 'main', 'APP_URL unset: the feature is off');
});

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, location: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { if (typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; };
  res.type = () => res;
  res.send = (b) => { res.body = b; return res; };
  res.redirect = (c, l) => { res.statusCode = c; res.location = l; return res; };
  return res;
}

test('resolver: one query per unknown host, then the cache; lookups limited per IP', async () => {
  customHosts.clear();
  let queries = 0;
  const pool = { query: async () => { queries += 1; return [[]]; } };
  const resolve = hostResolver({ pool, env: { APP_URL: `https://${MAIN}` } });
  const call = async (host, ip = '10.0.0.1', path = '/') => {
    const req = { headers: { host }, path, originalUrl: path, ip };
    const res = fakeRes();
    let passed = false;
    await resolve(req, res, () => { passed = true; });
    return { req, res, passed };
  };
  const main = await call(MAIN);
  assert.equal(main.passed, true);
  assert.equal(queries, 0, 'a main host never touches the database');
  const first = await call('nobody-here.com');
  assert.equal(first.res.statusCode, 404);
  assert.equal(first.res.body, NOT_FOUND_HTML);
  assert.equal(queries, 1);
  await call('nobody-here.com');
  await call('www.nobody-here.com');
  assert.equal(queries, 1, 'the negative answer is cached (www shares it)');
  const health = await call('nobody-here.com', '10.0.0.1', '/health');
  assert.equal(health.passed, true, '/health answers on every host');
  assert.equal((await call('bad host')).res.statusCode, 404);

  let limited = null;
  for (let i = 0; i < 70 && !limited; i += 1) {
    const r = await call(`random-${i}.com`, '10.9.9.9');
    if (r.res.statusCode === 429) limited = i;
  }
  assert.equal(limited, 60, 'the 61st new host from one IP in a minute is refused');
  assert.equal((await call('random-200.com', '10.9.9.10')).res.statusCode, 404, 'another IP is not affected');
  customHosts.clear();
});

// ------------------------------------------------------------ database

/** A raw HTTP request (fetch cannot set the Host header). */
function raw(path, { host, method = 'GET', headers = {}, form = null } = {}) {
  const port = new URL(httpApp.base()).port;
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { Host: host, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'ALLOWED_HOSTS', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = `https://${MAIN}`;
  process.env.ALLOWED_HOSTS = 'alt-main.net';
  process.env.PLATFORM_ADMIN_PHONE = `0${phone(99).slice(3)}`;
  process.env.REQUIRE_ADMIN_2FA = 'false';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_listings, is_active, sort_order, custom_domain)
     VALUES ('test_hosts', 'اختبار النطاقات', 1, 1, NULL, NULL, 0, 141, 'included') ON DUPLICATE KEY UPDATE max_listings = NULL, custom_domain = 'included'`,
  );
  httpApp = createOfficeHttp(db);
  await httpApp.start();
  fx = createFixtures({ db, http: httpApp, phone, planCode: 'test_hosts' });
  A = await fx.office(1, 'تجربة-نطاق-أ', { units: 2 });
  B = await fx.office(2, 'تجربة-نطاق-ب', { units: 2 });
  listingA = await publish(A, 0);
  listingB = await publish(B, 0);
  for (const [o, slug] of [[A, 'tch-alpha'], [B, 'tch-beta']]) {
    await db.pool.query("UPDATE offices SET public_slug = ?, public_page_enabled = 1, status = 'active' WHERE id = ?", [slug, o.office.id]);
  }
  requestA = await activate(A, 'tch-a.com');
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES), { retries: 5 });
}

test.after(async () => {
  require('../services/domains').setProbe(null);
  customHosts.clear();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (httpApp) httpApp.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

async function publish(o, unitIndex) {
  await db.pool.query(
    `INSERT INTO listings (office_id, unit_id, title, description, price, currency, status, published_at, expires_at, unit_type, city, neighborhood, rooms, bathrooms, area_sqm, features)
     VALUES (?, ?, 'شقة للإيجار في حي الملقا، الرياض', 'وصف الإعلان العام', 36000, 'SAR', 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, 'apartment', 'الرياض', 'الملقا', 3, 2, 120, '[]')`,
    [o.office.id, o.units[unitIndex]],
  );
  return (await db.pool.query('SELECT id FROM listings WHERE unit_id = ?', [o.units[unitIndex]]))[0][0].id;
}

/** The admin's activation, as Prompt 23 stores it: an active request plus offices.custom_domain. */
async function activate(o, domain) {
  const [made] = await db.pool.query(
    "INSERT INTO office_domain_requests (office_id, type, domain, status, activated_at) VALUES (?, 'own', ?, 'active', UTC_TIMESTAMP())",
    [o.office.id, domain],
  );
  await db.pool.query('UPDATE offices SET custom_domain = ? WHERE id = ?', [domain, o.office.id]);
  customHosts.clear();
  return made.insertId;
}

const sessionCookie = (res) => [].concat(res.headers['set-cookie'] || []).find((c) => /aqdi_session|aqdi_login|aqdi_mfa/.test(c)) || null;

test('main hosts behave exactly as before', { skip }, async () => {
  for (const host of ['127.0.0.1', MAIN, 'alt-main.net', `${MAIN}:443`]) {
    const res = await raw('/', { host });
    assert.equal(res.status, 200, host);
    assert.equal(res.headers['x-aqdi-office-host'], undefined, host);
    assert.doesNotMatch(res.text, /تجربة-نطاق-أ/);
  }
  assert.equal((await raw('/login', { host: MAIN })).status, 200);
});

test('an unknown host answers a plain 404 and reveals nothing', { skip }, async () => {
  const res = await raw('/', { host: 'tch-unknown.com' });
  assert.equal(res.status, 404);
  assert.equal(res.text, NOT_FOUND_HTML);
  assert.equal(res.headers['x-aqdi-office-host'], undefined);
  assert.equal(sessionCookie(res), null);
  assert.equal((await raw('/login', { host: 'tch-unknown.com' })).status, 404, 'no redirect either');
  assert.equal((await raw('/health', { host: 'tch-unknown.com' })).status, 200, '/health on every host');
});

test('the office page on its own domain: canonical and og:url on the domain, header, no session cookie', { skip }, async () => {
  const res = await raw('/', { host: 'TCH-A.com', headers: { Cookie: 'aqdi_session=forged.token.value' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-aqdi-office-host'], 'tch-alpha');
  assert.match(res.text, /تجربة-نطاق-أ/);
  assert.match(res.text, /<link rel="canonical" href="https:\/\/tch-a\.com\/">/);
  assert.match(res.text, /<meta property="og:url" content="https:\/\/tch-a\.com\/">/);
  assert.match(res.text, new RegExp(`href="/listings/${listingA}"`));
  assert.doesNotMatch(res.text, new RegExp(`/listings/${listingB}"`), 'only this office\'s listings');
  assert.equal(sessionCookie(res), null, 'no session cookie is read, cleared or set');
  const health = await raw('/health', { host: 'tch-a.com' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).status, 'ok');
});

test('www is the same domain: 301 to the bare domain with the path', { skip }, async () => {
  const res = await raw('/listings/1?x=1', { host: 'www.tch-a.com' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://tch-a.com/listings/1?x=1');
});

test('allow-list: own listings and the inquiry form; another office\'s listing is 404', { skip }, async () => {
  const own = await raw(`/listings/${listingA}`, { host: 'tch-a.com' });
  assert.equal(own.status, 200);
  assert.match(own.text, new RegExp(`<link rel="canonical" href="https://tch-a\\.com/listings/${listingA}">`));
  assert.equal((await raw(`/listings/${listingB}`, { host: 'tch-a.com' })).status, 404);
  assert.equal((await raw(`/listings/${listingB}/inquiry`, { host: 'tch-a.com', method: 'POST', headers: { Origin: 'https://tch-a.com' }, form: { name: 'زائر', phone: '0555000111', message: 'مرحبا' } })).status, 404);

  const sent = await raw(`/listings/${listingA}/inquiry`, { host: 'tch-a.com', method: 'POST', headers: { Origin: 'https://tch-a.com' }, form: { name: 'زائر', phone: '0555000111', message: 'أريد التفاصيل' } });
  assert.equal(sent.status, 302, sent.text.slice(0, 200));
  assert.equal(sent.headers.location, `/listings/${listingA}?sent=1#inquiry`);
  const [[row]] = await db.pool.query('SELECT office_id FROM listing_inquiries WHERE listing_id = ? ORDER BY id DESC LIMIT 1', [listingA]);
  assert.equal(Number(row.office_id), A.office.id);
  const foreign = await raw(`/listings/${listingA}/inquiry`, { host: 'tch-a.com', method: 'POST', headers: { Origin: 'https://evil.example.net' }, form: { name: 'x', phone: '0555000111', message: 'y' } });
  assert.equal(foreign.status, 403, 'the same-origin check still refuses another site');
  assert.equal(sessionCookie(sent), null);
});

test('everything else answers 302 to the same path on the main host', { skip }, async () => {
  for (const path of ['/login', '/register', '/office', '/office/settings', '/admin', '/admin/domains', '/pricing', '/blog', '/listings', '/tch-beta', `/listings/${listingA}/report`, '/notifications?x=1']) {
    const res = await raw(path, { host: 'tch-a.com' });
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.location, `https://${MAIN}${path}`, path);
    assert.equal(sessionCookie(res), null, path);
  }
  const post = await raw('/login', { host: 'tch-a.com', method: 'POST', headers: { Origin: 'https://tch-a.com' }, form: { phone: '0555000111' } });
  assert.equal(post.status, 302);
  assert.equal(post.headers.location, `https://${MAIN}/login`);
});

test('robots.txt and sitemap.xml are scoped to the office, with absolute URLs on its domain', { skip }, async () => {
  const robots = await raw('/robots.txt', { host: 'tch-a.com' });
  assert.equal(robots.status, 200);
  assert.match(robots.text, /Sitemap: https:\/\/tch-a\.com\/sitemap\.xml/);
  assert.doesNotMatch(robots.text, new RegExp(MAIN));
  const map = await raw('/sitemap.xml', { host: 'tch-a.com' });
  assert.equal(map.status, 200);
  assert.match(map.text, /<loc>https:\/\/tch-a\.com\/<\/loc>/);
  assert.match(map.text, new RegExp(`<loc>https://tch-a\\.com/listings/${listingA}</loc>`));
  assert.doesNotMatch(map.text, new RegExp(`/listings/${listingB}<`));
  assert.doesNotMatch(map.text, new RegExp(MAIN));
  assert.doesNotMatch(map.text, /\/pricing|\/blog/);
});

test('the /<slug> page on the main host points rel=canonical at the live custom domain', { skip }, async () => {
  const res = await raw('/tch-alpha', { host: '127.0.0.1' });
  assert.equal(res.status, 200);
  assert.match(res.text, /<link rel="canonical" href="https:\/\/tch-a\.com\/">/);
  const other = await raw('/tch-beta', { host: '127.0.0.1' });
  assert.match(other.text, new RegExp(`<link rel="canonical" href="https://${MAIN}/tch-beta">`));
});

test('not served: request not active (latest one), page off, suspended, expired trial', { skip }, async () => {
  const check = async (setup, undo, label) => {
    await setup();
    customHosts.clear();
    assert.equal((await raw('/', { host: 'tch-a.com' })).status, 404, label);
    await undo();
    customHosts.clear();
    assert.equal((await raw('/', { host: 'tch-a.com' })).status, 200, `${label} (restored)`);
  };
  for (const status of ['rejected', 'cancelled', 'awaiting_dns']) {
    await check(
      () => db.pool.query('UPDATE office_domain_requests SET status = ? WHERE id = ?', [status, requestA]),
      () => db.pool.query("UPDATE office_domain_requests SET status = 'active' WHERE id = ?", [requestA]),
      `request ${status}`,
    );
  }
  let newer;
  await check(
    async () => { [newer] = await db.pool.query("INSERT INTO office_domain_requests (office_id, type, domain, status) VALUES (?, 'own', 'tch-a2.com', 'pending_setup')", [A.office.id]); },
    () => db.pool.query('DELETE FROM office_domain_requests WHERE id = ?', [newer.insertId]),
    'a newer request that is not active',
  );
  await check(
    () => db.pool.query('UPDATE offices SET public_page_enabled = 0 WHERE id = ?', [A.office.id]),
    () => db.pool.query('UPDATE offices SET public_page_enabled = 1 WHERE id = ?', [A.office.id]),
    'page switched off',
  );
  await check(
    () => db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [A.office.id]),
    () => db.pool.query("UPDATE offices SET status = 'active' WHERE id = ?", [A.office.id]),
    'suspended',
  );
  await check(
    () => db.pool.query("UPDATE offices SET status = 'trial', trial_ends_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?", [A.office.id]),
    () => db.pool.query("UPDATE offices SET status = 'active' WHERE id = ?", [A.office.id]),
    'expired trial',
  );
});

test('cache: 60 s for a found host, 30 s for a missing one; cleared by the admin update', { skip }, async () => {
  customHosts.clear();
  const t = 1_000_000;
  assert.ok(await customHosts.lookup(db.pool, 'tch-a.com', { clock: t }));
  assert.equal(await customHosts.lookup(db.pool, 'tch-none.com', { clock: t }), null);
  assert.equal(customHosts.cached('tch-a.com', t + 59_000).hit, true);
  assert.equal(customHosts.cached('tch-none.com', t + 29_000).hit, true);
  assert.equal(customHosts.cached('tch-none.com', t + 31_000).hit, false, 'missing answers expire after 30 s');
  assert.equal(customHosts.cached('tch-a.com', t + 61_000).hit, false, 'found answers expire after 60 s');

  // A change made elsewhere is picked up when the entry expires; an admin change clears at once.
  customHosts.clear();
  assert.equal((await raw('/', { host: 'tch-a.com' })).status, 200);
  await db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [A.office.id]);
  assert.equal((await raw('/', { host: 'tch-a.com' })).status, 200, 'still cached (at most 60 s)');
  const [moved] = await db.pool.query("INSERT INTO office_domain_requests (office_id, type, domain, status) VALUES (?, 'own', 'tch-b.com', 'pending_setup')", [B.office.id]);
  const domains = require('../services/domains');
  const result = await domains.adminUpdate(db.pool, { id: moved.insertId, adminId: null, body: { status: 'awaiting_dns' }, reason: 'اختبار' });
  assert.equal(result.ok, true);
  assert.equal(customHosts.cacheSize(), 0, 'the admin update cleared the cache');
  assert.equal((await raw('/', { host: 'tch-a.com' })).status, 404);
  await db.pool.query("UPDATE offices SET status = 'active' WHERE id = ?", [A.office.id]);
  await db.pool.query('DELETE FROM office_domain_requests WHERE id = ?', [moved.insertId]);
  customHosts.clear();

  for (let i = 0; i < customHosts.MAX_ENTRIES + 5; i += 1) await customHosts.lookup({ query: async () => [[]] }, `tch-many-${i}.com`, { clock: t });
  assert.equal(customHosts.cacheSize(), customHosts.MAX_ENTRIES, 'never more than 1000 entries');
  customHosts.clear();
});

test('admin "فحص الدومين": DNS and HTTPS answer, and whether it is this office on this app', { skip }, async () => {
  const admin = await httpApp.login(phone(99));
  const domains = require('../services/domains');
  domains.setProbe({
    resolve4: async () => ['203.0.113.7'],
    resolveCname: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); },
    head: async (url) => (url === 'https://tch-a.com/' ? { status: 200, header: 'tch-alpha' } : { error: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }),
  });
  const detail = await httpApp.request(`/admin/domains/${requestA}`, { cookie: admin.cookie });
  assert.match(detail.text, /الدومين الفعّال[\s\S]*فحص الدومين/);
  const probe = await httpApp.request(`/admin/domains/${requestA}/probe`, { method: 'POST', cookie: admin.cookie });
  assert.equal(probe.status, 200);
  assert.match(probe.text, /203\.0\.113\.7/);
  assert.match(probe.text, /HTTP 200/);
  assert.match(probe.text, /نعم، صفحة هذا المكتب/);

  domains.setProbe({ resolve4: async () => [], resolveCname: async () => [], head: async () => ({ error: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }) });
  const bad = await httpApp.request(`/admin/domains/${requestA}/probe`, { method: 'POST', cookie: admin.cookie });
  assert.match(bad.text, /CERT_HAS_EXPIRED: certificate has expired/);
  assert.doesNotMatch(bad.text, /نعم، صفحة هذا المكتب/);
  domains.setProbe(null);

  assert.notEqual((await httpApp.request(`/admin/domains/${requestA}/probe`, { method: 'POST', cookie: A.cookie })).status, 200, 'office owners cannot run it');
});
