'use strict';

// Platform admin sign-in at /admin/login: the admin's own email address
// (PLATFORM_ADMIN_EMAIL) receives a six-digit code, then the authenticator
// app code is always asked (set up on first use), whatever REQUIRE_ADMIN_2FA
// says. The account is the active platform_admin user with
// PLATFORM_ADMIN_PHONE. Any other address gets the same "code sent" page and
// no mail, so the page never tells whether an address is the admin's.
// Attempts are limited per IP and audited without the address.

const express = require('express');
const auth = require('../services/auth');
const emailAuth = require('../services/emailAuth');
const emailCode = require('../services/emailCode');
const db = require('../config/db');
const { normalizeSaudi, toWesternDigits } = require('../utils/phone');
const { noStore, sameOrigin } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const STEP_COOKIE = 'aqdi_admin_login';
const MFA_COOKIE = 'aqdi_mfa';
const STEP_SECONDS = 10 * 60;
const RESEND_SECONDS = 60;
const PURPOSE = 'verify';

const MESSAGES = {
  invalid_email: 'البريد الإلكتروني غير صحيح.',
  invalid_code: 'الرمز غير صحيح أو انتهت صلاحيته. تأكد منه أو اطلب رمزاً جديداً.',
  rate_limited: 'محاولات كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مرة أخرى.',
  send_failed: 'تعذّر إرسال الرمز الآن. حاول مرة أخرى بعد قليل.',
  off: 'دخول الإدارة بالبريد غير مفعّل على هذا الخادم.',
};

/** The configured admin address, lower-case, or null. */
function adminEmail(env = process.env) {
  return emailAuth.normalizeEmail(env.PLATFORM_ADMIN_EMAIL || '') || null;
}

async function adminUser(pool = db.pool, env = process.env) {
  const phone = normalizeSaudi(env.PLATFORM_ADMIN_PHONE || '');
  if (!phone) return null;
  const [[user]] = await pool.query(
    `SELECT id, phone, role, is_active, twofa_enabled, session_epoch
       FROM users WHERE phone = ? AND role = 'platform_admin' LIMIT 1`,
    [phone],
  );
  return user && user.is_active ? user : null;
}

function audit(req, outcome, userId = null) {
  return emailAuth.audit(db.pool, { action: 'auth.admin_login', userId, outcome, ip: req.ip, method: 'admin_email' });
}

function renderStart(res, email, error, status = 200) {
  return res.status(status).render('pages/admin-login', { title: 'دخول الإدارة', email, error });
}

function pending(req) {
  return auth.verifyStepToken(req.cookies[STEP_COOKIE], 'admin-email');
}

function renderVerify(res, step, error, status = 200) {
  const elapsed = Math.floor((Date.now() - step.sentAt) / 1000);
  return res.status(status).render('pages/login-verify', {
    title: 'دخول الإدارة',
    phoneLocal: step.email,
    sentTo: 'email',
    verifyAction: '/admin/login/verify',
    resendAction: '/admin/login/resend',
    changeHref: '/admin/login',
    changeLabel: 'تغيير البريد الإلكتروني',
    resendIn: Math.max(0, RESEND_SECONDS - elapsed),
    error,
  });
}

const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyFor: (req) => `admin-login:${req.ip}`,
  onLimit: async (req, res) => {
    await audit(req, 'rate_limited');
    const step = pending(req);
    if (step && req.path !== '/admin/login') return renderVerify(res, step, MESSAGES.rate_limited, 429);
    return renderStart(res, '', MESSAGES.rate_limited, 429);
  },
});

router.use('/admin/login', noStore, sameOrigin, (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  useAdminLayout(res);
  next();
});

// Its own quiet layout, unlike the customer sign-in pages.
function useAdminLayout(res) {
  res.locals.layout = 'layouts/admin-auth';
  res.locals.adminAuth = true;
}

// The authenticator step after an admin email code keeps the admin layout
// (the flag lives in the signed step token, so no database read).
router.use('/login/2fa', (req, res, next) => {
  const step = auth.verifyStepToken(req.cookies[MFA_COOKIE], 'mfa');
  if (step && step.admin) {
    useAdminLayout(res);
    res.locals.adminStep = 2;
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

router.get('/admin/login', (req, res) => {
  if (req.user && req.user.role === 'platform_admin') return res.redirect('/admin');
  return renderStart(res, '', adminEmail() ? null : MESSAGES.off);
});

/** Sends a code only when the address is the admin's; the answer looks the same either way. */
async function sendIfAdmin(req, address) {
  const target = adminEmail();
  const user = target && address === target ? await adminUser() : null;
  if (!user) {
    await audit(req, 'not_admin');
    return { ok: true };
  }
  const result = await emailCode.request(address, PURPOSE, req.ip, req.lang);
  await audit(req, result.ok ? 'code_sent' : result.error, user.id);
  return result;
}

router.post('/admin/login', limit, async (req, res, next) => {
  try {
    if (!adminEmail()) return renderStart(res, '', MESSAGES.off, 404);
    const typed = String(req.body.email || '').trim().slice(0, 190);
    const address = emailAuth.normalizeEmail(typed);
    if (!address) return renderStart(res, typed, MESSAGES.invalid_email, 422);
    const result = await sendIfAdmin(req, address);
    if (!result.ok) {
      const message = result.error === 'send_failed' ? MESSAGES.send_failed : MESSAGES.rate_limited;
      return renderStart(res, address, message, result.error === 'send_failed' ? 503 : 429);
    }
    res.cookie(STEP_COOKIE, auth.signStepToken({ email: address, sentAt: Date.now() }, 'admin-email', STEP_SECONDS), auth.cookieOptions(STEP_SECONDS));
    return res.redirect('/admin/login/verify');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/login/verify', (req, res) => {
  const step = pending(req);
  if (!step) return res.redirect('/admin/login');
  return renderVerify(res, step, null);
});

router.post('/admin/login/resend', limit, async (req, res, next) => {
  try {
    const step = pending(req);
    if (!step) return res.redirect('/admin/login');
    const result = await sendIfAdmin(req, step.email);
    if (!result.ok) return renderVerify(res, step, MESSAGES.rate_limited, 429);
    res.cookie(STEP_COOKIE, auth.signStepToken({ email: step.email, sentAt: Date.now() }, 'admin-email', STEP_SECONDS), auth.cookieOptions(STEP_SECONDS));
    return res.redirect('/admin/login/verify');
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/login/verify', limit, async (req, res, next) => {
  try {
    const step = pending(req);
    if (!step) return res.redirect('/admin/login');
    const typed = req.body.code || ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((k) => req.body[k] || '').join('');
    const code = toWesternDigits(String(typed)).replace(/\D/g, '');
    const target = adminEmail();
    const user = target && step.email === target ? await adminUser() : null;
    if (!user) {
      await audit(req, 'invalid_code');
      return renderVerify(res, step, MESSAGES.invalid_code, 422);
    }
    const result = await emailCode.verify(step.email, code, PURPOSE);
    if (!result.ok) {
      await audit(req, result.error || 'invalid_code', user.id);
      const message = result.error === 'locked' ? MESSAGES.rate_limited : MESSAGES.invalid_code;
      return renderVerify(res, step, message, 422);
    }
    res.clearCookie(STEP_COOKIE, { path: '/' });
    await audit(req, 'email_ok', user.id);
    // The authenticator code is always the second step for the admin.
    res.cookie(MFA_COOKIE, auth.signStepToken({ sub: String(user.id), admin: true }, 'mfa', STEP_SECONDS), auth.cookieOptions(STEP_SECONDS));
    return res.redirect(user.twofa_enabled ? '/login/2fa' : '/login/2fa/setup');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.adminEmail = adminEmail;
module.exports.limit = limit;
