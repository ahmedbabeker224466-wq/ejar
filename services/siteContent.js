'use strict';

// Public marketing content that does not need the database: the FAQ used when
// the faqs table is empty, and the public site's page list (sitemap).
// Wording rule: nothing here claims that the app belongs to, is approved by or
// complies with Ejar, REGA, ZATCA or any authority.

const DEFAULT_FAQS = [
  ['هل «عقدي» تابع لمنصة إيجار؟', 'لا. عقدي تطبيق خاص غير تابع لمنصة إيجار ولا يتصل بها. تنشئ عقودك في منصة إيجار كما تفعل اليوم، ثم ترفع ملف العقد إلينا ليقرأ التطبيق التواريخ والمبالغ فقط.'],
  ['ماذا يقرأ الذكاء الاصطناعي من العقد؟', 'التواريخ والإيجار وطريقة الدفع والمدينة ونوع العقار فقط. لا نحفظ أسماء الأطراف ولا أرقام الهوية أو الآيبان أو العدادات أو العناوين، ولا نحتفظ بملف العقد بعد قراءته.'],
  ['هل مواعيد التجديد مضمونة؟', 'المواعيد للتذكير فقط. نحسبها من تاريخ نهاية العقد وفق القواعد المعروفة، وعليك دائماً مراجعة عقدك وأنظمة الجهات الرسمية قبل أي إجراء.'],
  ['كيف يصل التذكير؟', 'داخل التطبيق دائماً، ويمكن إضافة البريد الإلكتروني وواتساب وتيليجرام حسب باقتك، مع ساعات هدوء تمنع الرسائل المزعجة ليلاً.'],
  ['كم يدفع الملّاك والمستأجرون؟', 'لا شيء. يشترك المكتب فقط، ويدعو الملّاك والمستأجرين برمز يستخدمونه مجاناً لمتابعة عقودهم.'],
  ['هل بياناتي آمنة؟', 'كل مكتب يرى بياناته فقط، ولا تظهر أرقام الجوال أو الأسماء في الإعلانات العامة. تُحفظ الأسرار مشفرة، وتُسجَّل العمليات المهمة في سجل تدقيق.'],
  ['هل توجد تجربة مجانية؟', 'نعم، تجربة مجانية لمدة 14 يوماً بدون بطاقة. بعدها تختار الباقة المناسبة وتدفع بالبطاقة أو بالحوالة البنكية.'],
  ['كيف أنشر إعلان وحدة شاغرة؟', 'من صفحة الإعلانات اختر الوحدة، أكمل الحي والإيجار والوصف وأضف صوراً، ثم انشر. يصلك استفسار الزائر داخل التطبيق دون أن يظهر رقمك للعموم.'],
];

// Public pages that belong in the sitemap (listings and blog posts are added from the database).
const PUBLIC_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/listings', changefreq: 'daily', priority: '0.9' },
  { path: '/features', changefreq: 'monthly', priority: '0.7' },
  { path: '/pricing', changefreq: 'monthly', priority: '0.8' },
  { path: '/about', changefreq: 'yearly', priority: '0.4' },
  { path: '/contact', changefreq: 'yearly', priority: '0.4' },
  { path: '/blog', changefreq: 'weekly', priority: '0.6' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
  { path: '/disclaimer', changefreq: 'yearly', priority: '0.3' },
];

/** The FAQ rows from the database (active, in order), or the defaults. */
async function faqs(pool) {
  const [rows] = await pool.query('SELECT question_ar, answer_ar FROM faqs WHERE is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 50');
  return rows.length ? rows.map((r) => ({ q: r.question_ar, a: r.answer_ar })) : DEFAULT_FAQS.map(([q, a]) => ({ q, a }));
}

module.exports = { DEFAULT_FAQS, PUBLIC_PAGES, faqs };
