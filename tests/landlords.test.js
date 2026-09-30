'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLandlordFields, parseId } = require('../services/landlords');

test('a landlord needs only a label; phone is normalised', () => {
  const minimal = validateLandlordFields({ label: '  أبو   فهد ' });
  assert.deepEqual(minimal.errors, {});
  assert.deepEqual(minimal.values, { label: 'أبو فهد', city: null, phone: null, notes: null });

  const full = validateLandlordFields({ label: 'أبو فهد', city: 'جدة', phone: '+966 50 123 4567', notes: 'يفضّل التواصل مساءً' });
  assert.deepEqual(full.errors, {});
  assert.equal(full.values.phone, '966501234567');
  assert.equal(validateLandlordFields({ label: 'أبو فهد', phone: '٥٠١٢٣٤٥٦٧' }).values.phone, '966501234567');
});

test('landlord validation errors', () => {
  const bad = validateLandlordFields({ label: 'x', city: 'Paris', phone: '0112345678', notes: 'ن'.repeat(1001) });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['city', 'label', 'notes', 'phone']);
  assert.ok(bad.errors.phone, 'landlines are not mobiles');
  assert.deepEqual(validateLandlordFields({ label: 'ab', notes: 'ن'.repeat(1000) }).errors, {});
  assert.deepEqual(Object.keys(validateLandlordFields().errors), ['label']);
});

test('the landlord form has no field for ID, iqama, IBAN or address', () => {
  const { values } = validateLandlordFields({
    label: 'أبو فهد', national_id: '1012345678', iqama: '2012345678', iban: 'SA0380000000608010167519', address: 'حي النرجس',
  });
  assert.deepEqual(Object.keys(values).sort(), ['city', 'label', 'notes', 'phone']);
});

test('route ids are positive integers only', () => {
  assert.equal(parseId('42'), 42);
  for (const bad of ['0', '-1', '1e3', '4.2', 'abc', '', '12abc', '999999999999999999999']) assert.equal(parseId(bad), null, bad);
});
