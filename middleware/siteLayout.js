'use strict';

// Public pages (blog, listings, sign-in, an office page, the 404 page) use the
// marketing layout (layouts/site) so the whole public site shares one design.
// Signed-in areas keep their own layouts, and an office's own domain keeps the
// plain layout (no Mi3aad marketing header there).

const PRIVATE_PREFIXES = Object.freeze([
  '/office', '/admin', '/landlord', '/tenant', '/platform', '/join', '/settings',
  '/notifications', '/maintenance', '/messages', '/tasks', '/reports', '/payments',
  '/billing', '/api', '/webhooks', '/cron', '/health', '/logout',
]);

function isPrivatePath(path) {
  return PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function siteLayout() {
  return function siteLayoutMiddleware(req, res, next) {
    if (!req.isCustomHost && !isPrivatePath(req.path)) {
      res.locals.layout = 'layouts/site';
      res.locals.mkStd = true;
    }
    next();
  };
}

module.exports = { siteLayout, isPrivatePath };
