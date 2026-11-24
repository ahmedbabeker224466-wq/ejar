'use strict';

// Platform admin sign-in at /admin/login: the admin's email
// (PLATFORM_ADMIN_EMAIL) and password (PLATFORM_ADMIN_PASSWORD, at least 8
// characters), both set in the server environment. The account is the active
// platform_admin user with PLATFORM_ADMIN_PHONE. When that user has turned on
// the authenticator (from /admin/security), or REQUIRE_ADMIN_2FA demands it,
// the authenticator step follows; otherwise the session starts at once.
// One generic error for a wrong email or password; attempts are limited per
// IP and audited without the address. Each correct password mails the admin
// a short sign-in notice (loginAlert).

const crypto = require('node:crypto');
const express = require('express');
const auth = require('../services/auth');
const emailAuth = require('../services/emailAuth');
const db = require('../config/db');
const { normalizeSaudi } = require('../utils/phone');
const { noStore, sameOrigin } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');
const email = require('../services/channels/email');
const platformStaff = require('../services/platformStaff');
const { riyadhDate } = require('../services/contractDates');

const router = express.Router();

const MFA_COOKIE = 'aqdi_mfa';
const STEP_SECONDS = 10 * 60;
const MIN_PASSWORD = 8;

const MESSAGES = {
  wrong: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  rate_limited: 'محاولات كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مرة أخرى.',
  off: 'دخول الإدارة غير مضبوط على هذا الخادم.',
};

/** The configured admin address, lower-case, or null. */
function adminEmail(env = process.env) {
  return emailAuth.normalizeEmail(env.PLATFORM_ADMIN_EMAIL || '') || null;
}

/** The configured password, or null when missing or shorter than 8 characters. */
function adminPassword(env = process.env) {
  const value = String(env.PLATFORM_ADMIN_PASSWORD || '');
  return value.length >= MIN_PASSWORD ? value : null;
}

/** Constant-time comparison of two strings of any length. */
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function configured(env = process.env) {
  return Boolean(adminEmail(env) && adminPassword(env));
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
  return emailAuth.audit(db.pool, { action: 'auth.admin_login', userId, outcome, ip: req.ip, method: 'admin_password' });
}

/**
 * Mails the admin a short notice after each correct password, so a sign-in
 * they did not make shows up at once. Best effort: never blocks or fails the
 * sign-in. Holds the Riyadh time and the browser only (no password, no IP).
 */
function loginAlert(req, who = null) {
  const to = adminEmail();
  if (!to) return;
  const at = new Date();
  const time = at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' });
  const agent = String(req.get('user-agent') || '').slice(0, 120) || '—';
  const text = [
    who ? `دخل الموظف «${who}» إلى لوحة إدارة ميعاد.` : 'تم الدخول إلى لوحة إدارة ميعاد بكلمة المرور الصحيحة.',
    `الوقت: ${riyadhDate(at)} ${time} بتوقيت الرياض`,
    `المتصفح: ${agent}`,
    '',
    'إذا لم تكن أنت، فغيّر PLATFORM_ADMIN_PASSWORD من إعدادات تطبيق Node.js في السي بانل فوراً، ثم فعّل التحقق بخطوتين من صفحة «الأمان».',
  ].join('\n');
  Promise.resolve()
    .then(() => email.send({ to, subject: 'تنبيه: دخول إلى لوحة إدارة ميعاد', text }))
    .catch(() => {});
}

function renderStart(res, email, error, status = 200) {
  return res.status(status).render('pages/admin-login', { title: 'دخول الإدارة', email, error });
}

// Its own quiet layout, unlike the customer sign-in pages.
function useAdminLayout(res) {
  res.locals.layout = 'layouts/admin-auth';
  res.locals.adminAuth = true;
}

const limit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyFor: (req) => `admin-login:${req.ip}`,
  onLimit: async (req, res) => {
    await audit(req, 'rate_limited');
    return renderStart(res, '', MESSAGES.rate_limited, 429);
  },
});

router.use('/admin/login', noStore, sameOrigin, (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  useAdminLayout(res);
  next();
});

// The authenticator step after an admin password keeps the admin layout
// (the flag lives in the signed step token, so no database read).
router.use('/login/2fa', (req, res, next) => {
  const step = auth.verifyStepToken(req.cookies[MFA_COOKIE], 'mfa');
  if (step && step.admin) {
    useAdminLayout(res);
    res.locals.adminSteps = true;
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

router.get('/admin/login', (req, res) => {
  if (req.user && req.user.role === 'platform_admin') return res.redirect('/admin');
  return renderStart(res, '', configured() ? null : MESSAGES.off);
});

router.post('/admin/login', limit, async (req, res, next) => {
  try {
    if (!configured()) return renderStart(res, '', MESSAGES.off, 404);
    const typed = String(req.body.email || '').trim().slice(0, 190);
    const address = emailAuth.normalizeEmail(typed) || '';
    const password = String(req.body.password || '').slice(0, 200);
    // Both comparisons always run, so the timing says nothing about which one failed.
    const emailOk = sameSecret(address, adminEmail());
    const passwordOk = sameSecret(password, adminPassword());
    const user = emailOk && passwordOk ? await adminUser() : null;
    if (!user) {
      // A platform_staff account (routes/adminStaff.js): bcrypt password, its own sections.
      const member = await platformStaff.authenticate(db.pool, address, password);
      if (!member) {
        await audit(req, 'wrong');
        return renderStart(res, typed, MESSAGES.wrong, 401);
      }
      loginAlert(req, member.name || 'موظف');
      await db.pool.query('UPDATE users SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [member.id]);
      if (member.twofa_enabled) {
        await audit(req, 'staff_password_ok', member.id);
        res.cookie(MFA_COOKIE, auth.signStepToken({ sub: String(member.id), admin: true }, 'mfa', STEP_SECONDS), auth.cookieOptions(STEP_SECONDS));
        return res.redirect('/login/2fa');
      }
      await audit(req, 'staff_success', member.id);
      await auth.issueSession(req, res, member);
      return res.redirect('/admin');
    }
    loginAlert(req);
    if (user.twofa_enabled || auth.needsTwoFactor(user)) {
      await audit(req, 'password_ok', user.id);
      res.cookie(MFA_COOKIE, auth.signStepToken({ sub: String(user.id), admin: true }, 'mfa', STEP_SECONDS), auth.cookieOptions(STEP_SECONDS));
      return res.redirect(user.twofa_enabled ? '/login/2fa' : '/login/2fa/setup');
    }
    await audit(req, 'success', user.id);
    await auth.issueSession(req, res, user);
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.adminEmail = adminEmail;
module.exports.adminPassword = adminPassword;
module.exports.limit = limit;
