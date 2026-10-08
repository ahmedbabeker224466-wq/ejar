'use strict';

// /admin/launch: the launch readiness page (services/launch.js). Behind the admin
// guard (platform admin + 2FA + same-origin). It shows pass / warn / fail for each
// item and never a secret value. Manual confirmations and the test email need a
// written reason and are audit-logged.

const db = require('../config/db');
const launch = require('../services/launch');
const email = require('../services/channels/email');
const { rateLimit } = require('../middleware/rateLimit');

const MAIL_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFor: (req) => `launch-mail:${req.user.id}`,
  onLimit: (req, res) => res.status(429).type('text/plain; charset=utf-8').send('يمكنك إرسال 5 رسائل تجربة فقط في الساعة.'),
});

const ADDRESS = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

module.exports = function registerLaunch(router, { wrap, notFound, reasonOf, REASON_ERROR, audit, doneText }) {
  async function render(req, res, { error = null, status = 200, openKey = null } = {}) {
    const checks = await launch.runChecks({
      pool: db.pool,
      env: process.env,
      now: new Date(),
      host: req.get('host'),
      hsts: res.getHeader('Strict-Transport-Security') || null,
    });
    return res.status(status).render('admin/launch', {
      title: 'جاهزية الإطلاق',
      checks,
      summary: launch.summarize(checks),
      confirms: launch.CONFIRMS,
      rules: launch.ruleSummary(),
      done: doneText(req.query.done),
      error,
      openKey,
    });
  }

  router.get('/admin/launch', wrap((req, res) => render(req, res)));

  router.post('/admin/launch/confirm/:key', wrap(async (req, res) => {
    const key = String(req.params.key);
    if (!Object.hasOwn(launch.CONFIRMS, key)) return notFound(res);
    const reason = reasonOf(req.body);
    if (!reason) return render(req, res, { error: REASON_ERROR, status: 422, openKey: key });
    const checked = launch.validateConfirm(key, req.body, new Date());
    if (!checked.ok) return render(req, res, { error: checked.error, status: 422, openKey: key });
    await launch.saveRecord(db.pool, key, checked.record, { userId: req.user.id });
    await audit.write(req.user.id, null, 'admin.launch.confirm', 'launch', null, null, { key, on: checked.record.on, reason }, req.ip);
    return res.redirect('/admin/launch?done=launch_confirmed');
  }));

  router.post('/admin/launch/smtp-test', MAIL_LIMIT, wrap(async (req, res) => {
    const reason = reasonOf(req.body);
    if (!reason) return render(req, res, { error: REASON_ERROR, status: 422, openKey: 'smtp' });
    const to = String(req.body.to || '').trim();
    if (!ADDRESS.test(to) || to.length > 190) return render(req, res, { error: 'اكتب بريداً إلكترونياً صحيحاً لاستلام الرسالة.', status: 422, openKey: 'smtp' });
    const sent = await email.send({ to, subject: 'رسالة تجربة من عقدي', text: 'هذه رسالة تجربة للتأكد من إعدادات البريد قبل الإطلاق. لا حاجة للرد عليها.' });
    const record = await launch.saveSmtpTest(db.pool, sent);
    await audit.write(req.user.id, null, 'admin.launch.smtp_test', 'launch', null, null, { ok: record.ok, reason }, req.ip);
    return res.redirect(`/admin/launch?done=${record.ok ? 'smtp_ok' : 'smtp_failed'}`);
  }));
};
