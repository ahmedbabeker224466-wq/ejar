'use strict';

require('dotenv').config({ quiet: true });
// Point config/db at the test database before anything loads it.
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { checkSession, homeFor, needsTwoFactor } = require('../services/auth');

const payload = { sub: '7', epoch: 3, jti: 'abc' };
const row = { user_id: 7, revoked_at: null, session_live: 1, is_active: 1, session_epoch: 3 };

test('a current session is valid', () => {
  assert.equal(checkSession(payload, row), null);
});

test('a token with an old session_epoch is rejected', () => {
  assert.equal(checkSession(payload, { ...row, session_epoch: 4 }), 'old_epoch');
});

test('revoked, expired, inactive and mismatched sessions are rejected', () => {
  assert.equal(checkSession(payload, { ...row, revoked_at: new Date() }), 'revoked');
  assert.equal(checkSession(payload, { ...row, session_live: 0 }), 'expired');
  assert.equal(checkSession(payload, { ...row, is_active: 0 }), 'inactive');
  assert.equal(checkSession(payload, { ...row, user_id: 8 }), 'user_mismatch');
  assert.equal(checkSession(payload, undefined), 'unknown_session');
});

test('each role lands in its own area', () => {
  assert.equal(homeFor('platform_admin'), '/platform');
  for (const role of ['office_owner', 'office_manager', 'office_staff']) assert.equal(homeFor(role), '/office');
  assert.equal(homeFor('landlord'), '/landlord');
  assert.equal(homeFor('tenant'), '/tenant');
  assert.equal(homeFor(null), '/office/new', 'no role yet: create an office');
});

test('two-factor is mandatory for platform_admin and optional for office_owner', () => {
  const env = {};
  assert.equal(needsTwoFactor({ role: 'platform_admin', twofa_enabled: 0 }, env), true);
  assert.equal(needsTwoFactor({ role: 'office_owner', twofa_enabled: 0 }, env), false);
  assert.equal(needsTwoFactor({ role: 'office_owner', twofa_enabled: 1 }, env), true);
  assert.equal(needsTwoFactor({ role: 'tenant', twofa_enabled: 1 }, env), false);
});

test('REQUIRE_ADMIN_2FA=false outside production lets platform_admin skip 2FA', () => {
  const admin = { role: 'platform_admin', twofa_enabled: 0 };
  assert.equal(needsTwoFactor(admin, { REQUIRE_ADMIN_2FA: 'false', NODE_ENV: 'development' }), false);
  assert.equal(needsTwoFactor(admin, { REQUIRE_ADMIN_2FA: 'FALSE' }), false, 'NODE_ENV unset is not production');
});

test('REQUIRE_ADMIN_2FA=false is ignored in production', () => {
  const admin = { role: 'platform_admin', twofa_enabled: 0 };
  assert.equal(needsTwoFactor(admin, { REQUIRE_ADMIN_2FA: 'false', NODE_ENV: 'production' }), true);
});

test('REQUIRE_ADMIN_2FA unset or any value other than false keeps 2FA required', () => {
  const admin = { role: 'platform_admin', twofa_enabled: 0 };
  for (const env of [{}, { NODE_ENV: 'development' }, { REQUIRE_ADMIN_2FA: 'true' }, { REQUIRE_ADMIN_2FA: 'no' }, { REQUIRE_ADMIN_2FA: '' }]) {
    assert.equal(needsTwoFactor(admin, env), true, JSON.stringify(env));
  }
});

test('an admin who already enabled 2FA is still asked for the code when the flag is false', () => {
  const admin = { role: 'platform_admin', twofa_enabled: 1 };
  assert.equal(needsTwoFactor(admin, { REQUIRE_ADMIN_2FA: 'false', NODE_ENV: 'development' }), true);
});

// ---------------------------------------------------------------- with MySQL
const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
let db;
let authService;
const PHONE = '966500000072';

function fakeReqRes() {
  const cookies = {};
  const req = { ip: '203.0.113.10', headers: { 'user-agent': 'TestAgent/1.0' }, get: (h) => req.headers[h.toLowerCase()] };
  const res = { cookie: (name, value, options) => { cookies[name] = { value, options }; } };
  return { req, res, cookies };
}

test.before(async () => {
  if (!TEST_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  db = require('../config/db');
  await db.ensureSchema();
  authService = require('../services/auth').createAuthService({ pool: db.pool });
  await db.pool.query('DELETE FROM users WHERE phone = ?', [PHONE]);
});

test.after(async () => {
  if (db) {
    await db.pool.query('DELETE FROM users WHERE phone = ?', [PHONE]);
    await db.pool.end();
  }
});

test('new phones get no role until they create an office; the admin phone gets platform_admin', { skip }, async () => {
  delete process.env.PLATFORM_ADMIN_PHONE;
  const user = await authService.findOrCreateUser(PHONE);
  assert.equal(user.role, null);

  process.env.PLATFORM_ADMIN_PHONE = '0500000072';
  const again = await authService.findOrCreateUser(PHONE);
  assert.equal(again.id, user.id);
  assert.equal(again.role, 'platform_admin');
  delete process.env.PLATFORM_ADMIN_PHONE;
});

test('session cookie is HttpOnly, SameSite=Lax, and dies on logout-all', { skip }, async () => {
  const user = await authService.findOrCreateUser(PHONE);
  const { req, res, cookies } = fakeReqRes();
  await authService.issueSession(req, res, user);

  const { value, options } = cookies.aqdi_session;
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.path, '/');
  const decoded = jwt.decode(value);
  assert.equal(decoded.sub, String(user.id));
  assert.equal(decoded.exp - decoded.iat, 12 * 60 * 60, 'platform_admin sessions last 12 hours');

  assert.equal((await authService.userFromToken(value)).id, user.id);
  const [[device]] = await db.pool.query('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', [user.id]);
  assert.equal(Number(device.n), 1);

  await authService.logoutAll(user.id);
  assert.equal(await authService.userFromToken(value), null, 'old epoch rejected');
});

test('logout revokes only that session', { skip }, async () => {
  const [[fresh]] = await db.pool.query('SELECT * FROM users WHERE phone = ?', [PHONE]);
  const a = fakeReqRes();
  const b = fakeReqRes();
  const idA = await authService.issueSession(a.req, a.res, fresh);
  await authService.issueSession(b.req, b.res, fresh);
  await authService.revokeSession(idA);
  assert.equal(await authService.userFromToken(a.cookies.aqdi_session.value), null);
  assert.ok(await authService.userFromToken(b.cookies.aqdi_session.value));
});

test('a tampered token is rejected', { skip }, async () => {
  const forged = jwt.sign({ sub: '1', epoch: 99, jti: 'x' }, 'wrong-secret', { audience: 'session' });
  assert.equal(await authService.userFromToken(forged), null);
});
