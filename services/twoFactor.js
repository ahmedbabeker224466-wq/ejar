'use strict';

// Second login step (after the phone code, never instead of it).
// The TOTP secret is stored encrypted; backup codes are stored as keyed hashes.

const crypto = require('crypto');
const db = require('../config/db');
const totp = require('./totp');
const secretBox = require('./secretBox');

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function backupKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHash('sha256').update(`backup-key:${secret}`).digest();
}

function parseHashes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function createTwoFactorService({ pool = db.pool, now = () => Date.now() } = {}) {
  // Failed second-step attempts per user. Kept in memory: the attacker has
  // already passed the SMS code, and a restart only resets this counter.
  const failures = new Map();

  function lockedFor(userId) {
    const entry = failures.get(userId);
    if (!entry || entry.count < MAX_FAILURES) return 0;
    const left = entry.at + LOCK_MS - now();
    if (left <= 0) {
      failures.delete(userId);
      return 0;
    }
    return Math.ceil(left / 1000);
  }

  function recordFailure(userId) {
    const entry = failures.get(userId) || { count: 0, at: 0 };
    failures.set(userId, { count: entry.count + 1, at: now() });
  }

  /** Secret waiting to be confirmed during setup; created on first call. */
  async function pendingSetup(user) {
    const [[row]] = await pool.query(
      'SELECT phone, twofa_secret, twofa_enabled FROM users WHERE id = ?',
      [user.id],
    );
    if (row.twofa_enabled) return null;
    let secret = row.twofa_secret ? secretBox.open(row.twofa_secret) : null;
    if (!secret) {
      secret = totp.generateSecret();
      await pool.query('UPDATE users SET twofa_secret = ? WHERE id = ? AND twofa_enabled = 0', [
        secretBox.seal(secret),
        user.id,
      ]);
    }
    return { secret, uri: totp.otpauthUri(secret, row.phone) };
  }

  /** Confirms setup with a first code. Returns the backup codes (shown once) or null. */
  async function confirmSetup(user, code) {
    const locked = lockedFor(user.id);
    if (locked) return { ok: false, error: 'locked', retryAfterSec: locked };
    const setup = await pendingSetup(user);
    if (!setup || !totp.verifyCode(setup.secret, code, now())) {
      recordFailure(user.id);
      return { ok: false, error: 'invalid' };
    }
    const codes = totp.generateBackupCodes();
    const key = backupKey();
    await pool.query('UPDATE users SET twofa_enabled = 1, twofa_backup_codes = ? WHERE id = ?', [
      JSON.stringify(codes.map((c) => totp.hashBackupCode(c, key))),
      user.id,
    ]);
    failures.delete(user.id);
    return { ok: true, backupCodes: codes };
  }

  /** Checks an authenticator code, or a backup code (which is then used up). */
  async function verify(user, input) {
    const locked = lockedFor(user.id);
    if (locked) return { ok: false, error: 'locked', retryAfterSec: locked };

    const [[row]] = await pool.query(
      'SELECT twofa_secret, twofa_enabled, twofa_backup_codes FROM users WHERE id = ?',
      [user.id],
    );
    if (!row || !row.twofa_enabled || !row.twofa_secret) return { ok: false, error: 'not_enabled' };

    const value = String(input || '').trim();
    if (/^\d{6}$/.test(value)) {
      if (totp.verifyCode(secretBox.open(row.twofa_secret), value, now())) {
        failures.delete(user.id);
        return { ok: true, method: 'totp' };
      }
    } else {
      const remaining = totp.consumeBackupCode(parseHashes(row.twofa_backup_codes), value, backupKey());
      if (remaining) {
        await pool.query('UPDATE users SET twofa_backup_codes = ? WHERE id = ?', [
          JSON.stringify(remaining),
          user.id,
        ]);
        failures.delete(user.id);
        return { ok: true, method: 'backup', backupCodesLeft: remaining.length };
      }
    }
    recordFailure(user.id);
    const nowLocked = lockedFor(user.id);
    if (nowLocked) return { ok: false, error: 'locked', retryAfterSec: nowLocked };
    return { ok: false, error: 'invalid' };
  }

  return { pendingSetup, confirmSetup, verify };
}

module.exports = { ...createTwoFactorService(), createTwoFactorService };
