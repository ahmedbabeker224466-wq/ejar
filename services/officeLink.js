'use strict';

// The office's public link /<slug> (phase 1: one path on the platform's own
// domain, no custom domains). Rules for a slug, the automatic slug of a new
// office, changing it (old slugs keep redirecting), the public-page switch
// and description, and the lookup used by the public route.
//
// Office rows are read and changed through scopeToOffice(). The lookup of a
// slug (resolvePublic) and the global uniqueness check look across offices by
// design, like validateInviteCode: the visitor has no office.

const crypto = require('crypto');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');
const { daysAfter } = require('./contractDates');
const { findContact } = require('./publicText');

const MIN_LENGTH = 3;
const MAX_LENGTH = 40;
const DESCRIPTION_MAX = 300;
const CHANGES_PER_WINDOW = 3;
const CHANGE_WINDOW_DAYS = 30;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTO_PREFIX = 'office-';
const AUTO_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// Every top-level path the app mounts (tests/officeLink.test.js fails when a
// mounted path or a public/ folder is missing here), plus words kept for later
// or for the platform itself.
const MOUNTED = [
  'about', 'admin', 'blog', 'contact', 'cron', 'disclaimer', 'features', 'health', 'healthz', 'join', 'landlord',
  'listings', 'login', 'logout', 'logout-all', 'maintenance', 'notifications', 'office', 'platform', 'pricing',
  'privacy', 'register', 'robots', 'settings', 'sitemap', 'tenant', 'terms', 'webhooks', 'css', 'js',
];
const FIXED = [
  'admin', 'office', 'platform', 'login', 'logout', 'join', 'health', 'api', 'static', 'public', 'listings', 'blog',
  'pricing', 'features', 'about', 'contact', 'terms', 'privacy', 'disclaimer', 'landlord', 'tenant', 'billing',
  'www', 'aqdi', 'ejar', 'support', 'help', 'rega', 'zatca', 'gov', 'official',
  'assets', 'img', 'images', 'uploads', 'favicon', 'auth', 'account', 'signup', 'signin', 'home', 'dashboard',
  'mail', 'email', 'root', 'null', 'undefined',
];
const RESERVED = new Set([...MOUNTED, ...FIXED]);

// Names that look official or impersonate a government body. Long tokens are
// refused anywhere in the slug; short ones as a whole hyphen-separated part.
const OFFICIAL_ANYWHERE = [
  'ejar', 'eijar', 'iejar', 'nafath', 'nafaz', 'absher', 'balady', 'baladi', 'zatca', 'momrah', 'sakani', 'tawakkalna',
  'musaned', 'ministry', 'government', 'official', 'wizara', 'wazara', 'hukumi', 'hukoomi', 'saudigov',
];
const OFFICIAL_PARTS = ['rega', 'moj', 'gov', 'mol', 'mci', 'mhrsd', 'moh', 'moi', 'spl', 'sbc', 'nic', 'ijar', 'rhc'];

const ERRORS = {
  empty: 'اكتب الرابط المطلوب.',
  length: `الرابط من ${MIN_LENGTH} إلى ${MAX_LENGTH} حرفاً.`,
  chars: 'استخدم حروفاً إنجليزية صغيرة (a-z) وأرقاماً وشرطة واحدة (-) بين الكلمات فقط.',
  hyphen: 'لا تبدأ الرابط أو تنهِه بشرطة، ولا تكتب شرطتين متتاليتين.',
  reserved: 'هذا الرابط محجوز للمنصة. اختر رابطاً آخر.',
  official: 'لا يمكن استخدام رابط يوحي بجهة حكومية أو رسمية.',
  taken: 'هذا الرابط مستخدم. اختر رابطاً آخر.',
  limit: `يمكن تغيير الرابط ${CHANGES_PER_WINDOW} مرات كل ${CHANGE_WINDOW_DAYS} يوماً. حاول لاحقاً.`,
  same: 'هذا هو رابط مكتبك الحالي.',
  description: `الوصف ${DESCRIPTION_MAX} حرف كحد أقصى.`,
  description_contact: 'لا تكتب في الوصف رقم هاتف أو بريداً أو رابطاً أو رقم حساب؛ يتواصل الزوار عبر نموذج الاستفسار.',
};

/** The slug as typed, trimmed and lower-cased (case-insensitive everywhere). */
function normalizeSlug(raw) {
  return String(raw ?? '').trim().toLowerCase().slice(0, 200);
}

/** Pure check of a slug's form, reserved words and official look. Returns { ok, slug, error }. */
function validateSlug(raw) {
  const slug = normalizeSlug(raw);
  const fail = (error) => ({ ok: false, slug, error });
  if (!slug) return fail('empty');
  if (!/^[a-z0-9-]+$/.test(slug)) return fail('chars');
  if (slug.length < MIN_LENGTH || slug.length > MAX_LENGTH) return fail('length');
  if (!SLUG_PATTERN.test(slug)) return fail('hyphen');
  if (RESERVED.has(slug)) return fail('reserved');
  if (looksOfficial(slug)) return fail('official');
  return { ok: true, slug, error: null };
}

function looksOfficial(slug) {
  const flat = slug.replace(/-/g, '');
  if (OFFICIAL_ANYWHERE.some((w) => flat.includes(w))) return true;
  return slug.split('-').some((part) => OFFICIAL_PARTS.includes(part));
}

/** A random automatic slug: office-xxxxxx. */
function randomSlug() {
  const bytes = crypto.randomBytes(6);
  let out = AUTO_PREFIX;
  for (const b of bytes) out += AUTO_ALPHABET[b % AUTO_ALPHABET.length];
  return out;
}

/** Whether another office holds the slug, now or in its history (locking reads inside a transaction). */
async function takenByOther(conn, slug, officeId, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [current] = await conn.query(`SELECT id FROM offices WHERE public_slug = ? AND id <> ?${suffix}`, [slug, officeId]);
  if (current.length) return true;
  const [old] = await conn.query(`SELECT office_id FROM office_slug_history WHERE slug = ? AND office_id <> ?${suffix}`, [slug, officeId]);
  return old.length > 0;
}

/** Gives the office an automatic slug when it has none. Use inside the office's transaction. Returns the slug. */
async function assignAutoSlug(conn, officeId) {
  const scoped = scopeToOffice(conn, officeId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = randomSlug();
    if (!validateSlug(slug).ok || (await takenByOther(conn, slug, officeId))) continue;
    try {
      const changed = await scoped.query('UPDATE offices SET public_slug = ? WHERE id = :office_id AND public_slug IS NULL', [slug]);
      if (changed.affectedRows === 1) return slug;
      const [row] = await scoped.query('SELECT public_slug FROM offices WHERE id = :office_id');
      return row ? row.public_slug : null;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  throw new Error('slug_exhausted');
}

/**
 * Migration (ensureSchema at start-up): every office without a slug gets an
 * automatic one, page disabled. Idempotent. Returns how many were given.
 */
async function backfillSlugs(pool) {
  const [rows] = await pool.query('SELECT id FROM offices WHERE public_slug IS NULL ORDER BY id');
  let given = 0;
  for (const { id } of rows) {
    await withTransaction(pool, async (conn) => {
      const [office] = await scopeToOffice(conn, id).query('SELECT public_slug FROM offices WHERE id = :office_id FOR UPDATE');
      if (!office || office.public_slug !== null) return;
      await assignAutoSlug(conn, id);
      given += 1;
    });
  }
  return given;
}

/** How many slug changes the office made in the window ending now. */
async function recentChanges(scoped, now) {
  const [{ n }] = await scoped.query(
    'SELECT COUNT(*) AS n FROM office_slug_history WHERE office_id = :office_id AND created_at > ?',
    [daysAfter(now, -CHANGE_WINDOW_DAYS)],
  );
  return Number(n);
}

/** What the settings section shows. */
async function linkSettings(pool, officeId, now = new Date()) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query('SELECT public_slug, public_page_enabled, public_description FROM offices WHERE id = :office_id');
  return {
    slug: row ? row.public_slug : null,
    enabled: Boolean(row && Number(row.public_page_enabled)),
    description: row ? row.public_description || '' : '',
    changesLeft: Math.max(0, CHANGES_PER_WINDOW - (await recentChanges(scoped, now))),
  };
}

/**
 * Changes the office's slug: { ok: true, slug, previous } or { ok: false, error }.
 * One transaction with the office row locked: form, limit (3 per 30 days),
 * uniqueness against current slugs and history, the old slug into
 * office_slug_history (it then redirects), audit row. The office may take
 * back one of its own old slugs.
 */
async function changeSlug(pool, { officeId, actorId, slug: raw, ip = null, now = new Date() }) {
  const checked = validateSlug(raw);
  if (!checked.ok) return { ok: false, error: checked.error };
  const slug = checked.slug;
  try {
    return await withTransaction(pool, async (conn) => {
      const scoped = scopeToOffice(conn, officeId);
      const [office] = await scoped.query('SELECT id, public_slug FROM offices WHERE id = :office_id FOR UPDATE');
      if (!office) return { ok: false, error: 'taken' };
      const previous = office.public_slug;
      if (previous === slug) return { ok: false, error: 'same' };
      if ((await recentChanges(scoped, now)) >= CHANGES_PER_WINDOW) return { ok: false, error: 'limit' };
      if (await takenByOther(conn, slug, officeId, { lock: true })) return { ok: false, error: 'taken' };
      await scoped.query('DELETE FROM office_slug_history WHERE office_id = :office_id AND slug = ?', [slug]);
      if (previous) await scoped.insert('office_slug_history', { slug: previous, created_at: now });
      await scoped.query('UPDATE offices SET public_slug = ? WHERE id = :office_id', [slug]);
      await createAudit(conn).write(actorId, officeId, 'office.public_slug', 'office', officeId, { slug: previous }, { slug }, ip);
      return { ok: true, slug, previous };
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { ok: false, error: 'taken' };
    throw err;
  }
}

/** Checks the public-page form: { values: { enabled, description }, errors }. */
function validatePageFields(body = {}) {
  const errors = {};
  const description = String(body.description ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (description.length > DESCRIPTION_MAX) errors.description = ERRORS.description;
  else if (description && findContact(description)) errors.description = ERRORS.description_contact;
  return { values: { enabled: body.enabled === '1', description: description || null }, errors };
}

/** Saves the switch and the description; audits the switch and whether the text changed (never the text). */
async function savePublicPage(pool, { officeId, actorId, enabled, description, ip = null }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const [office] = await scoped.query('SELECT public_page_enabled, public_description FROM offices WHERE id = :office_id FOR UPDATE');
    if (!office) return false;
    await scoped.query('UPDATE offices SET public_page_enabled = ?, public_description = ? WHERE id = :office_id', [enabled ? 1 : 0, description]);
    const changed = (office.public_description || null) !== description ? ['public_description'] : [];
    await createAudit(conn).write(actorId, officeId, 'office.public_page', 'office', officeId,
      { enabled: Boolean(Number(office.public_page_enabled)) }, { enabled: Boolean(enabled), changed }, ip);
    return true;
  });
}

// The office may be shown: page switched on and the subscription live (as for public listings).
const VISIBLE_SQL = `o.public_page_enabled = 1
  AND (o.status IN ('active','past_due') OR (o.status = 'trial' AND o.trial_ends_at > ?))`;

/**
 * The public route's lookup: { state: 'ok', office: { id, name, city, slug, description } },
 * { state: 'redirect', slug } for an old or differently-cased slug of a visible office,
 * or { state: 'none' } (unknown, disabled, suspended, expired trial, bad form).
 */
async function resolvePublic(pool, raw, now = new Date()) {
  const asTyped = String(raw ?? '');
  const slug = asTyped.toLowerCase();
  if (slug.length < MIN_LENGTH || slug.length > MAX_LENGTH || !SLUG_PATTERN.test(slug)) return { state: 'none' };
  const [[office]] = await pool.query(
    `SELECT o.id, o.name, o.city, o.public_slug, o.public_description FROM offices o WHERE o.public_slug = ? AND ${VISIBLE_SQL}`,
    [slug, now],
  );
  if (office) {
    if (asTyped !== office.public_slug) return { state: 'redirect', slug: office.public_slug };
    return {
      state: 'ok',
      office: { id: Number(office.id), name: office.name, city: office.city, slug: office.public_slug, description: office.public_description || '' },
    };
  }
  const [[old]] = await pool.query(
    `SELECT o.public_slug FROM office_slug_history h JOIN offices o ON o.id = h.office_id
      WHERE h.slug = ? AND o.public_slug IS NOT NULL AND ${VISIBLE_SQL}`,
    [slug, now],
  );
  return old ? { state: 'redirect', slug: old.public_slug } : { state: 'none' };
}

/**
 * Visible office pages for the sitemap: switched on, live, and with at least
 * one public listing (a page without one is noindex, so it is left out).
 */
async function publicIndex(pool, now = new Date(), limit = 5000) {
  // Required here: services/listings.js loads modules that load this file.
  const { PUBLIC_WHERE } = require('./listings');
  const [rows] = await pool.query(
    `SELECT o.public_slug, o.updated_at FROM offices o
      WHERE o.public_slug IS NOT NULL AND ${VISIBLE_SQL}
        AND EXISTS (SELECT 1 FROM listings l WHERE l.office_id = o.id AND ${PUBLIC_WHERE})
      ORDER BY o.id LIMIT ${Number(limit)}`,
    [now, now, now],
  );
  return rows.map((r) => ({ slug: r.public_slug, updatedAt: r.updated_at }));
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  DESCRIPTION_MAX,
  CHANGES_PER_WINDOW,
  CHANGE_WINDOW_DAYS,
  RESERVED,
  ERRORS,
  normalizeSlug,
  validateSlug,
  looksOfficial,
  randomSlug,
  assignAutoSlug,
  backfillSlugs,
  linkSettings,
  changeSlug,
  validatePageFields,
  savePublicPage,
  resolvePublic,
  publicIndex,
};
