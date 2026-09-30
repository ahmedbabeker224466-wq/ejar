'use strict';

/** Auth and account pages must never be cached, by browsers or proxies. */
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

/**
 * Rejects state-changing requests sent from another site. Works alongside the
 * SameSite=Lax session cookie.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next(); // some privacy tools strip both; SameSite still applies
  try {
    if (new URL(source).host === req.get('host')) return next();
  } catch {
    // fall through to reject
  }
  return res.status(403).render('errors/403', { title: 'غير متاح' });
}

module.exports = { noStore, sameOrigin };
