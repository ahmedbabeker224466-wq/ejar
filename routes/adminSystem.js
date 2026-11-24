'use strict';

// Platform admin: platform settings, kill switches, analytics snippet and the audit viewer.
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


module.exports = function registerSystem(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText }) {
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
    return { ...r, label: auditLabels.labelFor(r.action), reason: after && typeof after.reason === 'string' ? after.reason : '' };
  });
  return res.render('admin/audit', { title: 'سجل التدقيق', ...result, rows, filters });
}));

};
