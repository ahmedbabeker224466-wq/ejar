'use strict';

// One-time login codes. Only a keyed SHA-256 (HMAC) of each code is stored:
// a plain hash of a 6-digit code could be reversed in seconds by anyone who
// copied the database. All time comparisons use the database clock (UTC).

const crypto = require('crypto');
const db = require('../config/db');
const { normalizeSaudi, toE164 } = require('../utils/phone');
const { sendSms } = require('./sms');
const { safeEqual } = require('./totp');

const CODE_TTL_MINUTES = 5;
const LIMITS = {
  perPhoneMinute: 1,
  perPhoneHour: 5,
  perIpHour: 20,
  maxWrongAttempts: 5,
  lockSeconds: 15 * 60,
};

function otpKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHash('sha256').update(`otp-key:${secret}`).digest();
}

/** Keyed hash of a code, bound to the phone so a hash is useless elsewhere. */
function hashCode(phone, code, key = otpKey()) {
  return crypto.createHmac('sha256', key).update(`${phone}:${code}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Pure decision: is a new request allowed? Inputs are counts within the last
 * hour and seconds since the newest/oldest of those requests.
 */
function rateLimitDecision({ phoneHourCount, phoneSinceNewest, phoneSinceOldest, ipHourCount, ipSinceOldest }) {
  if (phoneHourCount >= LIMITS.perPhoneMinute && phoneSinceNewest !== null && phoneSinceNewest < 60) {
    return { limited: true, retryAfterSec: 60 - phoneSinceNewest };
  }
  if (phoneHourCount >= LIMITS.perPhoneHour) {
    return { limited: true, retryAfterSec: Math.max(1, 3600 - phoneSinceOldest) };
  }
  if (ipHourCount >= LIMITS.perIpHour) {
    return { limited: true, retryAfterSec: Math.max(1, 3600 - ipSinceOldest) };
  }
  return { limited: false, retryAfterSec: 0 };
}

/** Pure decision: is the phone locked after too many wrong codes? */
function lockDecision({ wrongAttempts, sinceLastAttempt }) {
  if (wrongAttempts >= LIMITS.maxWrongAttempts && sinceLastAttempt < LIMITS.lockSeconds) {
    return { locked: true, retryAfterSec: LIMITS.lockSeconds - sinceLastAttempt };
  }
  return { locked: false, retryAfterSec: 0 };
}

function createOtpService({ pool = db.pool, send = sendSms, key = null } = {}) {
  const getKey = () => key || otpKey();

  // Wrong attempts since the phone's last successful login, in the lock window.
  async function lockState(phone) {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(attempts), 0) AS wrong,
              TIMESTAMPDIFF(SECOND, MAX(updated_at), CURRENT_TIMESTAMP) AS since_last
         FROM otp_codes
        WHERE phone = ?
          AND consumed_at IS NULL
          AND attempts > 0
          AND updated_at > CURRENT_TIMESTAMP - INTERVAL ? SECOND
          AND id > COALESCE((SELECT MAX(id) FROM (SELECT id FROM otp_codes
                              WHERE phone = ? AND consumed_at IS NOT NULL) AS done), 0)`,
      [phone, LIMITS.lockSeconds, phone],
    );
    return lockDecision({
      wrongAttempts: Number(row.wrong),
      sinceLastAttempt: row.since_last === null ? Infinity : Number(row.since_last),
    });
  }

  async function rateState(phone, ip) {
    const [[p]] = await pool.query(
      `SELECT COUNT(*) AS n,
              TIMESTAMPDIFF(SECOND, MAX(created_at), CURRENT_TIMESTAMP) AS since_newest,
              TIMESTAMPDIFF(SECOND, MIN(created_at), CURRENT_TIMESTAMP) AS since_oldest
         FROM otp_codes WHERE phone = ? AND created_at > CURRENT_TIMESTAMP - INTERVAL 1 HOUR`,
      [phone],
    );
    let ipRow = { n: 0, since_oldest: null };
    if (ip) {
      [[ipRow]] = await pool.query(
        `SELECT COUNT(*) AS n,
                TIMESTAMPDIFF(SECOND, MIN(created_at), CURRENT_TIMESTAMP) AS since_oldest
           FROM otp_codes WHERE ip = ? AND created_at > CURRENT_TIMESTAMP - INTERVAL 1 HOUR`,
        [ip],
      );
    }
    return rateLimitDecision({
      phoneHourCount: Number(p.n),
      phoneSinceNewest: p.since_newest === null ? null : Number(p.since_newest),
      phoneSinceOldest: Number(p.since_oldest || 0),
      ipHourCount: Number(ipRow.n),
      ipSinceOldest: Number(ipRow.since_oldest || 0),
    });
  }

  /**
   * Creates and sends a code. Returns { ok } or { ok: false, error, retryAfterSec }.
   * The response is the same whether or not the phone has an account.
   */
  async function request(rawPhone, purpose = 'login', ip = null) {
    const phone = normalizeSaudi(rawPhone);
    if (!phone) return { ok: false, error: 'invalid_phone' };

    const lock = await lockState(phone);
    if (lock.locked) return { ok: false, error: 'locked', retryAfterSec: lock.retryAfterSec };

    const rate = await rateState(phone, ip);
    if (rate.limited) return { ok: false, error: 'rate_limited', retryAfterSec: rate.retryAfterSec };

    const code = generateCode();
    await pool.query(
      `INSERT INTO otp_codes (phone, code_hash, purpose, expires_at, ip)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP + INTERVAL ? MINUTE, ?)`,
      [phone, hashCode(phone, code, getKey()), purpose, CODE_TTL_MINUTES, ip],
    );

    const message = `رمز الدخول إلى عقدي: ${code}\nصالح لمدة ${CODE_TTL_MINUTES} دقائق. لا تشاركه مع أحد.`;
    const sent = await send(toE164(phone), message);
    return sent.ok ? { ok: true, phone } : { ok: false, error: 'send_failed' };
  }

  /**
   * Checks a code. Every check counts as an attempt; five wrong ones lock the
   * phone for 15 minutes. A matching code is consumed and never works again.
   */
  async function verify(rawPhone, rawCode, purpose = 'login') {
    const phone = normalizeSaudi(rawPhone);
    const code = String(rawCode || '').trim();
    if (!phone) return { ok: false, error: 'invalid' };

    const lock = await lockState(phone);
    if (lock.locked) return { ok: false, error: 'locked', retryAfterSec: lock.retryAfterSec };

    const [[row]] = await pool.query(
      `SELECT id, code_hash, consumed_at, expires_at > CURRENT_TIMESTAMP AS live
         FROM otp_codes WHERE phone = ? AND purpose = ? ORDER BY id DESC LIMIT 1`,
      [phone, purpose],
    );
    if (!row || row.consumed_at || !Number(row.live)) return { ok: false, error: 'invalid' };

    // Count the attempt before comparing, so parallel guesses are all counted.
    const [counted] = await pool.query(
      'UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL',
      [row.id],
    );
    if (counted.affectedRows !== 1) return { ok: false, error: 'invalid' };

    const matches = /^\d{6}$/.test(code) && safeEqual(hashCode(phone, code, getKey()), row.code_hash);
    if (matches) {
      const [consumed] = await pool.query(
        'UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL',
        [row.id],
      );
      if (consumed.affectedRows === 1) return { ok: true, phone };
      return { ok: false, error: 'invalid' };
    }

    const after = await lockState(phone);
    if (after.locked) return { ok: false, error: 'locked', retryAfterSec: after.retryAfterSec };
    return { ok: false, error: 'invalid' };
  }

  return { request, verify, lockState };
}

module.exports = {
  ...createOtpService(),
  createOtpService,
  hashCode,
  generateCode,
  rateLimitDecision,
  lockDecision,
  LIMITS,
  CODE_TTL_MINUTES,
};
