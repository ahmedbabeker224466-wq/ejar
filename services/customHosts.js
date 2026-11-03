'use strict';

// Host-based routing for office custom domains (Prompt 24). A request whose
// Host is not one of the platform's own hosts is looked up here: the office
// whose offices.custom_domain equals it, whose LATEST domain request is
// 'active', and whose public page is visible (officeLink VISIBLE_SQL: page
// switched on, status active or past_due, or a trial that has not expired).
//
// The Host header is read raw (never X-Forwarded-Host). Lookups are cached in
// memory: found for 60 s, not found for 30 s, at most 1000 hosts; clear() runs
// when the admin changes a domain request or an office's public page, and
// nothing ever serves longer than the TTL after a change made elsewhere.

const { VISIBLE_SQL } = require('./officeLink');

const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
const FOUND_TTL_MS = 60 * 1000;
const MISSING_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 1000;
const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * Pure: the Host header as a bare lower-case host name (no port, no trailing
 * dot, IPv6 without brackets), or null when it is not a plausible host.
 */
function normalizeHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    return host.slice(1, end) || null; // IPv6 literal: kept as is (only ::1 is ever a main host)
  }
  const colon = host.indexOf(':');
  if (colon >= 0) {
    if (!/^:\d{1,5}$/.test(host.slice(colon))) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return HOST_SHAPE.test(host) && !host.includes('..') ? host : null;
}

/** The host of APP_URL, or '' when it is not set (then every host is a main host). */
function appHost(env = process.env) {
  try {
    return new URL(String(env.APP_URL || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The platform's own hosts: APP_URL, the local ones and ALLOWED_HOSTS (comma separated). */
function mainHosts(env = process.env) {
  const hosts = new Set(LOCAL_HOSTS);
  const app = appHost(env);
  if (app) hosts.add(app);
  for (const part of String(env.ALLOWED_HOSTS || '').split(',')) {
    const h = normalizeHost(part);
    if (h) hosts.add(h);
  }
  return hosts;
}

/** Pure: 'main' | 'custom' for a normalized host. Without APP_URL nothing is custom (feature off). */
function classify(host, env = process.env) {
  if (!host || !appHost(env)) return 'main';
  return mainHosts(env).has(host) ? 'main' : 'custom';
}

// ------------------------------------------------------------ lookup + cache

const cache = new Map();

function remember(host, office, now) {
  if (cache.has(host)) cache.delete(host);
  cache.set(host, { office, expires: now + (office ? FOUND_TTL_MS : MISSING_TTL_MS) });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/** The cached answer for a host: { hit: true, office } or { hit: false }. */
function cached(host, now = Date.now()) {
  const entry = cache.get(host);
  if (!entry) return { hit: false };
  if (entry.expires <= now) {
    cache.delete(host);
    return { hit: false };
  }
  return { hit: true, office: entry.office };
}

/** Forgets every cached host (admin changed a domain request or a public page). */
function clear() {
  cache.clear();
}

const LIVE_REQUEST_SQL = `(SELECT r.status FROM office_domain_requests r WHERE r.office_id = o.id ORDER BY r.id DESC LIMIT 1) = 'active'`;

/** ONE query: the office served on this host, or null. Cached. */
async function lookup(pool, host, { now = new Date(), clock = Date.now() } = {}) {
  const hit = cached(host, clock);
  if (hit.hit) return hit.office;
  const [[row]] = await pool.query(
    `SELECT o.id, o.name, o.city, o.public_slug, o.public_description, o.custom_domain FROM offices o
      WHERE o.custom_domain = ? AND o.public_slug IS NOT NULL AND ${VISIBLE_SQL} AND ${LIVE_REQUEST_SQL}`,
    [host, now],
  );
  const office = row ? {
    id: Number(row.id), name: row.name, city: row.city, slug: row.public_slug, description: row.public_description || '', host: row.custom_domain,
  } : null;
  remember(host, office, clock);
  return office;
}

/** The live custom domain of an office (for rel=canonical on /<slug>), or null. Not cached. */
async function liveDomainOf(pool, officeId) {
  const [[row]] = await pool.query(`SELECT o.custom_domain FROM offices o WHERE o.id = ? AND o.custom_domain IS NOT NULL AND ${LIVE_REQUEST_SQL}`, [officeId]);
  return row ? row.custom_domain : null;
}

module.exports = {
  LOCAL_HOSTS,
  FOUND_TTL_MS,
  MISSING_TTL_MS,
  MAX_ENTRIES,
  normalizeHost,
  appHost,
  mainHosts,
  classify,
  lookup,
  cached,
  clear,
  liveDomainOf,
  cacheSize: () => cache.size,
};
