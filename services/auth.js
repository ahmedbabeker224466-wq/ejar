'use strict';

// Sessions are signed JWT cookies backed by a user_sessions row. A token is
// valid only while its row is not revoked and its session_epoch is at least
// the user's current one, so "log out of all devices" is a single UPDATE.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { normalizeSaudi } = require('../utils/phone');

const SESSION_COOKIE = 'aqdi_session';
const SESSION_AUDIENCE = 'session';
const TTL_SECONDS = {
  default: 7 * 24 * 60 * 60,
  platform_admin: 12 * 60 * 60,
};

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function ttlFor(role) {
  return TTL_SECONDS[role] || TTL_SECONDS.default;
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

/** Signs a short-lived token for one login step (phone entered, 2FA pending). */
function signStepToken(payload, audience, expiresInSeconds) {
  return jwt.sign(payload, jwtSecret(), { algorithm: 'HS256', audience, expiresIn: expiresInSeconds });
}

function verifyStepToken(token, audience) {
  if (!token) return null;
  try {
    return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], audience });
  } catch {
    return null;
  }
}

/** Stable fingerprint of the browser: user agent plus accept headers. */
function deviceFingerprint(headers) {
  const parts = ['user-agent', 'accept', 'accept-language', 'accept-encoding'].map((h) => headers[h] || '');
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function describeDevice(userAgent = '') {
  const os =
    (/Windows/i.test(userAgent) && 'Windows') ||
    (/iPhone|iPad|iOS/i.test(userAgent) && 'iOS') ||
    (/Android/i.test(userAgent) && 'Android') ||
    (/Mac OS X|Macintosh/i.test(userAgent) && 'macOS') ||
    (/Linux/i.test(userAgent) && 'Linux') ||
    null;
  const browser =
    (/Edg\//i.test(userAgent) && 'Edge') ||
    (/SamsungBrowser/i.test(userAgent) && 'Samsung Internet') ||
    (/Chrome\//i.test(userAgent) && 'Chrome') ||
    (/Firefox\//i.test(userAgent) && 'Firefox') ||
    (/Safari\//i.test(userAgent) && 'Safari') ||
    null;
  return { os, browser };
}

/**
 * Pure check of a decoded session token against its database row.
 * Returns null when valid, or the reason it is not.
 */
function checkSession(payload, row) {
  if (!payload || !row) return 'unknown_session';
  if (String(row.user_id) !== String(payload.sub)) return 'user_mismatch';
  if (row.revoked_at) return 'revoked';
  if (!row.session_live) return 'expired';
  if (!row.is_active) return 'inactive';
  if (Number(payload.epoch) < Number(row.session_epoch)) return 'old_epoch';
  return null;
}

function createAuthService({ pool = db.pool } = {}) {
  /** Finds the user for a verified phone, creating a placeholder account if new. */
  async function findOrCreateUser(phone) {
    const adminPhone = normalizeSaudi(process.env.PLATFORM_ADMIN_PHONE || '');
    const isAdmin = adminPhone !== null && adminPhone === phone;

    let [[user]] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!user) {
      try {
        await pool.query('INSERT INTO users (phone, role, phone_verified) VALUES (?, ?, 1)', [
          phone,
          isAdmin ? 'platform_admin' : 'tenant', // placeholder until they join or create an office
        ]);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err; // created by a parallel request
      }
      [[user]] = await pool.query('SELECT * FROM users WHERE phone = ?', [phone]);
    }

    // Bootstrap: the configured admin phone always becomes platform_admin.
    if (isAdmin && user.role !== 'platform_admin') {
      await pool.query("UPDATE users SET role = 'platform_admin' WHERE id = ?", [user.id]);
      user.role = 'platform_admin';
    }
    await pool.query(
      'UPDATE users SET phone_verified = 1, last_seen_at = UTC_TIMESTAMP() WHERE id = ?',
      [user.id],
    );
    return user;
  }

  /** Creates the session row, records the device and sets the cookie. */
  async function issueSession(req, res, user) {
    const ttl = ttlFor(user.role);
    const tokenId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO user_sessions (user_id, token_id, ip, user_agent, expires_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND)`,
      [user.id, tokenId, req.ip || null, (req.get('user-agent') || '').slice(0, 1000), ttl],
    );

    const { os, browser } = describeDevice(req.get('user-agent'));
    await pool.query(
      `INSERT INTO user_devices (user_id, fingerprint, os, browser, country, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE last_seen_at = UTC_TIMESTAMP(), os = VALUES(os), browser = VALUES(browser)`,
      [user.id, deviceFingerprint(req.headers), os, browser, (req.get('cf-ipcountry') || '').slice(0, 2) || null],
    );

    const token = jwt.sign(
      { sub: String(user.id), role: user.role, epoch: user.session_epoch, jti: tokenId },
      jwtSecret(),
      { algorithm: 'HS256', audience: SESSION_AUDIENCE, expiresIn: ttl },
    );
    res.cookie(SESSION_COOKIE, token, cookieOptions(ttl));
    return tokenId;
  }

  /** The signed-in user for a cookie value, or null. Never throws. */
  async function userFromToken(token) {
    if (!token) return null;
    let payload;
    try {
      payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], audience: SESSION_AUDIENCE });
    } catch {
      return null;
    }
    const [[row]] = await pool.query(
      `SELECT s.user_id, s.revoked_at, s.expires_at > UTC_TIMESTAMP() AS session_live,
              u.id, u.phone, u.name, u.role, u.is_active, u.session_epoch, u.twofa_enabled
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_id = ?`,
      [payload.jti],
    );
    if (checkSession(payload, row)) return null;
    return {
      id: row.id,
      phone: row.phone,
      name: row.name,
      role: row.role, // always the current role from the database, not the token
      twofaEnabled: Boolean(row.twofa_enabled),
      tokenId: payload.jti,
    };
  }

  async function revokeSession(tokenId) {
    await pool.query(
      'UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_id = ? AND revoked_at IS NULL',
      [tokenId],
    );
  }

  /** Ends every session of the user at once. */
  async function logoutAll(userId) {
    await pool.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?', [userId]);
    await pool.query(
      'UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    );
  }

  return { findOrCreateUser, issueSession, userFromToken, revokeSession, logoutAll };
}

/** Where each role lands after signing in. */
function homeFor(role) {
  if (role === 'platform_admin') return '/platform';
  if (['office_owner', 'office_manager', 'office_staff'].includes(role)) return '/office';
  if (role === 'landlord') return '/landlord';
  return '/tenant';
}

/**
 * Whether platform_admin must use 2FA. REQUIRE_ADMIN_2FA=false turns it off
 * for testing, but only outside production; production ignores the flag.
 */
function adminTwoFactorRequired(env = process.env) {
  const skipRequested = String(env.REQUIRE_ADMIN_2FA ?? 'true').trim().toLowerCase() === 'false';
  return !(skipRequested && env.NODE_ENV !== 'production');
}

/** Whether signing in needs the authenticator step after the phone code. */
function needsTwoFactor(user, env = process.env) {
  const enabled = Boolean(user.twofa_enabled);
  if (user.role === 'platform_admin') return enabled || adminTwoFactorRequired(env);
  // Anyone who already turned 2FA on is always asked for their code.
  return user.role === 'office_owner' && enabled;
}

module.exports = {
  ...createAuthService(),
  createAuthService,
  checkSession,
  homeFor,
  needsTwoFactor,
  adminTwoFactorRequired,
  signStepToken,
  verifyStepToken,
  deviceFingerprint,
  describeDevice,
  cookieOptions,
  SESSION_COOKIE,
  jwtSecret,
};
