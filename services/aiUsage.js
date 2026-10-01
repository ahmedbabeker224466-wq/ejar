'use strict';

// Monthly AI contract-read allowance per office (plans.max_ai_reads_monthly,
// NULL = unlimited), counted in ai_reads_usage by Riyadh calendar month.
//
// A read first RESERVES one slot (in a transaction that locks the office row,
// so parallel requests cannot pass the limit together). Over the limit there
// is no API call. If the read then fails, the slot is RELEASED, so in the end
// only successful reads are counted.

const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { checkLimit } = require('./planLimits');
const { riyadhMonth } = require('./contractDates');

/** This month's limit and count for the office (no lock). */
async function usageFor(pool, officeId, now = new Date()) {
  const scoped = scopeToOffice(pool, officeId);
  const month = riyadhMonth(now);
  const [office] = await scoped.query(
    'SELECT p.max_ai_reads_monthly AS max_reads FROM offices o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = :office_id',
  );
  const row = await scoped.selectOne('ai_reads_usage', { month }, { columns: ['count'] });
  return {
    month,
    limit: office && office.max_reads !== null ? Number(office.max_reads) : null,
    used: row ? Number(row.count) : 0,
  };
}

/**
 * Takes one slot for this month. Returns { ok: true, month } or
 * { ok: false, limit, used } when the plan's allowance is used up.
 */
async function reserveRead(pool, officeId, now = new Date()) {
  const month = riyadhMonth(now);
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    // First statement: lock the office, so reservations queue up.
    const [office] = await scoped.query(
      `SELECT o.id, p.max_ai_reads_monthly AS max_reads FROM offices o
         LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = :office_id FOR UPDATE`,
    );
    const limit = office && office.max_reads !== null ? Number(office.max_reads) : null;
    await scoped.query(
      'INSERT IGNORE INTO ai_reads_usage (office_id, month, count) VALUES (:office_id, ?, 0)',
      [month],
    );
    const [row] = await scoped.query(
      'SELECT count FROM ai_reads_usage WHERE month = ? AND office_id = :office_id FOR UPDATE',
      [month],
    );
    const used = Number(row.count);
    if (!checkLimit({ limit, current: used, adding: 1 }).ok) return { ok: false, limit, used };
    await scoped.query('UPDATE ai_reads_usage SET count = count + 1 WHERE month = ? AND office_id = :office_id', [month]);
    return { ok: true, month };
  });
}

/** Gives a reserved slot back after a failed read. */
async function releaseRead(pool, officeId, month) {
  await scopeToOffice(pool, officeId).query(
    'UPDATE ai_reads_usage SET count = count - 1 WHERE month = ? AND count > 0 AND office_id = :office_id',
    [month],
  );
}

module.exports = { usageFor, reserveRead, releaseRead };
