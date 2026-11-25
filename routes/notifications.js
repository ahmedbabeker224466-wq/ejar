'use strict';

// The notification center (/notifications), personal notification settings
// (/settings/notifications) and the Telegram webhook. Mounted inside
// routes/areas.js. A notification is read and changed only through its
// user_id; another person's id answers 404.

const express = require('express');
const db = require('../config/db');
const auth = require('../services/auth');
const notifications = require('../services/notifications');
const contacts = require('../services/contacts');
const channelSettings = require('../services/channelSettings');
const telegram = require('../services/channels/telegram');
const otp = require('../services/otp');
const { parseId } = require('../services/landlords');
const { riyadhNow } = require('../utils/time');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { noStore, sameOrigin } = require('../middleware/security');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

for (const path of ['/notifications', '/settings']) router.use(path, noStore, sameOrigin);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

// The shared notification pages open inside the shell of the account that
// opened them: the office panel for office members, the landlord or tenant
// shell for those (owner, Nov 2026).
async function areaShell(req, res, next) {
  try {
    const role = req.user && req.user.role;
    if (['office_owner', 'office_manager', 'office_staff'].includes(role)) {
      const { membershipsFor } = require('../services/offices');
      const memberships = await membershipsFor(db.pool, req.user.id);
      if (!memberships.some((m) => m.is_active)) return next();
      const office = require('../middleware/loadOffice');
      return office.loadOffice(db.pool)(req, res, next);
    }
    if (role === 'landlord' || role === 'tenant') {
      const { landlordLinks, tenantLinks } = require('../services/memberships');
      const [landlord, tenant] = await Promise.all([landlordLinks(db.pool, req.user.id), tenantLinks(db.pool, req.user.id)]);
      const used = req.sessionCookie && req.sessionCookie.name;
      let area = used === auth.TENANT_COOKIE ? 'tenant' : used === auth.LANDLORD_COOKIE ? 'landlord' : role;
      if (area === 'landlord' && !landlord.length && tenant.length) area = 'tenant';
      if (area === 'tenant' && !tenant.length && landlord.length) area = 'landlord';
      if (!landlord.length && !tenant.length) return next();
      res.locals.layout = 'layouts/portal';
      res.locals.currentArea = area;
      res.locals.areas = [['landlord', landlord, 'صفحة المالك'], ['tenant', tenant, 'صفحة المستأجر']]
        .filter((x) => x[1].length).map((x) => ({ key: x[0], href: `/${x[0]}`, label: x[2] }));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

const signedIn = [requireAuth, requirePerm('settings.basic'), areaShell];

// ------------------------------------------------------------ notification center

/**
 * The notification center at `${base}/notifications`: '' for everyone, '/admin'
 * for the platform admin and staff (their own session cookie lives on /admin).
 */
function mountCenter(target, base, guard) {
  const root = `${base}/notifications`;

  function listUrl(kind, page, as) {
    const params = new URLSearchParams();
    if (as) params.set('as', as);
    if (kind) params.set('kind', kind);
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return `${root}${query ? `?${query}` : ''}`;
  }

  const backPattern = new RegExp(`^${root.replace(/\//g, '\\/')}(\\?[\\w=&-]*)?$`);
  const safeBack = (value) => (backPattern.test(String(value || '')) ? String(value) : root);

  target.get(root, guard, wrap(async (req, res) => {
    const kind = Object.hasOwn(notifications.KIND_LABELS, String(req.query.kind || '')) ? String(req.query.kind) : '';
    const list = await notifications.listFor(db.pool, req.user.id, { kind, page: req.query.page });
    res.render('notifications/index', {
      title: 'الإشعارات',
      ...list,
      kind,
      base,
      kindLabels: notifications.KIND_LABELS,
      home: auth.homeFor(req.user.role),
      rows: list.rows.map((n) => ({ ...n, at: riyadhNow(new Date(n.created_at)).slice(0, 16) })),
      back: listUrl(kind, list.page, res.locals.areaAs),
      prevUrl: list.page > 1 ? listUrl(kind, list.page - 1, res.locals.areaAs) : null,
      nextUrl: list.page < list.pages ? listUrl(kind, list.page + 1, res.locals.areaAs) : null,
    });
  }));

  target.post(`${root}/read-all`, guard, wrap(async (req, res) => {
    await notifications.markAllRead(db.pool, req.user.id);
    return res.redirect(safeBack(req.body.back));
  }));

  target.post(`${root}/:id/read`, guard, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !(await notifications.markRead(db.pool, req.user.id, id))) return notFound(res);
    return res.redirect(safeBack(req.body.back));
  }));

  // Opens a notification's page and marks it read.
  target.post(`${root}/:id/open`, guard, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const [[row]] = id ? await db.pool.query('SELECT link FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]) : [[null]];
    if (!row) return notFound(res);
    await notifications.markRead(db.pool, req.user.id, id);
    return res.redirect(notifications.safeLink(row.link) || root);
  }));
}

mountCenter(router, '', signedIn);

// ------------------------------------------------------------ personal settings

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const DONE = {
  saved: 'تم حفظ إعدادات الإشعارات.',
  whatsapp: 'تم تأكيد رقم واتساب.',
  whatsapp_removed: 'تم حذف رقم واتساب.',
  telegram_removed: 'تم إلغاء ربط تيليجرام.',
};
const OTP_ERRORS = {
  invalid_phone: 'اكتب رقم جوال سعودي صحيح يبدأ بـ 05.',
  rate_limited: 'طلبت رموزاً كثيرة. انتظر قليلاً ثم حاول مرة أخرى.',
  locked: 'محاولات كثيرة خاطئة. انتظر 15 دقيقة ثم حاول مرة أخرى.',
  send_failed: 'تعذر إرسال الرمز الآن. حاول بعد قليل.',
  invalid: 'الرمز غير صحيح أو انتهت صلاحيته.',
  nothing_pending: 'اطلب رمزاً جديداً أولاً.',
};

async function renderSettings(req, res, { status = 200, errors = {}, values = null, telegramCode = null, whatsappStep = false, message = null } = {}) {
  const prefs = await notifications.prefsFor(db.pool, req.user.id);
  const [[user]] = await db.pool.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
  return res.status(status).render('notifications/settings', {
    title: 'إعدادات الإشعارات',
    values: values || { email: user.email || '', channels: prefs.channels, quietStart: prefs.quietStart, quietEnd: prefs.quietEnd },
    hours: HOURS,
    errors,
    contacts: await contacts.contactsView(db.pool, req.user),
    bots: await contacts.botsFor(db.pool, req.user.id),
    telegramCode,
    codeMinutes: contacts.CODE_MINUTES,
    whatsappStep: whatsappStep || undefined,
    message: message || DONE[req.query.done] || null,
    home: auth.homeFor(req.user.role),
  });
}

router.get('/settings/notifications', signedIn, wrap((req, res) => renderSettings(req, res)));

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,180}\.[A-Za-z]{2,}$/;

router.post('/settings/notifications', signedIn, wrap(async (req, res) => {
  const { values, errors } = notifications.validatePrefs(req.body);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
  if (email && !EMAIL.test(email)) errors.email = 'اكتب بريداً إلكترونياً صحيحاً أو اتركه فارغاً.';
  if (Object.keys(errors).length) {
    return renderSettings(req, res, { status: 422, errors, values: { ...values, email } });
  }
  try {
    await db.pool.query('UPDATE users SET email = ? WHERE id = ?', [email || null, req.user.id]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    return renderSettings(req, res, { status: 422, errors: { email: 'هذا البريد مستخدم في حساب آخر. اكتب بريداً آخر.' }, values: { ...values, email } });
  }
  await notifications.savePrefs(db.pool, req.user.id, values);
  return res.redirect(`/settings/notifications?${res.locals.areaAs ? `as=${res.locals.areaAs}&` : ''}done=saved`);
}));

const contactLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyFor: (req) => `contacts:${req.user.id}`,
  onLimit: (req, res) => renderSettings(req, res, { status: 429, errors: { contact: 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' } }),
});

router.post('/settings/notifications/telegram/code', signedIn, contactLimit, wrap(async (req, res) => {
  const { code } = await contacts.createTelegramCode(db.pool, req.user.id);
  return renderSettings(req, res, { telegramCode: code });
}));

router.post('/settings/notifications/telegram/unlink', signedIn, wrap(async (req, res) => {
  await contacts.unlinkTelegram(db.pool, req.user.id);
  return res.redirect(`/settings/notifications?${res.locals.areaAs ? `as=${res.locals.areaAs}&` : ''}done=telegram_removed#telegram`);
}));

router.post('/settings/notifications/whatsapp/login-phone', signedIn, wrap(async (req, res) => {
  await contacts.useLoginPhone(db.pool, req.user);
  return res.redirect(`/settings/notifications?${res.locals.areaAs ? `as=${res.locals.areaAs}&` : ''}done=whatsapp#whatsapp`);
}));

router.post('/settings/notifications/whatsapp/change', signedIn, contactLimit, wrap(async (req, res) => {
  const result = await contacts.startWhatsappChange(db.pool, { userId: req.user.id, phone: req.body.phone, ip: req.ip, otp });
  if (!result.ok) return renderSettings(req, res, { status: 422, errors: { whatsapp: OTP_ERRORS[result.error] || OTP_ERRORS.send_failed } });
  return renderSettings(req, res, { whatsappStep: true });
}));

router.post('/settings/notifications/whatsapp/verify', signedIn, contactLimit, wrap(async (req, res) => {
  const result = await contacts.finishWhatsappChange(db.pool, { userId: req.user.id, code: req.body.code, otp });
  if (!result.ok) {
    return renderSettings(req, res, { status: 422, whatsappStep: true, errors: { whatsapp: OTP_ERRORS[result.error] || OTP_ERRORS.invalid } });
  }
  return res.redirect(`/settings/notifications?${res.locals.areaAs ? `as=${res.locals.areaAs}&` : ''}done=whatsapp#whatsapp`);
}));

router.post('/settings/notifications/whatsapp/remove', signedIn, wrap(async (req, res) => {
  await contacts.removeWhatsapp(db.pool, req.user.id);
  return res.redirect(`/settings/notifications?${res.locals.areaAs ? `as=${res.locals.areaAs}&` : ''}done=whatsapp_removed#whatsapp`);
}));

// ------------------------------------------------------------ Telegram webhook

// Telegram calls /webhooks/telegram/<secret>; the secret (random, per office)
// is compared in constant time and an unknown one answers 404. A message with
// a valid link code links that chat. Always { ok: true } otherwise, so
// Telegram does not retry.
router.post('/webhooks/telegram/:secret', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const office = await channelSettings.telegramBySecret(db.pool, req.params.secret);
  if (!office) return res.status(404).json({ ok: false });
  const message = req.body && req.body.message;
  const chat = message && message.chat;
  if (chat && chat.type === 'private' && typeof message.text === 'string') {
    const userId = await contacts.linkTelegram(db.pool, { code: contacts.codeFromMessage(message.text), chatId: chat.id });
    const reply = userId
      ? 'تم ربط حسابك في ميعاد بنجاح. ستصلك التذكيرات هنا.'
      : 'أرسل رمز الربط الظاهر في صفحة "إعدادات الإشعارات" في ميعاد.';
    const sent = await telegram.send({ token: office.token, chatId: chat.id, text: reply });
    if (!sent.ok) logger.warn(`Telegram reply failed for office ${office.officeId}: ${sent.error}`);
  }
  return res.json({ ok: true });
}));

module.exports = router;
module.exports.mountCenter = mountCenter;
