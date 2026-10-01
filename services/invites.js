'use strict';

// Invite codes: creation and revocation by an office (always through
// scopeToOffice), and validation and redemption by the person joining.
//
// validateInviteCode and markInviteUsed look a code up across all offices:
// the person joining has no office yet, so the code itself is the key. They
// return only the reasons below, never whether a malformed code "almost"
// matched, and never the code of another row.

const crypto = require('crypto');
const { ALPHABET, CODE_LENGTH, generateInviteCode } = require('./inviteCode');
const { inviteExpiresAt } = require('./contractDates');
const { createAudit } = require('./audit');
const { createCounter } = require('../middleware/rateLimit');
const { toWesternDigits } = require('../utils/phone');

const REASONS = ['not_found', 'expired', 'used', 'revoked'];
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const MAX_CODE_ATTEMPTS = 5;

/**
 * Canonical form of a typed code: trimmed, upper case, spaces and dashes
 * removed. Returns null for anything outside the alphabet (0 O 1 I L are
 * rejected, not mapped) or of the wrong length.
 */
function normalizeCode(input) {
  if (input === null || input === undefined) return null;
  const compact = toWesternDigits(String(input)).trim().toUpperCase().replace(/[\s\-‐-―]/g, '');
  return CODE_PATTERN.test(compact) ? compact : null;
}

/** 'active' | 'used' | 'revoked' | 'expired' for an invite row at a point in time. */
function inviteStatus(invite, now = new Date()) {
  if (invite.used_at) return 'used';
  if (invite.revoked_at) return 'revoked';
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

// A fixed value to compare against when no row matched, so a miss does the
// same work as a hit.
const DUMMY = Buffer.from('X'.repeat(CODE_LENGTH));

function sameCode(stored, typed) {
  const a = Buffer.from(String(stored));
  const b = Buffer.from(typed);
  if (a.length !== b.length) return crypto.timingSafeEqual(DUMMY, DUMMY) && false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Creates a landlord invite, revoking the landlord's previous active one.
 * `scoped` must be scopeToOffice() on a connection inside a transaction, so the
 * landlord row lock makes "one active invite per landlord" hold even when two
 * people press the button at once. Returns { ok, invite } or { ok: false, reason }
 * with reason 'not_found' | 'inactive' | 'joined'.
 */
async function createLandlordInvite(scoped, { landlordId, createdBy, ip = null, now = new Date(), generate = generateInviteCode }) {
  const [landlord] = await scoped.query(
    'SELECT id, user_id, is_active FROM landlords WHERE id = ? AND office_id = :office_id FOR UPDATE',
    [landlordId],
  );
  if (!landlord) return { ok: false, reason: 'not_found' };
  if (!landlord.is_active) return { ok: false, reason: 'inactive' };
  if (landlord.user_id) return { ok: false, reason: 'joined' };

  const revoked = await revokeActiveInvites(scoped, { landlordId });
  return insertInvite(scoped, { kind: 'landlord', landlordId, createdBy, ip, now, generate, revoked });
}

/**
 * Inserts one invite row with a fresh code. The UNIQUE key on invites.code is
 * the collision check: a duplicate is retried with a new code.
 */
async function insertInvite(scoped, { kind, landlordId = null, contractId = null, createdBy, ip, now, generate, revoked }) {
  const expiresAt = inviteExpiresAt(now);
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generate();
    try {
      const id = await scoped.insert('invites', {
        code,
        kind,
        landlord_id: landlordId,
        contract_id: contractId,
        created_by: createdBy,
        expires_at: expiresAt,
      });
      await auditWrite(scoped, createdBy, 'invite.create', id, null, {
        ...(landlordId ? { landlord_id: landlordId } : {}),
        ...(contractId ? { contract_id: contractId } : {}),
        kind,
        expires_at: expiresAt.toISOString(),
        replaced: revoked,
      }, ip);
      return { ok: true, invite: { id, code, expiresAt, revokedPrevious: revoked } };
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY' || attempt === MAX_CODE_ATTEMPTS) throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Creates the tenant invite of a contract, revoking its previous active one.
 * Same rules as landlord invites: `scoped` is scopeToOffice() on a connection
 * inside a transaction; the contract row lock keeps one active code per
 * contract. Returns { ok, invite } or { ok: false, reason } with reason
 * 'not_found' | 'closed' (terminated or renewed contracts get no code).
 */
async function createTenantInvite(scoped, { contractId, createdBy, ip = null, now = new Date(), generate = generateInviteCode }) {
  const [contract] = await scoped.query(
    'SELECT id, status FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE',
    [contractId],
  );
  if (!contract) return { ok: false, reason: 'not_found' };
  if (['terminated', 'renewed'].includes(contract.status)) return { ok: false, reason: 'closed' };
  const revoked = await revokeActiveTenantInvites(scoped, { contractId });
  return insertInvite(scoped, { kind: 'tenant', contractId, createdBy, ip, now, generate, revoked });
}

/** Revokes the contract's active tenant invites. Returns how many. */
async function revokeActiveTenantInvites(scoped, { contractId }) {
  const result = await scoped.query(
    `UPDATE invites SET revoked_at = UTC_TIMESTAMP()
      WHERE contract_id = ? AND kind = 'tenant' AND used_at IS NULL AND revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP() AND office_id = :office_id`,
    [contractId],
  );
  return result.affectedRows;
}

/** Revoke button on a contract: ends its active tenant invite. True when one was revoked. */
async function revokeTenantInvite(scoped, { contractId, actorId, ip = null }) {
  const count = await revokeActiveTenantInvites(scoped, { contractId });
  if (count > 0) {
    await auditWrite(scoped, actorId, 'invite.revoke', null, null, { contract_id: contractId, kind: 'tenant' }, ip);
  }
  return count > 0;
}

/** The contract's most recent tenant invite with who used it, or null. */
async function latestTenantInvite(scoped, contractId) {
  const [row] = await scoped.query(
    `SELECT i.id, i.code, i.used_at, i.revoked_at, i.expires_at, i.created_at, u.phone AS used_by_phone
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
      WHERE i.contract_id = ? AND i.kind = 'tenant' AND i.office_id = :office_id
      ORDER BY i.id DESC LIMIT 1`,
    [contractId],
  );
  return row || null;
}

/** Audit rows for invites never contain the code. */
async function auditWrite(scoped, actorId, action, inviteId, before, after, ip) {
  // audit_logs is not an office table; the office id comes from the scope.
  await createAudit({ query: (sql, params) => scoped.query(sql, params) }).write(
    actorId, scoped.officeId, action, 'invite', inviteId, before, after, ip,
  );
}

/** Revokes the landlord's active (unused, unrevoked, unexpired) invites. Returns how many. */
async function revokeActiveInvites(scoped, { landlordId }) {
  const result = await scoped.query(
    `UPDATE invites SET revoked_at = UTC_TIMESTAMP()
      WHERE landlord_id = ? AND kind = 'landlord' AND used_at IS NULL AND revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP() AND office_id = :office_id`,
    [landlordId],
  );
  return result.affectedRows;
}

/** Revoke button: ends the landlord's active invite. Returns true when one was revoked. */
async function revokeInvite(scoped, { landlordId, actorId, ip = null }) {
  const count = await revokeActiveInvites(scoped, { landlordId });
  if (count > 0) {
    await auditWrite(scoped, actorId, 'invite.revoke', null, null, { landlord_id: landlordId, kind: 'landlord' }, ip);
  }
  return count > 0;
}

/** The landlord's most recent invite with who used it, or null. */
async function latestLandlordInvite(scoped, landlordId) {
  const [row] = await scoped.query(
    `SELECT i.id, i.code, i.used_at, i.revoked_at, i.expires_at, i.created_at, u.phone AS used_by_phone
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
      WHERE i.landlord_id = ? AND i.kind = 'landlord' AND i.office_id = :office_id
      ORDER BY i.id DESC LIMIT 1`,
    [landlordId],
  );
  return row || null;
}

/**
 * Checks a typed code. Returns { ok: true, invite: { id, kind, officeId,
 * landlordId, contractId, expiresAt } } or { ok: false, reason } with reason
 * one of REASONS. Malformed input is simply 'not_found'.
 */
async function validateInviteCode(pool, input, now = new Date()) {
  const code = normalizeCode(input);
  if (!code) return { ok: false, reason: 'not_found' };
  const [[row]] = await pool.query(
    `SELECT id, code, kind, office_id, landlord_id, contract_id, used_at, revoked_at, expires_at
       FROM invites WHERE code = ? LIMIT 1`,
    [code],
  );
  // Compare even when nothing matched ('X' is outside the alphabet, so the
  // dummy never equals a real code).
  const matches = sameCode(row ? row.code : DUMMY.toString(), code);
  if (!row || !matches) return { ok: false, reason: 'not_found' };
  const status = inviteStatus(row, now);
  if (status !== 'active') return { ok: false, reason: status };
  return {
    ok: true,
    invite: {
      id: Number(row.id),
      kind: row.kind,
      officeId: Number(row.office_id),
      landlordId: row.landlord_id === null ? null : Number(row.landlord_id),
      contractId: row.contract_id === null ? null : Number(row.contract_id),
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Redeems a code for a user in one atomic UPDATE: only a code that is still
 * unused, unrevoked and unexpired changes, so of two simultaneous redemptions
 * exactly one succeeds. Returns true for the winner.
 */
async function markInviteUsed(pool, input, userId) {
  const code = normalizeCode(input);
  if (!code) return false;
  const [result] = await pool.query(
    `UPDATE invites SET used_at = UTC_TIMESTAMP(), used_by = ?
      WHERE code = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    [userId, code],
  );
  return result.affectedRows === 1;
}

/**
 * wa.me link with a ready Arabic message holding the code and the join page.
 * With the landlord's mobile it opens that chat; without it, WhatsApp asks
 * whom to send it to.
 */
function inviteShareLink({ code, officeName, baseUrl, phone = null, kind = 'landlord' }) {
  const what = kind === 'tenant' ? 'لمتابعة عقد إيجارك ومواعيد الدفعات' : 'لمتابعة عقاراتك وعقودها';
  const text = [
    `مرحباً، يدعوك ${officeName} ${what} في تطبيق عقدي.`,
    `رمز الدعوة: ${code}`,
    `ادخل من هنا واكتب الرمز: ${baseUrl}/join`,
  ].join('\n');
  const to = phone && /^9665\d{8}$/.test(phone) ? phone : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

/**
 * Brute-force guard for typed codes: at most 5 wrong attempts per IP per 15
 * minutes and 10 per phone per hour. Over the limit the answer is
 * { ok: false, reason: 'rate_limited', retryAfterSec } without a lookup.
 */
function createInviteGuard({
  ipLimit = { windowMs: 15 * 60 * 1000, max: 5 },
  phoneLimit = { windowMs: 60 * 60 * 1000, max: 10 },
} = {}) {
  const byIp = createCounter(ipLimit);
  const byPhone = createCounter(phoneLimit);

  return {
    async check(pool, input, { ip, phone } = {}) {
      const wait = Math.max(ip ? byIp.retryAfter(ip) : 0, phone ? byPhone.retryAfter(phone) : 0);
      if (wait > 0) return { ok: false, reason: 'rate_limited', retryAfterSec: wait };
      const result = await validateInviteCode(pool, input);
      if (!result.ok) {
        if (ip) byIp.hit(ip);
        if (phone) byPhone.hit(phone);
      }
      return result;
    },
    reset() {
      byIp.reset();
      byPhone.reset();
    },
  };
}

module.exports = {
  REASONS,
  normalizeCode,
  inviteStatus,
  createLandlordInvite,
  revokeInvite,
  revokeActiveInvites,
  latestLandlordInvite,
  createTenantInvite,
  revokeTenantInvite,
  revokeActiveTenantInvites,
  latestTenantInvite,
  validateInviteCode,
  markInviteUsed,
  inviteShareLink,
  createInviteGuard,
  inviteGuard: createInviteGuard(),
};
