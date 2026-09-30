'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAudit } = require('../services/audit');

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return [{ insertId: 1 }];
    },
  };
}

test('writes an audit row with before and after as JSON', async () => {
  const pool = fakePool();
  const ok = await createAudit(pool).log(
    3, 7, 'contract.update', 'contract', 11, { status: 'calm' }, { status: 'soon' }, '10.0.0.1',
  );
  assert.equal(ok, true);
  assert.deepEqual(pool.calls[0].params, [
    7, 3, 'contract.update', 'contract', 11, '{"status":"calm"}', '{"status":"soon"}', '10.0.0.1',
  ]);
});

test('skips high-frequency actions without touching the database', async () => {
  const pool = fakePool();
  assert.equal(await createAudit(pool).log(3, 7, 'page.view', 'page', null), false);
  assert.equal(await createAudit(pool).log(3, 7, 'activity.ping', 'user', 3), false);
  assert.equal(pool.calls.length, 0);
});

test('never writes secrets into the audit trail', async () => {
  const pool = fakePool();
  await createAudit(pool).log(3, null, 'user.2fa', 'user', 3, null, { twofa_secret: 'abc', twofa_enabled: 1 });
  assert.equal(pool.calls[0].params[6], '{"twofa_secret":"[redacted]","twofa_enabled":1}');
});

test('a failed audit write does not throw', async () => {
  const pool = { query: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } };
  assert.equal(await createAudit(pool).log(1, 1, 'x', 'y', 1), false);
});
