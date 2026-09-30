'use strict';

// Units of one office. Every query goes through scopeToOffice(); the office id
// always comes from req.office. Creating units (one or many) happens in a
// transaction that locks the office row and checks the plan's max_units, so
// parallel requests cannot pass the limit together.
//
// Audit rows hold ids, labels, statuses and the names of changed fields,
// never the notes text.

const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { withTransaction } = require('./transaction');
const { SAUDI_CITIES } = require('./offices');
const { parseId } = require('./landlords');
const { usableLandlord } = require('./buildings');
const planLimits = require('./planLimits');
const { toWesternDigits } = require('../utils/phone');

const PAGE_SIZE = 20;
const BULK_MAX = 30;

const UNIT_TYPES = {
  apartment: 'شقة',
  villa: 'فيلا',
  shop: 'محل',
  office: 'مكتب',
  warehouse: 'مستودع',
  land: 'أرض',
  other: 'أخرى',
};

const STATUS_LABELS = { vacant: 'شاغرة', rented: 'مؤجرة', maintenance: 'تحت الصيانة' };

// Fixed amenities list: stored as the key, shown in Arabic.
const AMENITIES = {
  ac: 'مكيف',
  kitchen: 'مطبخ راكب',
  parking: 'موقف سيارة',
  elevator: 'مصعد',
  guard: 'حارس',
  pool: 'مسبح',
  gym: 'نادي رياضي',
  internet: 'إنترنت',
  central_gas: 'غاز مركزي',
  maid_room: 'غرفة خادمة',
};

const EDITABLE = [
  'landlord_id', 'building_id', 'label', 'unit_type', 'rooms', 'bathrooms', 'area_sqm',
  'floor_no', 'is_furnished', 'city', 'district', 'base_rent', 'notes',
];
const AUDITED = ['landlord_id', 'building_id', 'label', 'unit_type'];

function clean(value, max) {
  return toWesternDigits(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Whole number in [min, max], or null when empty. Returns { value, error }. */
function wholeNumber(raw, min, max) {
  const text = clean(raw, 20);
  if (!text) return { value: null };
  if (!/^-?\d+$/.test(text)) return { error: true };
  const n = Number(text);
  if (n < min || n > max) return { error: true };
  return { value: n };
}

/**
 * Non-negative decimal with up to 2 places, as a string for DECIMAL columns
 * (never a float). Accepts "4,500", "٤٥٠٠٫٥". Returns { value, error }.
 */
function decimal(raw, max) {
  const text = clean(raw, 30).replace(/[,٬\s]/g, '').replace('٫', '.');
  if (!text) return { value: null };
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return { error: true };
  if (Number(text) > max) return { error: true };
  const [whole, fraction = ''] = text.split('.');
  return { value: `${BigInt(whole)}.${fraction.padEnd(2, '0')}` };
}

function amenityList(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  return [...new Set(list.map(String))];
}

/**
 * Checks the unit form (shape only; ownership of the landlord and building is
 * checked when saving). city may stay empty when a building is chosen: the
 * building's city is used. Returns { values, errors }.
 */
function validateUnitFields(body = {}) {
  const errors = {};
  const values = {};

  values.landlord_id = parseId(body.landlord_id);
  if (!values.landlord_id) errors.landlord_id = 'اختر المالك.';
  values.building_id = body.building_id ? parseId(body.building_id) : null;
  if (body.building_id && !values.building_id) errors.building_id = 'اختر المبنى من القائمة.';

  values.label = clean(body.label, 200).replace(/\s+/g, ' ');
  if (values.label.length < 1 || values.label.length > 120) errors.label = 'اكتب اسم الوحدة، مثل "شقة 3" (حتى 120 حرفاً).';

  values.unit_type = String(body.unit_type || 'apartment');
  if (!has(UNIT_TYPES, values.unit_type)) errors.unit_type = 'اختر نوع الوحدة من القائمة.';

  const checks = [
    ['rooms', wholeNumber(body.rooms, 0, 50), 'عدد الغرف رقم من 0 إلى 50.'],
    ['bathrooms', wholeNumber(body.bathrooms, 0, 50), 'عدد دورات المياه رقم من 0 إلى 50.'],
    ['floor_no', wholeNumber(body.floor_no, -5, 200), 'رقم الدور من -5 إلى 200.'],
    ['area_sqm', decimal(body.area_sqm, 99999999), 'المساحة رقم موجب، ويمكن أن يحتوي على منزلتين عشريتين.'],
    ['base_rent', decimal(body.base_rent, 9999999999), 'الإيجار رقم موجب بالريال، ويمكن أن يحتوي على هللات.'],
  ];
  for (const [field, result, message] of checks) {
    values[field] = result.value ?? null;
    if (result.error) errors[field] = message;
  }
  if (values.area_sqm !== null && Number(values.area_sqm) === 0) errors.area_sqm = 'المساحة يجب أن تكون أكبر من صفر.';

  values.is_furnished = ['1', 'on', 'true'].includes(String(body.is_furnished)) ? 1 : 0;

  values.city = clean(body.city, 80);
  if (values.city && !SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';
  if (!values.city && !values.building_id) errors.city = 'اختر المدينة.';

  values.district = clean(body.district, 200).replace(/\s+/g, ' ') || null;
  if (values.district && values.district.length > 80) errors.district = 'اسم الحي 80 حرفاً كحد أقصى.';

  const notes = clean(body.notes, 5000);
  values.notes = notes || null;
  if (notes.length > 1000) errors.notes = 'الملاحظات 1000 حرف كحد أقصى.';

  values.amenities = amenityList(body.amenities);
  if (values.amenities.some((a) => !has(AMENITIES, a))) errors.amenities = 'اختر المزايا من القائمة فقط.';

  return { values, errors };
}

/** Checks the "add many units" form. Returns { values, errors }. */
function validateBulkFields(body = {}) {
  const errors = {};
  const values = {};
  values.landlord_id = parseId(body.landlord_id);
  if (!values.landlord_id) errors.landlord_id = 'اختر المالك.';
  values.building_id = body.building_id ? parseId(body.building_id) : null;
  if (body.building_id && !values.building_id) errors.building_id = 'اختر المبنى من القائمة.';

  values.prefix = clean(body.prefix, 200).replace(/\s+/g, ' ');
  if (values.prefix.length < 1 || values.prefix.length > 100) errors.prefix = 'اكتب بداية الاسم، مثل "شقة".';

  const count = wholeNumber(body.count, 1, BULK_MAX);
  values.count = count.value;
  if (count.error || count.value === null) errors.count = `عدد الوحدات من 1 إلى ${BULK_MAX}.`;
  const start = wholeNumber(body.start || '1', 0, 99999);
  values.start = start.value ?? 1;
  if (start.error) errors.start = 'رقم البداية من 0 إلى 99999.';

  values.unit_type = String(body.unit_type || 'apartment');
  if (!has(UNIT_TYPES, values.unit_type)) errors.unit_type = 'اختر نوع الوحدة من القائمة.';

  const rent = decimal(body.base_rent, 9999999999);
  values.base_rent = rent.value ?? null;
  if (rent.error) errors.base_rent = 'الإيجار رقم موجب بالريال.';

  values.city = clean(body.city, 80);
  if (values.city && !SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';
  if (!values.city && !values.building_id) errors.city = 'اختر المدينة.';
  return { values, errors };
}

/** "شقة" + 12 from 1 -> ["شقة 1", ..., "شقة 12"]. */
function bulkLabels(prefix, count, start) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${start + i}`);
}

/**
 * Resolves the landlord and building for a unit inside this office. The
 * building must belong to the same landlord. Returns { ok, building, errors }.
 */
async function checkLinks(scoped, { landlordId, buildingId, keepLandlordId = null }) {
  const landlord = await usableLandlord(scoped, landlordId, keepLandlordId);
  if (!landlord) return { ok: false, errors: { landlord_id: 'اختر مالكاً من ملاك مكتبك.' } };
  if (!buildingId) return { ok: true, building: null };
  const [building] = await scoped.query(
    'SELECT id, landlord_id, city FROM buildings WHERE id = ? AND office_id = :office_id',
    [buildingId],
  );
  if (!building || Number(building.landlord_id) !== Number(landlordId)) {
    return { ok: false, errors: { building_id: 'المبنى المختار لا يتبع هذا المالك.' } };
  }
  return { ok: true, building };
}

/** Locks the office and checks the plan: { ok, usage, message }. Must be the first statement of a transaction. */
async function reserveUnits(scoped, adding) {
  const usage = await planLimits.unitUsage(scoped, { lock: true });
  const check = planLimits.checkLimit({ ...usage, adding });
  return { ok: check.ok, usage: check, message: check.ok ? null : planLimits.unitLimitMessage(check) };
}

function unitRow(fields, building) {
  return {
    landlord_id: fields.landlord_id,
    building_id: fields.building_id,
    label: fields.label,
    unit_type: fields.unit_type,
    rooms: fields.rooms,
    bathrooms: fields.bathrooms,
    area_sqm: fields.area_sqm,
    floor_no: fields.floor_no,
    is_furnished: fields.is_furnished,
    city: fields.city || building.city,
    district: fields.district,
    base_rent: fields.base_rent,
    notes: fields.notes,
  };
}

async function saveAmenities(scoped, unitId, amenities) {
  await scoped.query(
    'DELETE FROM unit_amenities WHERE unit_id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)',
    [unitId],
  );
  for (const amenity of amenities) await scoped.insert('unit_amenities', { unit_id: unitId, amenity });
}

function auditLog(scoped, ...args) {
  return createAudit({ query: (sql, params) => scoped.query(sql, params) }).write(...args);
}

/**
 * Creates one unit. Returns { ok: true, id } or { ok: false, errors } or
 * { ok: false, limit: message }.
 */
async function createUnit(pool, officeId, { fields, actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const reserve = await reserveUnits(scoped, 1); // first: see planLimits.unitUsage
    if (!reserve.ok) return { ok: false, limit: reserve.message };
    const links = await checkLinks(scoped, { landlordId: fields.landlord_id, buildingId: fields.building_id });
    if (!links.ok) return links;
    const row = unitRow(fields, links.building);
    const id = await scoped.insert('units', row);
    await saveAmenities(scoped, id, fields.amenities || []);
    await auditLog(scoped, actorId, officeId, 'unit.create', 'unit', id, null, {
      label: row.label, landlord_id: row.landlord_id, building_id: row.building_id, status: 'vacant',
    }, ip);
    return { ok: true, id };
  });
}

/** Creates `count` units in one transaction, or none. Same results as createUnit, with ids. */
async function createUnitsBulk(pool, officeId, { fields, actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const reserve = await reserveUnits(scoped, fields.count); // first: see planLimits.unitUsage
    if (!reserve.ok) return { ok: false, limit: reserve.message };
    const links = await checkLinks(scoped, { landlordId: fields.landlord_id, buildingId: fields.building_id });
    if (!links.ok) return links;
    const labels = bulkLabels(fields.prefix, fields.count, fields.start);
    const ids = [];
    for (const label of labels) {
      ids.push(await scoped.insert('units', unitRow({ ...fields, label, rooms: null, bathrooms: null, area_sqm: null,
        floor_no: null, is_furnished: 0, district: null, notes: null }, links.building)));
    }
    await auditLog(scoped, actorId, officeId, 'unit.bulk_create', 'unit', null, null, {
      count: ids.length, ids, first_label: labels[0], last_label: labels.at(-1),
      landlord_id: fields.landlord_id, building_id: fields.building_id,
    }, ip);
    return { ok: true, ids };
  });
}

/** Saves the unit form. Returns { ok, errors?, changed? }; null when not in this office. */
async function updateUnit(pool, officeId, unitId, { fields, actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [before] = await scoped.query(
      `SELECT id, ${EDITABLE.join(', ')} FROM units WHERE id = ? AND office_id = :office_id FOR UPDATE`,
      [unitId],
    );
    if (!before) return null;
    const links = await checkLinks(scoped, {
      landlordId: fields.landlord_id, buildingId: fields.building_id, keepLandlordId: Number(before.landlord_id),
    });
    if (!links.ok) return links;
    const next = unitRow(fields, links.building);
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    const changed = EDITABLE.filter((f) => !same(before[f], next[f]));
    if (changed.length) await scoped.update('units', { id: unitId }, Object.fromEntries(changed.map((f) => [f, next[f]])));

    const [{ list }] = await scoped.query(
      `SELECT COALESCE(GROUP_CONCAT(amenity ORDER BY amenity), '') AS list FROM unit_amenities
        WHERE unit_id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)`,
      [unitId],
    );
    const amenitiesChanged = list !== [...(fields.amenities || [])].sort().join(',');
    if (amenitiesChanged) await saveAmenities(scoped, unitId, fields.amenities || []);

    const allChanged = amenitiesChanged ? [...changed, 'amenities'] : changed;
    if (allChanged.length) {
      const audited = changed.filter((f) => AUDITED.includes(f));
      const pick = (src) => Object.fromEntries(audited.map((f) => [f, src[f] ?? null]));
      await auditLog(scoped, actorId, officeId, 'unit.update', 'unit', unitId, pick(before), {
        ...pick(next), also_changed: allChanged.filter((f) => !AUDITED.includes(f)),
      }, ip);
    }
    return { ok: true, changed: allChanged };
  });
}

function unitFilters({ q, landlordId, buildingId, status, unitType }) {
  const where = [];
  const params = [];
  const search = clean(q, 60);
  if (search) {
    where.push('u.label LIKE ?');
    params.push(`%${escapeLike(search)}%`);
  }
  if (landlordId) {
    where.push('u.landlord_id = ?');
    params.push(landlordId);
  }
  if (buildingId) {
    where.push('u.building_id = ?');
    params.push(buildingId);
  }
  if (has(STATUS_LABELS, status)) {
    where.push('u.status = ?');
    params.push(status);
  }
  if (has(UNIT_TYPES, unitType)) {
    where.push('u.unit_type = ?');
    params.push(unitType);
  }
  return { filter: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

async function listUnits(pool, officeId, { q = '', landlordId = null, buildingId = null, status = '', unitType = '', page = 1, pageSize = PAGE_SIZE } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const { filter, params } = unitFilters({ q, landlordId, buildingId, status, unitType });
  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n FROM units u WHERE u.office_id = :office_id${filter}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const rows = await scoped.query(
    `SELECT u.id, u.label, u.unit_type, u.status, u.city, u.district, u.rooms, u.base_rent, u.currency,
            u.landlord_id, l.label AS landlord_label, u.building_id, b.name AS building_name
       FROM units u
       JOIN landlords l ON l.id = u.landlord_id AND l.office_id = :office_id
       LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id
      WHERE u.office_id = :office_id${filter}
      ORDER BY u.label ASC, u.id ASC
      LIMIT ${pageSize} OFFSET ${(current - 1) * pageSize}`,
    params,
  );
  return { rows, total, page: current, pages };
}

/** One unit of this office with names, link counts and amenities, or null. */
async function getUnit(pool, officeId, id) {
  if (!id) return null;
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT u.*, l.label AS landlord_label, b.name AS building_name,
            (SELECT COUNT(*) FROM contracts c WHERE c.unit_id = u.id AND c.office_id = :office_id) AS contracts_count,
            (SELECT COUNT(*) FROM maintenance_requests m WHERE m.unit_id = u.id AND m.office_id = :office_id) AS maintenance_count,
            (SELECT COUNT(*) FROM listings li WHERE li.unit_id = u.id AND li.office_id = :office_id) AS listings_count
       FROM units u
       JOIN landlords l ON l.id = u.landlord_id AND l.office_id = :office_id
       LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id
      WHERE u.id = ? AND u.office_id = :office_id`,
    [id],
  );
  if (!row) return null;
  const amenities = await scoped.select('unit_amenities', { unit_id: id }, { columns: ['amenity'], orderBy: 'amenity' });
  return {
    ...row,
    contracts_count: Number(row.contracts_count),
    maintenance_count: Number(row.maintenance_count),
    listings_count: Number(row.listings_count),
    amenities: amenities.map((a) => a.amenity),
  };
}

/**
 * Deletes a unit only when it is not rented and has no contract, maintenance
 * request or listing, all checked inside the DELETE. Returns 'deleted' |
 * 'not_found' | 'rented' | 'has_contract' | 'has_links'.
 */
async function deleteUnit(pool, officeId, id, { actorId, ip }) {
  const unit = await getUnit(pool, officeId, id);
  if (!unit) return 'not_found';
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    `DELETE FROM units WHERE id = ? AND office_id = :office_id AND status <> 'rented'
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.unit_id = ?)
        AND NOT EXISTS (SELECT 1 FROM maintenance_requests m WHERE m.unit_id = ?)
        AND NOT EXISTS (SELECT 1 FROM listings li WHERE li.unit_id = ?)`,
    [id, id, id, id],
  );
  if (result.affectedRows !== 1) {
    if (unit.status === 'rented') return 'rented';
    return unit.contracts_count > 0 ? 'has_contract' : 'has_links';
  }
  await createAudit(pool).log(actorId, officeId, 'unit.delete', 'unit', id,
    { label: unit.label, status: unit.status, landlord_id: unit.landlord_id, building_id: unit.building_id }, null, ip);
  return 'deleted';
}

/** Unit numbers for the dashboard and the units page. */
async function unitCounts(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'vacant'), 0) AS vacant,
            COALESCE(SUM(status = 'rented'), 0) AS rented,
            COALESCE(SUM(status = 'maintenance'), 0) AS maintenance,
            (SELECT COUNT(*) FROM buildings WHERE office_id = :office_id) AS buildings
       FROM units WHERE office_id = :office_id`,
  );
  const usage = await planLimits.unitUsage(scoped);
  return {
    total: Number(row.total),
    vacant: Number(row.vacant),
    rented: Number(row.rented),
    maintenance: Number(row.maintenance),
    buildings: Number(row.buildings),
    limit: usage.limit,
    usageText: planLimits.usageText(usage),
  };
}

module.exports = {
  PAGE_SIZE,
  BULK_MAX,
  UNIT_TYPES,
  STATUS_LABELS,
  AMENITIES,
  validateUnitFields,
  validateBulkFields,
  bulkLabels,
  createUnit,
  createUnitsBulk,
  updateUnit,
  listUnits,
  getUnit,
  deleteUnit,
  unitCounts,
};
