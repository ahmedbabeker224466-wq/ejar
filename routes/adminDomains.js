'use strict';

// /admin/domains: the platform admin's queue of custom domain requests
// (services/domains.js). Behind the admin guard (platform admin + 2FA +
// same-origin). Every change needs a written reason and is audit-logged; a
// status change notifies the office. "Check propagation" only runs a standard
// NS lookup and shows the result; it changes nothing. Activation stores the
// domain on the office but does NOT change routing (manual for now).

const db = require('../config/db');
const domains = require('../services/domains');
const money = require('../services/money');
const { rateLimit } = require('../middleware/rateLimit');

const CHECK_LIMIT = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyFor: (req) => `domain-check:${req.user.id}`,
  onLimit: (req, res) => res.status(429).type('text/plain; charset=utf-8').send('استعلامات كثيرة. انتظر 10 دقائق.'),
});

const FILTERS = ['open', ...domains.STATUSES];

module.exports = function registerDomains(router, { wrap, notFound, reasonOf, REASON_ERROR, doneText }) {
  router.get('/admin/domains', wrap(async (req, res) => {
    const status = FILTERS.includes(String(req.query.status || '')) ? String(req.query.status) : '';
    const list = await domains.listRequests(db.pool, { status, page: req.query.page });
    return res.render('admin/domains', {
      title: 'طلبات الدومين', ...list, status, filters: FILTERS, labels: domains.STATUS_LABELS,
    });
  }));

  async function renderDetail(req, res, { status = 200, errors = {}, values = null, check = null, probe = null, error = null } = {}) {
    const request = await domains.getRequest(db.pool, req.params.id);
    if (!request) return notFound(res);
    return res.status(status).render('admin/domain', {
      title: `طلب دومين ${request.domain}`,
      request,
      labels: domains.STATUS_LABELS,
      next: domains.TRANSITIONS[request.status] || [],
      errors,
      error,
      values: values || {
        price_cost: request.price_cost_halalas ? money.formatHalalas(request.price_cost_halalas).replace(/,/g, '') : '',
        admin_note: request.admin_note || '',
        assigned_ns_1: request.assigned_ns_1 || '',
        assigned_ns_2: request.assigned_ns_2 || '',
        dns_zone_ref: request.dns_zone_ref || '',
      },
      check,
      probe,
      lookupErrors: domains.LOOKUP_ERRORS,
      done: doneText(req.query.done),
    });
  }

  router.get('/admin/domains/:id', wrap((req, res) => renderDetail(req, res)));

  router.post('/admin/domains/:id', wrap(async (req, res) => {
    const values = {
      status: String(req.body.status || ''),
      price_cost: String(req.body.price_cost ?? '').slice(0, 20),
      admin_note: String(req.body.admin_note ?? '').slice(0, 600),
      assigned_ns_1: String(req.body.assigned_ns_1 ?? '').slice(0, 260),
      assigned_ns_2: String(req.body.assigned_ns_2 ?? '').slice(0, 260),
      dns_zone_ref: String(req.body.dns_zone_ref ?? '').slice(0, 300),
    };
    const reason = reasonOf(req.body);
    if (!reason) return renderDetail(req, res, { status: 422, values, error: REASON_ERROR });
    const result = await domains.adminUpdate(db.pool, { id: req.params.id, adminId: req.user.id, body: values, reason, ip: req.ip });
    if (result.notFound) return notFound(res);
    if (!result.ok) return renderDetail(req, res, { status: 422, values, errors: result.errors, error: 'راجع الحقول المظللة بالأحمر.' });
    return res.redirect(`/admin/domains/${Number(req.params.id)}?done=domain_saved`);
  }));

  // The live domain check (active requests): DNS A/CNAME and an HTTPS HEAD. Changes nothing.
  router.post('/admin/domains/:id/probe', CHECK_LIMIT, wrap(async (req, res) => {
    const request = await domains.getRequest(db.pool, req.params.id);
    if (!request) return notFound(res);
    const probe = await domains.probeDomain(request.domain, { slug: request.public_slug });
    return renderDetail(req, res, { probe });
  }));

  router.post('/admin/domains/:id/check', CHECK_LIMIT, wrap(async (req, res) => {
    const request = await domains.getRequest(db.pool, req.params.id);
    if (!request) return notFound(res);
    const check = await domains.checkNameservers(request.domain, { expected: [request.assigned_ns_1, request.assigned_ns_2] });
    return renderDetail(req, res, { check });
  }));
};
