'use strict';

// Arabic explanations of a delivery result (the "send a test message" button
// and the dashboard's latest notifications). Input is only a channel, a status
// and the short error code stored in delivery_log; output never contains a
// token, an address or a provider reply. Pure, no database.

const CHANNEL_LABELS = Object.freeze({ email: 'البريد الإلكتروني', whatsapp: 'واتساب', telegram: 'تيليجرام' });

// "Not sent because something is not set up" (status skipped).
const NOT_CONFIGURED = {
  smtp_not_configured: () => 'البريد غير مضبوط على الخادم (إعدادات SMTP ناقصة).',
  channel_not_configured: (ch) => `لم تُضبط إعدادات ${CHANNEL_LABELS[ch] || 'القناة'} لهذا المكتب بعد.`,
  plan_lacks_channel: (ch) => `باقة المكتب لا تشمل ${CHANNEL_LABELS[ch] || 'هذه القناة'}.`,
  no_contact: (ch) => ({
    email: 'لا يوجد بريد إلكتروني في حساب المستلم.',
    whatsapp: 'لم يؤكد المستلم رقم واتساب.',
    telegram: 'لم يربط المستلم محادثته في تيليجرام بعد.',
  }[ch] || 'لا يوجد عنوان للمستلم في هذه القناة.'),
  opted_out: () => 'المستلم أوقف هذه القناة في إعدادات إشعاراته.',
  user_inactive: () => 'حساب المستلم موقوف.',
  unknown_channel: () => 'قناة غير معروفة.',
  unknown_provider: () => 'مزود الخدمة غير معروف في الإعدادات.',
};

// "Tried and failed" (status failed, or pending a retry).
function failureReason(code) {
  const c = String(code || '');
  if (c === 'timeout') return 'انتهت مهلة الاتصال بمزود الخدمة.';
  if (c === 'network_disabled_in_tests') return 'الإرسال الحقيقي متوقف في بيئة الاختبار.';
  if (c === 'internal_error') return 'خطأ داخلي في التطبيق أثناء الإرسال.';
  if (c === 'http_401' || c === 'http_403') return 'رفض مزود الخدمة بيانات الدخول (الرمز غير صحيح أو منتهي).';
  if (c === 'http_400') return 'رفض مزود الخدمة الرسالة (تحقق من القالب أو من الرقم أو المحادثة).';
  if (c === 'http_404') return 'مزود الخدمة لا يعرف هذا الحساب أو المحادثة.';
  if (c === 'http_429') return 'تجاوزت حد الإرسال لدى مزود الخدمة. حاول لاحقاً.';
  if (/^http_5\d\d$/.test(c)) return 'خدمة المزود متعطلة الآن. حاول لاحقاً.';
  if (c === 'EAUTH') return 'رفض خادم البريد اسم المستخدم أو كلمة المرور.';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(c)) return 'تعذر الاتصال بخادم البريد.';
  if (c === 'EENVELOPE') return 'رفض خادم البريد عنوان المرسل أو المستلم.';
  const shown = /^[A-Za-z0-9_]{1,40}$/.test(c) ? ` (الرمز: ${c})` : '';
  return `رفض مزود الخدمة الرسالة${shown}.`;
}

/** { kind: 'sent' | 'not_configured' | 'failed' | 'pending', reason } for one delivery. */
function explain(channel, status, code) {
  if (status === 'sent') return { kind: 'sent', reason: null };
  if (status === 'skipped') {
    const f = NOT_CONFIGURED[code];
    return { kind: 'not_configured', reason: f ? f(channel) : 'لم تُرسل لأن القناة غير مضبوطة.' };
  }
  if (status === 'pending') return { kind: 'pending', reason: code ? `ستُعاد المحاولة: ${failureReason(code)}` : null };
  return { kind: 'failed', reason: failureReason(code) };
}

// The test message goes to the person pressing the button, so "you" wording.
const TEST_NO_CONTACT = {
  email: 'لا يوجد بريد إلكتروني في حسابك. أضفه من «إعدادات الإشعارات».',
  whatsapp: 'لم تؤكد رقم واتساب بعد. أكّده من «إعدادات الإشعارات».',
  telegram: 'لم تربط محادثتك في تيليجرام بعد. اتبع خطوات الربط في قسم تيليجرام.',
};

/** The test button's result: { ok, status: sent | skipped | failed, text } in Arabic. */
function describeTest(channel, result) {
  const label = CHANNEL_LABELS[channel] || channel;
  if (result.ok) return { ok: true, status: 'sent', text: `${label}: تم إرسال رسالة التجربة ✓ تحقق من وصولها إليك.` };
  if (result.skip) {
    const reason = result.error === 'no_contact' ? TEST_NO_CONTACT[channel] : explain(channel, 'skipped', result.error).reason;
    return { ok: false, status: 'skipped', text: `${label}: لم تُرسل لأن القناة غير مضبوطة. ${reason}` };
  }
  return { ok: false, status: 'failed', text: `${label}: فشل الإرسال. ${failureReason(result.error)}` };
}

module.exports = { CHANNEL_LABELS, explain, describeTest, failureReason };
