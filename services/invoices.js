'use strict';

// Invoices and credit notes for subscription payments.
//
// - Numbers are gap-free per series and Riyadh year: SERIES-YEAR-000001. The
//   counter row (invoice_counters) is locked by the statement that bumps it,
//   inside the issuing transaction, so parallel payments queue up and a
//   rolled-back transaction gives its number back.
// - An invoice is a snapshot: seller details (platform settings at that
//   moment), the buyer (the office's display name only), lines, discount,
//   VAT and total. Later changes to settings or plans never alter it.
// - The title is "فاتورة ضريبية مبسطة" only when the seller VAT number is set;
//   otherwise "إيصال دفع". This app does not claim e-invoicing (ZATCA)
//   compliance: that integration is a separate later task.
// - A credit note has its own sequence and negative amounts; it cancels one
//   whole invoice (the admin's refund action records it; the money itself is
//   returned outside this app).

const billing = require('../config/billing');
const money = require('./money');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { riyadhYear, riyadhDate } = require('./contractDates');

const INTERVAL_LABELS = { monthly: 'شهري', yearly: 'سنوي' };
const TITLE_TAX = 'فاتورة ضريبية مبسطة';
const TITLE_RECEIPT = 'إيصال دفع';
const TITLE_CREDIT_TAX = 'إشعار دائن';
const TITLE_CREDIT_RECEIPT = 'إشعار استرداد';

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 'INV-2026-000007'. */
function formatNumber(series, year, n) {
  return `${billing.SERIES[series]}-${year}-${String(n).padStart(6, '0')}`;
}

/**
 * The next number of a series, under the counter row's lock. Call it inside
 * the transaction that inserts the invoice.
 */
async function nextNumber(conn, series, year) {
  await conn.query(
    `INSERT INTO invoice_counters (series, year, last_number) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
    [billing.SERIES[series], year],
  );
  const [[row]] = await conn.query('SELECT last_number FROM invoice_counters WHERE series = ? AND year = ? FOR UPDATE', [billing.SERIES[series], year]);
  return formatNumber(series, year, Number(row.last_number));
}

function titleFor(seller, credit = false) {
  const taxed = Boolean(seller && seller.vat_number);
  if (credit) return taxed ? TITLE_CREDIT_TAX : TITLE_CREDIT_RECEIPT;
  return taxed ? TITLE_TAX : TITLE_RECEIPT;
}

/** The lines of a subscription invoice, amounts in integer halalas (VAT-exclusive). */
function linesFor({ planName, interval, periodFrom, periodTo, subtotal, discount, promoCode }) {
  const lines = [{
    description: `اشتراك باقة ${planName} (${INTERVAL_LABELS[interval] || interval})`,
    period_from: periodFrom,
    period_to: periodTo,
    net: subtotal,
  }];
  if (discount > 0) lines.push({ description: promoCode ? `خصم (${promoCode})` : 'خصم', net: -discount });
  return lines;
}

/**
 * Issues the invoice of a paid order (inside the settle transaction).
 * `seller` is the platform seller block read just before. Returns { id, invoiceNo }.
 */
async function issueInvoice(conn, { order, officeName, planName, periodFrom, periodTo, subscriptionId = null, seller, issuedBy = null, now = new Date() }) {
  const subtotal = money.fromDecimal(order.subtotal);
  const discount = money.fromDecimal(order.discount);
  const vat = money.fromDecimal(order.vat_amount);
  const total = money.fromDecimal(order.total);
  const year = riyadhYear(now);
  const invoiceNo = await nextNumber(conn, 'invoice', year);
  const lines = linesFor({ planName, interval: order.billing_interval, periodFrom, periodTo, subtotal, discount, promoCode: order.promo_code });
  const [result] = await conn.query(
    `INSERT INTO subscription_invoices
       (office_id, subscription_id, order_id, kind, invoice_no, status, doc_title, seller_json, buyer_name, lines_json,
        subtotal, discount, vat_rate_bp, vat_amount, total, currency, issued_at, issued_by)
     VALUES (?, ?, ?, 'invoice', ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.office_id, subscriptionId, order.id, invoiceNo, titleFor(seller), JSON.stringify(seller), String(officeName).slice(0, 150),
      JSON.stringify(lines), money.toDecimal(subtotal), money.toDecimal(discount), order.vat_rate_bp, money.toDecimal(vat),
      money.toDecimal(total), order.currency, now, issuedBy,
    ],
  );
  return { id: result.insertId, invoiceNo };
}

/**
 * Cancels one whole invoice with a credit note (the admin's refund action).
 * Returns { ok: true, id, invoiceNo } or { ok: false, error } with error
 * 'not_found' | 'already_credited' | 'not_an_invoice'.
 */
async function issueCreditNote(pool, { invoiceId, reason, issuedBy, now = new Date() }) {
  return withTransaction(pool, async (conn) => {
    const [[invoice]] = await conn.query('SELECT * FROM subscription_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!invoice) return { ok: false, error: 'not_found' };
    if (invoice.kind !== 'invoice') return { ok: false, error: 'not_an_invoice' };
    if (invoice.status !== 'issued') return { ok: false, error: 'already_credited' };
    const seller = parseJson(invoice.seller_json) || {};
    const lines = (parseJson(invoice.lines_json) || []).map((l) => ({ ...l, net: -Number(l.net) }));
    const invoiceNo = await nextNumber(conn, 'credit_note', riyadhYear(now));
    const [result] = await conn.query(
      `INSERT INTO subscription_invoices
         (office_id, subscription_id, order_id, kind, credit_for_id, invoice_no, status, doc_title, seller_json, buyer_name, lines_json,
          subtotal, discount, vat_rate_bp, vat_amount, total, currency, reason, issued_at, issued_by)
       VALUES (?, ?, ?, 'credit_note', ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoice.office_id, invoice.subscription_id, invoice.order_id, invoice.id, invoiceNo, titleFor(seller, true),
        JSON.stringify(seller), invoice.buyer_name, JSON.stringify(lines),
        money.toDecimal(-money.fromDecimal(invoice.subtotal)), money.toDecimal(-money.fromDecimal(invoice.discount)),
        invoice.vat_rate_bp, money.toDecimal(-money.fromDecimal(invoice.vat_amount)), money.toDecimal(-money.fromDecimal(invoice.total)),
        invoice.currency, String(reason).slice(0, 200), now, issuedBy,
      ],
    );
    await conn.query("UPDATE subscription_invoices SET status = 'credited' WHERE id = ?", [invoice.id]);
    await conn.query("UPDATE platform_payments SET status = 'refunded' WHERE invoice_id = ?", [invoice.id]);
    return { ok: true, id: result.insertId, invoiceNo };
  });
}

/** Shapes a stored row for the printable page (JSON parsed, money as halalas). */
function present(row) {
  if (!row) return null;
  const seller = parseJson(row.seller_json) || {};
  const lines = parseJson(row.lines_json) || [];
  return {
    id: Number(row.id),
    officeId: Number(row.office_id),
    kind: row.kind,
    status: row.status,
    invoiceNo: row.invoice_no,
    title: row.doc_title,
    taxed: Boolean(seller.vat_number),
    seller,
    buyerName: row.buyer_name,
    lines,
    subtotal: money.fromDecimal(row.subtotal),
    discount: money.fromDecimal(row.discount),
    vatRateBp: Number(row.vat_rate_bp),
    vat: money.fromDecimal(row.vat_amount),
    total: money.fromDecimal(row.total),
    currency: row.currency,
    reason: row.reason,
    creditForId: row.credit_for_id === null ? null : Number(row.credit_for_id),
    issuedAt: row.issued_at,
    issuedDay: riyadhDate(new Date(row.issued_at)),
  };
}

/** One invoice of this office (ownership check in the query), or null. */
async function getForOffice(pool, officeId, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const scoped = scopeToOffice(pool, officeId);
  return present(await scoped.selectOne('subscription_invoices', { id: Number(id) }));
}

/** The office's invoices and credit notes, newest first. */
async function listForOffice(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const rows = await scoped.select('subscription_invoices', {}, { orderBy: 'id DESC', limit: 100 });
  return rows.map(present);
}

/** Any invoice by id (platform admin only). */
async function getAny(pool, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[row]] = await pool.query('SELECT * FROM subscription_invoices WHERE id = ?', [id]);
  return present(row);
}

module.exports = {
  TITLE_TAX,
  TITLE_RECEIPT,
  formatNumber,
  nextNumber,
  titleFor,
  linesFor,
  issueInvoice,
  issueCreditNote,
  present,
  getForOffice,
  listForOffice,
  getAny,
};
