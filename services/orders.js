'use strict';

// Orders: one per attempt to buy or renew a plan (Moyasar or bank transfer).
//
//   createOrder   quote + promo reservation + the order row, in ONE
//                 transaction with the office row locked first
//   settle        the only place an order becomes paid: locks the order,
//                 records the payment once (UNIQUE provider + reference),
//                 activates the plan, issues the invoice, redeems the promo
//   settleMoyasar fetches the payment from Moyasar by id (never trusts the
//                 redirect or the webhook body) and settles or flags it
//
// A payment whose amount, currency or order does not match marks the order
// "suspicious", activates nothing and alerts the platform admin.

const billing = require('../config/billing');
const money = require('./money');
const pricing = require('./pricing');
const plans = require('./plans');
const promos = require('./promos');
const invoices = require('./invoices');
const subscriptions = require('./subscriptions');
const moyasar = require('./moyasar');
const platformSettings = require('./platformSettings');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createNotification } = require('./notifications');
const { createAudit } = require('./audit');
const { hoursAfter, riyadhDate } = require('./contractDates');
const logger = require('../utils/logger');

const METHODS = ['moyasar', 'bank_transfer'];

/** Shapes an order row: money as halalas. */
function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    officeId: Number(row.office_id),
    planId: row.plan_id === null ? null : Number(row.plan_id),
    planCode: row.plan_code,
    interval: row.billing_interval,
    method: row.method,
    status: row.status,
    suspicious: Boolean(Number(row.suspicious)),
    failReason: row.fail_reason,
    subtotal: money.fromDecimal(row.subtotal),
    discount: money.fromDecimal(row.discount),
    vatRateBp: Number(row.vat_rate_bp),
    vat: money.fromDecimal(row.vat_amount),
    total: money.fromDecimal(row.total),
    totalHalalas: money.fromDecimal(row.total),
    currency: row.currency,
    promoCode: row.promo_code,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    invoiceId: row.invoice_id === null ? null : Number(row.invoice_id),
    createdAt: row.created_at,
  };
}

async function getForOffice(pool, officeId, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const scoped = scopeToOffice(pool, officeId);
  return present(await scoped.selectOne('orders', { id: Number(id) }));
}

async function getAny(pool, id) {
  if (!/^\d+$/.test(String(id))) return null;
  const [[row]] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  return present(row);
}

/** The office's open bank-transfer orders (waiting for the transfer or the admin). */
async function pendingTransfersFor(pool, officeId) {
  const scoped = scopeToOffice(pool, officeId);
  const rows = await scoped.query(
    `SELECT o.*, t.status AS transfer_status, t.id AS transfer_id FROM orders o
       LEFT JOIN bank_transfers t ON t.order_id = o.id
      WHERE o.office_id = :office_id AND o.status = 'pending' AND o.method = 'bank_transfer' ORDER BY o.id DESC LIMIT 5`,
  );
  return rows.map((r) => ({ ...present(r), transferId: r.transfer_id === null ? null : Number(r.transfer_id), transferStatus: r.transfer_status }));
}

// ------------------------------------------------------------ create

/**
 * Creates a pending order. Returns { ok: true, order } or
 * { ok: false, error, message } with error one of:
 * bad_input | admin_suspended | plan_unavailable | downgrade | promo.
 */
async function createOrder(pool, { officeId, userId, planId, interval, method, promoCode = '', now = new Date() }) {
  if (!Object.hasOwn(billing.INTERVAL_MONTHS, interval) || !METHODS.includes(method)) {
    return { ok: false, error: 'bad_input', message: 'اختر الباقة وطريقة الدفع.' };
  }
  return withTransaction(pool, async (conn) => {
    const scoped = scopeToOffice(conn, officeId);
    // The office row first: parallel orders of one office queue up here.
    const [office] = await scoped.query('SELECT id, name FROM offices WHERE id = :office_id FOR UPDATE');
    if (!office) return { ok: false, error: 'bad_input', message: 'المكتب غير موجود.' };
    if (await subscriptions.isAdminSuspended(conn, officeId)) {
      return { ok: false, error: 'admin_suspended', message: 'حساب المكتب موقوف من الإدارة. تواصل مع الدعم.' };
    }

    const plan = await plans.getPlan(conn, planId);
    const price = plan ? pricing.planPrice(plan, interval) : 0;
    if (!plan || !Number(plan.is_active) || !Number(plan.is_public) || price <= 0) {
      return { ok: false, error: 'plan_unavailable', message: 'هذه الباقة غير متاحة للشراء.' };
    }
    const usage = await plans.usageFor(conn, officeId, now);
    const downgrade = plans.checkDowngrade(plan, usage);
    if (!downgrade.ok) return { ok: false, error: 'downgrade', message: downgrade.message, problems: downgrade.problems };

    // An earlier unpaid order of this office is replaced by this one.
    const stale = await scoped.query(
      `SELECT o.id FROM orders o
        WHERE o.office_id = :office_id AND o.status = 'pending' AND o.suspicious = 0
          AND NOT EXISTS (SELECT 1 FROM bank_transfers t WHERE t.order_id = o.id) FOR UPDATE`,
    );
    for (const { id } of stale) {
      await scoped.query("UPDATE orders SET status = 'expired' WHERE id = ? AND office_id = :office_id", [id]);
      await promos.release(conn, id);
    }

    let promo = null;
    if (String(promoCode || '').trim()) {
      const checked = await promos.lockAndCheck(conn, { code: promoCode, officeId, planId: plan.id, now });
      if (!checked.ok) return { ok: false, error: 'promo', message: checked.message };
      promo = checked.promo;
    }
    const q = pricing.quote({ price, promo: promos.forQuote(promo) });
    const ttl = method === 'bank_transfer' ? billing.BANK_ORDER_TTL_HOURS : billing.ORDER_TTL_HOURS;
    const orderId = await scoped.insert('orders', {
      plan_id: plan.id,
      plan_code: plan.code,
      billing_interval: interval,
      method,
      status: 'pending',
      subtotal: money.toDecimal(q.subtotal),
      discount: money.toDecimal(q.discount),
      vat_rate_bp: q.vatBp,
      vat_amount: money.toDecimal(q.vat),
      total: money.toDecimal(q.total),
      currency: billing.CURRENCY,
      promo_id: promo ? promo.id : null,
      promo_code: promo ? promo.code : null,
      created_by: userId,
      expires_at: hoursAfter(now, ttl),
    });
    if (promo) await promos.recordUsage(conn, { promoId: promo.id, officeId, orderId });
    const [row] = await scoped.query('SELECT * FROM orders WHERE id = ? AND office_id = :office_id', [orderId]);
    return { ok: true, order: present(row), quote: q };
  });
}

// ------------------------------------------------------------ settle

async function alertAdmins(pool, { title, body, dedupeKey, now = new Date() }) {
  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'platform_admin' AND is_active = 1");
  for (const { id } of admins) {
    await createNotification(pool, {
      userId: id, kind: 'billing_alert', title, body, link: '/admin/orders', dedupeKey: `${dedupeKey}:u${id}`, urgent: true, now,
    });
  }
}

/** Marks a pending order failed and frees its promo. Returns true when it changed. */
async function failOrder(pool, { orderId, reason }) {
  return withTransaction(pool, async (conn) => {
    const [[order]] = await conn.query('SELECT id, status FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order || order.status !== 'pending') return false;
    await conn.query("UPDATE orders SET status = 'failed', fail_reason = ? WHERE id = ?", [String(reason).slice(0, 40), orderId]);
    await promos.release(conn, orderId);
    return true;
  });
}

/**
 * Settles an order with a confirmed payment. Idempotent by (provider, providerRef):
 *   { status: 'paid', ... }        activated now
 *   { status: 'replay' }           this payment was already recorded (no change)
 *   { status: 'suspicious' }       amount/currency mismatch (nothing activated, admin alerted)
 *   { status: 'duplicate' }        a second payment for an order already paid (flagged, admin alerted)
 *   { status: 'not_found' }
 * Late payments (the order already failed or expired) are accepted when they match.
 */
async function settleInTx(conn, { orderId, provider, providerRef, amount, currency, last4 = null, confirmedBy = null, now = new Date(), seller }) {
  const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
  if (!order) return { status: 'not_found' };
  const [[known]] = await conn.query('SELECT id FROM platform_payments WHERE provider = ? AND provider_ref = ?', [provider, providerRef]);
  if (known) return { status: 'replay', orderId: Number(order.id), officeId: Number(order.office_id) };

  const expected = money.fromDecimal(order.total);
  const record = (status, invoiceId = null) => conn.query(
    `INSERT INTO platform_payments (office_id, order_id, invoice_id, provider, provider_ref, amount, currency, status, card_last4, confirmed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order.office_id, order.id, invoiceId, provider, providerRef, money.toDecimal(amount), String(currency || order.currency).slice(0, 3), status, last4, confirmedBy],
  );

  if (order.status === 'paid') {
    await record('pending');
    await conn.query("UPDATE orders SET suspicious = 1, fail_reason = 'duplicate_payment' WHERE id = ?", [order.id]);
    return { status: 'duplicate', orderId: Number(order.id), officeId: Number(order.office_id) };
  }
  if (amount !== expected || String(currency || '').toUpperCase() !== order.currency) {
    await record('pending');
    await conn.query("UPDATE orders SET suspicious = 1, fail_reason = 'amount_mismatch' WHERE id = ?", [order.id]);
    await createAudit(conn).write(confirmedBy, order.office_id, 'billing.suspicious', 'order', order.id, null, { provider, reason: 'amount_mismatch' }, null);
    return { status: 'suspicious', orderId: Number(order.id), officeId: Number(order.office_id) };
  }

  const [[plan]] = await conn.query('SELECT id, name_ar FROM plans WHERE id = ?', [order.plan_id]);
  if (!plan) return { status: 'not_found' };
  const [[office]] = await conn.query('SELECT name, owner_id FROM offices WHERE id = ?', [order.office_id]);
  const period = await subscriptions.activate(conn, {
    officeId: Number(order.office_id), planId: Number(plan.id), interval: order.billing_interval, orderId: Number(order.id), price: money.fromDecimal(order.subtotal), now,
  });
  const invoice = await invoices.issueInvoice(conn, {
    order, officeName: office.name, planName: plan.name_ar, subscriptionId: period.subscriptionId,
    periodFrom: riyadhDate(period.periodStart), periodTo: riyadhDate(new Date(period.periodEnd.getTime() - 1)),
    seller, issuedBy: confirmedBy, now,
  });
  await record('paid', invoice.id);
  await conn.query("UPDATE orders SET status = 'paid', paid_at = ?, invoice_id = ?, fail_reason = NULL WHERE id = ?", [now, invoice.id, order.id]);
  await promos.markRedeemed(conn, { orderId: Number(order.id), promoId: order.promo_id, officeId: Number(order.office_id) });
  await createAudit(conn).write(confirmedBy, order.office_id, 'billing.paid', 'order', order.id, null, {
    provider, plan: order.plan_code, interval: order.billing_interval, invoice_no: invoice.invoiceNo,
  }, null);
  return {
    status: 'paid', orderId: Number(order.id), officeId: Number(order.office_id), ownerId: office.owner_id,
    officeName: office.name, planName: plan.name_ar, periodEnd: period.periodEnd, invoiceId: invoice.id, invoiceNo: invoice.invoiceNo,
  };
}

/**
 * Notifications after a settle commit (a failure here never undoes a payment):
 * the owner is told about a payment, the platform admin about a bad one.
 */
async function afterSettle(pool, outcome, providerRef, now = new Date()) {
  try {
    if (outcome.status === 'paid' && outcome.ownerId) {
      await createNotification(pool, {
        userId: outcome.ownerId, officeId: outcome.officeId, kind: 'billing_paid', title: 'تم تأكيد دفع الاشتراك',
        body: `تم تفعيل باقة ${outcome.planName} لمكتب ${outcome.officeName} حتى ${riyadhDate(new Date(outcome.periodEnd.getTime() - 1))}. رقم الفاتورة: ${outcome.invoiceNo}.`,
        link: `/office/billing/invoices/${outcome.invoiceId}`, dedupeKey: `billing_paid:order${outcome.orderId}`, now,
      });
    } else if (outcome.status === 'suspicious' || outcome.status === 'duplicate') {
      await alertAdmins(pool, {
        title: outcome.status === 'suspicious' ? 'دفعة لا تطابق الطلب' : 'دفعة مكررة لطلب مدفوع',
        body: `طلب رقم ${outcome.orderId}: ${outcome.status === 'suspicious' ? 'المبلغ أو العملة لا يطابق الطلب، لم يُفعَّل الاشتراك.' : 'وصلت دفعة ثانية لطلب مدفوع.'} راجع صفحة الطلبات.`,
        dedupeKey: `billing_alert:${outcome.status}:order${outcome.orderId}:${providerRef}`, now,
      });
    }
  } catch (err) {
    logger.error(`Billing notification failed: ${err.code || err.name}`);
  }
}

/** settleInTx in its own transaction, then the notifications. */
async function settle(pool, params) {
  const seller = await platformSettings.seller(pool);
  const outcome = await withTransaction(pool, (conn) => settleInTx(conn, { ...params, seller }));
  await afterSettle(pool, outcome, params.providerRef, params.now);
  return outcome;
}

/**
 * Verifies a Moyasar payment by fetching it, then settles or flags the order.
 * Used by the redirect callback and the webhook (both only pass an id).
 * Returns { status } like settle(), plus 'failed' | 'pending' | 'unverified' | 'mismatch'.
 */
async function settleMoyasar(pool, { paymentId, expectOrderId = null, now = new Date(), env = process.env }) {
  const fetched = await moyasar.fetchPayment(paymentId, env);
  if (!fetched.ok) return { status: 'unverified', error: fetched.error };
  const { payment } = fetched;
  const orderId = payment.orderId || (expectOrderId ? String(expectOrderId) : null);
  if (!orderId) return { status: 'unverified', error: 'no_order' };
  if (expectOrderId && payment.orderId && String(expectOrderId) !== payment.orderId) return { status: 'mismatch' };

  if (payment.status === 'paid') {
    if (payment.amount === null) return { status: 'unverified', error: 'bad_reply' };
    return settle(pool, {
      orderId: Number(orderId), provider: 'moyasar', providerRef: payment.id, amount: payment.amount, currency: payment.currency, last4: payment.last4, now,
    });
  }
  if (payment.status === 'failed') {
    await failOrder(pool, { orderId: Number(orderId), reason: 'payment_failed' });
    return { status: 'failed', orderId: Number(orderId) };
  }
  return { status: 'pending', orderId: Number(orderId) };
}

/** An order whose total is zero after a promo is settled without a payment. */
async function settleFree(pool, { orderId, confirmedBy = null, now = new Date() }) {
  return settle(pool, {
    orderId, provider: 'manual', providerRef: `free-order-${orderId}`, amount: 0, currency: billing.CURRENCY, confirmedBy, now,
  });
}

module.exports = {
  METHODS,
  present,
  getForOffice,
  getAny,
  pendingTransfersFor,
  createOrder,
  alertAdmins,
  failOrder,
  settleInTx,
  afterSettle,
  settle,
  settleMoyasar,
  settleFree,
};
