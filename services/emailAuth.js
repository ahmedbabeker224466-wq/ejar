'use strict';

// Email account helpers shared by the email-code sign-in, the join flow and the
// admin sign-in: address normalisation, lookup, registration, audit and the
// set-user-email script. (The code-less test sign-in, AUTH_EMAIL_TEST, was
// removed before launch, Nov 2026.) platform_admin accounts never sign in by
// email here; they use /admin/login. The address is never written to the audit log.

const { normalizeSaudi } = require('../utils/phone');
const { createAudit } = require('./audit');

const EMAIL = /^[^\s@<>"'(),;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;

/** Lower-case, trimmed email, or null when it is not a plausible address. */
function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (!email || email.length > 190) return null;
  return EMAIL.test(email) ? email : null;
}

/** Users whose email matches (stored lower-case; the column collation is case-insensitive too). More than one = ambiguous, refused. */
async function usersByEmail(pool, email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 2', [email]);
  return rows;
}

/**
 * Login decision for an email. Returns { ok: true, user } or { ok: false, error }
 * with error invalid_email | unknown | ambiguous | platform_admin | inactive.
 */
async function findForLogin(pool, input) {
  const email = normalizeEmail(input);
  if (!email) return { ok: false, error: 'invalid_email' };
  const rows = await usersByEmail(pool, email);
  if (rows.length === 0) return { ok: false, error: 'unknown' };
  if (rows.length > 1) return { ok: false, error: 'ambiguous' };
  const user = rows[0];
  if (user.role === 'platform_admin' || user.role === 'platform_staff') return { ok: false, error: 'platform_admin', user };
  if (!Number(user.is_active)) return { ok: false, error: 'inactive', user };
  return { ok: true, user };
}

/**
 * Creates a user with this email and no role yet (role NULL lands on
 * /office/new, the normal office creation flow). Returns { ok: true, user } or
 * { ok: false, error } with error invalid_email | exists | signups_disabled.
 */
async function register(pool, input, { signupsDisabled } = {}) {
  const email = normalizeEmail(input);
  if (!email) return { ok: false, error: 'invalid_email' };
  if ((await usersByEmail(pool, email)).length) return { ok: false, error: 'exists' };
  if (signupsDisabled && (await signupsDisabled())) return { ok: false, error: 'signups_disabled' };
  let insertId;
  try {
    const [made] = await pool.query('INSERT INTO users (phone, email, role, phone_verified) VALUES (NULL, ?, NULL, 0)', [email]);
    insertId = made.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { ok: false, error: 'exists' };
    throw err;
  }
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [insertId]);
  return { ok: true, user };
}

/** One audit row per email attempt: the user id and the outcome, never the address. */
async function audit(pool, { action, userId = null, outcome, ip, method = 'email_code' }) {
  return createAudit(pool).log(userId, null, action, 'user', userId, null, { outcome, method }, ip);
}

/**
 * For scripts/set-user-email.js: gives the user with this phone an email.
 * Returns { ok: true, userId, changed } or { ok: false, error } with error
 * invalid_phone | invalid_email | no_user | platform_admin | taken.
 */
async function setUserEmail(pool, phoneInput, emailInput) {
  const phone = normalizeSaudi(phoneInput);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  const email = normalizeEmail(emailInput);
  if (!email) return { ok: false, error: 'invalid_email' };
  const [[user]] = await pool.query('SELECT id, role, email FROM users WHERE phone = ?', [phone]);
  if (!user) return { ok: false, error: 'no_user' };
  if (user.role === 'platform_admin') return { ok: false, error: 'platform_admin' };
  const others = (await usersByEmail(pool, email)).filter((u) => Number(u.id) !== Number(user.id));
  if (others.length) return { ok: false, error: 'taken' };
  if (user.email === email) return { ok: true, userId: Number(user.id), changed: false };
  try {
    await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, user.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { ok: false, error: 'taken' };
    throw err;
  }
  await createAudit(pool).log(null, null, 'user.email_set', 'user', user.id, null, { via: 'script' }, null);
  return { ok: true, userId: Number(user.id), changed: true };
}

module.exports = {
  normalizeEmail,
  findForLogin,
  register,
  audit,
  setUserEmail,
};
