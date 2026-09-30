'use strict';

// Small in-memory limit for form posts (the OTP limits live in the database).
// Per process: under Passenger each worker counts on its own, which is fine
// for slowing down repeated submits.

/**
 * Allows `max` requests per `windowMs` for each key. keyFor(req) picks the
 * key; requests over the limit get the Arabic 429 page from render(req, res).
 */
function rateLimit({ windowMs, max, keyFor, onLimit }) {
  const hits = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = keyFor(req);
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      res.set('Retry-After', String(Math.ceil((windowMs - (now - recent[0])) / 1000)));
      return onLimit(req, res);
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) {
      for (const [k, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    return next();
  };
}

module.exports = { rateLimit };
