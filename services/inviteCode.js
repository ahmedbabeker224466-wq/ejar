'use strict';

const crypto = require('crypto');

// No 0 O 1 I L: they are easy to confuse when read aloud or typed.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;

/** One random code. crypto.randomInt is uniform, so no character is favoured. */
function generateInviteCode(randomInt = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/**
 * A code that is not taken yet. isTaken(code) is async and returns true when
 * the code already exists; collisions are retried up to maxAttempts times.
 */
async function generateUniqueInviteCode(
  isTaken,
  { maxAttempts = MAX_ATTEMPTS, generate = generateInviteCode } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = generate();
    if (!(await isTaken(code))) return code;
  }
  throw new Error(`Could not generate a unique invite code after ${maxAttempts} attempts`);
}

/** isTaken implementation backed by the invites table. */
function inviteCodeExistsIn(pool) {
  return async (code) => {
    const [rows] = await pool.query('SELECT 1 FROM invites WHERE code = ? LIMIT 1', [code]);
    return rows.length > 0;
  };
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  generateInviteCode,
  generateUniqueInviteCode,
  inviteCodeExistsIn,
};
