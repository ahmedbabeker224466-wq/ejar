'use strict';

// The office's tenants page (/office/tenants): one row per contract that is
// not superseded by a renewal, with the tenant nickname, the unit, the
// contract stage and whether the tenant joined, was invited or not yet.
// Nicknames only: the tenant label typed by the office, never a legal name.
// Every query goes through scopeToOffice().

const { scopeToOffice } = require('./scopeToOffice');

const PAGE_SIZE = 20;
const STATUSES = ['joined', 'invited', 'not_invited'];
const STATUS_LABELS = { joined: 'انضم', invited: 'مدعو', not_invited: 'غير مدعو' };

const JOINED = `EXISTS (SELECT 1 FROM contract_members cm
  WHERE cm.contract_id = c.id AND cm.role = 'tenant')`;
// Active invite = unused, unrevoked, unexpired.
const ACTIVE_INVITE = `EXISTS (SELECT 1 FROM invites i
  WHERE i.contract_id = c.id AND i.kind = 'tenant' AND i.office_id = :office_id
    AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > UTC_TIMESTAMP())`;

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function joinStatus(row) {
  if (Number(row.joined)) return 'joined';
  return Number(row.invited) ? 'invited' : 'not_invited';
}

/**
 * Lists the office's tenants: { rows, total, page, pages }. Filters: q
 * (tenant nickname, unit label or contract number) and status
 * (joined | invited | not_invited). Renewed contracts are left out: their
 * tenant continues on the renewal, which is listed instead.
 */
async function listTenants(pool, officeId, { q = '', status = '', page = 1 } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const where = ["c.status <> 'renewed'"];
  const params = [];

  const search = String(q || '').trim().slice(0, 60);
  if (search) {
    const like = `%${escapeLike(search)}%`;
    where.push('(c.tenant_label LIKE ? OR u.label LIKE ? OR c.contract_number LIKE ?)');
    params.push(like, like, like);
  }
  if (status === 'joined') where.push(JOINED);
  if (status === 'invited') where.push(`NOT ${JOINED} AND ${ACTIVE_INVITE}`);
  if (status === 'not_invited') where.push(`NOT ${JOINED} AND NOT ${ACTIVE_INVITE}`);
  const filter = where.join(' AND ');
  const from = `FROM contracts c LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE c.office_id = :office_id AND ${filter}`;

  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n ${from}`, params);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);

  const rows = await scoped.query(
    `SELECT c.id, c.tenant_label, c.contract_number, c.status,
            c.unit_id, u.label AS unit_label,
            ${JOINED} AS joined, ${ACTIVE_INVITE} AS invited
       ${from}
      ORDER BY FIELD(c.status, 'urgent', 'deadline_passed', 'soon', 'calm', 'ended', 'terminated'), c.end_date ASC, c.id ASC
      LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return {
    rows: rows.map((r) => {
      const joined = joinStatus(r);
      return {
        id: Number(r.id),
        tenantLabel: r.tenant_label,
        contractNumber: r.contract_number,
        stage: r.status,
        unitId: r.unit_id === null ? null : Number(r.unit_id),
        unitLabel: r.unit_label,
        joinStatus: joined,
        joinLabel: STATUS_LABELS[joined],
      };
    }),
    total,
    page: current,
    pages,
  };
}

module.exports = { listTenants, PAGE_SIZE, STATUSES, STATUS_LABELS };
