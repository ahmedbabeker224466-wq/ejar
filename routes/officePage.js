'use strict';

// The office's public page /<slug>. Mounted LAST in app.js, after every other
// router and before the 404 handler, so it can never shadow a real route; the
// slug rules also reserve every mounted top-level path (services/officeLink.js).
// An unknown slug, a page that is switched off or an office whose
// subscription is not live falls through to the normal 404, so nobody learns
// that the office exists. An old slug answers 301 to the current one.
// Shown: office name, city, the owner's short description and the office's
// public listings; visitors reach the office only through each listing's
// inquiry form.

const express = require('express');
const db = require('../config/db');
const officeLink = require('../services/officeLink');
const listings = require('../services/listings');
const customHosts = require('../services/customHosts');
const money = require('../services/money');
const { rateLimit } = require('../middleware/rateLimit');
const logger = require('../utils/logger');
const { wrap, publicPage, tooMany } = require('./publicHelpers');

const router = express.Router();

// Every lookup of a slug-shaped path touches the database: 120 per IP per minute.
const lookupLimit = rateLimit({ windowMs: 60 * 1000, max: 120, keyFor: (req) => `office-page:${req.ip}`, onLimit: tooMany });

router.get('/:slug', (req, res, next) => {
  const slug = String(req.params.slug || '');
  if (slug.length < officeLink.MIN_LENGTH || slug.length > officeLink.MAX_LENGTH || !/^[A-Za-z0-9-]+$/.test(slug)) return next();
  return lookupLimit(req, res, next);
}, wrap(async (req, res, next) => {
  let found;
  try {
    found = await officeLink.resolvePublic(db.pool, req.params.slug);
  } catch (err) {
    // A lookup that fails must not turn every unknown address into an error page.
    logger.error(`Office page lookup failed: ${err.code || err.name}`);
    return next();
  }
  if (found.state === 'none') return next();
  if (found.state === 'redirect') {
    const page = Number(req.query.page);
    return res.redirect(301, `/${found.slug}${Number.isInteger(page) && page > 1 ? `?page=${page}` : ''}`);
  }
  return renderOffice(req, res, found.office);
}));

/**
 * The public page of one office. On its own domain (req.customOffice) the page
 * lives at "/"; on the main host at /<slug>, with rel=canonical pointing at the
 * office's live custom domain when it has one.
 */
async function renderOffice(req, res, office) {
  const result = await listings.publicForOffice(db.pool, office.id, { page: req.query.page });
  const onOwnDomain = Boolean(req.customOffice);
  publicPage(req, res, {
    description: `${office.name} في ${office.city}: إعلانات عقارات للإيجار.`,
    page: result.page,
    path: onOwnDomain ? '/' : `/${office.slug}`,
  });
  if (!onOwnDomain) {
    const live = await customHosts.liveDomainOf(db.pool, office.id);
    if (live) res.locals.canonicalUrl = `https://${live}/${result.page > 1 ? `?page=${result.page}` : ''}`;
  }
  // A page without a published listing is not worth indexing.
  if (result.total === 0) res.locals.indexable = false;
  return res.render('site/office', {
    title: office.name,
    office,
    pageBase: onOwnDomain ? '/' : `/${office.slug}`,
    ...result,
    fmt: money.formatHalalas,
  });
}

module.exports = router;
module.exports.renderOffice = renderOffice;
