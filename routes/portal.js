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
const paymentEntries = require('../services/paymentEntries');
const money = require('../services/money');
const joins = require('../services/joins');
const invites = require('../services/invites');
const auth = require('../services/auth');
const emailAuth = require('../services/emailAuth');
const emailCode = require('../services/emailCode');
const platformSettings = require('../services/platformSettings');
const { toWesternDigits } = require('../utils/phone');
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
  recorded: 'تم تسجيل الدفعة.',
  undone: 'تم التراجع عن الدفعة.',
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
      res.locals.layout = 'layouts/portal';
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ------------------------------------------------------------ join

function renderJoin(req, res, { status = 200, error = null, code = '', email = '' } = {}) {
  const refused = Boolean(req.user && joins.OFFICE_ROLES.has(req.user.role));
  res.locals.layout = 'layouts/site';
  res.locals.mkStd = true;
  return res.status(status).render('portal/join', {
    title: 'الانضمام برمز',
    signedIn: Boolean(req.user),
    guestByEmail: !req.user && emailCode.enabled(),
    refused,
    refusedMessage: joins.MESSAGES.office_user,
    error,
    code,
    email,
  });
}

// A guest joins with the invite code and an email address: the code is checked
// first (inviteGuard), then a six-digit code goes to the email; only the right
// email code signs in (or creates the account) and redeems the invite.
const JOIN_COOKIE = 'aqdi_join';
const JOIN_SECONDS = 15 * 60;
const joinCookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: JOIN_SECONDS * 1000, path: '/join' });
const pendingJoin = (req) => auth.verifyStepToken(req.cookies[JOIN_COOKIE], 'join-email');

function renderJoinVerify(req, res, pending, error = null, status = 200) {
  res.locals.layout = 'layouts/site';
  res.locals.mkStd = true;
  const elapsed = Math.floor((Date.now() - pending.sentAt) / 1000);
  return res.status(status).render('pages/login-verify', {
    title: 'رمز الدخول',
    phoneLocal: pending.email,
    sentTo: 'email',
    verifyAction: '/join/verify',
    resendAction: '/join/resend',
    changeHref: '/join',
    changeLabel: 'تغيير البريد الإلكتروني',
    resendIn: Math.max(0, 60 - elapsed),
    error,
  });
}

async function guestJoin(req, res) {
  const typed = String(req.body.code || '').slice(0, 40);
  const address = emailAuth.normalizeEmail(String(req.body.email || '').slice(0, 190));
  if (!address) return renderJoin(req, res, { status: 422, error: 'اكتب بريدك الإلكتروني بصيغة صحيحة، مثل name@example.com.', code: typed, email: req.body.email || '' });
  const checked = await invites.inviteGuard.check(db.pool, typed, { ip: req.ip });
  if (!checked.ok) {
    if (checked.reason === 'rate_limited') res.set('Retry-After', String(checked.retryAfterSec));
    return renderJoin(req, res, { status: checked.reason === 'rate_limited' ? 429 : 422, error: checked.reason === 'rate_limited' ? joins.MESSAGES.rate_limited : joins.MESSAGES.invalid, code: typed, email: address });
  }
  const sent = await emailCode.request(address, 'login', req.ip, req.lang);
  if (!sent.ok) return renderJoin(req, res, { status: 429, error: sent.error === 'send_failed' ? 'تعذّر إرسال الرمز إلى بريدك الآن. حاول مرة أخرى بعد قليل.' : joins.MESSAGES.rate_limited, code: typed, email: address });
  res.cookie(JOIN_COOKIE, auth.signStepToken({ email: address, code: typed, sentAt: Date.now() }, 'join-email', JOIN_SECONDS), joinCookieOptions());
  return res.redirect('/join/verify');
}

router.get('/join/verify', (req, res) => {
  const pending = pendingJoin(req);
  if (!pending) return res.redirect('/join');
  return renderJoinVerify(req, res, pending);
});

router.post('/join/resend', wrap(async (req, res) => {
  const pending = pendingJoin(req);
  if (!pending) return res.redirect('/join');
  const sent = await emailCode.request(pending.email, 'login', req.ip, req.lang);
  if (!sent.ok) return renderJoinVerify(req, res, pending, joins.MESSAGES.rate_limited, 429);
  res.cookie(JOIN_COOKIE, auth.signStepToken({ ...pending, sentAt: Date.now() }, 'join-email', JOIN_SECONDS), joinCookieOptions());
  return res.redirect('/join/verify');
}));

router.post('/join/verify', wrap(async (req, res) => {
  const pending = pendingJoin(req);
  if (!pending) return res.redirect('/join');
  const typed = req.body.code || ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((k) => req.body[k] || '').join('');
  const result = await emailCode.verify(pending.email, toWesternDigits(String(typed)).replace(/\D/g, ''), 'login');
  if (!result.ok) return renderJoinVerify(req, res, pending, 'الرمز غير صحيح أو انتهت صلاحيته. أعد المحاولة أو اطلب رمزاً جديداً.', 422);
  res.clearCookie(JOIN_COOKIE, { path: '/join' });
  let found = await emailAuth.findForLogin(db.pool, pending.email);
  if (!found.ok && found.error === 'unknown') {
    const made = await emailAuth.register(db.pool, pending.email, { signupsDisabled: () => platformSettings.signupsDisabled(db.pool) });
    if (!made.ok && made.error !== 'exists') return renderJoin(req, res, { status: 403, error: joins.MESSAGES.invalid, code: pending.code, email: pending.email });
    found = await emailAuth.findForLogin(db.pool, pending.email);
  }
  if (!found.ok) return renderJoin(req, res, { status: 403, error: joins.MESSAGES.invalid, code: pending.code, email: pending.email });
  const user = found.user;
  if (joins.OFFICE_ROLES.has(user.role)) return renderJoin(req, res, { status: 403, error: joins.MESSAGES.office_user });
  const joined = await joins.joinWithCode(db.pool, { userId: user.id, code: pending.code, ip: req.ip });
  // The session goes into the cookie of the role the person has now (landlord or tenant keep their own).
  const [[fresh]] = await db.pool.query('SELECT role FROM users WHERE id = ?', [user.id]);
  await auth.issueSession(req, res, { ...user, role: fresh ? fresh.role : user.role });
  if (!joined.ok) return res.redirect(auth.homeFor(fresh ? fresh.role : user.role));
  return res.redirect(joined.kind === 'staff' ? '/office' : `${AREAS[joined.kind].href}?done=joined`);
}));

router.get('/join', (req, res) => renderJoin(req, res));

router.post('/join', wrap(async (req, res) => {
  if (!req.user) return emailCode.enabled() ? guestJoin(req, res) : res.redirect('/login?next=/join');
  const typed = String(req.body.code || '').slice(0, 40);
  if (joins.OFFICE_ROLES.has(req.user.role)) return renderJoin(req, res, { status: 403 });
  const wait = joins.joinGuard.attempt({ userId: req.user.id, ip: req.ip });
  if (wait > 0) {
    res.set('Retry-After', String(wait));
    return renderJoin(req, res, { status: 429, error: joins.MESSAGES.rate_limited, code: typed });
  }
  const result = await joins.joinWithCode(db.pool, { userId: req.user.id, code: typed, ip: req.ip });
  if (!result.ok) {
    const status = result.reason === 'office_user' ? 403 : result.reason === 'member_limit' ? 409 : 422;
    return renderJoin(req, res, { status, error: joins.MESSAGES[result.reason] || joins.MESSAGES.invalid, code: typed });
  }
  // A first join gives the person a role: move the session to that role's cookie.
  const [[fresh]] = await db.pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
  const target = auth.cookieFor(fresh && fresh.role);
  const used = req.sessionCookie;
  if (used && target.name !== used.name && req.cookies && req.cookies[used.name]) {
    res.cookie(target.name, req.cookies[used.name], auth.cookieOptions(7 * 24 * 60 * 60, target.path));
    res.clearCookie(used.name, { path: used.path });
  }
  return res.redirect(result.kind === 'staff' ? '/office' : `${AREAS[result.kind].href}?done=joined`);
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
    fmt: money.formatHalalas,
    entryMethods: paymentEntries.METHODS,
    entryRoleLabels: paymentEntries.ROLE_LABELS,
    undoable: (e) => e.canUndo && e.recorded_role === 'landlord' && Number(e.recorded_by) === Number(req.user.id),
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

// Record a payment received (full or partial) and undo it within 24 hours.
const PAY_ERRORS = {
  closed: 'هذه الدفعة مسددة بالكامل أو ملغاة.',
  exceeds: 'المبلغ أكبر من المتبقي على هذه الدفعة.',
  amount: 'اكتب مبلغاً صحيحاً.',
  expired: 'انتهت مهلة التراجع (24 ساعة).',
  forbidden: 'يمكنك التراجع فقط عن الدفعات التي سجلتها أنت.',
};

function payError(res, status, message, back) {
  return res.status(status).render('payments/error', { title: 'تعذر تنفيذ الطلب', message, back });
}

router.post('/landlord/contracts/:id/payments/:paymentId/entries', landlordArea, requirePerm('own.payments'), wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  const view = paymentId && await portal.landlordContract(db.pool, req.links, parseId(req.params.id), today());
  if (!view || !view.payments.some((p) => Number(p.id) === paymentId)) return notFound(res);
  const back = `/landlord/contracts/${view.contract.id}#payments`;
  const { values, errors } = paymentEntries.validateEntry(req.body, today());
  if (Object.keys(errors).length) return payError(res, 422, Object.values(errors)[0], back);
  const result = await paymentEntries.recordPayment(db.pool, view.link.office_id, {
    contractId: view.contract.id, paymentId, values, actor: { id: req.user.id, role: 'landlord' }, ip: req.ip, today: today(),
  });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return payError(res, 409, PAY_ERRORS[result.error] || PAY_ERRORS.amount, back);
  return res.redirect(`/landlord/contracts/${view.contract.id}?done=recorded#payments`);
}));

router.post('/landlord/contracts/:id/payments/:paymentId/entries/:entryId/undo', landlordArea, requirePerm('own.payments'), wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  const entryId = parseId(req.params.entryId);
  const view = paymentId && entryId && await portal.landlordContract(db.pool, req.links, parseId(req.params.id), today());
  if (!view || !view.payments.some((p) => Number(p.id) === paymentId)) return notFound(res);
  const back = `/landlord/contracts/${view.contract.id}#payments`;
  const reason = paymentEntries.validateReason(req.body.reason);
  if (reason.error) return payError(res, 422, reason.error, back);
  const result = await paymentEntries.undoEntry(db.pool, view.link.office_id, {
    contractId: view.contract.id, paymentId, entryId, reason: reason.value, actor: { id: req.user.id, role: 'landlord' }, ip: req.ip,
  });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return payError(res, 409, PAY_ERRORS[result.error], back);
  return res.redirect(`/landlord/contracts/${view.contract.id}?done=undone#payments`);
}));

function renderReceipt(res, { view, officeName, backUrl }) {
  return res.render('payments/receipt', {
    title: 'كشف دفعات العقد',
    officeName,
    unitLabel: view.contract.unit_label,
    startDate: view.contract.start_date,
    endDate: view.contract.end_date,
    today: today(),
    history: view.payments,
    totals: paymentEntries.totalsOf(view.payments),
    fmt: money.formatHalalas,
    methods: paymentEntries.METHODS,
    paymentLabels: contracts.PAYMENT_LABELS,
    backUrl,
  });
}

router.get('/landlord/contracts/:id/receipt', landlordArea, requirePerm('own.contracts'), wrap(async (req, res) => {
  const view = await portal.landlordContract(db.pool, req.links, parseId(req.params.id), today());
  if (!view) return notFound(res);
  return renderReceipt(res, { view, officeName: view.link.office_name, backUrl: `/landlord/contracts/${view.contract.id}#payments` });
}));

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
    paymentLabels: { ...contracts.PAYMENT_LABELS, tenant_reported: 'أبلغتَ بالدفع' },
    requestTypes: feedback.REQUEST_TYPES,
    requestStatuses: feedback.REQUEST_STATUSES,
    noteMax: 500,
  });
}));

async function tenantView(req) {
  return portal.tenantContract(db.pool, req.links, parseId(req.params.id), today(), req.user.id);
}

router.get('/tenant/contracts/:id/receipt', tenantArea, requirePerm('own.contract'), wrap(async (req, res) => {
  const view = await tenantView(req);
  if (!view) return notFound(res);
  const history = await paymentEntries.historyFor(db.pool, view.link.office_id, view.contract.id, today());
  return renderReceipt(res, { view: { ...view, payments: history }, officeName: view.link.office_name, backUrl: `/tenant#contract-${view.contract.id}` });
}));

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

// ------------------------------------------------------------ rate the office (owner's decision, Nov 2026)

const reviews = require('../services/reviews');
const { icon } = require('../services/listingIcons');
const { rateLimit } = require('../middleware/rateLimit');

const reviewLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyFor: (req) => `office-review:${req.user.id}` });
const REVIEW_DONE = { saved: 'تم حفظ تقييمك. شكراً لك.', pending: 'تم حفظ تقييمك، ويظهر تعليقك بعد مراجعته.' };

async function renderReview(req, res, kind, { status = 200, errors = {}, values = {}, officeId = null } = {}) {
  const offices = await reviews.eligibleOffices(db.pool, req.user.id);
  const mine = await reviews.ownReviews(db.pool, req.user.id, offices.map((o) => o.officeId));
  return res.status(status).render('portal/review', {
    title: 'تقييم المكتب',
    base: `/${kind}`,
    offices,
    mine,
    errors,
    values,
    errorOffice: officeId,
    icon,
    commentMax: reviews.COMMENT_MAX,
    commentStatus: reviews.COMMENT_STATUS,
    message: REVIEW_DONE[req.query.done] || null,
  });
}

for (const [kind, area, perm] of [['landlord', landlordArea, 'own.contracts'], ['tenant', tenantArea, 'own.contract']]) {
  router.get(`/${kind}/review`, area, requirePerm(perm), wrap((req, res) => renderReview(req, res, kind)));
  router.post(`/${kind}/review`, area, requirePerm(perm), reviewLimit, wrap(async (req, res) => {
    const result = await reviews.save(db.pool, { userId: req.user.id, officeId: Number(req.body.office_id), body: req.body, ip: req.ip });
    if (!result.ok && result.error === 'not_eligible') return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
    if (!result.ok) return renderReview(req, res, kind, { status: 422, errors: result.errors, values: { ...result.values, rating: req.body.rating }, officeId: Number(req.body.office_id) });
    return res.redirect(`/${kind}/review?done=${result.commentPending ? 'pending' : 'saved'}`);
  }));
}

module.exports = router;
module.exports.loadArea = loadArea;
