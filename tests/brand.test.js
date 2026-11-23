'use strict';

// The brand users see is «ميعاد» / Mi3aad (Prompt 25). Renders the public pages,
// the login and register pages, the 404 page, robots.txt and sitemap.xml, the
// OTP SMS, the WhatsApp invite text and the seeded message templates, and fails
// on «عقدي» or "Aqdi" in any of them. Also: the start-up migration updates only
// seeded defaults that still equal the old text, never edited rows.
// Database parts run only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const rebrand = require('../services/rebrand');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
const OLD = /عقدي|aqdi/i;
// Every phone this file uses: 9665000032NN.
const phone = (n) => `9665000032${String(n).padStart(2, '0')}`;
const saved = {};
let db;
let http;

const assertClean = (label, text) => {
  const m = String(text).match(new RegExp(`.{0,40}(${OLD.source}).{0,40}`, 'i'));
  assert.equal(m, null, `${label} shows the old name: "${m && m[0]}"`);
};

test('pure: the old default of a seeded text, and the seed itself uses the new name', () => {
  assert.equal(rebrand.oldOf('رمز الدخول إلى ميعاد: 1'), 'رمز الدخول إلى عقدي: 1');
  const seed = require('../database/seed');
  for (const t of seed.TEMPLATES) assertClean(`template ${t.code}/${t.channel}`, t.body_ar);
  for (const p of seed.BLOG_DRAFTS) assertClean(`blog ${p.slug}`, `${p.title_ar} ${p.excerpt_ar} ${p.body_ar}`);
  for (const s of seed.SETTINGS) assertClean(`setting ${s.key}`, s.value);
  for (const [q, a] of require('../services/siteContent').DEFAULT_FAQS) assertClean('FAQ', `${q} ${a}`);
  assert.match(require('../services/totp').otpauthUri('JBSWY3DPEHPK3PXP', 'x'), /issuer=Mi3aad/);
  const share = decodeURIComponent(require('../services/invites').inviteShareLink({ code: 'ABCD2345', officeName: 'مكتب', baseUrl: 'https://mi3aad.com' }));
  assert.match(share, /تطبيق ميعاد/);
  assertClean('invite share text', share);
});

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://mi3aad.com';
  db = require('../config/db');
  await db.ensureSchema(); // runs the rebrand migration
  await require('../database/seed').seed(db.pool);
  await require('../database/seed').seedContent(db.pool);
  await rebrand.applyRebrand(db.pool);
  http = createOfficeHttp(db);
  await http.start();
});

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (db) {
    await retryOnDeadlock(() => db.pool.query("DELETE FROM otp_codes WHERE phone LIKE '9665000032%'"), { retries: 5 });
    await db.pool.query("DELETE FROM message_templates WHERE code = 'brand_test_template'");
    await db.pool.end();
  }
});

test('public pages, login, register, 404, robots and sitemap never show the old name', { skip }, async () => {
  const pages = ['/', '/offices', '/features', '/pricing', '/about', '/contact', '/privacy', '/terms', '/disclaimer', '/blog', '/listings', '/login', '/register', '/robots.txt', '/sitemap.xml', '/no-such-page-brand'];
  for (const path of pages) {
    const res = await http.request(path);
    assert.ok([200, 404].includes(res.status), `${path}: ${res.status}`);
    assertClean(path, res.text);
  }
  const home = await http.request('/');
  assert.match(home.text, /<meta property="og:site_name" content="ميعاد">/);
  assert.match(home.text, /© \d{4} جميع الحقوق محفوظة لـ <a href="https:\/\/phillote\.com"/);
  assert.match((await http.request('/about')).text, /<title>[^<]*\| ميعاد<\/title>/);
});

test('the OTP SMS and the stored message templates use the new name', { skip }, async () => {
  let sms = null;
  const otp = require('../services/otp').createOtpService({ send: async (to, text) => { sms = text; return { ok: true }; }, key: 'k'.repeat(64) });
  const result = await otp.request(phone(1), 'login', '10.32.0.1');
  assert.equal(result.ok, true);
  assert.match(sms, /رمز الدخول إلى ميعاد/);
  assertClean('OTP SMS', sms);
  const [rows] = await db.pool.query('SELECT code, channel, body_ar FROM message_templates WHERE office_id IS NULL');
  assert.ok(rows.length > 0);
  for (const r of rows) assertClean(`stored template ${r.code}/${r.channel}`, r.body_ar);
});

test('migration: only defaults that still equal the old text change; edited rows are kept (rolled back)', { skip }, async () => {
  const seed = require('../database/seed');
  const sample = seed.TEMPLATES.find((t) => rebrand.oldOf(t.body_ar) !== t.body_ar);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE message_templates SET body_ar = ? WHERE office_id IS NULL AND code = ? AND channel = ?', [rebrand.oldOf(sample.body_ar), sample.code, sample.channel]);
    // A platform row edited by the admin and an office's own copy keep their text.
    await conn.query("INSERT INTO message_templates (office_id, code, channel, body_ar) VALUES (NULL, 'brand_test_template', 'sms', 'نص عدّله المدير ويذكر عقدي')");
    const [[office]] = await conn.query('SELECT id FROM offices ORDER BY id LIMIT 1');
    if (office) {
      await conn.query('INSERT INTO message_templates (office_id, code, channel, body_ar) VALUES (?, ?, ?, ?)', [office.id, sample.code, sample.channel, rebrand.oldOf(sample.body_ar)]);
    }
    const first = await rebrand.applyRebrand(conn);
    assert.ok(first.changed >= 1);
    const [[platform]] = await conn.query('SELECT body_ar FROM message_templates WHERE office_id IS NULL AND code = ? AND channel = ?', [sample.code, sample.channel]);
    assert.equal(platform.body_ar, sample.body_ar, 'the untouched default moved to the new name');
    const [[edited]] = await conn.query("SELECT body_ar FROM message_templates WHERE code = 'brand_test_template'");
    assert.match(edited.body_ar, /عقدي/, 'an edited text is never changed');
    if (office) {
      const [[own]] = await conn.query('SELECT body_ar FROM message_templates WHERE office_id = ? AND code = ? AND channel = ?', [office.id, sample.code, sample.channel]);
      assert.equal(own.body_ar, rebrand.oldOf(sample.body_ar), 'an office template is never changed');
    }
    assert.deepEqual(await rebrand.applyRebrand(conn), { changed: 0 }, 'idempotent');
  } finally {
    await conn.rollback();
    conn.release();
  }
});
