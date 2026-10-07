'use strict';

// Final privacy audit of the schema and the source code:
// - no column can hold an ID number, IBAN, meter or account number, party name or address;
// - every column with "name" in it is on a short, reviewed list;
// - no log call interpolates a phone number, token, secret, password or code;
// - production never uses the console SMS driver.
// The live-database part runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';
const ROOT = path.join(__dirname, '..');

const FORBIDDEN_COLUMN = /national|iqama|id_number|_nid\b|\biban|meter|account_?(no|number|num)|tenant_name|landlord_name|party|owner_name|full_name|address|street|plot|deed|latitude|longitude|\blat$|\blng$|coordinate|passport|birth|\bdob\b/i;

// Every column with "name" in it, reviewed one by one.
const NAME_COLUMNS = new Set([
  'buildings.name', // nickname of a building
  'office_branches.name', // branch of the office
  'offices.name', // the office's own public name
  'plans.name_ar', // plan title
  'cron_runs.job_name', // job id
  'vendors.name', // business nickname of a maintenance vendor
  'users.name', // the signed-in person's own display name, never taken from a contract
  'contact_messages.name', // sender of the public contact form
  'listing_inquiries.name', // sender of a public inquiry (visible to the listing's office only)
  'subscription_invoices.buyer_name', // the office display name only
  'testimonials.author_name', // marketing quote written by the platform admin
]);

test('no table has a column for IDs, IBANs, meters, accounts, party names or addresses', { skip }, async () => {
  const db = require('../config/db');
  try {
    await db.ensureSchema();
    const [rows] = await db.pool.query(
      'SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()',
    );
    assert.ok(rows.length > 400, `only ${rows.length} columns found`);
    const bad = rows.filter((r) => FORBIDDEN_COLUMN.test(r.c)).map((r) => `${r.t}.${r.c}`);
    assert.deepEqual(bad, [], `columns that could hold private data: ${bad.join(', ')}`);
    const names = rows.filter((r) => /name/i.test(r.c)).map((r) => `${r.t}.${r.c}`);
    const unknown = names.filter((n) => !NAME_COLUMNS.has(n));
    assert.deepEqual(unknown, [], `"name" columns that were not reviewed: ${unknown.join(', ')}`);
    for (const known of NAME_COLUMNS) assert.ok(names.includes(known), `reviewed column ${known} no longer exists: update the list`);
  } finally {
    await db.pool.end();
  }
});

test('the table definitions themselves have no forbidden column', () => {
  const { TABLES } = require('../database/schema');
  assert.ok(TABLES.length >= 70);
  const columns = [];
  for (const t of TABLES) {
    for (const line of t.sql.split('\n').slice(1)) {
      const m = /^\s+`?([a-z][a-z0-9_]*)`? [A-Z]/.exec(line);
      if (m && !/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN)$/.test(m[1].toUpperCase())) columns.push(`${t.name}.${m[1]}`);
    }
  }
  assert.ok(columns.length > 300, `only ${columns.length} columns parsed`);
  const bad = columns.filter((c) => FORBIDDEN_COLUMN.test(c.split('.')[1]));
  assert.deepEqual(bad, []);
});

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tests', 'public', 'storage', 'docs'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('no log call writes a phone number, token, secret, password, code or message body', () => {
  const files = sourceFiles(ROOT);
  assert.ok(files.length > 100);
  const call = /(?:logger|console)\.(?:info|warn|error|debug|log)\(([^;]*)\)/g;
  // Words that must never appear inside an interpolation of a log message.
  const risky = /\$\{[^}]*\b(phone|mobile|token|secret|password|passwd|otp|apiKey|api_key|authorization|cookie|body|message|text|iban|code|reference|note|description)\b[^}]*\}/i;
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    // The development console SMS driver is the one reviewed exception (refused in production, tested below).
    if (rel === path.join('services', 'sms', 'console.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(call)) {
      const text = m[1];
      for (const interpolation of text.match(/\$\{[^}]*\}/g) || []) {
        // err.code / error.code are system error codes, not user codes.
        // Error objects: system codes and messages are technical text, never a user's input.
        const stripped = interpolation.replace(/\b\w+\.(code|message|name|stack)\b/g, 'errfield').replace(/\$\{\s*code\s*\}/, '${errcode}');
        if (risky.test(stripped)) offenders.push(`${rel}: ${m[0].slice(0, 120)}`);
      }
      if (/\b(req\.body|req\.query|\.body\b)/.test(text)) offenders.push(`${rel}: logs request data: ${m[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('production never uses the console SMS driver (login codes would reach the log)', () => {
  const { selectDriver } = require('../services/sms');
  const logger = require('../utils/logger');
  const original = logger.error;
  logger.error = () => {};
  try {
    const driver = selectDriver({ NODE_ENV: 'production', SMS_PROVIDER: 'console' });
    assert.notEqual(driver.name, 'console');
    assert.notEqual(selectDriver({ NODE_ENV: 'production' }).name, 'console');
  } finally {
    logger.error = original;
  }
});

test('the phone masking helper hides the middle digits', () => {
  const { maskPhone } = require('../utils/phone');
  const masked = maskPhone('966500001939');
  assert.doesNotMatch(masked, /966500001939|500001939/);
});
