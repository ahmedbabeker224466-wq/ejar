'use strict';

// End to end through POST /login/verify: where does a platform_admin land
// after a correct phone code, depending on REQUIRE_ADMIN_2FA and NODE_ENV?
// Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
const PHONE = '966500000093';
const saved = {};
let db;
let server;
let base;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'REQUIRE_ADMIN_2FA', 'PLATFORM_ADMIN_PHONE', 'JWT_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.PLATFORM_ADMIN_PHONE = '0500000093';
  db = require('../config/db');
  await db.ensureSchema();
  const app = require('../app');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (server) server.close();
  if (db) {
    await db.pool.query('DELETE FROM users WHERE phone = ?', [PHONE]);
    await db.pool.query('DELETE FROM otp_codes WHERE phone = ?', [PHONE]);
    await db.pool.end();
  }
});

/** Signs in with a valid phone code and returns where the app redirects. */
async function loginWithPhoneCode({ nodeEnv, flag, twofaEnabled }) {
  process.env.NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env.REQUIRE_ADMIN_2FA;
  else process.env.REQUIRE_ADMIN_2FA = flag;

  const { hashCode } = require('../services/otp');
  const auth = require('../services/auth');
  await db.pool.query('DELETE FROM otp_codes WHERE phone = ?', [PHONE]);
  await db.pool.query(
    "INSERT INTO otp_codes (phone, code_hash, purpose, expires_at) VALUES (?, ?, 'login', CURRENT_TIMESTAMP + INTERVAL 5 MINUTE)",
    [PHONE, hashCode(PHONE, '123456')],
  );
  await db.pool.query('DELETE FROM users WHERE phone = ?', [PHONE]);
  if (twofaEnabled) {
    await db.pool.query(
      "INSERT INTO users (phone, role, twofa_enabled, twofa_secret) VALUES (?, 'platform_admin', 1, 'x')",
      [PHONE],
    );
  }

  const loginCookie = auth.signStepToken({ phone: PHONE, sentAt: Date.now() }, 'login-phone', 600);
  const response = await fetch(`${base}/login/verify`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: base,
      Cookie: `aqdi_login=${loginCookie}`,
    },
    body: 'code=123456',
  });
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('aqdi_session='));
  const token = setCookie ? setCookie.split(';')[0].slice('aqdi_session='.length) : null;
  return { status: response.status, location: response.headers.get('location'), session: token ? jwt.decode(token) : null };
}

test('flag false + development: admin signs in with the phone code alone, 12-hour session', { skip }, async () => {
  const result = await loginWithPhoneCode({ nodeEnv: 'development', flag: 'false' });
  assert.equal(result.status, 302);
  assert.equal(result.location, '/platform');
  assert.ok(result.session, 'a session cookie is issued');
  assert.equal(result.session.role, 'platform_admin');
  assert.equal(result.session.exp - result.session.iat, 12 * 60 * 60);
});

test('flag false + production: 2FA setup is still required', { skip }, async () => {
  const result = await loginWithPhoneCode({ nodeEnv: 'production', flag: 'false' });
  assert.equal(result.location, '/login/2fa/setup');
  assert.equal(result.session, null, 'no session before the second factor');
});

test('flag unset: 2FA setup is required', { skip }, async () => {
  const result = await loginWithPhoneCode({ nodeEnv: 'development', flag: undefined });
  assert.equal(result.location, '/login/2fa/setup');
  assert.equal(result.session, null);
});

test('flag false: an admin who already enabled 2FA is still asked for the code', { skip }, async () => {
  const result = await loginWithPhoneCode({ nodeEnv: 'development', flag: 'false', twofaEnabled: true });
  assert.equal(result.location, '/login/2fa');
  assert.equal(result.session, null);
});
