'use strict';

// Integration tests against a real MySQL database. They run only when
// TEST_DB_NAME is set, so `npm test` never touches the production database.
// The test database must already exist and DB_HOST/DB_USER/DB_PASSWORD must
// have full rights on it.

require('dotenv').config({ quiet: true });

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

let db;
let seed;
let scopeToOffice;

test.before(() => {
  if (!TEST_DB) return;
  process.env.DB_NAME = TEST_DB; // must happen before config/db is loaded
  db = require('../config/db');
  ({ seed } = require('../database/seed'));
  ({ scopeToOffice } = require('../services/scopeToOffice'));
});

test.after(async () => {
  if (db) await db.pool.end();
});

test('ensureSchema() runs twice in a row without error', { skip }, async () => {
  const first = await db.ensureSchema();
  const second = await db.ensureSchema();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, 0, 'the second run creates nothing');
  assert.equal(second.found, second.total);
  const { tableNames } = require('../database/schema');
  const [rows] = await db.pool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
    [TEST_DB],
  );
  const existing = new Set(rows.map((r) => r.name));
  for (const name of tableNames) assert.ok(existing.has(name), `missing table ${name}`);
});

test('the required indexes exist', { skip }, async () => {
  const required = {
    contracts: [['office_id', 'end_date'], ['office_id', 'status']],
    contract_payments: [['office_id', 'due_date', 'status'], ['contract_id']],
    reminders: [['remind_on', 'status'], ['office_id']],
    units: [['office_id', 'status'], ['landlord_id']],
    landlords: [['office_id']],
    invites: [['code'], ['office_id', 'kind']],
    audit_logs: [['office_id', 'created_at']],
    notifications: [['user_id', 'read_at']],
    maintenance_requests: [['office_id', 'status']],
    listings: [['status', 'published_at']],
    staff_activity: [['office_id', 'minute_utc']],
    page_views: [['day']],
  };
  const [rows] = await db.pool.query(
    `SELECT table_name AS t, index_name AS i, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
       FROM information_schema.statistics WHERE table_schema = ? GROUP BY table_name, index_name`,
    [TEST_DB],
  );
  const indexes = rows.map((r) => ({ table: r.t, cols: r.cols }));
  for (const [table, list] of Object.entries(required)) {
    for (const cols of list) {
      assert.ok(
        indexes.some((ix) => ix.table === table && ix.cols === cols.join(',')),
        `missing index ${table}(${cols.join(', ')})`,
      );
    }
  }
});

test('seed is idempotent', { skip }, async () => {
  await seed(db.pool);
  const count = async (t) => (await db.pool.query(`SELECT COUNT(*) AS n FROM ${t}`))[0][0].n;
  const before = [await count('plans'), await count('message_templates'), await count('settings')];
  const second = await seed(db.pool);
  const after = [await count('plans'), await count('message_templates'), await count('settings')];
  assert.deepEqual(second, { plans: 0, templates: 0, settings: 0 });
  assert.deepEqual(after, before);
  assert.ok(before[0] >= 4);
});

test('one office cannot read or change another office\'s rows', { skip }, async () => {
  const tag = `test-${Date.now()}`;
  const [u] = await db.pool.query('INSERT INTO users (phone, role) VALUES (?, ?)', [tag, 'office_owner']);
  const makeOffice = async (name) =>
    (await db.pool.query(
      "INSERT INTO offices (name, city, phone, owner_id) VALUES (?, 'Riyadh', '0500000000', ?)",
      [name, u.insertId],
    ))[0].insertId;
  const officeA = await makeOffice(`${tag}-A`);
  const officeB = await makeOffice(`${tag}-B`);
  try {
    const a = scopeToOffice(db.pool, officeA);
    const b = scopeToOffice(db.pool, officeB);

    const landlordA = await a.insert('landlords', { label: 'Landlord A' });
    const unitA = await a.insert('units', { landlord_id: landlordA, label: 'Unit A', city: 'Riyadh' });
    await a.insert('unit_photos', { unit_id: unitA, path: '/a.jpg' });
    await a.insert('contracts', {
      landlord_id: landlordA,
      unit_id: unitA,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      annual_rent: 30000,
    });

    assert.equal((await a.select('contracts')).length, 1);
    assert.equal((await b.select('contracts')).length, 0);
    assert.equal((await b.select('unit_photos', { unit_id: unitA })).length, 0);
    assert.equal(await b.update('units', { id: unitA }, { label: 'hacked' }), 0);
    assert.equal(await b.remove('landlords', { id: landlordA }), 0);
    await assert.rejects(b.insert('unit_photos', { unit_id: unitA, path: '/b.jpg' }), /does not belong/);
    assert.equal((await a.selectOne('units', { id: unitA })).label, 'Unit A');
    const [{ n }] = await b.query('SELECT COUNT(*) AS n FROM contracts WHERE office_id = :office_id');
    assert.equal(Number(n), 0);

    // invites.expires_at defaults to 30 days after creation.
    const inviteId = await a.insert('invites', { code: 'TEST2345', kind: 'landlord', landlord_id: landlordA });
    const [[invite]] = await db.pool.query(
      'SELECT TIMESTAMPDIFF(DAY, created_at, expires_at) AS days FROM invites WHERE id = ?',
      [inviteId],
    );
    assert.equal(Number(invite.days), 30);
  } finally {
    await db.pool.query('DELETE FROM offices WHERE id IN (?, ?)', [officeA, officeB]);
    await db.pool.query('DELETE FROM users WHERE id = ?', [u.insertId]);
  }
});
