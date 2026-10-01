'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, can, requirePerm } = require('../middleware/permissions');

const EXPECTED = {
  office_owner: [
    'contracts', 'contracts.ai', 'contracts.terminate', 'contracts.delete', 'landlords', 'units', 'tenants', 'payments.read',
    'payments.write', 'maintenance', 'listings', 'reports', 'messages', 'team', 'audit',
    'settings.basic', 'settings.office', 'settings.secure', 'billing', 'office.delete',
  ],
  office_manager: [
    'contracts', 'contracts.ai', 'contracts.terminate', 'contracts.delete', 'landlords', 'units', 'tenants', 'payments.read',
    'payments.write', 'maintenance', 'listings', 'reports', 'messages', 'audit',
    'settings.basic', 'settings.office',
  ],
  office_staff: [
    'contracts', 'contracts.ai', 'landlords', 'units', 'tenants', 'payments.read', 'payments.write', 'maintenance', 'messages',
    'settings.basic',
  ],
  landlord: [
    'own.units', 'own.contracts', 'own.payments', 'own.maintenance', 'own.reports', 'messages',
    'settings.basic',
  ],
  tenant: ['own.contract', 'own.payments', 'own.maintenance', 'messages', 'settings.basic'],
};

for (const [role, caps] of Object.entries(EXPECTED)) {
  test(`${role} has exactly the specified capabilities`, () => {
    assert.deepEqual([...CAPABILITIES[role]].sort(), [...caps].sort());
  });
}

test('platform_admin has every capability plus platform-only ones', () => {
  for (const caps of Object.values(EXPECTED)) {
    for (const cap of caps) assert.ok(can('platform_admin', cap), cap);
  }
  assert.ok(can('platform_admin', 'platform.access'));
  for (const role of Object.keys(EXPECTED)) assert.equal(can(role, 'platform.access'), false, role);
});

test('unknown roles have no capabilities', () => {
  assert.equal(can(undefined, 'contracts'), false);
  assert.equal(can('hacker', 'contracts'), false);
});

test('requirePerm refuses unknown capability names at startup', () => {
  assert.throws(() => requirePerm('contracts.typo'), /Unknown capability/);
});

function run(middleware, { user, json = false } = {}) {
  const req = { user, path: json ? '/api/x' : '/x', xhr: false, get: () => '' };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    render(view) {
      this.view = view;
      return this;
    },
    redirect(to) {
      this.redirectedTo = to;
      return this;
    },
  };
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('requirePerm allows and denies per role', () => {
  const guard = requirePerm('billing');
  assert.equal(run(guard, { user: { role: 'office_owner' } }).passed, true);
  assert.equal(run(guard, { user: { role: 'platform_admin' } }).passed, true);
  for (const role of ['office_manager', 'office_staff', 'landlord', 'tenant']) {
    const { passed, res } = run(guard, { user: { role } });
    assert.equal(passed, false, role);
    assert.equal(res.statusCode, 403, role);
    assert.equal(res.view, 'errors/403', role);
  }
});

test('requirePerm returns 403 JSON for API requests', () => {
  const { passed, res } = run(requirePerm('contracts'), { user: { role: 'tenant' }, json: true });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'هذا القسم غير متاح لنوع حسابك');
});

test('requirePerm sends signed-out visitors to /login, or 401 for APIs', () => {
  assert.equal(run(requirePerm('contracts')).res.redirectedTo, '/login');
  assert.equal(run(requirePerm('contracts'), { json: true }).res.statusCode, 401);
});

test('own.* capabilities are granted by role but still need an ownership check', () => {
  assert.ok(can('tenant', 'own.contract'));
  assert.equal(can('tenant', 'contracts'), false, 'tenants never get office-wide contract access');
  assert.equal(can('landlord', 'contracts'), false);
});
