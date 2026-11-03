'use strict';

// Host resolution (Prompt 24). Mounted FIRST in app.js, before cookies,
// sessions and the same-origin check. Uses the raw Host header only.
//
// - A main host (APP_URL, localhost, 127.0.0.1, ::1, ALLOWED_HOSTS): nothing
//   changes, the request continues as before.
// - /health and /healthz answer on every host.
// - Any other host: the office whose live custom domain it is (services/
//   customHosts.js, one cached query). Found: req.customOffice is set and the
//   response carries X-Aqdi-Office-Host: <slug>; "www.<domain>" answers 301 to
//   the bare domain. Not found: a plain 404 that says nothing about offices.
// Database lookups (cache misses) are limited per IP, so random Host headers
// cannot hammer the database.

const customHosts = require('../services/customHosts');
const { createCounter } = require('./rateLimit');
const logger = require('../utils/logger');

const HEALTH_PATHS = new Set(['/health', '/healthz']);
const LOOKUPS_PER_MINUTE = 60;

const NOT_FOUND_HTML = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>الصفحة غير موجودة</title></head>'
  + '<body style="font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem"><h1>الصفحة غير موجودة</h1><p>تأكد من العنوان.</p></body></html>';

function plain404(res) {
  res.status(404).set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }).send(NOT_FOUND_HTML);
}

function hostResolver({ pool = null, env = process.env } = {}) {
  const misses = createCounter({ windowMs: 60 * 1000, max: LOOKUPS_PER_MINUTE });
  const getPool = () => pool || require('../config/db').pool;

  const middleware = async function resolveHost(req, res, next) {
    req.customOffice = null;
    req.isCustomHost = false;
    const host = customHosts.normalizeHost(req.headers.host);
    if (!req.headers.host) return next(); // HTTP/1.0 without Host: behaves as before
    if (!host) return plain404(res);
    if (customHosts.classify(host, env) === 'main') return next();
    req.isCustomHost = true;
    if (HEALTH_PATHS.has(req.path)) return next();

    const bare = host.startsWith('www.') ? host.slice(4) : host;
    let office;
    const hit = customHosts.cached(bare);
    if (hit.hit) {
      office = hit.office;
    } else {
      const key = `host-lookup:${req.ip}`;
      const wait = misses.retryAfter(key);
      if (wait > 0) {
        res.set('Retry-After', String(wait));
        return res.status(429).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('طلبات كثيرة. حاول بعد قليل.');
      }
      misses.hit(key);
      try {
        office = await customHosts.lookup(getPool(), bare);
      } catch (err) {
        logger.error(`Custom host lookup failed: ${err.code || err.name}`);
        return res.status(503).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('الخدمة غير متاحة الآن. حاول بعد قليل.');
      }
    }
    if (!office) return plain404(res);
    if (bare !== host) return res.redirect(301, `https://${bare}${req.originalUrl}`);
    req.customOffice = office;
    res.set('X-Aqdi-Office-Host', office.slug);
    return next();
  };
  middleware.misses = misses;
  return middleware;
}

module.exports = { hostResolver, HEALTH_PATHS, NOT_FOUND_HTML };
