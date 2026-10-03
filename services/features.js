'use strict';

// Plan feature switches (plans.features) and the platform kill switches, in
// one place for the routes and the delivery queue to ask.

const db = require('../config/db');
const plans = require('./plans');
const platformSettings = require('./platformSettings');

const PLAN_MESSAGES = {
  ai_reading: 'باقتك لا تشمل قراءة العقد بالذكاء الاصطناعي. رقِّ اشتراكك أو أدخل البيانات يدوياً.',
  reports_csv: 'باقتك لا تشمل تنزيل ملفات CSV. رقِّ اشتراكك لتفعيلها.',
  whatsapp: 'باقتك لا تشمل واتساب. رقِّ اشتراكك لتفعيله.',
  telegram: 'باقتك لا تشمل تيليجرام. رقِّ اشتراكك لتفعيله.',
};
const AI_PAUSED_MESSAGE = 'قراءة العقد بالذكاء الاصطناعي متوقفة مؤقتاً. أدخل البيانات يدوياً.';

/** Whether the office's current plan has a feature switched on (no plan = allowed). */
async function officeAllows(pool, officeId, flag) {
  const [[row]] = await pool.query(
    'SELECT p.features FROM offices o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = ?',
    [officeId],
  );
  if (!row || row.features === null || row.features === undefined) return true;
  return plans.planAllows({ features: row.features }, flag);
}

/** Express middleware for an /office route: 403 (page or plain text for CSV) when the plan lacks the feature. */
function requireFeature(flag, { text = false } = {}) {
  return function requireFeatureMiddleware(req, res, next) {
    officeAllows(db.pool, req.office.id, flag).then((ok) => {
      if (ok) return next();
      if (text) return res.status(403).type('text/plain; charset=utf-8').send(PLAN_MESSAGES[flag]);
      return res.status(403).render('errors/403', { title: 'غير متاح في باقتك', heading: 'غير متاح في باقتك', message: PLAN_MESSAGES[flag] });
    }).catch(next);
  };
}

/**
 * The AI reading state for an office: { available, message }. Off when the
 * platform kill switch is on or the plan lacks it (the API key check stays in
 * services/aiContractReader.js).
 */
async function aiAvailability(pool, officeId) {
  if (await platformSettings.aiDisabled(pool)) return { available: false, message: AI_PAUSED_MESSAGE };
  if (!(await officeAllows(pool, officeId, 'ai_reading'))) return { available: false, message: PLAN_MESSAGES.ai_reading };
  return { available: true, message: null };
}

module.exports = { PLAN_MESSAGES, AI_PAUSED_MESSAGE, officeAllows, requireFeature, aiAvailability };
