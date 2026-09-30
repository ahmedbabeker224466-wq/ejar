'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeForLog } = require('../middleware/errorHandler');

test('a malformed request body never reaches the log', () => {
  let err;
  try {
    JSON.parse('code654321');
  } catch (e) {
    err = Object.assign(e, { type: 'entity.parse.failed', status: 400, body: 'code654321' });
  }
  assert.match(err.message, /654321/, 'the raw error really does quote the body');
  const line = describeForLog(err);
  assert.equal(line, 'request body rejected (entity.parse.failed)');
  assert.ok(!line.includes('654321'));
});

test('database error messages (which can quote values) are reduced to their code', () => {
  const err = Object.assign(new Error("Duplicate entry '966512345678' for key 'uq_users_phone'"), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlState: '23000',
  });
  const line = describeForLog(err);
  assert.equal(line, 'database error ER_DUP_ENTRY (errno 1062)');
  assert.ok(!line.includes('966512345678'));
});

test('ordinary programming errors keep their stack for debugging', () => {
  const err = new TypeError('x is undefined');
  assert.match(describeForLog(err), /TypeError: x is undefined/);
});
