'use strict';

// Maintenance requests. A tenant raises a request on their contract (category,
// short description, priority, up to 3 photos); the office works it through
// new -> seen -> in_progress -> done | rejected, assigns it to a team member,
// writes internal notes (office only) and public replies; the landlord of the
// unit follows it read-only and may comment.
//
// Access is decided only from database links, never from request input:
// office = the signed-in member's office; landlord = landlords.user_id link and
// the unit's landlord; tenant = contract_members link and the request's
// contract. Another person's id answers "not found" (the callers send 404).
//
// Notifications and audit rows hold ids, labels and statuses, never the
// description or reply text. Photos are re-encoded by services/images.js.

const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');
const { createNotification } = require('./notifications');
const planLimits = require('./planLimits');
const images = require('./images');
const team = require('./team');

const CATEGORIES = { plumbing: 'سباكة', electrical: 'كهرباء', ac: 'تكييف', other: 'أخرى' };
const LEGACY_CATEGORIES = { appliances: 'أجهزة', structural: 'إنشائي' };
const PRIORITIES = { low: 'منخفضة', normal: 'عادية', high: 'عاجلة' };
const STATUSES = { new: 'جديد', seen: 'تمت المشاهدة', in_progress: 'قيد التنفيذ', done: 'تم الإنجاز', rejected: 'مرفوض' };
const OPEN = ['new', 'seen', 'in_progress'];
const TRANSITIONS = { new: ['seen', 'in_progress', 'rejected'], seen: ['in_progress', 'done', 'rejected'], in_progress: ['done', 'rejected'], done: [], rejected: [] };
const VISIBILITY = { public: 'رد ظاهر للمستأجر والمالك', internal: 'ملاحظة داخلية (للمكتب فقط)' };
const LIMITS = { description: 500, message: 1000 };
const PAGE_SIZE = 20;

const categoryLabel = (key) => CATEGORIES[key] || LEGACY_CATEGORIES[key] || key;
const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

/** Free text: control characters removed (new lines kept), trimmed. Digits are not converted. */
function cleanText(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return { text, tooLong: text.length > max };
}

// ------------------------------------------------------------ validation

/** Checks the tenant's form. Returns { values, errors }. */
function validateRequest(body = {}) {
  const errors = {};
  const category = String(body.category || '');
  const priority = String(body.priority || 'normal');
  const description = cleanText(body.description, LIMITS.description);
  if (!has(CATEGORIES, category)) errors.category = 'اختر نوع المشكلة.';
  if (!has(PRIORITIES, priority)) errors.priority = 'اختر الأولوية.';
  if (!description.text) errors.description = 'اكتب وصفاً قصيراً للمشكلة.';
  else if (description.tooLong) errors.description = `الوصف ${LIMITS.description} حرفاً كحد أقصى.`;
  return { values: { category, priority, description: description.text }, errors };
}

/** Checks a reply or note. Returns { value } or { error }. */
function validateMessage(body, max = LIMITS.message) {
  const { text, tooLong } = cleanText(body, max);
  if (!text) return { error: 'اكتب نصاً.' };
  if (tooLong) return { error: `النص ${max} حرفاً كحد أقصى.` };
  return { value: text };
}

/**
 * Turns uploaded files into processed images. files: express-fileupload file
 * objects. Returns { ok, images: [Buffer] } or { ok: false, error } with
 * error 'too_many' | 'type' | 'size' | 'empty' | 'corrupt'.
 */
async function prepareImages(files) {
  const list = (Array.isArray(files) ? files : files ? [files] : []).filter((f) => f && (f.size > 0 || f.name));
  if (list.length > images.MAX_FILES) return { ok: false, error: 'too_many' };
  const out = [];
  for (const file of list) {
    const result = await images.processImage(file.data, { truncated: Boolean(file.truncated) });
    if (!result.ok) return { ok: false, error: result.error };
    out.push(result.buffer);
  }
  return { ok: true, images: out };
}

const IMAGE_ERRORS = {
  too_many: `يمكن رفع ${images.MAX_FILES} صور كحد أقصى.`,
  type: 'الصور المقبولة: JPG أو PNG أو WebP فقط.',
  size: 'حجم الصورة أكبر من 5 ميجابايت.',
  empty: 'ملف الصورة فارغ.',
  corrupt: 'تعذرت قراءة الصورة. جرّب صورة أخرى.',
};

// ------------------------------------------------------------ reading

const SELECT_REQUEST = `
  SELECT r.*, u.label AS unit_label, u.landlord_id, u.city AS unit_city, b.name AS building_name,
         a.name AS assignee_name, a.phone AS assignee_phone,
         (SELECT COUNT(*) FROM maintenance_photos ph WHERE ph.request_id = r.id) AS photo_count
    FROM maintenance_requests r
    LEFT JOIN units u ON u.id = r.unit_id AND u.office_id = :office_id
    LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id
    LEFT JOIN users a ON a.id = r.assigned_to`;

function shape(row) {
  return {
    ...row,
    id: Number(row.id),
    photo_count: Number(row.photo_count || 0),
    categoryLabel: categoryLabel(row.category),
    priorityLabel: PRIORITIES[row.priority],
    statusLabel: STATUSES[row.status],
    isOpen: OPEN.includes(row.status),
    assigneeLabel: row.assigned_to ? team.displayName({ name: row.assignee_name, phone: row.assignee_phone }) : null,
  };
}

async function getRequest(pool, officeId, id) {
  if (!id) return null;
  const [row] = await scopeToOffice(pool, officeId).query(`${SELECT_REQUEST} WHERE r.id = ? AND r.office_id = :office_id`, [id]);
  return row ? shape(row) : null;
}

/**
 * The request as one viewer may see it, or null. viewer: { kind: 'office',
 * officeId } | { kind: 'landlord', links } | { kind: 'tenant', links } (the
 * links come from services/memberships.js, i.e. from the database).
 */
async function requestForViewer(pool, viewer, id) {
  if (viewer.kind === 'office') {
    const request = await getRequest(pool, viewer.officeId, id);
    return request ? { request, officeId: Number(viewer.officeId) } : null;
  }
  for (const link of viewer.links) {
    const request = await getRequest(pool, link.office_id, id);
    if (!request) continue;
    if (viewer.kind === 'landlord' && Number(request.landlord_id) === Number(link.landlord_id)) return { request, officeId: link.office_id, link };
    if (viewer.kind === 'tenant' && request.contract_id && Number(request.contract_id) === Number(link.contract_id)) return { request, officeId: link.office_id, link };
  }
  return null;
}

/** Messages the viewer may read, oldest first. */
async function messagesFor(pool, officeId, requestId, kind) {
  const visible = kind === 'office' ? ['public', 'landlord', 'internal'] : kind === 'landlord' ? ['public', 'landlord'] : ['public'];
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT m.id, m.sender_role, m.visibility, m.body, m.created_at, u.name, u.phone, m.sender_id
       FROM maintenance_messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.request_id = ? AND m.visibility IN (?) AND m.request_id IN (SELECT id FROM maintenance_requests WHERE office_id = :office_id)
      ORDER BY m.id`,
    [requestId, visible],
  );
  return rows.map((m) => ({ ...m, author: m.sender_role === 'office' ? team.displayName(m) : m.sender_role === 'landlord' ? 'المالك' : 'المستأجر' }));
}

async function photosFor(pool, officeId, requestId) {
  return scopeToOffice(pool, officeId).query(
    `SELECT ph.id FROM maintenance_photos ph
      WHERE ph.request_id = ? AND ph.request_id IN (SELECT id FROM maintenance_requests WHERE office_id = :office_id) ORDER BY ph.id`,
    [requestId],
  );
}

function pageOf(total, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { pages, page: current, offset: (current - 1) * size };
}

/** Reads the list filters from a query string. */
function parseFilters(query = {}) {
  const status = String(query.status || '');
  return {
    status: status === 'open' || has(STATUSES, status) ? status : '',
    category: has(CATEGORIES, String(query.category || '')) ? String(query.category) : '',
    assignee: ['me', 'none'].includes(String(query.assignee || '')) ? String(query.assignee) : '',
  };
}

function filterSql(filters, userId) {
  const where = [];
  const params = [];
  if (filters.status === 'open') where.push("r.status IN ('new','seen','in_progress')");
  else if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  if (filters.category) { where.push('r.category = ?'); params.push(filters.category); }
  if (filters.assignee === 'me') { where.push('r.assigned_to = ?'); params.push(userId); }
  if (filters.assignee === 'none') where.push('r.assigned_to IS NULL');
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

/** One page of the office's requests, newest first. */
async function listForOffice(pool, officeId, { filters, userId, page = 1 }) {
  const scoped = scopeToOffice(pool, officeId);
  const f = filterSql(filters, userId);
  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n FROM maintenance_requests r WHERE r.office_id = :office_id${f.sql}`, f.params);
  const total = Number(n);
  const p = pageOf(total, page);
  const rows = await scoped.query(`${SELECT_REQUEST} WHERE r.office_id = :office_id${f.sql} ORDER BY r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${p.offset}`, f.params);
  return { total, pages: p.pages, page: p.page, rows: rows.map(shape) };
}

/** Requests on the landlord's own units (every linked office), newest first. */
async function listForLandlord(pool, links) {
  const all = [];
  for (const link of links) {
    const rows = await scopeToOffice(pool, link.office_id).query(
      `${SELECT_REQUEST} WHERE r.office_id = :office_id AND u.landlord_id = ? ORDER BY r.id DESC LIMIT 100`,
      [link.landlord_id],
    );
    for (const row of rows) all.push({ ...shape(row), officeName: link.office_name, officeId: link.office_id });
  }
  return all.sort((a, b) => b.id - a.id);
}

/** Requests on the tenant's contracts, newest first. */
async function listForTenant(pool, links) {
  const all = [];
  for (const link of links) {
    const rows = await scopeToOffice(pool, link.office_id).query(
      `${SELECT_REQUEST} WHERE r.office_id = :office_id AND r.contract_id = ? ORDER BY r.id DESC LIMIT 100`,
      [link.contract_id],
    );
    for (const row of rows) all.push({ ...shape(row), officeName: link.office_name, officeId: link.office_id });
  }
  return all.sort((a, b) => b.id - a.id);
}

// ------------------------------------------------------------ notifications

const LINKS = { office: (id) => `/office/maintenance/${id}`, landlord: (id) => `/landlord/maintenance/${id}`, tenant: (id) => `/tenant/maintenance/${id}` };

/** Active office members, optionally only the one in charge. */
async function officeRecipients(pool, officeId, request) {
  if (request.assigned_to) return [Number(request.assigned_to)];
  return (await team.listMembers(pool, officeId, { activeOnly: true })).map((m) => m.user_id);
}

async function landlordRecipient(pool, officeId, request) {
  if (!request.landlord_id) return [];
  const [row] = await scopeToOffice(pool, officeId).query(
    'SELECT user_id FROM landlords WHERE id = ? AND is_active = 1 AND user_id IS NOT NULL AND office_id = :office_id',
    [request.landlord_id],
  );
  return row ? [Number(row.user_id)] : [];
}

/**
 * Sends one notification per recipient (never the actor). audiences: a list of
 * { kind: 'office' | 'landlord' | 'tenant', users: [ids] }.
 */
async function notify(pool, { officeId, request, kind, title, body, audiences, actorId, urgent = false }) {
  const sent = new Set([Number(actorId)]);
  for (const audience of audiences) {
    for (const userId of audience.users) {
      if (sent.has(Number(userId))) continue;
      sent.add(Number(userId));
      await createNotification(pool, {
        userId, officeId, kind, title, body, link: LINKS[audience.kind](request.id), contractId: request.contract_id || null, urgent,
      });
    }
  }
}

// ------------------------------------------------------------ create

/**
 * Creates a request with its photos (already processed images). The photo
 * plan limit is checked in the same transaction, office row locked first, so
 * parallel uploads cannot pass it. Returns { ok, id } or { ok: false, error }.
 */
async function createRequest(pool, officeId, { contract, userId, values, photos = [], officeName = '', ip }) {
  const saved = [];
  try {
    for (const buffer of photos) saved.push({ ...(await images.saveImage(buffer)) });
    const result = await withTransaction(pool, async (conn) => {
      const scoped = scopeToOffice(conn, officeId);
      const usage = await planLimits.photoUsage(scoped, { lock: true }); // first: see planLimits
      if (photos.length) {
        const check = planLimits.checkLimit({ ...usage, adding: photos.length });
        if (!check.ok) return { ok: false, error: 'photo_limit', message: planLimits.photoLimitMessage(check) };
      }
      const id = await scoped.insert('maintenance_requests', {
        unit_id: contract.unit_id,
        contract_id: contract.id,
        reported_by: userId,
        category: values.category,
        description: values.description,
        priority: values.priority,
        status: 'new',
      });
      for (const photo of saved) {
        await scoped.insert('maintenance_photos', { request_id: id, path: photo.name, size_bytes: photo.size, uploaded_by: userId });
      }
      await createAudit(conn).write(userId, officeId, 'maintenance.create', 'maintenance_request', id, null,
        { category: values.category, priority: values.priority, photos: saved.length }, ip);
      return { ok: true, id };
    });
    if (!result.ok) {
      await Promise.all(saved.map((p) => images.deleteImage(p.name)));
      return result;
    }
    const request = await getRequest(pool, officeId, result.id);
    await notify(pool, {
      officeId,
      request,
      kind: 'maintenance_new',
      title: `طلب صيانة جديد: ${request.unit_label || 'وحدة'}`,
      body: `${request.categoryLabel} (${request.priorityLabel}) على ${request.unit_label || 'وحدة'}${officeName ? ` - ${officeName}` : ''}.`,
      audiences: [
        { kind: 'office', users: await officeRecipients(pool, officeId, request) },
        { kind: 'landlord', users: await landlordRecipient(pool, officeId, request) },
      ],
      actorId: userId,
      urgent: request.priority === 'high',
    });
    return result;
  } catch (err) {
    await Promise.all(saved.map((p) => images.deleteImage(p.name)));
    throw err;
  }
}

// ------------------------------------------------------------ office actions

/** Moves a request to the next status. Returns { ok } or { ok: false, error: 'not_found' | 'invalid' }. */
async function changeStatus(pool, officeId, { requestId, to, actorId, ip }) {
  if (!has(STATUSES, to)) return { ok: false, error: 'invalid' };
  const outcome = await withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [row] = await scoped.query('SELECT id, status FROM maintenance_requests WHERE id = ? AND office_id = :office_id FOR UPDATE', [requestId]);
    if (!row) return { ok: false, error: 'not_found' };
    if (!TRANSITIONS[row.status].includes(to)) return { ok: false, error: 'invalid' };
    await scoped.query(
      `UPDATE maintenance_requests SET status = ?, status_changed_at = UTC_TIMESTAMP(), status_changed_by = ?,
              seen_at = IF(? = 'seen' AND seen_at IS NULL, UTC_TIMESTAMP(), seen_at), seen_by = IF(? = 'seen' AND seen_by IS NULL, ?, seen_by),
              started_at = IF(? = 'in_progress' AND started_at IS NULL, UTC_TIMESTAMP(), started_at),
              closed_at = IF(? IN ('done','rejected'), UTC_TIMESTAMP(), closed_at)
        WHERE id = ? AND office_id = :office_id`,
      [to, actorId, to, to, actorId, to, to, requestId],
    );
    await createAudit(conn).write(actorId, officeId, 'maintenance.status', 'maintenance_request', requestId, { status: row.status }, { status: to }, ip);
    return { ok: true };
  });
  if (!outcome.ok) return outcome;
  const request = await getRequest(pool, officeId, requestId);
  await notify(pool, {
    officeId,
    request,
    kind: 'maintenance_update',
    title: `تحديث طلب الصيانة: ${request.unit_label || 'وحدة'}`,
    body: `أصبحت حالة الطلب: ${STATUSES[to]}.`,
    audiences: [
      { kind: 'tenant', users: request.reported_by ? [Number(request.reported_by)] : [] },
      { kind: 'landlord', users: await landlordRecipient(pool, officeId, request) },
      { kind: 'office', users: request.assigned_to ? [Number(request.assigned_to)] : [] },
    ],
    actorId,
  });
  return outcome;
}

/** Assigns a request to an active member of this office (or clears it with null). */
async function assign(pool, officeId, { requestId, assigneeId, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  if (assigneeId !== null) {
    const members = await team.listMembers(pool, officeId, { activeOnly: true });
    if (!members.some((m) => m.user_id === Number(assigneeId))) return { ok: false, error: 'invalid_member' };
  }
  const changed = await scoped.query(
    'UPDATE maintenance_requests SET assigned_to = ? WHERE id = ? AND office_id = :office_id AND NOT (assigned_to <=> ?)',
    [assigneeId, requestId, assigneeId],
  );
  const [exists] = await scoped.query('SELECT id FROM maintenance_requests WHERE id = ? AND office_id = :office_id', [requestId]);
  if (!exists) return { ok: false, error: 'not_found' };
  if (changed.affectedRows !== 1) return { ok: true, unchanged: true };
  await createAudit(pool).log(actorId, officeId, 'maintenance.assign', 'maintenance_request', requestId, null, { assigned_to: assigneeId }, ip);
  if (assigneeId !== null) {
    const request = await getRequest(pool, officeId, requestId);
    await notify(pool, {
      officeId,
      request,
      kind: 'maintenance_update',
      title: `أُسند إليك طلب صيانة: ${request.unit_label || 'وحدة'}`,
      body: `${request.categoryLabel} (${request.priorityLabel}).`,
      audiences: [{ kind: 'office', users: [Number(assigneeId)] }],
      actorId,
    });
  }
  return { ok: true };
}

/**
 * Adds a message. role: 'office' | 'landlord' | 'tenant'. Visibility: office
 * may write 'public' or 'internal'; a landlord's comment is visible to the
 * office and the landlord only; a tenant's reply is public. Returns { ok, id }.
 */
async function addMessage(pool, officeId, { request, userId, role, visibility, body, ip }) {
  const vis = role === 'landlord' ? 'landlord' : role === 'tenant' ? 'public' : (visibility === 'internal' ? 'internal' : 'public');
  const id = await scopeToOffice(pool, officeId).insert('maintenance_messages', {
    request_id: request.id, sender_id: userId, sender_role: role, visibility: vis, body,
  });
  await createAudit(pool).log(userId, officeId, 'maintenance.message', 'maintenance_request', request.id, null, { message_id: id, visibility: vis }, ip);
  if (vis !== 'internal') {
    const audiences = [];
    if (role !== 'office') audiences.push({ kind: 'office', users: await officeRecipients(pool, officeId, request) });
    if (role === 'office') {
      audiences.push({ kind: 'tenant', users: request.reported_by ? [Number(request.reported_by)] : [] });
      audiences.push({ kind: 'landlord', users: await landlordRecipient(pool, officeId, request) });
    }
    if (role === 'tenant') audiences.push({ kind: 'landlord', users: [] });
    await notify(pool, {
      officeId,
      request,
      kind: 'maintenance_update',
      title: `${role === 'office' ? 'رد جديد' : role === 'landlord' ? 'تعليق من المالك' : 'رد من المستأجر'} على طلب الصيانة: ${request.unit_label || 'وحدة'}`,
      body: `يوجد ${role === 'office' ? 'رد' : 'تعليق'} جديد على طلب ${request.categoryLabel}.`,
      audiences,
      actorId: userId,
    });
  }
  return { ok: true, id };
}

// ------------------------------------------------------------ photo access

/**
 * The stored file name of a photo this user may see, or null (the route
 * answers 404 for every refusal). Works from the user's own links: an active
 * office membership, landlord links and tenant links, each checked inside
 * that office.
 */
async function photoForUser(pool, user, photoId, { membership = null, landlordLinks = [], tenantLinks = [] } = {}) {
  if (!photoId) return null;
  const query = (officeId, extra, params) => scopeToOffice(pool, officeId).query(
    `SELECT ph.path FROM maintenance_photos ph
       JOIN maintenance_requests r ON r.id = ph.request_id
       LEFT JOIN units u ON u.id = r.unit_id AND u.office_id = :office_id
      WHERE ph.id = ? AND r.office_id = :office_id${extra}`,
    [photoId, ...params],
  );
  if (membership) {
    const [row] = await query(membership.officeId, '', []);
    if (row) return row.path;
  }
  for (const link of landlordLinks) {
    const [row] = await query(link.office_id, ' AND u.landlord_id = ?', [link.landlord_id]);
    if (row) return row.path;
  }
  for (const link of tenantLinks) {
    const [row] = await query(link.office_id, ' AND r.contract_id = ?', [link.contract_id]);
    if (row) return row.path;
  }
  return null;
}

module.exports = {
  CATEGORIES,
  PRIORITIES,
  STATUSES,
  OPEN,
  TRANSITIONS,
  VISIBILITY,
  LIMITS,
  IMAGE_ERRORS,
  categoryLabel,
  validateRequest,
  validateMessage,
  prepareImages,
  parseFilters,
  getRequest,
  requestForViewer,
  messagesFor,
  photosFor,
  listForOffice,
  listForLandlord,
  listForTenant,
  createRequest,
  changeStatus,
  assign,
  addMessage,
  photoForUser,
};
