'use strict';

// Office registration (/office/new) and the office area (/office/*).
// Every /office page runs requireAuth -> loadOffice -> officeGate, then its
// own requirePerm(capability). The office id always comes from loadOffice.

const express = require('express');
const db = require('../config/db');
const auth = require('../services/auth');
const offices = require('../services/offices');
const officeReview = require('../services/officeReview');
const unitsService = require('../services/units');
const logger = require('../utils/logger');
const { toLocal } = require('../utils/phone');
const { requireAuth } = require('../middleware/auth');
const { requirePerm, can } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');
const { loadOffice, officeGate } = require('../middleware/loadOffice');
const landlordRoutes = require('./landlords');
const unitRoutes = require('./units');
const contractRoutes = require('./contracts');
const reminderRoutes = require('./officeReminders');
const paymentRoutes = require('./officePayments');
const maintenanceRoutes = require('./maintenance');
const messageRoutes = require('./messages');
const teamRoutes = require('./team');
const taskRoutes = require('./tasks');
const reportRoutes = require('./reports');
const accountingRoutes = require('./accounting');
const leadRoutes = require('./leads');
const billingRoutes = require('./billing');
const listingRoutes = require('./listings');
const contractsService = require('../services/contracts');
const officeTenants = require('../services/officeTenants');
const officeAudit = require('../services/officeAudit');
const officeLink = require('../services/officeLink');
const plans = require('../services/plans');
const officialPricing = require('../services/officialPricing');
const { scopeToOffice } = require('../services/scopeToOffice');
const domains = require('../services/domains');
const customHosts = require('../services/customHosts');
const money = require('../services/money');
const { effectivePlanIdSql } = require('../services/defaultPlan');
const seo = require('../services/seo');
const contractStatus = require('../services/contractStatus');
const { riyadhDate } = require('../services/contractDates');
const feedback = require('../services/feedback');
const delivery = require('../services/delivery');
const { KIND_LABELS } = require('../services/notifications');
const platformSettings = require('../services/platformSettings');
const { riyadhNow } = require('../utils/time');

const router = express.Router();

router.use('/office', noStore, sameOrigin);

function formValues(values) {
  return {
    name: values.name || '',
    city: values.city || '',
    phone: values.phone ? toLocal(values.phone) : '',
    email: values.email || '',
    cr_number: values.cr_number || '',
    rega_license: values.rega_license || '',
  };
}

// ------------------------------------------------------------ registration

/**
 * Only a signed-in user with no role and no office may create one. Everyone
 * else is sent to their own area (office members to /office).
 */
async function onlyWithoutOffice(req, res, next) {
  try {
    const memberships = await offices.membershipsFor(db.pool, req.user.id);
    if (memberships.length > 0) return res.redirect('/office');
    if (req.user.role !== null) return res.redirect(auth.homeFor(req.user.role));
    return next();
  } catch (err) {
    return next(err);
  }
}

function renderNewOffice(res, values, errors, status = 200, extra = {}) {
  return res.status(status).render('office/new', {
    title: extra.editing ? 'تعديل بيانات المكتب' : 'إنشاء مكتبك',
    layout: 'layouts/site',
    mkStd: true,
    licenceRequired: true,
    cities: offices.SAUDI_CITIES,
    values,
    errors,
    ...extra,
  });
}

const TERMS_ERROR = 'وافق على الشروط والأحكام وسياسة الخصوصية لإنشاء المكتب.';

const createOfficeLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFor: (req) => `office-new:${req.user.id}`,
  onLimit: (req, res) =>
    renderNewOffice(res, formValues(offices.validateOfficeFields(req.body, { requireLicence: true }).values), {
      form: 'حاولت مرات كثيرة. انتظر بضع دقائق ثم حاول مرة أخرى.',
    }, 429),
});

router.get('/office/new', requireAuth, onlyWithoutOffice, (req, res) => {
  renderNewOffice(res, { ...formValues({}), city: offices.SAUDI_CITIES[0], phone: toLocal(req.user.phone) }, {});
});

router.post('/office/new', requireAuth, createOfficeLimit, onlyWithoutOffice, async (req, res, next) => {
  const { values, errors } = offices.validateOfficeFields(req.body, { requireLicence: true });
  const acceptedTerms = req.body.accept_terms === '1';
  if (!acceptedTerms) errors.accept_terms = TERMS_ERROR;
  if (Object.keys(errors).length > 0) {
    return renderNewOffice(res, { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20), accept_terms: acceptedTerms }, errors, 422);
  }
  try {
    if (await platformSettings.signupsDisabled()) {
      return renderNewOffice(res, { ...formValues(values), accept_terms: true }, { form: 'التسجيل الجديد متوقف مؤقتاً. حاول لاحقاً.' }, 403);
    }
    const officeId = await offices.createOffice(db.pool, { userId: req.user.id, fields: values, ip: req.ip, termsAccepted: true });
    // The platform admin checks the licence; a failed notice never blocks the sign-up.
    try {
      await officeReview.notifyNewOffice(db.pool, officeId);
    } catch (err) {
      logger.error(`Office review notice failed: ${err.code || err.name}`);
    }
    return res.redirect('/office');
  } catch (err) {
    if (err instanceof offices.OfficeCreateError) return res.redirect('/office');
    // Only the error code: never the office details the user typed.
    logger.error(`Office creation failed: ${err.code || err.name}`);
    return renderNewOffice(res, { ...formValues(values), accept_terms: true }, { form: 'تعذّر إنشاء المكتب الآن. حاول مرة أخرى بعد قليل.' }, 500);
  }
});

// ------------------------------------------------------------ office area

router.use('/office', requireAuth, loadOffice(), officeGate);

// ------------------------------------------------------------ correcting a pending or refused sign-up
// Only the owner, only while the licence check is pending or was refused.
// Saving sends the office back to the admin's review queue (officeGate lets
// these two routes through for an unverified office).
function onlyUnverifiedOwner(req, res, next) {
  if (req.memberRole !== 'office_owner') return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
  if (req.office.verification === 'approved') return res.redirect('/office');
  return next();
}

const resubmitLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFor: (req) => `office-resubmit:${req.office.id}`,
  onLimit: (req, res) =>
    renderNewOffice(res, formValues(offices.validateOfficeFields(req.body, { requireLicence: true }).values), {
      form: 'أرسلت التعديل مرات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.',
    }, 429, { editing: true }),
});

router.get('/office/review/edit', onlyUnverifiedOwner, async (req, res, next) => {
  try {
    return renderNewOffice(res, formValues(await offices.officeDetails(db.pool, req.office.id)), {}, 200, { editing: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/office/review/edit', onlyUnverifiedOwner, resubmitLimit, async (req, res, next) => {
  const { values, errors } = offices.validateOfficeFields(req.body, { requireLicence: true });
  if (Object.keys(errors).length > 0) {
    return renderNewOffice(res, { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20) }, errors, 422, { editing: true });
  }
  try {
    await officeReview.resubmit(db.pool, { officeId: req.office.id, userId: req.user.id, fields: values, ip: req.ip });
    return res.redirect('/office?done=resubmitted');
  } catch (err) {
    if (err instanceof officeReview.ReviewError) return res.redirect('/office');
    return next(err);
  }
});

// done(counts) ticks a step once the office has done it.
const SETUP_STEPS = [
  { label: 'أضف أول مالك', hint: 'لقب المالك ومدينته وجواله، ويدخل لوحته برمز دعوة.', href: '/office/landlords/new', capability: 'landlords', done: (c) => c.landlordsTotal > 0 },
  { label: 'أضف أول عقار أو وحدة', hint: 'المبنى ووحداته، أو وحدة مستقلة.', href: '/office/units/new', capability: 'units', done: (c) => c.units.total + c.units.buildings > 0 },
  { label: 'أضف أول عقد', hint: 'ارفع ملف العقد من إيجار وتُقرأ التواريخ والمبالغ تلقائياً.', href: '/office/contracts/new', capability: 'contracts', done: (c) => c.contractsTotal > 0 },
  { label: 'ادعُ أحد أعضاء فريقك', hint: 'مدير أو موظف برقم جواله.', href: '/office/team', capability: 'team', done: (c) => c.membersTotal > 1 },
  { label: 'فعّل قناة للتذكيرات', hint: 'تيليجرام أو واتساب ليصل التذكير خارج الموقع.', href: '/office/settings/reminders', capability: 'settings.office', done: (c) => c.channelsTotal > 0 },
];

router.get('/office', requirePerm('contracts'), async (req, res, next) => {
  try {
    const now = new Date();
    const today = riyadhDate(now);
    // No cron yet: keep this office's stages fresh, at most once an hour.
    await contractStatus.maybeRecompute({ pool: db.pool, officeId: req.office.id, now, today });
    const counts = await offices.dashboardCounts(db.pool, req.office.id, now);
    counts.units = await unitsService.unitCounts(db.pool, req.office.id);
    const scopedHome = scopeToOffice(db.pool, req.office.id);
    const [members] = await scopedHome.query('SELECT COUNT(*) AS n FROM office_members WHERE office_id = :office_id AND is_active = 1');
    const [channels] = await scopedHome.query('SELECT COUNT(*) AS n FROM channel_settings WHERE office_id = :office_id AND enabled = 1');
    counts.membersTotal = Number(members.n);
    counts.channelsTotal = Number(channels.n);
    return res.render('office/home', {
      title: 'الرئيسية',
      counts,
      board: await contractsService.needsActionContracts(db.pool, req.office.id, today, 10),
      pending: await feedback.pendingCounts(db.pool, req.office.id),
      pendingContracts: await feedback.pendingContracts(db.pool, req.office.id, 10),
      sent: await delivery.officeDeliverySummary(db.pool, req.office.id),
      kindLabels: KIND_LABELS,
      riyadhTime: (at) => riyadhNow(new Date(at)).slice(0, 16),
      stageLabels: contractsService.STAGE_LABELS,
      setupSteps: SETUP_STEPS.filter((step) => can(req.memberRole, step.capability)).map((step) => ({
        label: step.label,
        hint: step.hint,
        href: step.href,
        done: Boolean(step.done && step.done(counts)),
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.use(landlordRoutes);
router.use(unitRoutes);
router.use(contractRoutes);
router.use(paymentRoutes);
router.use(maintenanceRoutes.office);
router.use(messageRoutes.office);
router.use(teamRoutes);
router.use(taskRoutes);
router.use(reportRoutes.office);
router.use(accountingRoutes.office);
router.use(leadRoutes);
router.use(billingRoutes.office);
router.use(listingRoutes);

// ------------------------------------------------------------ tenants

router.get('/office/tenants', requirePerm('tenants'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 60);
    const status = officeTenants.STATUSES.includes(req.query.status) ? req.query.status : '';
    const result = await officeTenants.listTenants(db.pool, req.office.id, { q, status, page: req.query.page });
    const pageUrl = (page) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (page > 1) params.set('page', String(page));
      const text = params.toString();
      return `/office/tenants${text ? `?${text}` : ''}`;
    };
    return res.render('office/tenants', {
      title: 'المستأجرون',
      ...result,
      q,
      status,
      statusLabels: officeTenants.STATUS_LABELS,
      stageLabels: contractsService.STAGE_LABELS,
      filtered: Boolean(q || status),
      canAddContract: can(req.memberRole, 'contracts'),
      prevUrl: result.page > 1 ? pageUrl(result.page - 1) : null,
      nextUrl: result.page < result.pages ? pageUrl(result.page + 1) : null,
    });
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ audit log (read only)

router.get('/office/audit', requirePerm('audit'), async (req, res, next) => {
  try {
    const result = await officeAudit.listOfficeAudit(db.pool, req.office.id, { page: req.query.page });
    const pageUrl = (page) => (page > 1 ? `/office/audit?page=${page}` : '/office/audit');
    return res.render('office/audit', {
      title: 'سجل التدقيق',
      ...result,
      riyadhTime: (at) => riyadhNow(new Date(at)).slice(0, 16),
      prevUrl: result.page > 1 ? pageUrl(result.page - 1) : null,
      nextUrl: result.page < result.pages ? pageUrl(result.page + 1) : null,
    });
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ settings

const LINK_NOTICES = { link: 'تم تغيير رابط مكتبك. الرابط القديم يحوّل الزوار إلى الجديد.', page: 'تم حفظ إعدادات صفحة المكتب.' };
const DOMAIN_NOTICES = {
  created: 'تم حفظ الدومين. أضف السجلين الظاهرين عند مزود الدومين ثم اضغط «ربط الدومين».',
  cancelled: 'تم إلغاء طلب النطاق.',
  connected: 'تم ربط الدومين بصفحة مكتبك. شهادة الأمان (https) تصدر تلقائياً خلال ساعة غالباً.',
  disconnected: 'تم إلغاء ربط الدومين. يعمل رابطك المجاني كما هو.',
};

const connectLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFor: (req) => `office-domain-connect:${req.office.id}`,
});

/** The «ربط الدومين» page (its own menu item, owner's request Nov 2026). Actions stay owner-only ('billing'). */
async function renderDomain(req, res, { status = 200, domain = {} } = {}) {
  const domainView = await domains.officeView(db.pool, req.office.id);
  return res.status(status).render('office/domain', {
    title: 'ربط الدومين',
    domain: {
      ...domainView,
      freeLink: domainView.slug ? `${seo.baseUrl(req).replace(/^https?:\/\//, '')}/${domainView.slug}` : null,
      canRequest: can(req.memberRole, 'billing'),
      canEditLink: can(req.memberRole, 'settings.office'),
      fmt: money.formatHalalas,
      errors: domain.errors || {},
      values: domain.values || {},
      notice: domain.notice || DOMAIN_NOTICES[req.query.domain] || null,
      connectError: domain.connectError || null,
      found: domain.found || [],
    },
  });
}

router.get('/office/domain', requirePerm('settings.basic'), async (req, res, next) => {
  try {
    return await renderDomain(req, res);
  } catch (err) {
    return next(err);
  }
});

async function renderSettings(req, res, { values, errors = {}, saved = false, status = 200, link = {} } = {}) {
  const current = values || formValues(await offices.officeDetails(db.pool, req.office.id));
  const canEditOffice = can(req.memberRole, 'settings.office');
  const linkState = canEditOffice ? await officeLink.linkSettings(db.pool, req.office.id) : null;
  // The office's plan, its limits and the current usage (read live from the plan row).
  const [planRow] = await scopeToOffice(db.pool, req.office.id).query(`SELECT ${effectivePlanIdSql('o')} AS plan_id FROM offices o WHERE o.id = :office_id`);
  const plan = planRow && planRow.plan_id ? await plans.getPlan(db.pool, planRow.plan_id) : null;
  const usage = plans.usageRows(plan, await plans.usageFor(db.pool, req.office.id));
  const planInfo = plan ? {
    name: plan.name_ar,
    trial: plan.code === 'trial',
    usage,
    spec: officialPricing.planSpec(plan, await officialPricing.customDomainAddon(db.pool)),
  } : null;
  return res.status(status).render('office/settings', {
    licenceLocked: true,
    licenceRequired: true,
    planInfo,
    canBilling: can(req.memberRole, 'billing'),
    title: 'الإعدادات',
    cities: offices.SAUDI_CITIES,
    values: current,
    errors,
    saved,
    canEditOffice,
    link: linkState && {
      ...linkState,
      url: linkState.slug ? seo.absolute(seo.baseUrl(req), `/${linkState.slug}`) : null,
      base: seo.baseUrl(req),
      typed: link.typed ?? '',
      error: link.error ? officeLink.ERRORS[link.error] : null,
      descriptionValue: link.description ?? linkState.description,
      descriptionError: link.descriptionError || null,
      enabledValue: link.enabled ?? linkState.enabled,
      notice: LINK_NOTICES[req.query.link] || null,
      min: officeLink.MIN_LENGTH,
      max: officeLink.MAX_LENGTH,
      descriptionMax: officeLink.DESCRIPTION_MAX,
    },
  });
}

router.get('/office/settings', requirePerm('settings.basic'), async (req, res, next) => {
  try {
    return await renderSettings(req, res, { saved: req.query.saved === '1' });
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings', requirePerm('settings.office'), async (req, res, next) => {
  try {
    const { values, errors } = offices.validateOfficeFields(req.body, { requireLicence: true });
    if (Object.keys(errors).length > 0) {
      return await renderSettings(req, res, {
        values: { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20) },
        errors,
        status: 422,
      });
    }
    await offices.updateOffice(db.pool, { officeId: req.office.id, actorId: req.user.id, fields: values, ip: req.ip });
    return res.redirect('/office/settings?saved=1');
  } catch (err) {
    // The error handler logs only the error type and code, never the values.
    return next(err);
  }
});

// The office's public link (owner and manager). Open while the office is locked, like the rest of settings.
// Custom domain requests (services/domains.js): the owner only ('billing').
router.post('/office/settings/domain', requirePerm('billing'), async (req, res, next) => {
  try {
    const values = {
      type: String(req.body.type || ''),
      domain: String(req.body.domain || '').slice(0, 260),
      connection_method: String(req.body.connection_method || ''),
      alt_1: String(req.body.alt_1 || '').slice(0, 260),
      alt_2: String(req.body.alt_2 || '').slice(0, 260),
    };
    if (values.type === 'none') return res.redirect('/office/domain');
    if (req.officeAccess && (req.officeAccess.locked || req.officeAccess.readOnly)) {
      return await renderDomain(req, res, { status: 402, domain: { values, errors: { form: 'اشتراكك منتهي. جدّد الاشتراك لطلب نطاق.' } } });
    }
    // Offices connect a domain they bought (records method); reserving for them is no longer offered.
    const result = await domains.createRequest(db.pool, { officeId: req.office.id, userId: req.user.id, body: { type: 'own', connection_method: 'records', domain: req.body.domain }, ip: req.ip });
    if (!result.ok) return await renderDomain(req, res, { status: 422, domain: { values, errors: result.errors } });
    return res.redirect('/office/domain?domain=created');
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings/domain/:id/cancel', requirePerm('billing'), async (req, res, next) => {
  try {
    const ok = await domains.cancelRequest(db.pool, { officeId: req.office.id, userId: req.user.id, requestId: req.params.id, ip: req.ip });
    if (!ok) return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
    return res.redirect('/office/domain?domain=cancelled');
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings/domain/:id/connect', requirePerm('billing'), connectLimit, async (req, res, next) => {
  try {
    if (req.officeAccess && (req.officeAccess.locked || req.officeAccess.readOnly)) {
      return await renderDomain(req, res, { status: 402, domain: { errors: { form: 'اشتراكك منتهي. جدّد الاشتراك لربط الدومين.' } } });
    }
    const result = await domains.connectRequest(db.pool, { officeId: req.office.id, userId: req.user.id, requestId: req.params.id, ip: req.ip });
    if (result.ok) return res.redirect('/office/domain?domain=connected');
    if (result.code === 'not_found') return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
    if (result.manual) return await renderDomain(req, res, { domain: { notice: result.message } });
    return await renderDomain(req, res, { status: 422, domain: { connectError: result.message, found: result.found || [] } });
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings/domain/disconnect', requirePerm('billing'), async (req, res, next) => {
  try {
    await domains.disconnectDomain(db.pool, { officeId: req.office.id, userId: req.user.id, ip: req.ip });
    return res.redirect('/office/domain?domain=disconnected');
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings/link', requirePerm('settings.office'), async (req, res, next) => {
  try {
    const result = await officeLink.changeSlug(db.pool, { officeId: req.office.id, actorId: req.user.id, slug: req.body.slug, ip: req.ip });
    if (result.ok) customHosts.clear();
    if (result.ok) return res.redirect('/office/settings?link=link#office-link');
    return await renderSettings(req, res, { status: result.error === 'limit' ? 429 : 422, link: { typed: String(req.body.slug || '').slice(0, 60), error: result.error } });
  } catch (err) {
    return next(err);
  }
});

router.post('/office/settings/public-page', requirePerm('settings.office'), async (req, res, next) => {
  try {
    const { values, errors } = officeLink.validatePageFields(req.body);
    if (errors.description) {
      return await renderSettings(req, res, {
        status: 422,
        link: { description: String(req.body.description || '').slice(0, 600), descriptionError: errors.description, enabled: values.enabled },
      });
    }
    await officeLink.savePublicPage(db.pool, { officeId: req.office.id, actorId: req.user.id, ...values, ip: req.ip });
    customHosts.clear(); // a page switched off stops serving on its custom domain at once
    return res.redirect('/office/settings?link=page#office-link');
  } catch (err) {
    return next(err);
  }
});

router.use(reminderRoutes);

module.exports = router;
