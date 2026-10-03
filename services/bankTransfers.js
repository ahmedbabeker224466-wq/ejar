'use strict';

// Bank-transfer payment: the office transfers the money itself, then sends a
// short reference (never an account number, an IBAN or a long digit string)
// and an optional receipt image. The platform admin approves or rejects in a
// queue. Approval settles the order in the same transaction (activates the
// plan, issues the invoice); both sides are notified.
//
// Receipt images are re-encoded by sharp (no metadata), stored under a random
// name in UPLOAD_DIR (outside public) and served only by an authenticated
// route (routes/billing.js) to the office's owner and the platform admin.

const money = require('./money');
const orders = require('./orders');
const images = require('./images');
const platformSettings = require('./platformSettings');
const { validateReference } = require('./paymentEntries');
const { scopeToOffice } = require('./scopeToOffice');
const { withTransaction } = require('./transaction');
const { createNotification } = require('./notifications');
const { createAudit } = require('./audit');
const promos = require('./promos');
const logger = require('../utils/logger');

const IMAGE_ERRORS = {
  type: 'الإيصال يجب أن يكون صورة JPG أو PNG أو WebP.',
  size: 'حجم الصورة كبير (الحد 5 ميجابايت).',
  empty: 'ملف الإيصال فارغ.',
  corrupt: 'تعذّرت قراءة صورة الإيصال. جرّب صورة أخرى.',
};

/** Checks the submit form's reference. Returns { value } or { error }. */
function checkReference(input) {
  const checked = validateReference(input);
  if (checked.error) return checked;
  if (!checked.value || checked.value.length < 3) return { error: 'اكتب رمز مرجع الحوالة (3 أحرف على الأقل).' };
  return checked;
}

/**
 * The office sends its transfer reference (and a receipt) for one of its
 * pending bank-transfer orders. Returns { ok: true, id } or { ok: false, error, message }.
 */
async function submit(pool, { officeId, orderId, userId, reference, receipt = null, now = new Date() }) {
  const checked = checkReference(reference);
  if (checked.error) return { ok: false, error: 'reference', message: checked.error };

  let stored = null;
  if (receipt && receipt.data && receipt.data.length > 0) {
    const processed = await images.processImage(receipt.data, { truncated: Boolean(receipt.truncated) });
    if (!processed.ok) return { ok: false, error: 'receipt', message: IMAGE_ERRORS[processed.error] || IMAGE_ERRORS.corrupt };
    stored = await images.saveImage(processed.buffer);
  }

  try {
    const result = await withTransaction(pool, async (conn) => {
      const scoped = scopeToOffice(conn, officeId);
      const [order] = await scoped.query("SELECT id, method, status, total FROM orders WHERE id = ? AND office_id = :office_id FOR UPDATE", [orderId]);
      if (!order || order.method !== 'bank_transfer') return { ok: false, error: 'not_found', message: 'الطلب غير موجود.' };
      if (order.status !== 'pending') return { ok: false, error: 'closed', message: 'هذا الطلب لم يعد مفتوحاً. ابدأ طلباً جديداً.' };
      const [existing] = await scoped.query('SELECT id FROM bank_transfers WHERE order_id = ? AND office_id = :office_id', [orderId]);
      if (existing) return { ok: false, error: 'duplicate', message: 'أرسلت مرجع هذه الحوالة من قبل، وهي بانتظار المراجعة.' };
      const id = await scoped.insert('bank_transfers', {
        order_id: orderId, reference: checked.value, receipt_path: stored ? stored.name : null, status: 'pending', submitted_by: userId,
      });
      await createAudit(conn).write(userId, officeId, 'billing.transfer_submit', 'bank_transfer', id, null, { order_id: Number(orderId), has_receipt: Boolean(stored) }, null);
      return { ok: true, id };
    });
    if (!result.ok && stored) await images.deleteImage(stored.name);
    if (result.ok) {
      try {
        await orders.alertAdmins(pool, {
          title: 'حوالة بنكية جديدة بانتظار المراجعة',
          body: `طلب رقم ${orderId}: أرسل مكتب مرجع حوالة بنكية. راجع قائمة الحوالات.`,
          dedupeKey: `billing_alert:transfer:${result.id}`, now,
        });
      } catch (err) {
        logger.error(`Transfer alert failed: ${err.code || err.name}`);
      }
    }
    return result;
  } catch (err) {
    if (stored) await images.deleteImage(stored.name).catch(() => {});
    throw err;
  }
}

/** The admin queue: transfers with their order, newest first. status '' = all. */
async function listForAdmin(pool, { status = '' } = {}) {
  const where = ['pending', 'approved', 'rejected'].includes(status) ? 'WHERE t.status = ?' : '';
  const [rows] = await pool.query(
    `SELECT t.id, t.office_id, t.order_id, t.reference, t.receipt_path, t.status, t.decision_note, t.decided_at, t.created_at,
            o.name AS office_name, r.total, r.currency, r.plan_code, r.billing_interval, r.status AS order_status
       FROM bank_transfers t
       JOIN offices o ON o.id = t.office_id
       JOIN orders r ON r.id = t.order_id
       ${where} ORDER BY (t.status = 'pending') DESC, t.id DESC LIMIT 200`,
    where ? [status] : [],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    officeId: Number(r.office_id),
    officeName: r.office_name,
    orderId: Number(r.order_id),
    reference: r.reference,
    hasReceipt: Boolean(r.receipt_path),
    status: r.status,
    note: r.decision_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    total: money.fromDecimal(r.total),
    currency: r.currency,
    planCode: r.plan_code,
    interval: r.billing_interval,
    orderStatus: r.order_status,
  }));
}

/**
 * Approves a pending transfer: the order is settled (plan active, invoice
 * issued) and the transfer marked approved in ONE transaction. Returns
 * { ok: true, invoiceNo } or { ok: false, error }.
 */
async function approve(pool, { transferId, adminId, note = '', now = new Date() }) {
  const seller = await platformSettings.seller(pool);
  const result = await withTransaction(pool, async (conn) => {
    const [[transfer]] = await conn.query('SELECT * FROM bank_transfers WHERE id = ? FOR UPDATE', [transferId]);
    if (!transfer) return { ok: false, error: 'not_found' };
    if (transfer.status !== 'pending') return { ok: false, error: 'already_decided' };
    const [[order]] = await conn.query('SELECT id, total, currency, status FROM orders WHERE id = ?', [transfer.order_id]);
    const outcome = await orders.settleInTx(conn, {
      orderId: Number(transfer.order_id), provider: 'bank_transfer', providerRef: `bt-${transfer.id}`,
      amount: money.fromDecimal(order.total), currency: order.currency, confirmedBy: adminId, now, seller,
    });
    if (outcome.status !== 'paid') return { ok: false, error: 'not_settled', outcome };
    await conn.query(
      "UPDATE bank_transfers SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?",
      [adminId, now, String(note).slice(0, 200) || null, transfer.id],
    );
    await createAudit(conn).write(adminId, transfer.office_id, 'billing.transfer_approve', 'bank_transfer', transfer.id, { status: 'pending' }, { status: 'approved', reason: String(note || 'approved').slice(0, 200) }, null);
    return { ok: true, invoiceNo: outcome.invoiceNo, outcome, officeId: Number(transfer.office_id) };
  });
  if (result.ok) await orders.afterSettle(pool, result.outcome, `bt-${transferId}`, now);
  return result;
}

/** Rejects a pending transfer with a reason; the order fails and its promo is freed. */
async function reject(pool, { transferId, adminId, reason, now = new Date() }) {
  const text = String(reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  if (text.length < 3) return { ok: false, error: 'reason', message: 'اكتب سبب الرفض (3 أحرف على الأقل).' };
  const result = await withTransaction(pool, async (conn) => {
    const [[transfer]] = await conn.query('SELECT * FROM bank_transfers WHERE id = ? FOR UPDATE', [transferId]);
    if (!transfer) return { ok: false, error: 'not_found' };
    if (transfer.status !== 'pending') return { ok: false, error: 'already_decided' };
    const [[order]] = await conn.query('SELECT id, status FROM orders WHERE id = ? FOR UPDATE', [transfer.order_id]);
    if (order.status === 'pending') {
      await conn.query("UPDATE orders SET status = 'failed', fail_reason = 'transfer_rejected' WHERE id = ?", [order.id]);
      await promos.release(conn, order.id);
    }
    await conn.query(
      "UPDATE bank_transfers SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?",
      [adminId, now, text, transfer.id],
    );
    await createAudit(conn).write(adminId, transfer.office_id, 'billing.transfer_reject', 'bank_transfer', transfer.id, { status: 'pending' }, { status: 'rejected', reason: text }, null);
    return { ok: true, officeId: Number(transfer.office_id), orderId: Number(order.id) };
  });
  if (result.ok) {
    try {
      const [[office]] = await pool.query('SELECT name, owner_id FROM offices WHERE id = ?', [result.officeId]);
      if (office && office.owner_id) {
        await createNotification(pool, {
          userId: office.owner_id, officeId: result.officeId, kind: 'billing_transfer', title: 'تم رفض الحوالة البنكية',
          body: `لم تُقبل حوالة طلب رقم ${result.orderId} لمكتب ${office.name}. السبب: ${text}. يمكنك بدء طلب جديد من صفحة الاشتراك.`,
          link: '/office/billing', dedupeKey: `billing_transfer:reject:${transferId}`, urgent: true, now,
        });
      }
    } catch (err) {
      logger.error(`Transfer notification failed: ${err.code || err.name}`);
    }
  }
  return result;
}

/**
 * A receipt file name, but only for the office that sent it (billing capability
 * is checked by the route) or the platform admin (officeId null = any).
 */
async function receiptFor(pool, { transferId, officeId = null }) {
  if (!/^\d+$/.test(String(transferId))) return null;
  const [[row]] = await pool.query('SELECT office_id, receipt_path FROM bank_transfers WHERE id = ?', [transferId]);
  if (!row || !row.receipt_path) return null;
  if (officeId !== null && Number(row.office_id) !== Number(officeId)) return null;
  return row.receipt_path;
}

module.exports = { IMAGE_ERRORS, checkReference, submit, listForAdmin, approve, reject, receiptFor };
