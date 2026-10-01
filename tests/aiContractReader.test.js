'use strict';

// The AI contract reader without a database: file checks, the request it
// sends, reply parsing, privacy filtering, engine validation, and the
// 9-out-of-10 acceptance fixture. https is mocked: no real API call.

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const ai = require('../services/aiContractReader');
const engine = require('../services/contractEngine');
const { installClaudeMock, modelReply, fakePdf } = require('./helpers/claudeMock');

const TODAY = '2026-10-01';
const ENV = { CLAUDE_API_KEY: 'test-key-not-real' };
const GOOD = {
  start_date: '2026-10-01',
  end_date: '2027-09-30',
  annual_rent: 45000,
  payment_frequency: 'quarterly',
  city: 'Riyadh',
  property_type: 'apartment',
  ejar_contract_number: '10293847561',
};

let mock;
test.beforeEach(() => {
  mock = installClaudeMock();
  ai.settings.timeoutMs = 30 * 1000;
});
test.afterEach(() => mock.restore());

// ------------------------------------------------------------ config and files

test('config: no key means disabled; the model defaults to claude-sonnet-4-5', () => {
  assert.equal(ai.aiConfig({}).enabled, false);
  assert.equal(ai.aiConfig({ CLAUDE_API_KEY: '   ' }).enabled, false);
  assert.deepEqual(ai.aiConfig({ CLAUDE_API_KEY: 'k' }), { enabled: true, apiKey: 'k', model: 'claude-sonnet-4-5' });
  assert.equal(ai.aiConfig({ CLAUDE_API_KEY: 'k', CLAUDE_MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
});

test('file type comes from the magic bytes, never the name', async () => {
  assert.equal(ai.detectFileType(fakePdf()), 'application/pdf');
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
  const jpg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  assert.equal(ai.detectFileType(png), 'image/png');
  assert.equal(ai.detectFileType(jpg), 'image/jpeg');
  assert.equal(ai.detectFileType(webp), 'image/webp');
  for (const bad of [Buffer.from('hello world, not a pdf'), Buffer.from('<html><body>pdf</body></html>'), Buffer.alloc(0), Buffer.from('%PDF'), null]) {
    assert.equal(ai.detectFileType(bad), null);
  }
});

test('uploads: empty, too large and wrong type are refused', () => {
  assert.deepEqual(ai.checkUpload(undefined), { ok: false, code: 'empty' });
  assert.deepEqual(ai.checkUpload({ data: Buffer.alloc(0) }), { ok: false, code: 'empty' });
  assert.deepEqual(ai.checkUpload([{ data: fakePdf() }, { data: fakePdf() }]), { ok: false, code: 'empty' }, 'one file only');
  assert.deepEqual(ai.checkUpload({ data: fakePdf(), truncated: true }), { ok: false, code: 'too_large' });
  assert.deepEqual(ai.checkUpload({ data: Buffer.concat([fakePdf(), Buffer.alloc(8 * 1024 * 1024)]) }), { ok: false, code: 'too_large' });
  assert.deepEqual(ai.checkUpload({ data: Buffer.from('MZ\x90\x00 an exe pretending to be a pdf'), mimetype: 'application/pdf', name: 'c.pdf' }), { ok: false, code: 'bad_type' });
  const ok = ai.checkUpload({ data: fakePdf(), mimetype: 'image/png', name: 'c.png' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mime, 'application/pdf', 'the bytes win over the claimed type');
});

test('images are resized to at most 2000px; PDFs are sent as a document block', async () => {
  const big = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#eee' } }).png().toBuffer();
  const block = await ai.contentBlock(big, 'image/png');
  assert.equal(block.type, 'image');
  assert.equal(block.source.media_type, 'image/png');
  const meta = await sharp(Buffer.from(block.source.data, 'base64')).metadata();
  assert.equal(Math.max(meta.width, meta.height), 2000);
  const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#eee' } }).jpeg().toBuffer();
  const smallMeta = await sharp(Buffer.from((await ai.contentBlock(small, 'image/jpeg')).source.data, 'base64')).metadata();
  assert.deepEqual([smallMeta.width, smallMeta.height], [400, 300], 'never enlarged');
  const pdf = await ai.contentBlock(fakePdf(), 'application/pdf');
  assert.deepEqual(pdf, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fakePdf().toString('base64') } });
  await assert.rejects(ai.contentBlock(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('broken')]), 'image/png'), { code: 'bad_file' });
});

// ------------------------------------------------------------ the request

test('the request: Messages API, headers, model, document block first, strict prompt', async () => {
  mock.state.reply = modelReply(GOOD);
  await ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: { ...ENV, CLAUDE_MODEL: 'claude-sonnet-4-5' } });
  assert.equal(mock.state.calls.length, 1);
  const { options, body } = mock.state.calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.path, '/v1/messages');
  assert.equal(options.headers['x-api-key'], 'test-key-not-real');
  assert.equal(options.headers['anthropic-version'], '2023-06-01');
  assert.equal(options.headers['content-type'], 'application/json');
  const sent = JSON.parse(body);
  assert.equal(sent.model, 'claude-sonnet-4-5');
  assert.equal(sent.messages[0].content[0].type, 'document');
  assert.equal(sent.messages[0].content[1].type, 'text');
  for (const phrase of ['Gregorian YYYY-MM-DD', 'Hijri', 'null', 'national ID', 'iqama', 'IBAN', 'phone', 'addresses', 'meter', 'JSON object only']) {
    assert.ok(sent.system.includes(phrase), phrase);
  }
  for (const key of ai.ALLOWED_KEYS) assert.ok(sent.system.includes(`"${key}"`), key);
});

// ------------------------------------------------------------ the reply

test('happy path: fields validated, deadlines and stage from the engine, not the model', async () => {
  mock.state.reply = modelReply({ ...GOOD, notice_deadline: '1999-01-01', stage: 'calm' });
  const result = await ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV });
  assert.deepEqual(result.fields, {
    start_date: '2026-10-01',
    end_date: '2027-09-30',
    annual_rent: '45000.00',
    payment_frequency: 'quarterly',
    city: 'الرياض',
    property_type: 'apartment',
    ejar_contract_number: '10293847561',
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.preview.noticeDeadline, engine.noticeDeadline('2027-09-30'));
  assert.equal(result.preview.rentChangeDeadline, engine.rentChangeDeadline('2027-09-30'));
  assert.equal(result.preview.stage, engine.classifyContract({ start_date: '2026-10-01', end_date: '2027-09-30' }, TODAY));
  assert.ok(!JSON.stringify(result).includes('1999-01-01'), 'the model\'s own deadline is ignored');
});

test('code fences and stray prose around the JSON are tolerated', async () => {
  mock.state.reply = modelReply(`Here you go:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``);
  const result = await ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV });
  assert.equal(result.fields.start_date, '2026-10-01');
  assert.equal(ai.extractJson('no json here'), null);
  assert.equal(ai.extractJson('[1,2,3]'), null);
  assert.equal(ai.extractJson('{"a": 1,}'), null);
});

test('privacy: extra keys, national IDs and IBANs never pass', async () => {
  mock.state.reply = modelReply({
    ...GOOD,
    tenant_name: 'محمد عبدالله',
    landlord_name: 'Saleh',
    national_id: '1012345678',
    iban: 'SA0380000000608010167519',
    phone: '0501234567',
    address: 'حي النرجس، شارع 12',
    ejar_contract_number: '1012345678', // shaped like a national ID
    city: 'SA03 8000 0000 6080 1016 7519', // shaped like an IBAN
  });
  const result = await ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV });
  assert.deepEqual(Object.keys(result.fields).sort(), [...ai.ALLOWED_KEYS].sort());
  assert.equal(result.fields.ejar_contract_number, null);
  assert.equal(result.fields.city, null);
  const text = JSON.stringify(result);
  for (const secret of ['محمد', 'Saleh', '1012345678', 'SA0380000000608010167519', '6080 1016', '0501234567', 'النرجس']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.ok(result.warnings.some((w) => w.code === 'ejar_contract_number_dropped'));
  assert.ok(result.warnings.some((w) => w.code === 'city_dropped'));
  for (const v of ['1012345678', '2123456789', 'رقم 1012345678', 'SA03 8000 0000 6080 1016 7519', 'sa0380000000608010167519']) {
    assert.equal(ai.looksSensitive(v), true, v);
  }
  for (const v of ['10293847561', '45000', '2026-10-01', '3012345678', 'Riyadh']) assert.equal(ai.looksSensitive(v), false, v);
});

test('invalid values become null with an Arabic warning; inconsistent dates are dropped', () => {
  const { fields, warnings } = ai.sanitizeFields({
    start_date: '2026-02-30', end_date: '30/09/2027', annual_rent: -5, payment_frequency: 'weekly', city: 'Atlantis', property_type: 'castle',
  }, TODAY);
  assert.deepEqual(Object.values(fields), Array(7).fill(null));
  assert.deepEqual(warnings.map((w) => w.code).sort(),
    ['annual_rent_unclear', 'city_unclear', 'end_date_unclear', 'payment_frequency_unclear', 'start_date_unclear']);
  for (const w of warnings) assert.match(w.message_ar, /[؀-ۿ]/);

  const swapped = ai.sanitizeFields({ start_date: '2027-09-30', end_date: '2026-10-01' }, TODAY);
  assert.equal(swapped.fields.start_date, null);
  assert.equal(swapped.fields.end_date, null);
  assert.equal(swapped.warnings[0].code, 'dates_inconsistent');

  assert.equal(ai.sanitizeFields({ city: 'الرياض ' }, TODAY).fields.city, 'الرياض');
  assert.equal(ai.sanitizeFields({ annual_rent: '45,000.50' }, TODAY).fields.annual_rent, '45000.50');
  assert.equal(ai.sanitizeFields({ start_date: { nested: true } }, TODAY).fields.start_date, null);
});

test('garbage, non-JSON, empty JSON, refusal, 500, connection error and timeout: friendly errors, no crash', async () => {
  const cases = [
    [modelReply('I cannot find any contract here.'), 'bad_output'],
    [modelReply('{not json'), 'bad_output'],
    [modelReply({}), 'bad_output'],
    [modelReply({ tenant_name: 'x' }), 'bad_output'],
    [{ status: 200, body: '<html>oops</html>' }, 'bad_output'],
    [modelReply(GOOD, { stopReason: 'refusal' }), 'refused'],
    [{ status: 500, body: '{"type":"error"}' }, 'api_error'],
    [{ status: 401, body: '{"type":"error"}' }, 'api_error'],
    [{ status: 429, body: '{"type":"error"}' }, 'api_error'],
    ['error', 'api_error'],
  ];
  for (const [reply, code] of cases) {
    mock.state.reply = reply;
    await assert.rejects(ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV }), (err) => {
      assert.ok(err instanceof ai.AiReadError, String(err));
      assert.equal(err.code, code);
      assert.match(err.messageAr, /[؀-ۿ]/);
      return true;
    });
  }
  ai.settings.timeoutMs = 50;
  mock.state.reply = 'timeout';
  await assert.rejects(ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV }), { code: 'timeout' });
});

test('missing API key: refused before any call', async () => {
  mock.state.reply = modelReply(GOOD);
  await assert.rejects(ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: {} }), { code: 'not_configured' });
  assert.equal(mock.state.calls.length, 0);
  assert.equal(new ai.AiReadError('not_configured').messageAr, 'قراءة العقد بالذكاء الاصطناعي غير مفعّلة، أدخل البيانات يدوياً');
});

test('a file whose bytes do not match its type is refused before any call', async () => {
  await assert.rejects(ai.readContract({ buffer: Buffer.from('not a pdf at all......'), mime: 'application/pdf', today: TODAY, env: ENV }), { code: 'bad_file' });
  assert.equal(mock.state.calls.length, 0);
});

test('error objects never carry file contents or the model reply', async () => {
  mock.state.reply = modelReply('garbage containing SECRET-REPLY-TEXT and 1012345678');
  const err = await ai.readContract({ buffer: fakePdf('SECRET-FILE-TEXT'), mime: 'application/pdf', today: TODAY, env: ENV }).catch((e) => e);
  const dump = `${err.message} ${err.stack} ${JSON.stringify(err)}`;
  for (const secret of ['SECRET-REPLY-TEXT', 'SECRET-FILE-TEXT', '1012345678']) assert.ok(!dump.includes(secret), secret);
});

// ------------------------------------------------------------ acceptance: 9 of 10

// Ten realistic model outputs. Number 7 has a misread year (2062 instead of
// 2026). The engine's sanity checks must flag exactly that one, and every
// preview deadline must come from the engine.
const FIXTURE = [
  { start_date: '2026-01-01', end_date: '2026-12-31', annual_rent: 36000, payment_frequency: 'monthly', city: 'الرياض' },
  { start_date: '2026-03-15', end_date: '2027-03-14', annual_rent: 52000, payment_frequency: 'quarterly', city: 'Jeddah' },
  { start_date: '2026-06-01', end_date: '2027-05-31', annual_rent: 28000, payment_frequency: 'semiannual', city: 'الدمام' },
  { start_date: '2026-09-01', end_date: '2027-08-31', annual_rent: 120000, payment_frequency: 'annual', city: 'Khobar' },
  { start_date: '2026-01-15', end_date: '2027-01-14', annual_rent: 18000, payment_frequency: 'monthly', city: 'مكة المكرمة' },
  { start_date: '2026-02-01', end_date: '2027-01-31', annual_rent: 65000, payment_frequency: 'quarterly', city: 'Medina' },
  { start_date: '2026-04-01', end_date: '2062-03-31', annual_rent: 40000, payment_frequency: 'monthly', city: 'Riyadh' },
  { start_date: '2026-07-10', end_date: '2027-07-09', annual_rent: 33000, payment_frequency: 'semiannual', city: 'أبها' },
  { start_date: '2026-05-01', end_date: '2028-04-30', annual_rent: 75000, payment_frequency: 'annual', city: 'الطائف' },
  { start_date: '2026-08-20', end_date: '2027-08-19', annual_rent: 48000, payment_frequency: 'quarterly', city: 'Tabuk' },
];

test('acceptance: of 10 readings, the one with a wrong date is caught; the other 9 pass cleanly', async () => {
  const flagged = [];
  for (let i = 0; i < FIXTURE.length; i += 1) {
    mock.state.reply = modelReply(FIXTURE[i]);
    const result = await ai.readContract({ buffer: fakePdf(), mime: 'application/pdf', today: TODAY, env: ENV });
    assert.ok(result.fields.start_date && result.fields.end_date && result.fields.annual_rent && result.fields.city, `reading ${i + 1}`);
    assert.equal(result.preview.noticeDeadline, engine.noticeDeadline(FIXTURE[i].end_date));
    assert.equal(result.preview.rentChangeDeadline, engine.rentChangeDeadline(FIXTURE[i].end_date));
    if (result.warnings.length) flagged.push({ index: i, codes: result.warnings.map((w) => w.code) });
  }
  assert.deepEqual(flagged, [{ index: 6, codes: ['term_too_long'] }]);
  const wrong = engine.describeDeadlines({ start_date: '2026-04-01', end_date: '2062-03-31' }, TODAY);
  assert.ok(wrong.daysToNotice > 10000, 'and its preview deadline is visibly decades away');
});
