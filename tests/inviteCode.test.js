'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALPHABET,
  generateInviteCode,
  generateUniqueInviteCode,
} = require('../services/inviteCode');

test('the alphabet excludes 0, O, 1, I and L', () => {
  for (const ch of ['0', 'O', '1', 'I', 'L']) assert.ok(!ALPHABET.includes(ch), ch);
  assert.equal(new Set(ALPHABET).size, ALPHABET.length);
});

test('codes are 8 characters from the alphabet', () => {
  for (let i = 0; i < 2000; i += 1) {
    const code = generateInviteCode();
    assert.equal(code.length, 8);
    assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
    for (const ch of code) assert.ok(ALPHABET.includes(ch));
  }
});

test('retries on collision until it finds a free code', async () => {
  const codes = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'];
  const taken = new Set(['AAAAAAAA', 'BBBBBBBB']);
  const checked = [];
  const code = await generateUniqueInviteCode(
    async (c) => {
      checked.push(c);
      return taken.has(c);
    },
    { generate: () => codes.shift() },
  );
  assert.equal(code, 'CCCCCCCC');
  assert.deepEqual(checked, ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']);
});

test('gives up with a clear error after too many collisions', async () => {
  let attempts = 0;
  await assert.rejects(
    generateUniqueInviteCode(
      async () => {
        attempts += 1;
        return true;
      },
      { maxAttempts: 4 },
    ),
    /after 4 attempts/,
  );
  assert.equal(attempts, 4);
});
