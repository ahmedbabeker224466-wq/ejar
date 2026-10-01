'use strict';

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');
const { TABLES, COLUMN_ADDITIONS, INDEX_ADDITIONS, ENUM_ADDITIONS } = require('../database/schema');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: 'Z', // mysql2 reads and writes DATETIME values as UTC
  dateStrings: ['DATE'], // keep DATE columns as 'YYYY-MM-DD' strings
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
});

// Make CURRENT_TIMESTAMP and TIMESTAMP columns UTC on every connection, so the
// database and mysql2 agree whatever the server's own time zone is.
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

/** True when the database answers a trivial query. */
async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function countTables(targetPool) {
  const [[row]] = await targetPool.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?)',
    [TABLES.map((t) => t.name)],
  );
  return Number(row.n);
}

/**
 * Runs at startup: creates any missing table, in dependency order, then adds
 * any column or index a newer version introduced. Safe to run repeatedly.
 * Never throws: returns { ok, found, created, total, error } so the caller can
 * report it, and an unreachable database cannot crash the process.
 */
async function ensureSchema(targetPool = pool) {
  let current = null;
  const result = { ok: false, found: 0, created: 0, total: TABLES.length, error: null };
  try {
    result.found = await countTables(targetPool);
    for (const table of TABLES) {
      current = table.name;
      await targetPool.query(table.sql);
    }
    current = 'column additions';
    await addMissingColumns(targetPool, COLUMN_ADDITIONS);
    current = 'index additions';
    await addMissingIndexes(targetPool, INDEX_ADDITIONS);
    current = 'enum additions';
    await addMissingEnumValues(targetPool, ENUM_ADDITIONS);
    result.created = (await countTables(targetPool)) - result.found;
    result.ok = true;
    return result;
  } catch (err) {
    result.error = err.code || err.message;
    const where = current ? ` at ${current}` : '';
    logger.error(`Database schema check failed${where}: ${result.error}`);
    return result;
  }
}

/**
 * Adds each { table, column, definition } that is missing. Safe to run from
 * several processes at once. Returns the "table.column" names it added.
 */
async function addMissingColumns(targetPool, additions) {
  const added = [];
  for (const { table, column, definition } of additions) {
    const [found] = await targetPool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    // Another process starting at the same moment may add it first.
    if (found.length === 0
      && (await alterUnlessDone(targetPool, `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`, 'ER_DUP_FIELDNAME'))) {
      logger.info(`Added column ${table}.${column}`);
      added.push(`${table}.${column}`);
    }
  }
  return added;
}

/**
 * Widens an ENUM column when a value is missing: { table, column, value,
 * definition } with the full new column definition. Repeating it is harmless.
 * Returns the "table.column=value" entries it changed.
 */
async function addMissingEnumValues(targetPool, additions) {
  const added = [];
  for (const { table, column, value, definition } of additions) {
    const [[row]] = await targetPool.query(
      `SELECT column_type AS type FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    if (row && !String(row.type).includes(`'${value}'`)) {
      await targetPool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
      logger.info(`Added ${value} to ${table}.${column}`);
      added.push(`${table}.${column}=${value}`);
    }
  }
  return added;
}

/** Adds each { table, index, columns } that is missing. Returns the names it added. */
async function addMissingIndexes(targetPool, additions) {
  const added = [];
  for (const { table, index, columns, unique = false } of additions) {
    const [found] = await targetPool.query(
      `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index],
    );
    if (found.length === 0
      && (await alterUnlessDone(targetPool, `ALTER TABLE \`${table}\` ADD ${unique ? 'UNIQUE ' : ''}INDEX \`${index}\` (${columns})`, 'ER_DUP_KEYNAME'))) {
      logger.info(`Added index ${table}.${index}`);
      added.push(`${table}.${index}`);
    }
  }
  return added;
}

/**
 * Runs an ALTER; returns false instead of failing when the change already
 * exists (errorCode), which happens when two workers start together.
 */
async function alterUnlessDone(targetPool, sql, errorCode) {
  try {
    await targetPool.query(sql);
    return true;
  } catch (err) {
    if (err.code === errorCode) return false;
    throw err;
  }
}

module.exports = { pool, ping, ensureSchema, countTables, addMissingColumns, addMissingIndexes, addMissingEnumValues };
