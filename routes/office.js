'use strict';

// Office registration (/office/new) and the office area (/office/*).
// Every /office page runs requireAuth -> loadOffice -> officeGate, then its
// own requirePerm(capability). The office id always comes from loadOffice.

const express = require('express');
const db = require('../config/db');
const auth = require('../services/auth');
const offices = require('../services/offices');
const unitsService = require('../services/units');
const logger = require('../utils/logger');
const { toLocal } = require('../utils/phone');
const { requireAuth } = require('../middleware/auth');
const { requirePerm, can } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');
const { loadOffice, officeGate, OFFICE_NAV } = require('../middleware/loadOffice');
const landlordRoutes = require('./landlords');
const unitRoutes = require('./units');

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

function renderNewOffice(res, values, errors, status = 200) {
  return res.status(status).render('office/new', {
    title: 'إنشاء مكتبك',
    cities: offices.SAUDI_CITIES,
    values,
    errors,
  });
}

const createOfficeLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFor: (req) => `office-new:${req.user.id}`,
  onLimit: (req, res) =>
    renderNewOffice(res, formValues(offices.validateOfficeFields(req.body).values), {
      form: 'حاولت مرات كثيرة. انتظر بضع دقائق ثم حاول مرة أخرى.',
    }, 429),
});

router.get('/office/new', requireAuth, onlyWithoutOffice, (req, res) => {
  renderNewOffice(res, { ...formValues({}), city: offices.SAUDI_CITIES[0], phone: toLocal(req.user.phone) }, {});
});

router.post('/office/new', requireAuth, createOfficeLimit, onlyWithoutOffice, async (req, res, next) => {
  const { values, errors } = offices.validateOfficeFields(req.body);
  if (Object.keys(errors).length > 0) {
    return renderNewOffice(res, { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20) }, errors, 422);
  }
  try {
    await offices.createOffice(db.pool, { userId: req.user.id, fields: values, ip: req.ip });
    return res.redirect('/office');
  } catch (err) {
    if (err instanceof offices.OfficeCreateError) return res.redirect('/office');
    // Only the error code: never the office details the user typed.
    logger.error(`Office creation failed: ${err.code || err.name}`);
    return renderNewOffice(res, formValues(values), { form: 'تعذّر إنشاء المكتب الآن. حاول مرة أخرى بعد قليل.' }, 500);
  }
});

// ------------------------------------------------------------ office area

router.use('/office', requireAuth, loadOffice(), officeGate);

// done(counts) ticks a step once the office has done it.
const SETUP_STEPS = [
  { label: 'أضف أول مالك', href: '/office/landlords', capability: 'landlords', done: (c) => c.landlordsTotal > 0 },
  { label: 'أضف أول عقار أو وحدة', href: '/office/units', capability: 'units', done: (c) => c.units.total + c.units.buildings > 0 },
  { label: 'أضف أول عقد', href: '/office/contracts', capability: 'contracts' },
  { label: 'ادعُ أحد أعضاء فريقك', href: '/office/team', capability: 'team' },
  { label: 'اربط واتساب لإرسال التذكيرات', href: '/office/settings', capability: 'settings.basic' },
];

router.get('/office', requirePerm('contracts'), async (req, res, next) => {
  try {
    const counts = await offices.dashboardCounts(db.pool, req.office.id);
    counts.units = await unitsService.unitCounts(db.pool, req.office.id);
    const needsAction = [
      { count: counts.expiring90, text: 'عقود تنتهي خلال 90 يوماً', href: '/office/contracts', capability: 'contracts' },
      { count: counts.overduePayments, text: 'دفعات متأخرة', href: '/office/payments', capability: 'payments.read' },
      { count: counts.openMaintenance, text: 'طلبات صيانة مفتوحة', href: '/office/maintenance', capability: 'maintenance' },
    ].filter((item) => item.count > 0 && can(req.memberRole, item.capability));
    return res.render('office/home', {
      title: 'الرئيسية',
      counts,
      needsAction,
      setupSteps: SETUP_STEPS.filter((step) => can(req.memberRole, step.capability)).map((step) => ({
        label: step.label,
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

// One placeholder page per navigation item, each behind its own capability.
// Landlords, units (routes/landlords.js, routes/units.js) and settings (below) are real pages.
for (const item of OFFICE_NAV.filter((i) => !['home', 'landlords', 'units', 'settings'].includes(i.key))) {
  router.get(item.href, requirePerm(item.capability), (req, res) => {
    res.render('office/placeholder', { title: item.label });
  });
}

// ------------------------------------------------------------ settings

async function renderSettings(req, res, { values, errors = {}, saved = false, status = 200 } = {}) {
  const current = values || formValues(await offices.officeDetails(db.pool, req.office.id));
  return res.status(status).render('office/settings', {
    title: 'الإعدادات',
    cities: offices.SAUDI_CITIES,
    values: current,
    errors,
    saved,
    canEditOffice: can(req.memberRole, 'settings.office'),
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
    const { values, errors } = offices.validateOfficeFields(req.body);
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

module.exports = router;
