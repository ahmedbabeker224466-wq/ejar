'use strict';

// Platform admin: offices list, office page and its actions (trial, plan, verify, reject, suspend, notes).
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


module.exports = function registerOffices(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText }) {
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
    falInquiryUrl: officeReview.FAL_INQUIRY_URL,
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

router.post('/admin/offices/:id/verify', officeAction(async ({ req, res, office, reason }) => {
  try {
    await officeReview.approve(db.pool, { officeId: office.id, adminId: req.user.id, reason, ip: req.ip });
  } catch (err) {
    if (err instanceof officeReview.ReviewError) return renderOffice(req, res, { error: 'هذا المكتب موافق عليه من قبل.', status: 409 });
    throw err;
  }
  return res.redirect(`/admin/offices/${office.id}?done=verified`);
}));

router.post('/admin/offices/:id/reject', officeAction(async ({ req, res, office, reason }) => {
  try {
    await officeReview.reject(db.pool, { officeId: office.id, adminId: req.user.id, reason, ip: req.ip });
  } catch (err) {
    if (err instanceof officeReview.ReviewError) return renderOffice(req, res, { error: 'يمكن رفض المكاتب التي بانتظار المراجعة فقط.', status: 409 });
    throw err;
  }
  return res.redirect(`/admin/offices/${office.id}?done=office_rejected`);
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

};
