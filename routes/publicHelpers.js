'use strict';

// Shared by the public routers (listings, marketing site, blog).

const seo = require('../services/seo');
const { rateLimit } = require('../middleware/rateLimit');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Sets what every public page needs: it may be indexed, its canonical URL
 * (the path, plus ?page=N after page 1), description and a short public cache
 * (60 s) so busy pages do not hit the database on every visit.
 */
function publicPage(req, res, { description, page = 1, ogImage = null, ogType = null, jsonLd = null, path = null, cache = true } = {}) {
  const base = seo.baseUrl(req);
  const canonicalPath = `${path || req.path}${page > 1 ? `?page=${page}` : ''}`;
  res.locals.indexable = true;
  res.locals.canonicalUrl = seo.absolute(base, canonicalPath);
  if (description) res.locals.metaDescription = description;
  if (ogImage) res.locals.ogImage = ogImage;
  if (ogType) res.locals.ogType = ogType;
  if (jsonLd) res.locals.jsonLd = seo.safeJson(jsonLd);
  if (cache) res.set('Cache-Control', 'public, max-age=60');
  return base;
}

/** A public page that must not be indexed or cached (errors, confirmations, forms after a POST). */
function privatePage(res) {
  res.locals.indexable = false;
  res.set('Cache-Control', 'no-store');
}

function tooMany(req, res) {
  privatePage(res);
  return res.status(429).render('errors/403', {
    title: 'محاولات كثيرة', heading: 'محاولات كثيرة', message: 'أرسلت طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.',
  });
}

/** An hourly in-memory limit per key (IP, listing). */
function hourly(name, max, keyFor) {
  return rateLimit({ windowMs: 60 * 60 * 1000, max, keyFor: (req) => `${name}:${keyFor(req)}`, onLimit: tooMany });
}

function notFound(res) {
  privatePage(res);
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

function gone(res) {
  privatePage(res);
  return res.status(410).render('site/gone', { title: 'الإعلان لم يعد متاحاً' });
}

module.exports = { wrap, publicPage, privatePage, tooMany, hourly, notFound, gone };
