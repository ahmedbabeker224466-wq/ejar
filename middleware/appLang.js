'use strict';

// The language of every page that has no /en copy (sign-in, join, the office,
// landlord, tenant and admin areas, listings, blog). In order: ?lang= in the
// link (then remembered in a cookie and on the user), the signed-in user's
// saved language (users.locale), the cookie, Arabic. Marketing pages keep the
// language of their URL (middleware/locale). Sets req.lang, lang, dir, __ ,
// t and L for the views.

const i18n = require('../services/i18n');
const tr = require('../services/tr');

const COOKIE = 'mi3aad_lang';
const ONE_YEAR = 365 * 24 * 3600 * 1000;

function setLocals(req, res, lang) {
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.dir = lang === 'en' ? 'ltr' : 'rtl';
  res.locals.__ = (text, vars) => tr.translate(lang, text, vars);
  res.locals.t = (key, vars) => i18n.translate(lang, key, vars);
  res.locals.L = (p) => i18n.localizedPath(lang, p);
}

function appLang({ saveLocale = async () => {} } = {}) {
  return async function appLangMiddleware(req, res, next) {
    try {
      if (res.locals.localized) {
        res.locals.__ = (text, vars) => tr.translate(req.lang, text, vars);
        return next();
      }
      const asked = req.query && typeof req.query.lang === 'string' && tr.LANGS.includes(req.query.lang) ? req.query.lang : null;
      const remembered = req.cookies && tr.LANGS.includes(req.cookies[COOKIE]) ? req.cookies[COOKIE] : null;
      const user = req.user || null;
      // The latest choice on this device wins, then the user's saved language.
      let lang = asked || remembered || (user && tr.LANGS.includes(user.locale) ? user.locale : null) || 'ar';
      if (asked && asked !== remembered) res.cookie(COOKIE, asked, { maxAge: ONE_YEAR, httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
      // Messages (email, WhatsApp, reminders) follow the user's saved language.
      if (user && (asked || remembered) && user.locale !== lang) {
        await saveLocale(user.id, lang);
        user.locale = lang;
      }
      lang = tr.langOf(lang);
      setLocals(req, res, lang);
      // The other language of this same page (the header switch).
      const q = new URLSearchParams(req.query || {});
      q.set('lang', lang === 'en' ? 'ar' : 'en');
      res.locals.altLangHref = `${req.path}?${q.toString()}`;
      res.locals.langSwitch = true;
      // A page in a remembered language must not be shared by a public cache.
      if (lang === 'en') res.set('Vary', 'Cookie');
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { appLang, COOKIE, setLocals };
