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
    // /admin runs on the admin cookie first; everything else on the normal one.
    // Without an admin cookie /admin falls back to the normal one, so a platform
    // account signed in before the split stays in, and anyone else is refused
    // by the admin guard (a GET goes to /admin/login).
    const admin = auth.isAdminPath(req.path);
    const candidates = admin
      ? [{ name: auth.ADMIN_COOKIE, path: auth.ADMIN_COOKIE_PATH }, { name: auth.SESSION_COOKIE, path: '/' }]
      : [{ name: auth.SESSION_COOKIE, path: '/' }];
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
