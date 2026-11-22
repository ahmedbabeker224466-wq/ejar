'use strict';

// Office bookkeeping: what came in, what went out, and what each landlord is
// owed. The app never moves money; every figure records something the office
// did outside the app.
//
// Sources:
//   - Rent received: live payment_entries (undone rows excluded), dated paid_on.
//   - ledger_entries: expenses (charged to a landlord or to the office),
//     payouts to landlords, and other income. A wrong row is voided with a
//     written reason, never deleted.
//   - The office commission: a percentage of the rent received for each
//     landlord (office_settings 'accounting.commission_bp', basis points).
//     It is computed with the CURRENT rate, also for earlier months.
//
// A landlord's balance = rent received for their contracts + income booked to
// them - expenses charged to them - commission - payouts. Positive = the
// office holds money for the landlord.
//
// All sums are integer halalas (services/money.js). Audit rows hold ids, kinds
// and categories, never amounts or descriptions.

const dates = require('./contractDates');
const engine = require('./contractEngine');
const money = require('./money');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { withTransaction } = require('./transaction');

const KINDS = { expense: 'مصروف', owner_payout: 'تحويل إلى المالك', income: 'إيراد آخر' };
const CATEGORIES = {
  expense: {
    maintenance: 'صيانة',
    utilities: 'كهرباء ومياه',
    cleaning: 'نظافة',
    fees: 'رسوم ومعاملات',
    marketing: 'تسويق',
    other: 'أخرى',
  },
  owner_payout: { payout: 'تحويل إلى المالك' },
  income: { other: 'إيراد آخر' },
};
const LIMITS = { description: 160, reason: 200, maxCommissionBp: 5000 };
const COMMISSION_KEY = 'accounting.commission_bp';
const MAX_ROWS = 500;

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, tooLong: text.length > max };
}

// No account numbers, IBANs or ID-like numbers in a free-text description.
function looksLikeAccount(text) {
  const squeezed = text.replace(/[\s\-._/]/g, '');
  return /[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}/.test(squeezed) || /\d{10,}/.test(squeezed);
}

/** The month to show: 'YYYY-MM' from the query, else the current Riyadh month. Never in the future. */
function parseMonth(value, today) {
  const current = today.slice(0, 7);
  const period = String(value || '').trim();
  if (!dates.isMonth(period) || period > current) return current;
  return period;
}

/** Percent text ('5', '2.5', '٥') to basis points, or null when invalid. */
function parsePercent(input) {
  const text = String(input ?? '').trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bp >= 0 && bp <= LIMITS.maxCommissionBp ? bp : null;
}

const percentText = (bp) => {
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, '');
  return s || '0';
};

/** Commission in halalas on an amount, rounded half up. */
function commissionOn(halalas, bp) {
  if (halalas <= 0 || bp <= 0) return 0;
  return Math.floor((halalas * bp + 5000) / 10000);
}

/** Checks the "new entry" form. Returns { values, errors }; amount is halalas. */
function validateEntry(body = {}, today) {
  const errors = {};
  const kind = String(body.kind || '');
  if (!has(KINDS, kind)) errors.kind = 'اختر نوع القيد.';
  const category = kind === 'owner_payout' ? 'payout' : kind === 'income' ? 'other' : String(body.category || '');
  if (has(KINDS, kind) && !has(CATEGORIES[kind], category)) errors.category = 'اختر التصنيف.';
  const entryDate = String(body.entry_date || '').trim() || today;
  if (!engine.isValidDate(entryDate)) errors.entry_date = 'اختر تاريخاً صحيحاً.';
  else if (entryDate > today) errors.entry_date = 'لا يكون التاريخ في المستقبل.';
  const amount = money.parseAmount(String(body.amount ?? '').trim());
  if (amount === null) errors.amount = 'اكتب مبلغاً صحيحاً أكبر من صفر.';
  const landlordRaw = String(body.landlord_id || '').trim();
  const unitRaw = String(body.unit_id || '').trim();
  const landlordId = /^\d{1,12}$/.test(landlordRaw) ? Number(landlordRaw) : null;
  const unitId = /^\d{1,12}$/.test(unitRaw) ? Number(unitRaw) : null;
  if (landlordRaw && !landlordId) errors.landlord_id = 'اختر المالك من القائمة.';
  if (unitRaw && !unitId) errors.unit_id = 'اختر الوحدة من القائمة.';
  if (kind === 'owner_payout' && !landlordId) errors.landlord_id = 'اختر المالك الذي حوّلت له.';
  const description = cleanText(body.description, LIMITS.description);
  if (description.tooLong) errors.description = `الوصف ${LIMITS.description} حرفاً كحد أقصى.`;
  else if (description.text && looksLikeAccount(description.text)) errors.description = 'لا تكتب رقم حساب أو آيبان أو رقماً طويلاً في الوصف.';
  return {
    values: { kind, category, entry_date: entryDate, amount, landlord_id: landlordId, unit_id: unitId, description: description.text || null },
    errors,
  };
}

/** The landlord and unit must belong to this office, and the unit to that landlord. */
async function checkRefs(scoped, values) {
  const errors = {};
  if (values.landlord_id) {
    const [row] = await scoped.query('SELECT id FROM landlords WHERE id = ? AND office_id = :office_id', [values.landlord_id]);
    if (!row) errors.landlord_id = 'المالك غير موجود في مكتبك.';
  }
  if (values.unit_id) {
    const [unit] = await scoped.query('SELECT id, landlord_id FROM units WHERE id = ? AND office_id = :office_id', [values.unit_id]);
    if (!unit) errors.unit_id = 'الوحدة غير موجودة في مكتبك.';
    else if (values.landlord_id && Number(unit.landlord_id) !== values.landlord_id) errors.unit_id = 'الوحدة لا تتبع هذا المالك.';
    else if (!values.landlord_id && values.kind !== 'income') values.landlord_id = Number(unit.landlord_id);
  }
  return errors;
}

async function createEntry(pool, officeId, { values, actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const errors = await checkRefs(scoped, values);
  if (Object.keys(errors).length) return { ok: false, errors };
  return withTransaction(pool, async (conn) => {
    const tx = scopeToOffice(conn, officeId);
    const id = await tx.insert('ledger_entries', {
      kind: values.kind,
      category: values.category,
      entry_date: values.entry_date,
      amount: money.toDecimal(values.amount),
      landlord_id: values.landlord_id,
      unit_id: values.unit_id,
      description: values.description,
      created_by: actorId,
    });
    await createAudit(conn).write(actorId, officeId, 'ledger.create', 'ledger_entry', id, null, { kind: values.kind, category: values.category, landlord_id: values.landlord_id }, ip);
    return { ok: true, id };
  });
}

/** Voids a live entry with a written reason (3-200 characters). */
async function voidEntry(pool, officeId, id, { reason, actorId, ip }) {
  const text = cleanText(reason, LIMITS.reason).text;
  if (text.length < 3 || text.length > LIMITS.reason) return { ok: false, error: 'اكتب سبب الإلغاء (3 إلى 200 حرف).' };
  return withTransaction(pool, async (conn) => {
    const tx = scopeToOffice(conn, officeId);
    const [row] = await tx.query('SELECT id, kind, voided_at FROM ledger_entries WHERE id = ? AND office_id = :office_id FOR UPDATE', [id]);
    if (!row) return { ok: false, notFound: true };
    if (row.voided_at) return { ok: false, error: 'هذا القيد ملغى من قبل.' };
    await tx.query('UPDATE ledger_entries SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ? WHERE id = ? AND office_id = :office_id', [actorId, text, id]);
    await createAudit(conn).write(actorId, officeId, 'ledger.void', 'ledger_entry', id, { voided: false }, { voided: true, kind: row.kind }, ip);
    return { ok: true };
  });
}

async function commissionBp(pool, officeId) {
  const row = await scopeToOffice(pool, officeId).selectOne('office_settings', { setting_key: COMMISSION_KEY }, { columns: ['setting_value'] });
  const bp = Number(row && row.setting_value);
  return Number.isInteger(bp) && bp >= 0 && bp <= LIMITS.maxCommissionBp ? bp : 0;
}

async function setCommission(pool, officeId, { input, actorId, ip }) {
  const bp = parsePercent(input);
  if (bp === null) return { ok: false, error: 'اكتب نسبة بين 0 و50، مثل 5 أو 2.5.' };
  const before = await commissionBp(pool, officeId);
  await scopeToOffice(pool, officeId).query(
    `INSERT INTO office_settings (office_id, setting_key, setting_value) VALUES (:office_id, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [COMMISSION_KEY, String(bp)],
  );
  await createAudit(pool).log(actorId, officeId, 'accounting.commission', 'office', officeId, { commission_bp: before }, { commission_bp: bp }, ip);
  return { ok: true, bp };
}

// ------------------------------------------------------------ reading

/** Rent received per landlord between two days (inclusive). Map landlordId -> halalas. */
async function rentByLandlord(scoped, from, to) {
  const rows = await scoped.query(
    `SELECT c.landlord_id, ROUND(SUM(e.amount) * 100) AS h
       FROM payment_entries e
       JOIN contracts c ON c.id = e.contract_id AND c.office_id = :office_id
      WHERE e.office_id = :office_id AND e.undone_at IS NULL AND e.paid_on BETWEEN ? AND ?
      GROUP BY c.landlord_id`,
    [from, to],
  );
  return new Map(rows.map((r) => [Number(r.landlord_id), Number(r.h)]));
}

/** Live ledger sums between two days, grouped by kind, category and landlord. */
async function ledgerSums(scoped, from, to) {
  return (await scoped.query(
    `SELECT kind, category, landlord_id, ROUND(SUM(amount) * 100) AS h
       FROM ledger_entries
      WHERE office_id = :office_id AND voided_at IS NULL AND entry_date BETWEEN ? AND ?
      GROUP BY kind, category, landlord_id`,
    [from, to],
  )).map((r) => ({ kind: r.kind, category: r.category, landlordId: r.landlord_id === null ? null : Number(r.landlord_id), h: Number(r.h) }));
}

function totalsFor(rent, sums, bp) {
  let collected = 0;
  let commission = 0;
  for (const h of rent.values()) {
    collected += h;
    commission += commissionOn(h, bp);
  }
  const t = { collected, commission, expenses: 0, ownerExpenses: 0, officeExpenses: 0, payouts: 0, otherIncome: 0 };
  for (const s of sums) {
    if (s.kind === 'expense') {
      t.expenses += s.h;
      if (s.landlordId) t.ownerExpenses += s.h;
      else t.officeExpenses += s.h;
    } else if (s.kind === 'owner_payout') t.payouts += s.h;
    else if (s.kind === 'income') t.otherIncome += s.h;
  }
  t.officeIncome = t.commission + t.otherIncome;
  t.ownersNet = t.collected - t.ownerExpenses - t.commission;
  return t;
}

/** The accounting home for one month: totals, six-month trend, expenses by category. */
async function monthSummary(pool, officeId, period) {
  const scoped = scopeToOffice(pool, officeId);
  const bp = await commissionBp(pool, officeId);
  const { from, to } = dates.monthRange(period);
  const totals = totalsFor(await rentByLandlord(scoped, from, to), await ledgerSums(scoped, from, to), bp);

  const trend = [];
  for (let i = 5; i >= 0; i -= 1) {
    const p = dates.shiftMonth(period, -i);
    const r = dates.monthRange(p);
    const t = totalsFor(await rentByLandlord(scoped, r.from, r.to), await ledgerSums(scoped, r.from, r.to), bp);
    trend.push({ period: p, collected: t.collected, expenses: t.expenses });
  }
  const top = Math.max(1, ...trend.map((m) => Math.max(m.collected, m.expenses)));
  for (const m of trend) {
    m.collectedPct = Math.round((m.collected / top) * 100);
    m.expensesPct = Math.round((m.expenses / top) * 100);
  }

  const byCategory = {};
  for (const s of await ledgerSums(scoped, from, to)) {
    if (s.kind === 'expense') byCategory[s.category] = (byCategory[s.category] || 0) + s.h;
  }
  const expenseRows = Object.entries(byCategory)
    .map(([key, h]) => ({ key, label: CATEGORIES.expense[key] || key, h, pct: totals.expenses ? Math.round((h / totals.expenses) * 100) : 0 }))
    .sort((a, b) => b.h - a.h);

  return { period, bp, totals, trend, expenseRows };
}

/** Every movement of the month, newest first: rent received and ledger rows. */
async function movements(pool, officeId, period, { landlordId = null } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const { from, to } = dates.monthRange(period);
  const rentWhere = landlordId ? ' AND c.landlord_id = ?' : '';
  const rent = await scoped.query(
    `SELECT e.id, e.paid_on AS day, ROUND(e.amount * 100) AS h, u.label AS unit_label, c.id AS contract_id, c.landlord_id
       FROM payment_entries e
       JOIN contracts c ON c.id = e.contract_id AND c.office_id = :office_id
       LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE e.office_id = :office_id AND e.undone_at IS NULL AND e.paid_on BETWEEN ? AND ?${rentWhere}
      ORDER BY e.paid_on DESC, e.id DESC LIMIT ${MAX_ROWS}`,
    landlordId ? [from, to, landlordId] : [from, to],
  );
  const ledgerWhere = landlordId ? ' AND l.landlord_id = ?' : '';
  const ledger = await scoped.query(
    `SELECT l.id, l.kind, l.category, l.entry_date AS day, ROUND(l.amount * 100) AS h, l.description, l.voided_at, l.void_reason,
            l.landlord_id, ld.label AS landlord_label, u.label AS unit_label
       FROM ledger_entries l
       LEFT JOIN landlords ld ON ld.id = l.landlord_id AND ld.office_id = :office_id
       LEFT JOIN units u ON u.id = l.unit_id AND u.office_id = :office_id
      WHERE l.office_id = :office_id AND l.entry_date BETWEEN ? AND ?${ledgerWhere}
      ORDER BY l.entry_date DESC, l.id DESC LIMIT ${MAX_ROWS}`,
    landlordId ? [from, to, landlordId] : [from, to],
  );
  const rows = [
    ...rent.map((r) => ({
      source: 'rent',
      id: Number(r.id),
      day: String(r.day).slice(0, 10),
      label: `إيجار: ${r.unit_label || 'وحدة'}`,
      typeLabel: 'دفعة إيجار',
      tone: 'in',
      h: Number(r.h),
      link: `/office/contracts/${r.contract_id}#payments`,
    })),
    ...ledger.map((r) => {
      const out = r.kind !== 'income';
      const subject = r.kind === 'owner_payout' ? (r.landlord_label || 'مالك') : (r.unit_label || r.landlord_label || 'المكتب');
      return {
        source: 'ledger',
        id: Number(r.id),
        day: String(r.day).slice(0, 10),
        label: `${CATEGORIES[r.kind][r.category] || KINDS[r.kind]}: ${subject}`,
        description: r.description,
        typeLabel: KINDS[r.kind],
        kind: r.kind,
        tone: out ? 'out' : 'in',
        h: Number(r.h),
        voided: Boolean(r.voided_at),
        voidReason: r.void_reason,
      };
    }),
  ];
  rows.sort((a, b) => (a.day === b.day ? b.id - a.id : a.day < b.day ? 1 : -1));
  return rows;
}

/** Balance of one landlord for everything up to and including `to` (null = all time). */
async function landlordBalanceUntil(scoped, landlordId, to, bp) {
  const toClause = to ? ' AND e.paid_on <= ?' : '';
  const [rent] = await scoped.query(
    `SELECT ROUND(COALESCE(SUM(e.amount), 0) * 100) AS h
       FROM payment_entries e
       JOIN contracts c ON c.id = e.contract_id AND c.office_id = :office_id
      WHERE e.office_id = :office_id AND e.undone_at IS NULL AND c.landlord_id = ?${toClause}`,
    to ? [landlordId, to] : [landlordId],
  );
  const toLedger = to ? ' AND entry_date <= ?' : '';
  const sums = await scoped.query(
    `SELECT kind, ROUND(SUM(amount) * 100) AS h FROM ledger_entries
      WHERE office_id = :office_id AND voided_at IS NULL AND landlord_id = ?${toLedger}
      GROUP BY kind`,
    to ? [landlordId, to] : [landlordId],
  );
  const by = Object.fromEntries(sums.map((s) => [s.kind, Number(s.h)]));
  const rentH = Number(rent.h);
  return rentH + (by.income || 0) - (by.expense || 0) - (by.owner_payout || 0) - commissionOn(rentH, bp);
}

/** Landlords of the office with this month's rent and their balance at the month end. */
async function ownerBalances(pool, officeId, period) {
  const scoped = scopeToOffice(pool, officeId);
  const bp = await commissionBp(pool, officeId);
  const { from, to } = dates.monthRange(period);
  const rent = await rentByLandlord(scoped, from, to);
  const landlords = await scoped.query('SELECT id, label, city, is_active FROM landlords WHERE office_id = :office_id ORDER BY label LIMIT 1000');
  const rows = [];
  for (const l of landlords) {
    const id = Number(l.id);
    rows.push({ id, label: l.label, city: l.city, active: Boolean(l.is_active), collected: rent.get(id) || 0, balance: await landlordBalanceUntil(scoped, id, to, bp) });
  }
  return { bp, rows, totalBalance: rows.reduce((s, r) => s + r.balance, 0) };
}

/**
 * The statement of one landlord for one month: opening balance, every
 * movement (rent in, expenses, commission, payouts, income), closing balance.
 * Returns null when the landlord is not in this office.
 */
async function ownerStatement(pool, officeId, landlordId, period) {
  const scoped = scopeToOffice(pool, officeId);
  const [landlord] = await scoped.query('SELECT id, label, city FROM landlords WHERE id = ? AND office_id = :office_id', [landlordId]);
  if (!landlord) return null;
  const bp = await commissionBp(pool, officeId);
  const { from, to } = dates.monthRange(period);
  const opening = await landlordBalanceUntil(scoped, landlordId, dates.addDays(from, -1), bp);

  const rent = await scoped.query(
    `SELECT e.paid_on AS day, ROUND(e.amount * 100) AS h, u.label AS unit_label
       FROM payment_entries e
       JOIN contracts c ON c.id = e.contract_id AND c.office_id = :office_id
       LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id
      WHERE e.office_id = :office_id AND e.undone_at IS NULL AND c.landlord_id = ? AND e.paid_on BETWEEN ? AND ?
      ORDER BY e.paid_on, e.id LIMIT ${MAX_ROWS}`,
    [landlordId, from, to],
  );
  const ledger = await scoped.query(
    `SELECT l.kind, l.category, l.entry_date AS day, ROUND(l.amount * 100) AS h, l.description, u.label AS unit_label
       FROM ledger_entries l
       LEFT JOIN units u ON u.id = l.unit_id AND u.office_id = :office_id
      WHERE l.office_id = :office_id AND l.voided_at IS NULL AND l.landlord_id = ? AND l.entry_date BETWEEN ? AND ?
      ORDER BY l.entry_date, l.id LIMIT ${MAX_ROWS}`,
    [landlordId, from, to],
  );

  const lines = [];
  let rentTotal = 0;
  for (const r of rent) {
    const h = Number(r.h);
    rentTotal += h;
    lines.push({ day: String(r.day).slice(0, 10), label: `إيجار ${r.unit_label || 'وحدة'}`, credit: h, debit: 0 });
  }
  for (const r of ledger) {
    const h = Number(r.h);
    const what = CATEGORIES[r.kind][r.category] || KINDS[r.kind];
    const label = [what, r.unit_label, r.description].filter(Boolean).join('، ');
    if (r.kind === 'income') lines.push({ day: String(r.day).slice(0, 10), label, credit: h, debit: 0 });
    else lines.push({ day: String(r.day).slice(0, 10), label, credit: 0, debit: h });
  }
  lines.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const commission = commissionOn(rentTotal, bp);
  if (commission > 0) lines.push({ day: to, label: `عمولة المكتب ${percentText(bp)}%`, credit: 0, debit: commission });

  const credits = lines.reduce((s, l) => s + l.credit, 0);
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const payouts = ledger.filter((r) => r.kind === 'owner_payout').reduce((s, r) => s + Number(r.h), 0);
  const expenses = ledger.filter((r) => r.kind === 'expense').reduce((s, r) => s + Number(r.h), 0);
  return {
    landlord: { id: Number(landlord.id), label: landlord.label, city: landlord.city },
    period,
    from,
    to,
    bp,
    percent: percentText(bp),
    opening,
    lines,
    credits,
    debits,
    rent: rentTotal,
    expenses,
    commission,
    payouts,
    closing: opening + credits - debits,
    number: `ST-${period.replace('-', '')}-${String(landlord.id).padStart(4, '0')}`,
  };
}

/** Landlords and units of the office for the entry form. */
async function formOptions(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const landlords = await scoped.query('SELECT id, label FROM landlords WHERE office_id = :office_id AND is_active = 1 ORDER BY label LIMIT 1000');
  const units = await scoped.query(
    `SELECT u.id, u.label, u.landlord_id, l.label AS landlord_label
       FROM units u LEFT JOIN landlords l ON l.id = u.landlord_id AND l.office_id = :office_id
      WHERE u.office_id = :office_id ORDER BY l.label, u.label LIMIT 2000`,
  );
  return { landlords, units };
}

module.exports = {
  KINDS,
  CATEGORIES,
  LIMITS,
  COMMISSION_KEY,
  parseMonth,
  parsePercent,
  percentText,
  commissionOn,
  validateEntry,
  createEntry,
  voidEntry,
  commissionBp,
  setCommission,
  monthSummary,
  movements,
  ownerBalances,
  ownerStatement,
  formOptions,
};
