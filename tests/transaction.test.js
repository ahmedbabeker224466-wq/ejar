'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTransaction } = require('../services/transaction');

function fakePool() {
  const log = [];
  return {
    log,
    async getConnection() {
      return {
        beginTransaction: async () => log.push('begin'),
        commit: async () => log.push('commit'),
        rollback: async () => log.push('rollback'),
        release: () => log.push('release'),
      };
    },
  };
}

const deadlock = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

test('commits and returns the result', async () => {
  const pool = fakePool();
  assert.equal(await withTransaction(pool, async () => 42), 42);
  assert.deepEqual(pool.log, ['begin', 'commit', 'release']);
});

test('a deadlock victim is run again from the start', async () => {
  const pool = fakePool();
  let calls = 0;
  const result = await withTransaction(pool, async () => {
    calls += 1;
    if (calls === 1) throw deadlock();
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(pool.log, ['begin', 'rollback', 'release', 'begin', 'commit', 'release']);
});

test('gives up after the retries, and never retries other errors', async () => {
  const pool = fakePool();
  let calls = 0;
  await assert.rejects(withTransaction(pool, async () => { calls += 1; throw deadlock(); }), /Deadlock/);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(withTransaction(fakePool(), async () => { calls += 1; throw new Error('boom'); }), /boom/);
  assert.equal(calls, 1);
});
