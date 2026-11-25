'use strict';

// /office/vendors: the office's maintenance workers (name, trade, mobile,
// notes). Capability 'maintenance'. Another office's id answers 404.

const express = require('express');
const db = require('../config/db');
const vendors = require('../services/vendors');
const { parseId } = require('../services/landlords');
const { requirePerm } = require('../middleware/permissions');

const router = express.Router();
const guard = requirePerm('maintenance');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const DONE = {
  created: 'تمت إضافة الفني.',
  updated: 'تم حفظ التعديل.',
  active: 'تم تفعيل الفني.',
  inactive: 'تم إيقاف الفني. لن يظهر في قائمة الإسناد.',
  deleted: 'تم حذف الفني.',
};

async function renderList(req, res, { status = 200, values = null, errors = {}, editing = null } = {}) {
  const trade = vendors.TRADES[req.query.trade] ? req.query.trade : null;
  const rows = await vendors.listVendors(db.pool, req.office.id, { trade });
  return res.status(status).render('vendors/index', {
    title: 'فنيو الصيانة',
    rows,
    trade,
    trades: vendors.TRADES,
    limits: vendors.LIMITS,
    values: values || { name: '', trade: '', phoneLocal: '', notes: '' },
    errors,
    editing,
    message: DONE[req.query.done] || null,
  });
}

router.get('/office/vendors', guard, wrap((req, res) => renderList(req, res)));

router.post('/office/vendors', guard, wrap(async (req, res) => {
  const { values, errors } = vendors.validateVendor(req.body);
  if (Object.keys(errors).length) return renderList(req, res, { status: 422, values, errors });
  await vendors.createVendor(db.pool, req.office.id, { values, actorId: req.user.id, ip: req.ip });
  return res.redirect('/office/vendors?done=created');
}));

router.get('/office/vendors/:id/edit', guard, wrap(async (req, res) => {
  const vendor = await vendors.getVendor(db.pool, req.office.id, parseId(req.params.id));
  if (!vendor) return notFound(res);
  return renderList(req, res, { editing: vendor, values: { ...vendor, notes: vendor.notes || '' } });
}));

router.post('/office/vendors/:id', guard, wrap(async (req, res) => {
  const vendor = await vendors.getVendor(db.pool, req.office.id, parseId(req.params.id));
  if (!vendor) return notFound(res);
  const { values, errors } = vendors.validateVendor(req.body);
  if (Object.keys(errors).length) return renderList(req, res, { status: 422, values, errors, editing: vendor });
  await vendors.updateVendor(db.pool, req.office.id, vendor.id, { values, actorId: req.user.id, ip: req.ip });
  return res.redirect('/office/vendors?done=updated');
}));

router.post('/office/vendors/:id/active', guard, wrap(async (req, res) => {
  const vendor = await vendors.getVendor(db.pool, req.office.id, parseId(req.params.id));
  if (!vendor) return notFound(res);
  const on = String(req.body.active) === '1';
  await vendors.setActive(db.pool, req.office.id, vendor.id, on, { actorId: req.user.id, ip: req.ip });
  return res.redirect(`/office/vendors?done=${on ? 'active' : 'inactive'}`);
}));

router.post('/office/vendors/:id/delete', guard, wrap(async (req, res) => {
  const vendor = await vendors.getVendor(db.pool, req.office.id, parseId(req.params.id));
  if (!vendor) return notFound(res);
  await vendors.deleteVendor(db.pool, req.office.id, vendor.id, { actorId: req.user.id, ip: req.ip });
  return res.redirect('/office/vendors?done=deleted');
}));

module.exports = router;
