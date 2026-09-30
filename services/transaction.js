'use strict';

// Runs work inside one database transaction. InnoDB may roll a transaction
// back as a deadlock victim when another one touches the same rows; that
// rollback is complete, so the whole transaction is simply run again.

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK']);

/**
 * Calls fn(conn) between BEGIN and COMMIT on one pooled connection. Any error
 * rolls everything back; a deadlock is retried up to `retries` more times.
 */
async function withTransaction(pool, fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (!RETRYABLE.has(err.code) || attempt >= retries) throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = { withTransaction };
