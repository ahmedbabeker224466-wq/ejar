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

const signedIn = [requireAuth, requirePerm('settings.basic')];

// ------------------------------------------------------------ notification center

function listUrl(kind, page) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `/notifications${query ? `?${query}` : ''}`;
}

router.get('/notifications', signedIn, wrap(async (req, res) => {
  const kind = Object.hasOwn(notifications.KIND_LABELS, String(req.query.kind || '')) ? String(req.query.kind) : '';
  const list = await notifications.listFor(db.pool, req.user.id, { kind, page: req.query.page });
  res.render('notifications/index', {
    title: 'الإشعارات',
    ...list,
    kind,
    kindLabels: notifications.KIND_LABELS,
    home: auth.homeFor(req.user.role),
    rows: list.rows.map((n) => ({ ...n, at: riyadhNow(new Date(n.created_at)).slice(0, 16) })),
    back: listUrl(kind, list.page),
    prevUrl: list.page > 1 ? listUrl(kind, list.page - 1) : null,
    nextUrl: list.page < list.pages ? listUrl(kind, list.page + 1) : null,
  });
}));

const safeBack = (value) => (/^\/notifications(\?[\w=&-]*)?$/.test(String(value || '')) ? String(value) : '/notifications');

router.post('/notifications/read-all', signedIn, wrap(async (req, res) => {
  await notifications.markAllRead(db.pool, req.user.id);
  return res.redirect(safeBack(req.body.back));
}));

router.post('/notifications/:id/read', signedIn, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id || !(await notifications.markRead(db.pool, req.user.id, id))) return notFound(res);
  return res.redirect(safeBack(req.body.back));
}));

// Opens a notification's page and marks it read.
router.post('/notifications/:id/open', signedIn, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const [[row]] = id ? await db.pool.query('SELECT link FROM notifications WHERE id = ? AND user_id = ?', [id, req.user.id]) : [[null]];
  if (!row) return notFound(res);
  await notifications.markRead(db.pool, req.user.id, id);
  return res.redirect(notifications.safeLink(row.link) || '/notifications');
}));

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
  const email = String(req.body.email || '').trim().slice(0, 190);
  if (email && !EMAIL.test(email)) errors.email = 'اكتب بريداً إلكترونياً صحيحاً أو اتركه فارغاً.';
  if (Object.keys(errors).length) {
    return renderSettings(req, res, { status: 422, errors, values: { ...values, email } });
  }
  await notifications.savePrefs(db.pool, req.user.id, values);
  await db.pool.query('UPDATE users SET email = ? WHERE id = ?', [email || null, req.user.id]);
  return res.redirect('/settings/notifications?done=saved');
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
  return res.redirect('/settings/notifications?done=telegram_removed#telegram');
}));

router.post('/settings/notifications/whatsapp/login-phone', signedIn, wrap(async (req, res) => {
  await contacts.useLoginPhone(db.pool, req.user);
  return res.redirect('/settings/notifications?done=whatsapp#whatsapp');
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
  return res.redirect('/settings/notifications?done=whatsapp#whatsapp');
}));

router.post('/settings/notifications/whatsapp/remove', signedIn, wrap(async (req, res) => {
  await contacts.removeWhatsapp(db.pool, req.user.id);
  return res.redirect('/settings/notifications?done=whatsapp_removed#whatsapp');
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
      ? 'تم ربط حسابك في عقدي بنجاح. ستصلك التذكيرات هنا.'
      : 'أرسل رمز الربط الظاهر في صفحة "إعدادات الإشعارات" في عقدي.';
    const sent = await telegram.send({ token: office.token, chatId: chat.id, text: reply });
    if (!sent.ok) logger.warn(`Telegram reply failed for office ${office.officeId}: ${sent.error}`);
  }
  return res.json({ ok: true });
}));

module.exports = router;
