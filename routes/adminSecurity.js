'use strict';

// /admin/security: the signed-in platform admin turns on the authenticator
// (two-step verification) from inside the panel. Optional while
// REQUIRE_ADMIN_2FA is 'false'; once on, /admin/login asks for its code.
// The secret is sealed (services/twoFactor.js); backup codes are shown once.
// Turning it off needs a current authenticator (or backup) code and is
// refused while REQUIRE_ADMIN_2FA requires it. Audit admin.2fa.enable /
// admin.2fa.disable hold no secret and no code.

const db = require('../config/db');
const auth = require('../services/auth');
const twoFactor = require('../services/twoFactor');
const { toWesternDigits } = require('../utils/phone');

module.exports = function registerSecurity(router, { wrap, audit }) {
  async function render(req, res, error, status = 200) {
    const required = auth.adminTwoFactorRequired();
    if (req.user.twofaEnabled) return res.status(status).render('admin/security', { title: 'الأمان', enabled: true, required, error });
    const setup = await twoFactor.pendingSetup({ id: req.user.id });
    if (!setup) return res.status(status).render('admin/security', { title: 'الأمان', enabled: true, required, error });
    return res.status(status).render('admin/security', {
      title: 'الأمان',
      enabled: false,
      required,
      secretGroups: setup.secret.match(/.{1,4}/g),
      uri: setup.uri,
      error,
    });
  }

  router.get('/admin/security', wrap(async (req, res) => {
    if (req.query.done === 'off') res.locals.done = 'تم إيقاف التحقق بخطوتين.';
    return render(req, res, null);
  }));

  router.post('/admin/security/2fa', wrap(async (req, res) => {
    if (req.user.twofaEnabled) return res.redirect('/admin/security');
    const code = toWesternDigits(String(req.body.code || '')).replace(/\D/g, '');
    const result = await twoFactor.confirmSetup({ id: req.user.id }, code);
    if (!result.ok) {
      const message = result.error === 'locked'
        ? 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.'
        : 'الرمز غير صحيح. تأكد من وقت جوالك واكتب الرمز الظاهر الآن.';
      return render(req, res, message, 422);
    }
    await audit.write(req.user.id, null, 'admin.2fa.enable', 'user', req.user.id, null, {});
    return res.render('admin/security-codes', { title: 'رموز الاحتياط', codes: result.backupCodes });
  }));

  router.post('/admin/security/2fa/disable', wrap(async (req, res) => {
    if (!req.user.twofaEnabled) return res.redirect('/admin/security');
    if (auth.adminTwoFactorRequired()) {
      return render(req, res, 'إعدادات الخادم تشترط التحقق بخطوتين، فلا يمكن إيقافه من هنا.', 403);
    }
    const code = toWesternDigits(String(req.body.code || '')).trim();
    const result = await twoFactor.verify({ id: req.user.id }, code);
    if (!result.ok) {
      const message = result.error === 'locked'
        ? 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.'
        : 'الرمز غير صحيح. اكتب الرمز الظاهر الآن في التطبيق أو أحد رموز الاحتياط.';
      return render(req, res, message, 422);
    }
    await db.pool.query(
      'UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, twofa_backup_codes = NULL WHERE id = ?',
      [req.user.id],
    );
    await audit.write(req.user.id, null, 'admin.2fa.disable', 'user', req.user.id, null, {});
    return res.redirect('/admin/security?done=off');
  }));
};
