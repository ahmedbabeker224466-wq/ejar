'use strict';

const express = require('express');
const otp = require('../services/otp');
const auth = require('../services/auth');
const twoFactor = require('../services/twoFactor');
const emailAuth = require('../services/emailAuth');
const emailCode = require('../services/emailCode');
const platformSettings = require('../services/platformSettings');
const db = require('../config/db');
const { normalizeSaudi, toWesternDigits, toLocal } = require('../utils/phone');
const { noStore, sameOrigin } = require('../middleware/security');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

const LOGIN_COOKIE = 'aqdi_login'; // phone entered, code sent
const MFA_COOKIE = 'aqdi_mfa'; // phone verified, second factor pending
const EMAIL_COOKIE = 'aqdi_login_email'; // email entered, code sent
const STEP_SECONDS = 10 * 60;
const RESEND_SECONDS = 60;

const MESSAGES = {
  invalid_phone: 'رقم الجوال غير صحيح. اكتب رقم جوال سعودي يبدأ بـ 5 ويتكون من 9 أرقام.',
  invalid_code: 'الرمز غير صحيح أو انتهت صلاحيته. تأكد منه أو اطلب رمزاً جديداً.',
  send_failed: 'تعذّر إرسال الرمز الآن. حاول مرة أخرى بعد قليل.',
  inactive: 'لا يمكن الدخول بهذا الحساب حالياً. تواصل مع الدعم.',
  signups_disabled: 'التسجيل الجديد متوقف مؤقتاً. حاول لاحقاً.',
  invalid_2fa: 'الرمز غير صحيح. اكتب الرمز الظاهر الآن في تطبيق المصادقة أو أحد رموز الاحتياط.',
};

// Email sign-in wording, never mixed with the phone pages.
const EMAIL_MESSAGES = {
  invalid_email: 'البريد الإلكتروني غير صحيح. اكتبه بهذا الشكل: name@example.com',
  unknown: 'لا يوجد حساب بهذا البريد الإلكتروني. تأكد من كتابته، أو سجّل مكتبك من صفحة التسجيل.',
  ambiguous: 'لا يمكن الدخول بهذا البريد الإلكتروني. تواصل مع الدعم.',
  platform_admin: 'حساب مدير المنصة لا يدخل بالبريد الإلكتروني. ادخل برقم الجوال والتحقق بخطوتين.',
  inactive: 'لا يمكن الدخول بهذا الحساب حالياً. تواصل مع الدعم.',
  exists: 'هذا البريد الإلكتروني مسجّل من قبل. سجّل الدخول به بدلاً من ذلك.',
  signups_disabled: 'التسجيل الجديد متوقف مؤقتاً. حاول لاحقاً.',
  rate_limited: 'محاولات كثيرة من هذا الجهاز. انتظر 15 دقيقة ثم حاول مرة أخرى.',
  send_failed: 'تعذّر إرسال الرمز إلى بريدك الآن. حاول مرة أخرى بعد قليل.',
};
const EMAIL_STATUS = { invalid_email: 422, unknown: 422, ambiguous: 403, platform_admin: 403, inactive: 403, exists: 409, signups_disabled: 403, send_failed: 503 };

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
    signupStep: pending.intent === 'register' ? 1 : null,
    resendIn: Math.max(0, RESEND_SECONDS - elapsed),
    error,
  });
}

function pendingEmail(req) {
  return auth.verifyStepToken(req.cookies[EMAIL_COOKIE], 'login-email');
}

function renderEmailVerify(res, pending, error, status = 200) {
  const elapsed = Math.floor((Date.now() - pending.sentAt) / 1000);
  res.status(status).render('pages/login-verify', {
    title: 'رمز الدخول',
    phoneLocal: pending.email,
    sentTo: 'email',
    signupStep: pending.intent === 'register' ? 1 : null,
    verifyAction: '/login/email/verify',
    resendAction: '/login/email/resend',
    changeHref: pending.intent === 'register' ? '/register' : '/login',
    changeLabel: 'تغيير البريد الإلكتروني',
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

const EMAIL_PAGES = {
  login: {
    title: 'تسجيل الدخول',
    heading: 'تسجيل الدخول',
    lead: 'اكتب بريدك الإلكتروني المسجّل، وسنرسل إليه رمز دخول من 6 أرقام.',
    button: 'دخول',
  },
  register: {
    title: 'سجّل مكتبك',
    heading: 'سجّل مكتبك',
    lead: 'اكتب بريدك الإلكتروني وسنرسل إليه رمز تحقق، ثم تكتب بيانات مكتبك ورقم رخصة فال.',
    button: 'متابعة',
  },
};

function renderEmailPage(res, intent, email, error, status = 200, next = null) {
  const mode = intent === 'register' ? 'register' : 'login';
  const page = EMAIL_PAGES[mode];
  return res.status(status).render('pages/login-email', { ...page, intent: mode, email, error, next: safeNext(next) });
}

// While email codes can be sent (SMTP configured), /login and /register show the email form.
// /login?method=phone keeps the phone page.
function emailPagesOn() {
  return emailCode.enabled();
}

function showEmailPage(req) {
  return emailPagesOn() && req.query.method !== 'phone';
}

function renderPhonePage(res, intent, phone, error, status = 200, next = null) {
  const mode = intent === 'register' ? 'register' : 'login';
  return res.status(status).render('pages/login', { ...PHONE_PAGES[mode], intent: mode, phone, error, next: safeNext(next) });
}

// Step 1: phone number
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next) || auth.homeFor(req.user.role));
  if (showEmailPage(req)) return renderEmailPage(res, 'login', '', null, 200, req.query.next);
  return renderPhonePage(res, 'login', '', null, 200, req.query.next);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(auth.homeFor(req.user.role));
  if (emailPagesOn()) return renderEmailPage(res, 'register', '', null);
  return renderPhonePage(res, 'register', '', null);
});

// ------------------------------------------------------------ email sign-in
// Every attempt is counted per IP (also invalid ones).

const emailLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFor: (req) => `email-login:${req.ip}`,
  onLimit: async (req, res, next) => {
    if (!emailPagesOn()) return next();
    await emailAuth.audit(db.pool, { action: 'auth.email_login', outcome: 'rate_limited', ip: req.ip });
    const intent = req.body.intent === 'register' ? 'register' : 'login';
    return renderEmailPage(res, intent, '', EMAIL_MESSAGES.rate_limited, 429, req.body.next);
  },
});

router.post('/login/email', (req, res, next) => (emailPagesOn() ? next() : next('router')), emailLimit, async (req, res, next) => {
  try {
    return await requestEmailCode(req, res);
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------ email sign-in code
// The email sign-in: a six-digit code goes to the
// address, and only the right code signs in or creates the account. A new
// address becomes a user with no role, who then creates the office on
// /office/new. The platform admin never signs in by email.

function emailCodeError(result) {
  if (result.error === 'invalid_phone') return EMAIL_MESSAGES.invalid_email;
  return messageFor(result);
}

async function requestEmailCode(req, res) {
  const intent = req.body.intent === 'register' ? 'register' : 'login';
  const nextPath = safeNext(req.body.next);
  const typed = String(req.body.email || '').trim().slice(0, 190);
  const address = emailAuth.normalizeEmail(typed);
  const action = intent === 'register' ? 'auth.email_register' : 'auth.email_login';
  const refuse = async (error, userId = null) => {
    await emailAuth.audit(db.pool, { action, userId, outcome: error, ip: req.ip, method: 'email_code' });
    return renderEmailPage(res, intent, address || typed, EMAIL_MESSAGES[error], EMAIL_STATUS[error] || 422, nextPath);
  };
  if (!address) return refuse('invalid_email');

  if (intent === 'register') {
    const found = await emailAuth.findForLogin(db.pool, address);
    if (found.ok || found.user || found.error === 'ambiguous') return refuse('exists');
    if (await platformSettings.signupsDisabled(db.pool)) return refuse('signups_disabled');
  } else {
    const found = await emailAuth.findForLogin(db.pool, address);
    if (!found.ok) return refuse(found.error, found.user ? found.user.id : null);
  }

  const result = await emailCode.request(address, 'login', req.ip, req.lang);
  if (!result.ok) {
    return renderEmailPage(res, intent, address, emailCodeError(result), result.error === 'send_failed' ? 503 : 429, nextPath);
  }
  stepCookie(res, EMAIL_COOKIE, auth.signStepToken({ email: address, intent, sentAt: Date.now(), next: nextPath }, 'login-email', STEP_SECONDS));
  return res.redirect('/login/email/verify');
}

router.get('/login/email/verify', (req, res) => {
  const pending = pendingEmail(req);
  if (!pending) return res.redirect('/login');
  return renderEmailVerify(res, pending, null);
});

router.post('/login/email/resend', emailLimit, async (req, res, next) => {
  try {
    const pending = pendingEmail(req);
    if (!pending) return res.redirect('/login');
    const result = await emailCode.request(pending.email, 'login', req.ip, req.lang);
    if (!result.ok) return renderEmailVerify(res, pending, emailCodeError(result), 429);
    const fresh = { email: pending.email, intent: pending.intent, sentAt: Date.now(), next: safeNext(pending.next) };
    stepCookie(res, EMAIL_COOKIE, auth.signStepToken(fresh, 'login-email', STEP_SECONDS));
    return res.redirect('/login/email/verify');
  } catch (err) {
    return next(err);
  }
});

router.post('/login/email/verify', async (req, res, next) => {
  try {
    const pending = pendingEmail(req);
    if (!pending) return res.redirect('/login');
    const typed = req.body.code || ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((k) => req.body[k] || '').join('');
    const code = toWesternDigits(String(typed)).replace(/\D/g, '');
    const result = await emailCode.verify(pending.email, code, 'login');
    if (!result.ok) return renderEmailVerify(res, pending, messageFor(result), 422);
    clearStep(res, EMAIL_COOKIE);

    const intent = pending.intent === 'register' ? 'register' : 'login';
    const action = intent === 'register' ? 'auth.email_register' : 'auth.email_login';
    let found = await emailAuth.findForLogin(db.pool, pending.email);
    if (!found.ok && found.error === 'unknown' && intent === 'register') {
      const made = await emailAuth.register(db.pool, pending.email, { signupsDisabled: () => platformSettings.signupsDisabled(db.pool) });
      if (!made.ok && made.error !== 'exists') {
        await emailAuth.audit(db.pool, { action, outcome: made.error, ip: req.ip, method: 'email_code' });
        return renderEmailPage(res, intent, pending.email, EMAIL_MESSAGES[made.error], EMAIL_STATUS[made.error] || 422);
      }
      found = await emailAuth.findForLogin(db.pool, pending.email);
    }
    if (!found.ok) {
      await emailAuth.audit(db.pool, { action, userId: found.user ? found.user.id : null, outcome: found.error, ip: req.ip, method: 'email_code' });
      return renderEmailPage(res, 'login', pending.email, EMAIL_MESSAGES[found.error], EMAIL_STATUS[found.error] || 422);
    }
    const { user } = found;
    await db.pool.query('UPDATE users SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    await emailAuth.audit(db.pool, { action, userId: user.id, outcome: 'ok', ip: req.ip, method: 'email_code' });
    if (auth.needsTwoFactor(user)) {
      stepCookie(res, MFA_COOKIE, auth.signStepToken({ sub: String(user.id) }, 'mfa', STEP_SECONDS));
      return res.redirect('/login/2fa');
    }
    return finishLogin(req, res, user, pending.next);
  } catch (err) {
    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const raw = String(req.body.phone || '');
    const intent = req.body.intent === 'register' ? 'register' : 'login';
    const nextPath = safeNext(req.body.next);
    const phone = normalizeSaudi(raw);
    if (!phone) return renderPhonePage(res, intent, raw.slice(0, 20), MESSAGES.invalid_phone, 422, nextPath);
    const result = await otp.request(phone, 'login', req.ip, req.lang);
    if (!result.ok) {
      return renderPhonePage(res, intent, toLocal(phone), messageFor(result), result.error === 'send_failed' ? 503 : 429, nextPath);
    }
    stepCookie(res, LOGIN_COOKIE, auth.signStepToken({ phone, intent, sentAt: Date.now(), next: nextPath }, 'login-phone', STEP_SECONDS));
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
    const result = await otp.request(pending.phone, 'login', req.ip, req.lang);
    if (!result.ok) return renderVerify(res, pending, messageFor(result), 429);
    const fresh = { phone: pending.phone, intent: pending.intent === 'register' ? 'register' : 'login', sentAt: Date.now(), next: safeNext(pending.next) };
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
    let user;
    try {
      user = await auth.findOrCreateUser(result.phone);
    } catch (err) {
      if (err.code === 'signups_disabled') return renderPhonePage(res, 'login', '', MESSAGES.signups_disabled, 403);
      throw err;
    }
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
    const used = req.sessionCookie || { name: auth.SESSION_COOKIE, path: '/' };
    res.clearCookie(used.name, { path: used.path });
    return res.redirect('/login');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await auth.logoutAll(req.user.id);
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    res.clearCookie(auth.LANDLORD_COOKIE, { path: '/' });
    res.clearCookie(auth.TENANT_COOKIE, { path: '/' });
    res.clearCookie(auth.ADMIN_COOKIE, { path: auth.ADMIN_COOKIE_PATH });
    return res.redirect('/login');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.formatWait = formatWait;
module.exports.messageFor = messageFor;
module.exports.emailLimit = emailLimit;
