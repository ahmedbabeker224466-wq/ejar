'use strict';

// Small in-memory limits (the OTP limits live in the database). Per process:
// under Passenger each worker counts on its own, which is fine for slowing
// down repeated submits and guessing.

/**
 * Counts events per key inside a sliding window. retryAfter(key) is 0 while
 * fewer than `max` events happened in the last `windowMs`, otherwise the
 * seconds until the oldest one leaves the window. hit(key) records one event.
 */
function createCounter({ windowMs, max }) {
  const hits = new Map();

  function recent(key, now) {
    const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (times.length) hits.set(key, times);
    else hits.delete(key);
    return times;
  }

  return {
    retryAfter(key, now = Date.now()) {
      const times = recent(key, now);
      if (times.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - times[0])) / 1000));
    },
    hit(key, now = Date.now()) {
      const times = recent(key, now);
      times.push(now);
      hits.set(key, times);
      if (hits.size > 10000) {
        for (const [k, list] of hits) if (list.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * Middleware: allows `max` requests per `windowMs` for each key. keyFor(req)
 * picks the key; requests over the limit are answered by onLimit(req, res).
 */
function rateLimit({ windowMs, max, keyFor, onLimit }) {
  const counter = createCounter({ windowMs, max });

  const middleware = function rateLimitMiddleware(req, res, next) {
    const key = keyFor(req);
    const wait = counter.retryAfter(key);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return onLimit(req, res, next);
    }
    counter.hit(key);
    return next();
  };
  middleware.counter = counter;
  return middleware;
}

module.exports = { rateLimit, createCounter };
