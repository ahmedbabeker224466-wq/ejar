'use strict';

// Unit status rules.
// - 'vacant' <-> 'maintenance': office staff switch these by hand.
// - 'rented': set and cleared only by the contract system, through setRented
//   and setVacant. A manual change to or from 'rented' is refused. The unit's
//   public listing follows: rented with the unit, back to draft when vacant.

const { createAudit } = require('./audit');

const STATUSES = ['vacant', 'rented', 'maintenance'];
const MANUAL = new Set(['vacant', 'maintenance']);

/** Whether a person may change the status by hand. Returns { ok, reason }. */
function manualTransition(from, to) {
  if (!STATUSES.includes(to)) return { ok: false, reason: 'invalid' };
  if (from === 'rented') return { ok: false, reason: 'from_rented' };
  if (to === 'rented') return { ok: false, reason: 'to_rented' };
  if (!MANUAL.has(from)) return { ok: false, reason: 'invalid' };
  return { ok: true, reason: from === to ? 'unchanged' : null };
}

/**
 * Manual change by office staff. The UPDATE repeats the rule (status is not
 * 'rented'), so a contract that rents the unit at the same moment wins.
 * Returns 'changed' | 'unchanged' | 'not_found' | 'from_rented' | 'to_rented' | 'invalid'.
 */
async function changeStatusByHand(scoped, unitId, to, { actorId, ip } = {}) {
  const [unit] = await scoped.query('SELECT id, label, status FROM units WHERE id = ? AND office_id = :office_id', [unitId]);
  if (!unit) return 'not_found';
  const rule = manualTransition(unit.status, to);
  if (!rule.ok) return rule.reason;
  if (rule.reason === 'unchanged') return 'unchanged';
  const result = await scoped.query(
    "UPDATE units SET status = ? WHERE id = ? AND status IN ('vacant','maintenance') AND office_id = :office_id",
    [to, unitId],
  );
  if (result.affectedRows !== 1) return 'from_rented';
  await audit(scoped, actorId, unitId, unit.status, to, ip);
  return 'changed';
}

async function audit(scoped, actorId, unitId, from, to, ip) {
  await createAudit({ query: (sql, params) => scoped.query(sql, params) }).log(
    actorId || null, scoped.officeId, 'unit.status', 'unit', unitId, { status: from }, { status: to }, ip || null,
  );
}

/**
 * Contract system: the unit is now rented (from vacant or maintenance).
 * Returns true when the unit exists in this office.
 */
async function setRented(scoped, unitId, { actorId = null, ip = null } = {}) {
  const [unit] = await scoped.query('SELECT id, status FROM units WHERE id = ? AND office_id = :office_id', [unitId]);
  if (!unit) return false;
  if (unit.status !== 'rented') {
    await scoped.query("UPDATE units SET status = 'rented' WHERE id = ? AND office_id = :office_id", [unitId]);
    await audit(scoped, actorId, unitId, unit.status, 'rented', ip);
  }
  // A listing of a rented unit is rented too (it leaves the public site at once).
  await require('./listings').syncRented(scoped, unitId);
  return true;
}

/**
 * Contract system: the contract ended, the unit is free again. Only a rented
 * unit changes; a unit under maintenance stays under maintenance.
 * Returns true when the unit exists in this office.
 */
async function setVacant(scoped, unitId, { actorId = null, ip = null } = {}) {
  const [unit] = await scoped.query('SELECT id, status FROM units WHERE id = ? AND office_id = :office_id', [unitId]);
  if (!unit) return false;
  const result = await scoped.query(
    "UPDATE units SET status = 'vacant' WHERE id = ? AND status = 'rented' AND office_id = :office_id",
    [unitId],
  );
  if (result.affectedRows === 1) {
    await audit(scoped, actorId, unitId, 'rented', 'vacant', ip);
    // The listing goes back to draft; the office publishes it again on purpose.
    await require('./listings').syncVacant(scoped, unitId);
  }
  return true;
}

module.exports = { STATUSES, manualTransition, changeStatusByHand, setRented, setVacant };
