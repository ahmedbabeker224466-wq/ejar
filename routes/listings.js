'use strict';

// The office side of public listings (/office/listings, capability 'listings':
// owner and manager; the plan must include the 'listings' feature). Mounted in
// routes/office.js after loadOffice, so the office always comes from the
// signed-in member. A listing or photo id from another office answers 404.

const express = require('express');
const fileUpload = require('express-fileupload');
const db = require('../config/db');
const rules = require('../config/listings');
const listings = require('../services/listings');
const listingPhotos = require('../services/listingPhotos');
const inquiries = require('../services/inquiries');
const images = require('../services/images');
const money = require('../services/money');
const { SAUDI_CITIES } = require('../config/saudiCities');
const { BY_CITY, OTHER } = require('../config/neighborhoods');
const { requirePerm } = require('../middleware/permissions');
const { requireFeature } = require('../services/features');
const { rateLimit } = require('../middleware/rateLimit');
const { parseId } = require('../services/landlords');
const { riyadhNow } = require('../utils/time');

const router = express.Router();
const guard = [requirePerm('listings'), requireFeature('listings')];

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const NOTICES = {
  created: ['success', 'تم إنشاء المسودة. أكمل البيانات وأضف الصور ثم انشرها.'],
  saved: ['success', 'تم حفظ الإعلان.'],
  published: ['success', 'تم نشر الإعلان.'],
  hidden: ['info', 'تم إخفاء الإعلان.'],
  renewed: ['success', 'تم تجديد الإعلان.'],
  photos: ['success', 'تمت إضافة الصور.'],
  photo: ['success', 'تم تحديث الصور.'],
  status: ['success', 'تم تحديث حالة الاستفسار.'],
};

const stamp = (at) => (at ? riyadhNow(new Date(at)).slice(0, 10) : '—');
const priceInput = (halalas) => (halalas % 100 === 0 ? String(halalas / 100) : money.toDecimal(halalas));

function formValues(listing) {
  return {
    unit_type: listing.unitType,
    city: listing.city,
    neighborhood: listing.neighborhood,
    rooms: listing.rooms === null ? '' : String(listing.rooms),
    bathrooms: listing.bathrooms === null ? '' : String(listing.bathrooms),
    area_sqm: listing.area === null ? '' : String(listing.area),
    price: listing.price > 0 ? priceInput(listing.price) : '',
    description: listing.description,
    features: listing.features,
  };
}

async function renderEdit(req, res, listing, { values = null, errors = {}, status = 200, error = null } = {}) {
  const photos = await listingPhotos.photosFor(db.pool, req.office.id, listing.unitId);
  const notice = Object.hasOwn(NOTICES, req.query.done) ? NOTICES[req.query.done] : null;
  return res.status(status).render('listings/edit', {
    title: 'الإعلان',
    listing,
    values: values || formValues(listing),
    errors,
    error,
    notice,
    photos,
    inquiries: listing.status === 'rented' ? [] : await inquiries.inquiriesFor(db.pool, req.office.id, listing.id),
    inquiryStatuses: inquiries.INQUIRY_STATUSES,
    cities: SAUDI_CITIES,
    byCity: BY_CITY,
    other: OTHER,
    types: listings.TYPE_LABELS,
    featureLabels: listings.FEATURES,
    statusLabels: listings.STATUS_LABELS,
    maxPhotos: rules.MAX_PHOTOS,
    days: rules.LISTING_DAYS,
    stamp,
    fmt: money.formatHalalas,
    publicPath: `/listings/${listing.id}`,
  });
}

async function loadListing(req, res) {
  const id = parseId(req.params.id);
  const listing = id ? await listings.getForOffice(db.pool, req.office.id, id) : null;
  if (!listing) notFound(res);
  return listing;
}

// ------------------------------------------------------------ list and create

router.get('/office/listings', guard, wrap(async (req, res) => {
  const status = String(req.query.status || '');
  return res.render('listings/index', {
    title: 'الإعلانات',
    rows: await listings.listForOffice(db.pool, req.office.id, { status }),
    status,
    statusLabels: listings.STATUS_LABELS,
    types: listings.TYPE_LABELS,
    stamp,
    fmt: money.formatHalalas,
  });
}));

async function renderNew(req, res, { error = null, status = 200, unitId = '' } = {}) {
  return res.status(status).render('listings/new', {
    title: 'إعلان جديد',
    units: await listings.unitsWithoutListing(db.pool, req.office.id),
    types: listings.TYPE_LABELS,
    error,
    unitId: String(unitId),
  });
}

router.get('/office/listings/new', guard, wrap((req, res) => renderNew(req, res, { unitId: req.query.unit || '' })));

router.post('/office/listings', guard, wrap(async (req, res) => {
  const unitId = parseId(req.body.unit_id);
  if (!unitId) return renderNew(req, res, { error: 'اختر الوحدة.', status: 422 });
  const result = await listings.createFromUnit(db.pool, { officeId: req.office.id, unitId, actorId: req.user.id, ip: req.ip });
  if (!result.ok) return renderNew(req, res, { error: result.message, status: 422, unitId });
  return res.redirect(`/office/listings/${result.id}?done=created`);
}));

// ------------------------------------------------------------ one listing

router.get('/office/listings/:id', guard, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  if (listing) await renderEdit(req, res, listing);
}));

router.post('/office/listings/:id', guard, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  if (!listing) return null;
  if (listing.status === 'rented') return renderEdit(req, res, listing, { error: 'الوحدة مؤجرة ولا يمكن تعديل الإعلان الآن.', status: 409 });
  const { values, errors } = listings.validateListing(req.body);
  if (Object.keys(errors).length) {
    return renderEdit(req, res, listing, { values: { ...formValues(listing), ...req.body, features: [].concat(req.body.features || []) }, errors, status: 422 });
  }
  await listings.update(db.pool, { officeId: req.office.id, id: listing.id, values, actorId: req.user.id, ip: req.ip });
  return res.redirect(`/office/listings/${listing.id}?done=saved`);
}));

function action(name, handler, done) {
  router.post(`/office/listings/:id/${name}`, guard, wrap(async (req, res) => {
    const listing = await loadListing(req, res);
    if (!listing) return null;
    const result = await handler({ req, listing });
    if (result && result.ok === false && result.message) return renderEdit(req, res, listing, { error: result.message, status: 422 });
    return res.redirect(`/office/listings/${listing.id}?done=${done}`);
  }));
}

const ctx = (req, listing) => ({ officeId: req.office.id, id: listing.id, actorId: req.user.id, ip: req.ip });
action('publish', ({ req, listing }) => listings.publish(db.pool, ctx(req, listing)), 'published');
action('hide', ({ req, listing }) => listings.hide(db.pool, ctx(req, listing)), 'hidden');
action('renew', ({ req, listing }) => listings.renew(db.pool, ctx(req, listing)), 'renewed');

router.post('/office/listings/:id/delete', guard, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  if (!listing) return null;
  const result = await listings.remove(db.pool, ctx(req, listing));
  if (result.ok) await listingPhotos.removeFiles(result.files);
  return res.redirect('/office/listings');
}));

// ------------------------------------------------------------ photos

const upload = fileUpload({
  useTempFiles: false,
  abortOnLimit: false,
  limits: { fileSize: images.MAX_BYTES, files: rules.MAX_PHOTOS + 1, fields: 4, fieldSize: 1024 },
  uploadTimeout: 120 * 1000,
  debug: false,
});

const uploadLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFor: (req) => `listing-photos:${req.office ? req.office.id : req.ip}`,
  onLimit: (req, res) => res.status(429).render('errors/403', { title: 'محاولات كثيرة', heading: 'محاولات كثيرة', message: 'رفعت صوراً كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' }),
});

router.post('/office/listings/:id/photos', guard, uploadLimit, upload, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  if (!listing) return null;
  const sent = req.files && req.files.photos ? [].concat(req.files.photos) : [];
  req.files = null;
  if (sent.length === 0) return renderEdit(req, res, listing, { error: 'اختر صورة واحدة على الأقل.', status: 422 });
  const result = await listingPhotos.addPhotos(db.pool, {
    officeId: req.office.id, listingId: listing.id, files: sent.map((f) => ({ data: f.data, truncated: f.truncated })), actorId: req.user.id, ip: req.ip,
  });
  if (!result.ok) return result.error === 'rented' ? renderEdit(req, res, listing, { error: 'الوحدة مؤجرة.', status: 409 }) : notFound(res);
  const problems = [...new Set(result.errors)].map((code) => listingPhotos.ERROR_MESSAGES[code]).filter(Boolean);
  if (problems.length) return renderEdit(req, res, { ...listing }, { error: `${result.added ? `أُضيفت ${result.added} صور. ` : ''}${problems.join(' ')}`, status: result.added ? 200 : 422 });
  return res.redirect(`/office/listings/${listing.id}?done=photos`);
}));

for (const [name, run] of [
  ['cover', (c) => listingPhotos.setCover(db.pool, c)],
  ['up', (c) => listingPhotos.move(db.pool, { ...c, direction: 'up' })],
  ['down', (c) => listingPhotos.move(db.pool, { ...c, direction: 'down' })],
  ['delete', (c) => listingPhotos.removePhoto(db.pool, { ...c, actorId: c.actorId, ip: c.ip })],
]) {
  router.post(`/office/listings/:id/photos/:photoId/${name}`, guard, wrap(async (req, res) => {
    const listing = await loadListing(req, res);
    const photoId = parseId(req.params.photoId);
    if (!listing || !photoId) return photoId ? null : notFound(res);
    const ok = await run({ officeId: req.office.id, unitId: listing.unitId, photoId, actorId: req.user.id, ip: req.ip });
    if (!ok) return notFound(res);
    return res.redirect(`/office/listings/${listing.id}?done=photo`);
  }));
}

// The office's own preview of a photo (any state of the listing).
router.get('/office/listings/:id/photos/:photoId/:variant', guard, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  if (!listing) return null;
  const photo = await listingPhotos.photoForOffice(db.pool, req.office.id, req.params.photoId, req.params.variant === 'thumb' ? 'thumb' : 'full');
  const file = photo ? images.imagePath(photo.name) : null;
  if (!file) return notFound(res);
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  return res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) notFound(res);
  });
}));

// ------------------------------------------------------------ inquiries

router.post('/office/listings/:id/inquiries/:inquiryId/status', guard, wrap(async (req, res) => {
  const listing = await loadListing(req, res);
  const inquiryId = parseId(req.params.inquiryId);
  if (!listing || !inquiryId) return inquiryId ? null : notFound(res);
  const ok = await inquiries.setInquiryStatus(db.pool, { officeId: req.office.id, listingId: listing.id, inquiryId, status: String(req.body.status || '') });
  if (!ok) return notFound(res);
  return res.redirect(`/office/listings/${listing.id}?done=status#inquiries`);
}));

module.exports = router;
