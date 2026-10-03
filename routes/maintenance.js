'use strict';

// Maintenance requests: the office board (/office/maintenance), the landlord's
// read-only-plus-comment view (/landlord/maintenance), the tenant's requests
// (/tenant/maintenance) and the photo route (/maintenance/photos/:id).
//
// Three routers are exported: `office` (mounted in routes/office.js, after
// loadOffice), `portal` and `photos` (mounted in routes/areas.js). Who may see
// a request is decided from the database links of the signed-in user (see
// services/maintenance.js requestForViewer); an id outside them answers 404.

const express = require('express');
const fileUpload = require('express-fileupload');
const db = require('../config/db');
const maintenance = require('../services/maintenance');
const images = require('../services/images');
const team = require('../services/team');
const portal = require('../services/portal');
const { membershipsFor } = require('../services/offices');
const { landlordLinks, tenantLinks } = require('../services/memberships');
const { parseId } = require('../services/landlords');
const { riyadhNow } = require('../utils/time');
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');
const { loadArea } = require('./portal');

const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const stamp = (at) => riyadhNow(new Date(at)).slice(0, 16);

// Photos stay in memory until they are checked and re-encoded.
const upload = fileUpload({
  useTempFiles: false,
  abortOnLimit: false,
  limits: { fileSize: images.MAX_BYTES, files: images.MAX_FILES + 1, fields: 8, fieldSize: 4096 },
  uploadTimeout: 60 * 1000,
  debug: false,
});

const DONE = {
  created: 'تم إرسال طلب الصيانة. سنخبرك بأي تحديث.',
  status: 'تم تحديث حالة الطلب.',
  assigned: 'تم تحديث المسؤول عن الطلب.',
  message: 'تمت الإضافة.',
};

const LABELS = {
  categories: maintenance.CATEGORIES,
  priorities: maintenance.PRIORITIES,
  statuses: maintenance.STATUSES,
};

// ------------------------------------------------------------ shared detail rendering

async function renderDetail(req, res, { kind, found, base, status = 200, error = null }) {
  const { request, officeId } = found;
  const [messages, photos] = await Promise.all([
    maintenance.messagesFor(db.pool, officeId, request.id, kind),
    maintenance.photosFor(db.pool, officeId, request.id),
  ]);
  const members = kind === 'office' ? await team.listMembers(db.pool, officeId, { activeOnly: true }) : [];
  return res.status(status).render('maintenance/detail', {
    title: `طلب صيانة: ${request.unit_label || 'وحدة'}`,
    kind,
    request,
    messages: messages.map((m) => ({ ...m, at: stamp(m.created_at) })),
    photos,
    base,
    listUrl: kind === 'office' ? '/office/maintenance' : `/${kind}/maintenance`,
    members,
    nextStatuses: kind === 'office' ? maintenance.TRANSITIONS[request.status] : [],
    labels: LABELS,
    visibility: maintenance.VISIBILITY,
    createdAt: stamp(request.created_at),
    changedAt: request.status_changed_at ? stamp(request.status_changed_at) : null,
    message: DONE[req.query.done] || null,
    error,
    limits: maintenance.LIMITS,
  });
}

async function postMessage(req, res, { kind, viewer, base, role, allowInternal = false }) {
  const found = await maintenance.requestForViewer(db.pool, viewer, parseId(req.params.id));
  if (!found) return notFound(res);
  const checked = maintenance.validateMessage(req.body.body);
  if (checked.error) return renderDetail(req, res, { kind, found, base, status: 422, error: checked.error });
  await maintenance.addMessage(db.pool, found.officeId, {
    request: found.request,
    userId: req.user.id,
    role,
    visibility: allowInternal ? req.body.visibility : 'public',
    body: checked.value,
    ip: req.ip,
  });
  return res.redirect(`${base}?done=message#thread`);
}

// ------------------------------------------------------------ office

const office = express.Router();

office.get('/office/maintenance', requirePerm('maintenance'), wrap(async (req, res) => {
  const filters = maintenance.parseFilters(req.query);
  const result = await maintenance.listForOffice(db.pool, req.office.id, { filters, userId: req.user.id, page: req.query.page });
  const url = (page) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    if (page > 1) params.set('page', String(page));
    const text = params.toString();
    return `/office/maintenance${text ? `?${text}` : ''}`;
  };
  return res.render('maintenance/list', {
    title: 'الصيانة',
    kind: 'office',
    ...result,
    filters,
    filtered: Boolean(filters.status || filters.category || filters.assignee),
    detailBase: '/office/maintenance',
    labels: LABELS,
    prevUrl: result.page > 1 ? url(result.page - 1) : null,
    nextUrl: result.page < result.pages ? url(result.page + 1) : null,
    form: null,
  });
}));

async function loadOfficeRequest(req, res) {
  const found = await maintenance.requestForViewer(db.pool, { kind: 'office', officeId: req.office.id }, parseId(req.params.id));
  return found || null;
}

office.get('/office/maintenance/:id', requirePerm('maintenance'), wrap(async (req, res) => {
  const found = await loadOfficeRequest(req, res);
  if (!found) return notFound(res);
  return renderDetail(req, res, { kind: 'office', found, base: `/office/maintenance/${found.request.id}` });
}));

office.post('/office/maintenance/:id/status', requirePerm('maintenance'), wrap(async (req, res) => {
  const found = await loadOfficeRequest(req, res);
  if (!found) return notFound(res);
  const result = await maintenance.changeStatus(db.pool, req.office.id, { requestId: found.request.id, to: String(req.body.status || ''), actorId: req.user.id, ip: req.ip });
  const base = `/office/maintenance/${found.request.id}`;
  if (!result.ok) return renderDetail(req, res, { kind: 'office', found, base, status: 422, error: 'لا يمكن نقل الطلب إلى هذه الحالة.' });
  return res.redirect(`${base}?done=status`);
}));

office.post('/office/maintenance/:id/assign', requirePerm('maintenance'), wrap(async (req, res) => {
  const found = await loadOfficeRequest(req, res);
  if (!found) return notFound(res);
  const raw = String(req.body.assignee || '');
  const assigneeId = raw === '' ? null : parseId(raw);
  const base = `/office/maintenance/${found.request.id}`;
  if (raw !== '' && !assigneeId) return renderDetail(req, res, { kind: 'office', found, base, status: 422, error: 'اختر عضواً من الفريق.' });
  const result = await maintenance.assign(db.pool, req.office.id, { requestId: found.request.id, assigneeId, actorId: req.user.id, ip: req.ip });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return renderDetail(req, res, { kind: 'office', found, base, status: 422, error: 'اختر عضواً فعّالاً من الفريق.' });
  return res.redirect(`${base}?done=assigned`);
}));

office.post('/office/maintenance/:id/messages', requirePerm('maintenance'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  return postMessage(req, res, {
    kind: 'office', viewer: { kind: 'office', officeId: req.office.id }, base: `/office/maintenance/${id}`, role: 'office', allowInternal: true,
  });
}));

// ------------------------------------------------------------ landlord and tenant

const portalRouter = express.Router();
// noStore and the same-origin check for /landlord and /tenant already run in routes/portal.js.

const landlordArea = [requireAuth, loadArea('landlord')];
const tenantArea = [requireAuth, loadArea('tenant')];

portalRouter.get('/landlord/maintenance', landlordArea, requirePerm('own.maintenance'), wrap(async (req, res) => {
  const rows = await maintenance.listForLandlord(db.pool, req.links);
  return res.render('maintenance/list', { title: 'الصيانة', kind: 'landlord', rows, total: rows.length, detailBase: '/landlord/maintenance', labels: LABELS, form: null, filters: {}, filtered: false, pages: 1, page: 1, prevUrl: null, nextUrl: null });
}));

portalRouter.get('/landlord/maintenance/:id', landlordArea, requirePerm('own.maintenance'), wrap(async (req, res) => {
  const found = await maintenance.requestForViewer(db.pool, { kind: 'landlord', links: req.links }, parseId(req.params.id));
  if (!found) return notFound(res);
  return renderDetail(req, res, { kind: 'landlord', found, base: `/landlord/maintenance/${found.request.id}` });
}));

portalRouter.post('/landlord/maintenance/:id/messages', landlordArea, requirePerm('own.maintenance'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  return postMessage(req, res, { kind: 'landlord', viewer: { kind: 'landlord', links: req.links }, base: `/landlord/maintenance/${id}`, role: 'landlord' });
}));

async function tenantForm(req, { values = {}, errors = {} } = {}) {
  const live = req.links.filter((l) => l.contract_id);
  return { contracts: live, values: { category: '', priority: 'normal', description: '', contract: '', ...values }, errors, maxFiles: images.MAX_FILES, maxMb: images.MAX_BYTES / (1024 * 1024) };
}

async function renderTenantList(req, res, { status = 200, values, errors } = {}) {
  const rows = await maintenance.listForTenant(db.pool, req.links);
  return res.status(status).render('maintenance/list', {
    title: 'الصيانة', kind: 'tenant', rows, total: rows.length, detailBase: '/tenant/maintenance', labels: LABELS,
    filters: {}, filtered: false, pages: 1, page: 1, prevUrl: null, nextUrl: null,
    form: await tenantForm(req, { values, errors }),
    message: DONE[req.query.done] || null,
  });
}

portalRouter.get('/tenant/maintenance', tenantArea, requirePerm('own.maintenance'), wrap((req, res) => renderTenantList(req, res)));

portalRouter.get('/tenant/maintenance/:id', tenantArea, requirePerm('own.maintenance'), wrap(async (req, res) => {
  const found = await maintenance.requestForViewer(db.pool, { kind: 'tenant', links: req.links }, parseId(req.params.id));
  if (!found) return notFound(res);
  return renderDetail(req, res, { kind: 'tenant', found, base: `/tenant/maintenance/${found.request.id}` });
}));

portalRouter.post('/tenant/maintenance/:id/messages', tenantArea, requirePerm('own.maintenance'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  return postMessage(req, res, { kind: 'tenant', viewer: { kind: 'tenant', links: req.links }, base: `/tenant/maintenance/${id}`, role: 'tenant' });
}));

const createLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFor: (req) => `maintenance-new:${req.user.id}`,
  onLimit: (req, res) => renderTenantList(req, res, { status: 429, errors: { form: 'أرسلت طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' } }),
});

portalRouter.post('/tenant/contracts/:id/maintenance', tenantArea, requirePerm('own.maintenance'), createLimit, upload, wrap(async (req, res) => {
  const view = await portal.tenantContract(db.pool, req.links, parseId(req.params.id), today(), req.user.id);
  if (!view || ['terminated', 'renewed'].includes(view.contract.status) || !view.contract.unit_id) return notFound(res);
  const { values, errors } = maintenance.validateRequest(req.body);
  const files = req.files && req.files.photos;
  const prepared = Object.keys(errors).length ? { ok: true, images: [] } : await maintenance.prepareImages(files);
  if (!prepared.ok) errors.photos = maintenance.IMAGE_ERRORS[prepared.error] || maintenance.IMAGE_ERRORS.corrupt;
  if (Object.keys(errors).length) {
    return renderTenantList(req, res, { status: 422, values: { ...values, contract: String(view.contract.id) }, errors });
  }
  const result = await maintenance.createRequest(db.pool, view.link.office_id, {
    contract: view.contract, userId: req.user.id, values, photos: prepared.images, officeName: view.link.office_name, ip: req.ip,
  });
  if (!result.ok) {
    return renderTenantList(req, res, { status: 409, values: { ...values, contract: String(view.contract.id) }, errors: { photos: result.message } });
  }
  return res.redirect(`/tenant/maintenance/${result.id}?done=created`);
}));

// ------------------------------------------------------------ photos

const photos = express.Router();
photos.use('/maintenance/photos', noStore);

// Any refusal answers 404 (never says whether the photo exists).
photos.get('/maintenance/photos/:id', requireAuth, wrap(async (req, res) => {
  const [memberships, landlord, tenant] = await Promise.all([membershipsFor(db.pool, req.user.id), landlordLinks(db.pool, req.user.id), tenantLinks(db.pool, req.user.id)]);
  const member = memberships.find((m) => m.is_active);
  const name = await maintenance.photoForUser(db.pool, req.user, parseId(req.params.id), {
    membership: member ? { officeId: Number(member.office_id) } : null,
    landlordLinks: landlord,
    tenantLinks: tenant,
  });
  const file = name ? images.imagePath(name) : null;
  if (!file) return notFound(res);
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  return res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) notFound(res);
  });
}));

module.exports = { office, portal: portalRouter, photos };
