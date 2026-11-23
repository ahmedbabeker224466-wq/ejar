'use strict';

// The licence check of a new office. A new office starts with verification
// 'pending' and sees only the "under review" page (services/offices.js
// officeAccess) until the platform admin compares its FAL licence and
// commercial registration with the official inquiry service and approves or
// rejects it. Approval starts the free trial on that day. Notifications carry
// the office name only, never the licence numbers.

const { withTransaction } = require('./transaction');
const { scopeToOffice } = require('./scopeToOffice');
const { createNotification } = require('./notifications');
const { notifyPlatformAdmins } = require('./platformNotify');
const { createAudit } = require('./audit');
const contractDates = require('./contractDates');

// The public FAL licence inquiry of the Real Estate General Authority (opened by the admin in a new tab).
const FAL_INQUIRY_URL = 'https://rega.gov.sa/rega-services/real-estate-inquiries/';

class ReviewError extends Error {
  constructor(reason) {
    super(`Office review refused: ${reason}`);
    this.name = 'ReviewError';
    this.reason = reason;
  }
}

/** Tells every platform admin that a new office waits for the check. */
async function notifyNewOffice(pool, officeId) {
  const [[office]] = await pool.query('SELECT id, name FROM offices WHERE id = ?', [officeId]);
  if (!office) return 0;
  return notifyPlatformAdmins(pool, {
    kind: 'office_review',
    title: 'مكتب جديد بانتظار المراجعة',
    body: `مكتب جديد بانتظار مراجعة الرخصة: ${office.name}`,
    link: `/admin/offices/${office.id}`,
    dedupeKey: `office_review:o${office.id}`,
    urgent: true,
  });
}

async function pendingCount(pool) {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM offices WHERE verification = 'pending'");
  return Number(row.n);
}

async function lockOffice(conn, officeId) {
  const [[office]] = await conn.query(
    'SELECT id, name, status, owner_id, verification, trial_ends_at FROM offices WHERE id = ? FOR UPDATE',
    [officeId],
  );
  if (!office) throw new ReviewError('no_office');
  return office;
}

/** Approves the office (from pending or rejected). The free trial starts now. */
async function approve(pool, { officeId, adminId, reason, ip, now = new Date() }) {
  const office = await withTransaction(pool, async (conn) => {
    const row = await lockOffice(conn, officeId);
    if (row.verification === 'approved') throw new ReviewError('already_approved');
    const scoped = scopeToOffice(conn, row.id);
    const trialEnd = contractDates.trialEndsAt(now);
    await conn.query(
      `UPDATE offices SET verification = 'approved', verification_note = NULL, verified_at = ?, verified_by = ?,
              trial_ends_at = IF(status = 'trial', ?, trial_ends_at)
        WHERE id = ?`,
      [now, adminId, trialEnd, row.id],
    );
    if (row.status === 'trial') {
      await scoped.query(
        "UPDATE subscriptions SET period_start = ?, period_end = ? WHERE office_id = :office_id AND status = 'trialing'",
        [now, trialEnd],
      );
    }
    await createAudit(conn).write(adminId, row.id, 'admin.office.verify', 'office', row.id,
      { verification: row.verification }, { verification: 'approved', reason }, ip);
    return row;
  });
  if (office.owner_id) {
    await createNotification(pool, {
      userId: office.owner_id,
      officeId: office.id,
      kind: 'office_verified',
      title: 'تمت الموافقة على مكتبك',
      body: 'تحققنا من بيانات مكتبك، وأصبح حسابك جاهزاً. بدأت الآن تجربتك المجانية لمدة 14 يوماً.',
      link: '/office',
      dedupeKey: `office_verified:o${office.id}:${now.getTime()}`,
      urgent: true,
    });
  }
  return office;
}

/** Rejects a pending office with a reason the owner will read. */
async function reject(pool, { officeId, adminId, reason, ip, now = new Date() }) {
  const office = await withTransaction(pool, async (conn) => {
    const row = await lockOffice(conn, officeId);
    if (row.verification !== 'pending') throw new ReviewError('not_pending');
    await conn.query(
      "UPDATE offices SET verification = 'rejected', verification_note = ?, verified_at = ?, verified_by = ? WHERE id = ?",
      [reason, now, adminId, row.id],
    );
    await createAudit(conn).write(adminId, row.id, 'admin.office.reject', 'office', row.id,
      { verification: row.verification }, { verification: 'rejected', reason }, ip);
    return row;
  });
  if (office.owner_id) {
    await createNotification(pool, {
      userId: office.owner_id,
      officeId: office.id,
      kind: 'office_verified',
      title: 'لم تتم الموافقة على مكتبك',
      body: 'راجعنا بيانات مكتبك ولم نتمكن من التحقق منها. ستجد السبب عند دخولك إلى حسابك.',
      link: '/office',
      dedupeKey: `office_rejected:o${office.id}:${now.getTime()}`,
      urgent: true,
    });
  }
  return office;
}

module.exports = { FAL_INQUIRY_URL, ReviewError, notifyNewOffice, pendingCount, approve, reject };
