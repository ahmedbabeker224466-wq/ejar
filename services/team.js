'use strict';

// The office team: members, staff invites by phone, role changes and
// deactivation. Every query goes through scopeToOffice(). (Invites and
// deactivation are added below the member list.)

const { scopeToOffice } = require('./scopeToOffice');
const { toLocal, maskPhone } = require('../utils/phone');

const ROLE_LABELS = { office_owner: 'مالك المكتب', office_manager: 'مدير', office_staff: 'موظف' };

/** The name a person shows under: their profile name, else their masked phone. */
function displayName(row) {
  return (row.name && String(row.name).trim()) || maskPhone(row.phone) || toLocal(row.phone);
}

/** Members of the office (active first), with display names. */
async function listMembers(pool, officeId, { activeOnly = false } = {}) {
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT m.id AS member_id, m.user_id, m.role, m.is_active, m.joined_at, u.name, u.phone
       FROM office_members m JOIN users u ON u.id = m.user_id
      WHERE m.office_id = :office_id${activeOnly ? ' AND m.is_active = 1' : ''}
      ORDER BY m.is_active DESC, FIELD(m.role, 'office_owner', 'office_manager', 'office_staff'), m.id`,
  );
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id), is_active: Boolean(Number(r.is_active)), display: displayName(r), roleLabel: ROLE_LABELS[r.role] }));
}

module.exports = { ROLE_LABELS, displayName, listMembers };

// ------------------------------------------------------------ staff management

const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');
const invites = require('./invites');
const planLimits = require('./planLimits');
const { normalizeSaudi } = require('../utils/phone');

const ASSIGNABLE = ['office_manager', 'office_staff'];

/**
 * Who may change whom. The owner manages every other member; a manager
 * manages staff only (never other managers or the owner). Nobody manages
 * themselves here.
 */
function canManage(actorRole, targetRole) {
  if (actorRole === 'office_owner') return targetRole !== 'office_owner';
  if (actorRole === 'office_manager') return targetRole === 'office_staff';
  return false;
}

async function memberRow(scoped, memberId) {
  if (!memberId) return null;
  const [row] = await scoped.query(
    `SELECT m.id, m.user_id, m.role, m.is_active FROM office_members m WHERE m.id = ? AND m.office_id = :office_id`,
    [memberId],
  );
  return row ? { ...row, id: Number(row.id), user_id: Number(row.user_id), is_active: Boolean(Number(row.is_active)) } : null;
}

/** Everything the team page shows: members, pending invites and the plan usage. */
async function overview(pool, officeId, actor) {
  const scoped = scopeToOffice(pool, officeId);
  const members = await listMembers(pool, officeId);
  const usage = await planLimits.memberUsage(scoped);
  const pending = await invites.pendingStaffInvites(scoped);
  return {
    members: members.map((m) => ({ ...m, manageable: Number(m.user_id) !== Number(actor.id) && canManage(actor.role, m.role) })),
    pending: pending.map((i) => ({ ...i, roleLabel: ROLE_LABELS[i.role_hint], phoneMasked: maskPhone(i.phone) })),
    usage,
  };
}

/**
 * Invites a person to the team by phone. The limit counts active members plus
 * pending invites, checked with the office row locked. Returns { ok, invite }
 * or { ok: false, error: 'invalid_phone' | 'invalid_role' | 'forbidden' |
 * 'already_member' | 'phone_used' | 'limit', message? }.
 */
async function inviteStaff(pool, officeId, { actor, phone: rawPhone, role, ip }) {
  const phone = normalizeSaudi(rawPhone);
  if (!phone) return { ok: false, error: 'invalid_phone' };
  if (!ASSIGNABLE.includes(role)) return { ok: false, error: 'invalid_role' };
  if (!canManage(actor.role, role)) return { ok: false, error: 'forbidden' };
  const [[user]] = await pool.query('SELECT id, role FROM users WHERE phone = ?', [phone]);
  if (user) {
    const [member] = await scopeToOffice(pool, officeId).query('SELECT id FROM office_members WHERE user_id = ? AND office_id = :office_id', [user.id]);
    if (member) return { ok: false, error: 'already_member' };
    if (user.role !== null) return { ok: false, error: 'phone_used' };
  }
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const usage = await planLimits.memberUsage(scoped, { lock: true }); // first: see planLimits
    const [{ n }] = await scoped.query(
      `SELECT COUNT(*) AS n FROM invites WHERE kind = 'staff' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()
         AND phone <> ? AND office_id = :office_id`,
      [phone],
    );
    const check = planLimits.checkLimit({ limit: usage.limit, current: usage.current + Number(n), adding: 1 });
    if (!check.ok) return { ok: false, error: 'limit', message: planLimits.memberLimitMessage({ limit: check.limit, current: check.current }) };
    return invites.createStaffInvite(scoped, { phone, role, createdBy: actor.id, ip });
  });
}

/** Owner only: manager <-> staff. Returns { ok } or { ok: false, error }. */
async function changeRole(pool, officeId, { actor, memberId, role, ip }) {
  if (actor.role !== 'office_owner') return { ok: false, error: 'forbidden' };
  if (!ASSIGNABLE.includes(role)) return { ok: false, error: 'invalid_role' };
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const member = await memberRow(scoped, memberId);
    if (!member) return { ok: false, error: 'not_found' };
    if (member.role === 'office_owner' || member.user_id === Number(actor.id)) return { ok: false, error: 'forbidden' };
    if (member.role === role) return { ok: true, unchanged: true };
    await scoped.query('UPDATE office_members SET role = ? WHERE id = ? AND office_id = :office_id', [role, memberId]);
    await conn.query('UPDATE users SET role = ? WHERE id = ?', [role, member.user_id]);
    await createAudit(conn).write(actor.id, officeId, 'team.role', 'office_member', memberId, { role: member.role }, { role }, ip);
    return { ok: true };
  });
}

/**
 * Deactivates a member: they lose access at once (their sessions end, the
 * session epoch is bumped), and the open work assigned to them is unassigned.
 * Returns { ok } or { ok: false, error: 'not_found' | 'forbidden' }.
 */
async function deactivate(pool, officeId, { actor, memberId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const member = await memberRow(scoped, memberId);
    if (!member) return { ok: false, error: 'not_found' };
    if (member.user_id === Number(actor.id) || !canManage(actor.role, member.role)) return { ok: false, error: 'forbidden' };
    if (!member.is_active) return { ok: true, unchanged: true };
    await scoped.query('UPDATE office_members SET is_active = 0 WHERE id = ? AND office_id = :office_id', [memberId]);
    await conn.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?', [member.user_id]);
    await conn.query('UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [member.user_id]);
    await scoped.query(
      "UPDATE maintenance_requests SET assigned_to = NULL WHERE assigned_to = ? AND status IN ('new','seen','in_progress') AND office_id = :office_id",
      [member.user_id],
    );
    await scoped.query("UPDATE office_tasks SET assigned_to = NULL WHERE assigned_to = ? AND status <> 'done' AND office_id = :office_id", [member.user_id]);
    await createAudit(conn).write(actor.id, officeId, 'team.deactivate', 'office_member', memberId, { is_active: true }, { is_active: false }, ip);
    return { ok: true };
  });
}

/** Reactivates a member if the plan has room (office row locked first). Returns { ok } or { ok: false, error, message? }. */
async function activate(pool, officeId, { actor, memberId, ip }) {
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    const usage = await planLimits.memberUsage(scoped, { lock: true }); // first: see planLimits
    const member = await memberRow(scoped, memberId);
    if (!member) return { ok: false, error: 'not_found' };
    if (!canManage(actor.role, member.role)) return { ok: false, error: 'forbidden' };
    if (member.is_active) return { ok: true, unchanged: true };
    const check = planLimits.checkLimit({ ...usage, adding: 1 });
    if (!check.ok) return { ok: false, error: 'limit', message: planLimits.memberLimitMessage(check) };
    await scoped.query('UPDATE office_members SET is_active = 1 WHERE id = ? AND office_id = :office_id', [memberId]);
    await createAudit(conn).write(actor.id, officeId, 'team.activate', 'office_member', memberId, { is_active: false }, { is_active: true }, ip);
    return { ok: true };
  });
}

Object.assign(module.exports, { ASSIGNABLE, canManage, overview, inviteStaff, changeRole, deactivate, activate });
