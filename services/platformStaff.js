'use strict';

// Platform staff: limited admin accounts the platform admin creates at
// /admin/staff. Each has a name, an email, a bcrypt password hash and a list of
// admin sections (routes/admin.js STAFF_SECTIONS). They sign in at
// /admin/login like the admin. The password itself is never stored, logged or
// audited.

const bcrypt = require('bcryptjs');
const emailAuth = require('./emailAuth');

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;
// Compared against when no account matches, so a missing account takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0000', 10);

/** Pure: validates the staff form. sectionsAllowed = the keys of STAFF_SECTIONS. */
function validate(body, sectionsAllowed, { creating }) {
  const errors = {};
  const name = String(body.name || '').trim().slice(0, 120);
  if (name.length < 2) errors.name = 'اكتب اسم الموظف.';
  const email = emailAuth.normalizeEmail(String(body.email || '').slice(0, 190));
  if (creating && !email) errors.email = 'اكتب بريداً إلكترونياً صحيحاً.';
  const password = String(body.password || '');
  if (creating || password) {
    if (password.length < MIN_PASSWORD) errors.password = `كلمة المرور ${MIN_PASSWORD} أحرف على الأقل.`;
    else if (password.length > MAX_PASSWORD) errors.password = 'كلمة المرور طويلة جداً.';
  }
  const picked = [].concat(body.sections || []).map(String);
  const sections = sectionsAllowed.filter((k) => picked.includes(k));
  if (!sections.length) errors.sections = 'اختر قسماً واحداً على الأقل.';
  return { values: { name, email, password, sections }, errors };
}

async function list(pool) {
  const [rows] = await pool.query(
    `SELECT id, name, email, admin_sections, is_active, twofa_enabled, last_seen_at, created_at
       FROM users WHERE role = 'platform_staff' ORDER BY is_active DESC, id DESC`,
  );
  return rows.map((r) => ({ ...r, sections: r.admin_sections ? String(r.admin_sections).split(',') : [] }));
}

async function get(pool, id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id))) return null;
  const [[row]] = await pool.query(
    "SELECT id, name, email, admin_sections, is_active FROM users WHERE id = ? AND role = 'platform_staff'",
    [id],
  );
  return row ? { ...row, sections: row.admin_sections ? String(row.admin_sections).split(',') : [] } : null;
}

/** Creates the account. Returns { ok: true, id } or { ok: false, error: 'taken' }. */
async function create(pool, { name, email, password, sections }) {
  const [[taken]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (taken) return { ok: false, error: 'taken' };
  const hash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    "INSERT INTO users (name, email, role, password_hash, admin_sections, is_active) VALUES (?, ?, 'platform_staff', ?, ?, 1)",
    [name, email, hash, sections.join(',')],
  );
  return { ok: true, id: result.insertId };
}

/** Updates name and sections, and the password when a new one is given. */
async function update(pool, id, { name, password, sections }) {
  await pool.query("UPDATE users SET name = ?, admin_sections = ? WHERE id = ? AND role = 'platform_staff'", [name, sections.join(','), id]);
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'platform_staff'", [hash, id]);
  }
}

async function setActive(pool, id, active) {
  await pool.query("UPDATE users SET is_active = ? WHERE id = ? AND role = 'platform_staff'", [active ? 1 : 0, id]);
}

/** The active staff account for this email and password, or null. Always runs one bcrypt compare. */
async function authenticate(pool, emailInput, password) {
  const email = emailAuth.normalizeEmail(emailInput);
  const [[row]] = email
    ? await pool.query(
      `SELECT id, phone, email, name, role, is_active, twofa_enabled, session_epoch, password_hash
         FROM users WHERE email = ? AND role = 'platform_staff' LIMIT 1`,
      [email],
    )
    : [[]];
  const ok = await bcrypt.compare(String(password || '').slice(0, MAX_PASSWORD), row && row.password_hash ? row.password_hash : DUMMY_HASH);
  if (!row || !ok || !Number(row.is_active)) return null;
  delete row.password_hash;
  return row;
}

module.exports = { validate, list, get, create, update, setActive, authenticate, MIN_PASSWORD };
