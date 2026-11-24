'use strict';

// /admin/staff: the platform admin manages limited admin accounts (platform_staff):
// name, email, password and the admin sections each one may open. Staff can
// never reach this page (it is not a staff section). Every change needs a
// written reason and writes an audit row (admin.staff.*) with the reason and
// the section keys only, never the password or the email.

const db = require('../config/db');
const auth = require('../services/auth');
const staff = require('../services/platformStaff');

module.exports = function registerStaff(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText, STAFF_SECTIONS }) {
  const KEYS = Object.keys(STAFF_SECTIONS);
  const adminOnly = (req, res, next) => (req.user.role === 'platform_admin' ? next() : notFound(res));

  const renderList = async (res, done = null) => res.render('admin/staff', {
    title: 'فريق الإدارة', rows: await staff.list(db.pool), sections: STAFF_SECTIONS, done,
  });

  const renderForm = (res, { member = null, values, errors = {}, status = 200 }) => res.status(status).render('admin/staff-form', {
    title: member ? `الموظف: ${member.name}` : 'موظف جديد', member, values, errors, sections: STAFF_SECTIONS,
  });

  router.get('/admin/staff', adminOnly, wrap(async (req, res) => renderList(res, doneText(req.query.done))));

  router.get('/admin/staff/new', adminOnly, (req, res) => renderForm(res, { values: { name: '', email: '', sections: [] } }));

  router.post('/admin/staff', adminOnly, wrap(async (req, res) => {
    const { values, errors } = staff.validate(req.body, KEYS, { creating: true });
    const reason = reasonOf(req.body);
    if (!reason) errors.reason = REASON_ERROR;
    if (Object.keys(errors).length) return renderForm(res, { values, errors, status: 422 });
    const made = await staff.create(db.pool, values);
    if (!made.ok) return renderForm(res, { values, errors: { email: 'هذا البريد مستخدم لحساب آخر.' }, status: 409 });
    await audit.write(req.user.id, null, 'admin.staff.create', 'user', made.id, null, { reason, sections: values.sections }, req.ip);
    return res.redirect('/admin/staff?done=staff_created');
  }));

  router.get('/admin/staff/:id', adminOnly, wrap(async (req, res) => {
    const member = await staff.get(db.pool, req.params.id);
    if (!member) return notFound(res);
    return renderForm(res, { member, values: { name: member.name, email: member.email, sections: member.sections } });
  }));

  router.post('/admin/staff/:id', adminOnly, wrap(async (req, res) => {
    const member = await staff.get(db.pool, req.params.id);
    if (!member) return notFound(res);
    const { values, errors } = staff.validate(req.body, KEYS, { creating: false });
    values.email = member.email;
    delete errors.email;
    const reason = reasonOf(req.body);
    if (!reason) errors.reason = REASON_ERROR;
    if (Object.keys(errors).length) return renderForm(res, { member, values, errors, status: 422 });
    await staff.update(db.pool, member.id, values);
    // A new password or fewer sections take effect at once: end the staff member's sessions.
    if (values.password) await auth.logoutAll(member.id);
    await audit.write(req.user.id, null, 'admin.staff.update', 'user', member.id, null,
      { reason, sections: values.sections, password_changed: Boolean(values.password) }, req.ip);
    return res.redirect('/admin/staff?done=staff_updated');
  }));

  router.post('/admin/staff/:id/active', adminOnly, wrap(async (req, res) => {
    const member = await staff.get(db.pool, req.params.id);
    if (!member) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) {
      return renderForm(res, { member, values: { name: member.name, email: member.email, sections: member.sections }, errors: { reason_active: REASON_ERROR }, status: 422 });
    }
    const active = req.body.active === '1';
    await staff.setActive(db.pool, member.id, active);
    if (!active) await auth.logoutAll(member.id);
    await audit.write(req.user.id, null, active ? 'admin.staff.activate' : 'admin.staff.deactivate', 'user', member.id, null, { reason }, req.ip);
    return res.redirect(`/admin/staff?done=${active ? 'staff_activated' : 'staff_deactivated'}`);
  }));
};
