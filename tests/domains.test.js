'use strict';

// Custom domain requests (Prompt 23): domain validation, the one-open-request
// rule (also under parallel submits), plan gating (none / addon / included),
// owner-only create and cancel, tenancy isolation, the admin status flow with
// a written reason, activation (stored on the office, unique, routing
// untouched), the NS propagation check with a stubbed resolver, the office
// notification on every status change, and the launch check helper.
// Database parts run only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const domains = require('../services/domains');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000030NN. Every domain: tdom-*.com.
const phone = (n) => `9665000030${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const local = (n) => `0${phone(n).slice(3)}`;
const saved = {};
let db;
let http;
let admin;

// ------------------------------------------------------------ pure

test('domain validation: lower-case punycode, public names only, never the platform domain', () => {
  const v = (d) => domains.validateDomain(d, { platform: 'aqdi.example.com' });
  assert.deepEqual(v('  MyOffice.SA '), { ok: true, domain: 'myoffice.sa' });
  assert.deepEqual(v('shop.myoffice.com.'), { ok: true, domain: 'shop.myoffice.com' });
  assert.equal(v('مكتب.السعودية').domain, 'xn--ngbd8eh.xn--mgberp4a5d4ar', 'Arabic names become punycode');
  const errors = {
    '': domains.ERRORS.required,
    'https://myoffice.sa': domains.ERRORS.shape,
    'myoffice.sa/path': domains.ERRORS.shape,
    '1.2.3.4': domains.ERRORS.ip,
    '10.0.0.1': domains.ERRORS.ip,
    localhost: domains.ERRORS.reserved,
    'office.localhost': domains.ERRORS.reserved,
    'office.test': domains.ERRORS.reserved,
    '*.myoffice.sa': domains.ERRORS.wildcard,
    'aqdi.example.com': domains.ERRORS.platform,
    'x.aqdi.example.com': domains.ERRORS.platform,
    'example.com': domains.ERRORS.platform,
    'my_office.sa': domains.ERRORS.invalid,
    '-office.sa': domains.ERRORS.invalid,
    'office': domains.ERRORS.invalid,
    'a..sa': domains.ERRORS.invalid,
    [`${'a'.repeat(64)}.sa`]: domains.ERRORS.invalid,
  };
  for (const [input, error] of Object.entries(errors)) assert.deepEqual(v(input), { ok: false, error }, input);
  assert.equal(domains.cleanNameserver(' NS1.Cloud-DNS.net. '), 'ns1.cloud-dns.net');
  assert.equal(domains.cleanNameserver(''), '');
  assert.equal(domains.cleanNameserver('not a host'), null);
});

test('records config comes from the environment and ignores bad values', () => {
  assert.deepEqual(domains.recordsConfig({}), { target: '', ip: '' });
  assert.deepEqual(domains.recordsConfig({ APP_DOMAIN_TARGET: 'Apps.Hosting-co.net', APP_DOMAIN_IP: '203.0.113.7' }), { target: 'apps.hosting-co.net', ip: '203.0.113.7' });
  assert.deepEqual(domains.recordsConfig({ APP_DOMAIN_TARGET: 'http://x', APP_DOMAIN_IP: '999.1.1.1' }), { target: '', ip: '' });
});

test('admin form: only allowed transitions, nameserver and cost checks', () => {
  const at = (status) => ({ status, assigned_ns_1: null, assigned_ns_2: null });
  assert.deepEqual(domains.validateAdminUpdate({ status: 'awaiting_nameservers' }, at('pending_setup')).values, { status: 'awaiting_nameservers' });
  assert.ok(domains.validateAdminUpdate({ status: 'active' }, at('awaiting_dns')).values.status === 'active');
  for (const [from, to] of [['active', 'pending_setup'], ['cancelled', 'active'], ['rejected', 'active'], ['pending_setup', 'cancelled'], ['pending_setup', 'bogus']]) {
    assert.ok(domains.validateAdminUpdate({ status: to }, at(from)).errors.status, `${from} -> ${to}`);
  }
  const r = domains.validateAdminUpdate({ assigned_ns_1: 'ns1.x.com', assigned_ns_2: 'bad host', price_cost: 'abc' }, at('pending_setup'));
  assert.equal(r.values.assigned_ns_1, 'ns1.x.com');
  assert.ok(r.errors.assigned_ns_2 && r.errors.price_cost);
  assert.equal(domains.validateAdminUpdate({ price_cost: '65.50' }, at('pending_purchase')).values.price_cost_halalas, 6550);
});

test('propagation check: a standard NS lookup through a replaceable resolver', async () => {
  const stub = (answer) => ({ resolveNs: async () => { if (answer instanceof Error) throw answer; return answer; } });
  const ok = await domains.checkNameservers('myoffice.sa', { expected: ['NS1.Cloud-dns.net', 'ns2.cloud-dns.net.'], resolver: stub(['ns2.cloud-dns.net', 'ns1.cloud-dns.net.']) });
  assert.deepEqual(ok, { ok: true, ns: ['ns1.cloud-dns.net', 'ns2.cloud-dns.net'], expected: ['ns1.cloud-dns.net', 'ns2.cloud-dns.net'], matches: true });
  const other = await domains.checkNameservers('myoffice.sa', { expected: ['ns1.cloud-dns.net'], resolver: stub(['dns1.registrar.net']) });
  assert.equal(other.matches, false);
  assert.equal((await domains.checkNameservers('myoffice.sa', { resolver: stub(['a.example']) })).matches, null, 'nothing assigned yet');
  const missing = await domains.checkNameservers('myoffice.sa', { resolver: stub(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) });
  assert.deepEqual(missing, { ok: false, error: 'ENOTFOUND', expected: [] });
});

// ------------------------------------------------------------ database

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'APP_DOMAIN_TARGET', 'APP_DOMAIN_IP']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi-test.net';
  process.env.PLATFORM_ADMIN_PHONE = local(99);
  process.env.REQUIRE_ADMIN_2FA = 'false';
  delete process.env.APP_DOMAIN_TARGET;
  delete process.env.APP_DOMAIN_IP;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  for (const [code, mode] of [['test_dom_none', 'none'], ['test_dom_addon', 'addon'], ['test_dom_included', 'included']]) {
    await db.pool.query(
      `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_members, is_active, sort_order, custom_domain)
       VALUES (?, ?, 1, 1, NULL, NULL, 0, 140, ?) ON DUPLICATE KEY UPDATE custom_domain = VALUES(custom_domain), max_members = NULL`,
      [code, `اختبار ${mode}`, mode],
    );
  }
  await db.pool.query("INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ('addons.custom_domain', ?)", [JSON.stringify(require('../services/officialPricing').CUSTOM_DOMAIN_ADDON)]);
  http = createOfficeHttp(db);
  await http.start();
  admin = await http.login(phone(99));
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES), { retries: 5 });
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES);
}

test.after(async () => {
  domains.setResolver(null);
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

const post = (path, cookie, form = {}) => http.request(path, { method: 'POST', cookie, form });
const get = (path, cookie) => http.request(path, { cookie });
async function office(n, mode) {
  const o = await http.registerOffice(phone(n), `تجربة-نطاق-${n}`);
  await db.pool.query(`UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?`, [`test_dom_${mode}`, o.office.id]);
  return o;
}
const requestsOf = async (officeId) => (await db.pool.query('SELECT * FROM office_domain_requests WHERE office_id = ? ORDER BY id', [officeId]))[0];
const auditOf = async (officeId, action) => (await db.pool.query('SELECT * FROM audit_logs WHERE office_id = ? AND action = ? ORDER BY id', [officeId, action]))[0];

test('plan gating: none = locked with an upgrade button, nothing can be requested', { skip }, async () => {
  const o = await office(1, 'none');
  const page = await get('/office/settings', o.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="domain"[\s\S]*نطاق مكتبك/);
  assert.match(page.text, /النطاق الخاص غير متاح في باقتك الحالية[\s\S]*href="\/office\/billing"[^>]*>ترقية الباقة/);
  assert.match(page.text, /aqdi-test\.net\/office-[a-z0-9]{6}/, 'the free link is always shown');
  const res = await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'tdom-none.com' });
  assert.equal(res.status, 422);
  assert.match(res.text, /باقتك لا تشمل نطاقاً مخصصاً/);
  assert.equal((await requestsOf(o.office.id)).length, 0);
});

test('add-on plan: the request is recorded with the add-on price (never charged); one open request at a time', { skip }, async () => {
  const o = await office(2, 'addon');
  const page = await get('/office/settings', o.cookie);
  assert.match(page.text, /إضافة اختيارية بـ <strong>49\.00 ريال شهرياً<\/strong>/);
  assert.match(page.text, /id="domain-type-own"[\s\S]*id="domain-type-reserve"[\s\S]*id="domain-type-none"/);

  const bad = await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'https://tdom-a.com' });
  assert.equal(bad.status, 422);
  assert.ok(bad.text.includes(domains.ERRORS.shape));
  const platform = await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'shop.aqdi-test.net' });
  assert.ok(platform.text.includes(domains.ERRORS.platform));

  const ok = await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'TDOM-A.com', connection_method: 'nameservers' });
  assert.equal(ok.status, 302);
  const [row] = await requestsOf(o.office.id);
  assert.equal(row.domain, 'tdom-a.com');
  assert.equal(row.status, 'pending_setup');
  assert.equal(row.connection_method, 'nameservers');
  assert.equal(row.plan_mode, 'addon');
  assert.equal(Number(row.addon_monthly_halalas), 4900);
  assert.equal(Number(row.service_fee_halalas), 4000);
  assert.equal((await auditOf(o.office.id, 'domain.request')).length, 1);

  const shown = await get('/office/settings', o.cookie);
  assert.match(shown.text, /بانتظار الإعداد/);
  assert.match(shown.text, /سيرسل لك الدعم القيم قريباً/);
  assert.match(shown.text, /إلغاء الطلب/);

  const second = await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'tdom-b.com' });
  assert.equal(second.status, 422);
  assert.match(second.text, /لديك طلب نطاق مفتوح/);
  assert.equal((await requestsOf(o.office.id)).length, 1);
});

test('one open request even under parallel submits (office row locked first)', { skip }, async () => {
  const o = await office(3, 'included');
  const results = await Promise.all([1, 2, 3, 4].map((i) => domains.createRequest(db.pool, { officeId: o.office.id, userId: o.user.id, body: { type: 'own', domain: `tdom-par${i}.com` } })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await requestsOf(o.office.id)).length, 1);
});

test('reserve on an included plan: alternatives, price text, cancel and a new request', { skip }, async () => {
  const o = await office(4, 'included');
  const dup = await post('/office/settings/domain', o.cookie, { type: 'reserve', domain: 'tdom-r.com', alt_1: 'tdom-r.com' });
  assert.equal(dup.status, 422);
  assert.ok(dup.text.includes(domains.ERRORS.duplicate));
  const ok = await post('/office/settings/domain', o.cookie, { type: 'reserve', domain: 'tdom-r.com', alt_1: 'tdom-r2.com', alt_2: 'tdom-r3.sa' });
  assert.equal(ok.status, 302);
  const [row] = await requestsOf(o.office.id);
  assert.equal(row.status, 'pending_purchase');
  const alts = typeof row.alt_domains === 'string' ? JSON.parse(row.alt_domains) : row.alt_domains;
  assert.deepEqual(alts, ['tdom-r2.com', 'tdom-r3.sa']);
  const page = await get('/office/settings', o.cookie);
  assert.match(page.text, /تكلفة الدومين الفعلية \+ رسم خدمة 40\.00 ريال، ويُسجَّل باسم المكتب/);
  assert.match(page.text, /نتحقق من توفر الاسم بعد الطلب/);

  assert.equal((await post(`/office/settings/domain/${row.id}/cancel`, o.cookie)).status, 302);
  assert.equal((await requestsOf(o.office.id))[0].status, 'cancelled');
  assert.equal((await auditOf(o.office.id, 'domain.cancel')).length, 1);
  assert.equal((await post(`/office/settings/domain/${row.id}/cancel`, o.cookie)).status, 404, 'a cancelled request cannot be cancelled again');
  assert.equal((await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'tdom-r4.com', connection_method: 'records' })).status, 302, 'a new request after cancelling');
});

test('only the owner creates or cancels; managers and staff see the section', { skip }, async () => {
  const o = await office(5, 'included');
  const manager = await http.addMember(o.office.id, phone(6), 'office_manager');
  const staff = await http.addMember(o.office.id, phone(7), 'office_staff');
  for (const cookie of [manager, staff]) {
    assert.equal((await post('/office/settings/domain', cookie, { type: 'own', domain: 'tdom-m.com' })).status, 403);
    const page = await get('/office/settings', cookie);
    assert.match(page.text, /نطاق مكتبك/);
    assert.match(page.text, /طلب النطاق الخاص متاح لمالك المكتب فقط/);
  }
  assert.equal((await requestsOf(o.office.id)).length, 0);
  await domains.createRequest(db.pool, { officeId: o.office.id, userId: o.user.id, body: { type: 'own', domain: 'tdom-m.com' } });
  const [row] = await requestsOf(o.office.id);
  assert.equal((await post(`/office/settings/domain/${row.id}/cancel`, manager)).status, 403);
  assert.equal((await requestsOf(o.office.id))[0].status, 'pending_setup');
  assert.equal((await get('/admin/domains', o.cookie)).status === 200, false, 'office owners never reach the admin queue');
});

test('tenancy: office B can neither see nor cancel office A\'s request', { skip }, async () => {
  const a = await office(8, 'included');
  const b = await office(9, 'included');
  await post('/office/settings/domain', a.cookie, { type: 'own', domain: 'tdom-secret-a.com' });
  const [row] = await requestsOf(a.office.id);
  assert.equal((await post(`/office/settings/domain/${row.id}/cancel`, b.cookie)).status, 404);
  assert.equal((await requestsOf(a.office.id))[0].status, 'pending_setup');
  assert.doesNotMatch((await get('/office/settings', b.cookie)).text, /tdom-secret-a/);
  const scopedB = require('../services/scopeToOffice').scopeToOffice(db.pool, b.office.id);
  assert.equal((await scopedB.select('office_domain_requests', { id: row.id })).length, 0);
  assert.equal(await domains.cancelRequest(db.pool, { officeId: b.office.id, userId: b.user.id, requestId: row.id }), false);
});

test('admin: queue, reason required, status flow with notification, NS values shown to the office, propagation, activation', { skip }, async () => {
  const a = await office(10, 'included');
  const b = await office(11, 'included');
  await post('/office/settings/domain', a.cookie, { type: 'own', domain: 'tdom-live.com', connection_method: 'nameservers' });
  await post('/office/settings/domain', b.cookie, { type: 'own', domain: 'tdom-live.com' });
  const [ra] = await requestsOf(a.office.id);
  const [rb] = await requestsOf(b.office.id);

  const list = await get('/admin/domains?status=open', admin.cookie);
  assert.equal(list.status, 200);
  assert.match(list.text, new RegExp(`id="domain-request-${ra.id}"[\\s\\S]*tdom-live\\.com[\\s\\S]*تجربة-نطاق-10`));
  const detail = await get(`/admin/domains/${ra.id}`, admin.cookie);
  assert.match(detail.text, /لا يغيّر توجيه الموقع/);

  const noReason = await post(`/admin/domains/${ra.id}`, admin.cookie, { status: 'awaiting_nameservers' });
  assert.equal(noReason.status, 422);
  assert.equal((await requestsOf(a.office.id))[0].status, 'pending_setup');

  const moved = await post(`/admin/domains/${ra.id}`, admin.cookie, {
    status: 'awaiting_nameservers', assigned_ns_1: 'NS1.Zone-dns.net', assigned_ns_2: 'ns2.zone-dns.net', dns_zone_ref: 'zone-123', admin_note: 'ملاحظة خاصة', reason: 'أسندت القيم',
  });
  assert.equal(moved.status, 302, moved.text.slice(0, 300));
  const after = (await requestsOf(a.office.id))[0];
  assert.deepEqual([after.status, after.assigned_ns_1, after.assigned_ns_2, after.dns_zone_ref], ['awaiting_nameservers', 'ns1.zone-dns.net', 'ns2.zone-dns.net', 'zone-123']);
  const [notes] = await db.pool.query("SELECT * FROM notifications WHERE user_id = ? AND kind = 'domain_update' ORDER BY id", [a.user.id]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /بانتظار تغيير Nameservers/);
  assert.match(notes[0].body, /tdom-live\.com/);
  const [emails] = await db.pool.query("SELECT channel FROM delivery_log WHERE notification_id = ? AND channel = 'email'", [notes[0].id]);
  assert.equal(emails.length, 1, 'queued for email too');
  const [auditRows] = await db.pool.query("SELECT after_json FROM audit_logs WHERE action = 'admin.domain.update' AND entity_id = ?", [ra.id]);
  assert.match(JSON.stringify(auditRows[0].after_json), /أسندت القيم/);

  const officePage = await get('/office/settings', a.cookie);
  assert.match(officePage.text, /غيّر Nameservers الدومين عند مزودك إلى القيمتين التاليتين[\s\S]*ns1\.zone-dns\.net[\s\S]*ns2\.zone-dns\.net/);
  assert.doesNotMatch(officePage.text, /ملاحظة خاصة|zone-123/, 'the admin note and zone ref stay private');

  const wrong = await post(`/admin/domains/${ra.id}`, admin.cookie, { status: 'cancelled', reason: 'اختبار' });
  assert.equal(wrong.status, 422);

  domains.setResolver({ resolveNs: async (name) => (name === 'tdom-live.com' ? ['ns2.zone-dns.net.', 'NS1.zone-dns.net'] : []) });
  const check = await post(`/admin/domains/${ra.id}/check`, admin.cookie);
  assert.equal(check.status, 200);
  assert.match(check.text, /ns1\.zone-dns\.net[\s\S]*مطابقة للقيم المسندة/);
  domains.setResolver({ resolveNs: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  assert.match((await post(`/admin/domains/${ra.id}/check`, admin.cookie)).text, /الدومين غير موجود في DNS/);
  domains.setResolver(null);
  assert.equal((await requestsOf(a.office.id))[0].status, 'awaiting_nameservers', 'the check changes nothing');

  const active = await post(`/admin/domains/${ra.id}`, admin.cookie, { status: 'active', reason: 'تم الربط يدوياً' });
  assert.equal(active.status, 302);
  const [[offA]] = await db.pool.query('SELECT custom_domain FROM offices WHERE id = ?', [a.office.id]);
  assert.equal(offA.custom_domain, 'tdom-live.com');
  assert.ok((await requestsOf(a.office.id))[0].activated_at);
  assert.match((await get('/office/settings', a.cookie)).text, /نطاق مكتبك: <strong dir="ltr">tdom-live\.com<\/strong>/);
  assert.equal((await db.pool.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'domain_update'", [a.user.id]))[0][0].n, 2);

  // The same domain cannot become active for a second office, nor be requested again.
  const clash = await post(`/admin/domains/${rb.id}`, admin.cookie, { status: 'active', reason: 'تجربة' });
  assert.equal(clash.status, 422);
  assert.ok(clash.text.includes(domains.ERRORS.taken));
  const c = await office(12, 'included');
  const taken = await post('/office/settings/domain', c.cookie, { type: 'own', domain: 'tdom-live.com' });
  assert.ok(taken.text.includes(domains.ERRORS.taken));
  assert.match((await post('/office/settings/domain', a.cookie, { type: 'own', domain: 'tdom-new.com' })).text, /لمكتبك نطاق فعّال/);
});

test('records method shows the configured CNAME and A values, or "soon" when empty', { skip }, async () => {
  const o = await office(13, 'included');
  await post('/office/settings/domain', o.cookie, { type: 'own', domain: 'tdom-rec.com', connection_method: 'records' });
  assert.match((await get('/office/settings', o.cookie)).text, /سيرسل لك الدعم القيم قريباً/);
  process.env.APP_DOMAIN_TARGET = 'apps.hosting-co.net';
  process.env.APP_DOMAIN_IP = '203.0.113.7';
  try {
    const page = await get('/office/settings', o.cookie);
    assert.match(page.text, /CNAME www →<\/span><output id="domain-cname">apps\.hosting-co\.net/);
    assert.match(page.text, /A @ →<\/span><output id="domain-a">203\.0\.113\.7/);
  } finally {
    delete process.env.APP_DOMAIN_TARGET;
    delete process.env.APP_DOMAIN_IP;
  }
});

test('launch helper counts open requests unchanged for more than 3 days', { skip }, async () => {
  const o = await office(14, 'included');
  await domains.createRequest(db.pool, { officeId: o.office.id, userId: o.user.id, body: { type: 'own', domain: 'tdom-old.com' } });
  const before = await domains.staleCount(db.pool);
  await db.pool.query('UPDATE office_domain_requests SET updated_at = UTC_TIMESTAMP() - INTERVAL 4 DAY WHERE office_id = ?', [o.office.id]);
  assert.equal(await domains.staleCount(db.pool), before + 1);
});
