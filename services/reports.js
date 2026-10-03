'use strict';

// Office reports and the landlord statement. Every query goes through
// scopeToOffice(); the office comes from loadOffice (office reports) or from
// the landlord's database links (statement). Amounts are integer halalas in
// code (SUM(ROUND(amount * 100)) in SQL) and shown with services/money.js.
// Reports hold nicknames (unit labels, building names, landlord labels, team
// display names), dates, counts and amounts only: no tenant labels, phones or
// notes. Date ranges are validated here, on the server.

const engine = require('./contractEngine');
const money = require('./money');
const team = require('./team');
const paymentEntries = require('./paymentEntries');
const { scopeToOffice } = require('./scopeToOffice');
const { addDays, addMonths } = require('./contractDates');

const MAX_RANGE_DAYS = 1100;
const MAX_ROWS = 5000;
const STATUS_LABELS = { due: 'مستحقة', paid: 'مدفوعة', late: 'متأخرة', waived: 'ملغاة', tenant_reported: 'أبلغ المستأجر بالدفع' };
const UNIT_LABELS = { vacant: 'شاغرة', rented: 'مؤجرة', maintenance: 'صيانة' };

// ------------------------------------------------------------ date range

/**
 * Reads ?from=&to= (YYYY-MM-DD). Default: the last 6 months up to today.
 * Returns { from, to, error }; on an invalid value the default range is used
 * and error says why.
 */
function parseRange(query = {}, today) {
  const fallback = { from: addMonths(`${today.slice(0, 7)}-01`, -5), to: today };
  const rawFrom = String(query.from || '').trim();
  const rawTo = String(query.to || '').trim();
  if (!rawFrom && !rawTo) return { ...fallback, error: null };
  const from = rawFrom || fallback.from;
  const to = rawTo || today;
  if (!engine.isValidDate(from) || !engine.isValidDate(to)) return { ...fallback, error: 'اختر تاريخين صحيحين.' };
  if (engine.isAfter(from, to)) return { ...fallback, error: 'تاريخ البداية بعد تاريخ النهاية.' };
  if (engine.daysUntil(from, to) > MAX_RANGE_DAYS) return { ...fallback, error: 'المدة طويلة جداً (3 سنوات كحد أقصى).' };
  return { from, to, error: null };
}

// ------------------------------------------------------------ office reports

async function occupancy(pool, officeId) {
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT b.id AS building_id, COALESCE(b.name, '') AS building, COUNT(u.id) AS total,
            COALESCE(SUM(u.status = 'rented'), 0) AS rented, COALESCE(SUM(u.status = 'vacant'), 0) AS vacant,
            COALESCE(SUM(u.status = 'maintenance'), 0) AS maintenance
       FROM units u LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id
      WHERE u.office_id = :office_id
      GROUP BY b.id, b.name ORDER BY (b.id IS NULL), b.name`,
  );
  const data = rows.map((r) => {
    const total = Number(r.total);
    const rented = Number(r.rented);
    return {
      building: r.building || 'بدون مبنى',
      total,
      rented,
      vacant: Number(r.vacant),
      maintenance: Number(r.maintenance),
      percent: total ? Math.round((rented / total) * 100) : 0,
    };
  });
  const sum = (k) => data.reduce((s, r) => s + r[k], 0);
  const totals = { total: sum('total'), rented: sum('rented'), vacant: sum('vacant'), maintenance: sum('maintenance') };
  totals.percent = totals.total ? Math.round((totals.rented / totals.total) * 100) : 0;
  return {
    data,
    totals,
    headers: ['المبنى', 'عدد الوحدات', 'مؤجرة', 'شاغرة', 'تحت الصيانة', 'نسبة الإشغال %'],
    csvRows: data.map((r) => [r.building, r.total, r.rented, r.vacant, r.maintenance, r.percent]),
  };
}

const BUCKETS = [{ key: 30, label: 'خلال 30 يوماً' }, { key: 60, label: '31 إلى 60 يوماً' }, { key: 90, label: '61 إلى 90 يوماً' }];

/** Running contracts ending within 90 days, in 30 / 60 / 90 day groups. */
async function expiring(pool, officeId, { today }) {
  const last = addDays(today, 90);
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT c.id, c.end_date, u.label AS unit_label, l.label AS landlord_label
       FROM contracts c
       LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
       LEFT JOIN landlords l ON l.id = c.landlord_id AND l.office_id = :office_id
      WHERE c.office_id = :office_id AND c.status IN (?) AND c.end_date >= ? AND c.end_date <= ?
      ORDER BY c.end_date, c.id LIMIT ${MAX_ROWS}`,
    [engine.LIVE_STAGES, today, last],
  );
  const data = rows.map((r) => {
    const end = String(r.end_date).slice(0, 10);
    const days = engine.daysUntil(today, end);
    return { id: Number(r.id), unit: r.unit_label || '', landlord: r.landlord_label || '', end, days, bucket: days <= 30 ? 30 : days <= 60 ? 60 : 90 };
  });
  const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, data.filter((r) => r.bucket === b.key).length]));
  return {
    data,
    counts,
    headers: ['الوحدة', 'المالك', 'تاريخ النهاية', 'الأيام المتبقية', 'المجموعة'],
    csvRows: data.map((r) => [r.unit, r.landlord, r.end, r.days, BUCKETS.find((b) => b.key === r.bucket).label]),
  };
}

async function overdue(pool, officeId, { today, range }) {
  const filters = { landlordId: null, q: '', minDays: null, from: range.from, to: range.to };
  const rows = await paymentEntries.overdueAll(pool, officeId, { today, filters, limit: MAX_ROWS });
  const remaining = rows.reduce((s, r) => s + r.remainingHalalas, 0);
  return {
    data: rows,
    totals: { count: rows.length, remaining },
    headers: ['الوحدة', 'المالك', 'تاريخ الاستحقاق', 'أيام التأخر', 'المبلغ', 'المدفوع', 'المتبقي'],
    csvRows: rows.map((r) => [r.unit_label, r.landlord_label, String(r.due_date).slice(0, 10), r.daysOverdue,
      money.toDecimal(r.totalHalalas), money.toDecimal(r.paidHalalas), money.toDecimal(r.remainingHalalas)]),
  };
}

/** Expected (installments due in the month) vs collected (payments received in the month). */
async function collections(pool, officeId, { range }) {
  const scoped = scopeToOffice(pool, officeId);
  const expected = await scoped.query(
    `SELECT DATE_FORMAT(due_date, '%Y-%m') AS month, COALESCE(SUM(ROUND(amount * 100)), 0) AS h
       FROM contract_payments WHERE office_id = :office_id AND status <> 'waived' AND due_date BETWEEN ? AND ?
      GROUP BY month`,
    [range.from, range.to],
  );
  const collected = await scoped.query(
    `SELECT DATE_FORMAT(paid_on, '%Y-%m') AS month, COALESCE(SUM(ROUND(amount * 100)), 0) AS h
       FROM payment_entries WHERE office_id = :office_id AND undone_at IS NULL AND paid_on BETWEEN ? AND ?
      GROUP BY month`,
    [range.from, range.to],
  );
  const months = new Map();
  const slot = (month) => {
    if (!months.has(month)) months.set(month, { month, expected: 0, collected: 0 });
    return months.get(month);
  };
  for (const r of expected) slot(r.month).expected = Number(r.h);
  for (const r of collected) slot(r.month).collected = Number(r.h);
  const data = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
    ...m,
    percent: m.expected ? Math.round((m.collected / m.expected) * 100) : null,
  }));
  const totals = { expected: data.reduce((s, m) => s + m.expected, 0), collected: data.reduce((s, m) => s + m.collected, 0) };
  return {
    data,
    totals,
    headers: ['الشهر', 'المتوقع', 'المحصّل', 'نسبة التحصيل %'],
    csvRows: data.map((m) => [m.month, money.toDecimal(m.expected), money.toDecimal(m.collected), m.percent === null ? '' : m.percent]),
  };
}

const CREATED_DAY = "DATE(CONVERT_TZ(r.created_at, '+00:00', '+03:00'))";

/** Maintenance requests created in the range, by status and category. */
async function maintenance(pool, officeId, { range, categories, statuses }) {
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT r.status, r.category, COUNT(*) AS n FROM maintenance_requests r
      WHERE r.office_id = :office_id AND ${CREATED_DAY} BETWEEN ? AND ?
      GROUP BY r.status, r.category`,
    [range.from, range.to],
  );
  const matrix = {};
  for (const status of Object.keys(statuses)) matrix[status] = Object.fromEntries(Object.keys(categories).map((c) => [c, 0]));
  let other = 0;
  for (const r of rows) {
    if (matrix[r.status] && Object.hasOwn(matrix[r.status], r.category)) matrix[r.status][r.category] += Number(r.n);
    else other += Number(r.n);
  }
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  return {
    data: matrix,
    total,
    other,
    headers: ['الحالة', ...Object.values(categories), 'المجموع'],
    csvRows: Object.entries(statuses).map(([status, label]) => {
      const counts = Object.keys(categories).map((c) => matrix[status][c]);
      return [label, ...counts, counts.reduce((s, n) => s + n, 0)];
    }),
  };
}

/** Per active member: open and finished maintenance and tasks. */
async function workload(pool, officeId, { today, range }) {
  const scoped = scopeToOffice(pool, officeId);
  const members = await team.listMembers(pool, officeId, { activeOnly: true });
  const rows = await scoped.query(
    `SELECT m.user_id,
            (SELECT COUNT(*) FROM maintenance_requests r WHERE r.office_id = :office_id AND r.assigned_to = m.user_id AND r.status IN ('new','seen','in_progress')) AS maint_open,
            (SELECT COUNT(*) FROM maintenance_requests r WHERE r.office_id = :office_id AND r.assigned_to = m.user_id AND r.status = 'done'
                AND DATE(CONVERT_TZ(r.closed_at, '+00:00', '+03:00')) BETWEEN ? AND ?) AS maint_done,
            (SELECT COUNT(*) FROM office_tasks t WHERE t.office_id = :office_id AND t.assigned_to = m.user_id AND t.status IN ('todo','doing')) AS tasks_open,
            (SELECT COUNT(*) FROM office_tasks t WHERE t.office_id = :office_id AND t.assigned_to = m.user_id AND t.status IN ('todo','doing')
                AND t.due_date < ?) AS tasks_overdue,
            (SELECT COUNT(*) FROM office_tasks t WHERE t.office_id = :office_id AND t.assigned_to = m.user_id AND t.status = 'done'
                AND DATE(CONVERT_TZ(t.completed_at, '+00:00', '+03:00')) BETWEEN ? AND ?) AS tasks_done
       FROM office_members m WHERE m.office_id = :office_id AND m.is_active = 1`,
    [range.from, range.to, today, range.from, range.to],
  );
  const byUser = new Map(rows.map((r) => [Number(r.user_id), r]));
  const data = members.map((m) => {
    const r = byUser.get(m.user_id) || {};
    return {
      name: m.display,
      role: m.roleLabel,
      maintOpen: Number(r.maint_open || 0),
      maintDone: Number(r.maint_done || 0),
      tasksOpen: Number(r.tasks_open || 0),
      tasksOverdue: Number(r.tasks_overdue || 0),
      tasksDone: Number(r.tasks_done || 0),
    };
  });
  return {
    data,
    headers: ['العضو', 'الدور', 'صيانة مفتوحة', 'صيانة أُنجزت', 'مهام مفتوحة', 'مهام متأخرة', 'مهام أُنجزت'],
    csvRows: data.map((r) => [r.name, r.role, r.maintOpen, r.maintDone, r.tasksOpen, r.tasksOverdue, r.tasksDone]),
  };
}

const REPORTS = {
  occupancy: { title: 'الإشغال حسب المبنى', file: 'occupancy', load: (pool, officeId) => occupancy(pool, officeId) },
  expiring: { title: 'عقود تنتهي خلال 30 / 60 / 90 يوماً', file: 'expiring-contracts', load: expiring },
  overdue: { title: 'الدفعات المتأخرة', file: 'overdue-payments', load: overdue },
  collections: { title: 'المحصّل مقابل المتوقع شهرياً', file: 'collections', load: collections },
  maintenance: { title: 'الصيانة حسب الحالة والنوع', file: 'maintenance', load: maintenance },
  workload: { title: 'عبء عمل الفريق', file: 'staff-workload', load: workload },
};

/** Runs one report. ctx: { today, range, categories, statuses }. */
async function run(pool, officeId, name, ctx) {
  if (!Object.hasOwn(REPORTS, name)) return null;
  return REPORTS[name].load(pool, officeId, ctx);
}

// ------------------------------------------------------------ landlord statement

/**
 * The landlord's read-only statement: installments of THEIR contracts due in
 * the range, per office link. links come from services/memberships.js
 * (database, never request input).
 */
async function landlordStatement(pool, links, { today, range }) {
  const offices = [];
  for (const link of links) {
    const rows = await scopeToOffice(pool, link.office_id).query(
      `SELECT p.due_date, p.status, ROUND(p.amount * 100) AS amount_h, ROUND(p.paid_amount * 100) AS paid_h,
              u.label AS unit_label, c.id AS contract_id
         FROM contract_payments p
         JOIN contracts c ON c.id = p.contract_id
         LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
        WHERE p.office_id = :office_id AND c.office_id = :office_id AND c.landlord_id = ? AND p.status <> 'waived'
          AND p.due_date BETWEEN ? AND ?
        ORDER BY p.due_date, p.id LIMIT ${MAX_ROWS}`,
      [link.landlord_id, range.from, range.to],
    );
    const items = rows.map((r) => {
      const total = Number(r.amount_h);
      const paid = Number(r.paid_h);
      const due = String(r.due_date).slice(0, 10);
      return {
        unit: r.unit_label || '',
        due,
        total,
        paid,
        remaining: Math.max(0, total - paid),
        status: paid > 0 && paid < total && r.status !== 'paid' ? 'جزئية' : STATUS_LABELS[engine.paymentDisplayStatus({ status: r.status, due_date: due }, today)],
      };
    });
    offices.push({
      officeName: link.office_name,
      items,
      totals: {
        total: items.reduce((s, i) => s + i.total, 0),
        paid: items.reduce((s, i) => s + i.paid, 0),
        remaining: items.reduce((s, i) => s + i.remaining, 0),
      },
    });
  }
  return {
    offices,
    headers: ['المكتب', 'الوحدة', 'تاريخ الاستحقاق', 'المبلغ', 'المدفوع', 'المتبقي', 'الحالة'],
    csvRows: offices.flatMap((o) => o.items.map((i) => [o.officeName, i.unit, i.due, money.toDecimal(i.total), money.toDecimal(i.paid), money.toDecimal(i.remaining), i.status])),
  };
}

module.exports = { MAX_RANGE_DAYS, BUCKETS, STATUS_LABELS, UNIT_LABELS, REPORTS, parseRange, run, landlordStatement, occupancy, expiring, overdue, collections, maintenance, workload };
