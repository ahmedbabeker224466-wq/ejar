'use strict';

// AI contract reading end to end over HTTP against real MySQL, with the
// Claude API mocked (no real call). Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { installClaudeMock, modelReply, fakePdf } = require('./helpers/claudeMock');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000005NN.
const phone = (n) => `9665000005${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 30 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let mock;
let ai;
let engine;
let dates;
let TODAY;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'CLAUDE_API_KEY', 'CLAUDE_MODEL']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  process.env.CLAUDE_API_KEY = 'test-key-not-real';
  delete process.env.CLAUDE_MODEL;
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query("INSERT IGNORE INTO plans (code, name_ar, price_monthly, price_yearly, sort_order) VALUES ('trial', 'تجربة', 0, 0, 1)");
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_ai_reads_monthly, is_active, sort_order)
     VALUES ('test_ai_2', 'اختبار قراءتين', 1, 1, NULL, NULL, 2, 0, 95), ('test_ai_none', 'اختبار بلا حد', 1, 1, NULL, NULL, NULL, 0, 96)
     ON DUPLICATE KEY UPDATE max_ai_reads_monthly = VALUES(max_ai_reads_monthly), max_units = NULL, max_contracts = NULL, is_active = 0`,
  );
  ai = require('../services/aiContractReader');
  engine = require('../services/contractEngine');
  dates = require('../services/contractDates');
  TODAY = dates.riyadhDate(new Date());
  mock = installClaudeMock();
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
  if (mock) mock.restore();
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

test.beforeEach(() => {
  if (!TEST_DB) return;
  mock.state.calls.length = 0;
  mock.state.reply = null;
  ai.settings.timeoutMs = 30 * 1000;
  process.env.CLAUDE_API_KEY = 'test-key-not-real';
});

// ------------------------------------------------------------ helpers

const months = (start, n) => dates.addDays(dates.addMonths(start, n), -1);

function reading(extra = {}) {
  const start = TODAY;
  return { start_date: start, end_date: months(start, 12), annual_rent: 48000, payment_frequency: 'quarterly', city: 'Jeddah', ejar_contract_number: '10293847561', ...extra };
}

async function office(n, name, plan = 'test_ai_none') {
  const owner = await http.registerOffice(phone(n), name);
  await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', [plan, owner.office.id]);
  return owner;
}

/** POSTs a file as multipart/form-data, like the upload form does. */
async function upload(cookie, { bytes = fakePdf(), type = 'application/pdf', name = 'contract.pdf', field = 'contract' } = {}) {
  const form = new FormData();
  if (bytes !== null) form.append(field, new Blob([bytes], { type }), name);
  const response = await fetch(`${http.base()}/office/contracts/new/ai`, {
    method: 'POST', headers: { Cookie: cookie, Origin: http.base() }, body: form, redirect: 'manual',
  });
  return { status: response.status, text: await response.text() };
}

async function usage(officeId) {
  const [[row]] = await db.pool.query('SELECT COALESCE(SUM(count), 0) AS n FROM ai_reads_usage WHERE office_id = ?', [officeId]);
  return Number(row.n);
}

const valueOf = (html, id) => {
  const match = new RegExp(`id="${id}"[^>]*value="([^"]*)"`).exec(html);
  return match ? match[1] : null;
};

// ------------------------------------------------------------ the flow

test('happy path: the same contract form, prefilled, marked, engine deadlines; saving keeps source ai', { skip }, async () => {
  const o = await office(1, 'مكتب القراءة');
  const page = await http.request('/office/contracts/new/ai', { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /لا نحتفظ بالملف ولا بأسماء الأطراف، نقرأ التواريخ والمبالغ فقط/);
  assert.match(page.text, /enctype="multipart\/form-data"/);
  assert.match((await http.request('/office/contracts/new', { cookie: o.cookie })).text, /href="\/office\/contracts\/new\/ai"[^>]*>قراءة من ملف/);

  mock.state.reply = modelReply({ ...reading(), notice_deadline: '1999-01-01', tenant_name: 'اسم-سري' });
  const res = await upload(o.cookie);
  assert.equal(res.status, 200);
  assert.equal(mock.state.calls.length, 1);
  assert.match(res.text, /تمت القراءة بالذكاء الاصطناعي، راجع كل رقم قبل الحفظ/);
  assert.match(res.text, /<form method="post" action="\/office\/contracts" novalidate id="contract-form">/, 'the normal form');
  assert.match(res.text, /<input type="hidden" name="source" value="ai">/);
  assert.equal(valueOf(res.text, 'start_date'), TODAY);
  assert.equal(valueOf(res.text, 'end_date'), months(TODAY, 12));
  assert.equal(valueOf(res.text, 'annual_rent'), '48000.00');
  assert.equal(valueOf(res.text, 'contract_number'), '10293847561');
  assert.equal(valueOf(res.text, 'tenant_label'), '', 'the tenant nickname is typed by the person');
  assert.match(res.text, /<option value="جدة" selected>/);
  assert.match(res.text, /<option value="quarterly" selected>/);
  assert.equal((res.text.match(/badge--ai/g) || []).length, 6, 'each prefilled field is marked');
  assert.ok(!/<option value="\d+" selected>/.test(res.text.slice(res.text.indexOf('id="landlord_id"'), res.text.indexOf('id="unit_id"'))), 'no landlord preselected');
  const notice = engine.noticeDeadline(months(TODAY, 12));
  assert.match(res.text, new RegExp(`data-preview="noticeDeadline">${notice}<`), 'deadline from the engine');
  assert.ok(!res.text.includes('1999-01-01') && !res.text.includes('اسم-سري'));
  assert.equal(await usage(o.office.id), 1);
  assert.equal(Number((await db.pool.query('SELECT COUNT(*) AS n FROM contracts WHERE office_id = ?', [o.office.id]))[0][0].n), 0, 'nothing saved yet');

  // The person picks landlord and unit and saves through the normal form.
  const scoped = require('../services/scopeToOffice').scopeToOffice(db.pool, o.office.id);
  const landlordId = await scoped.insert('landlords', { label: 'مالك' });
  const unitId = await scoped.insert('units', { landlord_id: landlordId, label: 'شقة 1', city: 'جدة' });
  const saved = await http.request('/office/contracts', {
    method: 'POST', cookie: o.cookie,
    form: { ...reading(), annual_rent: '48000.00', landlord_id: String(landlordId), unit_id: String(unitId), contract_number: '10293847561', source: 'ai', city: 'جدة', auto_renew: '1' },
  });
  assert.equal(saved.status, 302, saved.text.slice(0, 300));
  const [[c]] = await db.pool.query('SELECT source, notice_deadline FROM contracts WHERE office_id = ?', [o.office.id]);
  assert.deepEqual({ ...c }, { source: 'ai', notice_deadline: notice });
});

test('missing API key: clear Arabic message, no call, manual entry still works', { skip }, async () => {
  const o = await office(2, 'مكتب بلا مفتاح');
  delete process.env.CLAUDE_API_KEY;
  const page = await http.request('/office/contracts/new/ai', { cookie: o.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /قراءة العقد بالذكاء الاصطناعي غير مفعّلة، أدخل البيانات يدوياً/);
  assert.ok(!page.text.includes('enctype="multipart/form-data"'), 'no upload form');
  mock.state.reply = modelReply(reading());
  const res = await upload(o.cookie);
  assert.equal(res.status, 503);
  assert.match(res.text, /غير مفعّلة، أدخل البيانات يدوياً/);
  assert.equal(mock.state.calls.length, 0);
  assert.equal((await http.request('/office/contracts/new', { cookie: o.cookie })).status, 200);
  assert.equal(await usage(o.office.id), 0);
});

test('wrong magic bytes, over 8 MB and empty files are rejected without a call', { skip }, async () => {
  const o = await office(3, 'مكتب الملفات');
  mock.state.reply = modelReply(reading());
  const cases = [
    [{ bytes: Buffer.from('this is plain text, named like a pdf'), type: 'application/pdf', name: 'c.pdf' }, /نوع الملف غير مدعوم/],
    [{ bytes: Buffer.from('GIF89a......pretending'), type: 'image/png', name: 'c.png' }, /نوع الملف غير مدعوم/],
    [{ bytes: Buffer.concat([fakePdf(), Buffer.alloc(8 * 1024 * 1024 + 10, 0x20)]) }, /أكبر من 8 ميجابايت/],
    [{ bytes: Buffer.alloc(0) }, /لم يصل أي ملف/],
    [{ bytes: null }, /لم يصل أي ملف/],
  ];
  for (const [file, message] of cases) {
    const res = await upload(o.cookie, file);
    assert.equal(res.status, 422, String(message));
    assert.match(res.text, message);
  }
  assert.equal(mock.state.calls.length, 0);
  assert.equal(await usage(o.office.id), 0);
});

test('model or network failures: friendly Arabic error, no crash, no usage counted', { skip }, async () => {
  const o = await office(4, 'مكتب الأعطال');
  const cases = [
    [{ status: 500, body: '{"type":"error","error":{"type":"api_error"}}' }, /تعذّرت قراءة الملف الآن/],
    [modelReply('Sorry, this does not look like a contract.'), /لم نتمكن من استخراج بيانات واضحة/],
    [modelReply('{"start_date": '), /لم نتمكن من استخراج بيانات واضحة/],
    ['error', /تعذّرت قراءة الملف الآن/],
  ];
  for (const [reply, message] of cases) {
    mock.state.reply = reply;
    const res = await upload(o.cookie);
    assert.equal(res.status, 502);
    assert.match(res.text, message);
  }
  ai.settings.timeoutMs = 100;
  mock.state.reply = 'timeout';
  const slow = await upload(o.cookie);
  assert.equal(slow.status, 502);
  assert.match(slow.text, /استغرقت القراءة وقتاً طويلاً/);
  assert.equal(await usage(o.office.id), 0, 'failed reads are not counted');
  assert.equal((await http.request('/office/contracts/new', { cookie: o.cookie })).status, 200, 'the app still works');
});

test('monthly plan limit: blocked with no call; offices are counted separately', { skip }, async () => {
  const a = await office(5, 'مكتب الحد أ', 'test_ai_2');
  const b = await office(6, 'مكتب الحد ب', 'test_ai_2');
  mock.state.reply = modelReply(reading());
  assert.equal((await upload(a.cookie)).status, 200);
  assert.equal((await upload(a.cookie)).status, 200);
  const calls = mock.state.calls.length;
  const over = await upload(a.cookie);
  assert.equal(over.status, 429);
  assert.match(over.text, /استخدمت كل قراءات الذكاء الاصطناعي في باقتك لهذا الشهر \(2\)/);
  assert.equal(mock.state.calls.length, calls, 'no API call over the limit');
  assert.equal(await usage(a.office.id), 2);

  assert.equal((await upload(b.cookie)).status, 200, 'office B has its own allowance');
  assert.equal(await usage(b.office.id), 1);
  assert.equal(await usage(a.office.id), 2);
  const [rows] = await db.pool.query('SELECT office_id, month, count FROM ai_reads_usage WHERE office_id IN (?, ?) ORDER BY office_id', [a.office.id, b.office.id]);
  assert.deepEqual(rows.map((r) => [r.office_id, r.month, r.count]), [[a.office.id, dates.riyadhMonth(new Date()), 2], [b.office.id, dates.riyadhMonth(new Date()), 1]]);
  assert.match((await http.request('/office/contracts/new/ai', { cookie: b.cookie })).text, /قراءات هذا الشهر: 1 من 2/);
});

test('parallel reads cannot pass the monthly limit', { skip }, async () => {
  const o = await office(7, 'مكتب السباق', 'test_ai_2');
  mock.state.reply = modelReply(reading());
  const results = await Promise.all([1, 2, 3, 4].map(() => upload(o.cookie)));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.equal(results.filter((r) => r.status === 429).length, 2);
  assert.equal(mock.state.calls.length, 2);
  assert.equal(await usage(o.office.id), 2);
});

test('rate limit: at most 5 requests per office per minute, the 6th makes no call', { skip }, async () => {
  const o = await office(8, 'مكتب السرعة');
  mock.state.reply = modelReply(reading());
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await upload(o.cookie)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(mock.state.calls.length, 5);
});

test('capability: staff may read; landlords and tenants may not', { skip }, async () => {
  const o = await office(9, 'مكتب الصلاحية');
  const staff = await http.addMember(o.office.id, phone(10), 'office_staff');
  mock.state.reply = modelReply(reading());
  assert.equal((await upload(staff)).status, 200);
  await db.pool.query("INSERT INTO users (phone, role) VALUES (?, 'landlord'), (?, 'tenant')", [phone(11), phone(12)]);
  for (const p of [phone(11), phone(12)]) {
    const { cookie } = await http.login(p);
    assert.equal((await http.request('/office/contracts/new/ai', { cookie })).status, 403);
    assert.equal((await upload(cookie)).status, 403);
  }
});

// ------------------------------------------------------------ privacy

test('the file bytes and the model reply never reach the logs or the database', { skip }, async () => {
  const o = await office(13, 'مكتب الخصوصية');
  const MARK = 'ZXQ-PRIVATE-CONTRACT-BYTES-7731';
  const file = fakePdf(MARK);
  const fileB64 = file.toString('base64');
  const REPLY_MARK = 'ZXQ-PRIVATE-MODEL-REPLY-4419';

  const captured = [];
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const capture = (stream) => function captureWrite(chunk, ...rest) {
    captured.push(String(chunk));
    return originals[stream].call(this, chunk, ...rest);
  };
  process.stdout.write = capture('out');
  process.stderr.write = capture('err');
  try {
    mock.state.reply = modelReply({ ...reading(), tenant_name: REPLY_MARK, national_id: '1012345678' });
    assert.equal((await upload(o.cookie, { bytes: file })).status, 200);
    mock.state.reply = modelReply(`not json ${REPLY_MARK}`);
    assert.equal((await upload(o.cookie, { bytes: file })).status, 502);
    mock.state.reply = { status: 500, body: `{"error":"${REPLY_MARK}"}` };
    assert.equal((await upload(o.cookie, { bytes: file })).status, 502);
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  }
  assert.ok(mock.state.calls.some((c) => c.body.includes(fileB64)), 'the file did reach the (mocked) API');
  const logs = captured.join('');
  for (const secret of [MARK, fileB64.slice(0, 40), REPLY_MARK, '1012345678']) assert.ok(!logs.includes(secret), `log leaked ${secret}`);

  // Every text-like column of every table in the test database.
  const [columns] = await db.pool.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND data_type IN ('char','varchar','text','mediumtext','longtext','json','blob','mediumblob','longblob')`,
  );
  for (const { t, c } of columns) {
    for (const secret of [MARK, fileB64.slice(0, 40), REPLY_MARK]) {
      const [[row]] = await db.pool.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE CAST(\`${c}\` AS CHAR) LIKE ?`, [`%${secret}%`]);
      assert.equal(Number(row.n), 0, `${t}.${c} holds ${secret}`);
    }
  }
});
