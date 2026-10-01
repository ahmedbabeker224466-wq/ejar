'use strict';

const express = require('express');
const otp = require('../services/otp');
const auth = require('../services/auth');
const twoFactor = require('../services/twoFactor');
const db = require('../config/db');
const { normalizeSaudi, toWesternDigits, toLocal } = require('../utils/phone');
const { noStore, sameOrigin } = require('../middleware/security');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const LOGIN_COOKIE = 'aqdi_login'; // phone entered, code sent
const MFA_COOKIE = 'aqdi_mfa'; // phone verified, second factor pending
const STEP_SECONDS = 10 * 60;
const RESEND_SECONDS = 60;

const MESSAGES = {
  invalid_phone: 'رقم الجوال غير صحيح. اكتب رقم جوال سعودي يبدأ بـ 5 ويتكون من 9 أرقام.',
  invalid_code: 'الرمز غير صحيح أو انتهت صلاحيته. تأكد منه أو اطلب رمزاً جديداً.',
  send_failed: 'تعذّر إرسال الرمز الآن. حاول مرة أخرى بعد قليل.',
  inactive: 'لا يمكن الدخول بهذا الحساب حالياً. تواصل مع الدعم.',
  invalid_2fa: 'الرمز غير صحيح. اكتب الرمز الظاهر الآن في تطبيق المصادقة أو أحد رموز الاحتياط.',
};

function formatWait(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  return s < 60 ? `${s} ثانية` : `${Math.ceil(s / 60)} دقيقة`;
}

/** Arabic message for an OTP or 2FA failure, never revealing if a phone is registered. */
function messageFor(result, invalidMessage = MESSAGES.invalid_code) {
  if (result.error === 'rate_limited') {
    return `طلبت رموزاً كثيرة. انتظر ${formatWait(result.retryAfterSec)} ثم حاول مرة أخرى.`;
  }
  if (result.error === 'locked') {
    return `أُدخل رمز خاطئ عدة مرات. انتظر ${formatWait(result.retryAfterSec)} ثم حاول مرة أخرى.`;
  }
  if (result.error === 'invalid_phone') return MESSAGES.invalid_phone;
  if (result.error === 'send_failed') return MESSAGES.send_failed;
  return invalidMessage;
}

function stepCookie(res, name, token) {
  res.cookie(name, token, auth.cookieOptions(STEP_SECONDS));
}

function clearStep(res, name) {
  res.clearCookie(name, { path: '/' });
}

function pendingLogin(req) {
  return auth.verifyStepToken(req.cookies[LOGIN_COOKIE], 'login-phone');
}

async function pendingMfaUser(req) {
  const payload = auth.verifyStepToken(req.cookies[MFA_COOKIE], 'mfa');
  if (!payload) return null;
  const [[user]] = await db.pool.query(
    'SELECT id, phone, role, is_active, twofa_enabled, session_epoch FROM users WHERE id = ?',
    [payload.sub],
  );
  return user && user.is_active ? user : null;
}

function renderVerify(res, pending, error, status = 200) {
  const elapsed = Math.floor((Date.now() - pending.sentAt) / 1000);
  res.status(status).render('pages/login-verify', {
    title: 'رمز الدخول',
    phoneLocal: toLocal(pending.phone),
    resendIn: Math.max(0, RESEND_SECONDS - elapsed),
    error,
  });
}

// Where a login may continue instead of the role's home page. Only these
// exact paths are honoured, so ?next= can never redirect anywhere else.
const NEXT_PATHS = new Set(['/join']);

function safeNext(value) {
  return NEXT_PATHS.has(String(value || '')) ? String(value) : null;
}

async function finishLogin(req, res, user, next = null) {
  await auth.issueSession(req, res, user);
  return res.redirect(safeNext(next) || auth.homeFor(user.role));
}

// '/login' also covers '/login/verify', '/login/2fa' and the other steps.
router.use(['/login', '/logout', '/logout-all', '/register'], noStore, sameOrigin);

// The phone page, as "sign in" or as "register your office". Both use the same
// phone code flow; a new phone ends up at /office/new (auth.homeFor).
const PHONE_PAGES = {
  login: { title: 'تسجيل الدخول', heading: 'تسجيل الدخول', lead: 'أدخل رقم جوالك وسنرسل لك رمز دخول برسالة نصية.' },
  register: {
    title: 'سجّل مكتبك',
    heading: 'سجّل مكتبك',
    lead: 'أدخل رقم جوالك وسنرسل لك رمزاً برسالة نصية، ثم تكتب بيانات مكتبك. التجربة مجانية 14 يوماً.',
  },
};

function renderPhonePage(res, intent, phone, error, status = 200, next = null) {
  const mode = intent === 'register' ? 'register' : 'login';
  return res.status(status).render('pages/login', { ...PHONE_PAGES[mode], intent: mode, phone, error, next: safeNext(next) });
}

// Step 1: phone number
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next) || auth.homeFor(req.user.role));
  return renderPhonePage(res, 'login', '', null, 200, req.query.next);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user.role));
  return renderPhonePage(res, 'register', '', null);
});

router.post('/login', async (req, res, next) => {
  try {
    const raw = String(req.body.phone || '');
    const intent = req.body.intent === 'register' ? 'register' : 'login';
    const nextPath = safeNext(req.body.next);
    const phone = normalizeSaudi(raw);
    if (!phone) return renderPhonePage(res, intent, raw.slice(0, 20), MESSAGES.invalid_phone, 422, nextPath);
    const result = await otp.request(phone, 'login', req.ip);
    if (!result.ok) {
      return renderPhonePage(res, intent, toLocal(phone), messageFor(result), result.error === 'send_failed' ? 503 : 429, nextPath);
    }
    stepCookie(res, LOGIN_COOKIE, auth.signStepToken({ phone, sentAt: Date.now(), next: nextPath }, 'login-phone', STEP_SECONDS));
    return res.redirect('/login/verify');
  } catch (err) {
    return next(err);
  }
});

// Step 2: the SMS code
router.get('/login/verify', (req, res) => {
  const pending = pendingLogin(req);
  if (!pending) return res.redirect('/login');
  return renderVerify(res, pending, null);
});

router.post('/login/resend', async (req, res, next) => {
  try {
    const pending = pendingLogin(req);
    if (!pending) return res.redirect('/login');
    const result = await otp.request(pending.phone, 'login', req.ip);
    if (!result.ok) return renderVerify(res, pending, messageFor(result), 429);
    const fresh = { phone: pending.phone, sentAt: Date.now(), next: safeNext(pending.next) };
    stepCookie(res, LOGIN_COOKIE, auth.signStepToken(fresh, 'login-phone', STEP_SECONDS));
    return res.redirect('/login/verify');
  } catch (err) {
    return next(err);
  }
});

router.post('/login/verify', async (req, res, next) => {
  try {
    const pending = pendingLogin(req);
    if (!pending) return res.redirect('/login');

    const typed = req.body.code || ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((k) => req.body[k] || '').join('');
    const code = toWesternDigits(String(typed)).replace(/\D/g, '');

    const result = await otp.verify(pending.phone, code, 'login');
    if (!result.ok) return renderVerify(res, pending, messageFor(result), 422);

    clearStep(res, LOGIN_COOKIE);
    const user = await auth.findOrCreateUser(result.phone);
    if (!user.is_active) {
      return renderPhonePage(res, 'login', '', MESSAGES.inactive, 403);
    }

    if (auth.needsTwoFactor(user)) {
      stepCookie(res, MFA_COOKIE, auth.signStepToken({ sub: String(user.id) }, 'mfa', STEP_SECONDS));
      const mustSetUp = user.role === 'platform_admin' && !user.twofa_enabled;
      return res.redirect(mustSetUp ? '/login/2fa/setup' : '/login/2fa');
    }
    return finishLogin(req, res, user, pending.next);
  } catch (err) {
    return next(err);
  }
});

// Step 3 (platform_admin always, office_owner when enabled): authenticator app
router.get('/login/2fa', async (req, res, next) => {
  try {
    const user = await pendingMfaUser(req);
    if (!user) return res.redirect('/login');
    if (!user.twofa_enabled) return res.redirect('/login/2fa/setup');
    return res.render('pages/login-2fa', { title: 'التحقق بخطوتين', error: null });
  } catch (err) {
    return next(err);
  }
});

router.post('/login/2fa', async (req, res, next) => {
  try {
    const user = await pendingMfaUser(req);
    if (!user) return res.redirect('/login');
    const result = await twoFactor.verify(user, toWesternDigits(String(req.body.code || '')));
    if (!result.ok) {
      return res.status(422).render('pages/login-2fa', {
        title: 'التحقق بخطوتين',
        error: messageFor(result, MESSAGES.invalid_2fa),
      });
    }
    clearStep(res, MFA_COOKIE);
    return finishLogin(req, res, user);
  } catch (err) {
    return next(err);
  }
});

async function renderSetup(res, user, error, status = 200) {
  const setup = await twoFactor.pendingSetup(user);
  if (!setup) return res.redirect('/login/2fa');
  return res.status(status).render('pages/login-2fa-setup', {
    title: 'تفعيل التحقق بخطوتين',
    secretGroups: setup.secret.match(/.{1,4}/g),
    uri: setup.uri,
    error,
  });
}

router.get('/login/2fa/setup', async (req, res, next) => {
  try {
    const user = await pendingMfaUser(req);
    if (!user) return res.redirect('/login');
    if (user.twofa_enabled) return res.redirect('/login/2fa');
    if (user.role !== 'platform_admin') return res.redirect('/login');
    return await renderSetup(res, user, null);
  } catch (err) {
    return next(err);
  }
});

router.post('/login/2fa/setup', async (req, res, next) => {
  try {
    const user = await pendingMfaUser(req);
    if (!user) return res.redirect('/login');
    if (user.twofa_enabled) return res.redirect('/login/2fa');
    if (user.role !== 'platform_admin') return res.redirect('/login');
    const result = await twoFactor.confirmSetup(user, toWesternDigits(String(req.body.code || '')));
    if (!result.ok) return await renderSetup(res, user, messageFor(result, MESSAGES.invalid_2fa), 422);

    clearStep(res, MFA_COOKIE);
    await auth.issueSession(req, res, user);
    return res.render('pages/login-backup-codes', {
      title: 'رموز الاحتياط',
      codes: result.backupCodes,
      next: auth.homeFor(user.role),
    });
  } catch (err) {
    return next(err);
  }
});

// Logout
router.get('/logout', async (req, res, next) => {
  try {
    if (req.user) await auth.revokeSession(req.user.tokenId);
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return res.redirect('/login');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await auth.logoutAll(req.user.id);
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return res.redirect('/login');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.formatWait = formatWait;
module.exports.messageFor = messageFor;
