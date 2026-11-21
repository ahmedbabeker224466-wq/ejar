'use strict';

// Picks the page language from the URL: /en/<path> is the English copy of a
// localized marketing page (services/i18n.js LOCALIZED_PATHS), everything else
// is Arabic. The language lives in the URL only (no cookie), so public caches
// keep the two copies apart. /en/<any other path> goes back to the Arabic page.

const i18n = require('../services/i18n');

// English pages that also accept a form post (the contact form).
const POSTABLE = Object.freeze(['/contact']);

function locale() {
  return function localeMiddleware(req, res, next) {
    // An office's own domain serves its own Arabic pages only.
    const { lang, path } = req.isCustomHost ? { lang: i18n.DEFAULT_LANG, path: req.path } : i18n.splitPath(req.path);
    if (lang === 'en') {
      if (!i18n.LOCALIZED_PATHS.includes(path) || (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && POSTABLE.includes(path)))) {
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(302, `${path}${query}`);
      }
      // Route the English request through the same handlers as the Arabic page.
      req.url = path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    }
    req.lang = lang;
    const other = lang === 'en' ? 'ar' : 'en';
    res.locals.lang = lang;
    res.locals.dir = lang === 'en' ? 'ltr' : 'rtl';
    res.locals.t = (key, vars) => i18n.translate(lang, key, vars);
    res.locals.L = (p) => i18n.localizedPath(lang, p);
    res.locals.currentPath = path;
    res.locals.localized = !req.isCustomHost && i18n.LOCALIZED_PATHS.includes(path);
    res.locals.altLangHref = i18n.localizedPath(other, path);
    res.locals.hreflang = res.locals.localized ? { ar: path, en: i18n.localizedPath('en', path) } : null;
    next();
  };
}

module.exports = { locale };
