'use strict';

// Checks the schema definition itself; no database needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TABLES, tableNames } = require('../database/schema');

function fixedTableNames() {
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  const section = claude.split('# Fixed table names')[1];
  return section.trim().split('\n')[0].split(',').map((s) => s.trim()).filter(Boolean);
}

test('the schema creates exactly the fixed tables listed in CLAUDE.md', () => {
  assert.deepEqual([...tableNames].sort(), fixedTableNames().sort());
});

test('every table is InnoDB utf8mb4_unicode_ci with timestamps', () => {
  for (const { name, sql } of TABLES) {
    assert.match(sql, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci$/, name);
    assert.match(sql, /created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/, name);
    assert.match(sql, /updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE/, name);
  }
});

test('a table is created only after every table it references', () => {
  const seen = new Set();
  for (const { name, sql } of TABLES) {
    for (const [, parent] of sql.matchAll(/REFERENCES `([a-z_]+)`/g)) {
      assert.ok(seen.has(parent) || parent === name, `${name} references ${parent} before it exists`);
    }
    seen.add(name);
  }
});

test('SET NULL foreign keys point at nullable columns', () => {
  for (const { name, sql } of TABLES) {
    for (const [, column] of sql.matchAll(/FOREIGN KEY \((\w+)\) REFERENCES `\w+` \(id\) ON DELETE SET NULL/g)) {
      assert.match(sql, new RegExp(`\\b${column} BIGINT UNSIGNED NULL\\b`), `${name}.${column}`);
    }
  }
});

test('no column can hold personal data from a contract', () => {
  const forbidden = /\b(national_id|iqama\w*|id_number|iban|meter\w*|account_number|tenant_name|landlord_name|party_name\w*|address\w*)\b/i;
  for (const { name, sql } of TABLES) {
    assert.doesNotMatch(sql, forbidden, name);
  }
});

test('money columns sit next to a currency column', () => {
  for (const { name, sql } of TABLES) {
    if (/DECIMAL\(12,2\)/.test(sql)) {
      assert.match(sql, /currency CHAR\(3\) NOT NULL DEFAULT 'SAR'/, name);
    }
  }
});
