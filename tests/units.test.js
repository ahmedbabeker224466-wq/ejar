'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateUnitFields, validateBulkFields, bulkLabels, UNIT_TYPES, AMENITIES } = require('../services/units');
const { validateBuildingFields } = require('../services/buildings');
const { manualTransition } = require('../services/unitStatus');

const BASE = { landlord_id: '5', label: 'شقة 3', city: 'الرياض' };

test('a unit needs a landlord, a label and a city (or a building)', () => {
  assert.deepEqual(validateUnitFields(BASE).errors, {});
  assert.deepEqual(Object.keys(validateUnitFields({}).errors).sort(), ['city', 'label', 'landlord_id']);
  assert.deepEqual(validateUnitFields({ landlord_id: '5', label: 'شقة', building_id: '9' }).errors, {}, 'city comes from the building');
});

test('numbers: Arabic digits, separators, money as exact strings', () => {
  const { values, errors } = validateUnitFields({
    ...BASE, rooms: '٣', bathrooms: '2', area_sqm: '120.5', floor_no: '-1', base_rent: '٤٥٬٠٠٠٫٥', is_furnished: 'on',
  });
  assert.deepEqual(errors, {});
  assert.equal(values.rooms, 3);
  assert.equal(values.floor_no, -1, 'basement floors are allowed');
  assert.equal(values.area_sqm, '120.50');
  assert.equal(values.base_rent, '45000.50');
  assert.equal(values.is_furnished, 1);
  assert.equal(validateUnitFields({ ...BASE, base_rent: '4,500' }).values.base_rent, '4500.00');
  assert.equal(validateUnitFields({ ...BASE, base_rent: '' }).values.base_rent, null);
});

test('negative, fractional or huge numbers are refused', () => {
  const bad = validateUnitFields({ ...BASE, rooms: '-1', bathrooms: '1.5', area_sqm: '-5', floor_no: '500', base_rent: '-100' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['area_sqm', 'base_rent', 'bathrooms', 'floor_no', 'rooms']);
  assert.ok(validateUnitFields({ ...BASE, base_rent: '12.345' }).errors.base_rent, 'three decimals');
  assert.ok(validateUnitFields({ ...BASE, base_rent: '99999999999' }).errors.base_rent, 'too large for DECIMAL(12,2)');
  assert.ok(validateUnitFields({ ...BASE, area_sqm: '0' }).errors.area_sqm);
});

test('unit types, amenities and enums accept only known values', () => {
  assert.equal(Object.keys(UNIT_TYPES).length, 7);
  assert.equal(Object.keys(AMENITIES).length, 10);
  for (const bad of ['castle', 'toString', 'constructor', '__proto__']) {
    assert.ok(validateUnitFields({ ...BASE, unit_type: bad }).errors.unit_type, bad);
  }
  assert.deepEqual(validateUnitFields({ ...BASE, amenities: ['ac', 'pool', 'ac'] }).values.amenities, ['ac', 'pool']);
  assert.equal(validateUnitFields({ ...BASE, amenities: 'gym' }).values.amenities[0], 'gym');
  assert.ok(validateUnitFields({ ...BASE, amenities: ['ac', 'jacuzzi'] }).errors.amenities);
  assert.ok(validateUnitFields({ ...BASE, amenities: ['hasOwnProperty'] }).errors.amenities);
  assert.ok(validateUnitFields({ ...BASE, notes: 'ن'.repeat(1001) }).errors.notes);
});

test('bulk create: 1 to 30 units from a prefix', () => {
  assert.deepEqual(bulkLabels('شقة', 3, 1), ['شقة 1', 'شقة 2', 'شقة 3']);
  assert.deepEqual(bulkLabels('محل', 2, 10), ['محل 10', 'محل 11']);
  const ok = validateBulkFields({ landlord_id: '1', prefix: 'شقة', count: '12', start: '1', city: 'جدة', base_rent: '30000' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.count, 12);
  for (const count of ['0', '31', '-2', 'abc', '']) assert.ok(validateBulkFields({ landlord_id: '1', prefix: 'شقة', count, city: 'جدة' }).errors.count, count);
});

test('buildings: landlord, name and city required; no address fields exist', () => {
  assert.deepEqual(validateBuildingFields({ landlord_id: '1', name: 'عمارة الملقا', city: 'الرياض' }).errors, {});
  assert.deepEqual(Object.keys(validateBuildingFields({ name: 'x', city: 'Paris' }).errors).sort(), ['city', 'landlord_id', 'name']);
  const { values } = validateBuildingFields({ landlord_id: '1', name: 'عمارة', city: 'الرياض', address: 'شارع 1', deed_no: '123', lat: '24.7', meter_no: '99' });
  assert.deepEqual(Object.keys(values).sort(), ['city', 'district', 'landlord_id', 'name', 'notes']);
});

test('manual status changes: vacant <-> maintenance only', () => {
  assert.deepEqual(manualTransition('vacant', 'maintenance'), { ok: true, reason: null });
  assert.deepEqual(manualTransition('maintenance', 'vacant'), { ok: true, reason: null });
  assert.deepEqual(manualTransition('vacant', 'vacant'), { ok: true, reason: 'unchanged' });
  assert.deepEqual(manualTransition('vacant', 'rented'), { ok: false, reason: 'to_rented' });
  assert.deepEqual(manualTransition('rented', 'vacant'), { ok: false, reason: 'from_rented' });
  assert.deepEqual(manualTransition('rented', 'maintenance'), { ok: false, reason: 'from_rented' });
  assert.deepEqual(manualTransition('vacant', 'sold'), { ok: false, reason: 'invalid' });
});
