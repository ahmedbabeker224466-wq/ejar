'use strict';

// Office registration, the office context, status rules and dashboard counts.

const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { withTransaction } = require('./transaction');
const contractDates = require('./contractDates');
const engine = require('./contractEngine');
const { normalizeSaudi, toWesternDigits } = require('../utils/phone');

// Riyadh first, then the other large cities, then a catch-all.
const { SAUDI_CITIES } = require('../config/saudiCities');

// Reminder channels for a new office: site and email on, the rest off.
const DEFAULT_SETTINGS = {
  'reminders.channel.site': '1',
  'reminders.channel.email': '1',
  'reminders.channel.whatsapp': '0',
  'reminders.channel.telegram': '0',
};

const OFFICE_FIELDS = ['name', 'city', 'phone', 'email', 'cr_number', 'rega_license'];

class OfficeCreateError extends Error {
  constructor(reason) {
    super(`Office creation refused: ${reason}`);
    this.name = 'OfficeCreateError';
    this.reason = reason;
  }
}

function clean(value, max) {
  return toWesternDigits(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Saudi mobile ('9665XXXXXXXX') or landline ('9661XXXXXXXX'), else null. */
function normalizeOfficePhone(input) {
  const mobile = normalizeSaudi(input);
  if (mobile) return mobile;
  const compact = toWesternDigits(String(input ?? '')).replace(/[\s-]/g, '');
  const landline = /^(?:\+?966|0)(1[1-7]\d{7})$/.exec(compact);
  return landline ? `966${landline[1]}` : null;
}

/**
 * Checks the office form. Returns { values, errors }: values are ready to
 * store, errors maps a field to an Arabic message. Never throws.
 */
function validateOfficeFields(body = {}) {
  const errors = {};
  const values = {};

  values.name = clean(body.name, 200);
  if (values.name.length < 2 || values.name.length > 150) {
    errors.name = 'اكتب اسم المكتب (من حرفين إلى 150 حرفاً).';
  }

  values.city = clean(body.city, 80);
  if (!SAUDI_CITIES.includes(values.city)) errors.city = 'اختر المدينة من القائمة.';

  const phone = normalizeOfficePhone(body.phone);
  values.phone = phone;
  if (!phone) errors.phone = 'اكتب رقم جوال سعودي (05XXXXXXXX) أو رقم هاتف ثابت (011XXXXXXX).';

  const email = clean(body.email, 200).toLowerCase();
  values.email = email || null;
  if (email && (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
    errors.email = 'البريد الإلكتروني غير صحيح.';
  }

  const cr = clean(body.cr_number, 40).replace(/\s/g, '');
  values.cr_number = cr || null;
  if (cr && !/^\d{10}$/.test(cr)) errors.cr_number = 'رقم السجل التجاري يتكون من 10 أرقام.';

  const rega = clean(body.rega_license, 40).replace(/\s/g, '');
  values.rega_license = rega || null;
  if (rega && !/^\d{5,20}$/.test(rega)) errors.rega_license = 'رقم ترخيص فال أرقام فقط (من 5 إلى 20 رقماً).';

  return { values, errors };
}

/**
 * The user's office memberships, active first. This is the one lookup that is
 * keyed by the signed-in user instead of an office: it is how the office id is
 * found in the first place, so it cannot go through scopeToOffice(). The user
 * id always comes from the verified session, never from the request.
 */
async function membershipsFor(pool, userId) {
  const [rows] = await pool.query(
    `SELECT m.office_id, m.role, m.is_active,
            o.name, o.city, o.status, o.trial_ends_at,
            p.code AS plan_code, p.name_ar AS plan_name
       FROM office_members m
       JOIN offices o ON o.id = m.office_id
       LEFT JOIN plans p ON p.id = o.plan_id
      WHERE m.user_id = ?
      ORDER BY m.is_active DESC, m.joined_at ASC, m.id ASC`,
    [userId],
  );
  return rows;
}

/**
 * Creates the office and makes the user its owner, all in one transaction:
 * office, users.role, office_members, office_settings, audit_logs. Anything
 * failing rolls every step back (a deadlock is retried, see services/transaction.js). Only a user with no role and no office may
 * create one, so this can never grant platform_admin or a second office.
 */
async function createOffice(pool, { userId, fields, ip, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    // Locks the user row, so a double submit cannot create two offices.
    const [[user]] = await conn.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user) throw new OfficeCreateError('no_user');
    if (user.role !== null) throw new OfficeCreateError('has_role');
    if ((await membershipsFor(conn, userId)).length > 0) throw new OfficeCreateError('has_office');

    const [[plan]] = await conn.query(
      'SELECT id FROM plans WHERE is_active = 1 ORDER BY price_monthly ASC, sort_order ASC, id ASC LIMIT 1',
    );
    const trialEndsAt = contractDates.trialEndsAt(now);
    const [created] = await conn.query(
      `INSERT INTO offices
         (name, city, phone, email, cr_number, rega_license, owner_id, plan_id, status, trial_ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'trial', ?)`,
      [
        fields.name,
        fields.city,
        fields.phone,
        fields.email,
        fields.cr_number,
        fields.rega_license,
        userId,
        plan ? plan.id : null,
        trialEndsAt,
      ],
    );
    const officeId = created.insertId;
    const scoped = scopeToOffice(conn, officeId);

    const [roleUpdate] = await conn.query(
      "UPDATE users SET role = 'office_owner' WHERE id = ? AND role IS NULL",
      [userId],
    );
    if (roleUpdate.affectedRows !== 1) throw new OfficeCreateError('has_role');

    await scoped.insert('office_members', { user_id: userId, role: 'office_owner', is_active: 1 });
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await scoped.insert('office_settings', { setting_key: key, setting_value: value });
    }
    await createAudit(conn).write(userId, officeId, 'office.create', 'office', officeId, null, {
      name: fields.name,
      city: fields.city,
      status: 'trial',
      plan_id: plan ? plan.id : null,
    }, ip);

    return officeId;
  });
}

/**
 * What the office may do right now, from its status:
 * trial (not expired) and active: full access; past_due: access plus a red
 * banner; suspended or an expired trial: locked except billing and settings.
 */
function officeAccess(office, now = new Date()) {
  const result = { locked: false, reason: null, pastDue: false, onTrial: false, trialDaysLeft: null };
  if (office.status === 'suspended') return { ...result, locked: true, reason: 'suspended' };
  if (office.status === 'trial') {
    if (contractDates.isTrialExpired(office.trial_ends_at, now)) {
      return { ...result, locked: true, reason: 'trial_expired' };
    }
    return { ...result, onTrial: true, trialDaysLeft: contractDates.trialDaysLeft(office.trial_ends_at, now) };
  }
  if (office.status === 'past_due') return { ...result, pastDue: true };
  if (office.status === 'active') return result;
  return { ...result, locked: true, reason: 'suspended' }; // unknown status: fail closed
}

const LIVE_CONTRACT = "status IN ('calm','soon','urgent','deadline_passed')";

/**
 * The dashboard numbers, counted inside this office only. "Decision within
 * 90 days" is a display window, not an Ejar rule. A payment is late when it
 * is marked late, or still due after its due date.
 */
async function dashboardCounts(pool, officeId, now = new Date()) {
  const scoped = scopeToOffice(pool, officeId);
  const today = contractDates.riyadhDate(now);
  const window = engine.dateWindow(today, 90);
  const [row] = await scoped.query(
    `SELECT
       (SELECT COUNT(*) FROM contracts WHERE office_id = :office_id) AS contracts_total,
       (SELECT COUNT(*) FROM contracts
         WHERE office_id = :office_id AND ${LIVE_CONTRACT}) AS active_contracts,
       (SELECT COUNT(*) FROM contracts
         WHERE office_id = :office_id AND ${LIVE_CONTRACT} AND notice_deadline BETWEEN ? AND ?) AS deadline_90,
       (SELECT COUNT(*) FROM contract_payments
         WHERE office_id = :office_id AND (status = 'late' OR (status = 'due' AND due_date < ?))) AS late_payments,
       (SELECT COALESCE(SUM(amount - paid_amount), 0) FROM contract_payments
         WHERE office_id = :office_id AND (status = 'late' OR (status = 'due' AND due_date < ?))) AS late_total,
       (SELECT COUNT(*) FROM maintenance_requests
         WHERE office_id = :office_id AND status IN ('new','seen','in_progress')) AS open_maintenance,
       (SELECT COUNT(*) FROM landlords WHERE office_id = :office_id) AS landlords_total,
       (SELECT COUNT(*) FROM landlords WHERE office_id = :office_id AND is_active = 1) AS landlords_active`,
    [window.from, window.to, today, today],
  );
  return {
    contractsTotal: Number(row.contracts_total),
    activeContracts: Number(row.active_contracts),
    deadline90: Number(row.deadline_90),
    latePayments: Number(row.late_payments),
    lateTotal: String(row.late_total),
    openMaintenance: Number(row.open_maintenance),
    landlordsTotal: Number(row.landlords_total),
    landlordsActive: Number(row.landlords_active),
  };
}

/** The office's editable details. */
async function officeDetails(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT ${OFFICE_FIELDS.join(', ')} FROM offices WHERE id = :office_id`,
  );
  return row || null;
}

/** Saves the office details and audit-logs what changed. Returns the changed field names. */
async function updateOffice(pool, { officeId, actorId, fields, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const before = await officeDetails(pool, officeId);
  if (!before) throw new OfficeCreateError('no_office');
  const changed = OFFICE_FIELDS.filter((f) => (before[f] ?? null) !== (fields[f] ?? null));
  if (changed.length === 0) return [];
  await scoped.query(
    `UPDATE offices SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE id = :office_id`,
    changed.map((f) => fields[f]),
  );
  const pick = (source) => Object.fromEntries(changed.map((f) => [f, source[f] ?? null]));
  await createAudit(pool).log(actorId, officeId, 'office.update', 'office', officeId, pick(before), pick(fields), ip);
  return changed;
}

module.exports = {
  SAUDI_CITIES,
  DEFAULT_SETTINGS,
  OfficeCreateError,
  normalizeOfficePhone,
  validateOfficeFields,
  membershipsFor,
  createOffice,
  officeAccess,
  dashboardCounts,
  officeDetails,
  updateOffice,
};
