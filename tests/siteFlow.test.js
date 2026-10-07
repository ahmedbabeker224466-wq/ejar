'use strict';

// The marketing site, legal pages, pricing from the database, the contact form,
// the blog (admin CRUD, escaping, cover, RSS, seeded drafts) and the analytics
// snippet, against real MySQL. Runs only when TEST_DB_NAME is set.

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

// Every phone this file signs in with: 9665000018NN. NN = 00 is the platform admin.
const phone = (n) => `9665000018${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const DISCLAIMER = 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط';
const saved = {};
let db;
let http;
let fx;
let mod;
let admin;
let uploadDir;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'UPLOAD_DIR']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.PLATFORM_ADMIN_PHONE = '0500001800';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-site-'));
  process.env.UPLOAD_DIR = uploadDir;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, is_public, is_active, sort_order) VALUES
       ('site_public', 'اختبار-باقة-معروضة', 77, 770, 1, 1, 601), ('site_private', 'اختبار-باقة-مخفية', 88, 880, 0, 1, 602), ('site_inactive', 'اختبار-باقة-موقوفة', 99, 990, 1, 0, 603)
     ON DUPLICATE KEY UPDATE is_public = VALUES(is_public), is_active = VALUES(is_active)`,
  );
  mod = {
    settings: require('../services/platformSettings'),
    seed: require('../database/seed'),
    site: require('../routes/site'),
    blog: require('../services/blog'),
  };
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'trial' });
  admin = await http.login(phone(0));
  admin.user = await http.userByPhone(phone(0));
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
  await db.pool.query("DELETE FROM plans WHERE code LIKE 'site\\_%'");
  await db.pool.query("DELETE FROM contact_messages WHERE name LIKE 'اختبار-%'");
  await db.pool.query("DELETE FROM faqs WHERE question_ar LIKE 'اختبار-%'");
  await db.pool.query("DELETE FROM blog_posts WHERE slug LIKE 'site-test-%'");
  await db.pool.query("DELETE FROM settings WHERE setting_key IN ('analytics.snippet', 'seller.cr_number')");
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
  if (mod) for (const l of Object.values(mod.site.limiters)) l.counter.reset();
});

const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const count = async (sql, params = []) => Number(Object.values(await one(sql, params))[0]);
const post = (p, cookie, form) => http.request(p, { method: 'POST', cookie, form });
const getPublic = (p) => fetch(`${http.base()}${p}`, { redirect: 'manual' });
const text = async (p) => (await getPublic(p)).text();
const afterOf = (row) => (typeof row.after_json === 'string' ? JSON.parse(row.after_json) : row.after_json);

const PAGES = ['/', '/features', '/pricing', '/about', '/contact', '/privacy', '/terms', '/disclaimer', '/blog', '/listings'];

// ------------------------------------------------------------ the pages

test('every public page: 200, one h1, title, description, canonical, robots, the disclaimer; no cookie', { skip }, async () => {
  for (const p of PAGES) {
    const res = await getPublic(p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${p}: exactly one h1`);
    assert.match(html, /<html lang="ar" dir="rtl">/, p);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/, p);
    assert.match(html, /<title>[^<]{3,}<\/title>/, p);
    assert.match(html, /<meta name="description" content="[^"]{20,}">/, p);
    assert.match(html, /<meta name="robots" content="index,follow">/, p);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://aqdi\\.example${p === '/' ? '/' : p}">`), p);
    assert.match(html, /property="og:title"/, p);
    assert.ok(html.includes(DISCLAIMER), `${p}: the disclaimer is visible`);
    assert.equal(res.headers.get('set-cookie'), null, `${p}: no cookie`);
    assert.match(res.headers.get('cache-control'), /public, max-age=60/, p);
    assert.ok(!/<script(?![^>]*(src=|type="application\/ld\+json"))/.test(html), `${p}: no inline script`);
    assert.ok(!/ style="/.test(html), `${p}: no inline style`);
    assert.ok(!/(googletagmanager|google-analytics|facebook\.net|hotjar)/.test(html), `${p}: no tracker by default`);
  }
  // Blocking scripts: none at all on the home page (deferred own-origin files only elsewhere).
  const home = await text('/');
  assert.equal((home.match(/<script(?![^>]*application\/ld\+json)/g) || []).length, 0);
  // Images carry their size and load lazily.
  const html = await text('/listings');
  for (const tag of html.match(/<img [^>]*>/g) || []) assert.match(tag, /width="\d+" height="\d+"/);
});

test('the disclaimer is visible on every kind of page: public, sign-in, office, admin, invoice', { skip }, async () => {
  const o = await fx.office(1, 'تجربة-موقع-1', { landlords: 0, units: 0 });
  for (const [p, cookie] of [['/login'], ['/register'], ['/office', o.cookie], ['/office/billing', o.cookie], ['/office/settings', o.cookie], ['/admin', admin.cookie], ['/notifications', o.cookie]]) {
    const res = await fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    assert.equal(res.status, 200, p);
    assert.ok((await res.text()).includes(DISCLAIMER), p);
  }
  // Pages behind a login are never indexed.
  assert.match(await text('/login'), /<meta name="robots" content="noindex,nofollow">/);
});

test('no page claims an affiliation with, approval by or compliance with Ejar, REGA or ZATCA', { skip }, async () => {
  const forbidden = [/ZATCA|زاتكا|هيئة الزكاة/i, /REGA|الهيئة العامة للعقار/i, /معتمد(ة)? من/, /مرخّص|مرخص من/, /متوافق(ة)? مع/, /شريك(ة)? (رسمي|معتمد)/, /الموقع الرسمي|رسمياً من/];
  const allowed = /غير تابع|لا يمثّل أي جهة|ليس معتمداً|لا يُعدّ فاتورة إلكترونية معتمدة|لا يدّعي/;
  for (const p of [...PAGES, '/sitemap.xml']) {
    const html = (await text(p)).replace(/<[^>]+>/g, ' ');
    for (const re of forbidden) {
      for (const m of html.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
        const around = html.slice(Math.max(0, m.index - 80), m.index + 80);
        assert.match(around, allowed, `${p}: "${m[0]}" near "${around.replace(/\s+/g, ' ')}"`);
      }
    }
  }
  assert.match(await text('/disclaimer'), /لا يمثّل أي جهة حكومية/);
});

test('legal pages: marked for lawyer review, and the operator details come from the platform settings', { skip }, async () => {
  for (const p of ['/privacy', '/terms', '/disclaimer']) assert.match(await text(p), /يراجعها محامٍ قبل الإطلاق/, p);
  assert.doesNotMatch(await text('/privacy'), /ريال|\b\d{10}\b/, 'no company number is hardcoded');
  await mod.settings.save(db.pool, { [mod.settings.KEYS.sellerCr]: '1234567890' });
  try {
    const html = await text('/about');
    assert.match(html, /1234567890/, 'the CR number printed is the one in the settings');
    assert.match(await text('/privacy'), /1234567890/);
  } finally {
    await mod.settings.save(db.pool, { [mod.settings.KEYS.sellerCr]: '' });
  }
  assert.doesNotMatch(await text('/about'), /1234567890/);
});

test('pricing comes from the database: public active plans only, prices before VAT; the home page and FAQ too', { skip }, async () => {
  const pricing = await text('/pricing');
  assert.match(pricing, /اختبار-باقة-معروضة/);
  assert.match(pricing, /77\.00/);
  assert.match(pricing, /770\.00/);
  assert.doesNotMatch(pricing, /اختبار-باقة-مخفية/);
  assert.doesNotMatch(pricing, /اختبار-باقة-موقوفة/);
  assert.match(pricing, /قبل ضريبة القيمة المضافة \(15%\)/);
  assert.match(await text('/'), /اختبار-باقة-معروضة/);
  // The FAQ comes from the faqs table (the built-in answers are only a fallback).
  await db.pool.query("INSERT INTO faqs (question_ar, answer_ar, sort_order, is_active) VALUES ('اختبار-سؤال-ظاهر؟', 'جواب-ظاهر', 999, 1), ('اختبار-سؤال-مخفي؟', 'جواب-مخفي', 1000, 0)");
  const home = await text('/');
  assert.match(home, /اختبار-سؤال-ظاهر/);
  assert.doesNotMatch(home, /اختبار-سؤال-مخفي/);
  assert.match(home, /<details class="faq__item">/);
});

// ------------------------------------------------------------ contact

test('contact form: stored for the platform admin with a notification; validated, honeypot, 5 per hour per IP', { skip }, async () => {
  const send = (form) => post('/contact', null, form);
  assert.equal((await send({ name: 'اختبار-زائر', message: 'مرحبا' })).status, 422, 'a phone or an email is needed');
  assert.equal((await send({ name: 'اختبار-زائر', phone: '0555000111', message: '' })).status, 422);
  assert.equal((await send({ name: 'اختبار-زائر', phone: '0555000111', message: 'x'.repeat(1001) })).status, 422);
  assert.equal((await send({ name: 'اختبار-زائر', phone: '0555000111', message: 'see https://spam.example' })).status, 422);
  mod.site.limiters.contactIp.counter.reset();
  const ok = await send({ name: 'اختبار-زائر <b>x</b>', phone: '0555000111', email: 'v@example.com', message: 'أريد معلومات عن الباقات <script>alert(1)</script>' });
  assert.equal(ok.location, '/contact?sent=1');
  const row = await one("SELECT * FROM contact_messages WHERE name LIKE 'اختبار-زائر%' ORDER BY id DESC LIMIT 1");
  assert.equal(row.phone, '966555000111');
  assert.equal(row.email, 'v@example.com');
  assert.match(await text('/contact?sent=1'), /وصلتنا رسالتك/);
  const note = await one("SELECT * FROM notifications WHERE user_id = ? AND kind = 'contact_new' ORDER BY id DESC LIMIT 1", [admin.user.id]);
  assert.ok(note, 'the admin is notified');
  assert.doesNotMatch(`${note.title} ${note.body}`, /0555|966555|v@example|الباقات/);

  // The admin reads it escaped and closes it with a reason.
  const list = await http.request('/admin/messages', { cookie: admin.cookie });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes('<script>alert(1)'));
  assert.match(list.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((await http.request('/admin/messages')).status, 302);
  assert.equal((await post(`/admin/messages/${row.id}/handled`, admin.cookie, { reason: '' })).status, 422);
  assert.equal((await post(`/admin/messages/${row.id}/handled`, admin.cookie, { reason: 'تم الرد بالهاتف' })).location, '/admin/messages?done=handled');
  assert.ok((await one('SELECT handled_at FROM contact_messages WHERE id = ?', [row.id])).handled_at);
  const audit = await one("SELECT * FROM audit_logs WHERE action = 'admin.message.handled' AND entity_id = ? ORDER BY id DESC LIMIT 1", [row.id]);
  assert.equal(audit.actor_id, admin.user.id);
  assert.equal(afterOf(audit).reason, 'تم الرد بالهاتف');

  // Honeypot: nothing stored.
  const before = await count("SELECT COUNT(*) FROM contact_messages WHERE name LIKE 'اختبار-%'");
  assert.equal((await send({ name: 'اختبار-روبوت', phone: '0555000111', message: 'spam', website: 'http://x' })).location, '/contact?sent=1');
  assert.equal(await count("SELECT COUNT(*) FROM contact_messages WHERE name LIKE 'اختبار-%'"), before);
  // 5 per hour per IP.
  mod.site.limiters.contactIp.counter.reset();
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await send({ name: `اختبار-سريع-${i}`, phone: '0555000111', message: `رسالة ${i}` })).status);
  assert.deepEqual(codes, [302, 302, 302, 302, 302, 429, 429]);
});

// ------------------------------------------------------------ blog

const PNG = () => sharp({ create: { width: 800, height: 450, channels: 3, background: '#336699' } }).withExif({ IFD0: { ImageDescription: 'SECRETGPSMARKER' } }).jpeg().toBuffer();

test('blog admin: create a draft with a reason, drafts are invisible, publishing shows it escaped, RSS, sitemap, cover, edit, delete', { skip }, async () => {
  const form = {
    slug: 'site-test-one', title_ar: 'مقال اختبار & <b>عنوان</b>', excerpt_ar: 'ملخص "اختبار" <i>x</i>',
    body_ar: '## عنوان فرعي\n\nنص **غامق** <script>alert(1)</script> [سيء](javascript:alert(1)) [جيد](https://example.com)\n\n- بند',
    meta_title: 'عنوان الميتا', meta_description: 'وصف الميتا للمقال', status: 'draft', needs_review: '1', reason: 'مقال جديد',
  };
  const create = (extra = {}, files = []) => fx.multipart('/admin/blog', admin.cookie, { ...form, ...extra }, files);
  assert.equal((await create({ reason: '' })).status, 422);
  assert.equal((await create({ slug: 'Bad Slug' })).status, 422);
  assert.equal((await create({ body_ar: 'قصير' })).status, 422);
  assert.equal((await fx.multipart('/admin/blog', (await fx.person(5)).cookie, form)).status, 403, 'office users cannot');
  assert.equal(await count("SELECT COUNT(*) FROM blog_posts WHERE slug LIKE 'site-test-%'"), 0);
  const made = await create();
  assert.equal(made.location, '/admin/blog?done=created', made.text.slice(0, 300));
  const post1 = await one("SELECT * FROM blog_posts WHERE slug = 'site-test-one'");
  assert.equal(post1.status, 'draft');
  assert.equal(post1.needs_review, 1);
  assert.equal(post1.published_at, null);
  assert.equal((await create()).status, 422, 'duplicate slug');
  assert.match((await http.request('/admin/blog', { cookie: admin.cookie })).text, /يحتاج مراجعة قبل النشر/);

  // A draft is not public anywhere.
  assert.equal((await getPublic('/blog/site-test-one')).status, 404);
  assert.doesNotMatch(await text('/blog'), /site-test-one/);
  assert.doesNotMatch(await text('/sitemap.xml'), /site-test-one/);
  assert.doesNotMatch(await text('/blog/feed.xml'), /site-test-one/);

  // Publish with a cover.
  const cover = { field: 'cover', name: 'c.jpg', type: 'image/jpeg', data: await PNG() };
  const edit = await fx.multipart(`/admin/blog/${post1.id}`, admin.cookie, { ...form, status: 'published', needs_review: '', reason: 'اعتماد المقال' }, [cover]);
  assert.equal(edit.location, '/admin/blog?done=saved', edit.text.slice(0, 300));
  const live = await one('SELECT * FROM blog_posts WHERE id = ?', [post1.id]);
  assert.equal(live.status, 'published');
  assert.ok(live.published_at);
  assert.match(live.cover_path, /^[0-9a-f-]{36}\.jpg$/);
  assert.ok(!fs.readFileSync(path.join(uploadDir, live.cover_path)).includes(Buffer.from('SECRETGPSMARKER')), 'EXIF stripped from the cover');

  const page = await text('/blog/site-test-one');
  assert.ok(!page.includes('<script>alert(1)'), 'raw HTML in the body is escaped');
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(page, /href="javascript/);
  assert.match(page, /\[سيء\]\(javascript:alert\(1\)\)/);
  assert.match(page, /<a href="https:\/\/example\.com" rel="nofollow noopener noreferrer">جيد<\/a>/);
  assert.match(page, /<h2>عنوان فرعي<\/h2>/);
  assert.equal((page.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(page, /<h1>مقال اختبار &amp; &lt;b&gt;عنوان&lt;\/b&gt;<\/h1>/, 'the title is escaped');
  assert.match(page, /<title>عنوان الميتا \| عقدي<\/title>/);
  assert.match(page, /<meta name="description" content="وصف الميتا للمقال">/);
  assert.match(page, /"@type":"BlogPosting"/);
  assert.match(page, /<link rel="canonical" href="https:\/\/aqdi\.example\/blog\/site-test-one">/);
  assert.match(page, /rel="alternate" type="application\/rss\+xml"/);
  assert.match(await text('/blog'), /site-test-one/);
  assert.match(await text('/sitemap.xml'), /<loc>https:\/\/aqdi\.example\/blog\/site-test-one<\/loc>/);

  const rss = await getPublic('/blog/feed.xml');
  assert.match(rss.headers.get('content-type'), /application\/rss\+xml/);
  const xml = await rss.text();
  assert.match(xml, /<link>https:\/\/aqdi\.example\/blog\/site-test-one<\/link>/);
  assert.ok(!xml.includes('<b>') && !xml.includes('<script>'));
  assert.match(xml, /&lt;b&gt;عنوان&lt;\/b&gt;/);

  // The cover is served for the published post only.
  const img = await getPublic('/blog/site-test-one/cover');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /public/);
  assert.equal((await getPublic('/blog/nothing-here/cover')).status, 404);
  for (const bad of ['..%2F..%2Fetc', 'a', 'x'.repeat(200), '%00']) assert.equal((await getPublic(`/blog/${bad}`)).status, 404, bad);

  // Back to draft: everything disappears again. Delete removes the cover file.
  await fx.multipart(`/admin/blog/${post1.id}`, admin.cookie, { ...form, status: 'draft', reason: 'سحب المقال' });
  assert.equal((await getPublic('/blog/site-test-one')).status, 404);
  assert.equal((await getPublic('/blog/site-test-one/cover')).status, 404);
  assert.equal((await post(`/admin/blog/${post1.id}/delete`, admin.cookie, { reason: '' })).status, 422);
  assert.ok(fs.existsSync(path.join(uploadDir, live.cover_path)));
  assert.equal((await post(`/admin/blog/${post1.id}/delete`, admin.cookie, { reason: 'حذف المقال التجريبي' })).location, '/admin/blog?done=deleted');
  assert.equal(await count("SELECT COUNT(*) FROM blog_posts WHERE slug = 'site-test-one'"), 0);
  assert.ok(!fs.existsSync(path.join(uploadDir, live.cover_path)), 'the cover file is deleted');
  for (const action of ['admin.blog.create', 'admin.blog.update', 'admin.blog.delete']) {
    const row = await one('SELECT * FROM audit_logs WHERE action = ? AND actor_id = ? ORDER BY id DESC LIMIT 1', [action, admin.user.id]);
    assert.ok(row, action);
    assert.ok(afterOf(row).reason.length >= 3, `${action}: reason`);
  }
  // A bad cover is refused and nothing is stored.
  const before = fs.readdirSync(uploadDir).length;
  const bad = await create({ slug: 'site-test-two' }, [{ field: 'cover', name: 'c.jpg', type: 'image/jpeg', data: Buffer.from('not an image at all, just text here') }]);
  assert.equal(bad.status, 422);
  assert.equal(fs.readdirSync(uploadDir).length, before);
  assert.equal(await count("SELECT COUNT(*) FROM blog_posts WHERE slug = 'site-test-two'"), 0);
});

test('the three seeded articles are drafts flagged for review, honest, and never public', { skip }, async () => {
  await mod.seed.seedContent(db.pool);
  const second = await mod.seed.seedContent(db.pool);
  assert.deepEqual(second, { posts: 0, faqs: 0 }, 'idempotent');
  const rows = (await db.pool.query("SELECT * FROM blog_posts WHERE slug IN (?)", [mod.seed.BLOG_DRAFTS.map((p) => p.slug)]))[0];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, 'draft');
    assert.equal(row.needs_review, 1);
    assert.match(row.body_ar, /يحتاج مراجعة قبل النشر/);
    assert.match(row.body_ar, /ليست استشارة قانونية|وليست استشارة قانونية|وليس استشارة قانونية/);
    assert.doesNotMatch(row.body_ar, /\b(60|90|30|2025|2030)\b/, 'no rule number outside config/ejarRules.js');
    assert.equal((await getPublic(`/blog/${row.slug}`)).status, 404, row.slug);
  }
  assert.deepEqual(rows.map((r) => r.title_ar).sort(), [
    'تجميد زيادة الإيجار في الرياض: وش يعني للمكتب', 'كيف تتابع مواعيد عقود الإيجار', 'متى يبدأ التجديد وإشعار عدم التجديد',
  ].sort());
  const sitemap = await text('/sitemap.xml');
  for (const row of rows) assert.ok(!sitemap.includes(row.slug));
});

// ------------------------------------------------------------ analytics snippet

test('analytics: empty by default; only an allowlisted script tag is accepted; it shows on public pages only; the policy allows just that provider', { skip }, async () => {
  const get = async (p, cookie) => fetch(`${http.base()}${p}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  const home = await get('/');
  assert.doesNotMatch(await home.text(), /plausible|googletagmanager/);
  assert.doesNotMatch(home.headers.get('content-security-policy'), /plausible/);

  const save = (snippet, reason = 'تفعيل التحليلات') => post('/admin/settings/analytics', admin.cookie, { snippet, reason });
  for (const bad of ['<script>alert(1)</script>', '<script src="https://evil.example/x.js"></script>', '<script src="https://plausible.io/x.js" onload="x()"></script>']) {
    const res = await save(bad);
    assert.equal(res.status, 422, bad);
  }
  assert.equal((await save('<script src="https://plausible.io/js/script.js"></script>', '')).status, 422, 'a reason is required');
  assert.equal(await count("SELECT COUNT(*) FROM settings WHERE setting_key = 'analytics.snippet' AND setting_value <> ''"), 0, 'nothing was saved');
  assert.equal((await http.request('/admin/settings/analytics', { method: 'POST', cookie: (await fx.person(6)).cookie, form: { snippet: '', reason: 'x' } })).status, 403);

  const ok = await save('<script defer data-domain="aqdi.example" src="https://plausible.io/js/script.js"></script>');
  assert.equal(ok.location, '/admin/settings?done=analytics');
  const audit = await one("SELECT * FROM audit_logs WHERE action = 'admin.settings.analytics' AND actor_id = ? ORDER BY id DESC LIMIT 1", [admin.user.id]);
  assert.equal(afterOf(audit).enabled, true);
  assert.equal(afterOf(audit).reason, 'تفعيل التحليلات');
  const page = await get('/pricing');
  const html = await page.text();
  assert.ok(html.includes('<script src="https://plausible.io/js/script.js" defer data-domain="aqdi.example"></script>'));
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/plausible\.io/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/plausible\.io/);
  assert.ok(!/style-src[^;]*plausible/.test(page.headers.get('content-security-policy')));
  // Not on the sign-in pages, the office or the admin area.
  const o = await fx.office(2, 'تجربة-موقع-2', { landlords: 0, units: 0 });
  for (const [p, cookie] of [['/login'], ['/office', o.cookie], ['/admin', admin.cookie]]) assert.ok(!(await (await get(p, cookie)).text()).includes('plausible.io'), p);
  // Clearing it removes it again.
  assert.equal((await save('')).location, '/admin/settings?done=analytics');
  assert.doesNotMatch(await text('/pricing'), /plausible/);
  assert.equal(afterOf(await one("SELECT * FROM audit_logs WHERE action = 'admin.settings.analytics' AND actor_id = ? ORDER BY id DESC LIMIT 1", [admin.user.id])).enabled, false);
});

test('the new admin pages are for the platform admin only', { skip }, async () => {
  const o = await fx.office(3, 'تجربة-موقع-3', { landlords: 0, units: 0 });
  for (const p of ['/admin/reports', '/admin/messages', '/admin/blog', '/admin/blog/new']) {
    assert.equal((await http.request(p)).status, 302, p);
    assert.equal((await http.request(p, { cookie: o.cookie })).status, 403, p);
    assert.equal((await http.request(p, { cookie: admin.cookie })).status, 200, p);
  }
  assert.equal((await http.request('/admin/blog/999999', { cookie: admin.cookie })).status, 404);
  assert.equal((await http.request('/admin/blog/abc', { cookie: admin.cookie })).status, 404);
});
