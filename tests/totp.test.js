'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../services/totp');

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" (SHA-1).
// Its 8-digit results, cut to the last 6 digits, are what a 6-digit TOTP gives.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS = [
  [59, '287082'], // 94287082
  [1111111109, '081804'], // 07081804
  [1111111111, '050471'], // 14050471
  [1234567890, '005924'], // 89005924
  [2000000000, '279037'], // 69279037
];

test('base32 matches the RFC 4648 example and round-trips', () => {
  assert.equal(totp.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.base32Decode(RFC_SECRET).toString(), '12345678901234567890');
});

for (const [seconds, expected] of RFC_VECTORS) {
  test(`generates the RFC 6238 code at T=${seconds}`, () => {
    assert.equal(totp.generateCode(RFC_SECRET, seconds * 1000), expected);
  });
}

test('verifies a code for a known secret and time', () => {
  assert.equal(totp.verifyCode(RFC_SECRET, '081804', 1111111109 * 1000), true);
  assert.equal(totp.verifyCode(RFC_SECRET, '081805', 1111111109 * 1000), false);
});

test('accepts one step either side and nothing further', () => {
  const t = 1111111109 * 1000;
  const code = totp.generateCode(RFC_SECRET, t);
  assert.equal(totp.verifyCode(RFC_SECRET, code, t + 30000), true);
  assert.equal(totp.verifyCode(RFC_SECRET, code, t - 30000), true);
  assert.equal(totp.verifyCode(RFC_SECRET, code, t + 90000), false);
  assert.equal(totp.verifyCode(RFC_SECRET, code, t - 90000), false);
});

test('rejects malformed codes', () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
    assert.equal(totp.verifyCode(RFC_SECRET, bad, 59000), false);
  }
});

test('new secrets are 160-bit base32', () => {
  const secret = totp.generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Decode(secret).length, 20);
});

test('builds an otpauth URI for authenticator apps', () => {
  const uri = totp.otpauthUri(RFC_SECRET, '966512345678');
  assert.match(uri, /^otpauth:\/\/totp\/Aqdi%3A966512345678\?/);
  assert.match(uri, new RegExp(`secret=${RFC_SECRET}`));
  assert.match(uri, /issuer=Aqdi/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});

test('backup codes: 8 codes, stored hashed, each usable once', () => {
  const key = Buffer.from('k'.repeat(32));
  const codes = totp.generateBackupCodes();
  assert.equal(codes.length, 8);
  for (const code of codes) assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);

  const hashes = codes.map((c) => totp.hashBackupCode(c, key));
  assert.ok(hashes.every((h) => !codes.some((c) => h.includes(c.replace('-', '')))));

  const after = totp.consumeBackupCode(hashes, codes[3].toLowerCase().replace('-', ' '), key);
  assert.equal(after.length, 7);
  assert.equal(totp.consumeBackupCode(after, codes[3], key), null, 'a used code works only once');
  assert.equal(totp.consumeBackupCode(hashes, 'ZZZZ-ZZZZ', key), null);
});
