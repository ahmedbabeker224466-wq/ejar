'use strict';

// Pure OTP rules run everywhere. The full flow against MySQL runs only when
// TEST_DB_NAME is set (see tests/database.test.js).

require('dotenv').config({ quiet: true });
// Point config/db at the test database before anything loads it.
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashCode, rateLimitDecision, lockDecision, LIMITS } = require('../services/otp');

const KEY = Buffer.from('k'.repeat(32));

test('codes are stored as a keyed SHA-256, bound to the phone', () => {
  const hash = hashCode('966512345678', '123456', KEY);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashCode('966512345678', '123456', KEY));
  assert.notEqual(hash, hashCode('966512345679', '123456', KEY), 'same code, other phone');
  assert.notEqual(hash, hashCode('966512345678', '123457', KEY));
  assert.notEqual(hash, hashCode('966512345678', '123456', Buffer.from('x'.repeat(32))), 'other key');
  assert.ok(!hash.includes('123456'));
});

test('rate limit: one request per phone per minute', () => {
  const base = { phoneHourCount: 1, phoneSinceNewest: 20, phoneSinceOldest: 20, ipHourCount: 1, ipSinceOldest: 20 };
  assert.deepEqual(rateLimitDecision(base), { limited: true, retryAfterSec: 40 });
  assert.equal(rateLimitDecision({ ...base, phoneSinceNewest: 60 }).limited, false);
});

test('rate limit: five requests per phone per hour', () => {
  const d = rateLimitDecision({ phoneHourCount: 5, phoneSinceNewest: 300, phoneSinceOldest: 3000, ipHourCount: 5, ipSinceOldest: 3000 });
  assert.deepEqual(d, { limited: true, retryAfterSec: 600 });
  assert.equal(
    rateLimitDecision({ phoneHourCount: 4, phoneSinceNewest: 300, phoneSinceOldest: 3000, ipHourCount: 4, ipSinceOldest: 3000 }).limited,
    false,
  );
});

test('rate limit: twenty requests per IP per hour', () => {
  const d = rateLimitDecision({ phoneHourCount: 0, phoneSinceNewest: null, phoneSinceOldest: 0, ipHourCount: 20, ipSinceOldest: 3500 });
  assert.deepEqual(d, { limited: true, retryAfterSec: 100 });
});

test('lock: five wrong attempts lock the phone for 15 minutes', () => {
  assert.equal(LIMITS.maxWrongAttempts, 5);
  assert.deepEqual(lockDecision({ wrongAttempts: 4, sinceLastAttempt: 10 }), { locked: false, retryAfterSec: 0 });
  assert.deepEqual(lockDecision({ wrongAttempts: 5, sinceLastAttempt: 10 }), { locked: true, retryAfterSec: 890 });
  assert.equal(lockDecision({ wrongAttempts: 5, sinceLastAttempt: 900 }).locked, false, 'unlocks after 15 minutes');
});

// ---------------------------------------------------------------- with MySQL
const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
let db;
let service;
let sent;
const PHONE = '966500000071';

test.before(async () => {
  if (!TEST_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  db = require('../config/db');
  await db.ensureSchema();
  const { createOtpService } = require('../services/otp');
  service = createOtpService({
    pool: db.pool,
    key: KEY,
    send: async (to, message) => {
      sent.push({ to, message });
      return { ok: true, providerRef: 'test', error: null };
    },
  });
});

test.beforeEach(async () => {
  sent = [];
  if (db) await db.pool.query('DELETE FROM otp_codes WHERE phone = ? OR ip = ?', [PHONE, '203.0.113.9']);
});

test.after(async () => {
  if (db) {
    await db.pool.query('DELETE FROM otp_codes WHERE phone = ? OR ip = ?', [PHONE, '203.0.113.9']);
    await db.pool.end();
  }
});

const codeFrom = (message) => /(\d{6})/.exec(message)[1];

test('a code works once, and only its hash is stored', { skip }, async () => {
  assert.deepEqual(await service.request('0500000071', 'login', '203.0.113.9'), { ok: true, phone: PHONE });
  assert.equal(sent[0].to, '+966500000071');
  const code = codeFrom(sent[0].message);

  const [[row]] = await db.pool.query('SELECT code_hash FROM otp_codes WHERE phone = ?', [PHONE]);
  assert.equal(row.code_hash, hashCode(PHONE, code, KEY));
  assert.ok(!row.code_hash.includes(code));

  assert.deepEqual(await service.verify(PHONE, code), { ok: true, phone: PHONE });
  assert.deepEqual(await service.verify(PHONE, code), { ok: false, error: 'invalid' }, 'never reusable');
});

test('an expired code is rejected', { skip }, async () => {
  await service.request(PHONE, 'login', '203.0.113.9');
  const code = codeFrom(sent[0].message);
  await db.pool.query(
    'UPDATE otp_codes SET expires_at = CURRENT_TIMESTAMP - INTERVAL 1 SECOND WHERE phone = ?',
    [PHONE],
  );
  assert.deepEqual(await service.verify(PHONE, code), { ok: false, error: 'invalid' });
});

test('a second request within a minute is refused with the wait time', { skip }, async () => {
  await service.request(PHONE, 'login', '203.0.113.9');
  const second = await service.request(PHONE, 'login', '203.0.113.9');
  assert.equal(second.error, 'rate_limited');
  assert.ok(second.retryAfterSec > 0 && second.retryAfterSec <= 60);
  assert.equal(sent.length, 1);
});

test('five wrong attempts lock the phone, even for the right code', { skip }, async () => {
  await service.request(PHONE, 'login', '203.0.113.9');
  const code = codeFrom(sent[0].message);
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 1; i <= 4; i += 1) {
    assert.deepEqual(await service.verify(PHONE, wrong), { ok: false, error: 'invalid' }, `attempt ${i}`);
  }
  const fifth = await service.verify(PHONE, wrong);
  assert.equal(fifth.error, 'locked');
  assert.ok(fifth.retryAfterSec > 890 && fifth.retryAfterSec <= 900);

  assert.equal((await service.verify(PHONE, code)).error, 'locked');
  assert.equal((await service.request(PHONE, 'login', '203.0.113.9')).error, 'locked');
});
