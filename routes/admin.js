'use strict';

// The platform admin area (/admin). Every page needs a signed-in platform_admin
// (capability 'platform.access'); the admin login already requires 2FA, and the
// guard below refuses a session whose user still has to set it up. Every
// change writes an audit row (services/audit.js), and the actions on an office
// (extend trial, change plan, suspend, unsuspend), a credit note and a
// rejected transfer need a written reason. The area never shows landlord,
// tenant or contract content, and there is no way to act as an office user.

const express = require('express');
const db = require('../config/db');
const auth = require('../services/auth');
const admin = require('../services/admin');
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
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');

const router = express.Router();
const audit = createAudit(db.pool);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const NAV = [
  { key: 'dashboard', href: '/admin', label: 'لوحة المنصة' },
  { key: 'offices', href: '/admin/offices', label: 'المكاتب' },
  { key: 'orders', href: '/admin/orders', label: 'الطلبات والمدفوعات' },
  { key: 'transfers', href: '/admin/transfers', label: 'الحوالات البنكية' },
  { key: 'promos', href: '/admin/promos', label: 'أكواد الخصم' },
  { key: 'plans', href: '/admin/plans', label: 'الباقات' },
  { key: 'reports', href: '/admin/reports', label: 'بلاغات الإعلانات' },
  { key: 'messages', href: '/admin/messages', label: 'رسائل التواصل' },
  { key: 'blog', href: '/admin/blog', label: 'المدونة' },
  { key: 'settings', href: '/admin/settings', label: 'إعدادات المنصة' },
  { key: 'audit', href: '/admin/audit', label: 'سجل التدقيق' },
];

function isCurrent(item, path) {
  if (item.href === '/admin') return path === '/admin' || path === '/admin/';
  return path === item.href || path.startsWith(`${item.href}/`);
}

/** A platform admin session whose user still has to set up 2FA is refused (defence in depth: login never issues one). */
function twoFactorGuard(req, res, next) {
  const user = { role: req.user.role, twofa_enabled: req.user.twofaEnabled };
  if (auth.needsTwoFactor(user) && !req.user.twofaEnabled) {
    return res.status(403).render('errors/403', { title: 'غير متاح', heading: 'فعّل المصادقة الثنائية أولاً', message: 'منطقة إدارة المنصة تتطلب المصادقة الثنائية.' });
  }
  return next();
}

router.use('/admin', noStore, sameOrigin, requireAuth, requirePerm('platform.access'), twoFactorGuard, (req, res, next) => {
  res.locals.layout = 'layouts/admin';
  res.locals.adminNav = NAV.map((item) => ({ ...item, current: isCurrent(item, req.baseUrl + req.path) }));
  res.locals.userDisplay = req.user.name || req.user.phone;
  res.locals.fmt = money.formatHalalas;
  res.locals.fmtDec = (value) => money.formatHalalas(money.fromDecimal(value));
  res.locals.stamp = (at) => (at ? riyadhDate(new Date(at)) : '—');
  res.locals.done = null;
  next();
});

// /platform is where a platform admin lands after login.
router.get('/platform', noStore, requirePerm('platform.access'), (req, res) => res.redirect('/admin'));

const DONE = {
  trial: 'تم تمديد التجربة.',
  plan: 'تم تغيير الباقة.',
  suspend: 'تم إيقاف المكتب.',
  unsuspend: 'تمت إعادة تشغيل المكتب.',
  note: 'تمت إضافة الملاحظة.',
  credit: 'تم إصدار الإشعار الدائن. أعد المبلغ للعميل من لوحة مزوّد الدفع أو البنك.',
  approved: 'تم قبول الحوالة وتفعيل الباقة.',
  rejected: 'تم رفض الحوالة.',
  saved: 'تم الحفظ.',
  created: 'تمت الإضافة.',
  deleted: 'تم الحذف.',
  dismissed: 'تم إغلاق البلاغ دون إجراء.',
  hidden: 'تم إخفاء الإعلان.',
  unhidden: 'أُلغي إخفاء الإدارة؛ على المكتب نشر الإعلان من جديد.',
  banned: 'تم إيقاف نشر الإعلانات لهذا المكتب وإخفاء إعلاناته.',
  unbanned: 'أُعيد حق نشر الإعلانات للمكتب.',
  handled: 'تم تعليم الرسالة كمعالجة.',
  analytics: 'تم حفظ شيفرة التحليلات.',
};
const doneText = (key) => (Object.hasOwn(DONE, key) ? DONE[key] : null);

/** A written reason of 3 to 200 characters, or null. */
function reasonOf(body) {
  const text = String((body && body.reason) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 3 && text.length <= 200 ? text : null;
}
const REASON_ERROR = 'اكتب سبباً للإجراء (من 3 إلى 200 حرف).';

// ------------------------------------------------------------ dashboard

router.get('/admin', wrap(async (req, res) => {
  const data = await admin.overview(db.pool);
  return res.render('admin/dashboard', { title: 'لوحة المنصة', data });
}));

// ------------------------------------------------------------ offices

router.get('/admin/offices', wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 60);
  const status = String(req.query.status || '');
  const result = await admin.listOffices(db.pool, { q, status, page: req.query.page });
  return res.render('admin/offices', { title: 'المكاتب', ...result, q, status, statuses: admin.OFFICE_STATUSES });
}));

async function renderOffice(req, res, { error = null, status = 200, values = {} } = {}) {
  const detail = await admin.officeDetail(db.pool, req.params.id);
  if (!detail) return notFound(res);
  return res.status(status).render('admin/office', {
    title: detail.office.name,
    ...detail,
    allPlans: await plans.listPlans(db.pool),
    error,
    values,
    done: doneText(req.query.done),
  });
}

router.get('/admin/offices/:id', wrap((req, res) => renderOffice(req, res)));

/** Runs an office action when the office exists and a reason was written. */
function officeAction(handler) {
  return wrap(async (req, res) => {
    const found = await admin.officeDetail(db.pool, req.params.id);
    if (!found) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return renderOffice(req, res, { error: REASON_ERROR, status: 422, values: req.body });
    return handler({ req, res, office: found.office, reason });
  });
}

router.post('/admin/offices/:id/extend-trial', officeAction(async ({ req, res, office, reason }) => {
  const days = /^\d{1,2}$/.test(String(req.body.days)) ? Number(req.body.days) : 0;
  if (days < 1 || days > 90) return renderOffice(req, res, { error: 'اكتب عدد أيام من 1 إلى 90.', status: 422, values: req.body });
  const end = await subscriptions.extendTrial(db.pool, { officeId: office.id, days });
  if (!end) return renderOffice(req, res, { error: 'التمديد متاح للمكاتب في الفترة التجريبية فقط.', status: 422, values: req.body });
  await audit.write(req.user.id, office.id, 'admin.office.extend_trial', 'office', office.id,
    { trial_ends_at: office.trial_ends_at }, { trial_ends_at: end, days, reason }, req.ip);
  return res.redirect(`/admin/offices/${office.id}?done=trial`);
}));

router.post('/admin/offices/:id/plan', officeAction(async ({ req, res, office, reason }) => {
  const plan = await plans.getPlan(db.pool, req.body.plan_id);
  if (!plan) return renderOffice(req, res, { error: 'اختر الباقة.', status: 422, values: req.body });
  const check = plans.checkDowngrade(plan, await plans.usageFor(db.pool, office.id));
  if (!check.ok) return renderOffice(req, res, { error: check.message, status: 422, values: req.body });
  await subscriptions.setPlan(db.pool, { officeId: office.id, planId: plan.id });
  await audit.write(req.user.id, office.id, 'admin.office.change_plan', 'office', office.id,
    { plan_id: office.plan_id }, { plan_id: Number(plan.id), reason }, req.ip);
  return res.redirect(`/admin/offices/${office.id}?done=plan`);
}));

router.post('/admin/offices/:id/suspend', officeAction(async ({ req, res, office, reason }) => {
  await subscriptions.suspend(db.pool, { officeId: office.id });
  await audit.write(req.user.id, office.id, 'admin.office.suspend', 'office', office.id, { status: office.status }, { status: 'suspended', reason }, req.ip);
  return res.redirect(`/admin/offices/${office.id}?done=suspend`);
}));

router.post('/admin/offices/:id/unsuspend', officeAction(async ({ req, res, office, reason }) => {
  const status = await subscriptions.unsuspend(db.pool, { officeId: office.id });
  await audit.write(req.user.id, office.id, 'admin.office.unsuspend', 'office', office.id, { status: office.status }, { status, reason }, req.ip);
  return res.redirect(`/admin/offices/${office.id}?done=unsuspend`);
}));

router.post('/admin/offices/:id/note', wrap(async (req, res) => {
  const found = await admin.officeDetail(db.pool, req.params.id);
  if (!found) return notFound(res);
  const text = String(req.body.body ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (text.length < 3) return renderOffice(req, res, { error: 'اكتب نص الملاحظة (3 أحرف على الأقل).', status: 422, values: req.body });
  const noteId = await admin.addNote(db.pool, { officeId: found.office.id, authorId: req.user.id, body: text });
  // The note text is the reason of this action.
  await audit.write(req.user.id, found.office.id, 'admin.office.note', 'office', found.office.id, null, { note_id: noteId, reason: text.slice(0, 200) }, req.ip);
  return res.redirect(`/admin/offices/${found.office.id}?done=note`);
}));

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

// ------------------------------------------------------------ platform settings and kill switches

async function renderSettings(req, res, { errors = {}, values = null, status = 200 } = {}) {
  const seller = await platformSettings.seller();
  const bank = await platformSettings.bank();
  const support = await platformSettings.support();
  const switches = await platformSettings.switches();
  return res.status(status).render('admin/settings', {
    title: 'إعدادات المنصة',
    values: values || {
      legal_name: seller.legal_name, vat_number: seller.vat_number, address: seller.address, cr_number: seller.cr_number,
      bank_name: bank.name, bank_account_name: bank.account_name, bank_iban: bank.iban,
      support_phone: support.phone, support_email: support.email,
    },
    errors,
    switches,
    analytics: await platformSettings.get(platformSettings.KEYS.analyticsSnippet),
    done: doneText(req.query.done),
  });
}

router.get('/admin/settings', wrap((req, res) => renderSettings(req, res)));

router.post('/admin/settings/details', wrap(async (req, res) => {
  const { values, errors } = platformSettings.validateDetails(req.body);
  const reason = reasonOf(req.body);
  if (!reason) errors.reason = REASON_ERROR;
  if (Object.keys(errors).length) return renderSettings(req, res, { errors, values: req.body, status: 422 });
  const changed = await platformSettings.save(db.pool, values);
  // Only the names of the changed settings are logged, not their values.
  await audit.write(req.user.id, null, 'admin.settings.details', 'settings', null, null, { changed, reason }, req.ip);
  return res.redirect('/admin/settings?done=saved');
}));

router.post('/admin/settings/switches', wrap(async (req, res) => {
  const reason = reasonOf(req.body);
  if (!reason) return renderSettings(req, res, { errors: { reason_switches: REASON_ERROR }, status: 422 });
  const before = await platformSettings.switches();
  const values = platformSettings.switchValues(req.body);
  await platformSettings.save(db.pool, values);
  await audit.write(req.user.id, null, 'admin.settings.switches', 'settings', null,
    { signups_disabled: before.signupsDisabled, ai_disabled: before.aiDisabled, banner_set: Boolean(before.banner) },
    { signups_disabled: values[platformSettings.KEYS.signupsDisabled] === '1', ai_disabled: values[platformSettings.KEYS.aiDisabled] === '1', banner_set: Boolean(values[platformSettings.KEYS.bannerMessage]), reason }, req.ip);
  return res.redirect('/admin/settings?done=saved');
}));

// ------------------------------------------------------------ audit viewer

router.get('/admin/audit', wrap(async (req, res) => {
  const filters = {
    action: String(req.query.action || '').slice(0, 60),
    officeId: String(req.query.office || '').slice(0, 12),
    actor: String(req.query.actor || '').slice(0, 20),
    from: String(req.query.from || '').slice(0, 10),
    to: String(req.query.to || '').slice(0, 10),
  };
  const result = await admin.listAudit(db.pool, { ...filters, page: req.query.page });
  const parse = (value) => {
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      return null;
    }
  };
  const rows = result.rows.map((r) => {
    const after = parse(r.after_json);
    return { ...r, reason: after && typeof after.reason === 'string' ? after.reason : '' };
  });
  return res.render('admin/audit', { title: 'سجل التدقيق', ...result, rows, filters });
}));

require('./adminContent')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });

module.exports = router;
