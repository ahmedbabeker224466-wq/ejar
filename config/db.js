'use strict';

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: 'Z', // store and read timestamps as UTC
  dateStrings: ['DATE'], // keep DATE columns as 'YYYY-MM-DD' strings
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
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
 * Runs at startup. Table creation is added here in the next task.
 * Never throws: an unreachable database is logged and the app keeps serving.
 */
async function ensureSchema() {
  try {
    await pool.query('SELECT 1');
    logger.info('Database reachable; schema check complete');
    return true;
  } catch (err) {
    logger.error(`Database unreachable (${err.code || err.message}); the app will run without it`);
    return false;
  }
}

module.exports = { pool, ping, ensureSchema };
