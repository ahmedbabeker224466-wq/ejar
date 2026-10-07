'use strict';

// Public listings. An office publishes a vacant unit as a listing: a snapshot
// of what may be public (type, city, a fixed neighborhood, rooms, baths, area,
// annual rent, features, a short description and up to 8 photos). The listing
// never shows the unit's label, notes, district text, building, landlord, any
// name or any phone number: visitors reach the office through the in-app
// inquiry form.
//
// States: draft -> published -> hidden (by the office, by expiry or by the
// platform admin) and rented (a contract rents the unit, see unitStatus.js;
// the listing goes back to draft when the unit is vacant again). A published
// listing hides itself LISTING_DAYS after publishing or renewing (cron job
// listings_expiry), unless renewed.

const rules = require('../config/listings');
const { isNeighborhood, neighborhoodsFor, OTHER } = require('../config/neighborhoods');
const { SAUDI_CITIES } = require('../config/saudiCities');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');
const { createNotification } = require('./notifications');
const { checkLimit, listingUsage, listingLimitMessage } = require('./planLimits');
const { cleanText, findContact, contactMessage } = require('./publicText');
const { AMENITIES } = require('./units');
const money = require('./money');
const { daysAfter, riyadhDate } = require('./contractDates');
const { toWesternDigits } = require('../utils/phone');

const TYPE_LABELS = {
  apartment: 'شقة', villa: 'فيلا', shop: 'محل', office: 'مكتب', warehouse: 'مستودع', land: 'أرض', other: 'عقار',
};
const FEATURES = { ...AMENITIES, furnished: 'مفروش' };
const STATUS_LABELS = { draft: 'مسودة', published: 'منشور', rented: 'مؤجر', hidden: 'مخفي', pending_review: 'قيد المراجعة' };
const SORTS = { newest: 'l.published_at DESC, l.id DESC', price_asc: 'l.price ASC, l.id DESC', price_desc: 'l.price DESC, l.id DESC', area_desc: 'l.area_sqm DESC, l.id DESC' };

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

/** The generated public title: type, neighborhood and city only. */
function titleFor({ unit_type: type, city, neighborhood }) {
  const area = neighborhood && neighborhood !== OTHER ? `حي ${neighborhood}، ` : '';
  return `${TYPE_LABELS[type] || TYPE_LABELS.other} للإيجار في ${area}${city}`.slice(0, 160);
}

function parseCount(value, max) {
  const text = toWesternDigits(String(value ?? '')).trim();
  if (text === '') return { value: null };
  if (!/^\d{1,2}$/.test(text) || Number(text) > max) return { error: true };
  return { value: Number(text) };
}

/**
 * Checks the listing form. Returns { values, errors }. Everything public is
 * validated here: the neighborhood must be on the fixed list of the city, the
 * description may hold no phone number, link, email or IBAN.
 */
function validateListing(body = {}) {
  const errors = {};
  const values = {};

  values.unit_type = has(TYPE_LABELS, body.unit_type) ? body.unit_type : null;
  if (!values.unit_type) errors.unit_type = 'اختر نوع العقار.';

  values.city = cleanText(body.city, 80);
  if (!SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';

  values.neighborhood = cleanText(body.neighborhood, 80);
  if (!errors.city && !isNeighborhood(values.city, values.neighborhood)) errors.neighborhood = 'اختر الحي من القائمة.';

  for (const [field, max, message] of [['rooms', 20, 'عدد الغرف من 0 إلى 20.'], ['bathrooms', 20, 'عدد دورات المياه من 0 إلى 20.']]) {
    const parsed = parseCount(body[field], max);
    if (parsed.error) errors[field] = message;
    else values[field] = parsed.value;
  }

  const area = toWesternDigits(String(body.area_sqm ?? '')).replace(/,/g, '').trim();
  if (area === '') values.area_sqm = null;
  else if (!/^\d{1,6}(\.\d{1,2})?$/.test(area) || Number(area) <= 0) errors.area_sqm = 'اكتب مساحة صحيحة بالمتر المربع.';
  else values.area_sqm = Number(area).toFixed(2);

  const price = money.parseAmount(String(body.price ?? ''));
  if (price === null) errors.price = 'اكتب الإيجار السنوي بالريال (رقم أكبر من صفر).';
  else values.price = price;

  const picked = [].concat(body.features || []);
  if (picked.some((f) => !has(FEATURES, f))) errors.features = 'اختر المزايا من القائمة فقط.';
  values.features = [...new Set(picked.filter((f) => has(FEATURES, f)))];

  values.description = cleanText(body.description, rules.DESCRIPTION_MAX + 1, { multiline: true });
  if (values.description.length > rules.DESCRIPTION_MAX) errors.description = `الوصف ${rules.DESCRIPTION_MAX} حرفاً كحد أقصى.`;
  else {
    const kind = findContact(values.description);
    if (kind) errors.description = contactMessage(kind);
  }
  return { values, errors };
}

/** What a draft needs before it can be published. Returns the Arabic list of missing things. */
function missingForPublish(listing, photoCount) {
  const missing = [];
  if (!(money.fromDecimal(listing.price) > 0)) missing.push('الإيجار السنوي');
  if (String(listing.description || '').trim().length < 10) missing.push('وصف قصير (10 أحرف على الأقل)');
  if (!listing.neighborhood) missing.push('الحي');
  if (photoCount < 1) missing.push('صورة واحدة على الأقل');
  return missing;
}

/** Shapes a listing row for pages: money as halalas, features as an array. */
function present(row) {
  if (!row) return null;
  let features = row.features;
  if (typeof features === 'string') {
    try {
      features = JSON.parse(features);
    } catch {
      features = [];
    }
  }
  return {
    id: Number(row.id),
    officeId: Number(row.office_id),
    unitId: Number(row.unit_id),
    title: row.title,
    description: row.description,
    status: row.status,
    price: money.fromDecimal(row.price),
    currency: row.currency,
    unitType: row.unit_type,
    city: row.city,
    neighborhood: row.neighborhood,
    rooms: row.rooms === null ? null : Number(row.rooms),
    bathrooms: row.bathrooms === null ? null : Number(row.bathrooms),
    area: row.area_sqm === null || row.area_sqm === undefined ? null : Number(row.area_sqm),
    features: Array.isArray(features) ? features.filter((f) => has(FEATURES, f)) : [],
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    adminHidden: Boolean(Number(row.admin_hidden)),
    adminHiddenReason: row.admin_hidden_reason,
    updatedAt: row.updated_at,
    officeName: row.office_name,
    coverId: row.cover_id === undefined || row.cover_id === null ? null : Number(row.cover_id),
    photoCount: row.photo_count === undefined ? undefined : Number(row.photo_count),
    inquiryCount: row.inquiry_count === undefined ? undefined : Number(row.inquiry_count),
  };
}

// ------------------------------------------------------------ office side

const OFFICE_SELECT = `SELECT l.*,
    (SELECT p.id FROM unit_photos p WHERE p.unit_id = l.unit_id ORDER BY p.is_cover DESC, p.sort_order ASC, p.id ASC LIMIT 1) AS cover_id,
    (SELECT COUNT(*) FROM unit_photos p WHERE p.unit_id = l.unit_id) AS photo_count,
    (SELECT COUNT(*) FROM listing_inquiries q WHERE q.listing_id = l.id AND q.office_id = :office_id) AS inquiry_count
  FROM listings l`;

async function listForOffice(pool, officeId, { status = '' } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const filter = has(STATUS_LABELS, status) ? 'AND l.status = ?' : '';
  const rows = await scoped.query(
    `${OFFICE_SELECT} WHERE l.office_id = :office_id ${filter} ORDER BY l.id DESC LIMIT 200`,
    filter ? [status] : [],
  );
  return rows.map(present);
}

async function getForOffice(pool, officeId, id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) return null;
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(`${OFFICE_SELECT} WHERE l.id = ? AND l.office_id = :office_id`, [id]);
  return present(row);
}

/** Vacant units of this office that have no listing yet (the choices for a new listing). */
async function unitsWithoutListing(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  return scoped.query(
    `SELECT u.id, u.label, u.unit_type, u.city FROM units u
      WHERE u.office_id = :office_id AND u.status = 'vacant'
        AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.unit_id = u.id AND l.office_id = :office_id)
      ORDER BY u.id DESC LIMIT 300`,
  );
}

async function officeRights(scoped) {
  const [row] = await scoped.query('SELECT listings_banned FROM offices WHERE id = :office_id');
  return { banned: Boolean(row && Number(row.listings_banned)) };
}

/**
 * Creates a draft for a vacant unit, prefilled from the unit (type, rooms,
 * baths, area, city, rent, amenities; the neighborhood only when the unit's
 * district is on the fixed list). ONE transaction; the listing plan limit is
 * checked first with the office row locked. Returns { ok, id } or { ok: false, error, message }.
 */
async function createFromUnit(pool, { officeId, unitId, actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const usage = await listingUsage(scoped, { lock: true });
    const limit = checkLimit({ limit: usage.limit, current: usage.current, adding: 1 });
    if (!limit.ok) return { ok: false, error: 'limit', message: listingLimitMessage(limit) };
    if ((await officeRights(scoped)).banned) return { ok: false, error: 'banned', message: 'تم إيقاف نشر الإعلانات لمكتبك من إدارة المنصة. تواصل مع الدعم.' };

    const [unit] = await scoped.query('SELECT * FROM units WHERE id = ? AND office_id = :office_id FOR UPDATE', [unitId]);
    if (!unit) return { ok: false, error: 'not_found', message: 'الوحدة غير موجودة.' };
    if (unit.status !== 'vacant') return { ok: false, error: 'not_vacant', message: 'يمكن نشر الوحدات الشاغرة فقط.' };
    const [existing] = await scoped.query('SELECT id FROM listings WHERE unit_id = ? AND office_id = :office_id', [unitId]);
    if (existing) return { ok: false, error: 'exists', message: 'لهذه الوحدة إعلان من قبل.' };

    const amenities = await scoped.query(
      `SELECT a.amenity FROM unit_amenities a JOIN units u ON u.id = a.unit_id WHERE a.unit_id = ? AND u.office_id = :office_id`,
      [unitId],
    ).catch(() => []);
    const features = amenities.map((a) => a.amenity).filter((f) => has(FEATURES, f));
    if (Number(unit.is_furnished) === 1) features.push('furnished');
    const district = isNeighborhood(unit.city, unit.district) ? unit.district : '';
    const base = {
      unit_type: has(TYPE_LABELS, unit.unit_type) ? unit.unit_type : 'other', city: unit.city, neighborhood: district,
    };
    const id = await scoped.insert('listings', {
      unit_id: unitId,
      title: titleFor(base),
      description: '',
      price: unit.base_rent === null ? '0.00' : unit.base_rent,
      currency: 'SAR',
      status: 'draft',
      ...base,
      rooms: unit.rooms,
      bathrooms: unit.bathrooms,
      area_sqm: unit.area_sqm,
      features: JSON.stringify([...new Set(features)]),
    });
    await createAudit(conn).write(actorId, officeId, 'listing.create', 'listing', id, null, { unit_id: Number(unitId) }, ip);
    return { ok: true, id };
  });
}

/** Saves the form values of a listing that is not rented. Returns { ok } or { ok: false, error }. */
async function update(pool, { officeId, id, values, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query('SELECT * FROM listings WHERE id = ? AND office_id = :office_id', [id]);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status === 'rented') return { ok: false, error: 'rented' };
  const next = { ...values };
  const changed = ['unit_type', 'city', 'neighborhood', 'rooms', 'bathrooms', 'area_sqm', 'price', 'description', 'features']
    .filter((f) => String(f === 'features' ? JSON.stringify(next[f]) : next[f] ?? '') !== String(f === 'features' ? JSON.stringify(present(row).features) : f === 'price' ? money.fromDecimal(row.price) : row[f] ?? ''));
  await scoped.query(
    `UPDATE listings SET title = ?, unit_type = ?, city = ?, neighborhood = ?, rooms = ?, bathrooms = ?, area_sqm = ?, price = ?,
            description = ?, features = ? WHERE id = ? AND office_id = :office_id`,
    [
      titleFor(next), next.unit_type, next.city, next.neighborhood, next.rooms, next.bathrooms, next.area_sqm,
      money.toDecimal(next.price), next.description, JSON.stringify(next.features), id,
    ],
  );
  // Names of the changed fields only: never the description text.
  await createAudit(pool).log(actorId, officeId, 'listing.update', 'listing', Number(id), null, { changed }, ip);
  return { ok: true };
}

/**
 * Publishes a draft or hidden listing for LISTING_DAYS days. Refused for a
 * rented unit, an office without listing rights, a listing hidden by the
 * platform admin, or a listing missing required parts.
 * Returns { ok, expiresAt } or { ok: false, error, message }.
 */
async function publish(pool, { officeId, id, actorId, ip, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [row] = await scoped.query('SELECT * FROM listings WHERE id = ? AND office_id = :office_id FOR UPDATE', [id]);
    if (!row) return { ok: false, error: 'not_found', message: 'الإعلان غير موجود.' };
    if ((await officeRights(scoped)).banned) return { ok: false, error: 'banned', message: 'تم إيقاف نشر الإعلانات لمكتبك من إدارة المنصة. تواصل مع الدعم.' };
    if (Number(row.admin_hidden)) return { ok: false, error: 'admin_hidden', message: 'أخفت إدارة المنصة هذا الإعلان، ولا يمكن نشره مرة أخرى.' };
    if (row.status === 'rented') return { ok: false, error: 'rented', message: 'الوحدة مؤجرة. يعود الإعلان مسودة عندما تُصبح الوحدة شاغرة.' };
    const [unit] = await scoped.query('SELECT status FROM units WHERE id = ? AND office_id = :office_id', [row.unit_id]);
    if (!unit || unit.status !== 'vacant') return { ok: false, error: 'not_vacant', message: 'يمكن نشر الوحدات الشاغرة فقط.' };
    const [{ n }] = await scoped.query(
      'SELECT COUNT(*) AS n FROM unit_photos p JOIN units u ON u.id = p.unit_id WHERE p.unit_id = ? AND u.office_id = :office_id',
      [row.unit_id],
    );
    const missing = missingForPublish(row, Number(n));
    if (missing.length) return { ok: false, error: 'incomplete', message: `أكمل أولاً: ${missing.join('، ')}.` };
    const expiresAt = daysAfter(now, rules.LISTING_DAYS);
    await scoped.query(
      "UPDATE listings SET status = 'published', published_at = COALESCE(published_at, ?), expires_at = ? WHERE id = ? AND office_id = :office_id",
      [now, expiresAt, id],
    );
    await createAudit(conn).write(actorId, officeId, 'listing.publish', 'listing', Number(id), { status: row.status }, { status: 'published' }, ip);
    return { ok: true, expiresAt };
  });
}

/** Takes a published listing off the public site (it can be published again). */
async function hide(pool, { officeId, id, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    "UPDATE listings SET status = 'hidden' WHERE id = ? AND status = 'published' AND office_id = :office_id",
    [id],
  );
  if (result.affectedRows !== 1) return { ok: false };
  await createAudit(pool).log(actorId, officeId, 'listing.hide', 'listing', Number(id), { status: 'published' }, { status: 'hidden' }, ip);
  return { ok: true };
}

/**
 * Renews a published listing for another LISTING_DAYS days, or publishes a
 * listing that hid itself by expiry again (same rules as publish).
 */
async function renew(pool, { officeId, id, actorId, ip, now = new Date() }) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query('SELECT status, expires_at FROM listings WHERE id = ? AND office_id = :office_id', [id]);
  if (!row) return { ok: false, error: 'not_found', message: 'الإعلان غير موجود.' };
  if (row.status === 'published') {
    const expiresAt = daysAfter(now, rules.LISTING_DAYS);
    await scoped.query("UPDATE listings SET expires_at = ? WHERE id = ? AND status = 'published' AND office_id = :office_id", [expiresAt, id]);
    await createAudit(pool).log(actorId, officeId, 'listing.renew', 'listing', Number(id), null, { days: rules.LISTING_DAYS }, ip);
    return { ok: true, expiresAt };
  }
  return publish(pool, { officeId, id, actorId, ip, now });
}

/** Deletes the listing; returns the photo file names to remove from disk (after the row is gone). */
async function remove(pool, { officeId, id, actorId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [row] = await scoped.query('SELECT id, unit_id FROM listings WHERE id = ? AND office_id = :office_id FOR UPDATE', [id]);
    if (!row) return { ok: false };
    const photos = await scoped.query(
      'SELECT p.path, p.thumb_path FROM unit_photos p JOIN units u ON u.id = p.unit_id WHERE p.unit_id = ? AND u.office_id = :office_id',
      [row.unit_id],
    );
    await scoped.query('DELETE FROM unit_photos WHERE unit_id = ? AND unit_id IN (SELECT id FROM units WHERE office_id = :office_id)', [row.unit_id]);
    await scoped.query('DELETE FROM listings WHERE id = ? AND office_id = :office_id', [id]);
    await createAudit(conn).write(actorId, officeId, 'listing.delete', 'listing', Number(id), null, null, ip);
    return { ok: true, files: photos.flatMap((p) => [p.path, p.thumb_path].filter(Boolean)) };
  });
}

// ------------------------------------------------------------ unit status sync (called by unitStatus.js)

/** The unit was rented: its listing is rented too, whatever its state. */
async function syncRented(scoped, unitId) {
  await scoped.query(
    "UPDATE listings SET status = 'rented' WHERE unit_id = ? AND office_id = :office_id AND status IN ('draft','published','hidden','pending_review')",
    [unitId],
  );
}

/** The unit is vacant again: a rented listing goes back to draft (the office publishes it again on purpose). */
async function syncVacant(scoped, unitId) {
  await scoped.query(
    "UPDATE listings SET status = 'draft', published_at = NULL, expires_at = NULL WHERE unit_id = ? AND office_id = :office_id AND status = 'rented'",
    [unitId],
  );
}

// ------------------------------------------------------------ daily job

/**
 * The listing expiry job (cron 'listings_expiry'), idempotent:
 *  - owners are reminded REMIND_DAYS days before a listing hides itself
 *    (notification dedupe key listing_expiring:l<id>:<expiry day>)
 *  - published listings past expires_at become hidden
 * Returns the number of changes and notifications.
 */
async function runExpiry({ pool, now = new Date() }) {
  let processed = 0;
  const remindFrom = daysAfter(now, 0);
  const remindTo = daysAfter(now, rules.REMIND_DAYS);
  const [soon] = await pool.query(
    `SELECT l.id, l.office_id, l.expires_at, o.owner_id, o.name FROM listings l JOIN offices o ON o.id = l.office_id
      WHERE l.status = 'published' AND l.expires_at > ? AND l.expires_at <= ? AND o.owner_id IS NOT NULL`,
    [remindFrom, remindTo],
  );
  for (const row of soon) {
    const id = await createNotification(pool, {
      userId: row.owner_id, officeId: row.office_id, kind: 'listing_expiring', title: 'إعلان على وشك أن يُخفى',
      body: `الإعلان رقم ${row.id} في ${row.name} سيُخفى تلقائياً في ${riyadhDate(new Date(row.expires_at))}. جدّده من صفحة الإعلانات إن كان ما زال متاحاً.`,
      link: `/office/listings/${row.id}`, dedupeKey: `listing_expiring:l${row.id}:${riyadhDate(new Date(row.expires_at))}`, now,
    });
    if (id) processed += 1;
  }
  const [expired] = await pool.query("SELECT id, office_id FROM listings WHERE status = 'published' AND expires_at <= ?", [now]);
  for (const row of expired) {
    const result = await scopeToOffice(pool, row.office_id).query(
      "UPDATE listings SET status = 'hidden' WHERE id = ? AND status = 'published' AND expires_at <= ? AND office_id = :office_id",
      [row.id, now],
    );
    if (result.affectedRows === 1) {
      processed += 1;
      await createAudit(pool).log(null, row.office_id, 'listing.expire', 'listing', Number(row.id), { status: 'published' }, { status: 'hidden' }, null);
    }
  }
  return processed;
}

// ------------------------------------------------------------ public side

// A listing is public only while published, not expired, not hidden by the
// platform admin, its office may still publish and its subscription is live.
const PUBLIC_WHERE = `l.status = 'published' AND l.admin_hidden = 0 AND l.expires_at > ? AND o.listings_banned = 0
  AND (o.status IN ('active','past_due') OR (o.status = 'trial' AND o.trial_ends_at > ?))`;

const PUBLIC_COLUMNS = `l.id, l.office_id, l.unit_id, l.title, l.description, l.status, l.price, l.currency, l.unit_type, l.city, l.neighborhood,
  l.rooms, l.bathrooms, l.area_sqm, l.features, l.published_at, l.expires_at, l.admin_hidden, l.admin_hidden_reason, l.updated_at, o.name AS office_name,
  (SELECT p.id FROM unit_photos p WHERE p.unit_id = l.unit_id ORDER BY p.is_cover DESC, p.sort_order ASC, p.id ASC LIMIT 1) AS cover_id,
  (SELECT COUNT(*) FROM unit_photos p WHERE p.unit_id = l.unit_id) AS photo_count`;

/** Reads the public search filters from a query string: only valid values survive. */
function parseFilters(query = {}) {
  const filters = {};
  const city = cleanText(query.city, 80);
  if (SAUDI_CITIES.includes(city)) filters.city = city;
  const hood = cleanText(query.neighborhood, 80);
  if (hood && hood.length <= 80 && [...SAUDI_CITIES, ''].some((c) => (c ? neighborhoodsFor(c) : [OTHER]).includes(hood))) filters.neighborhood = hood;
  if (has(TYPE_LABELS, query.type)) filters.type = query.type;
  const rooms = String(query.rooms ?? '');
  if (/^[1-9]$/.test(rooms)) filters.rooms = { min: Number(rooms), exact: true };
  else if (/^[1-9]\+$/.test(rooms)) filters.rooms = { min: Number(rooms.slice(0, -1)), exact: false };
  const min = money.parseAmount(String(query.min_price ?? ''));
  const max = money.parseAmount(String(query.max_price ?? ''));
  if (min !== null) filters.minPrice = min;
  if (max !== null) filters.maxPrice = max;
  filters.sort = has(SORTS, query.sort) ? query.sort : 'newest';
  const page = Number(query.page);
  filters.page = Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1;
  return filters;
}

/** One page of public listings. Every value is a bound parameter. */
async function searchPublic(pool, filters, now = new Date()) {
  const where = [PUBLIC_WHERE];
  const params = [now, now];
  if (filters.city) { where.push('l.city = ?'); params.push(filters.city); }
  if (filters.neighborhood) { where.push('l.neighborhood = ?'); params.push(filters.neighborhood); }
  if (filters.type) { where.push('l.unit_type = ?'); params.push(filters.type); }
  if (filters.rooms) {
    where.push(filters.rooms.exact ? 'l.rooms = ?' : 'l.rooms >= ?');
    params.push(filters.rooms.min);
  }
  if (filters.minPrice) { where.push('l.price >= ?'); params.push(money.toDecimal(filters.minPrice)); }
  if (filters.maxPrice) { where.push('l.price <= ?'); params.push(money.toDecimal(filters.maxPrice)); }
  const clause = where.join(' AND ');
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM listings l JOIN offices o ON o.id = l.office_id WHERE ${clause}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / rules.PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM listings l JOIN offices o ON o.id = l.office_id WHERE ${clause}
      ORDER BY ${SORTS[filters.sort] || SORTS.newest} LIMIT ${rules.PAGE_SIZE} OFFSET ${(page - 1) * rules.PAGE_SIZE}`,
    params,
  );
  return { rows: rows.map(present), total, page, pages };
}

/**
 * One public listing by id: { state: 'ok', listing } while it is public,
 * { state: 'gone' } once it was public and is not any more (rented, hidden,
 * expired, hidden by the admin), { state: 'none' } for a draft or an id that
 * does not exist.
 */
async function getPublic(pool, id, now = new Date()) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) return { state: 'none' };
  const [[row]] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}, o.listings_banned, o.status AS office_status, o.trial_ends_at
       FROM listings l JOIN offices o ON o.id = l.office_id WHERE l.id = ?`,
    [id],
  );
  if (!row) return { state: 'none' };
  if (row.status === 'draft' || row.status === 'pending_review') return { state: 'none' };
  const [[live]] = await pool.query(
    `SELECT COUNT(*) AS n FROM listings l JOIN offices o ON o.id = l.office_id WHERE l.id = ? AND ${PUBLIC_WHERE}`,
    [id, now, now],
  );
  if (Number(live.n) !== 1) return { state: 'gone' };
  return { state: 'ok', listing: present(row) };
}

/** Ids and timestamps of every public listing (for the sitemap). */
async function publicIndex(pool, now = new Date(), limit = 5000) {
  const [rows] = await pool.query(
    `SELECT l.id, l.updated_at FROM listings l JOIN offices o ON o.id = l.office_id WHERE ${PUBLIC_WHERE} ORDER BY l.id DESC LIMIT ${Number(limit)}`,
    [now, now],
  );
  return rows.map((r) => ({ id: Number(r.id), updatedAt: r.updated_at }));
}

module.exports = {
  TYPE_LABELS,
  FEATURES,
  STATUS_LABELS,
  PUBLIC_WHERE,
  titleFor,
  validateListing,
  missingForPublish,
  present,
  listForOffice,
  getForOffice,
  unitsWithoutListing,
  createFromUnit,
  update,
  publish,
  hide,
  renew,
  remove,
  syncRented,
  syncVacant,
  runExpiry,
  parseFilters,
  searchPublic,
  getPublic,
  publicIndex,
};
