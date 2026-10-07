'use strict';

// Reminders, the notification center, channels and cron against real MySQL.
// Every outside call goes to a mock (services/channels/transport.setMock and
// email.setMailer); nothing real is ever contacted. Runs only when
// TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000007NN.
const phone = (n) => `9665000007${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const DISCLAIMER = 'تطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط';
const TG_TOKEN = `123456789:${'A'.repeat(35)}`;
const WA_TOKEN = `EAAG${'x'.repeat(40)}`;
const saved = {};
let db;
let http;
let engine;
let dates;
let reminders;
let notifications;
let delivery;
let cron;
let transport;
let joins;
let TODAY;
const calls = [];

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'APP_URL', 'SECRET_BOX_KEY', 'CRON_SECRET', 'SMTP_HOST', 'MAIL_FROM', 'SMTP_FROM']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.SECRET_BOX_KEY = process.env.SECRET_BOX_KEY || 'b'.repeat(64);
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'https://aqdi.example';
  process.env.CRON_SECRET = 'cron-secret-for-tests-0123456789';
  for (const k of ['SMTP_HOST', 'MAIL_FROM', 'SMTP_FROM']) delete process.env[k];
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, is_active, sort_order)
     VALUES ('test_notify_none', 'اختبار الإشعارات', 1, 1, NULL, NULL, 0, 97)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, is_active = 0`,
  );
  engine = require('../services/contractEngine');
  dates = require('../services/contractDates');
  reminders = require('../services/reminders');
  notifications = require('../services/notifications');
  delivery = require('../services/delivery');
  cron = require('../services/cron');
  transport = require('../services/channels/transport');
  joins = require('../services/joins');
  TODAY = dates.riyadhDate(new Date());
  transport.setMock(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/getMe')) return { status: 200, body: JSON.stringify({ ok: true, result: { username: 'aqdi_test_bot' } }) };
    return { status: 200, body: '{"ok":true}' };
  });
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
  if (transport) transport.setMock(null);
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

// ------------------------------------------------------------ helpers

const months = (start, n) => dates.addDays(dates.addMonths(start, n), -1);
const contractIdFrom = (location) => Number(/\/office\/contracts\/(\d+)/.exec(location)[1]);

async function count(sql, params = []) {
  const [[row]] = await db.pool.query(sql, params);
  return Number(Object.values(row)[0]);
}

async function office(n, name, { city = 'جدة' } = {}) {
  const owner = await http.registerOffice(phone(n), name);
  await db.pool.query("UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = 'test_notify_none') WHERE id = ?", [owner.office.id]);
  const { scopeToOffice } = require('../services/scopeToOffice');
  const scoped = scopeToOffice(db.pool, owner.office.id);
  const landlordId = await scoped.insert('landlords', { label: `مالك ${name}`, city });
  const unitIds = [];
  for (let i = 1; i <= 6; i += 1) unitIds.push(await scoped.insert('units', { landlord_id: landlordId, label: `شقة ${i}`, city }));
  return { ...owner, scoped, city, landlordId, unitIds };
}

/** A contract ending on `end` (12 months), created through the office form. */
async function contract(o, unitIndex, end, { frequency = 'annual', start } = {}) {
  const from = start || dates.addDays(dates.addMonths(end, -12), 1);
  const res = await http.request('/office/contracts', {
    method: 'POST',
    cookie: o.cookie,
    form: {
      landlord_id: String(o.landlordId), unit_id: String(o.unitIds[unitIndex]), tenant_label: 'اسم-سري-لا-يظهر',
      start_date: from, end_date: end, annual_rent: '36000', payment_frequency: frequency, city: o.city, auto_renew: '1', ack_warnings: '1',
    },
  });
  assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 300));
  return contractIdFrom(res.location);
}

async function person(n) {
  const { cookie } = await http.login(phone(n));
  return { cookie, user: await http.userByPhone(phone(n)) };
}

async function joinAs(n, code) {
  const p = await person(n);
  const result = await joins.joinWithCode(db.pool, { userId: p.user.id, code });
  assert.equal(result.ok, true);
  return { ...p, user: await http.userByPhone(phone(n)) };
}

async function landlordOf(o, n) {
  await http.request(`/office/landlords/${o.landlordId}/invite`, { method: 'POST', cookie: o.cookie });
  const [[row]] = await db.pool.query(
    'SELECT code FROM invites WHERE landlord_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', [o.landlordId],
  );
  return joinAs(n, row.code);
}

async function tenantOf(contractId, n) {
  const [[row]] = await db.pool.query(
    "SELECT code FROM invites WHERE contract_id = ? AND kind = 'tenant' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1", [contractId],
  );
  return joinAs(n, row.code);
}

async function notesOf(userId, where = '', params = []) {
  const [rows] = await db.pool.query(`SELECT * FROM notifications WHERE user_id = ? ${where} ORDER BY id`, [userId, ...params]);
  return rows;
}

const run = (o, today = TODAY, lastRun = null, now = new Date()) => reminders.computeDueReminders({ pool: db.pool, today, lastRun, now, officeId: o.office.id });

// ------------------------------------------------------------ reminder engine

test('reminders: decision deadline in 7 days reaches office, landlord and tenant once; idempotent', { skip }, async () => {
  const o = await office(1, 'مكتب التذكير');
  const end = dates.addDays(TODAY, 67); // decision deadline = end - 60 = today + 7
  assert.equal(engine.noticeDeadline(end), dates.addDays(TODAY, 7));
  const id = await contract(o, 0, end);
  const landlord = await landlordOf(o, 2);
  const tenant = await tenantOf(id, 3);

  const first = await run(o);
  assert.ok(first.created >= 3, JSON.stringify(first));
  for (const [userId, link] of [[o.user.id, `/office/contracts/${id}`], [landlord.user.id, `/landlord/contracts/${id}`], [tenant.user.id, `/tenant#contract-${id}`]]) {
    const notes = await notesOf(userId, "AND kind = 'decision_60'");
    assert.equal(notes.length, 1, `one decision reminder for ${link}`);
    const n = notes[0];
    assert.equal(n.link, link);
    assert.equal(Number(n.contract_id), id);
    assert.equal(Number(n.office_id), o.office.id);
    assert.ok(n.body.endsWith(DISCLAIMER));
    assert.ok(n.body.includes(engine.noticeDeadline(end)));
    assert.match(n.title, /بعد 7 يوم/);
    assert.doesNotMatch(n.body, /اسم-سري/, 'the tenant label never goes into a message');
    assert.equal(n.dedupe_key, `decision_60:c${id}:${{ [o.user.id]: 'office', [landlord.user.id]: 'landlord', [tenant.user.id]: 'tenant' }[userId]}-${userId}:7:${TODAY}`);
  }
  const before = await count('SELECT COUNT(*) FROM notifications WHERE contract_id = ?', [id]);
  const again = await run(o);
  assert.equal(again.created, 0, 'running twice creates nothing new');
  assert.equal(await count('SELECT COUNT(*) FROM notifications WHERE contract_id = ?', [id]), before);
  await Promise.all([run(o), run(o), run(o)]);
  assert.equal(await count('SELECT COUNT(*) FROM notifications WHERE contract_id = ?', [id]), before, 'parallel runs too');
  // Every notification queued its outside channels once.
  assert.equal(await count('SELECT COUNT(*) FROM delivery_log d JOIN notifications n ON n.id = d.notification_id WHERE n.contract_id = ?', [id]), before * 3);
});

test('catch-up: missed thresholds are sent once marked "متأخر", never more than 3 days back', { skip }, async () => {
  const o = await office(5, 'مكتب الفائت');
  // Threshold 7 fell 2 days ago (inside the window) and 4 days ago (outside).
  const inside = await contract(o, 0, dates.addDays(TODAY, 65));
  const outside = await contract(o, 1, dates.addDays(TODAY, 63));
  const result = await run(o, TODAY, dates.addDays(TODAY, -6));
  assert.ok(result.created > 0);
  const [[late]] = await db.pool.query("SELECT title, dedupe_key FROM notifications WHERE contract_id = ? AND kind = 'decision_60'", [inside]);
  assert.match(late.title, /^متأخر: /);
  assert.ok(late.dedupe_key.endsWith(`:7:${dates.addDays(TODAY, -2)}`));
  const [rows] = await db.pool.query("SELECT title, dedupe_key FROM notifications WHERE contract_id = ? AND kind = 'decision_60'", [outside]);
  assert.deepEqual(rows.map((r) => r.dedupe_key.split(':').slice(-2).join(':')), [`3:${TODAY}`], 'only today\'s 3-day threshold, not the 4-day-old one');
  assert.doesNotMatch(rows[0].title, /متأخر/);
  assert.equal((await run(o, TODAY, dates.addDays(TODAY, -6))).created, 0, 'catch-up is sent once');
});

test('Riyadh contract: freeze notice and reduction reminder only, no rent-increase wording', { skip }, async () => {
  const o = await office(6, 'مكتب الرياض', { city: 'الرياض' });
  const end = dates.addDays(TODAY, 120); // rent-change deadline = today + 30
  const id = await contract(o, 0, end);
  const landlord = await landlordOf(o, 7);
  const tenant = await tenantOf(id, 8);
  await run(o);
  const [rows] = await db.pool.query("SELECT user_id, title, body FROM notifications WHERE contract_id = ? AND kind = 'rent_change_90'", [id]);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const text = `${row.title} ${row.body}`;
    assert.doesNotMatch(text, /رفع|زيادة|تغيير الإيجار/);
    if (Number(row.user_id) === Number(tenant.user.id)) assert.match(text, /تخفيض الإيجار/);
    else assert.match(text, /مجمّد في الرياض/);
  }
  assert.ok(rows.some((r) => Number(r.user_id) === Number(landlord.user.id)));
});

test('payments: due-day reminders for tenant and office; paid, terminated and locked offices get nothing', { skip }, async () => {
  const o = await office(10, 'مكتب الدفعات');
  const id = await contract(o, 0, months(TODAY, 12), { frequency: 'monthly', start: TODAY });
  const tenant = await tenantOf(id, 11);
  const [[first]] = await db.pool.query('SELECT id, due_date FROM contract_payments WHERE contract_id = ? ORDER BY due_date LIMIT 1', [id]);
  assert.equal(first.due_date, TODAY);
  await run(o);
  const due = await notesOf(tenant.user.id, "AND kind = 'payment_due'");
  assert.equal(due.length, 1);
  assert.match(due[0].title, /دفعة مستحقة اليوم/);
  assert.match(due[0].body, /3,000\.00 ريال/);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'payment_due'", [o.user.id]), 1);

  // The second installment, 3 days before its date: paid -> nothing.
  const [[second]] = await db.pool.query('SELECT id, due_date FROM contract_payments WHERE contract_id = ? ORDER BY due_date LIMIT 1 OFFSET 1', [id]);
  await db.pool.query("UPDATE contract_payments SET status = 'paid', paid_at = UTC_TIMESTAMP() WHERE id = ?", [second.id]);
  await run(o, dates.addDays(second.due_date, -3));
  assert.equal(await count('SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE ?', [`payment_due:c${id}p${second.id}:%`]), 0);

  // Terminated: no more reminders.
  const ended = await http.request(`/office/contracts/${id}/terminate`, { method: 'POST', cookie: o.cookie, form: { reason: 'سبب الإنهاء', confirm: '1' } });
  assert.equal(ended.status, 302);
  const [[third]] = await db.pool.query('SELECT id, due_date FROM contract_payments WHERE contract_id = ? ORDER BY due_date LIMIT 1 OFFSET 2', [id]);
  await run(o, dates.addDays(third.due_date, -7));
  assert.equal(await count('SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE ?', [`%:c${id}p${third.id}:%`]), 0);

  // A suspended office gets nothing at all.
  const s = await office(12, 'مكتب موقوف');
  const sid = await contract(s, 0, dates.addDays(TODAY, 67));
  await db.pool.query("UPDATE offices SET status = 'suspended' WHERE id = ?", [s.office.id]);
  assert.equal((await run(s)).offices, 0);
  assert.equal(await count('SELECT COUNT(*) FROM notifications WHERE contract_id = ?', [sid]), 0);
});

test('office rules: a disabled kind sends nothing; custom days are used; owner/manager only; other offices unaffected', { skip }, async () => {
  const o = await office(13, 'مكتب القواعد');
  const other = await office(14, 'مكتب آخر');
  const staff = await http.addMember(o.office.id, phone(15), 'office_staff');
  assert.equal((await http.request('/office/settings/reminders', { cookie: staff })).status, 403);
  assert.equal((await http.request('/office/settings/reminders/rules', { method: 'POST', cookie: staff, form: {} })).status, 403);

  const form = Object.fromEntries(Object.entries(reminders.RULE_KINDS).flatMap(([k, r]) => [[`${k}_enabled`, '1'], [`${k}_days`, r.days.join(',')]]));
  const bad = await http.request('/office/settings/reminders/rules', { method: 'POST', cookie: o.cookie, form: { ...form, decision_60_days: 'abc' } });
  assert.equal(bad.status, 422);
  const ok = await http.request('/office/settings/reminders/rules', {
    method: 'POST', cookie: o.cookie, form: { ...form, decision_60_days: '10', rent_change_90_enabled: '' },
  });
  assert.equal(ok.status, 302);
  const page = await http.request('/office/settings/reminders', { cookie: o.cookie });
  assert.match(page.text, /id="decision_60_days"[^>]*value="10"/);
  const otherPage = await http.request('/office/settings/reminders', { cookie: other.cookie });
  assert.match(otherPage.text, /id="decision_60_days"[^>]*value="60, 45, 30, 14, 7, 3, 1"/, 'the other office keeps the defaults');

  const id = await contract(o, 0, dates.addDays(TODAY, 70)); // deadline today + 10
  const rentEnd = dates.addDays(TODAY, 120);
  const rentId = await contract(o, 1, rentEnd); // rent change deadline today + 30, but the rule is off
  await run(o);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE contract_id = ? AND kind = 'decision_60'", [id]), 1);
  assert.equal(await count("SELECT COUNT(*) FROM notifications WHERE contract_id = ? AND kind = 'rent_change_90'", [rentId]), 0);
});

// ------------------------------------------------------------ delivery

test('delivery: quiet hours defer, one failing channel never blocks others, retries 1m/10m/1h then failed, SMTP missing is skipped', { skip }, async () => {
  const o = await office(20, 'مكتب القنوات');
  const scoped = o.scoped;
  const channelSettings = require('../services/channelSettings');
  assert.equal((await channelSettings.saveWhatsapp(scoped, { phone_number_id: '1234567', token: WA_TOKEN }, o.user.id)).ok, true);
  calls.length = 0;
  assert.equal((await channelSettings.saveTelegram(scoped, { token: TG_TOKEN }, o.user.id)).ok, true);
  const contacts = require('../services/contacts');
  await contacts.useLoginPhone(db.pool, o.user);
  await db.pool.query('UPDATE user_contacts SET telegram_chat_id = ?, telegram_verified_at = UTC_TIMESTAMP() WHERE user_id = ?', ['777001', o.user.id]);
  await db.pool.query('UPDATE users SET email = ? WHERE id = ?', ['owner@example.sa', o.user.id]);

  // 22:00 Riyadh: a non-urgent message waits for 08:00, an urgent one goes now.
  const night = new Date(`${TODAY}T19:00:00Z`);
  const quietId = await notifications.createNotification(db.pool, { userId: o.user.id, officeId: o.office.id, kind: 'digest', title: 'ت', body: 'ب', now: night });
  const [[deferred]] = await db.pool.query("SELECT next_retry_at FROM delivery_log WHERE notification_id = ? AND channel = 'telegram'", [quietId]);
  assert.equal(new Date(deferred.next_retry_at).toISOString(), dates.nextRiyadhClock(night, '08:00').toISOString());
  const urgentId = await notifications.createNotification(db.pool, { userId: o.user.id, officeId: o.office.id, kind: 'decision_60', title: 'عاجل', body: 'اليوم', urgent: true, now: night });
  const [[now]] = await db.pool.query("SELECT next_retry_at FROM delivery_log WHERE notification_id = ? AND channel = 'telegram'", [urgentId]);
  assert.equal(new Date(now.next_retry_at).toISOString(), night.toISOString());

  // WhatsApp answers 500, Telegram works.
  transport.setMock(async (url, options) => {
    calls.push({ url, options });
    return url.includes('graph.facebook.com') ? { status: 500, body: 'secret-reply-body' } : { status: 200, body: '{"ok":true}' };
  });
  calls.length = 0;
  const logged = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await delivery.deliverPending({ pool: db.pool, now: night, limit: 1000000 });
  } finally {
    Object.assign(console, original);
  }
  const state = async (channel) => (await db.pool.query('SELECT * FROM delivery_log WHERE notification_id = ? AND channel = ?', [urgentId, channel]))[0][0];
  assert.equal((await state('telegram')).status, 'sent');
  assert.equal((await state('email')).status, 'skipped');
  assert.equal((await state('email')).error_code, 'smtp_not_configured');
  let wa = await state('whatsapp');
  assert.equal(wa.status, 'pending');
  assert.equal(wa.error_code, 'http_500');
  assert.equal(new Date(wa.next_retry_at).toISOString(), new Date(night.getTime() + 60000).toISOString());
  assert.equal((await db.pool.query("SELECT status FROM delivery_log WHERE notification_id = ? AND channel = 'telegram'", [quietId]))[0][0].status, 'pending', 'the deferred one waits');

  const waCall = calls.find((c) => c.url.includes('graph.facebook.com'));
  assert.equal(JSON.parse(waCall.options.body).to, o.user.phone, 'sent to the verified login phone');
  const all = logged.join('\n');
  for (const secret of [WA_TOKEN, TG_TOKEN, o.user.phone, 'secret-reply-body', 'عاجل']) assert.ok(!all.includes(secret), 'nothing sensitive in the logs');

  for (const [minutes, expect] of [[2, 10], [13, 60]]) {
    const at = new Date(night.getTime() + minutes * 60000);
    await delivery.deliverPending({ pool: db.pool, now: at, limit: 1000000 });
    wa = await state('whatsapp');
    assert.equal(wa.status, 'pending');
    assert.equal(new Date(wa.next_retry_at).toISOString(), new Date(at.getTime() + expect * 60000).toISOString());
  }
  await delivery.deliverPending({ pool: db.pool, now: new Date(night.getTime() + 80 * 60000), limit: 1000000 });
  wa = await state('whatsapp');
  assert.equal(wa.status, 'failed');
  assert.equal(Number(wa.attempts), 4);
  assert.equal(calls.filter((c) => c.url.includes('graph.facebook.com') && JSON.parse(c.options.body).template.components[0].parameters[0].text === 'عاجل').length, 4);

  // delivery_log rows hold no text, address or secret.
  const [rows] = await db.pool.query('SELECT * FROM delivery_log WHERE notification_id IN (?, ?)', [quietId, urgentId]);
  const dump = JSON.stringify(rows);
  for (const secret of [WA_TOKEN, TG_TOKEN, o.user.phone, '777001', 'owner@example.sa', 'عاجل']) assert.ok(!dump.includes(secret));

  // Turning a channel off skips what is still queued.
  await notifications.savePrefs(db.pool, o.user.id, { channels: { email: true, whatsapp: true, telegram: false }, quietStart: '21:00', quietEnd: '08:00' });
  await delivery.deliverPending({ pool: db.pool, now: dates.nextRiyadhClock(night, '08:00'), limit: 1000000 });
  assert.equal((await db.pool.query("SELECT error_code FROM delivery_log WHERE notification_id = ? AND channel = 'telegram'", [quietId]))[0][0].error_code, 'opted_out');
  transport.setMock(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/getMe')) return { status: 200, body: JSON.stringify({ ok: true, result: { username: 'aqdi_test_bot' } }) };
    return { status: 200, body: '{"ok":true}' };
  });
});

test('email with SMTP set goes through the mailer (mocked)', { skip }, async () => {
  const email = require('../services/channels/email');
  const sent = [];
  email.setMailer({ async sendMail(message) { sent.push(message); } });
  process.env.SMTP_HOST = 'smtp.example.sa';
  process.env.MAIL_FROM = 'عقدي <no-reply@example.sa>';
  try {
    const o = await office(21, 'مكتب البريد');
    await db.pool.query('UPDATE users SET email = ? WHERE id = ?', ['mail@example.sa', o.user.id]);
    const id = await notifications.createNotification(db.pool, { userId: o.user.id, officeId: o.office.id, kind: 'test', title: 'عنوان', body: 'نص', urgent: true });
    await delivery.deliverPending({ pool: db.pool, limit: 1000000 });
    assert.equal((await db.pool.query("SELECT status FROM delivery_log WHERE notification_id = ? AND channel = 'email'", [id]))[0][0].status, 'sent');
    const message = sent.find((m) => m.to === 'mail@example.sa');
    assert.equal(message.subject, 'عنوان');
    assert.ok(message.text.endsWith(DISCLAIMER));
  } finally {
    email.setMailer(null);
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_FROM;
  }
});

// ------------------------------------------------------------ channel settings and Telegram linking

test('channel secrets: encrypted at rest, never returned, "مضبوط ✓"; per office; test message to me', { skip }, async () => {
  const o = await office(30, 'مكتب الأسرار');
  const other = await office(31, 'مكتب الجار');
  const wa = await http.request('/office/settings/reminders/whatsapp', { method: 'POST', cookie: o.cookie, form: { phone_number_id: '987654321', token: WA_TOKEN, template_name: 'aqdi_reminder', language: 'ar' } });
  assert.equal(wa.status, 302);
  const tg = await http.request('/office/settings/reminders/telegram', { method: 'POST', cookie: o.cookie, form: { token: TG_TOKEN } });
  assert.equal(tg.status, 302, tg.text.slice(0, 300));

  const [rows] = await db.pool.query('SELECT config_sealed, public_json, webhook_secret_hash FROM channel_settings WHERE office_id = ?', [o.office.id]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const raw = `${row.config_sealed.toString('latin1')} ${JSON.stringify(row.public_json)}`;
    assert.ok(!raw.includes(WA_TOKEN) && !raw.includes(TG_TOKEN) && !raw.includes('987654321'), 'sealed, not plain');
  }
  const page = await http.request('/office/settings/reminders', { cookie: o.cookie });
  assert.match(page.text, /مضبوط ✓/);
  assert.match(page.text, /@aqdi_test_bot/);
  for (const secret of [WA_TOKEN, TG_TOKEN, '987654321']) assert.ok(!page.text.includes(secret), 'never sent back');
  const otherPage = await http.request('/office/settings/reminders', { cookie: other.cookie });
  assert.doesNotMatch(otherPage.text, /مضبوط ✓|aqdi_test_bot/, 'office B does not see office A settings');

  // Blank token keeps the stored one.
  await http.request('/office/settings/reminders/whatsapp', { method: 'POST', cookie: o.cookie, form: { phone_number_id: '', token: '', template_name: 'aqdi_other' } });
  const channelSettings = require('../services/channelSettings');
  const loaded = await channelSettings.loadForSending(o.scoped, 'whatsapp');
  assert.equal(loaded.config.token, WA_TOKEN);
  assert.equal(loaded.settings.template_name, 'aqdi_other');
  const audit = await count("SELECT COUNT(*) FROM audit_logs WHERE office_id = ? AND action = 'channel.saved' AND after_json LIKE ?", [o.office.id, `%${WA_TOKEN.slice(0, 10)}%`]);
  assert.equal(audit, 0, 'audit holds no secret');

  // Test message: WhatsApp needs my confirmed number first.
  const noContact = await http.request('/office/settings/reminders/test/whatsapp', { method: 'POST', cookie: o.cookie });
  assert.equal(noContact.status, 422);
  assert.match(noContact.text, /لا يوجد لديك عنوان/);
  await http.request('/settings/notifications/whatsapp/login-phone', { method: 'POST', cookie: o.cookie });
  calls.length = 0;
  const sent = await http.request('/office/settings/reminders/test/whatsapp', { method: 'POST', cookie: o.cookie });
  assert.equal(sent.status, 200);
  assert.match(sent.text, /تم إرسال رسالة تجربة/);
  assert.equal(calls.filter((c) => c.url.includes('graph.facebook.com/')).length, 1);
  const mail = await http.request('/office/settings/reminders/test/email', { method: 'POST', cookie: o.cookie });
  assert.match(mail.text, /البريد غير مضبوط/);
});

test('Telegram linking via webhook: random per-office secret, unknown secret 404, one-time code', { skip }, async () => {
  const o = await office(40, 'مكتب البوت');
  calls.length = 0;
  await http.request('/office/settings/reminders/telegram', { method: 'POST', cookie: o.cookie, form: { token: TG_TOKEN } });
  const hook = calls.find((c) => c.url.endsWith('/setWebhook'));
  assert.ok(hook, 'the webhook is set through the Bot API');
  const url = JSON.parse(hook.options.body).url;
  const secret = /\/webhooks\/telegram\/([A-Za-z0-9_-]+)$/.exec(url)[1];
  assert.ok(secret.length >= 40);
  assert.ok(url.startsWith('https://aqdi.example/webhooks/telegram/'));

  const t = await person(41);
  await db.pool.query("UPDATE users SET role = 'tenant' WHERE id = ?", [t.user.id]);
  const page = await http.request('/settings/notifications/telegram/code', { method: 'POST', cookie: t.cookie });
  const code = /id="tg-code"[^>]*>([A-Z2-9]{8})</.exec(page.text)[1];
  const [[stored]] = await db.pool.query('SELECT telegram_code_hash FROM user_contacts WHERE user_id = ?', [t.user.id]);
  assert.notEqual(stored.telegram_code_hash, code, 'stored as a hash');

  const post = (s, body) => fetch(`${http.base()}/webhooks/telegram/${s}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const update = (text, chatId = 555001) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chatId, type: 'private' } } });
  assert.equal((await post(`${secret.slice(0, -1)}x`, update(`/start ${code}`))).status, 404);
  assert.equal((await post('short', update(`/start ${code}`))).status, 404);
  assert.equal((await post('../../etc', update('x'))).status, 404);
  const wrong = await post(secret, update('/start ZZZZZZZZ'));
  assert.equal(wrong.status, 200);
  assert.equal((await db.pool.query('SELECT telegram_chat_id FROM user_contacts WHERE user_id = ?', [t.user.id]))[0][0].telegram_chat_id, null);
  const right = await post(secret, update(`/start ${code.toLowerCase()}`));
  assert.equal(right.status, 200);
  const [[linked]] = await db.pool.query('SELECT telegram_chat_id, telegram_verified_at, telegram_code_hash FROM user_contacts WHERE user_id = ?', [t.user.id]);
  assert.equal(linked.telegram_chat_id, '555001');
  assert.ok(linked.telegram_verified_at);
  assert.equal(linked.telegram_code_hash, null, 'one time');
  const reuse = await post(secret, update(`/start ${code}`, 555002));
  assert.equal(reuse.status, 200);
  assert.equal((await db.pool.query('SELECT telegram_chat_id FROM user_contacts WHERE user_id = ?', [t.user.id]))[0][0].telegram_chat_id, '555001');
  const settings = await http.request('/settings/notifications', { cookie: t.cookie });
  assert.match(settings.text, /مربوط ✓/);

  // Saving again rotates the secret: the old URL stops working.
  await http.request('/office/settings/reminders/telegram', { method: 'POST', cookie: o.cookie, form: { token: '' } });
  assert.equal((await post(secret, update('x'))).status, 404);
});

// ------------------------------------------------------------ notification center

test('notification center: only my notifications; mark read, mark all, filter, pagination, bell count', { skip }, async () => {
  const a = await person(50);
  const b = await person(51);
  await db.pool.query("UPDATE users SET role = 'tenant' WHERE id IN (?, ?)", [a.user.id, b.user.id]);
  const ids = [];
  for (let i = 0; i < 23; i += 1) {
    ids.push(await notifications.createNotification(db.pool, {
      userId: a.user.id, kind: i % 2 ? 'payment_due' : 'decision_60', title: `إشعار ${i} <script>`, body: `نص ${i}`, link: '/tenant',
    }));
  }
  const bId = await notifications.createNotification(db.pool, { userId: b.user.id, kind: 'payment_due', title: 'إشعار ب السري', body: 'ب' });

  const page1 = await http.request('/notifications', { cookie: a.cookie });
  assert.equal(page1.status, 200);
  assert.equal((page1.text.match(/class="note note--unread"/g) || []).length, 20);
  assert.match(page1.text, /class="bell__count">23</);
  assert.match(page1.text, /&lt;script&gt;/, 'escaped');
  assert.doesNotMatch(page1.text, /<script>/);
  assert.doesNotMatch(page1.text, /إشعار ب السري/);
  assert.match(page1.text, /صفحة 1 من 2/);
  const page2 = await http.request('/notifications?page=2', { cookie: a.cookie });
  assert.equal((page2.text.match(/class="note /g) || []).length, 3);
  const filtered = await http.request('/notifications?kind=payment_due', { cookie: a.cookie });
  assert.equal((filtered.text.match(/class="note /g) || []).length, 11);

  // B's notification is invisible and untouchable for A.
  assert.equal((await http.request(`/notifications/${bId}/read`, { method: 'POST', cookie: a.cookie })).status, 404);
  assert.equal((await http.request(`/notifications/${bId}/open`, { method: 'POST', cookie: a.cookie })).status, 404);
  assert.equal((await http.request('/notifications/abc/read', { method: 'POST', cookie: a.cookie })).status, 404);
  const read = await http.request(`/notifications/${ids[0]}/read`, { method: 'POST', cookie: a.cookie, form: { back: 'https://evil.example' } });
  assert.equal(read.location, '/notifications');
  const opened = await http.request(`/notifications/${ids[1]}/open`, { method: 'POST', cookie: a.cookie });
  assert.equal(opened.location, '/tenant');
  assert.equal(await notifications.unreadCount(db.pool, a.user.id), 21);
  await http.request('/notifications/read-all', { method: 'POST', cookie: a.cookie });
  assert.equal(await notifications.unreadCount(db.pool, a.user.id), 0);
  assert.equal(await notifications.unreadCount(db.pool, b.user.id), 1, 'B is untouched');
  const bPage = await http.request('/notifications', { cookie: b.cookie });
  assert.match(bPage.text, /إشعار ب السري/);
  assert.doesNotMatch(bPage.text, /إشعار 0/);
  assert.equal((await http.request('/notifications')).status, 302, 'signed out goes to login');
});

test('personal settings: channels and quiet hours saved; WhatsApp by login phone or SMS code', { skip }, async () => {
  const p = await person(60);
  await db.pool.query("UPDATE users SET role = 'landlord' WHERE id = ?", [p.user.id]);
  const page = await http.request('/settings/notifications', { cookie: p.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /value="21:00" selected/);
  assert.match(page.text, /050\*\*\*\*/, 'login phone shown masked');
  const bad = await http.request('/settings/notifications', { method: 'POST', cookie: p.cookie, form: { quiet_start: '25:00', quiet_end: '08:00', email: 'x' } });
  assert.equal(bad.status, 422);
  const ok = await http.request('/settings/notifications', { method: 'POST', cookie: p.cookie, form: { email: 'me@example.sa', whatsapp: '1', quiet_start: '22:00', quiet_end: '07:00' } });
  assert.equal(ok.status, 302);
  const prefs = await notifications.prefsFor(db.pool, p.user.id);
  assert.deepEqual(prefs.channels, { email: false, whatsapp: true, telegram: false });
  assert.equal(prefs.quietStart, '22:00');
  assert.equal((await http.userByPhone(phone(60))).email, 'me@example.sa');

  // A notification now only queues WhatsApp.
  const id = await notifications.createNotification(db.pool, { userId: p.user.id, kind: 'test', title: 't', body: 'b' });
  assert.deepEqual((await db.pool.query('SELECT channel FROM delivery_log WHERE notification_id = ?', [id]))[0].map((r) => r.channel), ['whatsapp']);

  // Another number: confirmed by an SMS code.
  const newPhone = phone(61);
  const change = await http.request('/settings/notifications/whatsapp/change', { method: 'POST', cookie: p.cookie, form: { phone: `0${newPhone.slice(3)}` } });
  assert.equal(change.status, 200);
  assert.match(change.text, /رمز التأكيد المرسل/);
  const { hashCode } = require('../services/otp');
  await db.pool.query("UPDATE otp_codes SET code_hash = ? WHERE phone = ? AND purpose = 'verify' ORDER BY id DESC LIMIT 1", [hashCode(newPhone, '123456'), newPhone]);
  const wrong = await http.request('/settings/notifications/whatsapp/verify', { method: 'POST', cookie: p.cookie, form: { code: '000000' } });
  assert.equal(wrong.status, 422);
  const right = await http.request('/settings/notifications/whatsapp/verify', { method: 'POST', cookie: p.cookie, form: { code: '123456' } });
  assert.equal(right.status, 302);
  const [[c]] = await db.pool.query('SELECT whatsapp_e164, whatsapp_verified_at, whatsapp_pending FROM user_contacts WHERE user_id = ?', [p.user.id]);
  assert.equal(c.whatsapp_e164, `+${newPhone}`);
  assert.ok(c.whatsapp_verified_at);
  assert.equal(c.whatsapp_pending, null);
});

// ------------------------------------------------------------ cron

test('cron: the advisory lock prevents a double run; runJob records cron_runs', { skip }, async () => {
  let runs = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(1); }, 300));
  const results = await Promise.all([cron.runWithLock(db.pool, 'test_lock', slow), cron.runWithLock(db.pool, 'test_lock', slow)]);
  assert.equal(runs, 1);
  assert.deepEqual(results.map((r) => r.skipped || 'ran').sort(), ['locked', 'ran']);

  const conn = await db.pool.getConnection();
  try {
    await conn.query("SELECT GET_LOCK('aqdi:job:expire_invites', 0)");
    assert.equal((await cron.runJob('expire_invites')).skipped, 'locked', 'another process holds it');
  } finally {
    await conn.query("SELECT RELEASE_LOCK('aqdi:job:expire_invites')");
    conn.release();
  }
  const before = await count("SELECT COUNT(*) FROM cron_runs WHERE job_name = 'expire_invites' AND status = 'ok'");
  const done = await cron.runJob('expire_invites');
  assert.equal(done.ok, true);
  assert.equal(await count("SELECT COUNT(*) FROM cron_runs WHERE job_name = 'expire_invites' AND status = 'ok'"), before + 1);
  for (const [name, job] of Object.entries(cron.JOBS)) assert.equal(typeof job.run, 'function', `${name} is a real job`);
  assert.equal((await cron.runJob('nope')).error, 'unknown_job');
  for (const [name, job] of Object.entries(cron.JOBS)) assert.ok(require('node-cron').validate(job.schedule), name);
  assert.equal(Object.keys(cron.JOBS).length, 16); // + listings_expiry and purge_inquiries
});

test('POST /cron/run/:job needs the right X-Cron-Secret and answers only { ok, processed }', { skip }, async () => {
  const post = (job, secret) => fetch(`${http.base()}/cron/run/${job}`, { method: 'POST', headers: secret === undefined ? {} : { 'X-Cron-Secret': secret } });
  assert.equal((await post('expire_invites')).status, 403);
  assert.equal((await post('expire_invites', 'wrong')).status, 403);
  const ok = await post('expire_invites', process.env.CRON_SECRET);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'processed']);
  assert.equal(body.ok, true);
  assert.equal((await post('unknown_job', process.env.CRON_SECRET)).status, 404);
  assert.equal((await fetch(`${http.base()}/cron/run/expire_invites`)).status, 404, 'GET is not a route');
});

test('daily digest and trial check notify the owner once (counts only)', { skip }, async () => {
  const o = await office(70, 'مكتب الملخص');
  await contract(o, 0, dates.addDays(TODAY, 70));
  await http.request('/office', { cookie: o.cookie }); // recompute stages
  const runDigest = () => cron.runJob('digest');
  await runDigest();
  await runDigest();
  const digests = await notesOf(o.user.id, "AND kind = 'digest'");
  assert.equal(digests.length, 1);
  assert.match(digests[0].body, /عقود تحتاج قراراً: 1/);

  await db.pool.query("UPDATE offices SET trial_ends_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?", [o.office.id]);
  await cron.runJob('trial_check');
  await cron.runJob('trial_check');
  assert.equal((await notesOf(o.user.id, "AND kind = 'trial_expired'")).length, 1);
  // An office with an expired trial gets no contract reminders.
  assert.equal((await run(o)).offices, 0);
});

test('office dashboard shows the latest sent notifications with delivery counts', { skip }, async () => {
  const o = await office(80, 'مكتب اللوحة');
  await notifications.createNotification(db.pool, { userId: o.user.id, officeId: o.office.id, kind: 'decision_60', title: 'تذكير اللوحة', body: 'ب', urgent: true });
  await delivery.deliverPending({ pool: db.pool, limit: 1000000 });
  const home = await http.request('/office', { cookie: o.cookie });
  assert.match(home.text, /آخر الإشعارات المرسلة/);
  assert.match(home.text, /تذكير اللوحة/);
  assert.match(home.text, /class="delivery-skipped">3</);
  assert.match(home.text, /class="bell__count">1</);
});
