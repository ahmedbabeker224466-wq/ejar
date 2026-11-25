'use strict';

// Office ratings (owner's decision, Nov 2026). Only people linked to the office
// may rate it: a tenant of one of its contracts (contract_members) or a joined
// landlord (landlords.user_id). One review per person per office, which they may
// change. Stars count at once; a short comment is shown publicly only after the
// platform admin approves it. Public pages never show who wrote a review, only
// "مستأجر" or "مالك" and the month.
//
// Ranking: listings are ordered by a smoothed score so one 5-star review does
// not beat many good ones: (sum + PRIOR_WEIGHT * PRIOR_MEAN) / (count + PRIOR_WEIGHT).

const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { cleanText, findContact, contactMessage } = require('./publicText');
const { landlordLinks, tenantLinks } = require('./memberships');

const COMMENT_MAX = 300;
const PRIOR_MEAN = 3;
const PRIOR_WEIGHT = 3;
const ROLE_LABELS = { tenant: 'مستأجر', landlord: 'مالك' };
const COMMENT_STATUS = { none: 'بلا تعليق', pending: 'بانتظار المراجعة', approved: 'منشور', rejected: 'مرفوض' };

/** Pure: the smoothed score used for ranking (an office without reviews gets PRIOR_MEAN). */
function score(sum, count) {
  return (Number(sum || 0) + PRIOR_WEIGHT * PRIOR_MEAN) / (Number(count || 0) + PRIOR_WEIGHT);
}

/** SQL expression of the same score for a listing row `l` (used in ORDER BY). */
const SCORE_SQL = `((SELECT COALESCE(SUM(rv.rating), 0) FROM office_reviews rv WHERE rv.office_id = l.office_id) + ${PRIOR_WEIGHT * PRIOR_MEAN})
  / ((SELECT COUNT(*) FROM office_reviews rv WHERE rv.office_id = l.office_id) + ${PRIOR_WEIGHT})`;

/** Columns added to public listing queries: the office's average and count. */
const RATING_COLUMNS = `(SELECT ROUND(AVG(rv.rating), 1) FROM office_reviews rv WHERE rv.office_id = l.office_id) AS office_rating,
  (SELECT COUNT(*) FROM office_reviews rv WHERE rv.office_id = l.office_id) AS office_rating_count`;

/** Pure: checks the form. Returns { values, errors }. */
function validate(body = {}) {
  const errors = {};
  const values = {};
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'اختر عدد النجوم من 1 إلى 5.';
  else values.rating = rating;
  values.comment = cleanText(body.comment, COMMENT_MAX + 1, { multiline: true });
  if (values.comment.length > COMMENT_MAX) errors.comment = `التعليق ${COMMENT_MAX} حرف كحد أقصى.`;
  else {
    const kind = findContact(values.comment);
    if (kind) errors.comment = contactMessage(kind);
  }
  return { values, errors };
}

/**
 * The offices this user may rate, from their own links only: [{ officeId, officeName, role }].
 * A person who is both tenant and landlord of one office rates it once (as landlord).
 */
async function eligibleOffices(pool, userId) {
  const [landlord, tenant] = await Promise.all([landlordLinks(pool, userId), tenantLinks(pool, userId)]);
  const byOffice = new Map();
  for (const t of tenant) byOffice.set(t.office_id, { officeId: t.office_id, officeName: t.office_name, role: 'tenant' });
  for (const l of landlord) byOffice.set(l.office_id, { officeId: l.office_id, officeName: l.office_name, role: 'landlord' });
  return [...byOffice.values()];
}

/** The user's own reviews keyed by office id. */
async function ownReviews(pool, userId, officeIds) {
  if (!officeIds.length) return {};
  const [rows] = await pool.query(
    'SELECT office_id, rating, comment, comment_status, updated_at FROM office_reviews WHERE user_id = ? AND office_id IN (?)',
    [userId, officeIds],
  );
  return Object.fromEntries(rows.map((r) => [Number(r.office_id), r]));
}

/**
 * Saves (creates or changes) the user's review of an office they are linked to.
 * The office id comes from the form but must be one of the user's own links.
 * Returns { ok, created, commentPending } or { ok: false, error: 'not_eligible' | 'invalid', errors }.
 */
async function save(pool, { userId, officeId, body, ip = null }) {
  const eligible = (await eligibleOffices(pool, userId)).find((o) => o.officeId === Number(officeId));
  if (!eligible) return { ok: false, error: 'not_eligible' };
  const { values, errors } = validate(body);
  if (Object.keys(errors).length) return { ok: false, error: 'invalid', errors, values };
  const scoped = scopeToOffice(pool, eligible.officeId);
  const [existing] = await scoped.query('SELECT id, comment FROM office_reviews WHERE office_id = :office_id AND user_id = ?', [userId]);
  const comment = values.comment || null;
  // An unchanged approved comment stays approved; a new or changed one waits for review.
  const status = !comment ? 'none' : existing && existing.comment === comment ? null : 'pending';
  if (existing) {
    await scoped.query(
      `UPDATE office_reviews SET rating = ?, role = ?, comment = ?${status ? ', comment_status = ?, moderated_by = NULL, moderated_at = NULL' : ''}
        WHERE id = ? AND office_id = :office_id`,
      status ? [values.rating, eligible.role, comment, status, existing.id] : [values.rating, eligible.role, comment, existing.id],
    );
  } else {
    await scoped.insert('office_reviews', { user_id: userId, role: eligible.role, rating: values.rating, comment, comment_status: status || 'none' });
  }
  await createAudit(pool).log(userId, eligible.officeId, existing ? 'review.update' : 'review.create', 'office', eligible.officeId, null,
    { rating: values.rating, comment: Boolean(comment) }, ip);
  if (status === 'pending') {
    await require('./platformNotify').notifyPlatformAdmins(pool, {
      kind: 'review_pending',
      title: 'تعليق تقييم بانتظار المراجعة',
      body: 'وصل تعليق جديد على تقييم مكتب. راجعه قبل نشره.',
      link: '/admin/reviews',
      dedupeKey: `review_pending:o${eligible.officeId}:u${userId}:${Date.now()}`,
    });
  }
  return { ok: true, created: !existing, commentPending: status === 'pending' };
}

/** Public summary of an office: { avg, count } (avg null without reviews). */
async function summary(pool, officeId) {
  const [[row]] = await pool.query('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM office_reviews WHERE office_id = ?', [officeId]);
  return { avg: row.avg === null ? null : Number(row.avg), count: Number(row.n) };
}

/** Approved comments for the office's public page, newest first. No names: role and month only. */
async function publicComments(pool, officeId, limit = 10) {
  const [rows] = await pool.query(
    `SELECT rating, comment, role, updated_at FROM office_reviews
      WHERE office_id = ? AND comment_status = 'approved' AND comment IS NOT NULL
      ORDER BY updated_at DESC, id DESC LIMIT ${Number(limit)}`,
    [officeId],
  );
  return rows.map((r) => ({ rating: Number(r.rating), comment: r.comment, role: r.role, month: new Date(r.updated_at).toISOString().slice(0, 7) }));
}

// ------------------------------------------------------------ admin moderation

async function pendingList(pool, limit = 100) {
  const [rows] = await pool.query(
    `SELECT r.id, r.office_id, r.rating, r.comment, r.role, r.updated_at, o.name AS office_name
       FROM office_reviews r JOIN offices o ON o.id = r.office_id
      WHERE r.comment_status = 'pending' ORDER BY r.updated_at ASC LIMIT ${Number(limit)}`,
  );
  return rows;
}

async function pendingCount(pool) {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM office_reviews WHERE comment_status = 'pending'");
  return Number(row.n);
}

/** Approves or rejects a pending comment (the stars always count). Returns true when it changed. */
async function moderate(pool, { id, decision, adminId, reason, ip = null }) {
  if (!['approved', 'rejected'].includes(decision) || !/^\d+$/.test(String(id))) return false;
  const [[row]] = await pool.query("SELECT id, office_id FROM office_reviews WHERE id = ? AND comment_status = 'pending'", [id]);
  if (!row) return false;
  const scoped = scopeToOffice(pool, Number(row.office_id));
  const result = await scoped.query(
    "UPDATE office_reviews SET comment_status = ?, moderated_by = ?, moderated_at = UTC_TIMESTAMP() WHERE id = ? AND office_id = :office_id AND comment_status = 'pending'",
    [decision, adminId, row.id],
  );
  if (result.affectedRows !== 1) return false;
  await createAudit(pool).log(adminId, Number(row.office_id), `admin.review.${decision === 'approved' ? 'approve' : 'reject'}`, 'office_review', Number(row.id), null, { reason }, ip);
  return true;
}

module.exports = {
  COMMENT_MAX,
  PRIOR_MEAN,
  PRIOR_WEIGHT,
  ROLE_LABELS,
  COMMENT_STATUS,
  SCORE_SQL,
  RATING_COLUMNS,
  score,
  validate,
  eligibleOffices,
  ownReviews,
  save,
  summary,
  publicComments,
  pendingList,
  pendingCount,
  moderate,
};
