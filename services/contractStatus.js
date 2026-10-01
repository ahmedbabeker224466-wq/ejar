'use strict';

// Keeps stored contract stages, unit statuses and late payments in step with
// the calendar. planStatusChanges is pure (unit-tested without a database);
// recomputeStatuses applies it. Idempotent: running it twice changes nothing
// the second time. A cron job will call recomputeStatuses for all offices;
// until then the office home page calls maybeRecompute for its office.

const engine = require('./contractEngine');
const { scopeToOffice } = require('./scopeToOffice');
const unitStatus = require('./unitStatus');
const { hoursAfter } = require('./contractDates');
const { retryOnDeadlock } = require('./transaction');
const contracts = require('./contracts');
const db = require('../config/db');
const logger = require('../utils/logger');

const BATCH = 500;
const SETTING_KEY = 'contracts.status_recomputed_at';
const MIN_INTERVAL_HOURS = 1;

/**
 * Which stored stages are out of date. rows: { id, start_date, end_date,
 * status, ... }. Terminated and renewed rows never change. Returns
 * { checked, changes: [{ id, from, to, unit_id }], byStage } where byStage
 * counts the stage every checked row has after the changes.
 */
function planStatusChanges(rows, today) {
  const changes = [];
  const byStage = {};
  let checked = 0;
  for (const row of rows) {
    if (row.status === 'terminated' || row.status === 'renewed') continue;
    checked += 1;
    const next = engine.classifyContract(row, today);
    byStage[next] = (byStage[next] || 0) + 1;
    if (next !== row.status) changes.push({ id: row.id, from: row.status, to: next, unit_id: row.unit_id ?? null });
  }
  return { checked, changes, byStage };
}

/**
 * Stored deadline copies that are missing or differ from the engine (for
 * example rows imported without them). Returns [{ id, notice_deadline,
 * rent_change_deadline }]. The engine is the source of truth; the stored
 * copies only serve sorting and filtering.
 */
function planDeadlineFixes(rows) {
  const fixes = [];
  for (const row of rows) {
    const notice = engine.noticeDeadline(row.end_date);
    const rentChange = engine.rentChangeDeadline(row.end_date);
    if (row.notice_deadline !== notice || row.rent_change_deadline !== rentChange) {
      fixes.push({ id: row.id, notice_deadline: notice, rent_change_deadline: rentChange });
    }
  }
  return fixes;
}

function merge(total, part) {
  total.checked += part.checked;
  total.changed += part.changed;
  total.unitsVacated += part.unitsVacated;
  total.unitsRented += part.unitsRented;
  total.paymentsLate += part.paymentsLate;
  total.deadlinesFixed += part.deadlinesFixed;
  for (const [stage, n] of Object.entries(part.byStage)) total.byStage[stage] = (total.byStage[stage] || 0) + n;
  return total;
}

async function recomputeOffice(pool, officeId, today) {
  const scoped = scopeToOffice(pool, officeId);
  const result = { checked: 0, changed: 0, byStage: {}, unitsVacated: 0, unitsRented: 0, paymentsLate: 0, deadlinesFixed: 0 };

  // 1. Stages, in batches by id.
  let lastId = 0;
  for (;;) {
    const rows = await scoped.query(
      `SELECT id, unit_id, start_date, end_date, status, terminated_at, renewed_at, notice_deadline, rent_change_deadline FROM contracts
        WHERE office_id = :office_id AND status NOT IN ('terminated','renewed') AND id > ?
        ORDER BY id LIMIT ${BATCH}`,
      [lastId],
    );
    if (!rows.length) break;
    lastId = rows.at(-1).id;
    for (const fix of planDeadlineFixes(rows)) {
      await scoped.query(
        'UPDATE contracts SET notice_deadline = ?, rent_change_deadline = ? WHERE id = ? AND office_id = :office_id',
        [fix.notice_deadline, fix.rent_change_deadline, fix.id],
      );
      result.deadlinesFixed += 1;
    }
    const plan = planStatusChanges(rows, today);
    result.checked += plan.checked;
    for (const [stage, n] of Object.entries(plan.byStage)) result.byStage[stage] = (result.byStage[stage] || 0) + n;
    for (const change of plan.changes) {
      const updated = await scoped.query(
        'UPDATE contracts SET status = ? WHERE id = ? AND status = ? AND office_id = :office_id',
        [change.to, change.id, change.from],
      );
      if (updated.affectedRows !== 1) continue; // changed by someone else meanwhile
      result.changed += 1;
      await contracts.addEvent(scoped, change.id, null, 'stage_changed', { from: change.from, to: change.to });
      if (change.to === 'ended' && change.unit_id) {
        const [unit] = await scoped.query('SELECT status FROM units WHERE id = ? AND office_id = :office_id', [change.unit_id]);
        if (unit && unit.status === 'rented' && (await contracts.freeUnitIfIdle(scoped, change.unit_id, change.id, today))) {
          result.unitsVacated += 1;
        }
      }
    }
    if (rows.length < BATCH) break;
  }

  // 2. Units of running contracts that have (almost) started become rented.
  const waiting = await scoped.query(
    `SELECT c.id, c.unit_id, c.start_date, c.end_date FROM contracts c
       JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE c.office_id = :office_id AND c.status IN ('calm','soon','urgent','deadline_passed') AND u.status = 'vacant'`,
  );
  for (const contract of waiting.filter((c) => engine.unitShouldBeRented(c, today))) {
    await unitStatus.setRented(scoped, contract.unit_id);
    await contracts.addEvent(scoped, contract.id, null, 'unit_rented');
    result.unitsRented += 1;
  }

  // 3. Payments past their due date that are still 'due' are late.
  const late = await scoped.query(
    "UPDATE contract_payments SET status = 'late' WHERE status = 'due' AND due_date < ? AND office_id = :office_id",
    [today],
  );
  result.paymentsLate = late.affectedRows;
  return result;
}

/**
 * Recomputes stages, unit statuses and late payments for one office, or for
 * every office when officeId is omitted. today is riyadhDate(now).
 * Returns { checked, changed, byStage, unitsVacated, unitsRented, paymentsLate, deadlinesFixed }.
 */
async function recomputeStatuses({ pool = db.pool, today, officeId = null }) {
  engine.dateWindow(today, 0); // validates today
  const total = { checked: 0, changed: 0, byStage: {}, unitsVacated: 0, unitsRented: 0, paymentsLate: 0, deadlinesFixed: 0 };
  let officeIds = [officeId];
  if (!officeId) {
    // The list of offices is platform-level data, not an office-owned table.
    const [rows] = await pool.query('SELECT id FROM offices ORDER BY id');
    officeIds = rows.map((r) => r.id);
  }
  // Statements run outside a transaction; one can lose a deadlock to a
  // contract being saved at the same moment. The work is idempotent, so the
  // office is simply recomputed again.
  for (const id of officeIds) merge(total, await retryOnDeadlock(() => recomputeOffice(pool, id, today), { retries: 3 }));
  return total;
}

/**
 * Runs recomputeStatuses for one office unless it ran in the last hour. The
 * last run time is claimed in office_settings first, so two page loads at the
 * same moment run it once. Returns the result, or null when it was skipped.
 */
async function maybeRecompute({ pool = db.pool, officeId, now = new Date(), today }) {
  const scoped = scopeToOffice(pool, officeId);
  const stamp = now.toISOString();
  const cutoff = hoursAfter(now, -MIN_INTERVAL_HOURS).toISOString();
  const inserted = await scoped.query(
    'INSERT IGNORE INTO office_settings (office_id, setting_key, setting_value) VALUES (:office_id, ?, ?)',
    [SETTING_KEY, stamp],
  );
  if (inserted.affectedRows !== 1) {
    const claimed = await scoped.query(
      `UPDATE office_settings SET setting_value = ?
        WHERE setting_key = ? AND (setting_value IS NULL OR setting_value < ?) AND office_id = :office_id`,
      [stamp, SETTING_KEY, cutoff],
    );
    if (claimed.affectedRows !== 1) return null;
  }
  try {
    return await recomputeStatuses({ pool, today, officeId });
  } catch (err) {
    // A page must still load with slightly older stages; the next hour retries.
    logger.error(`Contract status recompute failed for office ${officeId}: ${err.code || err.name}`);
    return null;
  }
}

/** Marks every 'due' installment past its date as 'late', office by office. Returns the count. */
async function markLatePayments({ pool = db.pool, today }) {
  engine.dateWindow(today, 0); // validates today
  const [offices] = await pool.query('SELECT id FROM offices ORDER BY id');
  let marked = 0;
  for (const { id } of offices) {
    const result = await scopeToOffice(pool, id).query(
      "UPDATE contract_payments SET status = 'late' WHERE status = 'due' AND due_date < ? AND office_id = :office_id",
      [today],
    );
    marked += result.affectedRows;
  }
  return marked;
}

module.exports = { planStatusChanges, planDeadlineFixes, recomputeStatuses, maybeRecompute, markLatePayments, SETTING_KEY };
