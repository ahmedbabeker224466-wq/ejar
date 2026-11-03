'use strict';

// What an office's own domain serves (Prompt 24), after middleware/customHost.js
// set req.customOffice. Mounted after static files and before sessions in
// app.js: nothing here reads or sets a session or login cookie.
//
// Allowed on the custom domain:
//   GET  /                              the office's public page (as /<slug>)
//   GET  /listings/:id                  that office's listings only (others 404)
//   POST /listings/:id/inquiry          the inquiry form of those listings
//   GET  /listings/photos/:id/:variant  photos of that office's public listings
//   GET  /robots.txt, /sitemap.xml      scoped to the office, absolute URLs on the domain
// Static files and /health are served before this router. Everything else
// (login, panels, admin, blog, pricing, other offices' pages) answers 302 to
// the same path on the main host.

const express = require('express');
const db = require('../config/db');
const seo = require('../services/seo');
const listings = require('../services/listings');
const customHosts = require('../services/customHosts');
const { scopeToOffice } = require('../services/scopeToOffice');
const publicListings = require('./publicListings');
const { renderOffice } = require('./officePage');
const { wrap } = require('./publicHelpers');

const router = express.Router();

// Only requests that the host resolver attached to an office.
router.use((req, res, next) => (req.customOffice ? next() : next('router')));

router.get('/', wrap((req, res) => renderOffice(req, res, req.customOffice)));

router.get('/robots.txt', (req, res) => {
  const base = seo.baseUrl(req);
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  return res.send(`User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
});

router.get('/sitemap.xml', wrap(async (req, res) => {
  const base = seo.baseUrl(req);
  const now = new Date();
  const rows = await scopeToOffice(db.pool, req.customOffice.id).query(
    `SELECT l.id, l.updated_at FROM listings l JOIN offices o ON o.id = l.office_id
      WHERE l.office_id = :office_id AND ${listings.PUBLIC_WHERE} ORDER BY l.id DESC LIMIT 5000`,
    [now, now],
  );
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  return res.send(seo.sitemapXml(base, [
    { path: '/', changefreq: 'weekly', priority: '1.0' },
    ...rows.map((l) => ({ path: `/listings/${l.id}`, lastmod: l.updated_at, changefreq: 'weekly', priority: '0.7' })),
  ]));
}));

// The office's own listings, photos and inquiry form: the public listing
// routes, which 404 anything outside req.customOffice.
const LISTING_PATHS = [/^\/listings\/[1-9]\d{0,17}$/, /^\/listings\/photos\/[1-9]\d{0,17}\/(full|thumb)$/];
const INQUIRY_PATH = /^\/listings\/[1-9]\d{0,17}\/inquiry$/;
router.use((req, res, next) => {
  const allowed = (['GET', 'HEAD'].includes(req.method) && LISTING_PATHS.some((re) => re.test(req.path)))
    || (req.method === 'POST' && INQUIRY_PATH.test(req.path));
  return allowed ? publicListings(req, res, next) : next();
});

// Everything else lives on the main host.
router.use((req, res) => {
  const main = customHosts.appHost();
  res.set('Cache-Control', 'no-store');
  if (!main) return res.status(404).type('text/plain; charset=utf-8').send('Not found');
  const base = String(process.env.APP_URL).trim().replace(/\/+$/, '');
  return res.redirect(302, `${base}${req.originalUrl}`);
});

module.exports = router;
