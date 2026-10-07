'use strict';

// The public listings: search, one listing with its photos, the inquiry form
// and the abuse report. No login. Nothing here shows an address, a unit label,
// a name, a phone number or a contract: see services/listings.js. Visitors
// reach the office only through the inquiry form (honeypot, 5 per hour per IP,
// 10 per hour per listing).

const express = require('express');
const db = require('../config/db');
const rules = require('../config/listings');
const listings = require('../services/listings');
const listingPhotos = require('../services/listingPhotos');
const inquiries = require('../services/inquiries');
const images = require('../services/images');
const seo = require('../services/seo');
const money = require('../services/money');
const { SAUDI_CITIES } = require('../config/saudiCities');
const { BY_CITY, OTHER } = require('../config/neighborhoods');
const { wrap, publicPage, privatePage, hourly, notFound, gone } = require('./publicHelpers');

const router = express.Router();

const inquiryIp = hourly('inquiry-ip', rules.INQUIRY_PER_IP_PER_HOUR, (req) => req.ip);
const inquiryListing = hourly('inquiry-listing', rules.INQUIRY_PER_LISTING_PER_HOUR, (req) => req.params.id);
const reportIp = hourly('report-ip', rules.REPORT_PER_IP_PER_HOUR, (req) => req.ip);

const common = { types: listings.TYPE_LABELS, featureLabels: listings.FEATURES, fmt: money.formatHalalas, reasons: inquiries.REPORT_REASONS };

// ------------------------------------------------------------ search

router.get('/listings', wrap(async (req, res) => {
  const filters = listings.parseFilters(req.query);
  const result = await listings.searchPublic(db.pool, filters);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({
    city: filters.city, neighborhood: filters.neighborhood, type: filters.type, min_price: req.query.min_price && filters.minPrice ? req.query.min_price : '',
    max_price: req.query.max_price && filters.maxPrice ? req.query.max_price : '', rooms: filters.rooms ? `${filters.rooms.min}${filters.rooms.exact ? '' : '+'}` : '',
    sort: filters.sort === 'newest' ? '' : filters.sort,
  })) if (value) query.set(key, String(value));
  publicPage(req, res, {
    description: 'تصفح إعلانات العقارات للإيجار: شقق وفلل ومحلات ومكاتب في مدن المملكة، مع الصور والمواصفات والإيجار السنوي.',
    page: result.page,
    cache: !query.toString(),
  });
  if (query.toString()) res.locals.indexable = false; // filtered result lists are not indexed; the base list is
  return res.render('site/listings', {
    ...common,
    title: 'إعلانات العقارات للإيجار',
    ...result,
    filters,
    qs: query.toString(),
    cities: SAUDI_CITIES,
    byCity: BY_CITY,
    other: OTHER,
    rawFilters: { min_price: req.query.min_price || '', max_price: req.query.max_price || '', rooms: req.query.rooms || '' },
  });
}));

// ------------------------------------------------------------ photos (published listings only)

router.get('/listings/photos/:id/:variant', wrap(async (req, res) => {
  const photo = await listingPhotos.photoForPublic(db.pool, req.params.id, req.params.variant === 'thumb' ? 'thumb' : 'full');
  const file = photo ? images.imagePath(photo.name) : null;
  if (!file) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  // ETag and Last-Modified come from the file; the browser and CDN may keep it for a day.
  return res.sendFile(file, { dotfiles: 'allow', etag: true, lastModified: true, cacheControl: false, headers: { 'Cache-Control': 'public, max-age=86400' } }, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('Not found');
  });
}));

// ------------------------------------------------------------ one listing

async function renderListing(req, res, found, { values = {}, errors = {}, status = 200, sent = false } = {}) {
  const { listing } = found;
  const [rows] = await db.pool.query(
    'SELECT id FROM unit_photos WHERE unit_id = ? ORDER BY is_cover DESC, sort_order ASC, id ASC LIMIT ?',
    [listing.unitId, rules.MAX_PHOTOS],
  );
  const photos = rows.map((r) => Number(r.id));
  const base = seo.baseUrl(req);
  const imageUrl = photos.length ? seo.absolute(base, `/listings/photos/${photos[0]}/full`) : null;
  publicPage(req, res, {
    description: `${listing.title}. الإيجار السنوي ${money.formatHalalas(listing.price)} ريال${listing.rooms !== null ? `، ${listing.rooms} غرف` : ''}${listing.area !== null ? `، ${listing.area} م²` : ''}.`,
    ogImage: imageUrl,
    ogType: 'article',
    path: `/listings/${listing.id}`,
    jsonLd: seo.listingJsonLd({ listing, base, imageUrl }),
    cache: !sent && status === 200 && !Object.keys(errors).length,
  });
  return res.status(status).render('site/listing', {
    ...common,
    title: listing.title,
    listing,
    photos,
    values,
    errors,
    sent,
    expiresDay: listing.expiresAt ? new Date(listing.expiresAt).toISOString().slice(0, 10) : null,
  });
}

async function find(req, res) {
  const found = await listings.getPublic(db.pool, req.params.id);
  if (found.state === 'none') {
    notFound(res);
    return null;
  }
  if (found.state === 'gone') {
    gone(res);
    return null;
  }
  return found;
}

router.get('/listings/:id', wrap(async (req, res) => {
  const found = await find(req, res);
  if (found) await renderListing(req, res, found, { sent: req.query.sent === '1' });
}));

router.post('/listings/:id/inquiry', inquiryIp, inquiryListing, wrap(async (req, res) => {
  const found = await find(req, res);
  if (!found) return null;
  const { values, errors, bot } = inquiries.validateInquiry(req.body);
  // A filled honeypot gets the normal thank-you page and nothing is stored.
  if (bot) return res.redirect(`/listings/${found.listing.id}?sent=1#inquiry`);
  if (Object.keys(errors).length) {
    privatePage(res);
    return renderListing(req, res, found, { values: { name: values.name, phone: String(req.body.phone || '').slice(0, 30), email: String(req.body.email || '').slice(0, 190), message: values.message }, errors, status: 422 });
  }
  await inquiries.createInquiry(db.pool, { listing: found.listing, values });
  return res.redirect(`/listings/${found.listing.id}?sent=1#inquiry`);
}));

// ------------------------------------------------------------ report a listing

router.get('/listings/:id/report', wrap(async (req, res) => {
  const found = await find(req, res);
  if (!found) return null;
  privatePage(res);
  return res.render('site/report', { ...common, title: 'الإبلاغ عن إعلان', listing: found.listing, values: {}, errors: {}, done: req.query.done === '1' });
}));

router.post('/listings/:id/report', reportIp, wrap(async (req, res) => {
  const found = await find(req, res);
  if (!found) return null;
  privatePage(res);
  if (String(req.body.website ?? '').trim() !== '') return res.redirect(`/listings/${found.listing.id}/report?done=1`);
  const reason = String(req.body.reason || '');
  if (!Object.hasOwn(inquiries.REPORT_REASONS, reason)) {
    return res.status(422).render('site/report', { ...common, title: 'الإبلاغ عن إعلان', listing: found.listing, values: req.body, errors: { reason: 'اختر سبب البلاغ.' }, done: false });
  }
  await inquiries.createReport(db.pool, { listingId: found.listing.id, reason, note: req.body.note });
  return res.redirect(`/listings/${found.listing.id}/report?done=1`);
}));

module.exports = router;
module.exports.limiters = { inquiryIp, inquiryListing, reportIp };
