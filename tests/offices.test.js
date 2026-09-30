'use strict';

// Pure parts of the office area: status rules, form validation, navigation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { officeAccess, validateOfficeFields, normalizeOfficePhone, SAUDI_CITIES } = require('../services/offices');
const { navFor, OFFICE_NAV } = require('../middleware/loadOffice');

const NOW = new Date('2026-09-30T10:00:00Z');
const future = new Date('2026-10-05T10:00:00Z');
const past = new Date('2026-09-29T10:00:00Z');

test('trial and active offices have full access; trial shows days left', () => {
  const trial = officeAccess({ status: 'trial', trial_ends_at: future }, NOW);
  assert.equal(trial.locked, false);
  assert.equal(trial.onTrial, true);
  assert.equal(trial.trialDaysLeft, 5);
  assert.deepEqual(officeAccess({ status: 'active' }, NOW), {
    locked: false, reason: null, pastDue: false, onTrial: false, trialDaysLeft: null,
  });
});

test('past_due keeps access and raises the red banner', () => {
  const access = officeAccess({ status: 'past_due' }, NOW);
  assert.equal(access.locked, false);
  assert.equal(access.pastDue, true);
});

test('suspended, expired trial and unknown status are locked', () => {
  assert.equal(officeAccess({ status: 'suspended' }, NOW).reason, 'suspended');
  assert.equal(officeAccess({ status: 'trial', trial_ends_at: past }, NOW).reason, 'trial_expired');
  assert.equal(officeAccess({ status: 'trial', trial_ends_at: null }, NOW).locked, true);
  assert.equal(officeAccess({ status: 'whatever' }, NOW).locked, true);
});

test('Riyadh is the first city', () => {
  assert.equal(SAUDI_CITIES[0], 'الرياض');
});

test('a complete office form is accepted and normalised', () => {
  const { values, errors } = validateOfficeFields({
    name: '  مكتب   الأمانة  ',
    city: 'جدة',
    phone: '٠٥٠١٢٣٤٥٦٧',
    email: ' Info@Example.SA ',
    cr_number: '1010123456',
    rega_license: '1200001234',
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(values, {
    name: 'مكتب الأمانة',
    city: 'جدة',
    phone: '966501234567',
    email: 'info@example.sa',
    cr_number: '1010123456',
    rega_license: '1200001234',
  });
});

test('optional fields may be empty; required ones may not', () => {
  const ok = validateOfficeFields({ name: 'مكتب', city: 'الرياض', phone: '0112345678' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.email, null);
  assert.equal(ok.values.phone, '966112345678', 'landline accepted');

  const bad = validateOfficeFields({ name: 'م', city: 'Paris', phone: '123', email: 'x@', cr_number: '12', rega_license: 'abc' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['city', 'cr_number', 'email', 'name', 'phone', 'rega_license']);
  assert.deepEqual(Object.keys(validateOfficeFields().errors).sort(), ['city', 'name', 'phone']);
});

test('office phone accepts Saudi mobiles and landlines only', () => {
  assert.equal(normalizeOfficePhone('+966 11 234 5678'), '966112345678');
  assert.equal(normalizeOfficePhone('0512345678'), '966512345678');
  assert.equal(normalizeOfficePhone('0182345678'), null);
  assert.equal(normalizeOfficePhone('+1 212 555 0100'), null);
});

const ALL = OFFICE_NAV.map((i) => i.key);
const NAV = {
  office_owner: ALL,
  office_manager: ALL.filter((k) => !['team', 'billing'].includes(k)),
  office_staff: ['home', 'contracts', 'landlords', 'units', 'tenants', 'payments', 'maintenance', 'messages', 'settings'],
};

test('the navigation has the 14 items in order', () => {
  assert.deepEqual(ALL, [
    'home', 'contracts', 'landlords', 'units', 'tenants', 'payments', 'maintenance',
    'listings', 'reports', 'messages', 'team', 'audit', 'settings', 'billing',
  ]);
});

for (const [role, keys] of Object.entries(NAV)) {
  test(`${role} sees only the permitted navigation items`, () => {
    assert.deepEqual(navFor(role, '/office').map((i) => i.key), keys);
  });
}

test('an unknown role gets no office navigation', () => {
  assert.deepEqual(navFor(null, '/office'), []);
  assert.deepEqual(navFor('hacker', '/office'), []);
});

test('only the current page is highlighted', () => {
  const current = (path) => navFor('office_owner', path).filter((i) => i.current).map((i) => i.key);
  assert.deepEqual(current('/office'), ['home']);
  assert.deepEqual(current('/office/contracts'), ['contracts']);
  assert.deepEqual(current('/office/contracts/12'), ['contracts']);
  assert.deepEqual(current('/office/settingsx'), []);
});
