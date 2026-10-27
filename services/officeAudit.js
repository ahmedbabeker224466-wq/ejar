'use strict';

// The office's own audit log (/office/audit), read only. Shows who (nickname
// or masked phone, and role), the action, the target (type and number) and
// the time. Never the before/after values: they may hold reasons or notes.
// Platform-admin actions on the office (admin.*) are internal to the platform
// and left out. audit_logs is not an office table (office_id is nullable), but
// the query still goes through scopeToOffice() and filters by :office_id.

const { scopeToOffice } = require('./scopeToOffice');
const { maskPhone } = require('../utils/phone');

const PAGE_SIZE = 30;

const ROLE_LABELS = {
  office_owner: 'مالك المكتب',
  office_manager: 'مدير',
  office_staff: 'موظف',
  landlord: 'مالك عقار',
  tenant: 'مستأجر',
  platform_admin: 'إدارة المنصة',
};

const ACTION_LABELS = {
  'office.create': 'إنشاء المكتب',
  'office.update': 'تعديل بيانات المكتب',
  'office.plan_backfill': 'تحديد الباقة الافتراضية تلقائياً',
  'office.public_slug': 'تغيير رابط المكتب',
  'office.public_page': 'إعدادات صفحة المكتب العامة',
  'landlord.create': 'إضافة مالك',
  'landlord.update': 'تعديل مالك',
  'landlord.activate': 'إعادة تفعيل مالك',
  'landlord.deactivate': 'إيقاف مالك',
  'landlord.delete': 'حذف مالك',
  'building.create': 'إضافة عقار',
  'building.update': 'تعديل عقار',
  'building.delete': 'حذف عقار',
  'unit.create': 'إضافة وحدة',
  'unit.bulk_create': 'إضافة عدة وحدات',
  'unit.update': 'تعديل وحدة',
  'unit.status': 'تغيير حالة وحدة',
  'unit.delete': 'حذف وحدة',
  'contract.create': 'إضافة عقد',
  'contract.update': 'تعديل عقد',
  'contract.renew': 'تجديد عقد',
  'contract.terminate': 'إنهاء عقد',
  'contract.delete': 'حذف عقد',
  'contract.decision': 'قرار المالك على العقد',
  'contract.request': 'طلب من المستأجر',
  'contract.request_handled': 'الرد على طلب المستأجر',
  'invite.create': 'إنشاء رمز دعوة',
  'invite.revoke': 'إلغاء رمز دعوة',
  'invite.use': 'استخدام رمز دعوة',
  'payment.record': 'تسجيل دفعة',
  'payment.undo': 'التراجع عن دفعة',
  'payment.status': 'تغيير حالة دفعة',
  'payment.reported': 'المستأجر أبلغ بالدفع',
  'payment.confirmed': 'تأكيد دفعة',
  'payment.rejected': 'رفض بلاغ دفعة',
  'maintenance.create': 'طلب صيانة جديد',
  'maintenance.status': 'تغيير حالة طلب صيانة',
  'maintenance.assign': 'تعيين مسؤول صيانة',
  'maintenance.message': 'رد على طلب صيانة',
  'listing.create': 'إنشاء إعلان',
  'listing.update': 'تعديل إعلان',
  'listing.publish': 'نشر إعلان',
  'listing.hide': 'إخفاء إعلان',
  'listing.renew': 'تمديد إعلان',
  'listing.expire': 'انتهاء إعلان',
  'listing.delete': 'حذف إعلان',
  'listing.photos_add': 'إضافة صور لإعلان',
  'listing.photo_delete': 'حذف صورة إعلان',
  'team.invite': 'دعوة عضو',
  'team.role': 'تغيير دور عضو',
  'team.activate': 'إعادة تفعيل عضو',
  'team.deactivate': 'إيقاف عضو',
  'task.create': 'إضافة مهمة',
  'task.update': 'تعديل مهمة',
  'task.move': 'تغيير حالة مهمة',
  'task.comment': 'تعليق على مهمة',
  'conversation.mute': 'كتم محادثة',
  'conversation.unmute': 'إلغاء كتم محادثة',
  'message.delete': 'حذف رسالة',
  'channel.saved': 'ضبط قناة تذكير',
  'channel.removed': 'إزالة قناة تذكير',
  'reminders.rules': 'تعديل مواعيد التذكير',
  'billing.paid': 'دفع الاشتراك',
  'billing.suspicious': 'دفعة اشتراك تحت المراجعة',
  'billing.transfer_submit': 'إرسال تحويل بنكي',
  'billing.transfer_approve': 'قبول تحويل بنكي',
  'billing.transfer_reject': 'رفض تحويل بنكي',
  'subscription.past_due': 'الاشتراك غير مسدَّد',
  'subscription.suspend': 'إيقاف الاشتراك',
};

const ENTITY_LABELS = {
  office: 'المكتب',
  landlord: 'مالك',
  building: 'عقار',
  unit: 'وحدة',
  contract: 'عقد',
  contract_payment: 'دفعة',
  invite: 'رمز دعوة',
  maintenance_request: 'طلب صيانة',
  listing: 'إعلان',
  office_member: 'عضو',
  task: 'مهمة',
  office_task: 'مهمة',
  conversation: 'محادثة',
  message: 'رسالة',
  order: 'طلب اشتراك',
  bank_transfer: 'تحويل بنكي',
  subscription: 'اشتراك',
  channel: 'قناة تذكير',
};

// Targets with a page inside the office area (which itself answers 404 for other offices' ids).
const ENTITY_LINKS = {
  contract: (id) => `/office/contracts/${id}`,
  landlord: (id) => `/office/landlords/${id}`,
  unit: (id) => `/office/units/${id}`,
  maintenance_request: (id) => `/office/maintenance/${id}`,
  listing: (id) => `/office/listings/${id}`,
};

function actionLabel(action) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const entity = ENTITY_LABELS[String(action).split('.')[0]];
  return entity ? `إجراء على ${entity}` : 'إجراء آخر';
}

function actorView(row) {
  if (!row.actor_id) return { name: 'النظام', role: null };
  if (row.user_role === 'platform_admin') return { name: ROLE_LABELS.platform_admin, role: null };
  const role = row.member_role || row.user_role;
  return {
    name: row.actor_name || (row.actor_phone ? maskPhone(row.actor_phone) : 'مستخدم'),
    role: ROLE_LABELS[role] || null,
  };
}

/** One page of this office's audit rows, newest first: { rows, total, page, pages }. */
async function listOfficeAudit(pool, officeId, { page = 1 } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const where = "a.office_id = :office_id AND a.action NOT LIKE 'admin.%'";
  const [{ n }] = await scoped.query(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${where}`);
  const total = Number(n);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
  const rows = await scoped.query(
    `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.created_at,
            u.name AS actor_name, u.phone AS actor_phone, u.role AS user_role, m.role AS member_role
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN office_members m ON m.user_id = a.actor_id AND m.office_id = :office_id
      WHERE ${where}
      ORDER BY a.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`,
  );
  return {
    rows: rows.map((r) => {
      const entityId = r.entity_id === null ? null : Number(r.entity_id);
      const link = ENTITY_LINKS[r.entity_type];
      return {
        id: Number(r.id),
        actor: actorView(r),
        action: r.action,
        actionLabel: actionLabel(r.action),
        target: ENTITY_LABELS[r.entity_type] || 'عنصر',
        targetId: entityId,
        targetHref: link && entityId ? link(entityId) : null,
        createdAt: r.created_at,
      };
    }),
    total,
    page: current,
    pages,
  };
}

module.exports = { listOfficeAudit, actionLabel, PAGE_SIZE, ACTION_LABELS, ENTITY_LABELS };
