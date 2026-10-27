'use strict';

// The office public link /<slug> against real MySQL: automatic slug, settings
// (role access, validation, uniqueness incl. history, change limit, audit),
// redirects, what the public page shows and hides, 404 for unknown, disabled
// and suspended offices, sitemap, and the start-up backfill.
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000027NN.
const phone = (n) => `9665000027${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
// Slugs this file chooses (all start with "tpl-", cleaned up before and after).
const SLUG = (s) => `tpl-${s}`;
const saved = {};
let db;
let http;
let fx;
let officeLink;

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
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_members, max_photos, max_listings, is_active, sort_order)
     VALUES ('test_link', 'اختبار الرابط', 1, 1, NULL, NULL, NULL, NULL, NULL, 0, 131)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, max_listings = NULL, is_active = 0`,
  );
  officeLink = require('../services/officeLink');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_link' });
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM office_slug_history WHERE slug LIKE 'tpl-%'");
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

const get = (path, cookie) => http.request(path, { cookie });
const post = (path, cookie, form) => http.request(path, { method: 'POST', cookie, form });
const officeRow = async (id) => (await db.pool.query('SELECT * FROM offices WHERE id = ?', [id]))[0][0];

async function publish(o, unitIndex, { title = 'شقة للإيجار في حي الملقا، الرياض' } = {}) {
  await db.pool.query(
    `INSERT INTO listings (office_id, unit_id, title, description, price, currency, status, published_at, expires_at, unit_type, city, neighborhood, rooms, bathrooms, area_sqm, features)
     VALUES (?, ?, ?, 'وصف الإعلان العام', 36000, 'SAR', 'published', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 30 DAY, 'apartment', 'الرياض', 'الملقا', 3, 2, 120, '[]')`,
    [o.office.id, o.units[unitIndex], title],
  );
  return (await db.pool.query('SELECT id FROM listings WHERE unit_id = ?', [o.units[unitIndex]]))[0][0].id;
}

async function enable(o, slug, description = '') {
  assert.equal((await post('/office/settings/link', o.cookie, { slug })).status, 302);
  assert.equal((await post('/office/settings/public-page', o.cookie, { enabled: '1', description })).status, 302);
}

// ------------------------------------------------------------ new office and settings

test('a new office gets office-xxxxxx with the page switched off; the link answers 404 until it is switched on', { skip }, async () => {
  const o = await fx.office(1, 'تجربة-رابط-جديد', { units: 1 });
  const row = await officeRow(o.office.id);
  assert.match(row.public_slug, /^office-[a-z0-9]{6}$/);
  assert.equal(Number(row.public_page_enabled), 0);

  const hidden = await get(`/${row.public_slug}`);
  const unknown = await get('/tpl-no-such-office');
  assert.equal(hidden.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(hidden.text.replace(/office-[a-z0-9]{6}/g, ''), unknown.text.replace(/tpl-no-such-office/g, ''), 'a hidden page looks exactly like an unknown one');

  const settings = await get('/office/settings', o.cookie);
  assert.match(settings.text, /رابط مكتبك/);
  assert.ok(settings.text.includes(`https://aqdi.example/${row.public_slug}`), 'the full link');
  assert.match(settings.text, /نسخ الرابط/);
  assert.match(settings.text, /إظهار صفحة المكتب للعامة/);
  assert.match(settings.text, /يبقى الرابط القديم يحوّل/);

  await post('/office/settings/public-page', o.cookie, { enabled: '1', description: '' });
  const shown = await get(`/${row.public_slug}`);
  assert.equal(shown.status, 200);
  assert.match(shown.text, /noindex/, 'no published listing: not indexed');
});

test('settings: staff cannot see or change the link; a manager can; every change is audited without the text', { skip }, async () => {
  const o = await fx.office(10, 'تجربة-رابط-الأدوار', { units: 1 });
  const staff = await http.addMember(o.office.id, phone(11), 'office_staff');
  const manager = await http.addMember(o.office.id, phone(12), 'office_manager');
  const before = await officeRow(o.office.id);

  assert.doesNotMatch((await get('/office/settings', staff)).text, /رابط مكتبك/);
  assert.equal((await post('/office/settings/link', staff, { slug: SLUG('staff') })).status, 403);
  assert.equal((await post('/office/settings/public-page', staff, { enabled: '1' })).status, 403);
  assert.equal((await officeRow(o.office.id)).public_slug, before.public_slug);
  assert.equal(Number((await officeRow(o.office.id)).public_page_enabled), 0);
  assert.equal((await post('/office/settings/link', null, { slug: SLUG('anon') })).status, 302, 'anonymous goes to login');

  assert.equal((await post('/office/settings/link', manager, { slug: SLUG('roles') })).status, 302);
  assert.equal((await post('/office/settings/public-page', manager, { enabled: '1', description: 'نص-خاص-بالوصف' })).status, 302);
  const after = await officeRow(o.office.id);
  assert.equal(after.public_slug, SLUG('roles'));
  assert.equal(Number(after.public_page_enabled), 1);

  const [audits] = await db.pool.query("SELECT action, before_json, after_json FROM audit_logs WHERE office_id = ? AND action LIKE 'office.public%' ORDER BY id", [o.office.id]);
  assert.deepEqual(audits.map((a) => a.action), ['office.public_slug', 'office.public_page']);
  assert.match(JSON.stringify(audits[0].after_json), /tpl-roles/);
  assert.doesNotMatch(JSON.stringify(audits), /نص-خاص-بالوصف/, 'the description text is never audited');
  assert.match((await get('/office/audit', o.cookie)).text, /تغيير رابط المكتب/);
});

test('changing the slug: Arabic errors for form, reserved, official and taken (current and history); 3 changes per 30 days', { skip }, async () => {
  const a = await fx.office(20, 'تجربة-رابط-أ', { units: 1 });
  const b = await fx.office(21, 'تجربة-رابط-ب', { units: 1 });
  await enable(b, SLUG('taken-now'));
  // b's first slug is in history now; b moves once more so "tpl-taken-now" is history too.
  assert.equal((await post('/office/settings/link', b.cookie, { slug: SLUG('b-current') })).status, 302);

  const cases = [
    ['ab', /من 3 إلى 40/],
    ['Al_Ittihad', /حروفاً إنجليزية صغيرة/],
    ['-abc', /لا تبدأ الرابط/],
    ['admin', /محجوز/],
    ['listings', /محجوز/],
    ['ejar-riyadh', /جهة حكومية أو رسمية/],
    [SLUG('b-current'), /مستخدم/],
    [SLUG('TAKEN-NOW'), /مستخدم/],
  ];
  for (const [slug, message] of cases) {
    const res = await post('/office/settings/link', a.cookie, { slug });
    assert.equal(res.status, 422, slug);
    assert.match(res.text, message, slug);
  }
  assert.match((await officeRow(a.office.id)).public_slug, /^office-/, 'nothing changed');

  assert.equal((await post('/office/settings/link', a.cookie, { slug: SLUG('A-One') })).status, 302);
  assert.equal((await officeRow(a.office.id)).public_slug, SLUG('a-one'), 'stored lower-case');
  assert.equal((await post('/office/settings/link', a.cookie, { slug: SLUG('a-one') })).status, 422, 'the same slug again');
  assert.equal((await post('/office/settings/link', a.cookie, { slug: SLUG('a-two') })).status, 302);
  assert.equal((await post('/office/settings/link', a.cookie, { slug: SLUG('a-three') })).status, 302);
  const limited = await post('/office/settings/link', a.cookie, { slug: SLUG('a-four') });
  assert.equal(limited.status, 429);
  assert.match(limited.text, /3 مرات كل 30 يوماً/);
  assert.equal((await officeRow(a.office.id)).public_slug, SLUG('a-three'));

  // The window is 30 days: older changes no longer count.
  await db.pool.query('UPDATE office_slug_history SET created_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE office_id = ?', [a.office.id]);
  assert.equal((await post('/office/settings/link', a.cookie, { slug: SLUG('a-one') })).status, 302, 'an office may take back its own old slug');
  const [history] = await db.pool.query('SELECT slug FROM office_slug_history WHERE office_id = ? ORDER BY slug', [a.office.id]);
  assert.ok(!history.some((h) => h.slug === SLUG('a-one')), 'the slug in use is not also in history');
  assert.ok(history.some((h) => h.slug === SLUG('a-three')));
});

// ------------------------------------------------------------ the public page

test('public page: name, city, escaped description and this office\'s published listings only; no private data; canonical; sitemap', { skip }, async () => {
  const a = await fx.office(30, 'تجربة-صفحة-أ', { units: 3, city: 'الرياض' });
  const b = await fx.office(31, 'تجربة-صفحة-ب', { units: 1 });
  await db.pool.query("UPDATE offices SET email = 'office@private.example', phone = '966112223344' WHERE id = ?", [a.office.id]);
  const mine = await publish(a, 0);
  await db.pool.query(
    `INSERT INTO listings (office_id, unit_id, title, description, price, currency, status, unit_type, city, neighborhood)
     VALUES (?, ?, 'مسودة-لا-تظهر', 'وصف', 1000, 'SAR', 'draft', 'apartment', 'الرياض', 'الملقا')`,
    [a.office.id, a.units[1]],
  );
  const theirs = await publish(b, 0, { title: 'إعلان-المكتب-ب' });
  await enable(a, SLUG('page-a'), '<script>alert(7)</script> مكتب موثوق');
  await enable(b, SLUG('page-b'));

  const page = await get(`/${SLUG('page-a')}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /تجربة-صفحة-أ/);
  assert.match(page.text, /الرياض/);
  assert.match(page.text, /&lt;script&gt;alert\(7\)&lt;\/script&gt; مكتب موثوق/);
  assert.doesNotMatch(page.text, /<script>alert\(7\)/);
  assert.ok(page.text.includes(`href="/listings/${mine}"`));
  assert.ok(!page.text.includes(`href="/listings/${theirs}"`), 'another office\'s listing');
  assert.doesNotMatch(page.text, /إعلان-المكتب-ب|مسودة-لا-تظهر/);
  for (const secret of ['شقة 1-1', 'مالك 1', 'اسم-سري', 'office@private.example', '966112223344', '0112223344', phone(30), `0${phone(30).slice(3)}`]) {
    assert.ok(!page.text.includes(secret), `no ${secret}`);
  }
  assert.match(page.text, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);
  assert.match(page.text, new RegExp(`<link rel="canonical" href="https://aqdi.example/${SLUG('page-a')}">`));
  assert.match(page.text, /content="index,follow"/);
  assert.match(page.response.headers.get('cache-control') || '', /public, max-age=60/);
  assert.match(page.text, /نموذج الاستفسار/);

  // The inquiry form of the listing is the way to reach the office.
  const listing = await get(`/listings/${mine}`);
  assert.equal(listing.status, 200);
  assert.match(listing.text, new RegExp(`action="/listings/${mine}/inquiry"`));

  const sitemap = await get('/sitemap.xml');
  assert.ok(sitemap.text.includes(`https://aqdi.example/${SLUG('page-a')}</loc>`));
  await db.pool.query("UPDATE listings SET status = 'hidden' WHERE office_id = ?", [b.office.id]);
  const sitemap2 = await get('/sitemap.xml');
  assert.ok(!sitemap2.text.includes(`/${SLUG('page-b')}</loc>`), 'a page without a public listing is left out (it is noindex)');
});

test('redirects: an old slug and another case answer 301 to the current link; hidden, suspended or expired offices answer 404', { skip }, async () => {
  const o = await fx.office(40, 'تجربة-تحويل', { units: 1 });
  await enable(o, SLUG('old-name'));
  assert.equal((await post('/office/settings/link', o.cookie, { slug: SLUG('new-name') })).status, 302);

  const old = await get(`/${SLUG('old-name')}?page=2`);
  assert.equal(old.status, 301);
  assert.equal(old.location, `/${SLUG('new-name')}?page=2`);
  const upper = await get(`/${SLUG('NEW-Name')}`);
  assert.equal(upper.status, 301);
  assert.equal(upper.location, `/${SLUG('new-name')}`);
  assert.equal((await get(`/${SLUG('new-name')}`)).status, 200);

  await post('/office/settings/public-page', o.cookie, { description: '' });
  assert.equal((await get(`/${SLUG('new-name')}`)).status, 404, 'switched off');
  assert.equal((await get(`/${SLUG('old-name')}`)).status, 404, 'an old link of a hidden page reveals nothing');

  await post('/office/settings/public-page', o.cookie, { enabled: '1' });
  await db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [o.office.id]);
  assert.equal((await get(`/${SLUG('new-name')}`)).status, 404, 'suspended');
  assert.equal((await get(`/${SLUG('old-name')}`)).status, 404);
  await db.pool.query("UPDATE offices SET status = 'trial', trial_ends_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?", [o.office.id]);
  assert.equal((await get(`/${SLUG('new-name')}`)).status, 404, 'expired trial');
  await db.pool.query("UPDATE offices SET status = 'active', subscription_ends_at = UTC_TIMESTAMP() + INTERVAL 10 DAY WHERE id = ?", [o.office.id]);
  assert.equal((await get(`/${SLUG('new-name')}`)).status, 200, 'paid again');
});

test('/<slug> never breaks real routes, static files, health or the 404 page', { skip }, async () => {
  for (const path of ['/healthz', '/listings', '/pricing', '/blog', '/robots.txt']) assert.equal((await get(path)).status, 200, path);
  const css = await get('/css/main.css');
  assert.equal(css.status, 200);
  assert.match(css.response.headers.get('content-type'), /text\/css/);
  for (const path of ['/no-such-page-here', '/x', '/a.b', `/${'a'.repeat(41)}`, '/office-zzzzzz/extra']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.match(res.text, /الصفحة غير موجودة/);
  }
  assert.equal((await http.request('/tpl-anything', { method: 'POST', form: {} })).status, 404, 'only GET');
});

// ------------------------------------------------------------ backfill

test('the start-up backfill gives every office without a slug an automatic one, once', { skip }, async () => {
  const o = await fx.office(50, 'تجربة-رابط-ترحيل', { landlords: 0, units: 0 });
  await db.pool.query('UPDATE offices SET public_slug = NULL, public_page_enabled = 0 WHERE id = ?', [o.office.id]);
  await officeLink.backfillSlugs(db.pool);
  const first = (await officeRow(o.office.id)).public_slug;
  assert.match(first, /^office-[a-z0-9]{6}$/);
  await officeLink.backfillSlugs(db.pool);
  await db.ensureSchema();
  const again = await officeRow(o.office.id);
  assert.equal(again.public_slug, first, 'idempotent');
  assert.equal(Number(again.public_page_enabled), 0, 'still switched off');
});
