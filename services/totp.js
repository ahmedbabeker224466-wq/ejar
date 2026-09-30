'use strict';

// TOTP (RFC 6238) on top of HOTP (RFC 4226), with Node's crypto only.
// 6 digits, 30-second steps, HMAC-SHA1: what every authenticator app expects.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // accept one step either side for clock drift
const BACKUP_CODE_COUNT = 8;
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random secret as base32 (160 bits, as RFC 4226 recommends). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuffer, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuffer).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Code for a base32 secret at a moment (milliseconds since epoch). */
function generateCode(secretBase32, timeMs = Date.now()) {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / STEP_SECONDS));
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** True when code matches the current step or one step either side. */
function verifyCode(secretBase32, code, timeMs = Date.now()) {
  const candidate = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 1000 / STEP_SECONDS);
  let ok = false;
  // Check every step without returning early, so timing reveals nothing.
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    if (safeEqual(hotp(secret, counter + delta), candidate)) ok = true;
  }
  return ok;
}

/** otpauth:// URI that authenticator apps read from a QR code or a tap. */
function otpauthUri(secretBase32, accountName, issuer = 'Aqdi') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

/** 8 single-use backup codes, shown once, formatted XXXX-XXXX. */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    let raw = '';
    for (let i = 0; i < 8; i += 1) raw += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function normalizeBackupCode(code) {
  return String(code || '').toUpperCase().replace(/[\s-]/g, '');
}

/** Keyed hash of a backup code; only these hashes are stored. */
function hashBackupCode(code, key) {
  return crypto.createHmac('sha256', key).update(`backup:${normalizeBackupCode(code)}`).digest('hex');
}

/**
 * Finds a backup code among stored hashes. Returns the remaining hashes when
 * it matches (the used one removed), or null. Compares every hash so timing
 * does not reveal the position of a match.
 */
function consumeBackupCode(storedHashes, code, key) {
  const candidate = hashBackupCode(code, key);
  let matchIndex = -1;
  storedHashes.forEach((stored, index) => {
    if (safeEqual(stored, candidate)) matchIndex = index;
  });
  if (matchIndex === -1) return null;
  return storedHashes.filter((_, index) => index !== matchIndex);
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  generateCode,
  verifyCode,
  otpauthUri,
  generateBackupCodes,
  hashBackupCode,
  consumeBackupCode,
  safeEqual,
};
