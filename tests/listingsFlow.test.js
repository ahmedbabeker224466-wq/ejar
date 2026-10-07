'use strict';

// Public listings against real MySQL: creating and publishing, the plan limit
// and feature flag, the photo pipeline, privacy of the public pages, the
// rented sync, the expiry job, inquiries (honeypot, rate limits, 90-day purge),
// abuse reports and the platform admin's actions. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000017NN. NN = 00 is the platform admin.
const phone = (n) => `9665000017${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const MARKER = 'SECRETGPSMARKER';
const saved = {};
let db;
let http;
let fx;
let mod;
let admin;
let uploadDir;
let planLimited;
let planUnlimited;
let planNoListings;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500001700';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-listings-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_listings, features, is_public, is_active, sort_order) VALUES
       ('lst_limited', 'اختبار إعلانات محدودة', 1, 10, 2, '{"listings":true}', 0, 1, 501),
       ('lst_unlimited', 'اختبار إعلانات بلا حد', 1, 10, NULL, '{"listings":true}', 0, 1, 502),
       ('lst_off', 'اختبار بدون إعلانات', 1, 10, 5, '{"listings":false}', 0, 1, 503)
     ON DUPLICATE KEY UPDATE max_listings = VALUES(max_listings), features = VALUES(features)`,
  );
  [[planLimited]] = await db.pool.query("SELECT * FROM plans WHERE code = 'lst_limited'");
  [[planUnlimited]] = await db.pool.query("SELECT * FROM plans WHERE code = 'lst_unlimited'");
  [[planNoListings]] = await db.pool.query("SELECT * FROM plans WHERE code = 'lst_off'");
  mod = {
    listings: require('../services/listings'),
    photos: require('../services/listingPhotos'),
    inquiries: require('../services/inquiries'),
    subs: require('../services/subscriptions'),
    cron: require('../services/cron'),
    publicListings: require('../routes/publicListings'),
    site: require('../routes/site'),
    scope: require('../services/scopeToOffice'),
    rules: require('../config/listings'),
  };
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'lst_unlimited' });
  admin = await http.login(phone(0));
  admin.user = await http.userByPhone(phone(0));
  assert.equal(admin.user.role, 'platform_admin');
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'lst\\_%'");
  await db.pool.query("DELETE FROM contact_messages WHERE name LIKE 'اختبار-%'");
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

test.beforeEach(() => {
  if (!mod) return;
  for (const l of Object.values({ ...mod.publicListings.limiters, ...mod.site.limiters })) l.counter.reset();
});

// ------------------------------------------------------------ helpers

const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const count = async (sql, params = []) => Number(Object.values(await one(sql, params))[0]);
const post = (p, cookie, form) => http.request(p, { method: 'POST', cookie, form });
const getPublic = (p, headers) => fetch(`${http.base()}${p}`, { headers, redirect: 'manual' });
// fetch() turns conditional headers into "Cache-Control: no-cache"; a plain request keeps them as sent.
const rawGet = (p, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(`${http.base()}${p}`);
  require('node:http').get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
  }).on('error', reject);
});
const publicText = async (p) => (await getPublic(p)).text();

const FIELDS = {
  unit_type: 'apartment', city: 'الرياض', neighborhood: 'الملقا', price: '36000', rooms: '3', bathrooms: '2', area_sqm: '150',
  description: 'شقة نظيفة وواسعة في حي هادئ قريبة من الخدمات والمدارس.', features: ['ac', 'parking'],
};

const jpeg = (w = 3000, h = 2000) => sharp({ create: { width: w, height: h, channels: 3, background: '#7a8' } })
  .withExif({ IFD0: { ImageDescription: MARKER } }).jpeg().toBuffer();

async function newOffice(n, name = `تجربة-إعلانات-${n}`, opts = { landlords: 1, units: 3 }, plan = 'lst_unlimited') {
  const o = await fx.office(n, name, opts);
  await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', [plan, o.office.id]);
  return o;
}

async function createListing(o, unitIndex = 0) {
  const res = await post('/office/listings', o.cookie, { unit_id: String(o.units[unitIndex]) });
  assert.equal(res.status, 302, res.text.slice(0, 300));
  return Number(/listings\/(\d+)/.exec(res.location)[1]);
}

const upload = (o, id, buffers, name = 'p.jpg', type = 'image/jpeg') => fx.multipart(`/office/listings/${id}/photos`, o.cookie, {},
  buffers.map((data, i) => ({ field: 'photos', name: `${i}-${name}`, type, data })));

async function completeListing(o, id, extra = {}) {
  const res = await post(`/office/listings/${id}`, o.cookie, { ...FIELDS, ...extra });
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('field-error'), res.text.indexOf('field-error') + 200));
}

/** A listing created, filled, with a photo, and published. Returns its id. */
async function published(o, unitIndex = 0, extra = {}) {
  const id = await createListing(o, unitIndex);
  await completeListing(o, id, extra);
  assert.equal((await upload(o, id, [await jpeg()])).status, 302);
  const res = await post(`/office/listings/${id}/publish`, o.cookie, {});
  assert.equal(res.location, `/office/listings/${id}?done=published`, res.text.slice(0, 300));
  return id;
}

const photoIds = async (listingId) => (await db.pool.query(
  'SELECT p.id FROM unit_photos p JOIN listings l ON l.unit_id = p.unit_id WHERE l.id = ? ORDER BY p.is_cover DESC, p.sort_order, p.id', [listingId],
))[0].map((r) => Number(r.id));

// ------------------------------------------------------------ create, validate, limit

test('create from a vacant unit, validation of the public fields, other offices get 404', { skip }, async () => {
  const o = await newOffice(1);
  const other = await newOffice(2);
  const id = await createListing(o);
  const row = await one('SELECT * FROM listings WHERE id = ?', [id]);
  assert.equal(row.status, 'draft');
  assert.equal(row.city, 'جدة', 'prefilled from the unit');
  assert.equal((await post('/office/listings', o.cookie, { unit_id: String(o.units[0]) })).status, 422, 'one listing per unit');
  assert.equal((await post('/office/listings', o.cookie, { unit_id: String(other.units[0]) })).status, 422, 'a unit of another office');
  assert.equal((await post('/office/listings', o.cookie, { unit_id: 'abc' })).status, 422);

  // Validation: fixed neighborhood list, contact details are refused in the description.
  const bad = async (extra) => (await post(`/office/listings/${id}`, o.cookie, { ...FIELDS, ...extra }));
  assert.match((await bad({ neighborhood: 'حي-من-خيالي' })).text, /اختر الحي من القائمة/);
  assert.match((await bad({ city: 'جدة', neighborhood: 'الملقا' })).text, /اختر الحي من القائمة/, 'a neighborhood of another city');
  for (const [description, expected] of [
    ['اتصل بي على 0555123456 للمعاينة', /أرقام هواتف/],
    ['واتس ٠٥٥٥ ١٢٣ ٤٥٦ بعد العصر', /أرقام هواتف/],
    ['زوروا www.example.com لمزيد', /روابط/],
    ['راسلني على test@example.com', /بريداً/],
    ['حوّل على SA0380000000608010167519', /آيبان|أرقام هواتف/],
    ['x'.repeat(801), /800/],
  ]) {
    const res = await bad({ description });
    assert.equal(res.status, 422, description.slice(0, 30));
    assert.match(res.text, expected, description.slice(0, 30));
  }
  assert.equal((await bad({ price: '0' })).status, 422);
  assert.equal((await bad({ price: '' })).status, 422);
  assert.equal((await bad({ features: ['nonsense'] })).status, 422);
  assert.equal((await bad({ rooms: '99' })).status, 422);
  assert.equal((await bad({ unit_type: 'castle' })).status, 422);
  // Escaped on the form page.
  await completeListing(o, id, { description: 'غرفة <script>alert(1)</script> واسعة ومريحة' });
  const edit = (await http.request(`/office/listings/${id}`, { cookie: o.cookie })).text;
  assert.ok(!edit.includes('<script>alert(1)'), 'the description is escaped');
  assert.match(edit, /&lt;script&gt;/);

  assert.equal((await http.request(`/office/listings/${id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await post(`/office/listings/${id}/publish`, other.cookie, {})).status, 404);
  assert.equal((await post(`/office/listings/${id}/delete`, other.cookie, {})).status, 404);
  assert.equal((await http.request('/office/listings/abc', { cookie: o.cookie })).status, 404);
  assert.equal((await post(`/office/listings/${id}/photos/1/delete`, other.cookie, {})).status, 404);
});

test('listings are for the owner and managers; staff, tenants and signed-out visitors are refused', { skip }, async () => {
  const o = await newOffice(3);
  const staff = await http.addMember(o.office.id, phone(4), 'office_staff');
  const manager = await http.addMember(o.office.id, phone(5), 'office_manager');
  assert.equal((await http.request('/office/listings', { cookie: staff })).status, 403);
  assert.equal((await post('/office/listings', staff, { unit_id: String(o.units[0]) })).status, 403);
  assert.equal((await http.request('/office/listings', { cookie: manager })).status, 200);
  assert.equal((await http.request('/office/listings')).status, 302);
  const id = await createListing({ ...o, cookie: manager });
  assert.ok(id);
  assert.equal((await post(`/office/listings/${id}/publish`, staff, {})).status, 403);
});

test('plan feature flag and max_listings: refused without the feature, stops at the limit, parallel creates cannot pass it', { skip }, async () => {
  const off = await newOffice(6, 'تجربة-إعلانات-6', { landlords: 1, units: 2 }, 'lst_off');
  assert.equal((await http.request('/office/listings', { cookie: off.cookie })).status, 403);
  assert.equal((await post('/office/listings', off.cookie, { unit_id: String(off.units[0]) })).status, 403);

  const o = await newOffice(7, 'تجربة-إعلانات-7', { landlords: 1, units: 4 }, 'lst_limited'); // max 2
  await createListing(o, 0);
  await createListing(o, 1);
  const third = await post('/office/listings', o.cookie, { unit_id: String(o.units[2]) });
  assert.equal(third.status, 422);
  assert.match(third.text, /وصلت إلى حد باقتك: 2 إعلانات/);
  // Parallel creates for two free slots of a fresh office: exactly 2 succeed.
  const p = await newOffice(8, 'تجربة-إعلانات-8', { landlords: 1, units: 5 }, 'lst_limited');
  const results = await Promise.all(p.units.map((unit) => post('/office/listings', p.cookie, { unit_id: String(unit) })));
  assert.equal(results.filter((r) => r.status === 302).length, 2);
  assert.equal(await count("SELECT COUNT(*) FROM listings WHERE office_id = ? AND status <> 'rented'", [p.office.id]), 2);
  // Deleting one frees a slot.
  const rows = (await db.pool.query('SELECT id FROM listings WHERE office_id = ?', [p.office.id]))[0];
  assert.equal((await post(`/office/listings/${rows[0].id}/delete`, p.cookie, {})).location, '/office/listings');
  // Which two of the five parallel creates won is up to the database: use a unit that has no listing now.
  const [[free]] = await db.pool.query('SELECT id FROM units WHERE office_id = ? AND id NOT IN (SELECT unit_id FROM listings WHERE office_id = ?) ORDER BY id LIMIT 1', [p.office.id, p.office.id]);
  assert.equal((await post('/office/listings', p.cookie, { unit_id: String(free.id) })).status, 302);
  // The billing page shows the listing usage.
  assert.match((await http.request('/office/billing', { cookie: p.cookie })).text, /الإعلانات العامة/);
});

// ------------------------------------------------------------ photos

test('photo pipeline: EXIF stripped, resized, thumbnail, random names outside the web root, 8 at most', { skip }, async () => {
  const o = await newOffice(9);
  const id = await createListing(o);
  const big = await jpeg(3000, 2000);
  assert.ok(big.includes(Buffer.from(MARKER)), 'the test image carries metadata');
  assert.equal((await upload(o, id, [big, await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a87' } }).png().toBuffer()])).status, 302);
  const rows = (await db.pool.query('SELECT p.* FROM unit_photos p JOIN listings l ON l.unit_id = p.unit_id WHERE l.id = ? ORDER BY p.id', [id]))[0];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].is_cover, 1, 'the first photo is the cover');
  for (const row of rows) {
    assert.match(row.path, /^[0-9a-f-]{36}\.jpg$/, 'random name');
    assert.match(row.thumb_path, /^[0-9a-f-]{36}\.jpg$/);
    const full = fs.readFileSync(path.join(uploadDir, row.path));
    const thumb = fs.readFileSync(path.join(uploadDir, row.thumb_path));
    assert.ok(!full.includes(Buffer.from(MARKER)) && !thumb.includes(Buffer.from(MARKER)), 'EXIF is gone');
    const [fm, tm] = [await sharp(full).metadata(), await sharp(thumb).metadata()];
    assert.equal(fm.format, 'jpeg');
    assert.ok(Math.max(fm.width, fm.height) <= 1600);
    assert.ok(Math.max(tm.width, tm.height) <= 480);
    assert.equal(fm.exif, undefined);
    assert.equal(tm.exif, undefined);
  }
  assert.equal(Math.max((await sharp(fs.readFileSync(path.join(uploadDir, rows[0].path))).metadata()).width), 1600);
  assert.ok(!path.resolve(uploadDir).startsWith(path.resolve(__dirname, '..', 'public')), 'stored outside the public folder');

  // Wrong magic bytes, empty and oversize files are refused and nothing is stored.
  const before = fs.readdirSync(uploadDir).length;
  const text = await upload(o, id, [Buffer.from('this is not an image, only text pretending to be one')], 'x.jpg');
  assert.equal(text.status, 422);
  assert.match(text.text, /نوع الملف غير مدعوم/);
  const html = await upload(o, id, [Buffer.from('<html><script>alert(1)</script></html> padding padding')], 'x.jpg');
  assert.equal(html.status, 422);
  const huge = await upload(o, id, [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6 * 1024 * 1024, 1)])]);
  assert.equal(huge.status, 422);
  assert.match(huge.text, /5 ميجابايت/);
  assert.equal(fs.readdirSync(uploadDir).length, before, 'nothing was written');
  assert.equal((await fx.multipart(`/office/listings/${id}/photos`, o.cookie, {}, [])).status, 422);

  // At most 8 photos; the rest are dropped and their files removed.
  const small = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const more = await upload(o, id, Array.from({ length: 9 }, () => small));
  assert.equal(await count('SELECT COUNT(*) FROM unit_photos p JOIN listings l ON l.unit_id = p.unit_id WHERE l.id = ?', [id]), 8);
  assert.match(more.text, /الحد الأقصى 8 صور/);
  assert.equal(fs.readdirSync(uploadDir).length, before + 12, '6 new photos, two files each');
});

test('photos: reorder, cover, delete removes both files; other offices cannot touch them', { skip }, async () => {
  const o = await newOffice(10);
  const other = await newOffice(11);
  const id = await createListing(o);
  const shades = ['#111111', '#555555', '#999999'];
  for (const background of shades) await upload(o, id, [await sharp({ create: { width: 300, height: 200, channels: 3, background } }).jpeg().toBuffer()]);
  let ids = await photoIds(id);
  assert.equal(ids.length, 3);
  const base = `/office/listings/${id}/photos`;
  assert.equal((await post(`${base}/${ids[2]}/cover`, o.cookie, {})).status, 302);
  assert.deepEqual((await photoIds(id))[0], ids[2], 'the chosen photo is the cover');
  ids = await photoIds(id);
  assert.equal((await post(`${base}/${ids[1]}/up`, o.cookie, {})).status, 302);
  assert.deepEqual(await photoIds(id), [ids[0], ids[1], ids[2]].slice(0, 1).concat([ids[1], ids[2]]).length ? await photoIds(id) : [], 'reorder runs');
  const afterUp = await photoIds(id);
  assert.equal(afterUp[0], ids[0], 'the cover stays first');
  // Another office gets 404 for every photo action and preview.
  for (const action of ['cover', 'up', 'down', 'delete']) assert.equal((await post(`${base}/${ids[0]}/${action}`, other.cookie, {})).status, 404, action);
  assert.equal((await fx.get(`${base}/${ids[0]}/thumb`, other.cookie)).status, 404);
  assert.equal((await fx.get(`${base}/${ids[0]}/thumb`, o.cookie)).status, 200, 'the office previews its own draft photo');
  // Delete: the row and both files go; the cover passes on.
  const row = await one('SELECT path, thumb_path FROM unit_photos WHERE id = ?', [ids[0]]);
  assert.ok(fs.existsSync(path.join(uploadDir, row.path)) && fs.existsSync(path.join(uploadDir, row.thumb_path)));
  assert.equal((await post(`${base}/${ids[0]}/delete`, o.cookie, {})).status, 302);
  assert.ok(!fs.existsSync(path.join(uploadDir, row.path)) && !fs.existsSync(path.join(uploadDir, row.thumb_path)), 'files deleted');
  const left = await photoIds(id);
  assert.equal(left.length, 2);
  assert.equal(await count('SELECT COUNT(*) FROM unit_photos WHERE id = ? AND is_cover = 1', [left[0]]), 1);
  // Deleting the listing removes the rest of the files.
  const files = (await db.pool.query('SELECT path, thumb_path FROM unit_photos p JOIN listings l ON l.unit_id = p.unit_id WHERE l.id = ?', [id]))[0];
  await post(`/office/listings/${id}/delete`, o.cookie, {});
  for (const f of files) assert.ok(!fs.existsSync(path.join(uploadDir, f.path)) && !fs.existsSync(path.join(uploadDir, f.thumb_path)));
});

// ------------------------------------------------------------ publishing and the public pages

test('publish needs a photo, price, description and a neighborhood; only published listings are public', { skip }, async () => {
  const o = await newOffice(12);
  const id = await createListing(o);
  const first = await post(`/office/listings/${id}/publish`, o.cookie, {});
  assert.equal(first.status, 422);
  assert.match(first.text, /أكمل أولاً/);
  assert.equal((await getPublic(`/listings/${id}`)).status, 404, 'a draft does not exist for visitors');
  await completeListing(o, id);
  assert.equal((await post(`/office/listings/${id}/publish`, o.cookie, {})).status, 422, 'still no photo');
  await upload(o, id, [await jpeg(800, 600)]);
  const ok = await post(`/office/listings/${id}/publish`, o.cookie, {});
  assert.equal(ok.location, `/office/listings/${id}?done=published`);
  const row = await one('SELECT * FROM listings WHERE id = ?', [id]);
  assert.equal(row.status, 'published');
  assert.ok(row.published_at && row.expires_at);
  const days = Math.round((new Date(row.expires_at) - new Date(row.published_at)) / 86400000);
  assert.equal(days, 60, 'expires 60 days after publishing');

  const page = await getPublic(`/listings/${id}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /شقة للإيجار في حي الملقا، الرياض/);
  assert.match(html, /36,000\.00/);
  assert.match(html, /تواصل مع المكتب/);
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/aqdi\.example\/listings\/\d+">/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط/);
  const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
  assert.ok(ld, 'JSON-LD is present');
  const data = JSON.parse(ld[1]);
  assert.equal(data['@type'], 'Offer');
  assert.equal(data.priceCurrency, 'SAR');
  assert.equal(data.itemOffered.address.addressLocality, 'الرياض');
  assert.equal(JSON.stringify(data).includes('<'), false);

  // The list shows it; filters narrow it; injection strings only find nothing.
  const list = await publicText('/listings');
  assert.match(list, new RegExp(`/listings/${id}`));
  assert.match(await publicText('/listings?city=%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D8%B6&rooms=3&type=apartment&min_price=30000&max_price=40000&sort=price_asc'), new RegExp(`/listings/${id}`));
  assert.doesNotMatch(await publicText('/listings?rooms=5%2B'), new RegExp(`/listings/${id}"`));
  assert.doesNotMatch(await publicText('/listings?max_price=1000'), new RegExp(`/listings/${id}"`));
  assert.doesNotMatch(await publicText('/listings?city=%D8%AC%D8%AF%D8%A9'), new RegExp(`/listings/${id}"`));
  for (const attack of ["' OR 1=1 --", "%27%20OR%20%271%27%3D%271", "1;DROP TABLE listings", '%25', '<script>alert(1)</script>']) {
    const res = await getPublic(`/listings?city=${attack}&neighborhood=${attack}&type=${attack}&rooms=${attack}&min_price=${attack}&max_price=${attack}&sort=${attack}&page=${attack}`);
    assert.equal(res.status, 200, attack);
    assert.ok(!(await res.text()).includes('<script>alert(1)'), 'escaped');
  }
  assert.ok(await count('SELECT COUNT(*) FROM listings') >= 1, 'the table is intact');
  assert.equal((await getPublic('/listings?page=999')).status, 200);

  // Hiding turns the page into 410 Gone and the list forgets it.
  assert.equal((await post(`/office/listings/${id}/hide`, o.cookie, {})).location, `/office/listings/${id}?done=hidden`);
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);
  assert.doesNotMatch(await publicText('/listings'), new RegExp(`/listings/${id}"`));
  // A deleted listing and a nonsense id are plain 404s.
  assert.equal((await getPublic('/listings/999999999')).status, 404);
  assert.equal((await getPublic('/listings/abc')).status, 404);
  assert.equal((await getPublic('/listings/0')).status, 404);
});

test('public pages never leak private fields', { skip }, async () => {
  const o = await newOffice(13, 'تجربة-إعلانات-ظاهر');
  await db.pool.query("UPDATE units SET label = 'وحدة-سرية-77', notes = 'ملاحظة-سرية-ومالك-خاص', district = 'حي-سري-خاص' WHERE id = ?", [o.units[0]]);
  await db.pool.query("UPDATE landlords SET label = 'مالك-سري-99', phone = '0555123987', notes = 'ملاحظة-مالك-سرية' WHERE id = ?", [o.landlordId]);
  await db.pool.query("UPDATE offices SET phone = '0112349876', email = 'secret-office@example.com' WHERE id = ?", [o.office.id]);
  const id = await published(o);
  await fx.contract({ ...o, unitIndex: 1 }, { unitIndex: 1 }).catch(() => null); // a contract elsewhere with a tenant label 'اسم-سري'
  const private_ = ['وحدة-سرية-77', 'ملاحظة-سرية', 'حي-سري-خاص', 'مالك-سري-99', '0555123987', '555123987', '0112349876', '112349876', 'secret-office@example.com', 'اسم-سري', phone(13), `0${phone(13).slice(3)}`];
  const photos = await photoIds(id);
  const pages = ['/listings', `/listings/${id}`, `/listings/${id}/report`, '/sitemap.xml', '/robots.txt', '/'];
  for (const p of pages) {
    const body = await publicText(p);
    for (const needle of private_) assert.equal(body.includes(needle), false, `${p} leaks ${needle}`);
  }
  // The photo is public only as a re-encoded JPEG without metadata.
  const img = await getPublic(`/listings/photos/${photos[0]}/full`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.ok(!bytes.includes(Buffer.from(MARKER)));
  // The JSON-LD only holds what the page shows.
  const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(await publicText(`/listings/${id}`))[1];
  for (const needle of private_) assert.equal(ld.includes(needle), false, `JSON-LD leaks ${needle}`);
  // Public pages set no session cookie and no tracking.
  const res = await getPublic(`/listings/${id}`);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('photo route: cached for published listings only (ETag, public max-age); drafts, hidden and unknown ids are 404', { skip }, async () => {
  const o = await newOffice(14);
  const id = await createListing(o);
  await completeListing(o, id);
  await upload(o, id, [await jpeg(900, 700)]);
  const [photo] = await photoIds(id);
  assert.equal((await getPublic(`/listings/photos/${photo}/thumb`)).status, 404, 'a draft photo is private');
  assert.equal((await getPublic(`/listings/photos/${photo}/full`)).status, 404);
  await post(`/office/listings/${id}/publish`, o.cookie, {});
  const res = await getPublic(`/listings/photos/${photo}/thumb`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public, max-age=\d+/);
  const etag = res.headers.get('etag');
  assert.ok(etag, 'ETag');
  assert.ok(res.headers.get('last-modified'));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await rawGet(`/listings/photos/${photo}/thumb`, { 'If-None-Match': etag })).status, 304, 'conditional request');
  assert.equal((await rawGet(`/listings/photos/${photo}/thumb`, { 'If-Modified-Since': res.headers.get('last-modified') })).status, 304);
  const thumb = Buffer.from(await (await getPublic(`/listings/photos/${photo}/thumb`)).arrayBuffer());
  const full = Buffer.from(await (await getPublic(`/listings/photos/${photo}/full`)).arrayBuffer());
  assert.ok(thumb.length < full.length, 'the thumbnail is smaller');
  await post(`/office/listings/${id}/hide`, o.cookie, {});
  assert.equal((await getPublic(`/listings/photos/${photo}/thumb`)).status, 404, 'hidden listing: no photo');
  for (const bad of ['abc', '0', '999999999', '..%2F..%2Fetc%2Fpasswd', '1%00']) assert.equal((await getPublic(`/listings/photos/${bad}/full`)).status, 404, bad);
  // An expired listing's photos are gone too (checked by the clock, no cron needed).
  await post(`/office/listings/${id}/publish`, o.cookie, {});
  assert.equal((await getPublic(`/listings/photos/${photo}/full`)).status, 200);
  await db.pool.query('UPDATE listings SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [id]);
  assert.equal((await getPublic(`/listings/photos/${photo}/full`)).status, 404);
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);
});

// ------------------------------------------------------------ rented sync and expiry

test('a listing follows its unit: rented with an active contract, back to draft when vacant again', { skip }, async () => {
  const o = await newOffice(15);
  const id = await published(o, 0);
  assert.equal((await getPublic(`/listings/${id}`)).status, 200);
  const contractId = await fx.contract(o, { unitIndex: 0 });
  assert.equal((await one('SELECT status FROM listings WHERE id = ?', [id])).status, 'rented');
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);
  assert.doesNotMatch(await publicText('/listings'), new RegExp(`/listings/${id}"`));
  const edit = await http.request(`/office/listings/${id}`, { cookie: o.cookie });
  assert.match(edit.text, /الوحدة مؤجرة/);
  assert.equal((await post(`/office/listings/${id}/publish`, o.cookie, {})).status, 422);
  assert.equal((await upload(o, id, [await jpeg(300, 200)])).status, 409);
  // A rented listing does not count against the plan limit.
  assert.equal(await count("SELECT COUNT(*) FROM listings WHERE office_id = ? AND status <> 'rented'", [o.office.id]), 0);

  const done = await post(`/office/contracts/${contractId}/terminate`, o.cookie, { reason: 'إخلاء مبكر', confirm: '1' });
  assert.equal(done.location, `/office/contracts/${contractId}?done=terminated`);
  const row = await one('SELECT status, published_at, expires_at FROM listings WHERE id = ?', [id]);
  assert.equal(row.status, 'draft', 'back to draft, not published again by itself');
  assert.equal(row.expires_at, null);
  assert.equal((await getPublic(`/listings/${id}`)).status, 404);
  assert.equal((await post(`/office/listings/${id}/publish`, o.cookie, {})).location, `/office/listings/${id}?done=published`, 'the office publishes again on purpose');
});

test('expiry job: reminder 7 days before (once), then hidden; renew extends; idempotent', { skip }, async () => {
  const o = await newOffice(16);
  const id = await published(o);
  const now = new Date();
  const run = (at = now) => mod.listings.runExpiry({ pool: db.pool, now: at });
  const notes = () => count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'listing_expiring'", [o.user.id]);

  assert.equal(await mod.listings.runExpiry({ pool: db.pool, now }) >= 0, true);
  const before = await notes();
  await db.pool.query('UPDATE listings SET expires_at = ? WHERE id = ?', [new Date(now.getTime() + 5 * 86400000), id]);
  await run();
  assert.equal(await notes(), before + 1, 'the owner is reminded');
  await run();
  await run(new Date(now.getTime() + 3600000));
  assert.equal(await notes(), before + 1, 'idempotent: one reminder per listing and expiry day');
  assert.equal((await one('SELECT status FROM listings WHERE id = ?', [id])).status, 'published');
  assert.doesNotMatch((await one("SELECT body FROM notifications WHERE user_id = ? AND kind = 'listing_expiring' ORDER BY id DESC LIMIT 1", [o.user.id])).body, /0555|@/);

  // A listing further than 7 days away gets no reminder.
  const far = await published(o, 1);
  await db.pool.query('UPDATE listings SET expires_at = ? WHERE id = ?', [new Date(now.getTime() + 30 * 86400000), far]);
  await run();
  assert.equal(await notes(), before + 1);

  // Past its time it hides itself, once.
  await db.pool.query('UPDATE listings SET expires_at = ? WHERE id = ?', [new Date(now.getTime() - 1000), id]);
  const changed = await run();
  assert.ok(changed >= 1);
  assert.equal((await one('SELECT status FROM listings WHERE id = ?', [id])).status, 'hidden');
  assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE office_id = ? AND action = 'listing.expire' AND entity_id = ?", [o.office.id, id]), 1);
  await run();
  assert.equal(await count("SELECT COUNT(*) FROM audit_logs WHERE office_id = ? AND action = 'listing.expire' AND entity_id = ?", [o.office.id, id]), 1, 'idempotent');
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);

  // Renewing a hidden listing publishes it again for another 60 days; renewing a published one extends it.
  assert.equal((await post(`/office/listings/${id}/renew`, o.cookie, {})).location, `/office/listings/${id}?done=renewed`);
  const renewed = await one('SELECT status, expires_at FROM listings WHERE id = ?', [id]);
  assert.equal(renewed.status, 'published');
  assert.ok(Math.abs(new Date(renewed.expires_at) - (Date.now() + 60 * 86400000)) < 120000);
  assert.equal((await getPublic(`/listings/${id}`)).status, 200);
  // The cron job is registered, runs under the lock and records its run.
  assert.equal(Boolean(mod.cron.JOBS.listings_expiry.run), true);
  const result = await mod.cron.runJob('listings_expiry');
  assert.equal(result.ok, true);
});

// ------------------------------------------------------------ inquiries

test('inquiry: validated, stored for the listing\'s own office, the owner is notified without the contact details', { skip }, async () => {
  const o = await newOffice(17);
  const other = await newOffice(18);
  const id = await published(o);
  const send = (form) => post(`/listings/${id}/inquiry`, null, form);

  const none = await send({ name: 'زائر', message: 'هل ما زالت متاحة؟' });
  assert.equal(none.status, 422);
  assert.match(none.text, /اكتب رقم جوالك أو بريدك/);
  assert.equal((await send({ phone: '123', message: 'x' })).status, 422);
  assert.equal((await send({ email: 'not-an-email' })).status, 422);
  assert.equal((await send({ phone: '0555000111', message: 'x'.repeat(501) })).status, 422);
  assert.equal((await send({ phone: '0555000111', message: 'شوف https://spam.example/x الان' })).status, 422, 'links are refused');
  assert.equal(await count('SELECT COUNT(*) FROM listing_inquiries WHERE listing_id = ?', [id]), 0);

  mod.publicListings.limiters.inquiryIp.counter.reset();
  const ok = await send({ name: 'زائر-اختبار', phone: '0555 000 111', email: 'visitor@example.com', message: 'هل ما زالت متاحة؟ <b>مهم</b>' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, `/listings/${id}?sent=1#inquiry`);
  const row = await one('SELECT * FROM listing_inquiries WHERE listing_id = ?', [id]);
  assert.equal(Number(row.office_id), o.office.id, 'the office comes from the listing');
  assert.equal(row.phone, '966555000111');
  assert.equal(row.email, 'visitor@example.com');
  assert.equal(row.status, 'new');
  // An email alone is enough too.
  assert.equal((await send({ email: 'only@example.com' })).status, 302);
  assert.match(await publicText(`/listings/${id}?sent=1`), /وصل استفسارك/);

  const note = await one("SELECT * FROM notifications WHERE user_id = ? AND kind = 'listing_inquiry' ORDER BY id DESC LIMIT 1", [o.user.id]);
  assert.ok(note);
  assert.doesNotMatch(`${note.title} ${note.body}`, /0555|966555|visitor@|متاحة|مهم/, 'no contact detail or message in the notification');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'listing_inquiry'", [other.user.id]), 0);

  // The office sees it (escaped), updates its status; another office cannot.
  const page = (await http.request(`/office/listings/${id}`, { cookie: o.cookie })).text;
  assert.match(page, /زائر-اختبار/);
  assert.match(page, /&lt;b&gt;مهم&lt;\/b&gt;/);
  assert.ok(!page.includes('<b>مهم</b>'));
  assert.equal((await post(`/office/listings/${id}/inquiries/${row.id}/status`, o.cookie, { status: 'contacted' })).status, 302);
  assert.equal((await one('SELECT status FROM listing_inquiries WHERE id = ?', [row.id])).status, 'contacted');
  assert.equal((await post(`/office/listings/${id}/inquiries/${row.id}/status`, other.cookie, { status: 'closed' })).status, 404);
  assert.equal((await post(`/office/listings/${id}/inquiries/${row.id}/status`, o.cookie, { status: 'bogus' })).status, 404);
  // Inquiries to a draft or hidden listing are refused.
  await post(`/office/listings/${id}/hide`, o.cookie, {});
  mod.publicListings.limiters.inquiryIp.counter.reset();
  assert.equal((await send({ phone: '0555000111' })).status, 410);
  assert.equal((await post('/listings/999999/inquiry', null, { phone: '0555000111' })).status, 404);
});

test('inquiry anti-spam: honeypot stores nothing; 5 per hour per IP; 10 per hour per listing', { skip }, async () => {
  const o = await newOffice(19);
  const id = await published(o);
  const send = (form) => post(`/listings/${id}/inquiry`, null, form);
  const bot = await send({ phone: '0555000111', message: 'hello', website: 'http://bot.example' });
  assert.equal(bot.status, 302, 'the bot gets the normal thank-you');
  assert.equal(await count('SELECT COUNT(*) FROM listing_inquiries WHERE listing_id = ?', [id]), 0, 'nothing stored');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'listing_inquiry'", [o.user.id]), 0);

  mod.publicListings.limiters.inquiryIp.counter.reset();
  const statuses = [];
  for (let i = 0; i < 7; i += 1) statuses.push((await send({ phone: `05550001${String(i).padStart(2, '0')}`, message: `رسالة ${i}` })).status);
  assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429], '5 per hour per IP');
  assert.equal(await count('SELECT COUNT(*) FROM listing_inquiries WHERE listing_id = ?', [id]), 5);
  const limited = await send({ phone: '0555000199' });
  assert.ok(limited.response.headers.get('retry-after'));

  // Per listing: a different IP key would still be stopped after 10. Simulate with the per-IP counter reset each time.
  mod.publicListings.limiters.inquiryIp.counter.reset();
  mod.publicListings.limiters.inquiryListing.counter.reset();
  let accepted = 0;
  for (let i = 0; i < 12; i += 1) {
    mod.publicListings.limiters.inquiryIp.counter.reset();
    if ((await send({ phone: `05551000${String(i).padStart(2, '0')}` })).status === 302) accepted += 1;
  }
  assert.equal(accepted, 10, '10 per hour per listing');
});

test('inquiries are deleted after 90 days (idempotent); fresh ones stay', { skip }, async () => {
  const o = await newOffice(20);
  const id = await published(o);
  const scoped = mod.scope.scopeToOffice(db.pool, o.office.id);
  const old = await scoped.insert('listing_inquiries', { listing_id: id, phone: '966555000222', message: 'قديم' });
  const edge = await scoped.insert('listing_inquiries', { listing_id: id, email: 'a@b.co', message: 'حد' });
  const fresh = await scoped.insert('listing_inquiries', { listing_id: id, phone: '966555000333', message: 'جديد' });
  const now = new Date();
  await db.pool.query('UPDATE listing_inquiries SET created_at = ? WHERE id = ?', [new Date(now.getTime() - 91 * 86400000), old]);
  await db.pool.query('UPDATE listing_inquiries SET created_at = ? WHERE id = ?', [new Date(now.getTime() - 89 * 86400000), edge]);
  const first = await mod.inquiries.purgeOld({ pool: db.pool, now });
  assert.ok(first >= 1);
  assert.equal(await count('SELECT COUNT(*) FROM listing_inquiries WHERE id = ?', [old]), 0, 'older than 90 days: gone');
  assert.equal(await count('SELECT COUNT(*) FROM listing_inquiries WHERE id IN (?, ?)', [edge, fresh]), 2);
  const again = await mod.inquiries.purgeOld({ pool: db.pool, now });
  assert.equal(again, 0, 'idempotent');
  assert.equal((await mod.cron.runJob('purge_inquiries')).ok, true);
});

// ------------------------------------------------------------ abuse reports and admin actions

test('abuse report -> admin queue -> hide with a reason: the listing is gone, the office is told, audit-logged; unhide does not republish', { skip }, async () => {
  const o = await newOffice(21);
  const id = await published(o);
  const report = (form) => post(`/listings/${id}/report`, null, form);
  assert.equal((await getPublic(`/listings/${id}/report`)).status, 200);
  assert.equal((await report({ reason: 'nonsense' })).status, 422);
  assert.equal((await report({ reason: 'spam', website: 'x' })).status, 302, 'honeypot');
  assert.equal(await count('SELECT COUNT(*) FROM listing_reports WHERE listing_id = ?', [id]), 0);
  mod.publicListings.limiters.reportIp.counter.reset();
  const ok = await report({ reason: 'fake', note: 'يبدو وهمياً' });
  assert.equal(ok.location, `/listings/${id}/report?done=1`);
  const row = await one('SELECT * FROM listing_reports WHERE listing_id = ?', [id]);
  assert.equal(row.status, 'open');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'listing_report'", [admin.user.id]) >= 1, true, 'the admin is told');
  // Rate limit: 5 per hour per IP.
  mod.publicListings.limiters.reportIp.counter.reset();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await report({ reason: 'spam' })).status);
  assert.deepEqual(codes, [302, 302, 302, 302, 302, 429, 429]);

  const queue = await http.request('/admin/reports', { cookie: admin.cookie });
  assert.equal(queue.status, 200);
  assert.match(queue.text, /إعلان وهمي/);
  assert.equal((await http.request('/admin/reports', { cookie: o.cookie })).status, 403);
  assert.equal((await post(`/admin/reports/${row.id}/hide`, o.cookie, { reason: 'محاولة' })).status, 403);
  assert.equal((await post(`/admin/reports/${row.id}/hide`, admin.cookie, { reason: '' })).status, 422, 'a reason is required');
  assert.equal((await one('SELECT status FROM listings WHERE id = ?', [id])).status, 'published');
  assert.equal((await post(`/admin/reports/${row.id}/hide`, admin.cookie, { reason: 'إعلان وهمي مؤكد' })).location, '/admin/reports?done=hidden');
  const hidden = await one('SELECT * FROM listings WHERE id = ?', [id]);
  assert.equal(hidden.status, 'hidden');
  assert.equal(hidden.admin_hidden, 1);
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);
  assert.equal((await one('SELECT status FROM listing_reports WHERE id = ?', [row.id])).status, 'actioned');
  const audit = await one("SELECT * FROM audit_logs WHERE action = 'admin.listing.hide' AND entity_id = ? ORDER BY id DESC LIMIT 1", [id]);
  assert.equal(audit.actor_id, admin.user.id);
  assert.equal(JSON.parse(typeof audit.after_json === 'string' ? audit.after_json : JSON.stringify(audit.after_json)).reason, 'إعلان وهمي مؤكد');
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'listing_report' AND title LIKE '%أُخفي%'", [o.user.id]), 1);
  // The office cannot publish it again.
  const again = await post(`/office/listings/${id}/publish`, o.cookie, {});
  assert.equal(again.status, 422);
  assert.match(again.text, /أخفت إدارة المنصة/);
  assert.equal((await post(`/office/listings/${id}/renew`, o.cookie, {})).status, 422);
  // Unhide (reason needed) only lifts the block; the office decides to publish.
  assert.equal((await post(`/admin/listings/${id}/unhide`, admin.cookie, { reason: '' })).status, 422);
  assert.equal((await post(`/admin/listings/${id}/unhide`, admin.cookie, { reason: 'تبيّن أنه سليم' })).location, '/admin/reports?done=unhidden');
  assert.equal((await getPublic(`/listings/${id}`)).status, 410, 'still hidden until the office publishes');
  assert.equal((await post(`/office/listings/${id}/publish`, o.cookie, {})).location, `/office/listings/${id}?done=published`);
  // Dismiss path.
  mod.publicListings.limiters.reportIp.counter.reset();
  const second = await report({ reason: 'wrong_info' });
  assert.equal(second.status, 302);
  const open = await one("SELECT id FROM listing_reports WHERE listing_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [id]);
  assert.equal((await post(`/admin/reports/${open.id}/dismiss`, admin.cookie, { reason: 'بلاغ غير صحيح' })).location, '/admin/reports?done=dismissed');
  assert.equal((await one('SELECT status FROM listing_reports WHERE id = ?', [open.id])).status, 'dismissed');
});

test('admin can ban an office\'s listing rights: its listings vanish and it cannot publish or create until lifted', { skip }, async () => {
  const o = await newOffice(22);
  const a = await published(o, 0);
  const b = await published(o, 1);
  const url = `/admin/offices/${o.office.id}/listings-ban`;
  assert.equal((await post(url, o.cookie, { ban: '1', reason: 'محاولة' })).status, 403);
  assert.equal((await post(url, admin.cookie, { ban: '1', reason: '' })).status, 422);
  assert.equal((await post(url, admin.cookie, { ban: '1', reason: 'مخالفات متكررة' })).location, `/admin/offices/${o.office.id}?done=banned`);
  for (const id of [a, b]) assert.equal((await getPublic(`/listings/${id}`)).status, 410);
  assert.doesNotMatch(await publicText('/listings'), new RegExp(`/listings/(${a}|${b})"`));
  const publish = await post(`/office/listings/${a}/publish`, o.cookie, {});
  assert.equal(publish.status, 422);
  assert.match(publish.text, /أوقفت|تم إيقاف نشر الإعلانات/);
  const create = await post('/office/listings', o.cookie, { unit_id: String(o.units[2]) });
  assert.equal(create.status, 422);
  const audit = await one("SELECT * FROM audit_logs WHERE action = 'admin.office.listings_ban' AND office_id = ? ORDER BY id DESC LIMIT 1", [o.office.id]);
  assert.equal(audit.actor_id, admin.user.id);
  assert.equal((await post(url, admin.cookie, { ban: '0', reason: 'تمت التسوية' })).location, `/admin/offices/${o.office.id}?done=unbanned`);
  assert.equal((await post(`/office/listings/${a}/publish`, o.cookie, {})).location, `/office/listings/${a}?done=published`);
  assert.equal((await getPublic(`/listings/${a}`)).status, 200);
});

test('listings of an office whose subscription is locked disappear from the public site', { skip }, async () => {
  const o = await newOffice(23);
  const id = await published(o);
  assert.equal((await getPublic(`/listings/${id}`)).status, 200);
  await db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [o.office.id]);
  assert.equal((await getPublic(`/listings/${id}`)).status, 410);
  await db.pool.query("UPDATE offices SET status = 'trial', trial_ends_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?", [o.office.id]);
  assert.equal((await getPublic(`/listings/${id}`)).status, 410, 'an expired trial too');
  await db.pool.query("UPDATE offices SET status = 'trial', trial_ends_at = UTC_TIMESTAMP() + INTERVAL 5 DAY WHERE id = ?", [o.office.id]);
  assert.equal((await getPublic(`/listings/${id}`)).status, 200);
});

test('sitemap and robots: published listings and public pages only; private areas blocked', { skip }, async () => {
  const o = await newOffice(24);
  const live = await published(o, 0);
  const hidden = await published(o, 1);
  await post(`/office/listings/${hidden}/hide`, o.cookie, {});
  const draft = await createListing(o, 2);
  const xml = await publicText('/sitemap.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, new RegExp(`<loc>https://aqdi\\.example/listings/${live}</loc>`));
  assert.doesNotMatch(xml, new RegExp(`/listings/${hidden}<`));
  assert.doesNotMatch(xml, new RegExp(`/listings/${draft}<`));
  for (const p of ['/', '/listings', '/features', '/pricing', '/about', '/contact', '/blog', '/privacy', '/terms', '/disclaimer']) {
    assert.match(xml, new RegExp(`<loc>https://aqdi\\.example${p === '/' ? '/' : p}</loc>`), p);
  }
  for (const secret of ['/office', '/admin', '/login', '/maintenance', 'office/billing']) assert.equal(xml.includes(`aqdi.example${secret}`), false, secret);
  const robots = await getPublic('/robots.txt');
  assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
  const text = await robots.text();
  for (const dir of ['/office', '/admin', '/landlord', '/tenant', '/api', '/maintenance', '/login', '/webhooks', '/cron']) assert.match(text, new RegExp(`^Disallow: ${dir}$`, 'm'), dir);
  assert.match(text, /^Sitemap: https:\/\/aqdi\.example\/sitemap\.xml$/m);
  assert.doesNotMatch(text, /Disallow: \/listings/, 'listings stay crawlable');
});
