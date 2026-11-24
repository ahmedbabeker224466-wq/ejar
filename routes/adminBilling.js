'use strict';

// Platform admin: orders, payments, invoices and credit notes, the bank-transfer queue, promo codes and plans.
// Registered on the admin router by routes/admin.js (after its guard), so every
// route here already has requireAuth, requirePerm('platform.access') and the 2FA check.

/* eslint-disable no-unused-vars */
const db = require('../config/db');
const auth = require('../services/auth');
const admin = require('../services/admin');
const officeReview = require('../services/officeReview');
const plans = require('../services/plans');
const promos = require('../services/promos');
const invoices = require('../services/invoices');
const subscriptions = require('../services/subscriptions');
const bankTransfers = require('../services/bankTransfers');
const platformSettings = require('../services/platformSettings');
const { createNotification } = require('../services/notifications');
const images = require('../services/images');
const money = require('../services/money');
const { createAudit } = require('../services/audit');
const auditLabels = require('../services/auditLabels');
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');


module.exports = function registerBilling(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText }) {
// ------------------------------------------------------------ orders, payments, invoices

async function renderOrders(req, res, { error = null, status = 200 } = {}) {
  const filters = {
    status: String(req.query.status || ''),
    method: String(req.query.method || ''),
    suspicious: req.query.suspicious === '1',
  };
  const result = await admin.listOrders(db.pool, { ...filters, page: req.query.page });
  return res.status(status).render('admin/orders', {
    title: 'الطلبات والمدفوعات',
    ...result,
    filters,
    statuses: admin.ORDER_STATUSES,
    payments: await admin.recentPayments(db.pool),
    invoices: await admin.recentInvoices(db.pool),
    error,
    done: doneText(req.query.done),
  });
}

router.get('/admin/orders', wrap((req, res) => renderOrders(req, res)));

router.get('/admin/invoices/:id', wrap(async (req, res) => {
  const invoice = await invoices.getAny(db.pool, req.params.id);
  if (!invoice) return notFound(res);
  return res.render('billing/invoice', { layout: 'layouts/print', title: invoice.title, invoice, fmt: money.formatHalalas, backUrl: '/admin/orders' });
}));

router.post('/admin/invoices/:id/credit-note', wrap(async (req, res) => {
  const invoice = await invoices.getAny(db.pool, req.params.id);
  if (!invoice) return notFound(res);
  const reason = reasonOf(req.body);
  if (!reason) return renderOrders(req, res, { error: REASON_ERROR, status: 422 });
  const result = await invoices.issueCreditNote(db.pool, { invoiceId: invoice.id, reason, issuedBy: req.user.id });
  if (!result.ok) return renderOrders(req, res, { error: 'لا يمكن إصدار إشعار دائن لهذه الفاتورة (سبق إلغاؤها أو ليست فاتورة).', status: 409 });
  await audit.write(req.user.id, invoice.officeId, 'admin.invoice.credit_note', 'invoice', invoice.id,
    { status: 'issued' }, { credit_note_id: result.id, invoice_no: result.invoiceNo, reason }, req.ip);
  try {
    const [[office]] = await db.pool.query('SELECT name, owner_id FROM offices WHERE id = ?', [invoice.officeId]);
    if (office && office.owner_id) {
      await createNotification(db.pool, {
        userId: office.owner_id, officeId: invoice.officeId, kind: 'billing_paid', title: 'تم إصدار إشعار دائن',
        body: `أُصدر إشعار دائن رقم ${result.invoiceNo} لإلغاء الفاتورة ${invoice.invoiceNo}.`,
        link: `/office/billing/invoices/${result.id}`, dedupeKey: `billing_credit:${result.id}`,
      });
    }
  } catch {
    // The credit note is already issued; a missed notification is not an error.
  }
  return res.redirect('/admin/orders?done=credit');
}));

// ------------------------------------------------------------ bank-transfer queue

router.get('/admin/transfers', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '';
  return res.render('admin/transfers', {
    title: 'الحوالات البنكية',
    rows: await bankTransfers.listForAdmin(db.pool, { status }),
    status,
    error: null,
    done: doneText(req.query.done),
  });
}));

async function renderTransfers(req, res, error, status = 422) {
  return res.status(status).render('admin/transfers', {
    title: 'الحوالات البنكية',
    rows: await bankTransfers.listForAdmin(db.pool, {}),
    status: '',
    error,
    done: null,
  });
}

router.post('/admin/transfers/:id/approve', wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return notFound(res);
  const reason = reasonOf(req.body);
  if (!reason) return renderTransfers(req, res, REASON_ERROR);
  const result = await bankTransfers.approve(db.pool, { transferId: Number(req.params.id), adminId: req.user.id, note: reason });
  if (!result.ok && result.error === 'not_found') return notFound(res);
  if (!result.ok) return renderTransfers(req, res, result.error === 'already_decided' ? 'سبق اتخاذ قرار في هذه الحوالة.' : 'تعذّر قبول الحوالة: الطلب لم يعد مفتوحاً أو لا يطابق المبلغ.');
  return res.redirect('/admin/transfers?done=approved');
}));

router.post('/admin/transfers/:id/reject', wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return notFound(res);
  const result = await bankTransfers.reject(db.pool, { transferId: Number(req.params.id), adminId: req.user.id, reason: reasonOf(req.body) || '' });
  if (!result.ok && result.error === 'not_found') return notFound(res);
  if (!result.ok) return renderTransfers(req, res, result.message || 'سبق اتخاذ قرار في هذه الحوالة.');
  return res.redirect('/admin/transfers?done=rejected');
}));

router.get('/admin/transfers/:id/receipt', wrap(async (req, res) => {
  const name = await bankTransfers.receiptFor(db.pool, { transferId: req.params.id });
  const file = name ? images.imagePath(name) : null;
  if (!file) return notFound(res);
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  return res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) notFound(res);
  });
}));

// ------------------------------------------------------------ promo codes

const promoFormValues = (row) => (row ? {
  code: row.code,
  discount_type: row.discount_type,
  percent: row.percent_bp ? String(Number(row.percent_bp) / 100) : '',
  fixed: row.fixed_amount !== null && row.fixed_amount !== undefined ? String(row.fixed_amount) : '',
  valid_from: row.valid_from ? riyadhDate(new Date(row.valid_from)) : '',
  valid_to: promos.endDay(row.valid_to),
  max_redemptions: row.max_redemptions === null ? '' : String(row.max_redemptions),
  plan_ids: promos.planIdsOf(row) || [],
  is_active: Number(row.is_active) === 1,
  note: row.note || '',
} : { code: '', discount_type: 'percent', percent: '', fixed: '', valid_from: '', valid_to: '', max_redemptions: '', plan_ids: [], is_active: true, note: '' });

router.get('/admin/promos', wrap(async (req, res) => {
  return res.render('admin/promos', { title: 'أكواد الخصم', rows: await promos.list(db.pool), done: doneText(req.query.done) });
}));

async function renderPromoForm(res, { row = null, values, errors = {}, status = 200 }) {
  return res.status(status).render('admin/promo-form', {
    title: row ? `كود الخصم ${row.code}` : 'كود خصم جديد',
    row,
    values,
    errors,
    allPlans: await plans.listPlans(db.pool),
  });
}

router.get('/admin/promos/new', wrap((req, res) => renderPromoForm(res, { values: promoFormValues(null) })));

router.post('/admin/promos', wrap(async (req, res) => {
  const { values, errors } = promos.validatePromo(req.body, { creating: true });
  const shown = { ...promoFormValues(null), ...req.body, plan_ids: [].concat(req.body.plan_ids || []).map(Number), is_active: req.body.is_active === '1' };
  const reason = reasonOf(req.body);
  if (!reason) errors.reason = REASON_ERROR;
  if (Object.keys(errors).length) return renderPromoForm(res, { values: shown, errors, status: 422 });
  try {
    const id = await promos.create(db.pool, values, req.user.id);
    await audit.write(req.user.id, null, 'admin.promo.create', 'promo', id, null, {
      code: values.code, type: values.discount_type, percent_bp: values.percent_bp, fixed_halalas: values.fixed_halalas, max_redemptions: values.max_redemptions, reason,
    }, req.ip);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderPromoForm(res, { values: shown, errors: { code: 'هذا الرمز موجود من قبل.' }, status: 422 });
    throw err;
  }
  return res.redirect('/admin/promos?done=created');
}));

router.get('/admin/promos/:id', wrap(async (req, res) => {
  const row = await promos.get(db.pool, req.params.id);
  if (!row) return notFound(res);
  return renderPromoForm(res, { row, values: promoFormValues(row) });
}));

router.post('/admin/promos/:id', wrap(async (req, res) => {
  const row = await promos.get(db.pool, req.params.id);
  if (!row) return notFound(res);
  const { values, errors } = promos.validatePromo(req.body);
  const reason = reasonOf(req.body);
  if (!reason) errors.reason = REASON_ERROR;
  if (Object.keys(errors).length) {
    const shown = { ...promoFormValues(row), ...req.body, plan_ids: [].concat(req.body.plan_ids || []).map(Number), is_active: req.body.is_active === '1' };
    return renderPromoForm(res, { row, values: shown, errors, status: 422 });
  }
  await promos.update(db.pool, row.id, values);
  await audit.write(req.user.id, null, 'admin.promo.update', 'promo', Number(row.id),
    { is_active: Number(row.is_active), max_redemptions: row.max_redemptions },
    { is_active: values.is_active, max_redemptions: values.max_redemptions, type: values.discount_type, reason }, req.ip);
  return res.redirect('/admin/promos?done=saved');
}));

// ------------------------------------------------------------ plans

const planFormValues = (plan) => (plan ? {
  code: plan.code,
  name_ar: plan.name_ar,
  price_monthly: String(plan.price_monthly),
  price_yearly: String(plan.price_yearly),
  max_units: plan.max_units === null ? '' : String(plan.max_units),
  max_contracts: plan.max_contracts === null ? '' : String(plan.max_contracts),
  max_members: plan.max_members === null ? '' : String(plan.max_members),
  max_ai_reads_monthly: plan.max_ai_reads_monthly === null ? '' : String(plan.max_ai_reads_monthly),
  max_photos: plan.max_photos === null ? '' : String(plan.max_photos),
  max_listings: plan.max_listings === null || plan.max_listings === undefined ? '' : String(plan.max_listings),
  features: plans.normalizeFeatures(plan.features),
  is_public: Number(plan.is_public) === 1,
  is_active: Number(plan.is_active) === 1,
  sort_order: String(plan.sort_order),
} : {
  code: '', name_ar: '', price_monthly: '0', price_yearly: '0', max_units: '', max_contracts: '', max_members: '', max_ai_reads_monthly: '', max_photos: '', max_listings: '',
  features: plans.normalizeFeatures(null), is_public: true, is_active: true, sort_order: '0',
});

const planInputValues = (body) => ({
  ...planFormValues(null),
  ...body,
  features: Object.fromEntries(Object.keys(plans.FEATURE_FLAGS).map((f) => [f, body[`feature_${f}`] === '1'])),
  is_public: body.is_public === '1',
  is_active: body.is_active === '1',
});

router.get('/admin/plans', wrap(async (req, res) => {
  return res.render('admin/plans', { title: 'الباقات', rows: await plans.listPlans(db.pool), flags: plans.FEATURE_FLAGS, done: doneText(req.query.done), error: null });
}));

function renderPlanForm(res, { plan = null, values, errors = {}, status = 200 }) {
  return res.status(status).render('admin/plan-form', {
    title: plan ? `الباقة ${plan.name_ar}` : 'باقة جديدة',
    plan,
    values,
    errors,
    flags: plans.FEATURE_FLAGS,
    limits: plans.LIMITS,
  });
}

router.get('/admin/plans/new', (req, res) => renderPlanForm(res, { values: planFormValues(null) }));

router.post('/admin/plans', wrap(async (req, res) => {
  const { values, errors } = plans.validatePlan(req.body, { creating: true });
  const reason = reasonOf(req.body);
  if (!reason) errors.reason = REASON_ERROR;
  if (Object.keys(errors).length) return renderPlanForm(res, { values: planInputValues(req.body), errors, status: 422 });
  let id;
  try {
    id = await plans.createPlan(db.pool, values);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderPlanForm(res, { values: planInputValues(req.body), errors: { code: 'رمز الباقة موجود من قبل.' }, status: 422 });
    throw err;
  }
  await audit.write(req.user.id, null, 'admin.plan.create', 'plan', id, null, { code: values.code, price_monthly: values.priceMonthly, price_yearly: values.priceYearly, reason }, req.ip);
  return res.redirect('/admin/plans?done=created');
}));

router.get('/admin/plans/:id', wrap(async (req, res) => {
  const plan = await plans.getPlan(db.pool, req.params.id);
  if (!plan) return notFound(res);
  return renderPlanForm(res, { plan, values: planFormValues(plan) });
}));

router.post('/admin/plans/:id', wrap(async (req, res) => {
  const plan = await plans.getPlan(db.pool, req.params.id);
  if (!plan) return notFound(res);
  const { values, errors } = plans.validatePlan(req.body);
  const reason = reasonOf(req.body);
  if (!reason) errors.reason = REASON_ERROR;
  if (Object.keys(errors).length) return renderPlanForm(res, { plan, values: { ...planInputValues(req.body), code: plan.code }, errors, status: 422 });
  await plans.updatePlan(db.pool, plan.id, values);
  // A change applies to every subscriber at once; the audit row keeps what moved.
  await audit.write(req.user.id, null, 'admin.plan.update', 'plan', Number(plan.id),
    { price_monthly: money.fromDecimal(plan.price_monthly), price_yearly: money.fromDecimal(plan.price_yearly), max_units: plan.max_units, max_contracts: plan.max_contracts, max_members: plan.max_members, max_ai_reads_monthly: plan.max_ai_reads_monthly, max_photos: plan.max_photos },
    { price_monthly: values.priceMonthly, price_yearly: values.priceYearly, max_units: values.max_units, max_contracts: values.max_contracts, max_members: values.max_members, max_ai_reads_monthly: values.max_ai_reads_monthly, max_photos: values.max_photos, features: values.features, reason }, req.ip);
  return res.redirect('/admin/plans?done=saved');
}));

router.post('/admin/plans/:id/delete', wrap(async (req, res) => {
  const plan = await plans.getPlan(db.pool, req.params.id);
  if (!plan) return notFound(res);
  const reason = reasonOf(req.body);
  const refuse = async (error, status) => res.status(status).render('admin/plans', {
    title: 'الباقات', rows: await plans.listPlans(db.pool), flags: plans.FEATURE_FLAGS, done: null, error,
  });
  if (!reason) return refuse(REASON_ERROR, 422);
  if (!(await plans.deletePlan(db.pool, plan.id))) return refuse('لا يمكن حذف باقة مرتبطة بمكاتب أو طلبات. أوقفها بدلاً من حذفها.', 409);
  await audit.write(req.user.id, null, 'admin.plan.delete', 'plan', Number(plan.id), { code: plan.code }, { reason }, req.ip);
  return res.redirect('/admin/plans?done=deleted');
}));

};
