'use strict';

// Read models and actions for the platform admin area (/admin). Every query
// here deliberately spans offices (this is the platform view), and none of
// them reads contract party data: only counts, plans, dates and money.
// The reason rules and the audit rows live in routes/admin.js.

const money = require('./money');
const pricing = require('./pricing');
const plans = require('./plans');
const subscriptions = require('./subscriptions');
const { scopeToOffice } = require('./scopeToOffice');
const { riyadhMonth, riyadhMidnight, hoursAfter } = require('./contractDates');

const PAGE_SIZE = 20;
const OFFICE_STATUSES = ['trial', 'active', 'past_due', 'suspended'];
const ORDER_STATUSES = ['pending', 'paid', 'failed', 'expired'];

function clampPage(value, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { page: Math.min(Math.max(1, Number(value) || 1), pages), pages };
}

// ------------------------------------------------------------ overview

/** The dashboard cards. Money in halalas. */
async function overview(pool, now = new Date()) {
  const month = riyadhMonth(now);
  const monthStart = riyadhMidnight(`${month}-01`);
  const weekAgo = hoursAfter(now, -7 * 24);

  const [statusRows] = await pool.query('SELECT status, COUNT(*) AS n FROM offices GROUP BY status');
  const byStatus = Object.fromEntries(OFFICE_STATUSES.map((s) => [s, 0]));
  for (const row of statusRows) byStatus[row.status] = Number(row.n);
  const [[trialOver]] = await pool.query("SELECT COUNT(*) AS n FROM offices WHERE status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at <= ?)", [now]);

  // MRR: what the active paid subscriptions bring per month (VAT-exclusive).
  const [paid] = await pool.query(
    `SELECT s.price, s.billing_interval FROM subscriptions s JOIN offices o ON o.id = s.office_id
      WHERE s.status = 'active' AND o.status = 'active' AND s.period_end > ?`,
    [now],
  );
  const mrr = paid.reduce((sum, r) => {
    const price = money.fromDecimal(r.price);
    return sum + (r.billing_interval === 'yearly' ? pricing.divRound(price, 12) : price);
  }, 0);

  const [[newOffices]] = await pool.query('SELECT COUNT(*) AS n FROM offices WHERE created_at >= ?', [monthStart]);
  const [[contracts]] = await pool.query('SELECT COUNT(*) AS n FROM contracts');
  const [deliveries] = await pool.query('SELECT status, COUNT(*) AS n FROM delivery_log WHERE created_at >= ? GROUP BY status', [weekAgo]);
  const sent = Object.fromEntries(deliveries.map((r) => [r.status, Number(r.n)]));
  const [[notes]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ?', [weekAgo]);
  const [[ai]] = await pool.query('SELECT COALESCE(SUM(`count`), 0) AS n FROM ai_reads_usage WHERE month = ?', [month]);
  const [[transfers]] = await pool.query("SELECT COUNT(*) AS n FROM bank_transfers WHERE status = 'pending'");
  const [[suspicious]] = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE suspicious = 1');

  return {
    byStatus,
    trialOver: Number(trialOver.n),
    totalOffices: Object.values(byStatus).reduce((a, b) => a + b, 0),
    mrr,
    newOffices: Number(newOffices.n),
    contracts: Number(contracts.n),
    notifications: Number(notes.n),
    deliveries: { sent: sent.sent || 0, failed: sent.failed || 0, pending: sent.pending || 0, skipped: sent.skipped || 0 },
    aiReads: Number(ai.n),
    pendingTransfers: Number(transfers.n),
    suspiciousOrders: Number(suspicious.n),
    month,
  };
}

// ------------------------------------------------------------ offices

/** One page of offices: search by name or phone, filter by status. */
async function listOffices(pool, { q = '', status = '', page = 1 } = {}) {
  const where = [];
  const params = [];
  const term = String(q || '').trim().slice(0, 60);
  if (term) {
    where.push('(o.name LIKE ? OR o.phone LIKE ?)');
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (OFFICE_STATUSES.includes(status)) {
    where.push('o.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM offices o ${clause}`, params);
  const total = Number(n);
  const { page: current, pages } = clampPage(page, total);
  const [rows] = await pool.query(
    `SELECT o.id, o.name, o.city, o.phone, o.status, o.trial_ends_at, o.subscription_ends_at, o.created_at, p.name_ar AS plan_name,
            (SELECT COUNT(*) FROM units u WHERE u.office_id = o.id) AS units,
            (SELECT COUNT(*) FROM contracts c WHERE c.office_id = o.id) AS contracts
       FROM offices o LEFT JOIN plans p ON p.id = o.plan_id ${clause}
      ORDER BY o.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return { rows, total, page: current, pages };
}

/** Everything the office detail page shows: no landlord, tenant or contract content. */
async function officeDetail(pool, officeId, now = new Date()) {
  if (!/^\d+$/.test(String(officeId))) return null;
  const [[office]] = await pool.query(
    `SELECT o.id, o.name, o.city, o.phone, o.email, o.status, o.plan_id, o.trial_ends_at, o.subscription_ends_at, o.created_at, p.name_ar AS plan_name
       FROM offices o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?`,
    [officeId],
  );
  if (!office) return null;
  const id = Number(office.id);
  const scoped = scopeToOffice(pool, id);
  const [[activity]] = await pool.query(
    `SELECT MAX(u.last_seen_at) AS last_seen FROM office_members m JOIN users u ON u.id = m.user_id WHERE m.office_id = ?`,
    [id],
  );
  const [members] = await pool.query(
    `SELECT m.role, m.is_active FROM office_members m WHERE m.office_id = ? ORDER BY m.id`,
    [id],
  );
  const subs = await scoped.query(
    `SELECT s.id, s.status, s.billing_interval, s.period_start, s.period_end, s.price, s.ended_reason, p.name_ar AS plan_name
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.office_id = :office_id ORDER BY s.id DESC LIMIT 10`,
  );
  const officeOrders = await scoped.query(
    `SELECT id, plan_code, billing_interval, method, status, suspicious, total, currency, created_at
       FROM orders WHERE office_id = :office_id ORDER BY id DESC LIMIT 10`,
  );
  const notes = await scoped.query(
    `SELECT n.id, n.body, n.created_at, u.phone AS author_phone FROM internal_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.office_id = :office_id AND n.entity_type = 'office' ORDER BY n.id DESC LIMIT 20`,
  );
  const [audit] = await pool.query(
    `SELECT a.action, a.created_at, u.phone AS actor_phone FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.office_id = ? AND a.action LIKE 'admin.%' ORDER BY a.id DESC LIMIT 15`,
    [id],
  );
  return {
    office,
    usage: plans.usageRows(office.plan_id ? await plans.getPlan(pool, office.plan_id) : null, await plans.usageFor(pool, id, now)),
    lastSeen: activity ? activity.last_seen : null,
    members: { active: members.filter((m) => m.is_active).length, total: members.length },
    adminSuspended: await subscriptions.isAdminSuspended(pool, id),
    subscriptions: subs,
    orders: officeOrders,
    notes,
    audit,
  };
}

async function addNote(pool, { officeId, authorId, body }) {
  const scoped = scopeToOffice(pool, officeId);
  return scoped.insert('internal_notes', { entity_type: 'office', entity_id: officeId, author_id: authorId, body });
}

// ------------------------------------------------------------ orders and payments

async function listOrders(pool, { status = '', method = '', suspicious = false, page = 1 } = {}) {
  const where = [];
  const params = [];
  if (ORDER_STATUSES.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (['moyasar', 'bank_transfer'].includes(method)) {
    where.push('r.method = ?');
    params.push(method);
  }
  if (suspicious) where.push('r.suspicious = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM orders r ${clause}`, params);
  const total = Number(n);
  const { page: current, pages } = clampPage(page, total);
  const [rows] = await pool.query(
    `SELECT r.id, r.office_id, o.name AS office_name, r.plan_code, r.billing_interval, r.method, r.status, r.suspicious, r.fail_reason,
            r.total, r.currency, r.promo_code, r.created_at, r.invoice_id
       FROM orders r JOIN offices o ON o.id = r.office_id ${clause}
      ORDER BY r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return { rows, total, page: current, pages };
}

async function recentPayments(pool, limit = 30) {
  const [rows] = await pool.query(
    `SELECT p.id, p.office_id, o.name AS office_name, p.provider, p.provider_ref, p.amount, p.currency, p.status, p.card_last4, p.created_at
       FROM platform_payments p JOIN offices o ON o.id = p.office_id ORDER BY p.id DESC LIMIT ${Number(limit)}`,
  );
  return rows;
}

async function recentInvoices(pool, limit = 30) {
  const [rows] = await pool.query(
    `SELECT i.id, i.office_id, o.name AS office_name, i.kind, i.status, i.invoice_no, i.doc_title, i.total, i.currency, i.issued_at
       FROM subscription_invoices i JOIN offices o ON o.id = i.office_id ORDER BY i.id DESC LIMIT ${Number(limit)}`,
  );
  return rows;
}

// ------------------------------------------------------------ audit viewer

/**
 * One page of the audit trail with filters. The values stored in before/after
 * are shown as names only for admin rows; this list shows who, what and when.
 */
async function listAudit(pool, { action = '', officeId = '', actor = '', from = '', to = '', page = 1 } = {}) {
  const where = [];
  const params = [];
  const act = String(action || '').trim().slice(0, 60);
  if (act) {
    where.push('a.action LIKE ?');
    params.push(`${act.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (/^\d+$/.test(String(officeId))) {
    where.push('a.office_id = ?');
    params.push(Number(officeId));
  }
  const actorPhone = String(actor || '').replace(/\D/g, '');
  if (actorPhone) {
    where.push('u.phone LIKE ?');
    params.push(`%${actorPhone}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    where.push('a.created_at >= ?');
    params.push(riyadhMidnight(from));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    const end = riyadhMidnight(to);
    where.push('a.created_at < ?');
    params.push(new Date(end.getTime() + 24 * 60 * 60 * 1000));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ${clause}`, params);
  const total = Number(n);
  const { page: current, pages } = clampPage(page, total);
  const [rows] = await pool.query(
    `SELECT a.id, a.office_id, a.action, a.entity_type, a.entity_id, a.after_json, a.created_at, u.phone AS actor_phone, o.name AS office_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN offices o ON o.id = a.office_id ${clause}
      ORDER BY a.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
    params,
  );
  return { rows, total, page: current, pages };
}

module.exports = {
  PAGE_SIZE,
  OFFICE_STATUSES,
  ORDER_STATUSES,
  overview,
  listOffices,
  officeDetail,
  addNote,
  listOrders,
  recentPayments,
  recentInvoices,
  listAudit,
};
