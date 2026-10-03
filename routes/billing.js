'use strict';

// Subscription billing for the office owner (/office/billing/*, capability
// 'billing') and the Moyasar webhook (/webhooks/moyasar).
//
// Two routers are exported: `office` (mounted in routes/office.js, after
// loadOffice) and `webhook` (mounted in routes/areas.js, no session).
//
// Payment is never trusted from the browser: the Moyasar redirect and the
// webhook only carry a payment id; services/orders.js settleMoyasar() fetches
// the payment from Moyasar and compares amount, currency and order.

const express = require('express');
const fileUpload = require('express-fileupload');
const db = require('../config/db');
const billing = require('../config/billing');
const plans = require('../services/plans');
const pricing = require('../services/pricing');
const promos = require('../services/promos');
const orders = require('../services/orders');
const invoices = require('../services/invoices');
const subscriptions = require('../services/subscriptions');
const bankTransfers = require('../services/bankTransfers');
const moyasar = require('../services/moyasar');
const platformSettings = require('../services/platformSettings');
const images = require('../services/images');
const money = require('../services/money');
const logger = require('../utils/logger');
const { riyadhDate } = require('../services/contractDates');
const { requirePerm } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');

const INTERVAL_LABELS = { monthly: 'شهري', yearly: 'سنوي' };

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const NOTICES = {
  paid: ['success', 'تم تأكيد الدفع وتفعيل باقتك. شكراً لك.'],
  failed: ['danger', 'لم تتم عملية الدفع. لم يُخصم منك شيء. جرّب مرة أخرى أو اختر الحوالة البنكية.'],
  pending: ['info', 'عملية الدفع ما زالت قيد المعالجة. سنؤكدها تلقائياً خلال دقائق.'],
  unverified: ['warning', 'تعذّر تأكيد الدفع الآن. إن خُصم المبلغ فسنفعّل باقتك تلقائياً خلال دقائق.'],
  suspicious: ['warning', 'وصلت دفعة لا تطابق الطلب. لم نفعّل الباقة وسنراجعها مع الدعم.'],
  transfer: ['success', 'استلمنا مرجع الحوالة. سنراجعها ونفعّل باقتك فور التأكيد.'],
  free: ['success', 'تم تفعيل باقتك.'],
};

const siteUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// ------------------------------------------------------------ the page

async function planCards(currentPlanId) {
  const list = await plans.listPlans(db.pool, { onlyBuyable: true });
  return list.map((plan) => ({
    id: Number(plan.id),
    name: plan.name_ar,
    current: Number(plan.id) === Number(currentPlanId),
    monthly: pricing.planPrice(plan, 'monthly'),
    yearly: pricing.planPrice(plan, 'yearly'),
    limits: plans.usageRows(plan, { units: 0, contracts: 0, members: 0, aiReads: 0, photos: 0 }).map((r) => ({ label: r.label, unit: r.unit, limit: r.limit })),
    features: Object.entries(plans.normalizeFeatures(plan.features)).map(([flag, on]) => ({ label: plans.FEATURE_FLAGS[flag], on })),
  }));
}

function statusLine(office, access) {
  const endOf = (at) => riyadhDate(new Date(new Date(at).getTime() - 1));
  if (access.onTrial) return { label: 'تجربة مجانية', tone: 'info', until: office.trial_ends_at ? endOf(office.trial_ends_at) : null };
  if (access.readOnly) return { label: 'منتهي — وضع القراءة فقط', tone: 'danger', until: endOf(office.subscription_ends_at) };
  if (access.locked) return { label: access.reason === 'suspended' ? 'موقوف' : 'منتهي', tone: 'danger', until: null };
  if (access.pastDue) return { label: 'غير مسدَّد', tone: 'danger', until: office.subscription_ends_at ? endOf(office.subscription_ends_at) : null };
  return { label: 'فعّال', tone: 'success', until: office.subscription_ends_at ? endOf(office.subscription_ends_at) : null };
}

async function renderIndex(req, res, extra = {}) {
  const officeId = req.office.id;
  const [[row]] = await db.pool.query('SELECT plan_id FROM offices WHERE id = ?', [officeId]);
  const plan = row && row.plan_id ? await plans.getPlan(db.pool, row.plan_id) : null;
  const usage = await plans.usageFor(db.pool, officeId);
  const notice = Object.hasOwn(NOTICES, req.query.notice) ? NOTICES[req.query.notice] : null;
  const subscription = await subscriptions.currentFor(db.pool, officeId);
  return res.status(extra.status || 200).render('billing/index', {
    title: 'الاشتراك',
    plan,
    usage: plans.usageRows(plan, usage),
    status: statusLine(req.office, req.officeAccess),
    interval: subscription ? subscription.billing_interval : null,
    cards: await planCards(row && row.plan_id),
    invoices: await invoices.listForOffice(db.pool, officeId),
    transfers: await orders.pendingTransfersFor(db.pool, officeId),
    online: moyasar.config().enabled,
    suspendedByAdmin: await subscriptions.isAdminSuspended(db.pool, officeId),
    support: await platformSettings.support(),
    notice,
    error: extra.error || null,
    fmt: money.formatHalalas,
    keepDays: billing.DATA_KEEP_DAYS,
    vatPercent: billing.VAT_RATE_BP / 100,
    graceDays: billing.GRACE_DAYS,
  });
}

const office = express.Router();
const billingGuard = requirePerm('billing');

office.get('/office/billing', billingGuard, wrap((req, res) => renderIndex(req, res)));

// ------------------------------------------------------------ checkout review

/** Resolves ?plan and ?interval to a buyable plan; null when there is none. */
async function pickPlan(query) {
  const interval = Object.hasOwn(billing.INTERVAL_MONTHS, query.interval) ? query.interval : 'monthly';
  const plan = await plans.getPlan(db.pool, query.plan);
  if (!plan || !Number(plan.is_active) || !Number(plan.is_public) || pricing.planPrice(plan, interval) <= 0) return { interval, plan: null };
  return { interval, plan };
}

async function renderCheckout(req, res, { plan, interval, promoCode, error = null, status = 200 }) {
  const price = pricing.planPrice(plan, interval);
  let promo = null;
  let promoError = null;
  if (promoCode) {
    const checked = await promos.check(db.pool, { code: promoCode, officeId: req.office.id, planId: plan.id });
    if (checked.ok) promo = checked.promo;
    else promoError = checked.message;
  }
  const usage = await plans.usageFor(db.pool, req.office.id);
  return res.status(status).render('billing/checkout', {
    title: 'مراجعة الطلب',
    plan,
    interval,
    intervalLabel: INTERVAL_LABELS[interval],
    otherInterval: interval === 'monthly' ? 'yearly' : 'monthly',
    otherLabel: INTERVAL_LABELS[interval === 'monthly' ? 'yearly' : 'monthly'],
    promoCode: promo ? promo.code : String(promoCode || ''),
    promoApplied: Boolean(promo),
    promoError,
    quote: pricing.quote({ price, promo: promos.forQuote(promo) }),
    downgrade: plans.checkDowngrade(plan, usage),
    online: moyasar.config().enabled,
    bank: await platformSettings.bank(),
    error,
    fmt: money.formatHalalas,
    vatPercent: billing.VAT_RATE_BP / 100,
  });
}

office.get('/office/billing/checkout', billingGuard, wrap(async (req, res) => {
  const { plan, interval } = await pickPlan(req.query);
  if (!plan) return res.redirect('/office/billing');
  return renderCheckout(req, res, { plan, interval, promoCode: String(req.query.promo || '').slice(0, 40) });
}));

// ------------------------------------------------------------ create the order

const orderLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFor: (req) => `billing-order:${req.user.id}`,
  onLimit: (req, res) => res.status(429).render('errors/403', { title: 'محاولات كثيرة', heading: 'محاولات كثيرة', message: 'حاولت مرات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' }),
});

office.post('/office/billing/orders', billingGuard, orderLimit, wrap(async (req, res) => {
  const { plan, interval } = await pickPlan(req.body);
  if (!plan) return res.redirect('/office/billing');
  const method = req.body.method === 'bank_transfer' ? 'bank_transfer' : 'moyasar';
  const promoCode = String(req.body.promo || '').slice(0, 40);
  if (method === 'moyasar' && !moyasar.config().enabled) {
    return renderCheckout(req, res, { plan, interval, promoCode, error: 'الدفع الإلكتروني غير مفعّل. اختر الحوالة البنكية.', status: 422 });
  }
  const result = await orders.createOrder(db.pool, {
    officeId: req.office.id, userId: req.user.id, planId: plan.id, interval, method, promoCode,
  });
  if (!result.ok) return renderCheckout(req, res, { plan, interval, promoCode: result.error === 'promo' ? '' : promoCode, error: result.message, status: 422 });
  const { order } = result;
  if (order.total === 0) {
    await orders.settleFree(db.pool, { orderId: order.id, confirmedBy: req.user.id });
    return res.redirect('/office/billing?notice=free');
  }
  return res.redirect(`/office/billing/orders/${order.id}/${method === 'moyasar' ? 'pay' : 'transfer'}`);
}));

// ------------------------------------------------------------ pay by card (Moyasar hosted form)

// The hosted form is third-party script and styles, so this one page gets its
// own Content-Security-Policy (everything else stays on the strict app policy).
function moyasarCsp() {
  return [
    "default-src 'self'",
    "script-src 'self' https://cdn.moyasar.com",
    "style-src 'self' 'unsafe-inline' https://cdn.moyasar.com https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com https://cdn.moyasar.com",
    "img-src 'self' data: https://cdn.moyasar.com https://*.moyasar.com",
    "connect-src 'self' https://api.moyasar.com https://*.moyasar.com",
    "frame-src 'self' https://*.moyasar.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.moyasar.com",
  ].join('; ');
}

office.get('/office/billing/orders/:id/pay', billingGuard, wrap(async (req, res) => {
  const order = await orders.getForOffice(db.pool, req.office.id, req.params.id);
  if (!order) return notFound(res);
  if (order.method !== 'moyasar' || order.status !== 'pending' || new Date(order.expiresAt) <= new Date()) return res.redirect('/office/billing');
  if (!moyasar.config().enabled) return res.redirect('/office/billing');
  const config = moyasar.formConfig({
    order,
    description: `اشتراك عقدي - طلب ${order.id}`,
    callbackUrl: `${siteUrl(req)}/office/billing/moyasar/callback`,
  });
  res.set('Content-Security-Policy', moyasarCsp());
  return res.render('billing/pay', {
    title: 'الدفع بالبطاقة',
    order,
    configJson: JSON.stringify(config).replace(/</g, '\\u003c'),
    scriptUrl: billing.MOYASAR.FORM_SCRIPT,
    styleUrl: billing.MOYASAR.FORM_STYLE,
    fmt: money.formatHalalas,
  });
}));

// Moyasar sends the customer back here with ?id=<payment id>&status=...; the
// status in the URL is ignored: the payment is fetched and checked.
office.get('/office/billing/moyasar/callback', billingGuard, wrap(async (req, res) => {
  const paymentId = String(req.query.id || '');
  const outcome = await orders.settleMoyasar(db.pool, { paymentId });
  if (outcome.officeId && outcome.officeId !== req.office.id) return notFound(res);
  const notice = outcome.status === 'paid' || outcome.status === 'replay' ? 'paid'
    : outcome.status === 'suspicious' || outcome.status === 'duplicate' ? 'suspicious'
      : outcome.status === 'failed' ? 'failed' : outcome.status === 'pending' ? 'pending' : 'unverified';
  return res.redirect(`/office/billing?notice=${notice}`);
}));

// ------------------------------------------------------------ pay by bank transfer

const upload = fileUpload({
  useTempFiles: false,
  abortOnLimit: false,
  limits: { fileSize: images.MAX_BYTES, files: 2, fields: 6, fieldSize: 2048 },
  uploadTimeout: 60 * 1000,
  debug: false,
});

const transferLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFor: (req) => `billing-transfer:${req.user.id}`,
  onLimit: (req, res) => res.status(429).render('errors/403', { title: 'محاولات كثيرة', heading: 'محاولات كثيرة', message: 'حاولت مرات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' }),
});

async function renderTransfer(req, res, order, { error = null, status = 200 } = {}) {
  return res.status(status).render('billing/transfer', {
    title: 'الدفع بالحوالة البنكية',
    order,
    bank: await platformSettings.bank(),
    support: await platformSettings.support(),
    error,
    fmt: money.formatHalalas,
  });
}

async function openTransferOrder(req, res) {
  const order = await orders.getForOffice(db.pool, req.office.id, req.params.id);
  if (!order || order.method !== 'bank_transfer') {
    notFound(res);
    return null;
  }
  if (order.status !== 'pending') {
    res.redirect('/office/billing');
    return null;
  }
  return order;
}

office.get('/office/billing/orders/:id/transfer', billingGuard, wrap(async (req, res) => {
  const order = await openTransferOrder(req, res);
  if (order) await renderTransfer(req, res, order);
}));

office.post('/office/billing/orders/:id/transfer', billingGuard, transferLimit, upload, wrap(async (req, res) => {
  const order = await openTransferOrder(req, res);
  if (!order) return null;
  const file = req.files && req.files.receipt;
  const result = await bankTransfers.submit(db.pool, {
    officeId: req.office.id,
    orderId: order.id,
    userId: req.user.id,
    reference: req.body.reference,
    receipt: file && !Array.isArray(file) ? { data: file.data, truncated: file.truncated } : null,
  });
  if (!result.ok) return renderTransfer(req, res, order, { error: result.message, status: 422 });
  return res.redirect('/office/billing?notice=transfer');
}));

office.get('/office/billing/receipts/:id', billingGuard, wrap(async (req, res) => {
  const name = await bankTransfers.receiptFor(db.pool, { transferId: req.params.id, officeId: req.office.id });
  const file = name ? images.imagePath(name) : null;
  if (!file) return notFound(res);
  res.set({ 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
  return res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) notFound(res);
  });
}));

// ------------------------------------------------------------ invoices

office.get('/office/billing/invoices/:id', billingGuard, wrap(async (req, res) => {
  const invoice = await invoices.getForOffice(db.pool, req.office.id, req.params.id);
  if (!invoice) return notFound(res);
  return res.render('billing/invoice', { layout: 'layouts/print', title: invoice.title, invoice, fmt: money.formatHalalas, intervalLabels: INTERVAL_LABELS, backUrl: '/office/billing' });
}));

// ------------------------------------------------------------ the Moyasar webhook

const webhook = express.Router();

const webhookLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyFor: (req) => `moyasar-webhook:${req.ip}`,
  onLimit: (req, res) => res.status(429).json({ ok: false }),
});

// Moyasar posts JSON with a secret_token field. A missing or wrong secret
// answers 404 (the URL does not exist for anyone without it). The body is
// never trusted: only the payment id is used, and the payment is fetched.
webhook.post('/webhooks/moyasar', webhookLimit, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cfg = moyasar.config();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!cfg.webhookEnabled || typeof body.secret_token !== 'string' || !moyasar.secretsMatch(body.secret_token, cfg.webhookSecret)) {
    return res.status(404).json({ ok: false });
  }
  const paymentId = body.data && typeof body.data.id === 'string' ? body.data.id : '';
  try {
    const outcome = await orders.settleMoyasar(db.pool, { paymentId });
    // A payment we could not fetch right now is retried by Moyasar.
    if (outcome.status === 'unverified' && outcome.error === 'network') return res.status(503).json({ ok: false });
    return res.json({ ok: true });
  } catch (err) {
    logger.error(`Moyasar webhook failed: ${err.code || err.name}`);
    return res.status(500).json({ ok: false });
  }
}));

module.exports = { office, webhook, moyasarCsp };
