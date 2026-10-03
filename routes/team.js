'use strict';

// /office/team: members, staff invites by phone, role changes and
// deactivation. Capability 'team' (owner and managers); who may change whom is
// decided in services/team.js canManage (a manager manages staff only).
// Mounted inside routes/office.js, so req.office comes from loadOffice.

const express = require('express');
const db = require('../config/db');
const team = require('../services/team');
const invites = require('../services/invites');
const { parseId } = require('../services/landlords');
const { toLocal } = require('../utils/phone');
const { requirePerm } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');
const { scopeToOffice } = require('../services/scopeToOffice');

const router = express.Router();
const guard = requirePerm('team');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const DONE = {
  invited: 'تم إنشاء رمز الدعوة. أرسله للشخص ليدخل به من صفحة "الانضمام برمز".',
  revoked: 'تم إلغاء الدعوة.',
  role: 'تم تغيير الدور.',
  deactivated: 'تم إيقاف العضو وإنهاء جلساته.',
  activated: 'تمت إعادة تفعيل العضو.',
};
const ERRORS = {
  invalid_phone: 'اكتب رقم جوال سعودي صحيح يبدأ بـ 05.',
  invalid_role: 'اختر الدور: مدير أو موظف.',
  forbidden: 'ليس لديك صلاحية لهذا الإجراء.',
  already_member: 'هذا الرقم عضو في مكتبك بالفعل. فعّله من القائمة إن كان موقوفاً.',
  phone_used: 'هذا الرقم مسجل بحساب آخر في عقدي ولا يمكن إضافته للفريق. استخدم رقماً آخر.',
  not_found: 'العضو غير موجود.',
};

const inviteLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (req) => `staff-invite:${req.office.id}`,
  onLimit: (req, res) => render(req, res, { status: 429, error: 'أنشأت دعوات كثيرة. حاول بعد قليل.' }),
});

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

async function render(req, res, { status = 200, error = null, values = {} } = {}) {
  const actor = { id: req.user.id, role: req.memberRole };
  const overview = await team.overview(db.pool, req.office.id, actor);
  return res.status(status).render('team/index', {
    title: 'الفريق',
    ...overview,
    assignable: req.memberRole === 'office_owner' ? team.ASSIGNABLE : ['office_staff'],
    roleLabels: team.ROLE_LABELS,
    canChangeRoles: req.memberRole === 'office_owner',
    pending: overview.pending.map((i) => ({
      ...i,
      shareLink: invites.inviteShareLink({ code: i.code, officeName: req.office.name, baseUrl: baseUrl(req), phone: i.phone, kind: 'staff' }),
      phoneLocal: toLocal(i.phone),
    })),
    values: { phone: '', role: 'office_staff', ...values },
    error,
    message: DONE[req.query.done] || null,
  });
}

router.get('/office/team', guard, wrap((req, res) => render(req, res)));

router.post('/office/team/invite', guard, inviteLimit, wrap(async (req, res) => {
  const role = String(req.body.role || '');
  const result = await team.inviteStaff(db.pool, req.office.id, {
    actor: { id: req.user.id, role: req.memberRole }, phone: req.body.phone, role, ip: req.ip,
  });
  if (!result.ok) {
    return render(req, res, { status: result.error === 'limit' ? 409 : 422, error: result.message || ERRORS[result.error], values: { phone: String(req.body.phone || '').slice(0, 20), role } });
  }
  return res.redirect('/office/team?done=invited#invites');
}));

router.post('/office/team/invites/:id/revoke', guard, wrap(async (req, res) => {
  const inviteId = parseId(req.params.id);
  if (!inviteId) return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
  await invites.revokeStaffInvite(scopeToOffice(db.pool, req.office.id), { inviteId, actorId: req.user.id, ip: req.ip });
  return res.redirect('/office/team?done=revoked#invites');
}));

async function act(req, res, action, doneKey) {
  const memberId = parseId(req.params.memberId);
  if (!memberId) return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
  const result = await action(memberId);
  if (result.error === 'not_found') return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
  if (!result.ok) return render(req, res, { status: result.error === 'limit' ? 409 : 403, error: result.message || ERRORS[result.error] || ERRORS.forbidden });
  return res.redirect(`/office/team?done=${doneKey}`);
}

const actor = (req) => ({ id: req.user.id, role: req.memberRole });

router.post('/office/team/:memberId/role', guard, wrap((req, res) => act(req, res,
  (memberId) => team.changeRole(db.pool, req.office.id, { actor: actor(req), memberId, role: String(req.body.role || ''), ip: req.ip }), 'role')));

router.post('/office/team/:memberId/deactivate', guard, wrap((req, res) => act(req, res,
  (memberId) => team.deactivate(db.pool, req.office.id, { actor: actor(req), memberId, ip: req.ip }), 'deactivated')));

router.post('/office/team/:memberId/activate', guard, wrap((req, res) => act(req, res,
  (memberId) => team.activate(db.pool, req.office.id, { actor: actor(req), memberId, ip: req.ip }), 'activated')));

module.exports = router;
