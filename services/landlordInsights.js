'use strict';

// A landlord's numbers across their offices: rent received per month for the
// last 12 Riyadh months, occupancy and how long vacant units have been empty,
// and a per-unit comparison (rent received, maintenance requests). Reads only
// rows of the landlord's own links (services/memberships.landlordLinks);
// every query is scoped to the link's office and filtered by landlord_id.
// Money is integer halalas; dates come from services/contractDates.js.

const { scopeToOffice } = require('./scopeToOffice');
const { monthRange, shiftMonth, daysBetween } = require('./contractDates');
const money = require('./money');

const MONTHS = 12;

/** The last `n` months ending with the month of `today`, oldest first: ['YYYY-MM', ...]. */
function lastMonths(today, n = MONTHS) {
  const current = String(today).slice(0, 7);
  return Array.from({ length: n }, (_, i) => shiftMonth(current, i - (n - 1)));
}

/** Bar heights as whole percents of the largest month (0 when all are 0). */
function barPercents(values) {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 ? Math.round((v * 100) / max) : 0));
}

async function forLink(pool, link, months, today) {
  const scoped = scopeToOffice(pool, link.office_id);
  const from = monthRange(months[0]).from;
  const to = monthRange(months[months.length - 1]).to;
  const income = await scoped.query(
    `SELECT DATE_FORMAT(e.paid_on, '%Y-%m') AS ym, c.unit_id, ROUND(SUM(e.amount) * 100) AS h
       FROM payment_entries e
       JOIN contracts c ON c.id = e.contract_id AND c.office_id = :office_id
      WHERE e.office_id = :office_id AND e.undone_at IS NULL AND c.landlord_id = ? AND e.paid_on BETWEEN ? AND ?
      GROUP BY ym, c.unit_id`,
    [link.landlord_id, from, to],
  );
  const units = await scoped.query(
    `SELECT u.id, u.label, u.status,
            (SELECT MAX(c.end_date) FROM contracts c WHERE c.unit_id = u.id AND c.office_id = :office_id AND c.status <> 'renewed') AS last_end,
            (SELECT c.annual_rent FROM contracts c WHERE c.unit_id = u.id AND c.office_id = :office_id AND c.status IN ('calm','soon','urgent','deadline_passed') ORDER BY c.end_date DESC LIMIT 1) AS rent,
            (SELECT COUNT(*) FROM maintenance_requests m WHERE m.unit_id = u.id AND m.office_id = :office_id AND m.created_at >= ?) AS maintenance
       FROM units u WHERE u.landlord_id = ? AND u.office_id = :office_id ORDER BY u.label`,
    [`${from} 00:00:00`, link.landlord_id],
  );
  return {
    income: income.map((r) => ({ ym: r.ym, unitId: Number(r.unit_id), h: Number(r.h) })),
    units: units.map((u) => {
      const ended = u.last_end ? String(u.last_end).slice(0, 10) : null;
      const vacantDays = u.status === 'vacant' && ended && daysBetween(ended, today) > 0 ? daysBetween(ended, today) : null;
      return {
        id: Number(u.id), label: u.label, status: u.status, office: link.office_name,
        rentH: u.rent === null ? null : money.fromDecimal(u.rent), maintenance: Number(u.maintenance), vacantDays, neverRented: !ended,
      };
    }),
  };
}

/** Everything the insights page shows. */
async function insights(pool, links, today) {
  const months = lastMonths(today);
  const parts = await Promise.all(links.map((link) => forLink(pool, link, months, today)));
  const byMonth = new Map(months.map((m) => [m, 0]));
  const byUnit = new Map();
  const units = [];
  parts.forEach((part) => {
    part.income.forEach((r) => {
      if (byMonth.has(r.ym)) byMonth.set(r.ym, byMonth.get(r.ym) + r.h);
      byUnit.set(r.unitId, (byUnit.get(r.unitId) || 0) + r.h);
    });
    units.push(...part.units);
  });
  const monthValues = months.map((m) => byMonth.get(m));
  const pcts = barPercents(monthValues);
  const total = monthValues.reduce((a, b) => a + b, 0);
  const rented = units.filter((u) => u.status === 'rented').length;
  const compared = units.map((u) => ({ ...u, incomeH: byUnit.get(u.id) || 0 })).sort((a, b) => b.incomeH - a.incomeH);
  return {
    months: months.map((m, i) => ({ ym: m, h: monthValues[i], pct: pcts[i] })),
    totalH: total,
    averageH: Math.round(total / months.length),
    bestMonth: monthValues.some((v) => v > 0) ? months[monthValues.indexOf(Math.max(...monthValues))] : null,
    occupancy: { units: units.length, rented, pct: units.length ? Math.round((rented * 100) / units.length) : 0 },
    vacant: units.filter((u) => u.status === 'vacant').sort((a, b) => (b.vacantDays || 0) - (a.vacantDays || 0)),
    units: compared,
    maxUnitH: Math.max(0, ...compared.map((u) => u.incomeH)),
  };
}

/**
 * Cron landlord_monthly (1st of the month): one notification per joined
 * landlord and office with last month's rent received, late installments,
 * vacant units and contracts whose renewal decision is due within 30 days.
 * Counts and amounts only. Idempotent per landlord, office and month.
 */
async function runMonthlySummary({ pool, now = new Date() }) {
  const { riyadhDate } = require('./contractDates');
  const { officeAccess } = require('./offices');
  const { createNotification } = require('./notifications');
  const today = riyadhDate(now);
  const period = shiftMonth(today.slice(0, 7), -1);
  const { from, to } = monthRange(period);
  const [rows] = await pool.query(
    `SELECT l.id AS landlord_id, l.user_id, o.id AS office_id, o.name AS office_name, o.status, o.trial_ends_at, o.subscription_ends_at, o.verification
       FROM landlords l JOIN offices o ON o.id = l.office_id
      WHERE l.user_id IS NOT NULL AND l.is_active = 1 ORDER BY l.id`,
  );
  let sent = 0;
  for (const r of rows) {
    if (officeAccess({ ...r, id: r.office_id }, now).locked) continue;
    const scoped = scopeToOffice(pool, r.office_id);
    const [c] = await scoped.query(
      `SELECT (SELECT ROUND(COALESCE(SUM(e.amount), 0) * 100) FROM payment_entries e JOIN contracts k ON k.id = e.contract_id AND k.office_id = :office_id
                WHERE e.office_id = :office_id AND e.undone_at IS NULL AND k.landlord_id = ? AND e.paid_on BETWEEN ? AND ?) AS collected,
              (SELECT COUNT(*) FROM contract_payments p JOIN contracts k ON k.id = p.contract_id AND k.office_id = :office_id
                WHERE p.office_id = :office_id AND p.status = 'late' AND k.landlord_id = ?) AS late,
              (SELECT COUNT(*) FROM units u WHERE u.office_id = :office_id AND u.landlord_id = ? AND u.status = 'vacant') AS vacant,
              (SELECT COUNT(*) FROM contracts k WHERE k.office_id = :office_id AND k.landlord_id = ? AND k.status IN ('soon','urgent')) AS deciding`,
      [r.landlord_id, from, to, r.landlord_id, r.landlord_id, r.landlord_id],
    );
    const id = await createNotification(pool, {
      userId: r.user_id,
      officeId: r.office_id,
      kind: 'landlord_monthly',
      title: `ملخص عقاراتك لشهر ${period}`,
      body: `الإيجار المحصّل: ${money.formatHalalas(Number(c.collected))} ريال\nدفعات متأخرة: ${Number(c.late)}\nوحدات شاغرة: ${Number(c.vacant)}\nعقود يقترب موعد قرار تجديدها: ${Number(c.deciding)}`,
      link: '/landlord/insights',
      dedupeKey: `landlord_monthly:o${r.office_id}:u${r.user_id}:${period}`,
      now,
    });
    if (id) sent += 1;
  }
  return sent;
}

module.exports = { insights, lastMonths, barPercents, runMonthlySummary, MONTHS };
