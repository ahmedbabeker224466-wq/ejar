'use strict';

// Capability map for the six roles. Routes ask for a capability, never a role:
// requirePerm('contracts'). Capabilities starting with "own." also need a
// row-ownership check in the controller; the role alone is never enough.

const { wantsJson } = require('./auth');

const OFFICE_OWNER = [
  'contracts',
  'contracts.delete',
  'landlords',
  'units',
  'tenants',
  'payments.read',
  'payments.write',
  'maintenance',
  'listings',
  'reports',
  'messages',
  'team',
  'audit',
  'settings.basic',
  'settings.office',
  'settings.secure',
  'billing',
  'office.delete',
];

const OWNER_ONLY = ['team', 'settings.secure', 'billing', 'office.delete'];

const LANDLORD = [
  'own.units',
  'own.contracts',
  'own.payments',
  'own.maintenance',
  'own.reports',
  'messages',
  'settings.basic',
];

const TENANT = ['own.contract', 'own.payments', 'own.maintenance', 'messages', 'settings.basic'];

const PLATFORM_ONLY = [
  'platform.access',
  'platform.offices',
  'platform.users',
  'platform.billing',
  'platform.content',
  'platform.settings',
  'platform.support',
];

const CAPABILITIES = {
  platform_admin: [...new Set([...OFFICE_OWNER, ...LANDLORD, ...TENANT, ...PLATFORM_ONLY])],
  office_owner: OFFICE_OWNER,
  office_manager: OFFICE_OWNER.filter((c) => !OWNER_ONLY.includes(c)),
  office_staff: [
    'contracts',
    'landlords',
    'units',
    'tenants',
    'payments.read',
    'maintenance',
    'messages',
    'settings.basic',
  ],
  landlord: LANDLORD,
  tenant: TENANT,
};

const ROLE_SETS = Object.fromEntries(
  Object.entries(CAPABILITIES).map(([role, caps]) => [role, new Set(caps)]),
);

function can(role, capability) {
  return Boolean(ROLE_SETS[role] && ROLE_SETS[role].has(capability));
}

/**
 * The role that counts for this request. Inside /office, loadOffice sets
 * req.memberRole from the user's office_members row, and that role wins.
 */
function effectiveRole(req) {
  return req.memberRole || (req.user && req.user.role);
}

/**
 * Route guard: signed-in users whose role has the capability pass. Others get
 * 401/redirect (signed out) or 403 JSON / an Arabic page (signed in).
 */
function requirePerm(capability) {
  const known = Object.values(ROLE_SETS).some((set) => set.has(capability));
  if (!known) throw new Error(`Unknown capability: ${capability}`);

  return function requirePermMiddleware(req, res, next) {
    if (!req.user) {
      if (wantsJson(req)) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
      return res.redirect('/login');
    }
    if (can(effectiveRole(req), capability)) return next();
    if (wantsJson(req)) {
      return res.status(403).json({ error: 'هذا القسم غير متاح لنوع حسابك' });
    }
    return res.status(403).render('errors/403', { title: 'غير متاح' });
  };
}

module.exports = { CAPABILITIES, can, requirePerm, effectiveRole };
