'use strict';

// Buildings of one office, always under one of its landlords. Every query
// goes through scopeToOffice(); the office id always comes from req.office.
//
// Privacy: a building is a nickname, a city, an optional district and notes.
// No street address, plot or deed number, coordinates or meter numbers.
// Audit rows hold ids, the name and the names of changed fields, never notes.

const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { SAUDI_CITIES } = require('./offices');
const { parseId } = require('./landlords');
const { toWesternDigits } = require('../utils/phone');

const PAGE_SIZE = 20;
const EDITABLE = ['landlord_id', 'name', 'city', 'district', 'notes'];
const AUDITED = ['landlord_id', 'name', 'city'];

function clean(value, max) {
  return toWesternDigits(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Checks the building form (shape only; whether the landlord belongs to this
 * office is checked by saveBuilding). Returns { values, errors }.
 */
function validateBuildingFields(body = {}) {
  const errors = {};
  const values = {};

  values.landlord_id = parseId(body.landlord_id);
  if (!values.landlord_id) errors.landlord_id = 'اختر المالك.';

  values.name = clean(body.name, 200).replace(/\s+/g, ' ');
  if (values.name.length < 2 || values.name.length > 120) {
    errors.name = 'اكتب اسماً مختصراً للمبنى (من حرفين إلى 120 حرفاً).';
  }

  values.city = clean(body.city, 80);
  if (!SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';

  values.district = clean(body.district, 200).replace(/\s+/g, ' ') || null;
  if (values.district && values.district.length > 80) errors.district = 'اسم الحي 80 حرفاً كحد أقصى.';

  const notes = clean(body.notes, 5000);
  values.notes = notes || null;
  if (notes.length > 1000) errors.notes = 'الملاحظات 1000 حرف كحد أقصى.';

  return { values, errors };
}

/** This office's active landlords, plus `keepId` (the current one) even if stopped. */
async function landlordOptions(pool, officeId, keepId = null) {
  return scopeToOffice(pool, officeId).query(
    `SELECT id, label, is_active FROM landlords
      WHERE office_id = :office_id AND (is_active = 1 OR id = ?)
      ORDER BY label ASC, id ASC`,
    [keepId || 0],
  );
}

/** The landlord row when it is in this office and usable for new links, else null. */
async function usableLandlord(scoped, landlordId, keepId = null) {
  const [row] = await scoped.query(
    'SELECT id, label, is_active FROM landlords WHERE id = ? AND office_id = :office_id',
    [landlordId || 0],
  );
  if (!row) return null;
  if (!row.is_active && row.id !== keepId) return null;
  return row;
}

async function listBuildings(pool, officeId, { q = '', landlordId = null, page = 1 } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const where = [];
  const params = [];
  const search = clean(q, 60);
  if (search) {
    where.push('(b.name LIKE ? OR b.district LIKE ?)');
    params.push(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`);
  }
  if (landlordId) {
    where.push('b.landlord_id = ?');
    params.push(landlordId);
  }
  const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n FROM buildings b WHERE b.office_id = :office_id${filter}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const rows = await scoped.query(
    `SELECT b.id, b.name, b.city, b.district, b.landlord_id, l.label AS landlord_label,
            (SELECT COUNT(*) FROM units u WHERE u.building_id = b.id AND u.office_id = :office_id) AS units_count
       FROM buildings b
       JOIN landlords l ON l.id = b.landlord_id AND l.office_id = :office_id
      WHERE b.office_id = :office_id${filter}
      ORDER BY b.name ASC, b.id ASC
      LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return { rows: rows.map((r) => ({ ...r, units_count: Number(r.units_count) })), total, page: current, pages };
}

/** One building of this office with its units count, or null. */
async function getBuilding(pool, officeId, id) {
  if (!id) return null;
  const [row] = await scopeToOffice(pool, officeId).query(
    `SELECT b.id, b.landlord_id, b.name, b.city, b.district, b.notes, l.label AS landlord_label,
            (SELECT COUNT(*) FROM units u WHERE u.building_id = b.id AND u.office_id = :office_id) AS units_count
       FROM buildings b JOIN landlords l ON l.id = b.landlord_id AND l.office_id = :office_id
      WHERE b.id = ? AND b.office_id = :office_id`,
    [id],
  );
  return row ? { ...row, units_count: Number(row.units_count) } : null;
}

/** All buildings of the office for the unit form (id, name, city, landlord). */
async function buildingOptions(pool, officeId) {
  return scopeToOffice(pool, officeId).query(
    'SELECT id, name, city, landlord_id FROM buildings WHERE office_id = :office_id ORDER BY name ASC, id ASC',
  );
}

async function createBuilding(pool, officeId, { fields, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  if (!(await usableLandlord(scoped, fields.landlord_id))) return { ok: false, errors: { landlord_id: 'اختر مالكاً من ملاك مكتبك.' } };
  const id = await scoped.insert('buildings', {
    landlord_id: fields.landlord_id,
    name: fields.name,
    city: fields.city,
    district: fields.district,
    notes: fields.notes,
  });
  await createAudit(pool).log(actorId, officeId, 'building.create', 'building', id, null, {
    landlord_id: fields.landlord_id,
    name: fields.name,
    city: fields.city,
  }, ip);
  return { ok: true, id };
}

/**
 * Saves the form. The landlord may change only while the building has no
 * units, checked inside the UPDATE itself. Returns { ok, errors?, changed? }.
 */
async function updateBuilding(pool, officeId, building, { fields, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const changed = EDITABLE.filter((f) => (building[f] ?? null) !== (fields[f] ?? null));
  if (changed.length === 0) return { ok: true, changed: [] };
  const movesLandlord = changed.includes('landlord_id');
  if (movesLandlord && !(await usableLandlord(scoped, fields.landlord_id))) {
    return { ok: false, errors: { landlord_id: 'اختر مالكاً من ملاك مكتبك.' } };
  }
  const result = await scoped.query(
    `UPDATE buildings SET ${changed.map((f) => `${f} = ?`).join(', ')}
      WHERE id = ? AND office_id = :office_id
        AND (landlord_id = ? OR NOT EXISTS (SELECT 1 FROM units u WHERE u.building_id = ?))`,
    [...changed.map((f) => fields[f]), building.id, fields.landlord_id, building.id],
  );
  if (result.affectedRows !== 1) {
    return { ok: false, errors: { landlord_id: 'لا يمكن نقل مبنى فيه وحدات إلى مالك آخر.' } };
  }
  const audited = changed.filter((f) => AUDITED.includes(f));
  const pick = (src) => Object.fromEntries(audited.map((f) => [f, src[f] ?? null]));
  await createAudit(pool).log(actorId, officeId, 'building.update', 'building', building.id, pick(building), {
    ...pick(fields),
    also_changed: changed.filter((f) => !AUDITED.includes(f)),
  }, ip);
  return { ok: true, changed };
}

/** Deletes an empty building (checked inside the DELETE). 'deleted' | 'has_units' | 'not_found'. */
async function deleteBuilding(pool, officeId, id, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const row = await scoped.selectOne('buildings', { id }, { columns: ['id', 'name', 'landlord_id'] });
  if (!row) return 'not_found';
  const result = await scoped.query(
    `DELETE FROM buildings WHERE id = ? AND office_id = :office_id
        AND NOT EXISTS (SELECT 1 FROM units u WHERE u.building_id = ?)`,
    [id, id],
  );
  if (result.affectedRows !== 1) return 'has_units';
  await createAudit(pool).log(actorId, officeId, 'building.delete', 'building', id,
    { name: row.name, landlord_id: row.landlord_id }, null, ip);
  return 'deleted';
}

module.exports = {
  PAGE_SIZE,
  validateBuildingFields,
  landlordOptions,
  usableLandlord,
  listBuildings,
  getBuilding,
  buildingOptions,
  createBuilding,
  updateBuilding,
  deleteBuilding,
};
