'use strict';

// Encrypts small secrets for storage (AES-256-GCM, key from SECRET_BOX_KEY).
// Stored format: 12-byte IV | 16-byte auth tag | ciphertext.

const crypto = require('crypto');

function key() {
  const hex = process.env.SECRET_BOX_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SECRET_BOX_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function open(sealed) {
  const buffer = Buffer.from(sealed);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
}

module.exports = { seal, open };
