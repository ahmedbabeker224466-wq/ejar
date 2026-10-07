'use strict';

// Encrypted backups and the restore drill, against a throwaway MySQL/MariaDB:
// the dump (batches, odd values, foreign keys), encryption at rest, checksum,
// retention, the job lock, the failure notice, the webhook, and the restore
// script's refusals. The source and restore databases are separate throwaway
// databases (aqdi_bk_src, aqdi_bk_restore, aqdi_bk_cli) created by the test.
// Runs only when TEST_DB_NAME is set; without the privilege to create
// databases the restore tests say so and skip.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { createOfficeHttp } = require('./helpers/officeHttp');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000023NN. NN = 00 is the platform admin.
const phone = (n) => `9665000023${String(n).padStart(2, '0')}`;
const PHONES = [phone(0), phone(1), phone(2), phone(3)];
const SRC = 'aqdi_bk_src';
const RESTORED = 'aqdi_bk_restore';
const CLI_TARGET = 'aqdi_bk_cli';
const MARKER_AR = 'سر-عربي-☕-😀';
const MARKERS = [MARKER_AR, 'quoted-"marker"', 'PLAINTEXT-MARKER-XYZ'];
const logLines = [];
const consoleOriginals = {};
const saved = {};

let db;
let backup;
let cron;
let transport;
let dates;
let dir;
let srcPool = null;
let canCreateDb = false;
let adminId;
let posts = [];
let http;

const dbEnv = () => ({ DB_HOST: process.env.DB_HOST, DB_PORT: process.env.DB_PORT, DB_USER: process.env.DB_USER, DB_PASSWORD: process.env.DB_PASSWORD, DB_NAME: process.env.DB_NAME, SECRET_BOX_KEY: process.env.SECRET_BOX_KEY });

async function adminConnection() {
  return mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, charset: 'utf8mb4' });
}

async function dropDb(name) {
  const c = await adminConnection();
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await c.end();
  }
}

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET', 'BACKUP_DIR', 'BACKUP_WEBHOOK_URL', 'PLATFORM_ADMIN_PHONE', 'REQUIRE_ADMIN_2FA', 'SECRET_BOX_KEY', 'CRON_SECRET']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.SECRET_BOX_KEY = process.env.SECRET_BOX_KEY || crypto.randomBytes(32).toString('hex');
  process.env.PLATFORM_ADMIN_PHONE = '0500002300';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'backup-cron-secret-0123456789';
  delete process.env.BACKUP_WEBHOOK_URL;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqdi-bk-'));
  process.env.BACKUP_DIR = path.join(dir, 'backups');

  db = require('../config/db');
  await db.ensureSchema();
  backup = require('../services/backup');
  cron = require('../services/cron');
  transport = require('../services/channels/transport');
  dates = require('../services/contractDates');
  await cleanup();

  await db.pool.query("INSERT INTO users (phone, role, is_active) VALUES (?, 'platform_admin', 1) ON DUPLICATE KEY UPDATE role = 'platform_admin', is_active = 1", [phone(0)]);
  [[{ id: adminId }]] = await db.pool.query('SELECT id FROM users WHERE phone = ?', [phone(0)]);

  http = createOfficeHttp(db);
  await http.start();
  transport.setMock(async (url, options) => {
    posts.push({ url, body: JSON.parse(options.body) });
    return { status: 200, body: '{}' };
  });

  try {
    await dropDb(SRC);
    const c = await adminConnection();
    await c.query(`CREATE DATABASE \`${SRC}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.end();
    canCreateDb = true;
  } catch (err) {
    process.stderr.write(`NOTE: backup restore tests skipped, cannot create databases (${err.code})\n`);
  }
  if (canCreateDb) await seedSource();

  for (const level of ['log', 'info', 'warn', 'error']) {
    consoleOriginals[level] = console[level];
    console[level] = (...args) => logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
});

async function seedSource() {
  srcPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: SRC, charset: 'utf8mb4', timezone: 'Z', dateStrings: ['DATE'], connectionLimit: 4,
  });
  srcPool.pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));
  const { TABLES } = require('../database/schema');
  const backupsTable = TABLES.find((t) => t.name === 'backups').sql;
  const cronTable = TABLES.find((t) => t.name === 'cron_runs').sql;
  await srcPool.query(backupsTable);
  await srcPool.query(cronTable);
  await srcPool.query('CREATE TABLE parent (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(100) NOT NULL) ENGINE=InnoDB');
  await srcPool.query(`CREATE TABLE kv (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, parent_id BIGINT UNSIGNED NULL, txt MEDIUMTEXT NULL, amount DECIMAL(12,2) NULL,
      at DATETIME NULL, d DATE NULL, j JSON NULL, flag TINYINT(1) NOT NULL DEFAULT 0, big BIGINT UNSIGNED NULL,
      ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, e ENUM('a','b') NOT NULL DEFAULT 'a',
      CONSTRAINT fk_kv_parent FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await srcPool.query('CREATE TABLE empty_table (id INT PRIMARY KEY, note VARCHAR(10)) ENGINE=InnoDB');
  await srcPool.query("INSERT INTO parent (label) VALUES ('أ'), ('b')");
  const odd = [
    MARKER_AR, 'it\'s "quoted-"marker"" \\ back\\slash \\n', 'line1\nline2\r\nline3\ttab\u0000nul', '; -- not a comment; DROP TABLE kv;', '', null, 'x'.repeat(70000), 'PLAINTEXT-MARKER-XYZ',
  ];
  for (const [i, txt] of odd.entries()) {
    await srcPool.query(
      "INSERT INTO kv (parent_id, txt, amount, at, d, j, flag, big, ts, e) VALUES (?, ?, ?, '2026-03-04 05:06:07', '2026-03-04', ?, 1, 18446744073709551615, '2026-03-04 05:06:07', 'b')",
      [i % 2 ? 1 : 2, txt, i === 0 ? null : '1234567.89', JSON.stringify({ a: [1, 2, { b: 'ç"\\' }], t: txt && txt.slice(0, 5) })],
    );
  }

  // JSON (native and the MariaDB shape: LONGTEXT + CHECK json_valid), TEXT and real binary columns.
  await srcPool.query(`CREATE TABLE typed (
      id INT AUTO_INCREMENT PRIMARY KEY, j JSON NULL, jt LONGTEXT NULL, t TEXT NULL, b BLOB NULL, vb VARBINARY(10) NULL,
      CONSTRAINT chk_typed_jt CHECK (jt IS NULL OR JSON_VALID(jt))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const nested = { a: { b: [1, 2.5, { c: 'ç"\\' }], d: null }, 'عربي': 'قيمة ☕ 😀', e: '\u0627\n"quoted"', empty: {}, arr: [] };
  const bigJson = JSON.stringify({ items: Array.from({ length: 6000 }, (_, i) => ({ i, s: `نص ${i} "q" \\ end` })) });
  assert.ok(bigJson.length > 100 * 1024);
  const jsonCases = [
    [JSON.stringify(nested), 'عربي ☕'],
    ['{}', ''],
    ['null', null], // JSON null (a value) ...
    [null, null], // ... versus SQL NULL
    ['"\\u0627\\u0644"', "it's \\ \"x\""],
    [bigJson, 'x'.repeat(2000)],
  ];
  for (const [json, text] of jsonCases) {
    await srcPool.query('INSERT INTO typed (j, jt, t, b, vb) VALUES (?, ?, ?, ?, ?)', [json, json, text, Buffer.from([0x00, 0xff, 0x01, 0x80, 0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x00])]);
  }
  await srcPool.query('INSERT INTO typed (j, jt, t, b, vb) VALUES (NULL, NULL, NULL, NULL, NULL), (NULL, NULL, ?, ?, ?)', ['', Buffer.alloc(0), Buffer.alloc(0)]);
  await srcPool.query('INSERT INTO typed (b) VALUES (?)', [crypto.randomBytes(60000)]);
  // More than one INSERT batch (500 rows each).
  const values = [];
  for (let i = 0; i < 1300; i += 1) values.push(`(NULL, 'row ${i}', ${i}.50, NULL, NULL, NULL, 0, ${i}, '2026-01-01 00:00:00', 'a')`);
  await srcPool.query(`INSERT INTO kv (parent_id, txt, amount, at, d, j, flag, big, ts, e) VALUES ${values.join(',')}`);
}

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES);
  await db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES);
  await db.pool.query('DELETE FROM backups');
}

test.after(async () => {
  for (const [level, fn] of Object.entries(consoleOriginals)) console[level] = fn;
  if (transport) transport.setMock(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (srcPool) await srcPool.end();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
  if (TEST_DB && canCreateDb) for (const name of [SRC, RESTORED, CLI_TARGET, 'aqdi_bk_refused']) await dropDb(name).catch(() => {});
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const one = async (sql, params = []) => (await db.pool.query(sql, params))[0][0];
const filesIn = (d) => fs.readdirSync(d).sort();
// Tests that need the throwaway source/restore databases: skipped (with a note) when this account cannot create databases.
const dbTest = (name, fn) => test(name, { skip }, async (t) => {
  if (!canCreateDb) return t.skip('cannot create databases here');
  return fn(t);
});

// ------------------------------------------------------------ pure: retention and dates

test('retention keeps the newest of each of 14 days, 8 Sundays, 6 months, and never the only backup away', () => {
  const entry = (id, iso) => ({ id, at: new Date(iso) });
  // One backup a day for 200 days at 02:00 Riyadh (23:00 UTC the day before).
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const entries = Array.from({ length: 200 }, (_, i) => entry(i + 1, new Date(start + i * 86400000).toISOString()));
  const { keep, remove } = backup.planRetention(entries);
  const keptDays = new Set([...keep].map((id) => dates.riyadhDate(entries[id - 1].at)));
  const newest = entries[entries.length - 1];
  assert.ok(keep.has(newest.id), 'the newest is always kept');
  // The last 14 days all stay.
  for (let i = 0; i < 14; i += 1) assert.ok(keep.has(entries.length - i), `day ${i} back is kept`);
  // Older than 14 days: only Sundays (8 of them) and the first of up to 6 months survive.
  const older = [...keep].filter((id) => id <= entries.length - 14);
  const sundays = older.filter((id) => dates.weekdayOf(dates.riyadhDate(entries[id - 1].at)) === 0);
  assert.ok(sundays.length >= 6 && sundays.length <= 8, `sundays kept: ${sundays.length}`);
  const firstOfMonth = older.filter((id) => dates.riyadhDate(entries[id - 1].at).endsWith('-01'));
  assert.ok(firstOfMonth.length >= 4 && firstOfMonth.length <= 6, `monthly kept: ${firstOfMonth.length}`);
  assert.ok(remove.length > 100);
  assert.equal(keep.size + remove.length, entries.length);
  assert.ok(keptDays.size === keep.size, 'one kept backup per kept day');
  // Total is bounded by 14 + 8 + 6.
  assert.ok(keep.size <= 28, `kept ${keep.size}`);

  // A single backup, however old, is never removed; so is the newest of several old ones.
  assert.deepEqual(backup.planRetention([entry(1, '2020-01-01T00:00:00Z')]).remove, []);
  const many = backup.planRetention([entry(1, '2020-01-01T00:00:00Z'), entry(2, '2020-01-03T00:00:00Z'), entry(3, '2020-01-02T00:00:00Z')]);
  assert.ok(many.keep.has(2));
  // Two backups on the same day: only the newest of the day is a daily keeper.
  const same = backup.planRetention([entry(1, '2026-05-06T01:00:00Z'), entry(2, '2026-05-06T02:00:00Z')], { daily: 1, weekly: 0, monthly: 0 });
  assert.deepEqual([...same.keep], [2]);
  assert.deepEqual(same.remove, [1]);
  assert.deepEqual(backup.planRetention([]).remove, []);
});

test('date helpers for the backup names, the weekly keeper and the report period (Riyadh calendar)', () => {
  assert.equal(backup.fileNameFor(new Date('2026-10-07T23:30:00Z')), 'aqdi-20261008-0230.sql.gz.enc');
  assert.equal(backup.fileNameFor(new Date('2026-10-07T10:05:00Z'), 2), 'aqdi-20261007-1305-2.sql.gz.enc');
  assert.match(backup.fileNameFor(new Date()), backup.NAME_PATTERN);
  assert.equal(dates.weekdayOf('2026-10-04'), 0);
  assert.equal(dates.weekdayOf('2026-10-10'), 6);
  assert.equal(dates.previousMonthOf('2026-01-01'), '2025-12');
  assert.equal(dates.previousMonthOf('2026-03-31'), '2026-02');
  const { start, end } = dates.monthBounds('2026-02');
  assert.equal(start.toISOString(), '2026-01-31T21:00:00.000Z');
  assert.equal(end.toISOString(), '2026-02-28T21:00:00.000Z');
  assert.throws(() => dates.weekdayOf('2026-02-30'));
});

test('serialization guard: a parsed object or "[object Object]" is never written into a backup; bytes become hex', () => {
  assert.throws(() => backup.valueSql({ a: 1 }), (e) => e.code === 'bad_value_serialization');
  assert.throws(() => backup.valueSql([1, 2]), (e) => e.code === 'bad_value_serialization');
  assert.throws(() => backup.valueSql('[object Object]'), (e) => e.code === 'bad_value_serialization');
  assert.equal(backup.valueSql(null), 'NULL');
  assert.equal(backup.valueSql(Buffer.from([0, 255, 1])), "X'00ff01'");
  assert.equal(backup.valueSql('a\'b\\'), "'a\\'b\\\\'");
  assert.equal(backup.valueSql(12.5), "'12.5'");
});

test('BACKUP_DIR must be outside public/ and is created with mode 0700', { skip }, () => {
  assert.throws(() => backup.backupDir({ BACKUP_DIR: path.join(__dirname, '..', 'public', 'x') }), (e) => e.code === 'backup_dir_public');
  const made = backup.ensureBackupDir({ BACKUP_DIR: path.join(dir, 'fresh', 'b') });
  assert.equal(fs.statSync(made).mode & 0o777, 0o700);
  assert.equal(backup.backupDir({}).endsWith(`${path.sep}backups`), true, 'default is ./backups');
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8'), /^backups\/$/m);
});

// ------------------------------------------------------------ dump, encryption, restore

let sourceBackup = null;

dbTest('a backup is one encrypted file (mode 0600), no plaintext on disk, checksum stored, 0700 directory', async () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const result = await backup.runBackup({ pool: srcPool, now, env: { ...process.env } });
  sourceBackup = result;
  assert.equal(result.filename, 'aqdi-20261007-1300.sql.gz.enc');
  assert.equal(result.tables, 6);
  const file = path.join(process.env.BACKUP_DIR, result.filename);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(process.env.BACKUP_DIR).mode & 0o777, 0o700);
  assert.deepEqual(filesIn(process.env.BACKUP_DIR), [result.filename], 'no temp or plaintext file is left');

  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 7).toString('latin1'), 'AQDBK1\n');
  for (const needle of ['INSERT INTO', 'CREATE TABLE', 'empty_table', ...MARKERS]) assert.ok(!bytes.includes(Buffer.from(needle)), `plaintext "${needle}" is visible in the file`);
  assert.throws(() => zlib.gunzipSync(bytes), 'it is not a plain gzip file');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), result.sha256);

  const [[row]] = await srcPool.query('SELECT * FROM backups WHERE id = ?', [result.id]);
  assert.equal(row.status, 'ok');
  assert.equal(row.filename, result.filename);
  assert.equal(row.sha256, result.sha256);
  assert.equal(Number(row.size_bytes), bytes.length);
  assert.equal(row.trigger_kind, 'scheduled');
  assert.equal(row.error_code, null);

  const info = await backup.inspectBackup(file);
  assert.deepEqual(info.tables, ['backups', 'cron_runs', 'empty_table', 'kv', 'parent', 'typed'], 'the table list is in the header');
  assert.equal(info.rows.kv, 1308);
  assert.equal(info.rows.typed, 9);
  // The decrypted SQL never holds a serialized object, and every JSON text is real JSON.
  let sql = '';
  for await (const piece of backup.sqlPieces(file)) sql += piece;
  assert.ok(!sql.includes('[object Object]'));
  assert.ok(sql.includes('INSERT INTO `typed`'));
  assert.equal(info.rows.empty_table, 0);
});

dbTest('restore drill: every table comes back with the same rows (odd values, JSON, batches, foreign keys)', async () => {
  await dropDb(RESTORED);
  const file = path.join(process.env.BACKUP_DIR, sourceBackup.filename);
  const lines = [];
  const result = await backup.restoreBackup({ file, target: RESTORED, expectedSha: sourceBackup.sha256, env: dbEnv(), log: (m) => lines.push(m) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tables, { backups: 1, cron_runs: 0, empty_table: 0, kv: 1308, parent: 2, typed: 9 });
  assert.ok(lines.some((l) => /Checksum matches/.test(l)));

  const restored = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: RESTORED, charset: 'utf8mb4', timezone: 'Z', dateStrings: ['DATE'], connectionLimit: 2,
  });
  restored.pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));
  try {
    for (const table of ['kv', 'parent', 'empty_table', 'typed']) {
      const [a] = await srcPool.query(`SELECT * FROM \`${table}\` ORDER BY 1`);
      const [b] = await restored.query(`SELECT * FROM \`${table}\` ORDER BY 1`);
      assert.deepEqual(b, a, `${table} differs`);
      const [[sa]] = await srcPool.query(`CHECKSUM TABLE \`${table}\``);
      const [[sb]] = await restored.query(`CHECKSUM TABLE \`${table}\``);
      assert.equal(sb.Checksum, sa.Checksum, `${table} checksum differs`);
    }
    // JSON, TEXT and binary columns: byte for byte (hex of the stored bytes), and no value turned into "[object Object]".
    const columns = 'id, HEX(CAST(j AS CHAR)) AS j, HEX(jt) AS jt, HEX(t) AS t, HEX(b) AS b, HEX(vb) AS vb, JSON_VALID(jt) AS jv';
    const [ta] = await srcPool.query(`SELECT ${columns} FROM typed ORDER BY id`);
    const [tb] = await restored.query(`SELECT ${columns} FROM typed ORDER BY id`);
    assert.equal(ta.length, 9);
    assert.deepEqual(tb, ta, 'typed columns differ after the restore');
    const [[bin]] = await restored.query('SELECT HEX(b) AS b, HEX(vb) AS vb FROM typed WHERE id = 1');
    assert.equal(bin.b, '00FF0180C328', 'binary bytes survive (0xFF is not 0xEFBFBD)');
    assert.equal(bin.vb, 'FFFE00');
    const [[jnull]] = await restored.query("SELECT COUNT(*) AS n FROM typed WHERE jt = 'null'");
    assert.equal(Number(jnull.n), 1, 'JSON null stays a value');
    const [[sqlnull]] = await restored.query('SELECT COUNT(*) AS n FROM typed WHERE j IS NULL AND jt IS NULL');
    assert.equal(Number(sqlnull.n), 4, 'SQL NULL stays NULL (4 rows have both JSON columns NULL)');
    const [[objs]] = await restored.query("SELECT COUNT(*) AS n FROM typed WHERE jt LIKE '%[object Object]%' OR t LIKE '%[object Object]%'");
    assert.equal(Number(objs.n), 0);
    // The foreign key is back and works.
    await assert.rejects(restored.query("INSERT INTO kv (parent_id, txt) VALUES (999999, 'x')"), /foreign key/i);
    const [[big]] = await restored.query("SELECT CAST(big AS CHAR) AS big, txt FROM kv WHERE txt = ?", [MARKER_AR]);
    assert.equal(String(big.big), '18446744073709551615');
  } finally {
    await restored.end();
  }
});

dbTest('a damaged, cut or wrongly keyed file is refused before the target database is touched', async () => {
  const good = path.join(process.env.BACKUP_DIR, sourceBackup.filename);
  const bytes = fs.readFileSync(good);
  const refused = async (file, expected, opts = {}) => {
    await dropDb('aqdi_bk_refused');
    await assert.rejects(
      backup.restoreBackup({ file, target: 'aqdi_bk_refused', env: dbEnv(), ...opts }),
      (err) => err.name === 'BackupError' && err.code === expected,
      `${path.basename(file)} should be refused with ${expected}`,
    );
    const c = await adminConnection();
    const [rows] = await c.query("SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = 'aqdi_bk_refused'");
    await c.end();
    assert.equal(Number(rows[0].n), 0, 'the target database was not even created');
  };

  const flipped = Buffer.from(bytes);
  flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  const flippedFile = path.join(dir, 'flipped.sql.gz.enc');
  fs.writeFileSync(flippedFile, flipped);
  await refused(flippedFile, 'sha_mismatch', { expectedSha: sourceBackup.sha256 });
  await refused(flippedFile, 'bad_key_or_corrupt'); // no checksum known: the authenticated encryption still catches it

  const cut = path.join(dir, 'cut.sql.gz.enc');
  fs.writeFileSync(cut, bytes.subarray(0, bytes.length - 5));
  await refused(cut, 'truncated');
  // Cut exactly at a frame boundary: whole frames are intact but the last one is missing.
  let at = 7;
  let lastStart = 7;
  while (at < bytes.length) {
    lastStart = at;
    at += 4 + bytes.readUInt32BE(at);
  }
  const boundary = path.join(dir, 'boundary.sql.gz.enc');
  fs.writeFileSync(boundary, bytes.subarray(0, lastStart));
  await refused(boundary, 'truncated');

  const junk = path.join(dir, 'junk.sql.gz.enc');
  fs.writeFileSync(junk, Buffer.from('this is not a backup at all'));
  await refused(junk, 'not_a_backup');

  // Wrong SECRET_BOX_KEY.
  const original = process.env.SECRET_BOX_KEY;
  process.env.SECRET_BOX_KEY = crypto.randomBytes(32).toString('hex');
  try {
    await refused(good, 'bad_key_or_corrupt', { expectedSha: sourceBackup.sha256 });
  } finally {
    process.env.SECRET_BOX_KEY = original;
  }

  // Frames from two valid backups cannot be spliced or reordered: swap two frames.
  const frames = [];
  for (let p = 7; p < bytes.length; p += 4 + bytes.readUInt32BE(p)) frames.push(bytes.subarray(p, p + 4 + bytes.readUInt32BE(p)));
  if (frames.length >= 3) {
    const swapped = Buffer.concat([bytes.subarray(0, 7), frames[1], frames[0], ...frames.slice(2)]);
    const swappedFile = path.join(dir, 'swapped.sql.gz.enc');
    fs.writeFileSync(swappedFile, swapped);
    await refused(swappedFile, 'bad_key_or_corrupt');
  }
});

dbTest('the production database and non-empty targets are refused; --overwrite and the production flag are explicit', async () => {
  const file = path.join(process.env.BACKUP_DIR, sourceBackup.filename);
  await assert.rejects(backup.restoreBackup({ file, target: process.env.DB_NAME, env: dbEnv(), expectedSha: sourceBackup.sha256 }), (e) => e.code === 'production_refused');
  await assert.rejects(backup.restoreBackup({ file, target: 'bad name; DROP', env: dbEnv() }), (e) => e.code === 'bad_target');
  await assert.rejects(backup.restoreBackup({ file, target: '', env: dbEnv() }), (e) => e.code === 'bad_target');
  await assert.rejects(backup.restoreBackup({ file: path.join(dir, 'nope.enc'), target: 'x_y', env: dbEnv() }), (e) => e.code === 'file_missing');
  // RESTORED already has the tables from the drill.
  await assert.rejects(backup.restoreBackup({ file, target: RESTORED, env: dbEnv(), expectedSha: sourceBackup.sha256 }), (e) => e.code === 'target_not_empty');
  // With the flag, a "production" database named like the throwaway one is overwritten.
  const asProduction = { ...dbEnv(), DB_NAME: RESTORED };
  await assert.rejects(backup.restoreBackup({ file, target: RESTORED, env: asProduction, expectedSha: sourceBackup.sha256 }), (e) => e.code === 'production_refused');
  const ok = await backup.restoreBackup({ file, target: RESTORED, env: asProduction, expectedSha: sourceBackup.sha256, allowProduction: true });
  assert.equal(ok.tables.kv, 1308);
  const again = await backup.restoreBackup({ file, target: RESTORED, env: dbEnv(), expectedSha: sourceBackup.sha256, overwrite: true });
  assert.equal(again.ok, true);
});

dbTest('scripts/restore-backup.js: usage, refusals and success are visible in the exit code', async () => {
  const file = path.join(process.env.BACKUP_DIR, sourceBackup.filename);
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-backup.js'), ...args], {
    env: { ...process.env, ...env, NODE_ENV: 'test', TEST_DB_NAME: process.env.TEST_DB_NAME }, encoding: 'utf8', cwd: path.join(__dirname, '..'),
  });
  const usage = run([]);
  assert.equal(usage.status, 2);
  const prod = run(['--file', file, '--target', process.env.DB_NAME]);
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /production_refused/);
  const bad = run(['--file', file, '--target', CLI_TARGET, '--sha', 'a'.repeat(64)]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /sha_mismatch/);
  await dropDb(CLI_TARGET);
  const good = run(['--file', file, '--target', CLI_TARGET, '--sha', sourceBackup.sha256]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /kv\s+1308 \/ 1308/);
  assert.match(good.stdout, /OK: every table matches/);
  for (const text of [good.stdout, good.stderr, bad.stderr, prod.stderr]) {
    assert.ok(!text.includes(process.env.SECRET_BOX_KEY), 'the key is never printed');
    for (const m of MARKERS) assert.ok(!text.includes(m), 'row data is never printed');
  }
});

// ------------------------------------------------------------ the real database, the job, the lock

dbTest('the job backs up the whole real database; the restore matches its own row counts and every table is in the file', async () => {
  const { TABLES } = require('../database/schema');
  assert.ok(TABLES.every((t) => !/\b(BLOB|BINARY)\b/i.test(t.sql)), 'no binary columns: values are dumped as text');
  const result = await cron.runJob('backup');
  assert.deepEqual(result, { ok: true, processed: 1 });
  const row = await one("SELECT * FROM backups WHERE status = 'ok' AND tables_count = ? ORDER BY id DESC LIMIT 1", [TABLES.length]);
  assert.ok(row, 'a row for the real database');
  assert.equal(row.trigger_kind, 'scheduled');
  const file = path.join(process.env.BACKUP_DIR, row.filename);
  const info = await backup.inspectBackup(file);
  assert.deepEqual(info.tables, TABLES.map((t) => t.name).sort(), 'no table is silently left out');
  await dropDb(RESTORED);
  const restored = await backup.restoreBackup({ file, target: RESTORED, env: dbEnv() });
  assert.equal(Object.keys(restored.tables).length, TABLES.length);
  // The same data: the users table of the snapshot is in the restore.
  const c = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: RESTORED });
  const [[{ n }]] = await c.query('SELECT COUNT(*) AS n FROM users WHERE phone = ?', [phone(0)]);
  await c.end();
  assert.equal(Number(n), 1);
  assert.ok(!fs.readdirSync(process.env.BACKUP_DIR).some((f) => f.endsWith('.tmp')));
});

test('a second run waits for nobody: the job lock stops a double backup', { skip }, async () => {
  const before = Number((await one('SELECT COUNT(*) AS n FROM backups')).n);
  const holder = await db.pool.getConnection();
  try {
    const [[{ got }]] = await holder.query("SELECT GET_LOCK('aqdi:job:backup', 0) AS got");
    assert.equal(Number(got), 1);
    const result = await cron.runJob('backup');
    assert.deepEqual(result, { ok: true, skipped: 'locked', processed: 0 });
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM backups')).n), before, 'no backup row, no file');
  } finally {
    await holder.query("SELECT RELEASE_LOCK('aqdi:job:backup')");
    holder.release();
  }
});

test('retention against the files: 14 daily + weekly + monthly stay, the rest and their files go, the newest is safe', { skip }, async () => {
  const keepDir = path.join(dir, 'retention');
  fs.mkdirSync(keepDir, { recursive: true, mode: 0o700 });
  await db.pool.query('DELETE FROM backups');
  const days = [];
  for (let d = new Date('2026-11-10T00:00:00Z'); d <= new Date('2026-12-19T00:00:00Z'); d = new Date(d.getTime() + 86400000)) days.push(new Date(d));
  for (const at of days) {
    const filename = backup.fileNameFor(at);
    fs.writeFileSync(path.join(keepDir, filename), 'x');
    await db.pool.query("INSERT INTO backups (filename, size_bytes, sha256, tables_count, status, created_at) VALUES (?, 1, ?, 1, 'ok', ?)", [filename, 'a'.repeat(64), at]);
  }
  // A failed row older than 90 days goes; a recent failed row stays.
  await db.pool.query("INSERT INTO backups (status, error_code, created_at) VALUES ('failed', 'old', '2026-01-01 00:00:00'), ('failed', 'recent', '2026-12-10 00:00:00')");
  fs.writeFileSync(path.join(keepDir, '.aqdi-stale.sql.gz.enc.tmp'), 'x');
  fs.utimesSync(path.join(keepDir, '.aqdi-stale.sql.gz.enc.tmp'), new Date('2026-12-01'), new Date('2026-12-01'));
  fs.writeFileSync(path.join(keepDir, 'notes.txt'), 'not ours');

  const out = await backup.applyRetention({ pool: db.pool, dir: keepDir, now: new Date('2026-12-20T09:00:00Z') });
  // Dec 6..19 (14), Sundays Nov 15/22/29, first of each month present (Nov 10 and Dec 1).
  const expected = [];
  for (const at of days) {
    const day = at.toISOString().slice(0, 10);
    const daily = at >= new Date('2026-12-06T00:00:00Z');
    const sunday = dates.weekdayOf(day) === 0;
    const first = day === '2026-11-10' || day === '2026-12-01';
    if (daily || sunday || first) expected.push(backup.fileNameFor(at));
  }
  assert.equal(out.kept, expected.length);
  assert.deepEqual(filesIn(keepDir).filter((f) => f.startsWith('aqdi-')), expected.sort());
  assert.ok(filesIn(keepDir).includes('notes.txt'), 'files that are not backups are never touched');
  assert.ok(!filesIn(keepDir).includes('.aqdi-stale.sql.gz.enc.tmp'), 'stale temp files go');
  assert.ok(expected.includes(backup.fileNameFor(new Date('2026-12-19T00:00:00Z'))), 'the newest is kept');
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'")).n), expected.length);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM backups WHERE status = 'failed'")).n), 1);
  await db.pool.query('DELETE FROM backups');
});

test('a failed backup is recorded, the platform admin is told once per day, the webhook gets only a small JSON', { skip }, async () => {
  await db.pool.query('DELETE FROM backups');
  await db.pool.query('DELETE FROM notifications WHERE user_id = ?', [adminId]);
  const failing = { query: (...a) => db.pool.query(...a), getConnection: async () => { throw Object.assign(new Error('boom with secret SQL'), { code: 'ER_TEST_FAIL' }); } };
  const env = { ...process.env, BACKUP_WEBHOOK_URL: 'https://monitor.example/hook?token=abc' };
  const now = new Date('2026-12-21T02:00:00Z');
  posts = [];
  await assert.rejects(backup.runBackup({ pool: failing, now, env }), (e) => e.code === 'ER_TEST_FAIL');
  await assert.rejects(backup.runBackup({ pool: failing, now: new Date('2026-12-21T07:00:00Z'), env }), (e) => e.code === 'ER_TEST_FAIL');
  const rows = (await db.pool.query('SELECT status, error_code, filename, sha256 FROM backups ORDER BY id'))[0];
  assert.deepEqual(rows.map((r) => [r.status, r.error_code, r.filename, r.sha256]), [['failed', 'ER_TEST_FAIL', null, null], ['failed', 'ER_TEST_FAIL', null, null]]);
  const notes = (await db.pool.query("SELECT title, body FROM notifications WHERE user_id = ? AND kind = 'backup_failed'", [adminId]))[0];
  assert.equal(notes.length, 1, 'one notification for the day');
  assert.match(notes[0].body, /ER_TEST_FAIL/);
  assert.ok(!notes[0].body.includes('secret SQL'), 'the error text is never in the notice');
  // The next day is a new notification.
  await assert.rejects(backup.runBackup({ pool: failing, now: new Date('2026-12-22T02:00:00Z'), env }), (e) => e.code === 'ER_TEST_FAIL');
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'backup_failed'", [adminId])).n), 2);
  assert.equal(posts.length, 3);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['at', 'error', 'ok']);
  assert.equal(posts[0].body.ok, false);
  assert.equal(posts[0].url, 'https://monitor.example/hook?token=abc');
  assert.deepEqual(filesIn(process.env.BACKUP_DIR).filter((f) => f.startsWith('.')), [], 'no temp file after a failure');

  // Success: size, sha256, filename and time only. A non-https URL is ignored.
  posts = [];
  const okResult = await backup.runBackup({ pool: srcPool || db.pool, now: new Date('2026-12-23T02:00:00Z'), env });
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['at', 'filename', 'ok', 'sha256', 'size']);
  assert.equal(posts[0].body.sha256, okResult.sha256);
  assert.equal(posts[0].body.ok, true);
  posts = [];
  await backup.runBackup({ pool: srcPool || db.pool, now: new Date('2026-12-24T02:00:00Z'), env: { ...env, BACKUP_WEBHOOK_URL: 'http://insecure.example/x' } });
  assert.equal(posts.length, 0);
  await db.pool.query('DELETE FROM notifications WHERE user_id = ?', [adminId]);
});

dbTest('a run that died without finishing is marked failed on the next run', async () => {
  await srcPool.query("INSERT INTO backups (status, created_at) VALUES ('running', '2026-12-24 00:00:00')");
  await backup.runBackup({ pool: srcPool, now: new Date('2026-12-25T02:00:00Z'), env: { ...process.env } });
  const [[stale]] = await srcPool.query("SELECT status, error_code FROM backups WHERE created_at = '2026-12-24 00:00:00'");
  assert.deepEqual([stale.status, stale.error_code], ['failed', 'interrupted']);
});

dbTest('two backups in the same minute get different names', async () => {
  const now = new Date('2027-01-05T10:00:00Z');
  const a = await backup.runBackup({ pool: srcPool, now, env: { ...process.env } });
  const b = await backup.runBackup({ pool: srcPool, now, env: { ...process.env } });
  assert.notEqual(a.filename, b.filename);
  assert.match(b.filename, backup.NAME_PATTERN);
});


// ------------------------------------------------------------ /admin/ops and the manual job endpoint

test('/admin/ops: platform admin only (with 2FA), no download offered, "run backup now" needs a reason, is audit-logged and limited to 3 an hour', { skip }, async () => {
  const admin = await http.login(phone(0));
  const owner = await http.registerOffice(phone(1), 'تجربة-نسخ-1');
  const staffCookie = await http.addMember(owner.office.id, phone(2), 'office_staff');
  await db.pool.query("INSERT INTO users (phone, role, is_active) VALUES (?, 'tenant', 1) ON DUPLICATE KEY UPDATE role = 'tenant'", [phone(3)]);
  const tenant = await http.login(phone(3));
  await db.pool.query('DELETE FROM backups');
  const backupRows = async () => Number((await one('SELECT COUNT(*) AS n FROM backups')).n);
  const post = (cookie, form, headers = {}) => fetch(`${http.base()}/admin/ops/backup`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie || '', Origin: http.base(), 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });

  // Who can open it.
  assert.equal((await http.request('/admin/ops')).status, 302);
  for (const cookie of [owner.cookie, staffCookie, tenant.cookie]) {
    const res = await http.request('/admin/ops', { cookie });
    assert.ok([302, 403, 404].includes(res.status), `an office or tenant session got ${res.status}`);
    const attempt = await post(cookie, { reason: 'اختبار النسخ' });
    assert.ok([302, 403, 404].includes(attempt.status), `an office or tenant POST got ${attempt.status}`);
    if (attempt.status === 302) assert.doesNotMatch(attempt.headers.get('location'), /\/admin\/ops/);
  }
  assert.equal(await backupRows(), 0, 'nobody but the admin starts a backup');
  const page = await http.request('/admin/ops', { cookie: admin.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /النسخ الاحتياطي/);
  assert.match(page.text, /حالة النظام/);
  assert.doesNotMatch(page.text, /\.sql\.gz\.enc"|href="[^"]*download/i, 'there is no download link');
  assert.equal((await http.request('/admin/ops/download/aqdi-20261007-0200.sql.gz.enc', { cookie: admin.cookie })).status, 404);
  assert.equal((await http.request('/admin/ops/backup', { cookie: admin.cookie })).status, 404, 'GET is not a route');

  // Two-factor: while it is required, an admin session without it is refused.
  process.env.REQUIRE_ADMIN_2FA = 'true';
  try {
    assert.equal((await http.request('/admin/ops', { cookie: admin.cookie })).status, 403);
    assert.equal((await post(admin.cookie, { reason: 'اختبار النسخ' })).status, 403);
  } finally {
    process.env.REQUIRE_ADMIN_2FA = 'false';
  }
  assert.equal(await backupRows(), 0);

  // A cross-site post and a missing reason start nothing (the missing reason is attempt 1 of 3 this hour).
  assert.equal((await post(admin.cookie, { reason: 'اختبار النسخ' }, { Origin: 'https://evil.example' })).status, 403);
  const noReason = await post(admin.cookie, { reason: ' ' });
  assert.equal(noReason.status, 422);
  assert.match(await noReason.text(), /اكتب سبباً/);
  assert.equal(await backupRows(), 0);

  // The job lock: a backup already running answers politely and starts nothing.
  const holder = await db.pool.getConnection();
  try {
    await holder.query("SELECT GET_LOCK('aqdi:job:backup', 0)");
    const locked = await post(admin.cookie, { reason: 'اختبار القفل' });
    assert.equal(locked.headers.get('location'), '/admin/ops?done=backup_locked');
    assert.equal(await backupRows(), 0);
  } finally {
    await holder.query("SELECT RELEASE_LOCK('aqdi:job:backup')");
    holder.release();
  }

  // A real manual run.
  const ok = await post(admin.cookie, { reason: 'قبل التحديث الكبير' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin/ops?done=backup_ok');
  const row = await one("SELECT * FROM backups WHERE status = 'ok'");
  assert.equal(row.trigger_kind, 'manual');
  assert.ok(fs.existsSync(path.join(process.env.BACKUP_DIR, row.filename)));
  const audit = await one("SELECT after_json, actor_id FROM audit_logs WHERE action = 'admin.backup.run' ORDER BY id DESC LIMIT 1");
  const after = typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json;
  assert.equal(after.reason, 'قبل التحديث الكبير');
  assert.equal(after.outcome, 'ok');
  assert.equal(Number(audit.actor_id), (await http.userByPhone(phone(0))).id);
  const after2 = await http.request('/admin/ops?done=backup_ok', { cookie: admin.cookie });
  assert.match(after2.text, new RegExp(row.filename.replace(/\./g, '\\.')));
  assert.match(after2.text, /اكتمل النسخ الاحتياطي/);
  assert.ok(after2.text.includes(row.sha256), 'the checksum is shown');

  // Attempts so far: no reason, locked, ok. The fourth inside the hour is refused.
  const fourth = await post(admin.cookie, { reason: 'مرة أخرى' });
  assert.equal(fourth.status, 429);
  assert.ok(fourth.headers.get('retry-after'));
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'")).n), 1);
});

test('POST /cron/run/backup needs the secret and answers only { ok, processed }', { skip }, async () => {
  const call = (secret) => fetch(`${http.base()}/cron/run/backup`, { method: 'POST', headers: secret === undefined ? {} : { 'X-Cron-Secret': secret } });
  assert.equal((await call()).status, 403);
  assert.equal((await call('wrong')).status, 403);
  const before = Number((await one("SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'")).n);
  const res = await call(process.env.CRON_SECRET);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, processed: 1 });
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM backups WHERE status = 'ok'")).n), before + 1);
  assert.equal((await one("SELECT status FROM cron_runs WHERE job_name = 'backup' ORDER BY id DESC LIMIT 1")).status, 'ok');
});

// ------------------------------------------------------------ logs

test('the logs of this file hold no key, file content, row data, SQL or phone number', { skip }, () => {
  const text = logLines.join('\n');
  assert.ok(!text.includes(process.env.SECRET_BOX_KEY));
  assert.ok(!text.includes('token=abc'), 'the webhook URL is never logged');
  assert.doesNotMatch(text, /INSERT INTO|CREATE TABLE|secret SQL/);
  for (const m of MARKERS) assert.ok(!text.includes(m), `${m} reached the log`);
  assert.doesNotMatch(text, /(?<![\d+])(?:\+?966|0)?5\d{8}(?!\d)/, 'a phone number reached the log');
});
