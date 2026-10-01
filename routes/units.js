'use strict';

// /office/units: units and buildings (two tabs), capability 'units'.
// Mounted inside routes/office.js after requireAuth -> loadOffice -> officeGate,
// so req.office is always the signed-in member's office. Ids from the URL are
// looked up only inside req.office; anything else answers 404.

const express = require('express');
const db = require('../config/db');
const units = require('../services/units');
const buildings = require('../services/buildings');
const unitStatus = require('../services/unitStatus');
const { parseId } = require('../services/landlords');
const { scopeToOffice } = require('../services/scopeToOffice');
const { SAUDI_CITIES } = require('../services/offices');
const { requirePerm, can } = require('../middleware/permissions');
const contractsService = require('../services/contracts');
const { riyadhDate } = require('../services/contractDates');

const router = express.Router();

const MESSAGES = {
  created: 'تمت إضافة الوحدة.',
  bulk_created: 'تمت إضافة الوحدات.',
  saved: 'تم حفظ بيانات الوحدة.',
  status: 'تم تغيير حالة الوحدة.',
  deleted: 'تم حذف الوحدة.',
  building_created: 'تمت إضافة المبنى.',
  building_saved: 'تم حفظ بيانات المبنى.',
  building_deleted: 'تم حذف المبنى.',
};
const STATUS_ERRORS = {
  from_rented: 'الوحدة مؤجرة. تتغير حالتها تلقائياً عند انتهاء العقد، ولا يمكن تغييرها يدوياً.',
  to_rented: 'حالة "مؤجرة" تُضبط تلقائياً عند إضافة عقد للوحدة، ولا يمكن اختيارها يدوياً.',
  invalid: 'اختر حالة صحيحة.',
};
const DELETE_ERRORS = {
  rented: 'لا يمكن حذف وحدة مؤجرة.',
  has_contract: 'لا يمكن حذف وحدة لها عقد. العقود تبقى محفوظة دائماً.',
  has_links: 'لا يمكن حذف وحدة لها طلبات صيانة أو إعلانات.',
  has_units: 'لا يمكن حذف مبنى فيه وحدات. انقل الوحدات أو احذفها أولاً.',
};

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function loadUnit(req, res, next) {
  try {
    req.unit = await units.getUnit(db.pool, req.office.id, parseId(req.params.id));
    return req.unit ? next() : notFound(res);
  } catch (err) {
    return next(err);
  }
}

async function loadBuilding(req, res, next) {
  try {
    req.building = await buildings.getBuilding(db.pool, req.office.id, parseId(req.params.id));
    return req.building ? next() : notFound(res);
  } catch (err) {
    return next(err);
  }
}

function hasErrors(errors) {
  return Object.keys(errors).length > 0;
}

// ------------------------------------------------------------ the page with two tabs

router.get('/office/units', requirePerm('units'), wrap(async (req, res) => {
  const tab = req.query.tab === 'buildings' ? 'buildings' : 'units';
  const landlordId = parseId(req.query.landlord);
  const common = {
    title: 'العقارات والوحدات',
    tab,
    landlords: await buildings.landlordOptions(db.pool, req.office.id),
    counts: await units.unitCounts(db.pool, req.office.id),
    message: MESSAGES[req.query.done] || null,
    q: String(req.query.q || '').slice(0, 60),
    landlordId,
  };
  const pageUrl = (params) => (page) => {
    const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    if (page > 1) search.set('page', String(page));
    const text = search.toString();
    return `/office/units${text ? `?${text}` : ''}`;
  };

  if (tab === 'buildings') {
    const result = await buildings.listBuildings(db.pool, req.office.id, { q: common.q, landlordId, page: req.query.page });
    const url = pageUrl({ tab: 'buildings', q: common.q, landlord: landlordId });
    return res.render('office/units/index', {
      ...common,
      ...result,
      filtered: Boolean(common.q || landlordId),
      prevUrl: result.page > 1 ? url(result.page - 1) : null,
      nextUrl: result.page < result.pages ? url(result.page + 1) : null,
    });
  }

  const buildingId = parseId(req.query.building);
  const status = Object.hasOwn(units.STATUS_LABELS, String(req.query.status)) ? req.query.status : '';
  const unitType = Object.hasOwn(units.UNIT_TYPES, String(req.query.type)) ? req.query.type : '';
  const result = await units.listUnits(db.pool, req.office.id, {
    q: common.q, landlordId, buildingId, status, unitType, page: req.query.page,
  });
  const url = pageUrl({ q: common.q, landlord: landlordId, building: buildingId, status, type: unitType });
  return res.render('office/units/index', {
    ...common,
    ...result,
    buildingOptions: await buildings.buildingOptions(db.pool, req.office.id),
    buildingId,
    status,
    unitType,
    unitTypes: units.UNIT_TYPES,
    statusLabels: units.STATUS_LABELS,
    filtered: Boolean(common.q || landlordId || buildingId || status || unitType),
    prevUrl: result.page > 1 ? url(result.page - 1) : null,
    nextUrl: result.page < result.pages ? url(result.page + 1) : null,
  });
}));

// ------------------------------------------------------------ buildings

async function renderBuildingForm(req, res, { building = null, values, errors = {}, status = 200 }) {
  return res.status(status).render('office/units/building-form', {
    title: building ? 'تعديل المبنى' : 'إضافة مبنى',
    building,
    values,
    errors,
    cities: SAUDI_CITIES,
    landlords: await buildings.landlordOptions(db.pool, req.office.id, building ? building.landlord_id : null),
  });
}

router.get('/office/units/buildings/new', requirePerm('units'), wrap(async (req, res) => {
  renderBuildingForm(req, res, {
    values: { landlord_id: parseId(req.query.landlord), name: '', city: SAUDI_CITIES[0], district: '', notes: '' },
  });
}));

router.post('/office/units/buildings', requirePerm('units'), wrap(async (req, res) => {
  const { values, errors } = buildings.validateBuildingFields(req.body);
  if (hasErrors(errors)) return renderBuildingForm(req, res, { values, errors, status: 422 });
  const result = await buildings.createBuilding(db.pool, req.office.id, { fields: values, actorId: req.user.id, ip: req.ip });
  if (!result.ok) return renderBuildingForm(req, res, { values, errors: result.errors, status: 422 });
  return res.redirect('/office/units?tab=buildings&done=building_created');
}));

router.get('/office/units/buildings/:id/edit', requirePerm('units'), loadBuilding, wrap(async (req, res) => {
  renderBuildingForm(req, res, { building: req.building, values: req.building });
}));

router.post('/office/units/buildings/:id', requirePerm('units'), loadBuilding, wrap(async (req, res) => {
  const { values, errors } = buildings.validateBuildingFields(req.body);
  if (hasErrors(errors)) return renderBuildingForm(req, res, { building: req.building, values, errors, status: 422 });
  const result = await buildings.updateBuilding(db.pool, req.office.id, req.building, { fields: values, actorId: req.user.id, ip: req.ip });
  if (!result.ok) return renderBuildingForm(req, res, { building: req.building, values, errors: result.errors, status: 409 });
  return res.redirect('/office/units?tab=buildings&done=building_saved');
}));

router.post('/office/units/buildings/:id/delete', requirePerm('contracts.delete'), loadBuilding, wrap(async (req, res) => {
  const result = await buildings.deleteBuilding(db.pool, req.office.id, req.building.id, { actorId: req.user.id, ip: req.ip });
  if (result === 'not_found') return notFound(res);
  if (result === 'has_units') {
    return renderBuildingForm(req, res, { building: req.building, values: req.building, errors: { form: DELETE_ERRORS.has_units }, status: 409 });
  }
  return res.redirect('/office/units?tab=buildings&done=building_deleted');
}));

// ------------------------------------------------------------ one unit, many units

async function formOptions(req, keepLandlordId = null) {
  return {
    landlords: await buildings.landlordOptions(db.pool, req.office.id, keepLandlordId),
    buildingOptions: await buildings.buildingOptions(db.pool, req.office.id),
    cities: SAUDI_CITIES,
    unitTypes: units.UNIT_TYPES,
    amenityLabels: units.AMENITIES,
  };
}

function formValues(source = {}) {
  return {
    landlord_id: source.landlord_id || null,
    building_id: source.building_id || null,
    label: source.label || '',
    unit_type: source.unit_type || 'apartment',
    rooms: source.rooms ?? '',
    bathrooms: source.bathrooms ?? '',
    area_sqm: source.area_sqm ?? '',
    floor_no: source.floor_no ?? '',
    is_furnished: Number(source.is_furnished) === 1,
    city: source.city || '',
    district: source.district || '',
    base_rent: source.base_rent ?? '',
    notes: source.notes || '',
    amenities: source.amenities || [],
  };
}

/** Values to show again after a failed submit: what the person typed. */
function typedValues(body, values) {
  return {
    ...formValues(values),
    ...Object.fromEntries(['rooms', 'bathrooms', 'area_sqm', 'floor_no', 'base_rent'].map((f) => [f, String(body[f] ?? '').slice(0, 30)])),
  };
}

async function renderUnitForm(req, res, { unit = null, values, errors = {}, limit = null, status = 200 }) {
  return res.status(status).render('office/units/form', {
    title: unit ? 'تعديل الوحدة' : 'إضافة وحدة',
    unit,
    values,
    errors,
    limit,
    ...(await formOptions(req, unit ? unit.landlord_id : null)),
  });
}

async function renderBulkForm(req, res, { values, errors = {}, limit = null, status = 200 }) {
  return res.status(status).render('office/units/bulk', {
    title: 'إضافة عدة وحدات',
    values,
    errors,
    limit,
    bulkMax: units.BULK_MAX,
    ...(await formOptions(req)),
  });
}

router.get('/office/units/new', requirePerm('units'), wrap(async (req, res) => {
  renderUnitForm(req, res, { values: formValues({ landlord_id: parseId(req.query.landlord), building_id: parseId(req.query.building) }) });
}));

router.post('/office/units', requirePerm('units'), wrap(async (req, res) => {
  const { values, errors } = units.validateUnitFields(req.body);
  if (hasErrors(errors)) return renderUnitForm(req, res, { values: typedValues(req.body, values), errors, status: 422 });
  const result = await units.createUnit(db.pool, req.office.id, { fields: values, actorId: req.user.id, ip: req.ip });
  if (result.limit) return renderUnitForm(req, res, { values: typedValues(req.body, values), limit: result.limit, status: 409 });
  if (!result.ok) return renderUnitForm(req, res, { values: typedValues(req.body, values), errors: result.errors, status: 422 });
  return res.redirect(`/office/units/${result.id}?done=created`);
}));

router.get('/office/units/bulk', requirePerm('units'), wrap(async (req, res) => {
  renderBulkForm(req, res, {
    values: { landlord_id: parseId(req.query.landlord), building_id: null, prefix: 'شقة', count: '', start: '1', unit_type: 'apartment', base_rent: '', city: '' },
  });
}));

router.post('/office/units/bulk', requirePerm('units'), wrap(async (req, res) => {
  const { values, errors } = units.validateBulkFields(req.body);
  const shown = { ...values, count: String(req.body.count ?? '').slice(0, 10), start: String(req.body.start ?? '').slice(0, 10), base_rent: String(req.body.base_rent ?? '').slice(0, 30) };
  if (hasErrors(errors)) return renderBulkForm(req, res, { values: shown, errors, status: 422 });
  const result = await units.createUnitsBulk(db.pool, req.office.id, { fields: values, actorId: req.user.id, ip: req.ip });
  if (result.limit) return renderBulkForm(req, res, { values: shown, limit: result.limit, status: 409 });
  if (!result.ok) return renderBulkForm(req, res, { values: shown, errors: result.errors, status: 422 });
  return res.redirect(`/office/units?landlord=${values.landlord_id}&done=bulk_created`);
}));

async function renderUnit(req, res, { status = 200, error = null } = {}) {
  const unit = req.unit;
  return res.status(status).render('office/units/show', {
    title: unit.label,
    unit,
    unitTypes: units.UNIT_TYPES,
    statusLabels: units.STATUS_LABELS,
    amenityLabels: units.AMENITIES,
    message: MESSAGES[req.query.done] || null,
    error,
    contracts: await contractsService.listContracts(db.pool, req.office.id, { unitId: unit.id, pageSize: 20 }, riyadhDate(new Date())),
    stageLabels: contractsService.STAGE_LABELS,
    canDelete: can(req.memberRole, 'contracts.delete') && unit.status !== 'rented'
      && unit.contracts_count + unit.maintenance_count + unit.listings_count === 0,
  });
}

router.get('/office/units/:id', requirePerm('units'), loadUnit, wrap((req, res) => renderUnit(req, res)));

router.get('/office/units/:id/edit', requirePerm('units'), loadUnit, wrap(async (req, res) => {
  renderUnitForm(req, res, { unit: req.unit, values: formValues(req.unit) });
}));

router.post('/office/units/:id', requirePerm('units'), loadUnit, wrap(async (req, res) => {
  const { values, errors } = units.validateUnitFields(req.body);
  if (hasErrors(errors)) return renderUnitForm(req, res, { unit: req.unit, values: typedValues(req.body, values), errors, status: 422 });
  const result = await units.updateUnit(db.pool, req.office.id, req.unit.id, { fields: values, actorId: req.user.id, ip: req.ip });
  if (result === null) return notFound(res);
  if (!result.ok) return renderUnitForm(req, res, { unit: req.unit, values: typedValues(req.body, values), errors: result.errors, status: 422 });
  return res.redirect(`/office/units/${req.unit.id}?done=saved`);
}));

router.post('/office/units/:id/status', requirePerm('units'), loadUnit, wrap(async (req, res) => {
  const result = await unitStatus.changeStatusByHand(scopeToOffice(db.pool, req.office.id), req.unit.id, String(req.body.status || ''), {
    actorId: req.user.id,
    ip: req.ip,
  });
  if (result === 'not_found') return notFound(res);
  if (STATUS_ERRORS[result]) return renderUnit(req, res, { status: 409, error: STATUS_ERRORS[result] });
  return res.redirect(`/office/units/${req.unit.id}?done=status`);
}));

router.post('/office/units/:id/delete', requirePerm('contracts.delete'), loadUnit, wrap(async (req, res) => {
  const result = await units.deleteUnit(db.pool, req.office.id, req.unit.id, { actorId: req.user.id, ip: req.ip });
  if (result === 'not_found') return notFound(res);
  if (result !== 'deleted') return renderUnit(req, res, { status: 409, error: DELETE_ERRORS[result] });
  return res.redirect('/office/units?done=deleted');
}));

module.exports = router;
