'use strict';

// Database backup in pure Node (no mysqldump): every table is dumped inside one
// consistent snapshot as SQL (CREATE TABLE plus batched INSERTs, streamed row by
// row), gzip-compressed and encrypted chunk by chunk with AES-256-GCM
// (SECRET_BOX_KEY) while it is written. The plaintext SQL never touches the disk.
//
// File format (aqdi-YYYYMMDD-HHmm.sql.gz.enc):
//   "AQDBK1\n" then frames: uint32 length | sealed bytes (iv | tag | ciphertext)
//   of at most 64 KB of the gzip stream. Each frame is authenticated together
//   with its index and a "last frame" flag, so reordering, cutting the file or
//   changing one byte is detected.
// The SQL inside has one statement per line (string values are escaped, so a
// value never contains a raw line break) and ends with row counts for checking.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable, Transform, PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');
const db = require('../config/db');
const logger = require('../utils/logger');
const secretBox = require('./secretBox');
const dates = require('./contractDates');
const channelsTransport = require('./channels/transport');

const MAGIC = Buffer.from('AQDBK1\n', 'latin1');
const FRAME_BYTES = 64 * 1024;
const MAX_FRAME_SEALED = FRAME_BYTES + 1024;
const NAME_PATTERN = /^aqdi-\d{8}-\d{4}(?:-\d{1,2})?\.sql\.gz\.enc$/;
const ROWS_PER_INSERT = 500;
const BYTES_PER_INSERT = 256 * 1024;
const KEEP = Object.freeze({ daily: 14, weekly: 8, monthly: 6 });
const FAILED_ROWS_KEEP_DAYS = 90;
const STALE_RUN_HOURS = 6;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

class BackupError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'BackupError';
    this.code = code;
  }
}

const codeOf = (err) => String((err && (err.code || err.name)) || 'error').slice(0, 60);

// ------------------------------------------------------------ where files live

/** BACKUP_DIR (default ./backups next to the app, never under public/). Created with mode 0700. */
function backupDir(env = process.env) {
  const dir = path.resolve(env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  if (dir === PUBLIC_DIR || dir.startsWith(PUBLIC_DIR + path.sep)) {
    throw new BackupError('backup_dir_public', 'BACKUP_DIR must be outside the public folder');
  }
  return dir;
}

function ensureBackupDir(env = process.env) {
  const dir = backupDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('backup_dir_unusable', `BACKUP_DIR is not writable (${err.code || 'error'})`);
  }
  return dir;
}

/** aqdi-YYYYMMDD-HHmm.sql.gz.enc in Riyadh time; `n` > 1 only when two runs share a minute. */
function fileNameFor(at, n = 1) {
  const day = dates.riyadhDate(at).replace(/-/g, '');
  const clock = dates.riyadhClock(at).replace(':', '');
  return `aqdi-${day}-${clock}${n > 1 ? `-${n}` : ''}.sql.gz.enc`;
}

// ------------------------------------------------------------ encryption stream

/** Seals the gzip bytes frame by frame; the last frame is flagged. */
class Encryptor extends Transform {
  constructor() {
    super();
    this.pending = Buffer.alloc(0);
    this.held = null;
    this.index = 0;
    this.push(MAGIC);
  }

  frame(plain, last) {
    const aad = Buffer.alloc(9);
    aad.writeBigUInt64BE(BigInt(this.index), 0);
    aad.writeUInt8(last ? 1 : 0, 8);
    this.index += 1;
    const sealed = secretBox.sealBytes(plain, aad);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(sealed.length, 0);
    this.push(Buffer.concat([length, sealed]));
  }

  _transform(chunk, enc, cb) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length > FRAME_BYTES) {
        // One frame is always held back, so the final one can be flagged.
        if (this.held) this.frame(this.held, false);
        this.held = this.pending.subarray(0, FRAME_BYTES);
        this.pending = this.pending.subarray(FRAME_BYTES);
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _flush(cb) {
    try {
      if (this.held) this.frame(this.held, false);
      this.frame(this.pending, true);
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

/** Reads and authenticates every frame of an encrypted file; yields the gzip bytes. */
async function* decryptFrames(file) {
  const input = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
  let buf = Buffer.alloc(0);
  let headerChecked = false;
  let index = 0;
  let sawLast = false;
  for await (const chunk of input) {
    buf = Buffer.concat([buf, chunk]);
    if (!headerChecked) {
      if (buf.length < MAGIC.length) continue;
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('not_a_backup', 'Not an Aqdi backup file');
      buf = buf.subarray(MAGIC.length);
      headerChecked = true;
    }
    while (buf.length >= 4) {
      if (sawLast) throw new BackupError('corrupt', 'Data after the last frame');
      const length = buf.readUInt32BE(0);
      if (length < 28 || length > MAX_FRAME_SEALED) throw new BackupError('corrupt', 'Bad frame length');
      if (buf.length < 4 + length) break;
      const sealed = buf.subarray(4, 4 + length);
      buf = buf.subarray(4 + length);
      // The last frame is not known until the end: try "not last", then "last".
      const tryOpen = (last) => {
        const aad = Buffer.alloc(9);
        aad.writeBigUInt64BE(BigInt(index), 0);
        aad.writeUInt8(last ? 1 : 0, 8);
        return secretBox.openBytes(sealed, aad);
      };
      let plain;
      try {
        plain = tryOpen(false);
      } catch {
        try {
          plain = tryOpen(true);
          sawLast = true;
        } catch {
          throw new BackupError('bad_key_or_corrupt', 'Cannot decrypt: wrong SECRET_BOX_KEY or damaged file');
        }
      }
      index += 1;
      yield plain;
    }
  }
  if (!headerChecked) throw new BackupError('not_a_backup', 'Not an Aqdi backup file');
  if (buf.length > 0 || !sawLast) throw new BackupError('truncated', 'The backup file is incomplete');
}

// ------------------------------------------------------------ dumping

const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'NEWDATE', 'TIME', 'YEAR']);
const STRING_TYPES = new Set(['LONGLONG', 'DECIMAL', 'NEWDECIMAL', 'BIT', 'JSON']);

function typeCast(field, next) {
  if (field.type === 'JSON') return field.string('utf8'); // raw JSON text, not a parsed object
  if (DATE_TYPES.has(field.type) || STRING_TYPES.has(field.type)) return field.string();
  return next();
}

const quoteId = (name) => `\`${String(name).replace(/`/g, '``')}\``;

function valueSql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return mysql.escape(String(value));
}

/** Yields the SQL text of the whole database as seen by the snapshot on `conn`. */
async function* dumpSql(conn, now) {
  const [tableRows] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
  const tables = tableRows.map((r) => Object.values(r)[0]).sort();
  const counts = {};
  yield `-- aqdi-backup format=1\n-- created=${now.toISOString()}\n-- tables=${tables.length}: ${tables.join(',')}\n`;
  yield "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET sql_mode='NO_AUTO_VALUE_ON_ZERO';\n";
  for (const table of tables) {
    const [[created]] = await conn.query(`SHOW CREATE TABLE ${quoteId(table)}`);
    const createSql = String(created['Create Table']).replace(/\s*\n\s*/g, ' ');
    yield `-- table ${table}\nDROP TABLE IF EXISTS ${quoteId(table)};\n${createSql};\n`;
    const stream = conn.connection.query({ sql: `SELECT * FROM ${quoteId(table)}`, rowsAsArray: true, typeCast }).stream({ highWaterMark: 64 });
    let batch = [];
    let bytes = 0;
    let total = 0;
    for await (const row of stream) {
      const tuple = `(${row.map(valueSql).join(',')})`;
      batch.push(tuple);
      bytes += tuple.length;
      total += 1;
      if (batch.length >= ROWS_PER_INSERT || bytes >= BYTES_PER_INSERT) {
        yield `INSERT INTO ${quoteId(table)} VALUES ${batch.join(',')};\n`;
        batch = [];
        bytes = 0;
      }
    }
    if (batch.length) yield `INSERT INTO ${quoteId(table)} VALUES ${batch.join(',')};\n`;
    counts[table] = total;
  }
  yield 'SET FOREIGN_KEY_CHECKS=1;\n';
  for (const table of tables) yield `-- rows ${table} ${counts[table]}\n`;
  yield '-- end\n';
}

/**
 * Dumps the database of `pool` into `target` (an absolute path) in one consistent
 * snapshot. Returns { size, sha256, tables }. The file is created with mode 0600.
 */
async function writeBackupFile(pool, target, now) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new PassThrough();
    tap.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    let tables = 0;
    const source = Readable.from((async function* () {
      for await (const text of dumpSql(conn, now)) {
        const m = /^-- tables=(\d+):/m.exec(text);
        if (m) tables = Number(m[1]);
        yield text;
      }
    })(), { objectMode: false, encoding: 'utf8' });
    const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    await pipeline(source, zlib.createGzip({ level: 6 }), new Encryptor(), tap, out);
    return { size, sha256: hash.digest('hex'), tables };
  } finally {
    try {
      await conn.query('ROLLBACK');
    } catch {
      // the connection is released either way
    }
    conn.release();
  }
}

// ------------------------------------------------------------ retention (pure)

/**
 * Which backups to keep. entries: [{ id, at: Date }] of successful backups.
 * Keeps the newest backup of each of the last `daily` days, the newest backup
 * of each of the last `weekly` Sundays, the first backup of each of the last
 * `monthly` months (all Riyadh dates), and always the newest backup overall.
 * Returns { keep: Set of ids, remove: ids }.
 */
function planRetention(entries, { daily = KEEP.daily, weekly = KEEP.weekly, monthly = KEEP.monthly } = {}) {
  const sorted = [...entries].sort((a, b) => b.at - a.at || b.id - a.id);
  const keep = new Set();
  if (sorted.length) keep.add(sorted[0].id);

  const days = new Map(); // day -> newest entry (sorted is newest first)
  for (const e of sorted) {
    const day = dates.riyadhDate(e.at);
    if (!days.has(day)) days.set(day, e);
  }
  const dayKeys = [...days.keys()].sort().reverse();
  for (const day of dayKeys.slice(0, daily)) keep.add(days.get(day).id);

  const sundays = dayKeys.filter((day) => dates.weekdayOf(day) === 0);
  for (const day of sundays.slice(0, weekly)) keep.add(days.get(day).id);

  const months = new Map(); // month -> first (oldest) entry
  for (const e of [...sorted].reverse()) {
    const month = dates.riyadhMonth(e.at);
    if (!months.has(month)) months.set(month, e);
  }
  for (const month of [...months.keys()].sort().reverse().slice(0, monthly)) keep.add(months.get(month).id);

  return { keep, remove: sorted.filter((e) => !keep.has(e.id)).map((e) => e.id) };
}

async function applyRetention({ pool, dir, now }) {
  const [rows] = await pool.query("SELECT id, filename, created_at FROM backups WHERE status = 'ok' AND filename IS NOT NULL");
  const entries = rows.map((r) => ({ id: Number(r.id), at: new Date(r.created_at), filename: r.filename }));
  const { remove } = planRetention(entries);
  const byId = new Map(entries.map((e) => [e.id, e]));
  let files = 0;
  for (const id of remove) {
    const entry = byId.get(id);
    if (NAME_PATTERN.test(entry.filename)) {
      try {
        fs.unlinkSync(path.join(dir, entry.filename));
        files += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') logger.warn(`Backup retention could not remove a file (${err.code || 'error'})`);
      }
    }
    await pool.query('DELETE FROM backups WHERE id = ?', [id]);
  }
  const [failed] = await pool.query(
    "DELETE FROM backups WHERE status = 'failed' AND created_at < ?",
    [dates.daysAfter(now, -FAILED_ROWS_KEEP_DAYS)],
  );
  // Half-written files left by a crashed run.
  let stale = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\.aqdi-.*\.tmp$/.test(name)) continue;
      const full = path.join(dir, name);
      if (now.getTime() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) {
        fs.unlinkSync(full);
        stale += 1;
      }
    }
  } catch {
    // the directory listing is best effort
  }
  logger.info(`Backup retention: kept ${entries.length - remove.length}, removed ${remove.length} (${files} files, ${failed.affectedRows} old failed rows, ${stale} stale temp files)`);
  return { kept: entries.length - remove.length, removed: remove.length };
}

// ------------------------------------------------------------ running a backup

async function notifyFailure(pool, now, code) {
  try {
    const { notifyPlatformAdmins } = require('./platformNotify');
    await notifyPlatformAdmins(pool, {
      kind: 'backup_failed',
      title: 'فشل النسخ الاحتياطي',
      body: `لم يكتمل النسخ الاحتياطي (رمز الخطأ: ${code}). راجع صفحة التشغيل.`,
      link: '/admin/ops',
      dedupeKey: `backup_failed:${dates.riyadhDate(now)}`,
      urgent: true,
      now,
    });
  } catch (err) {
    logger.error(`Backup failure notice failed: ${codeOf(err)}`);
  }
}

/** POSTs a small JSON for monitoring (never the file). Never throws. */
async function pingWebhook(env, payload) {
  const url = (env.BACKUP_WEBHOOK_URL || '').trim();
  if (!url) return false;
  if (!/^https:\/\//i.test(url)) {
    logger.warn('BACKUP_WEBHOOK_URL ignored: it must start with https://');
    return false;
  }
  try {
    const res = await channelsTransport.postJson(url, payload);
    return Boolean(res && res.status >= 200 && res.status < 300);
  } catch {
    return false;
  }
}

/**
 * Runs one backup now (callers hold the 'backup' job lock). Records a row in
 * `backups`, writes the encrypted file, applies the retention and tells the
 * monitoring webhook. On failure the row says failed, platform admins get one
 * notification per day and the error is rethrown.
 */
async function runBackup({ pool = db.pool, now = new Date(), env = process.env, trigger = 'scheduled' } = {}) {
  const dir = ensureBackupDir(env);
  // A run that died without finishing must not look like it is still going.
  await pool.query(
    "UPDATE backups SET status = 'failed', error_code = 'interrupted' WHERE status = 'running' AND created_at < ?",
    [dates.hoursAfter(now, -STALE_RUN_HOURS)],
  );
  const [insert] = await pool.query("INSERT INTO backups (trigger_kind, status) VALUES (?, 'running')", [trigger === 'manual' ? 'manual' : 'scheduled']);
  const id = insert.insertId;
  let tmp = null;
  try {
    let filename;
    for (let n = 1; ; n += 1) {
      filename = fileNameFor(now, n);
      if (!fs.existsSync(path.join(dir, filename))) break;
      if (n >= 50) throw new BackupError('too_many_backups', 'Too many backups in one minute');
    }
    tmp = path.join(dir, `.${filename}.tmp`);
    const result = await writeBackupFile(pool, tmp, now);
    const final = path.join(dir, filename);
    fs.renameSync(tmp, final);
    tmp = null;
    await pool.query(
      "UPDATE backups SET status = 'ok', filename = ?, size_bytes = ?, sha256 = ?, tables_count = ? WHERE id = ?",
      [filename, result.size, result.sha256, result.tables, id],
    );
    logger.info(`Backup ${filename} written: ${result.tables} tables, ${result.size} bytes`);
    try {
      await applyRetention({ pool, dir, now });
    } catch (err) {
      logger.error(`Backup retention failed: ${codeOf(err)}`);
    }
    await pingWebhook(env, { ok: true, size: result.size, sha256: result.sha256, filename, at: now.toISOString() });
    return { id, filename, size: result.size, sha256: result.sha256, tables: result.tables };
  } catch (err) {
    const code = codeOf(err);
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
    await pool.query("UPDATE backups SET status = 'failed', error_code = ? WHERE id = ?", [code, id]).catch(() => {});
    logger.error(`Backup failed: ${code}`);
    await notifyFailure(pool, now, code);
    await pingWebhook(env, { ok: false, error: code, at: now.toISOString() });
    throw err;
  }
}

/** The newest backups for the admin page (no paths, no secrets). */
async function listBackups(pool = db.pool, limit = 30) {
  const [rows] = await pool.query(
    'SELECT id, filename, size_bytes, sha256, tables_count, trigger_kind, status, error_code, created_at FROM backups ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows;
}

// ------------------------------------------------------------ restoring

async function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Decrypts and gunzips a backup file; yields its SQL as text pieces. */
async function* sqlPieces(file) {
  const gunzip = zlib.createGunzip();
  const source = Readable.from(decryptFrames(file), { objectMode: false });
  const decoder = new StringDecoder('utf8');
  const piped = source.pipe(gunzip);
  source.on('error', (err) => gunzip.destroy(err));
  for await (const chunk of piped) yield decoder.write(chunk);
  const rest = decoder.end();
  if (rest) yield rest;
}

/** Splits text pieces into lines. */
async function* linesOf(pieces) {
  let tail = '';
  for await (const piece of pieces) {
    tail += piece;
    let at;
    while ((at = tail.indexOf('\n')) >= 0) {
      yield tail.slice(0, at);
      tail = tail.slice(at + 1);
    }
  }
  if (tail) yield tail;
}

/** One full pass: authenticates everything and reads the header and the row counts. */
async function inspectBackup(file) {
  const info = { format: null, createdAt: null, tables: [], rows: {}, complete: false, statements: 0 };
  try {
    for await (const line of linesOf(sqlPieces(file))) {
      if (line.startsWith('-- aqdi-backup format=')) info.format = Number(line.split('=')[1]);
      else if (line.startsWith('-- created=')) info.createdAt = line.slice('-- created='.length);
      else if (line.startsWith('-- tables=')) info.tables = line.slice(line.indexOf(':') + 1).trim().split(',').filter(Boolean);
      else if (line.startsWith('-- rows ')) {
        const [, , name, n] = line.split(' ');
        info.rows[name] = Number(n);
      } else if (line === '-- end') info.complete = true;
      else if (line && !line.startsWith('--')) info.statements += 1;
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('corrupt', 'The backup file is damaged');
  }
  if (info.format !== 1) throw new BackupError('not_a_backup', 'Unknown backup format');
  if (!info.complete) throw new BackupError('truncated', 'The backup file is incomplete');
  return info;
}

const TARGET_NAME = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Restores a backup file into the database `target`. Nothing is touched until the
 * whole file has been authenticated (key, checksum, completeness).
 * Refuses: a bad key or a damaged/cut file, a checksum that does not match,
 * the production database (DB_NAME) unless allowProduction, a target that
 * already has tables unless overwrite. Returns { ok, tables: {name: rows}, expected }.
 * Throws BackupError with a code on every refusal and on a row-count mismatch.
 */
async function restoreBackup({ file, target, expectedSha = null, allowProduction = false, overwrite = false, env = process.env, log = () => {} }) {
  if (!file || !fs.existsSync(file)) throw new BackupError('file_missing', 'Backup file not found');
  if (!TARGET_NAME.test(String(target || ''))) throw new BackupError('bad_target', 'The target database name is not valid');
  if (env.DB_NAME && target === env.DB_NAME && !allowProduction) {
    throw new BackupError('production_refused', 'Refusing to restore into the production database (DB_NAME)');
  }

  // 1. Checksum: from the flag, or from the backups table when it can be read.
  const actual = await sha256OfFile(file);
  let shaSource = 'none';
  let expected = expectedSha ? String(expectedSha).trim().toLowerCase() : null;
  if (expected) shaSource = 'flag';
  else {
    try {
      const [[row]] = await db.pool.query("SELECT sha256 FROM backups WHERE filename = ? AND status = 'ok' ORDER BY id DESC LIMIT 1", [path.basename(file)]);
      if (row && row.sha256) {
        expected = row.sha256;
        shaSource = 'backups table';
      }
    } catch {
      // the database may be the thing that was lost
    }
  }
  if (expected && expected !== actual) throw new BackupError('sha_mismatch', 'The checksum does not match: the file is damaged or not the one that was recorded');
  log(expected ? `Checksum matches (${shaSource}).` : 'No recorded checksum found: relying on the authenticated encryption only.');

  // 2. Full authenticated pass before anything is written.
  const info = await inspectBackup(file);
  log(`Backup of ${info.tables.length} tables, created ${info.createdAt}.`);

  // 3. Restore.
  const admin = await mysqlPromise.createConnection({
    host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT) || 3306, user: env.DB_USER, password: env.DB_PASSWORD, charset: 'utf8mb4',
  });
  try {
    await admin.query("SET time_zone = '+00:00'");
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${quoteId(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE ${quoteId(target)}`);
    const [existing] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(existing[0].n) > 0 && !overwrite && !allowProduction) {
      throw new BackupError('target_not_empty', 'The target database already has tables (use --overwrite)');
    }
    for await (const line of linesOf(sqlPieces(file))) {
      if (!line || line.startsWith('--')) continue;
      await admin.query(line);
    }
    await admin.query('SET FOREIGN_KEY_CHECKS=1');
    const counts = {};
    const mismatches = [];
    for (const table of info.tables) {
      const [[row]] = await admin.query(`SELECT COUNT(*) AS n FROM ${quoteId(table)}`);
      counts[table] = Number(row.n);
      if (counts[table] !== info.rows[table]) mismatches.push(table);
    }
    if (mismatches.length) throw new BackupError('count_mismatch', `Row counts differ for: ${mismatches.join(', ')}`);
    return { ok: true, tables: counts, expected: info.rows };
  } finally {
    await admin.end().catch(() => {});
  }
}

module.exports = {
  BackupError,
  KEEP,
  NAME_PATTERN,
  backupDir,
  ensureBackupDir,
  fileNameFor,
  planRetention,
  applyRetention,
  runBackup,
  listBackups,
  inspectBackup,
  restoreBackup,
  sha256OfFile,
  writeBackupFile,
};
