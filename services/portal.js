'use strict';

// Read models for the landlord (/landlord) and tenant (/tenant) areas. The
// links come from services/memberships.js (keyed by the session's user id);
// every query here is scoped to the link's office AND filtered by the link's
// landlord id or contract id, so a person only ever sees rows linked to them.
// All dates and deadlines come from services/contractEngine.js.

const engine = require('./contractEngine');
const feedback = require('./feedback');
const paymentEntries = require('./paymentEntries');
const { scopeToOffice } = require('./scopeToOffice');
const { riyadhDate } = require('./contractDates');

const withDay = (rows) => rows.map((r) => ({ ...r, createdOn: riyadhDate(new Date(r.created_at)) }));

const CONTRACT_COLUMNS = `c.id, c.office_id, c.landlord_id, c.unit_id, c.start_date, c.end_date, c.annual_rent, c.currency,
  c.payment_frequency, c.city, c.status, c.auto_renew, c.renewed_to_id, u.label AS unit_label, b.name AS building_name`;
const CONTRACT_JOINS = `FROM contracts c
  LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
  LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id`;

const halalas = (amount) => engine.toHalalas(String(amount));
const money = (h) => (h / 100).toFixed(2);

function isLive(contract) {
  return engine.LIVE_STAGES.includes(contract.status);
}

/** Engine view of one contract: stage, deadlines, days left, rent policy and Hijri dates. */
function describe(contract, today) {
  const described = engine.describeContract(contract, today);
  return {
    ...described,
    live: isLive(contract),
    policy: engine.rentChangePolicy({ city: contract.city, today, endDate: contract.end_date }),
    hijri: { start: engine.formatHijri(contract.start_date), end: engine.formatHijri(contract.end_date) },
  };
}

async function paymentsByContract(scoped, contractIds, today) {
  const byContract = new Map(contractIds.map((id) => [Number(id), []]));
  if (!contractIds.length) return byContract;
  const rows = await scoped.query(
    `SELECT id, contract_id, due_date, amount, currency, status, paid_at, reported_at FROM contract_payments
      WHERE contract_id IN (?) AND office_id = :office_id ORDER BY due_date, id`,
    [contractIds],
  );
  for (const p of rows) {
    byContract.get(Number(p.contract_id)).push({ ...p, shownStatus: engine.paymentDisplayStatus(p, today) });
  }
  return byContract;
}

/** Paid / due / late / reported totals for one contract's payments (waived ones left out). */
function paymentSummary(payments) {
  const sums = { paid: 0, due: 0, late: 0, tenant_reported: 0 };
  const counts = { paid: 0, due: 0, late: 0, tenant_reported: 0 };
  for (const p of payments) {
    if (!(p.shownStatus in sums)) continue;
    sums[p.shownStatus] += halalas(p.amount);
    counts[p.shownStatus] += 1;
  }
  const next = payments.find((p) => ['due', 'late', 'tenant_reported'].includes(p.shownStatus)) || null;
  return {
    counts,
    totals: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, money(v)])),
    next,
  };
}

// ------------------------------------------------------------ landlord

async function latestDecisions(scoped, contractIds) {
  if (!contractIds.length) return new Map();
  const rows = await scoped.query(
    `SELECT d.contract_id, d.decision, d.created_at FROM contract_decisions d
      WHERE d.contract_id IN (?) AND d.office_id = :office_id
        AND d.id = (SELECT MAX(d2.id) FROM contract_decisions d2 WHERE d2.contract_id = d.contract_id AND d2.office_id = :office_id)`,
    [contractIds],
  );
  return new Map(rows.map((r) => [Number(r.contract_id), r]));
}

/**
 * Everything one landlord link shows: units, running contracts with engine
 * deadlines, payment summaries and the latest decision.
 */
async function landlordOffice(pool, link, today) {
  const scoped = scopeToOffice(pool, link.office_id);
  const units = await scoped.query(
    `SELECT u.id, u.label, u.status, u.city, b.name AS building_name FROM units u
      LEFT JOIN buildings b ON b.id = u.building_id AND b.office_id = :office_id
      WHERE u.landlord_id = ? AND u.office_id = :office_id ORDER BY u.label, u.id`,
    [link.landlord_id],
  );
  const rows = await scoped.query(
    `SELECT ${CONTRACT_COLUMNS} ${CONTRACT_JOINS}
      WHERE c.landlord_id = ? AND c.office_id = :office_id AND c.status IN (?)
      ORDER BY c.end_date, c.id`,
    [link.landlord_id, engine.LIVE_STAGES],
  );
  const ids = rows.map((r) => Number(r.id));
  const payments = await paymentsByContract(scoped, ids, today);
  const decisions = await latestDecisions(scoped, ids);
  const contracts = rows.map((c) => ({
    ...c,
    described: describe(c, today),
    payments: paymentSummary(payments.get(Number(c.id))),
    reported: payments.get(Number(c.id)).filter((p) => p.status === 'tenant_reported'),
    latePayments: payments.get(Number(c.id)).filter((p) => p.shownStatus === 'late'),
    decision: decisions.get(Number(c.id)) || null,
  }));
  return { ...link, units, contracts };
}

/**
 * The "needs action" list of a landlord, most urgent first. days: days left
 * to the relevant date (negative = overdue); a reported payment is 0 (now).
 */
function landlordActions(offices, today) {
  const items = [];
  for (const office of offices) {
    for (const c of office.contracts) {
      const d = c.described;
      if (['urgent', 'deadline_passed', 'soon'].includes(d.stage) && (!c.decision || c.decision.decision === 'undecided')) {
        items.push({ type: 'decision', days: d.daysToNotice, contract: c, office });
      }
      for (const p of c.reported) items.push({ type: 'reported', days: 0, payment: p, contract: c, office });
      for (const p of c.latePayments) {
        items.push({ type: 'late', days: engine.daysUntil(today, p.due_date), payment: p, contract: c, office });
      }
    }
  }
  return items.sort((a, b) => a.days - b.days || Number(a.contract.id) - Number(b.contract.id));
}

/** The landlord dashboard across every office the person is a landlord with. */
async function landlordDashboard(pool, links, today) {
  const offices = [];
  for (const link of links) offices.push(await landlordOffice(pool, link, today));
  return { offices, actions: landlordActions(offices, today) };
}

/**
 * One contract of the landlord's, or null (another landlord's or office's id,
 * or a malformed one). The link is from the session, never from the request.
 */
async function landlordContract(pool, links, contractId, today) {
  if (!contractId) return null;
  for (const link of links) {
    const scoped = scopeToOffice(pool, link.office_id);
    const [row] = await scoped.query(
      `SELECT ${CONTRACT_COLUMNS} ${CONTRACT_JOINS}
        WHERE c.id = ? AND c.landlord_id = ? AND c.office_id = :office_id`,
      [contractId, link.landlord_id],
    );
    if (!row) continue;
    const payments = await paymentEntries.historyFor(pool, link.office_id, row.id, today);
    return {
      link,
      contract: row,
      described: describe(row, today),
      payments,
      summary: paymentSummary(payments),
      decisions: withDay(await feedback.decisionsFor(pool, link.office_id, row.id, 10)),
    };
  }
  return null;
}

// ------------------------------------------------------------ tenant

/** One contract linked to the tenant, or null. */
async function tenantContract(pool, links, contractId, today, userId) {
  if (!contractId) return null;
  const link = links.find((l) => l.contract_id === Number(contractId));
  if (!link) return null;
  const scoped = scopeToOffice(pool, link.office_id);
  const [row] = await scoped.query(
    `SELECT ${CONTRACT_COLUMNS} ${CONTRACT_JOINS}
      WHERE c.id = ? AND c.office_id = :office_id
        AND EXISTS (SELECT 1 FROM contract_members cm WHERE cm.contract_id = c.id AND cm.user_id = ? AND cm.role = 'tenant')`,
    [link.contract_id, userId],
  );
  if (!row) return null;
  const payments = (await paymentsByContract(scoped, [Number(row.id)], today)).get(Number(row.id));
  const requests = withDay(await scoped.query(
    `SELECT id, request_type, status, created_at FROM contract_requests
      WHERE contract_id = ? AND user_id = ? AND office_id = :office_id ORDER BY id DESC`,
    [row.id, userId],
  ));
  return {
    link,
    contract: row,
    described: describe(row, today),
    payments,
    upcoming: payments.filter((p) => p.status !== 'waived'),
    summary: paymentSummary(payments),
    reduction: feedback.reductionAvailability(row, today),
    pendingRequest: requests.some((r) => r.status === 'pending'),
    requests,
  };
}

/**
 * The tenant dashboard: every linked contract that was not replaced by a
 * renewal (the renewal is linked too), running ones first.
 */
async function tenantDashboard(pool, links, today, userId) {
  const contracts = [];
  for (const link of links) {
    const view = await tenantContract(pool, links, link.contract_id, today, userId);
    if (view && view.contract.status !== 'renewed') contracts.push(view);
  }
  contracts.sort((a, b) => Number(b.described.live) - Number(a.described.live));
  return { contracts };
}

module.exports = {
  landlordDashboard,
  landlordContract,
  landlordActions,
  tenantDashboard,
  tenantContract,
  paymentSummary,
};
