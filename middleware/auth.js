'use strict';

const auth = require('../services/auth');
const logger = require('../utils/logger');

/**
 * Reads the session cookie and sets req.user (or null) on every request.
 * An invalid, revoked or outdated token is treated as signed out and cleared.
 */
function loadUser(authService = auth) {
  return async function loadUserMiddleware(req, res, next) {
    req.user = null;
    req.sessionCookie = null;
    const cookies = req.cookies || {};
    // /login?add=1 and /join?add=1 sign in a second account (a landlord or a
    // tenant next to an office) without leaving the one already signed in.
    if ((req.path === '/login' || req.path === '/join') && req.query && req.query.add === '1') {
      res.locals.currentUser = null;
      res.locals.addAccount = true;
      return next();
    }
    // /admin runs on the admin cookie first; everything else on the normal one.
    // Without an admin cookie /admin falls back to the normal one, so a platform
    // account signed in before the split stays in, and anyone else is refused
    // by the admin guard (a GET goes to /admin/login).
    // Each area reads its own cookie first (office: aqdi_session, landlord and
    // tenant their own). Shared pages use the area of the page that linked
    // here, else the area this browser used last.
    const area = auth.areaOfPath(req.path);
    let hint = null;
    if (!area) {
      try {
        const ref = req.get('referer');
        if (ref) {
          const u = new URL(ref);
          if (u.host === req.get('host')) hint = auth.areaOfPath(u.pathname);
        }
      } catch { /* a bad referer is ignored */ }
      if (!hint && ['office', 'landlord', 'tenant'].includes(cookies[auth.AREA_HINT_COOKIE])) hint = cookies[auth.AREA_HINT_COOKIE];
    } else if (req.method === 'GET' && cookies[auth.AREA_HINT_COOKIE] !== area) {
      res.cookie(auth.AREA_HINT_COOKIE, area, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
    }
    const candidates = auth.cookieCandidates(req.path, hint);
    for (const cookie of candidates) {
      const token = cookies[cookie.name];
      if (!token) continue;
      let user = null;
      try {
        user = await authService.userFromToken(token);
      } catch (err) {
        logger.error(`Session check failed: ${err.code || err.message}`);
        continue;
      }
      if (!user) {
        res.clearCookie(cookie.name, { path: cookie.path });
        continue;
      }
      req.user = user;
      req.sessionCookie = cookie;
      break;
    }
    res.locals.currentUser = req.user;
    next();
  };
}

/** Unread notifications for the header bell (signed-in pages only). */
function loadUnreadCount(countFor = (userId) => require('../services/notifications').unreadCount(require('../config/db').pool, userId)) {
  return async function loadUnreadCountMiddleware(req, res, next) {
    res.locals.unreadCount = 0;
    if (req.user && req.method === 'GET') {
      try {
        res.locals.unreadCount = await countFor(req.user.id);
      } catch (err) {
        logger.error(`Unread count failed: ${err.code || err.message}`);
      }
    }
    next();
  };
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || (req.xhr || (req.get('accept') || '').includes('application/json'));
}

/** Signed-in users only: 401 for API requests, redirect to /login otherwise. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
  return res.redirect('/login');
}

module.exports = { loadUser, loadUnreadCount, requireAuth, wantsJson };
