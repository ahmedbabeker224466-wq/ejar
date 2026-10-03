'use strict';

// Office context for every /office route. The office always comes from the
// signed-in user's ACTIVE office_members row in the database, never from the
// URL, the body or a cookie.

const db = require('../config/db');
const { can } = require('./permissions');
const { membershipsFor, officeAccess } = require('../services/offices');
const { toLocal } = require('../utils/phone');

// Navigation of the office area, in order. Each item shows only when the
// member's role has its capability; routes/office.js guards the same pages.
const OFFICE_NAV = [
  { key: 'home', href: '/office', label: 'الرئيسية', capability: 'contracts' },
  { key: 'contracts', href: '/office/contracts', label: 'العقود', capability: 'contracts' },
  { key: 'landlords', href: '/office/landlords', label: 'الملّاك', capability: 'landlords' },
  { key: 'units', href: '/office/units', label: 'العقارات والوحدات', capability: 'units' },
  { key: 'tenants', href: '/office/tenants', label: 'المستأجرون', capability: 'tenants' },
  { key: 'payments', href: '/office/payments', label: 'الدفعات', capability: 'payments.read' },
  { key: 'maintenance', href: '/office/maintenance', label: 'الصيانة', capability: 'maintenance' },
  { key: 'listings', href: '/office/listings', label: 'الإعلانات', capability: 'listings' },
  { key: 'reports', href: '/office/reports', label: 'التقارير', capability: 'reports' },
  { key: 'messages', href: '/office/messages', label: 'الرسائل', capability: 'messages' },
  { key: 'tasks', href: '/office/tasks', label: 'مهام المكتب', capability: 'tasks' },
  { key: 'team', href: '/office/team', label: 'الفريق', capability: 'team' },
  { key: 'audit', href: '/office/audit', label: 'سجل التدقيق', capability: 'audit' },
  { key: 'settings', href: '/office/settings', label: 'الإعدادات', capability: 'settings.basic' },
  { key: 'billing', href: '/office/billing', label: 'الاشتراك', capability: 'billing' },
];

const ROLE_LABELS = {
  office_owner: 'مالك المكتب',
  office_manager: 'مدير',
  office_staff: 'موظف',
};

// Pages that stay open while the office is suspended or its trial is over.
const OPEN_WHEN_LOCKED = ['/office/billing', '/office/settings'];

function isCurrent(item, path) {
  if (item.href === '/office') return path === '/office' || path === '/office/';
  return path === item.href || path.startsWith(`${item.href}/`);
}

/** The navigation items a role may see, with the current page marked. */
function navFor(role, path) {
  return OFFICE_NAV.filter((item) => can(role, item.capability)).map((item) => ({
    ...item,
    current: isCurrent(item, path),
  }));
}

function loadOffice(pool = db.pool) {
  return async function loadOfficeMiddleware(req, res, next) {
    try {
      req.office = null;
      req.memberRole = null;
      if (!req.user) return res.redirect('/login');

      const memberships = await membershipsFor(pool, req.user.id);
      const member = memberships.find((m) => m.is_active);
      if (!member) {
        if (memberships.length > 0) {
          return res.status(403).render('errors/403', {
            title: 'غير متاح',
            heading: 'تم إيقاف حسابك في هذا المكتب',
            message: 'تواصل مع مالك المكتب لإعادة تفعيل حسابك.',
          });
        }
        if (req.user.role === null) return res.redirect('/office/new');
        return res.status(403).render('errors/403', { title: 'غير متاح' });
      }

      req.office = {
        id: Number(member.office_id),
        name: member.name,
        city: member.city,
        status: member.status,
        trial_ends_at: member.trial_ends_at,
        subscription_ends_at: member.subscription_ends_at,
        plan: member.plan_code ? { code: member.plan_code, name: member.plan_name } : null,
      };
      req.memberRole = member.role;
      req.officeAccess = officeAccess(req.office);

      const path = req.baseUrl + req.path;
      res.locals.layout = 'layouts/office';
      res.locals.office = req.office;
      res.locals.memberRole = req.memberRole;
      res.locals.roleLabel = ROLE_LABELS[req.memberRole];
      res.locals.userDisplay = req.user.name || toLocal(req.user.phone);
      res.locals.officeNav = navFor(req.memberRole, path);
      res.locals.access = req.officeAccess;
      res.locals.can = (capability) => can(req.memberRole, capability);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Suspended office or expired trial: only billing and settings stay open.
 * During the read-only grace after a paid period, every page can be read but
 * nothing can be changed (billing and settings stay writable, so the owner can pay).
 */
function officeGate(req, res, next) {
  const access = req.officeAccess;
  if (!access || (!access.locked && !access.readOnly)) return next();
  const path = req.baseUrl + req.path;
  if (OPEN_WHEN_LOCKED.some((open) => path === open || path.startsWith(`${open}/`))) return next();
  if (access.locked) return res.status(402).render('office/locked', { title: 'اشتراكك منتهي', reason: access.reason });
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return res.status(402).render('office/locked', { title: 'وضع القراءة فقط', reason: 'read_only' });
}

module.exports = { loadOffice, officeGate, navFor, OFFICE_NAV, ROLE_LABELS, OPEN_WHEN_LOCKED };
