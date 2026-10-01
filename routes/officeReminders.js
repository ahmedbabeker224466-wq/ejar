'use strict';

// /office/settings/reminders: the office's reminder rules, its WhatsApp and
// Telegram settings (secrets write-only: after saving the page shows only
// "مضبوط ✓"), and "send a test message to me" per channel. Owner and manager
// only ('settings.office'). Mounted inside routes/office.js, so req.office
// comes from loadOffice; every query is scoped to it.

const express = require('express');
const db = require('../config/db');
const reminders = require('../services/reminders');
const channelSettings = require('../services/channelSettings');
const delivery = require('../services/delivery');
const { scopeToOffice } = require('../services/scopeToOffice');
const { createAudit } = require('../services/audit');
const { requirePerm } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const BASE = '/office/settings/reminders';
const guard = requirePerm('settings.office');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const DONE = {
  rules: 'تم حفظ قواعد التذكير.',
  whatsapp: 'تم حفظ إعدادات واتساب.',
  telegram: 'تم حفظ إعدادات تيليجرام وربط البوت.',
  removed: 'تم حذف إعدادات القناة.',
};
const CHANNEL_LABELS = { email: 'البريد الإلكتروني', whatsapp: 'واتساب', telegram: 'تيليجرام' };
const TEST_ERRORS = {
  smtp_not_configured: 'البريد غير مضبوط على الخادم (SMTP).',
  no_contact: 'لا يوجد لديك عنوان لهذه القناة. أضفه من "إعدادات الإشعارات".',
  channel_not_configured: 'القناة غير مضبوطة لهذا المكتب.',
  timeout: 'انتهت مهلة الاتصال. حاول مرة أخرى.',
};

async function render(req, res, { status = 200, errors = {}, values = null, message = null, warning = null, test = null } = {}) {
  const scoped = scopeToOffice(db.pool, req.office.id);
  const rules = await reminders.rulesFor(scoped);
  return res.status(status).render('office/reminders', {
    title: 'إعدادات التذكيرات',
    kinds: reminders.RULE_KINDS,
    values: values || Object.fromEntries(Object.entries(rules).map(([k, r]) => [k, { enabled: r.enabled, days: r.days.join(', ') }])),
    channels: await channelSettings.summary(scoped),
    errors,
    message: message || DONE[req.query.done] || null,
    warning,
    test,
    channelLabels: CHANNEL_LABELS,
  });
}

router.get(BASE, guard, wrap((req, res) => render(req, res)));

router.post(`${BASE}/rules`, guard, wrap(async (req, res) => {
  const { values, errors } = reminders.validateRules(req.body);
  if (Object.keys(errors).length) {
    const shown = Object.fromEntries(Object.keys(reminders.RULE_KINDS).map((k) => [k, {
      enabled: values[k].enabled, days: String(req.body[`${k}_days`] || '').slice(0, 60),
    }]));
    return render(req, res, { status: 422, errors, values: shown });
  }
  await reminders.saveRules(scopeToOffice(db.pool, req.office.id), values, req.user.id);
  await createAudit(db.pool).log(req.user.id, req.office.id, 'reminders.rules', 'office', req.office.id, null,
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { enabled: v.enabled, days: v.days }])), req.ip);
  return res.redirect(`${BASE}?done=rules`);
}));

router.post(`${BASE}/whatsapp`, guard, wrap(async (req, res) => {
  const result = await channelSettings.saveWhatsapp(scopeToOffice(db.pool, req.office.id), req.body, req.user.id);
  if (!result.ok) return render(req, res, { status: 422, errors: { whatsapp: result.errors } });
  await createAudit(db.pool).log(req.user.id, req.office.id, 'channel.saved', 'office', req.office.id, null, { channel: 'whatsapp' }, req.ip);
  return res.redirect(`${BASE}?done=whatsapp#whatsapp`);
}));

router.post(`${BASE}/telegram`, guard, wrap(async (req, res) => {
  const result = await channelSettings.saveTelegram(scopeToOffice(db.pool, req.office.id), req.body, req.user.id);
  if (!result.ok) return render(req, res, { status: 422, errors: { telegram: result.errors } });
  await createAudit(db.pool).log(req.user.id, req.office.id, 'channel.saved', 'office', req.office.id, null, { channel: 'telegram' }, req.ip);
  if (result.warning) return render(req, res, { warning: result.warning });
  return res.redirect(`${BASE}?done=telegram#telegram`);
}));

router.post(`${BASE}/:channel/remove`, guard, wrap(async (req, res, next) => {
  const channel = String(req.params.channel);
  if (!['whatsapp', 'telegram'].includes(channel)) return next();
  await channelSettings.remove(scopeToOffice(db.pool, req.office.id), channel);
  await createAudit(db.pool).log(req.user.id, req.office.id, 'channel.removed', 'office', req.office.id, null, { channel }, req.ip);
  return res.redirect(`${BASE}?done=removed`);
}));

const testLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyFor: (req) => `channel-test:${req.user.id}`,
  onLimit: (req, res) => render(req, res, { status: 429, test: { ok: false, text: 'أرسلت رسائل تجربة كثيرة. انتظر 10 دقائق.' } }),
});

router.post(`${BASE}/test/:channel`, guard, testLimit, wrap(async (req, res, next) => {
  const channel = String(req.params.channel);
  if (!Object.hasOwn(CHANNEL_LABELS, channel)) return next();
  const [[user]] = await db.pool.query('SELECT id, phone, email FROM users WHERE id = ?', [req.user.id]);
  const result = await delivery.sendTest(db.pool, { officeId: req.office.id, user, channel, officeName: req.office.name });
  const text = result.ok
    ? `تم إرسال رسالة تجربة عبر ${CHANNEL_LABELS[channel]}.`
    : `لم تُرسل رسالة التجربة عبر ${CHANNEL_LABELS[channel]}: ${TEST_ERRORS[result.error] || 'رفض مزود الخدمة الرسالة. راجع الإعدادات.'}`;
  return render(req, res, { status: result.ok ? 200 : 422, test: { ok: result.ok, text } });
}));

module.exports = router;
