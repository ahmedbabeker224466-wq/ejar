'use strict';

// The platform admin area (/admin). Every page needs a signed-in platform_admin
// (capability 'platform.access'); the admin login already requires 2FA, and the
// guard below refuses a session whose user still has to set it up. Every
// change writes an audit row (services/audit.js), and the actions on an office
// (extend trial, change plan, suspend, unsuspend), a credit note and a
// rejected transfer need a written reason. The area never shows landlord,
// tenant or contract content, and there is no way to act as an office user.

const express = require('express');
const db = require('../config/db');
const auth = require('../services/auth');
const admin = require('../services/admin');
const officeReview = require('../services/officeReview');
const plans = require('../services/plans');
const promos = require('../services/promos');
const invoices = require('../services/invoices');
const subscriptions = require('../services/subscriptions');
const bankTransfers = require('../services/bankTransfers');
const platformSettings = require('../services/platformSettings');
const { createNotification } = require('../services/notifications');
const images = require('../services/images');
const money = require('../services/money');
const { createAudit } = require('../services/audit');
const auditLabels = require('../services/auditLabels');
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');

const router = express.Router();
const audit = createAudit(db.pool);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

// Grouped sidebar: group heading (null = none), icon key (views/admin/_nav-icons.ejs)
// and an optional pending-count key from pendingCounts().
const NAV = [
  { key: 'dashboard', href: '/admin', label: 'لوحة المنصة', group: null },
  { key: 'offices', href: '/admin/offices', label: 'المكاتب', group: 'العمل اليومي', count: 'offices' },
  { key: 'transfers', href: '/admin/transfers', label: 'الحوالات البنكية', group: 'العمل اليومي', count: 'transfers' },
  { key: 'reports', href: '/admin/reports', label: 'بلاغات الإعلانات', group: 'العمل اليومي', count: 'reports' },
  { key: 'messages', href: '/admin/messages', label: 'رسائل التواصل', group: 'العمل اليومي', count: 'messages' },
  { key: 'domains', href: '/admin/domains', label: 'طلبات الدومين', group: 'العمل اليومي', count: 'domains' },
  { key: 'orders', href: '/admin/orders', label: 'الطلبات والمدفوعات', group: 'المال والباقات' },
  { key: 'plans', href: '/admin/plans', label: 'الباقات', group: 'المال والباقات' },
  { key: 'promos', href: '/admin/promos', label: 'أكواد الخصم', group: 'المال والباقات' },
  { key: 'blog', href: '/admin/blog', label: 'المدونة', group: 'المحتوى' },
  { key: 'settings', href: '/admin/settings', label: 'إعدادات المنصة', group: 'النظام' },
  { key: 'launch', href: '/admin/launch', label: 'جاهزية الإطلاق', group: 'النظام' },
  { key: 'ops', href: '/admin/ops', label: 'التشغيل والنسخ الاحتياطي', group: 'النظام' },
  { key: 'audit', href: '/admin/audit', label: 'سجل التدقيق', group: 'النظام' },
  { key: 'staff', href: '/admin/staff', label: 'فريق الإدارة', group: 'النظام' },
  { key: 'security', href: '/admin/security', label: 'الأمان', group: 'النظام' },
];

// Sections a platform_staff account can be given (routes/adminStaff.js). Settings,
// launch, operations, audit, security and staff management stay with the admin.
const STAFF_SECTIONS = Object.freeze({
  offices: { label: 'المكاتب', prefixes: ['/admin/offices'] },
  transfers: { label: 'الحوالات البنكية', prefixes: ['/admin/transfers'] },
  reports: { label: 'بلاغات الإعلانات', prefixes: ['/admin/reports', '/admin/listings'] },
  messages: { label: 'رسائل التواصل', prefixes: ['/admin/messages'] },
  domains: { label: 'طلبات الدومين', prefixes: ['/admin/domains'] },
  orders: { label: 'الطلبات والمدفوعات', prefixes: ['/admin/orders', '/admin/invoices'] },
  plans: { label: 'الباقات', prefixes: ['/admin/plans'] },
  promos: { label: 'أكواد الخصم', prefixes: ['/admin/promos'] },
  blog: { label: 'المدونة', prefixes: ['/admin/blog'] },
});

const underPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** The section key a staff path belongs to, or null (admin-only or unknown). */
function sectionOf(path) {
  for (const [key, section] of Object.entries(STAFF_SECTIONS)) {
    if (section.prefixes.some((prefix) => underPrefix(path, prefix))) return key;
  }
  return null;
}

/**
 * platform_staff reach only the sections the admin gave them; everything else
 * answers 403 (enforced here on the server, the sidebar only mirrors it).
 * Their home (/admin) is their first section.
 */
function staffSections(req, res, next) {
  if (req.user.role !== 'platform_staff') return next();
  const allowed = new Set(req.user.adminSections.filter((k) => Object.hasOwn(STAFF_SECTIONS, k)));
  const path = req.baseUrl + req.path;
  if ((path === '/admin' || path === '/admin/') && req.method === 'GET') {
    const first = Object.keys(STAFF_SECTIONS).find((k) => allowed.has(k));
    if (first) return res.redirect(STAFF_SECTIONS[first].prefixes[0]);
  }
  if (underPrefix(path, '/admin/notifications')) return next(); // their own notifications
  const key = sectionOf(path);
  if (key && allowed.has(key)) return next();
  return res.status(403).render('errors/403', { title: 'غير متاح', heading: 'هذا القسم غير متاح لحسابك', message: 'اطلب من مدير المنصة إضافة هذا القسم إلى صلاحياتك.' });
}

const DOMAIN_OPEN = ['pending_setup', 'pending_purchase', 'awaiting_nameservers', 'awaiting_dns'];

/** Work waiting in each queue, for the sidebar badges. Never blocks a page. */
async function pendingCounts() {
  try {
    const [[row]] = await db.pool.query(
      `SELECT
         (SELECT COUNT(*) FROM offices WHERE verification = 'pending') AS offices,
         (SELECT COUNT(*) FROM bank_transfers WHERE status = 'pending') AS transfers,
         (SELECT COUNT(*) FROM listing_reports WHERE status = 'open') AS reports,
         (SELECT COUNT(*) FROM contact_messages WHERE handled_at IS NULL) AS messages,
         (SELECT COUNT(*) FROM office_domain_requests WHERE status IN (?, ?, ?, ?)) AS domains`,
      DOMAIN_OPEN,
    );
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]));
  } catch {
    return {};
  }
}

/** The sidebar as groups: [{ title, items: [...] }]. */
function navGroups(path, counts) {
  const groups = [];
  for (const item of NAV) {
    const entry = { ...item, current: isCurrent(item, path), pending: item.count ? counts[item.count] || 0 : 0 };
    const last = groups[groups.length - 1];
    if (last && last.title === item.group) last.items.push(entry);
    else groups.push({ title: item.group, items: [entry] });
  }
  return groups;
}

/** The sidebar of a platform_staff account: only its sections. */
function staffNavGroups(path, counts, sections) {
  const allowed = new Set(sections);
  return navGroups(path, counts)
    .map((g) => ({ ...g, items: g.items.filter((i) => allowed.has(i.key)) }))
    .filter((g) => g.items.length);
}

function isCurrent(item, path) {
  if (item.href === '/admin') return path === '/admin' || path === '/admin/';
  return path === item.href || path.startsWith(`${item.href}/`);
}

/** A platform admin session whose user still has to set up 2FA is refused (defence in depth: login never issues one). */
function twoFactorGuard(req, res, next) {
  const user = { role: req.user.role, twofa_enabled: req.user.twofaEnabled };
  if (auth.needsTwoFactor(user) && !req.user.twofaEnabled) {
    return res.status(403).render('errors/403', { title: 'غير متاح', heading: 'فعّل المصادقة الثنائية أولاً', message: 'منطقة إدارة المنصة تتطلب المصادقة الثنائية.' });
  }
  return next();
}

// A GET from someone who is not signed in as the platform (signed out, or
// signed in as an office in this browser) goes to the admin sign-in page.
const PLATFORM_ROLES = new Set(['platform_admin', 'platform_staff']);
router.use('/admin', noStore, sameOrigin, (req, res, next) => (req.method !== 'GET' || (req.user && PLATFORM_ROLES.has(req.user.role)) ? next() : res.redirect('/admin/login')), requireAuth, requirePerm('platform.access'), twoFactorGuard, staffSections, async (req, res, next) => {
  res.locals.layout = 'layouts/admin';
  res.locals.adminNav = NAV.map((item) => ({ ...item, current: isCurrent(item, req.baseUrl + req.path) }));
  const counts = req.method === 'GET' ? await pendingCounts() : {};
  res.locals.adminNavGroups = req.user.role === 'platform_staff'
    ? staffNavGroups(req.baseUrl + req.path, counts, req.user.adminSections)
    : navGroups(req.baseUrl + req.path, counts);
  // The header never shows a phone number (screen sharing).
  res.locals.userDisplay = req.user.role === 'platform_staff' ? (req.user.name || 'موظف المنصة') : 'مدير المنصة';
  res.locals.fmt = money.formatHalalas;
  res.locals.fmtDec = (value) => money.formatHalalas(money.fromDecimal(value));
  res.locals.stamp = (at) => (at ? riyadhDate(new Date(at)) : '—');
  res.locals.done = null;
  res.locals.auditLabel = auditLabels.labelFor;
  next();
});

// /platform is where a platform admin lands after login.
// The admin's landing path. The admin session cookie is sent to /admin only, so
// this is a plain redirect; the /admin guard decides who gets in.
router.get('/platform', noStore, (req, res) => res.redirect('/admin'));

const DONE = {
  trial: 'تم تمديد التجربة.',
  plan: 'تم تغيير الباقة.',
  suspend: 'تم إيقاف المكتب.',
  unsuspend: 'تمت إعادة تشغيل المكتب.',
  note: 'تمت إضافة الملاحظة.',
  credit: 'تم إصدار الإشعار الدائن. أعد المبلغ للعميل من لوحة مزوّد الدفع أو البنك.',
  approved: 'تم قبول الحوالة وتفعيل الباقة.',
  rejected: 'تم رفض الحوالة.',
  saved: 'تم الحفظ.',
  created: 'تمت الإضافة.',
  deleted: 'تم الحذف.',
  dismissed: 'تم إغلاق البلاغ دون إجراء.',
  hidden: 'تم إخفاء الإعلان.',
  unhidden: 'أُلغي إخفاء الإدارة؛ على المكتب نشر الإعلان من جديد.',
  banned: 'تم إيقاف نشر الإعلانات لهذا المكتب وإخفاء إعلاناته.',
  unbanned: 'أُعيد حق نشر الإعلانات للمكتب.',
  handled: 'تم تعليم الرسالة كمعالجة.',
  replied: 'أُرسل الرد بالبريد وعُلّمت الرسالة كمعالجة.',
  staff_created: 'أُضيف الموظف. أرسل له البريد وكلمة المرور بطريقة آمنة.',
  staff_updated: 'حُفظت بيانات الموظف.',
  staff_activated: 'أُعيد تفعيل الموظف.',
  staff_deactivated: 'أُوقف الموظف وخرج من كل أجهزته.',
  analytics: 'تم حفظ شيفرة التحليلات.',
  launch_confirmed: 'تم تسجيل التأكيد.',
  smtp_ok: 'نجحت رسالة التجربة.',
  smtp_failed: 'فشلت رسالة التجربة. راجع إعدادات SMTP.',
  backup_ok: 'اكتمل النسخ الاحتياطي.',
  backup_failed: 'فشل النسخ الاحتياطي. راجع رمز الخطأ في الجدول.',
  backup_locked: 'نسخة احتياطية أخرى تعمل الآن. حاول بعد قليل.',
  domain_saved: 'تم حفظ طلب الدومين.',
  verified: 'تمت الموافقة على المكتب، وبدأت تجربته المجانية، وأُبلغ صاحبه.',
  office_rejected: 'تم رفض الطلب، وأُبلغ صاحب المكتب بالسبب.',
};
const doneText = (key) => (Object.hasOwn(DONE, key) ? DONE[key] : null);

/** A written reason of 3 to 200 characters, or null. */
function reasonOf(body) {
  const text = String((body && body.reason) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 3 && text.length <= 200 ? text : null;
}
const REASON_ERROR = 'اكتب سبباً للإجراء (من 3 إلى 200 حرف).';

// ------------------------------------------------------------ dashboard

router.get('/admin', wrap(async (req, res) => {
  const data = await admin.overview(db.pool);
  return res.render('admin/dashboard', { title: 'لوحة المنصة', data });
}));

require('./adminOffices')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });
require('./adminBilling')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });
require('./adminSystem')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });
require('./adminContent')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });
require('./adminLaunch')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText });
require('./adminSecurity')(router, { wrap, audit });
require('./adminDomains')(router, { wrap, notFound, reasonOf, REASON_ERROR, doneText });
require('./adminStaff')(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText, STAFF_SECTIONS });
require('./adminOps')(router, { wrap, reasonOf, REASON_ERROR, audit, doneText });
// The admin's own notifications (the admin session cookie is sent to /admin only).
require('./notifications').mountCenter(router, '/admin', (req, res, next) => next());

module.exports = router;
module.exports.STAFF_SECTIONS = STAFF_SECTIONS;
module.exports.sectionOf = sectionOf;
