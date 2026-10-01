'use strict';

// /office/landlords: list, create, edit, (de)activate, delete, invites.
// Mounted inside routes/office.js after requireAuth -> loadOffice -> officeGate,
// so req.office is always the signed-in member's office. A landlord id from the
// URL is only ever looked up inside req.office; any other id answers 404.

const express = require('express');
const db = require('../config/db');
const landlords = require('../services/landlords');
const invites = require('../services/invites');
const unitsService = require('../services/units');
const contractsService = require('../services/contracts');
const { riyadhDate: riyadhToday } = require('../services/contractDates');
const { scopeToOffice } = require('../services/scopeToOffice');
const { withTransaction } = require('../services/transaction');
const { SAUDI_CITIES } = require('../services/offices');
const { riyadhDate } = require('../services/contractDates');
const { toLocal, maskPhone } = require('../utils/phone');
const { requirePerm, can } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const STATUS_LABELS = { joined: 'انضم', invited: 'مدعو', not_invited: 'غير مدعو' };
const INVITE_LABELS = { active: 'فعّال', used: 'مستخدم', expired: 'منتهي', revoked: 'ملغى' };
const MESSAGES = {
  saved: 'تم حفظ بيانات المالك.',
  created: 'تمت إضافة المالك.',
  deactivated: 'تم إيقاف المالك. يمكنك إعادة تفعيله في أي وقت.',
  activated: 'تمت إعادة تفعيل المالك.',
  deleted: 'تم حذف المالك.',
  invite_created: 'تم إنشاء رمز دعوة جديد. أرسله للمالك.',
  invite_revoked: 'تم إلغاء رمز الدعوة.',
};
const ERRORS = {
  has_links: 'لا يمكن حذف مالك مرتبط بعقارات أو وحدات أو عقود. يمكنك إيقافه بدلاً من الحذف.',
  inactive: 'المالك موقوف. أعد تفعيله أولاً ثم أنشئ رمز الدعوة.',
  joined: 'المالك انضم بالفعل، ولا يحتاج إلى رمز دعوة.',
  limited: 'أنشأت رموز دعوة كثيرة خلال ساعة. انتظر قليلاً ثم حاول مرة أخرى.',
};

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

function formValues(values = {}) {
  return {
    label: values.label || '',
    city: values.city || '',
    phone: values.phone ? toLocal(values.phone) : '',
    notes: values.notes || '',
  };
}

/** Loads req.landlord from the URL id, inside this office only; 404 otherwise. */
async function loadLandlord(req, res, next) {
  try {
    req.landlord = await landlords.getLandlord(db.pool, req.office.id, landlords.parseId(req.params.id));
    if (!req.landlord) return notFound(res);
    return next();
  } catch (err) {
    return next(err);
  }
}

/** The public base URL for links sent to people (APP_URL, else this host). */
function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

async function inviteView(req, landlord) {
  const row = await invites.latestLandlordInvite(scopeToOffice(db.pool, req.office.id), landlord.id);
  if (!row) return null;
  const status = invites.inviteStatus(row);
  return {
    status,
    label: INVITE_LABELS[status],
    code: status === 'active' ? row.code : null,
    expiresOn: riyadhDate(new Date(row.expires_at)),
    usedBy: status === 'used' && row.used_by_phone ? maskPhone(row.used_by_phone) : null,
    shareLink:
      status === 'active'
        ? invites.inviteShareLink({ code: row.code, officeName: req.office.name, baseUrl: baseUrl(req), phone: landlord.phone })
        : null,
  };
}

async function renderDetail(req, res, { status = 200, error = null } = {}) {
  const landlord = req.landlord;
  return res.status(status).render('office/landlords/show', {
    title: landlord.label,
    landlord: { ...landlord, phoneLocal: landlord.phone ? toLocal(landlord.phone) : null },
    statusLabel: STATUS_LABELS[landlord.status],
    invite: await inviteView(req, landlord),
    units: await unitsService.listUnits(db.pool, req.office.id, { landlordId: landlord.id, pageSize: 50 }),
    unitStatusLabels: unitsService.STATUS_LABELS,
    contracts: await contractsService.listContracts(db.pool, req.office.id, { landlordId: landlord.id, pageSize: 20 }, riyadhToday(new Date())),
    stageLabels: contractsService.STAGE_LABELS,
    message: MESSAGES[req.query.done] || null,
    error,
    canDelete:
      can(req.memberRole, 'contracts.delete') &&
      landlord.units_count + landlord.contracts_count + landlord.buildings_count === 0,
  });
}

function renderForm(res, { landlord = null, values, errors = {}, status = 200 }) {
  return res.status(status).render('office/landlords/form', {
    title: landlord ? `تعديل ${landlord.label}` : 'إضافة مالك',
    landlord,
    values,
    errors,
    cities: SAUDI_CITIES,
  });
}

// ------------------------------------------------------------ list

router.get('/office/landlords', requirePerm('landlords'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 60);
    const status = landlords.STATUSES.includes(req.query.status) ? req.query.status : '';
    const result = await landlords.listLandlords(db.pool, req.office.id, { q, status, page: req.query.page });
    const pageUrl = (page) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (page > 1) params.set('page', String(page));
      const text = params.toString();
      return `/office/landlords${text ? `?${text}` : ''}`;
    };
    return res.render('office/landlords/index', {
      title: 'الملّاك',
      ...result,
      rows: result.rows.map((r) => ({ ...r, phoneLocal: r.phone ? toLocal(r.phone) : null, statusLabel: STATUS_LABELS[r.status] })),
      q,
      status,
      statusLabels: STATUS_LABELS,
      filtered: Boolean(q || status),
      prevUrl: result.page > 1 ? pageUrl(result.page - 1) : null,
      nextUrl: result.page < result.pages ? pageUrl(result.page + 1) : null,
      message: MESSAGES[req.query.done] || null,
    });
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ create

router.get('/office/landlords/new', requirePerm('landlords'), (req, res) => renderForm(res, { values: formValues() }));

router.post('/office/landlords', requirePerm('landlords'), async (req, res, next) => {
  try {
    const { values, errors } = landlords.validateLandlordFields(req.body);
    if (Object.keys(errors).length) {
      return renderForm(res, {
        values: { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20) },
        errors,
        status: 422,
      });
    }
    const id = await landlords.createLandlord(db.pool, req.office.id, { fields: values, actorId: req.user.id, ip: req.ip });
    return res.redirect(`/office/landlords/${id}?done=created`);
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ one landlord

router.get('/office/landlords/:id', requirePerm('landlords'), loadLandlord, async (req, res, next) => {
  try {
    return await renderDetail(req, res);
  } catch (err) {
    return next(err);
  }
});

router.get('/office/landlords/:id/edit', requirePerm('landlords'), loadLandlord, (req, res) =>
  renderForm(res, { landlord: req.landlord, values: formValues(req.landlord) }),
);

router.post('/office/landlords/:id', requirePerm('landlords'), loadLandlord, async (req, res, next) => {
  try {
    const { values, errors } = landlords.validateLandlordFields(req.body);
    if (Object.keys(errors).length) {
      return renderForm(res, {
        landlord: req.landlord,
        values: { ...formValues(values), phone: String(req.body.phone || '').slice(0, 20) },
        errors,
        status: 422,
      });
    }
    await landlords.updateLandlord(db.pool, req.office.id, req.landlord.id, { fields: values, actorId: req.user.id, ip: req.ip });
    return res.redirect(`/office/landlords/${req.landlord.id}?done=saved`);
  } catch (err) {
    return next(err);
  }
});

for (const [action, active] of [['deactivate', false], ['activate', true]]) {
  router.post(`/office/landlords/:id/${action}`, requirePerm('landlords'), loadLandlord, async (req, res, next) => {
    try {
      await landlords.setLandlordActive(db.pool, req.office.id, req.landlord.id, active, { actorId: req.user.id, ip: req.ip });
      return res.redirect(`/office/landlords/${req.landlord.id}?done=${active ? 'activated' : 'deactivated'}`);
    } catch (err) {
      return next(err);
    }
  });
}

router.post('/office/landlords/:id/delete', requirePerm('contracts.delete'), loadLandlord, async (req, res, next) => {
  try {
    const result = await landlords.deleteLandlord(db.pool, req.office.id, req.landlord.id, { actorId: req.user.id, ip: req.ip });
    if (result === 'not_found') return notFound(res);
    if (result === 'has_links') return await renderDetail(req, res, { status: 409, error: ERRORS.has_links });
    return res.redirect('/office/landlords?done=deleted');
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ invites

const inviteLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (req) => `invite-create:${req.office.id}`,
  onLimit: (req, res, next) => renderDetail(req, res, { status: 429, error: ERRORS.limited }).catch(next),
});

router.post('/office/landlords/:id/invite', requirePerm('landlords'), loadLandlord, inviteLimit, async (req, res, next) => {
  let result;
  try {
    result = await withTransaction(db.pool, (conn) =>
      invites.createLandlordInvite(scopeToOffice(conn, req.office.id), {
        landlordId: req.landlord.id,
        createdBy: req.user.id,
        ip: req.ip,
      }),
    );
  } catch (err) {
    return next(err);
  }
  try {
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(res);
      return await renderDetail(req, res, { status: 409, error: ERRORS[result.reason] });
    }
    return res.redirect(`/office/landlords/${req.landlord.id}?done=invite_created#invite`);
  } catch (err) {
    return next(err);
  }
});

router.post('/office/landlords/:id/invite/revoke', requirePerm('landlords'), loadLandlord, async (req, res, next) => {
  try {
    await invites.revokeInvite(scopeToOffice(db.pool, req.office.id), { landlordId: req.landlord.id, actorId: req.user.id, ip: req.ip });
    return res.redirect(`/office/landlords/${req.landlord.id}?done=invite_revoked#invite`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
