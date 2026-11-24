'use strict';

// /admin/security: the signed-in platform admin turns on the authenticator
// (two-step verification) from inside the panel. Optional while
// REQUIRE_ADMIN_2FA is 'false'; once on, /admin/login asks for its code.
// The secret is sealed (services/twoFactor.js); backup codes are shown once.
// Audit admin.2fa.enable holds no secret and no code.

const twoFactor = require('../services/twoFactor');
const { toWesternDigits } = require('../utils/phone');

module.exports = function registerSecurity(router, { wrap, audit }) {
  async function render(req, res, error, status = 200) {
    if (req.user.twofaEnabled) return res.status(status).render('admin/security', { title: 'الأمان', enabled: true, error: null });
    const setup = await twoFactor.pendingSetup({ id: req.user.id });
    if (!setup) return res.status(status).render('admin/security', { title: 'الأمان', enabled: true, error: null });
    return res.status(status).render('admin/security', {
      title: 'الأمان',
      enabled: false,
      secretGroups: setup.secret.match(/.{1,4}/g),
      uri: setup.uri,
      error,
    });
  }

  router.get('/admin/security', wrap(async (req, res) => render(req, res, null)));

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
};
