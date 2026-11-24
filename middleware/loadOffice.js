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
  { key: 'home', href: '/office', label: 'الرئيسية', capability: 'contracts', group: '' },
  { key: 'billing', href: '/office/billing', label: 'الاشتراك', capability: 'billing', group: '' },
  { key: 'contracts', href: '/office/contracts', label: 'العقود', capability: 'contracts', group: 'العقود والعقارات' },
  { key: 'landlords', href: '/office/landlords', label: 'الملّاك', capability: 'landlords', group: 'العقود والعقارات' },
  { key: 'units', href: '/office/units', label: 'العقارات والوحدات', capability: 'units', group: 'العقود والعقارات' },
  { key: 'tenants', href: '/office/tenants', label: 'المستأجرون', capability: 'tenants', group: 'العقود والعقارات' },
  { key: 'payments', href: '/office/payments', label: 'الدفعات', capability: 'payments.read', group: 'المال' },
  { key: 'accounting', href: '/office/accounting', label: 'المحاسبة', capability: 'accounting', group: 'المال' },
  { key: 'maintenance', href: '/office/maintenance', label: 'الصيانة', capability: 'maintenance', group: 'العمل اليومي' },
  { key: 'tasks', href: '/office/tasks', label: 'مهام المكتب', capability: 'tasks', group: 'العمل اليومي' },
  { key: 'messages', href: '/office/messages', label: 'الرسائل', capability: 'messages', group: 'العمل اليومي' },
  { key: 'leads', href: '/office/leads', label: 'العملاء المحتملون', capability: 'leads', group: 'التسويق' },
  { key: 'listings', href: '/office/listings', label: 'الإعلانات', capability: 'listings', group: 'التسويق' },
  { key: 'domain', href: '/office/domain', label: 'ربط الدومين', capability: 'settings.basic', group: 'التسويق' },
  { key: 'reports', href: '/office/reports', label: 'التقارير', capability: 'reports', group: 'المكتب' },
  { key: 'team', href: '/office/team', label: 'الفريق', capability: 'team', group: 'المكتب' },
  { key: 'audit', href: '/office/audit', label: 'سجل التدقيق', capability: 'audit', group: 'المكتب' },
  { key: 'settings', href: '/office/settings', label: 'الإعدادات', capability: 'settings.basic', group: 'المكتب' },
];

const ROLE_LABELS = {
  office_owner: 'مالك المكتب',
  office_manager: 'مدير',
  office_staff: 'موظف',
};

// Pages that stay open while the office is suspended or its trial is over.
const OPEN_WHEN_LOCKED = ['/office/billing', '/office/settings', '/office/domain'];

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

async function planLocks(pool, officeId) {
  const { planJoin } = require('../services/defaultPlan');
  const [[row]] = await pool.query(`SELECT p.custom_domain AS mode FROM offices o ${planJoin()} WHERE o.id = ?`, [officeId]);
  return !row || !['addon', 'included'].includes(row.mode) ? ['domain'] : [];
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
        verification: member.verification || 'approved',
        verification_note: member.verification_note || null,
        plan: member.plan_code ? { code: member.plan_code, name: member.plan_name } : null,
      };
      req.memberRole = member.role;
      req.officeAccess = officeAccess(req.office);

      const path = req.baseUrl + req.path;
      res.locals.layout = 'layouts/office';
      res.locals.office = req.office;
      res.locals.memberRole = req.memberRole;
      res.locals.roleLabel = ROLE_LABELS[req.memberRole];
      res.locals.userDisplay = req.user.name || toLocal(req.user.phone) || req.user.email || '';
      res.locals.officeNav = navFor(req.memberRole, path);
      // Items the plan does not include show a lock (the page itself explains and offers the upgrade).
      res.locals.navLocks = await planLocks(pool, req.office.id);
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
async function officeGate(req, res, next) {
  try {
    return await gate(req, res, next);
  } catch (err) {
    return next(err);
  }
}

async function gate(req, res, next) {
  const access = req.officeAccess;
  if (!access || (!access.locked && !access.readOnly)) return next();
  // Waiting for the licence check (or refused): no office page opens at all,
  // except the owner's form that corrects the details and resubmits them.
  if (access.reason === 'pending_review' || access.reason === 'rejected') {
    if (req.baseUrl + req.path === '/office/review/edit' && req.memberRole === 'office_owner') return next();
    res.locals.officeNav = [];
    res.locals.bareShell = true;
    return res.status(403).render('office/review', {
      title: access.reason === 'rejected' ? 'لم تتم الموافقة على المكتب' : 'طلبك قيد المراجعة',
      reason: access.reason,
      note: req.office.verification_note,
      canEdit: req.memberRole === 'office_owner',
      resubmitted: req.query.done === 'resubmitted',
    });
  }
  const path = req.baseUrl + req.path;
  if (OPEN_WHEN_LOCKED.some((open) => path === open || path.startsWith(`${open}/`))) return next();
  if (access.locked) {
    // A suspension by the platform admin is not lifted by paying: say so plainly.
    if (access.reason === 'suspended' && await require('../services/subscriptions').isAdminSuspended(require('../config/db').pool, req.office.id)) {
      return res.status(402).render('office/locked', { title: 'الحساب موقوف', reason: 'admin_suspended' });
    }
    return res.status(402).render('office/locked', { title: 'اشتراكك منتهي', reason: access.reason });
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return res.status(402).render('office/locked', { title: 'وضع القراءة فقط', reason: 'read_only' });
}

module.exports = { loadOffice, officeGate, navFor, OFFICE_NAV, ROLE_LABELS, OPEN_WHEN_LOCKED };
