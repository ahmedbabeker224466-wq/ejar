'use strict';

// Join by code (/join), the landlord area (/landlord) and the tenant area
// (/tenant). Mounted inside routes/areas.js.
//
// loadArea(kind) takes the person's links from the database (landlords.user_id
// for landlords, contract_members for tenants), keyed by the session's user id,
// never by request data. It sets req.memberRole to 'landlord' or 'tenant', so
// requirePerm('own.*') checks the area, not just users.role: one person can be
// both. A contract or payment id from the URL is looked up only inside those
// links; anything else answers 404.

const express = require('express');
const db = require('../config/db');
const contracts = require('../services/contracts');
const feedback = require('../services/feedback');
const portal = require('../services/portal');
const joins = require('../services/joins');
const { landlordLinks, tenantLinks } = require('../services/memberships');
const { parseId } = require('../services/landlords');
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');

const router = express.Router();

for (const path of ['/join', '/landlord', '/tenant']) router.use(path, noStore, sameOrigin);

const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const AREAS = {
  landlord: { href: '/landlord', label: 'صفحة المالك' },
  tenant: { href: '/tenant', label: 'صفحة المستأجر' },
};

const DONE = {
  joined: 'تم الربط بنجاح. أهلاً بك!',
  decision: 'تم حفظ قرارك وسيراه المكتب.',
  confirmed: 'تم تأكيد استلام الدفعة.',
  rejected: 'تم رفض البلاغ وعادت الدفعة مستحقة.',
  reported: 'تم إبلاغ المكتب بأنك دفعت. ستظهر الدفعة "مدفوعة" بعد تأكيد المكتب أو المالك.',
  requested: 'تم إرسال طلبك للمكتب.',
  pending_exists: 'لديك طلب سابق قيد المراجعة.',
  not_allowed: 'لا يمكن تقديم هذا الطلب الآن.',
  unchanged: 'لم يتغير شيء: ربما تم التعامل مع هذا الطلب من قبل.',
};

// ------------------------------------------------------------ area guard

/**
 * Loads the person's links for one area. No link: the other area if they
 * have one, otherwise 403 with a way to join.
 */
function loadArea(kind) {
  return async function loadAreaMiddleware(req, res, next) {
    try {
      const [landlord, tenant] = await Promise.all([landlordLinks(db.pool, req.user.id), tenantLinks(db.pool, req.user.id)]);
      const links = { landlord, tenant };
      const areas = Object.entries(AREAS).filter(([key]) => links[key].length).map(([key, a]) => ({ key, ...a }));
      if (!links[kind].length) {
        const other = areas[0];
        if (other && req.method === 'GET') return res.redirect(other.href);
        return res.status(403).render('errors/403', {
          title: 'غير متاح',
          heading: 'لا توجد بيانات مرتبطة بحسابك هنا',
          message: 'إذا أرسل لك المكتب رمز دعوة، أدخله من صفحة "الانضمام برمز".',
        });
      }
      req.links = links[kind];
      req.memberRole = kind;
      res.locals.areas = areas;
      res.locals.currentArea = kind;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ------------------------------------------------------------ join

function renderJoin(req, res, { status = 200, error = null, code = '' } = {}) {
  const refused = Boolean(req.user && joins.OFFICE_ROLES.has(req.user.role));
  return res.status(status).render('portal/join', {
    title: 'الانضمام برمز',
    signedIn: Boolean(req.user),
    refused,
    refusedMessage: joins.MESSAGES.office_user,
    error,
    code,
  });
}

router.get('/join', (req, res) => renderJoin(req, res));

router.post('/join', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login?next=/join');
  const typed = String(req.body.code || '').slice(0, 40);
  if (joins.OFFICE_ROLES.has(req.user.role)) return renderJoin(req, res, { status: 403 });
  const wait = joins.joinGuard.attempt({ userId: req.user.id, ip: req.ip });
  if (wait > 0) {
    res.set('Retry-After', String(wait));
    return renderJoin(req, res, { status: 429, error: joins.MESSAGES.rate_limited, code: typed });
  }
  const result = await joins.joinWithCode(db.pool, { userId: req.user.id, code: typed, ip: req.ip });
  if (!result.ok) {
    const status = result.reason === 'office_user' ? 403 : 422;
    return renderJoin(req, res, { status, error: joins.MESSAGES[result.reason] || joins.MESSAGES.invalid, code: typed });
  }
  return res.redirect(`${AREAS[result.kind].href}?done=joined`);
}));

// ------------------------------------------------------------ landlord

const landlordArea = [requireAuth, loadArea('landlord')];

router.get('/landlord', landlordArea, requirePerm('own.units'), wrap(async (req, res) => {
  const day = today();
  const data = await portal.landlordDashboard(db.pool, req.links, day);
  res.render('portal/landlord', {
    title: 'صفحة المالك',
    ...data,
    today: day,
    message: DONE[req.query.done] || null,
    stageLabels: contracts.STAGE_LABELS,
    paymentLabels: contracts.PAYMENT_LABELS,
    decisionLabels: feedback.DECISIONS,
    unitStatusLabels: { vacant: 'شاغرة', rented: 'مؤجرة', maintenance: 'صيانة' },
  });
}));

async function renderLandlordContract(req, res, { status = 200, errors = {}, values = null } = {}) {
  const day = today();
  const view = await portal.landlordContract(db.pool, req.links, parseId(req.params.id), day);
  if (!view) return notFound(res);
  return res.status(status).render('portal/landlord-contract', {
    title: view.contract.unit_label ? `عقد ${view.contract.unit_label}` : 'عقد',
    ...view,
    today: day,
    message: DONE[req.query.done] || null,
    errors,
    values: values || { decision: (view.decisions[0] && view.decisions[0].decision) || '', note: '' },
    stageLabels: contracts.STAGE_LABELS,
    frequencyLabels: contracts.FREQUENCY_LABELS,
    paymentLabels: contracts.PAYMENT_LABELS,
    decisionLabels: feedback.DECISIONS,
    noteMax: 280,
  });
}

router.get('/landlord/contracts/:id', landlordArea, requirePerm('own.contracts'), wrap((req, res) => renderLandlordContract(req, res)));

router.post('/landlord/contracts/:id/decision', landlordArea, requirePerm('own.contracts'), wrap(async (req, res) => {
  const view = await portal.landlordContract(db.pool, req.links, parseId(req.params.id), today());
  if (!view) return notFound(res);
  const { values, errors } = feedback.validateDecision(req.body);
  if (!view.described.live) errors.decision = 'هذا العقد لم يعد سارياً.';
  if (Object.keys(errors).length) {
    return renderLandlordContract(req, res, { status: 422, errors, values: { decision: values.decision, note: String(req.body.note || '').slice(0, 600) } });
  }
  await feedback.addDecision(db.pool, view.link.office_id, {
    contractId: view.contract.id, landlordId: view.link.landlord_id, userId: req.user.id, ...values, ip: req.ip,
  });
  return res.redirect(`/landlord/contracts/${view.contract.id}?done=decision`);
}));

for (const action of ['confirm', 'reject']) {
  router.post(`/landlord/contracts/:id/payments/:paymentId/${action}`, landlordArea, requirePerm('own.payments'), wrap(async (req, res) => {
    const paymentId = parseId(req.params.paymentId);
    const view = paymentId && await portal.landlordContract(db.pool, req.links, parseId(req.params.id), today());
    if (!view || !view.payments.some((p) => Number(p.id) === paymentId)) return notFound(res);
    const changed = await feedback.answerReportedPayment(db.pool, view.link.office_id, {
      contractId: view.contract.id, paymentId, confirm: action === 'confirm', actorId: req.user.id, by: 'landlord', ip: req.ip,
    });
    const done = changed ? (action === 'confirm' ? 'confirmed' : 'rejected') : 'unchanged';
    return res.redirect(`/landlord/contracts/${view.contract.id}?done=${done}#payments`);
  }));
}

// ------------------------------------------------------------ tenant

const tenantArea = [requireAuth, loadArea('tenant')];

router.get('/tenant', tenantArea, requirePerm('own.contract'), wrap(async (req, res) => {
  const day = today();
  const data = await portal.tenantDashboard(db.pool, req.links, day, req.user.id);
  res.render('portal/tenant', {
    title: 'صفحة المستأجر',
    ...data,
    today: day,
    message: DONE[req.query.done] || null,
    stageLabels: contracts.STAGE_LABELS,
    frequencyLabels: contracts.FREQUENCY_LABELS,
    paymentLabels: contracts.PAYMENT_LABELS,
    requestTypes: feedback.REQUEST_TYPES,
    requestStatuses: feedback.REQUEST_STATUSES,
    noteMax: 500,
  });
}));

async function tenantView(req) {
  return portal.tenantContract(db.pool, req.links, parseId(req.params.id), today(), req.user.id);
}

router.post('/tenant/contracts/:id/payments/:paymentId/report', tenantArea, requirePerm('own.payments'), wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  const view = paymentId && await tenantView(req);
  if (!view || !view.payments.some((p) => Number(p.id) === paymentId)) return notFound(res);
  const changed = await feedback.reportPayment(db.pool, view.link.office_id, {
    contractId: view.contract.id, paymentId, userId: req.user.id, ip: req.ip,
  });
  return res.redirect(`/tenant?done=${changed ? 'reported' : 'unchanged'}#contract-${view.contract.id}`);
}));

router.post('/tenant/contracts/:id/requests', tenantArea, requirePerm('own.contract'), wrap(async (req, res) => {
  const view = await tenantView(req);
  if (!view) return notFound(res);
  if (String(req.body.request_type || 'rent_reduction') !== 'rent_reduction') return notFound(res);
  const outcome = await feedback.requestReduction(db.pool, view.link.office_id, {
    contract: view.contract, userId: req.user.id, body: req.body, today: today(), ip: req.ip,
  });
  if (outcome.result === 'invalid') {
    return res.status(422).render('portal/message', {
      title: 'طلب تخفيض الإيجار', heading: 'تعذر إرسال الطلب', message: outcome.errors.note, back: `/tenant#contract-${view.contract.id}`,
    });
  }
  const done = { created: 'requested', pending_exists: 'pending_exists', not_allowed: 'not_allowed' }[outcome.result];
  return res.redirect(`/tenant?done=${done}#contract-${view.contract.id}`);
}));

module.exports = router;
module.exports.loadArea = loadArea;
