'use strict';

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');
const { TABLES, COLUMN_ADDITIONS, INDEX_ADDITIONS } = require('../database/schema');

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

/**
 * Runs at startup: creates any missing table, in dependency order, then adds
 * any column or index a newer version introduced. Safe to run repeatedly.
 * Never throws: problems are logged and the app keeps serving, so an
 * unreachable database cannot crash the process.
 */
async function ensureSchema(targetPool = pool) {
  let current = null;
  try {
    for (const table of TABLES) {
      current = table.name;
      await targetPool.query(table.sql);
    }
    for (const { table, column, definition } of COLUMN_ADDITIONS) {
      current = `${table}.${column}`;
      const [found] = await targetPool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column],
      );
      if (found.length === 0) {
        await targetPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        logger.info(`Added column ${table}.${column}`);
      }
    }
    for (const { table, index, columns } of INDEX_ADDITIONS) {
      current = `${table}.${index}`;
      const [found] = await targetPool.query(
        `SELECT 1 FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index],
      );
      if (found.length === 0) {
        await targetPool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columns})`);
        logger.info(`Added index ${table}.${index}`);
      }
    }
    logger.info(`Database schema ready (${TABLES.length} tables)`);
    return true;
  } catch (err) {
    const where = current ? ` at ${current}` : '';
    logger.error(`Database schema check failed${where}: ${err.code || err.message}`);
    return false;
  }
}

module.exports = { pool, ping, ensureSchema };
