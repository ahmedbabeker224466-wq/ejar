'use strict';

// Landlords of one office. Every query goes through scopeToOffice(); the
// office id always comes from req.office.
//
// Privacy: a landlord is a nickname, a city, a mobile number and free notes.
// No national ID, iqama, IBAN or address fields exist. Audit rows record the
// label, city and active flag, and only the NAMES of other changed fields
// (never the phone number or the notes text).

const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { SAUDI_CITIES } = require('./offices');
const { normalizeSaudi, toWesternDigits } = require('../utils/phone');

const PAGE_SIZE = 20;
const STATUSES = ['joined', 'invited', 'not_invited'];
const AUDITED = ['label', 'city', 'is_active'];
const EDITABLE = ['label', 'city', 'phone', 'notes'];

function clean(value, max) {
  return toWesternDigits(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** Checks the landlord form. Returns { values, errors }; never throws. */
function validateLandlordFields(body = {}) {
  const errors = {};
  const values = {};

  values.label = clean(body.label, 200).replace(/\s+/g, ' ');
  if (values.label.length < 2 || values.label.length > 120) {
    errors.label = 'اكتب اسماً مختصراً للمالك (من حرفين إلى 120 حرفاً).';
  }

  values.city = clean(body.city, 80) || null;
  if (values.city && !SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';

  const rawPhone = clean(body.phone, 30);
  values.phone = rawPhone ? normalizeSaudi(rawPhone) : null;
  if (rawPhone && !values.phone) errors.phone = 'اكتب رقم جوال سعودي صحيح، مثل 0512345678.';

  const notes = clean(body.notes, 5000);
  values.notes = notes || null;
  if (notes.length > 1000) errors.notes = 'الملاحظات 1000 حرف كحد أقصى.';

  return { values, errors };
}

/** A route id: a positive integer, or null (the caller answers 404). */
function parseId(raw) {
  return /^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null;
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Active invite = unused, unrevoked, unexpired.
const ACTIVE_INVITE = `EXISTS (SELECT 1 FROM invites i
  WHERE i.landlord_id = l.id AND i.kind = 'landlord' AND i.office_id = :office_id
    AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > UTC_TIMESTAMP())`;

function linkStatus(row) {
  if (row.user_id) return 'joined';
  return Number(row.has_active_invite) ? 'invited' : 'not_invited';
}

/**
 * One page of the office's landlords. q searches the label and the phone
 * (typed as 05..., 5... or with Arabic digits); status is one of STATUSES.
 */
async function listLandlords(pool, officeId, { q = '', status = '', page = 1 } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const where = [];
  const params = [];

  const search = clean(q, 60);
  if (search) {
    const digits = search.replace(/[\s-]/g, '').replace(/^\+/, '');
    const phonePart = /^\d{3,}$/.test(digits) ? digits.replace(/^(966|0)/, '') : null;
    if (phonePart) {
      where.push("(l.label LIKE ? OR l.phone LIKE ?)");
      params.push(`%${escapeLike(search)}%`, `%${escapeLike(phonePart)}%`);
    } else {
      where.push('l.label LIKE ?');
      params.push(`%${escapeLike(search)}%`);
    }
  }
  if (status === 'joined') where.push('l.user_id IS NOT NULL');
  if (status === 'invited') where.push(`l.user_id IS NULL AND ${ACTIVE_INVITE}`);
  if (status === 'not_invited') where.push(`l.user_id IS NULL AND NOT ${ACTIVE_INVITE}`);
  const filter = where.length ? ` AND ${where.join(' AND ')}` : '';

  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n FROM landlords l WHERE l.office_id = :office_id${filter}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);

  const rows = await scoped.query(
    `SELECT l.id, l.label, l.city, l.phone, l.is_active, l.user_id,
            (SELECT COUNT(*) FROM units u WHERE u.landlord_id = l.id AND u.office_id = :office_id) AS units_count,
            ${ACTIVE_INVITE} AS has_active_invite
       FROM landlords l
      WHERE l.office_id = :office_id${filter}
      ORDER BY l.is_active DESC, l.label ASC, l.id ASC
      LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return {
    rows: rows.map((r) => ({ ...r, units_count: Number(r.units_count), status: linkStatus(r) })),
    total,
    page: current,
    pages,
  };
}

/** One landlord of this office with its link counts, or null (also for other offices' ids). */
async function getLandlord(pool, officeId, id) {
  if (!id) return null;
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT l.id, l.label, l.city, l.phone, l.notes, l.is_active, l.user_id, l.created_at,
            (SELECT COUNT(*) FROM units u WHERE u.landlord_id = l.id AND u.office_id = :office_id) AS units_count,
            (SELECT COUNT(*) FROM contracts c WHERE c.landlord_id = l.id AND c.office_id = :office_id) AS contracts_count,
            (SELECT COUNT(*) FROM buildings b WHERE b.landlord_id = l.id AND b.office_id = :office_id) AS buildings_count,
            ${ACTIVE_INVITE} AS has_active_invite
       FROM landlords l
      WHERE l.id = ? AND l.office_id = :office_id`,
    [id],
  );
  if (!row) return null;
  return {
    ...row,
    units_count: Number(row.units_count),
    contracts_count: Number(row.contracts_count),
    buildings_count: Number(row.buildings_count),
    status: linkStatus(row),
  };
}

function auditView(row) {
  return Object.fromEntries(AUDITED.filter((f) => f in row).map((f) => [f, row[f] ?? null]));
}

async function createLandlord(pool, officeId, { fields, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const id = await scoped.insert('landlords', {
    label: fields.label,
    city: fields.city,
    phone: fields.phone,
    notes: fields.notes,
  });
  await createAudit(pool).log(actorId, officeId, 'landlord.create', 'landlord', id, null, {
    ...auditView({ ...fields, is_active: 1 }),
    fields_set: EDITABLE.filter((f) => !AUDITED.includes(f) && fields[f]),
  }, ip);
  return id;
}

/** Saves the form. Returns the changed field names, or null when not in this office. */
async function updateLandlord(pool, officeId, id, { fields, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const before = await scoped.selectOne('landlords', { id }, { columns: ['id', ...EDITABLE] });
  if (!before) return null;
  const changed = EDITABLE.filter((f) => (before[f] ?? null) !== (fields[f] ?? null));
  if (changed.length === 0) return [];
  await scoped.update('landlords', { id }, Object.fromEntries(changed.map((f) => [f, fields[f]])));
  const audited = changed.filter((f) => AUDITED.includes(f));
  const pick = (src) => Object.fromEntries(audited.map((f) => [f, src[f] ?? null]));
  await createAudit(pool).log(actorId, officeId, 'landlord.update', 'landlord', id, pick(before), {
    ...pick(fields),
    also_changed: changed.filter((f) => !AUDITED.includes(f)),
  }, ip);
  return changed;
}

/** Soft deactivate / reactivate. Returns false when not in this office. */
async function setLandlordActive(pool, officeId, id, active, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const row = await scoped.selectOne('landlords', { id }, { columns: ['id', 'is_active'] });
  if (!row) return false;
  const value = active ? 1 : 0;
  if (Number(row.is_active) === value) return true;
  await scoped.update('landlords', { id }, { is_active: value });
  await createAudit(pool).log(actorId, officeId, active ? 'landlord.activate' : 'landlord.deactivate', 'landlord', id,
    { is_active: Number(row.is_active) }, { is_active: value }, ip);
  return true;
}

/**
 * Deletes a landlord that has no units, buildings or contracts, in one
 * statement so a unit added at the same moment cannot slip through.
 * Returns 'deleted' | 'has_links' | 'not_found'.
 */
async function deleteLandlord(pool, officeId, id, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const row = await scoped.selectOne('landlords', { id }, { columns: ['id', 'label', 'city', 'is_active'] });
  if (!row) return 'not_found';
  const result = await scoped.query(
    `DELETE FROM landlords
      WHERE id = ? AND office_id = :office_id
        AND NOT EXISTS (SELECT 1 FROM units u WHERE u.landlord_id = ?)
        AND NOT EXISTS (SELECT 1 FROM buildings b WHERE b.landlord_id = ?)
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.landlord_id = ?)`,
    [id, id, id, id],
  );
  if (result.affectedRows !== 1) return 'has_links';
  await createAudit(pool).log(actorId, officeId, 'landlord.delete', 'landlord', id, auditView(row), null, ip);
  return 'deleted';
}

/** Total landlords of the office (for the dashboard). */
async function countLandlords(pool, officeId) {
  const [row] = await scopeToOffice(pool, officeId).query(
    'SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active FROM landlords WHERE office_id = :office_id',
  );
  return { total: Number(row.total), active: Number(row.active) };
}

module.exports = {
  PAGE_SIZE,
  STATUSES,
  validateLandlordFields,
  parseId,
  listLandlords,
  getLandlord,
  createLandlord,
  updateLandlord,
  setLandlordActive,
  deleteLandlord,
  countLandlords,
};
