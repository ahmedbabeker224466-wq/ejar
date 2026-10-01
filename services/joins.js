'use strict';

// Joining with an invite code (landlord or tenant). The code is looked up
// across offices on purpose: the person joining has no office yet. Every
// write after that is scoped to the invite's office.
//
// Consumption is atomic: one transaction locks the user row and the invite
// row (SELECT ... FOR UPDATE), checks everything, then links the person and
// marks the invite used. Two simultaneous joins with the same code: exactly
// one succeeds.

const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createAudit } = require('./audit');
const { normalizeCode, inviteStatus } = require('./invites');
const { createCounter } = require('../middleware/rateLimit');

// Office accounts and the platform admin never become landlords or tenants.
const OFFICE_ROLES = new Set(['platform_admin', 'office_owner', 'office_manager', 'office_staff']);
const JOINABLE = new Set(['landlord', 'tenant']);

// One message for every bad code: never says whether it exists, expired,
// was used, was revoked or belongs to another kind.
const MESSAGES = {
  invalid: 'الرمز غير صحيح أو انتهت صلاحيته أو استُخدم من قبل. تأكد منه أو اطلب رمزاً جديداً من المكتب.',
  office_user: 'حسابك حساب مكتب عقار، فلا يمكن ربطه كمالك أو مستأجر. استخدم رقم جوال آخر للانضمام.',
  rate_limited: 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.',
};

// Join attempts: 5 per user per 10 minutes and 20 per IP per hour (in memory,
// per process). Every attempt counts, right or wrong.
function createJoinGuard({ userLimit = { windowMs: 10 * 60 * 1000, max: 5 }, ipLimit = { windowMs: 60 * 60 * 1000, max: 20 } } = {}) {
  const byUser = createCounter(userLimit);
  const byIp = createCounter(ipLimit);
  return {
    /** Seconds to wait (0 = allowed). Records the attempt when allowed. */
    attempt({ userId, ip }) {
      const wait = Math.max(byUser.retryAfter(String(userId)), ip ? byIp.retryAfter(ip) : 0);
      if (wait > 0) return wait;
      byUser.hit(String(userId));
      if (ip) byIp.hit(ip);
      return 0;
    },
    reset() {
      byUser.reset();
      byIp.reset();
    },
  };
}
const joinGuard = createJoinGuard();

class JoinRefused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Redeems a code for a user. Returns { ok: true, kind, officeId } or
 * { ok: false, reason } with reason 'invalid' | 'office_user'.
 */
async function joinWithCode(pool, { userId, code: input, ip = null, now = new Date() }) {
  const code = normalizeCode(input);
  if (!code) return { ok: false, reason: 'invalid' };
  try {
    return await withTransaction(pool, async (conn) => {
      const [[user]] = await conn.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!user) throw new JoinRefused('invalid');
      if (OFFICE_ROLES.has(user.role)) throw new JoinRefused('office_user');

      const [[invite]] = await conn.query('SELECT * FROM invites WHERE code = ? FOR UPDATE', [code]);
      if (!invite || invite.code !== code || !JOINABLE.has(invite.kind) || inviteStatus(invite, now) !== 'active') {
        throw new JoinRefused('invalid');
      }
      const scoped = scopeToOffice(conn, invite.office_id);

      if (invite.kind === 'landlord') {
        const [landlord] = await scoped.query(
          'SELECT id, user_id, is_active FROM landlords WHERE id = ? AND office_id = :office_id FOR UPDATE',
          [invite.landlord_id],
        );
        if (!landlord || !landlord.is_active || (landlord.user_id && Number(landlord.user_id) !== Number(userId))) {
          throw new JoinRefused('invalid');
        }
      } else {
        // A code from before a renewal joins the current contract of the chain.
        let [contract] = await scoped.query(
          'SELECT id, status, renewed_to_id FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE',
          [invite.contract_id],
        );
        for (let hops = 0; contract && contract.status === 'renewed' && contract.renewed_to_id && hops < 20; hops += 1) {
          [contract] = await scoped.query(
            'SELECT id, status, renewed_to_id FROM contracts WHERE id = ? AND office_id = :office_id FOR UPDATE',
            [contract.renewed_to_id],
          );
        }
        if (!contract || ['terminated', 'renewed'].includes(contract.status)) throw new JoinRefused('invalid');
        invite.joinContractId = Number(contract.id);
      }

      // Every check passed with the rows locked: now write.
      const used = await scoped.query(
        `UPDATE invites SET used_at = UTC_TIMESTAMP(), used_by = ?
          WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND office_id = :office_id`,
        [userId, invite.id],
      );
      if (used.affectedRows !== 1) throw new JoinRefused('invalid');

      if (invite.kind === 'landlord') {
        await scoped.query('UPDATE landlords SET user_id = ? WHERE id = ? AND office_id = :office_id', [userId, invite.landlord_id]);
      } else {
        await scoped.query(
          `INSERT IGNORE INTO contract_members (contract_id, user_id, role)
           SELECT id, ?, 'tenant' FROM contracts WHERE id = ? AND office_id = :office_id`,
          [userId, invite.joinContractId],
        );
        await scoped.insert('contract_events', {
          contract_id: invite.joinContractId, actor_id: userId, event_type: 'tenant_joined', details: null,
        });
      }
      // A person with no role yet takes the invite's role; someone who is
      // already a landlord or tenant keeps it and gains one more link.
      if (user.role === null) {
        await conn.query('UPDATE users SET role = ? WHERE id = ? AND role IS NULL', [invite.kind, userId]);
      }
      await createAudit(conn).write(userId, invite.office_id, 'invite.use', 'invite', invite.id, null, {
        kind: invite.kind,
        ...(invite.landlord_id ? { landlord_id: invite.landlord_id } : {}),
        ...(invite.contract_id ? { contract_id: invite.contract_id } : {}),
      }, ip);
      return { ok: true, kind: invite.kind, officeId: Number(invite.office_id) };
    });
  } catch (err) {
    if (err instanceof JoinRefused) return { ok: false, reason: err.reason };
    throw err;
  }
}

module.exports = { joinWithCode, joinGuard, createJoinGuard, MESSAGES, OFFICE_ROLES };
