'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scopeToOffice,
  OfficeScopeError,
  OFFICE_TABLES,
  CHILD_TABLES,
} = require('../services/scopeToOffice');
const { TABLES } = require('../database/schema');

/** Records every query instead of talking to MySQL. */
function fakePool(result = [[]]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return typeof result === 'function' ? result(sql, params) : result;
    },
  };
}

test('throws when office_id is missing or invalid', () => {
  for (const bad of [undefined, null, 0, -3, '', 'abc', '12abc', 1.5, NaN, {}]) {
    assert.throws(() => scopeToOffice(fakePool(), bad), OfficeScopeError, `accepted ${String(bad)}`);
  }
});

test('accepts a numeric office_id, including a numeric string from a session', () => {
  assert.equal(scopeToOffice(fakePool(), 7).officeId, 7);
  assert.equal(scopeToOffice(fakePool(), '7').officeId, 7);
});

test('select always filters by office_id', async () => {
  const pool = fakePool();
  await scopeToOffice(pool, 5).select('units', { status: 'vacant' });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE `office_id` = \? AND `status` = \?/);
  assert.deepEqual(params, [5, 'vacant']);
});

test('a where filter cannot override the office', async () => {
  const pool = fakePool();
  await scopeToOffice(pool, 5).select('contracts', { office_id: 99 });
  assert.deepEqual(pool.calls[0].params, [5]);
});

test('child tables are scoped through their parent', async () => {
  const pool = fakePool();
  await scopeToOffice(pool, 5).select('unit_photos', { unit_id: 3 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /`unit_id` IN \(SELECT id FROM `units` WHERE office_id = \?\)/);
  assert.deepEqual(params, [5, 3]);
});

test('insert forces this office and refuses another one', async () => {
  const pool = fakePool([{ insertId: 1 }]);
  const scoped = scopeToOffice(pool, 5);
  await scoped.insert('landlords', { label: 'أبو فهد' });
  assert.deepEqual(pool.calls[0].params, ['أبو فهد', 5]);
  await assert.rejects(scoped.insert('landlords', { label: 'x', office_id: 6 }), OfficeScopeError);
});

test('insert into a child table checks the parent belongs to the office', async () => {
  const pool = fakePool([[]]); // parent lookup finds nothing
  await assert.rejects(
    scopeToOffice(pool, 5).insert('unit_photos', { unit_id: 42, path: '/p.jpg' }),
    /does not belong to office 5/,
  );
});

test('update and delete need a WHERE and stay inside the office', async () => {
  const pool = fakePool([{ affectedRows: 1 }]);
  const scoped = scopeToOffice(pool, 5);
  await assert.rejects(scoped.update('units', {}, { label: 'x' }), OfficeScopeError);
  await assert.rejects(scoped.remove('units', {}), OfficeScopeError);
  await scoped.update('units', { id: 9 }, { label: 'x' });
  assert.match(pool.calls[0].sql, /WHERE `office_id` = \? AND `id` = \?/);
  assert.deepEqual(pool.calls[0].params, ['x', 5, 9]);
});

test('non office-owned tables are refused', async () => {
  const scoped = scopeToOffice(fakePool(), 5);
  await assert.rejects(scoped.select('users'), /not an office-owned table/);
  await assert.rejects(scoped.select('plans'), /not an office-owned table/);
});

test('raw queries on office tables must use :office_id', async () => {
  const scoped = scopeToOffice(fakePool(), 5);
  await assert.rejects(scoped.query('SELECT * FROM contracts'), /must filter by :office_id/);
  await assert.rejects(scoped.query('SELECT * FROM unit_photos WHERE unit_id = ?', [1]), OfficeScopeError);
});

test('raw queries bind :office_id in the right position', async () => {
  const pool = fakePool();
  await scopeToOffice(pool, 5).query(
    'SELECT * FROM contracts c JOIN units u ON u.id = c.unit_id WHERE c.status = ? AND c.office_id = :office_id AND u.office_id = :office_id AND c.city = ?',
    ['soon', 'Riyadh'],
  );
  const { sql, params } = pool.calls[0];
  assert.doesNotMatch(sql, /:office_id/);
  assert.deepEqual(params, ['soon', 5, 5, 'Riyadh']);
});

test('invalid identifiers are rejected', async () => {
  const scoped = scopeToOffice(fakePool(), 5);
  await assert.rejects(scoped.select('units', { 'status; DROP TABLE units': 1 }), /Invalid identifier/);
  await assert.rejects(scoped.select('units', {}, { orderBy: 'id; DROP' }), /Invalid orderBy/);
});

test('every table with office_id NOT NULL is covered by scopeToOffice', () => {
  const withOfficeId = TABLES.filter((t) => /\boffice_id BIGINT UNSIGNED NOT NULL\b/.test(t.sql)).map(
    (t) => t.name,
  );
  for (const name of withOfficeId) {
    assert.ok(OFFICE_TABLES.has(name), `${name} has office_id but is missing from OFFICE_TABLES`);
  }
  for (const name of OFFICE_TABLES) {
    assert.ok(withOfficeId.includes(name), `${name} is in OFFICE_TABLES but has no office_id`);
  }
  for (const [name, { parent }] of Object.entries(CHILD_TABLES)) {
    assert.ok(OFFICE_TABLES.has(parent), `${name}'s parent ${parent} is not office-owned`);
  }
});
