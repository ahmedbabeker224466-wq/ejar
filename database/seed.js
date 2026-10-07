'use strict';

// Default rows: plans, platform message templates and settings.
// Idempotent: existing rows are never changed, so running it twice (or after an
// admin edits a price or a template) changes nothing.
//
//   node database/seed.js

// Feature switches of a plan (see services/plans.js FEATURE_FLAGS). The trial
// has everything on so a new office can try it all.
const ALL_FEATURES = { whatsapp: true, telegram: true, reports_csv: true, ai_reading: true, listings: true };

// Placeholder prices in SAR (VAT-exclusive); set real prices from the admin panel later.
const PLANS = [
  {
    code: 'trial',
    name_ar: 'تجربة مجانية',
    price_monthly: 0,
    price_yearly: 0,
    max_contracts: 20,
    max_units: 20,
    max_members: 2,
    max_ai_reads_monthly: 10,
    max_photos: 30,
    max_listings: 3,
    features: ALL_FEATURES,
    sort_order: 1,
  },
  {
    code: 'basic',
    name_ar: 'الأساسية',
    price_monthly: 99,
    price_yearly: 990,
    max_contracts: 100,
    max_units: 100,
    max_members: 3,
    max_ai_reads_monthly: 100,
    max_photos: 200,
    max_listings: 10,
    features: { whatsapp: false, telegram: false, reports_csv: true, ai_reading: true, listings: true },
    sort_order: 2,
  },
  {
    code: 'pro',
    name_ar: 'الاحترافية',
    price_monthly: 249,
    price_yearly: 2490,
    max_contracts: 500,
    max_units: 500,
    max_members: 10,
    max_ai_reads_monthly: 500,
    max_photos: 1000,
    max_listings: 50,
    features: ALL_FEATURES,
    sort_order: 3,
  },
  {
    code: 'enterprise',
    name_ar: 'المؤسسات',
    price_monthly: 599,
    price_yearly: 5990,
    max_contracts: null, // null = unlimited
    max_units: null,
    max_members: null,
    max_ai_reads_monthly: 2000,
    max_photos: null,
    max_listings: null,
    features: ALL_FEATURES,
    sort_order: 4,
  },
];

// Wording stays cautious: reminders, never legal statements.
const REMINDER_BODIES = {
  rent_change_deadline:
    'تذكير من {{office}}: يقترب آخر موعد لطلب تعديل الأجرة لعقد {{property}} في {{date}}. راجع عقدك في منصة إيجار.',
  decision_deadline:
    'تذكير من {{office}}: يقترب آخر موعد لإشعار عدم التجديد لعقد {{property}} في {{date}}. راجع عقدك في منصة إيجار.',
  end_30: 'تذكير من {{office}}: ينتهي عقد {{property}} بعد 30 يوماً، في {{date}}.',
  end_7: 'تذكير من {{office}}: ينتهي عقد {{property}} بعد أسبوع، في {{date}}.',
  payment_due: 'تذكير من {{office}}: دفعة بمبلغ {{amount}} لعقد {{property}} مستحقة في {{date}}.',
  payment_late: 'تنبيه من {{office}}: دفعة بمبلغ {{amount}} لعقد {{property}} كانت مستحقة في {{date}} ولم تُسجَّل بعد.',
};

const REMINDER_CHANNELS = ['site', 'email', 'whatsapp', 'telegram'];

const TEMPLATES = [
  ...Object.entries(REMINDER_BODIES).flatMap(([kind, body]) =>
    REMINDER_CHANNELS.map((channel) => ({ code: `reminder_${kind}`, channel, body_ar: body })),
  ),
  {
    code: 'otp_login',
    channel: 'sms',
    body_ar: 'رمز الدخول إلى عقدي: {{code}}. صالح لمدة 5 دقائق. لا تشاركه مع أحد.',
  },
  {
    code: 'invite_landlord',
    channel: 'whatsapp',
    body_ar: 'دعاك {{office}} لمتابعة عقاراتك على عقدي. كود الدعوة: {{code}} — ادخل من {{link}}',
  },
  {
    code: 'invite_tenant',
    channel: 'whatsapp',
    body_ar: 'دعاك {{office}} لمتابعة عقدك ومواعيده على عقدي. كود الدعوة: {{code}} — ادخل من {{link}}',
  },
  {
    code: 'invite_staff',
    channel: 'whatsapp',
    body_ar: 'دعاك {{office}} للانضمام إلى فريقه على عقدي. كود الدعوة: {{code}} — ادخل من {{link}}',
  },
];


// Three honest draft articles (status draft, flagged "needs review before
// publishing"). They hold no legal advice and no rule numbers: the numbers
// live in config/ejarRules.js and must be checked against the official source.
const REVIEW_NOTE = '> يحتاج مراجعة قبل النشر: مسودة عامة، تحقق من كل معلومة من المصدر الرسمي، وليست استشارة قانونية.';
const BLOG_DRAFTS = [
  {
    slug: 'how-to-track-rental-contract-dates',
    title_ar: 'كيف تتابع مواعيد عقود الإيجار',
    excerpt_ar: 'طريقة عملية بسيطة لمكتب عقار كي لا تفوته مواعيد النهاية والتجديد والدفعات.',
    body_ar: `${REVIEW_NOTE}

## لماذا تضيع المواعيد؟

عندما يكبر عدد العقود تصبح المواعيد مبعثرة بين الملفات والجوالات والذاكرة. تفوت الدفعة أو يمر موعد التجديد دون قرار، ثم يبدأ الاستعجال.

## ثلاث خطوات تبدأ بها

1. **اجمع التواريخ في مكان واحد:** تاريخ البداية والنهاية والإيجار وطريقة الدفع لكل عقد، دون أسماء أو أرقام هوية.
2. **حدّد المراحل:** عقد هادئ، ثم قريب، ثم عاجل، ثم فات موعده. المرحلة تخبرك ماذا تفعل اليوم.
3. **اجعل التذكير تلقائياً:** تنبيه قبل كل موعد يصل لك وللمالك والمستأجر، لا تعتمد على ذاكرتك.

## ماذا تتابع كل أسبوع؟

- العقود التي تقترب من موعد القرار.
- الدفعات المتأخرة.
- طلبات الصيانة المفتوحة.

## تنبيه

المواعيد هنا للتذكير فقط. ارجع دائماً إلى عقدك وإلى المصدر الرسمي قبل أي إجراء.`,
  },
  {
    slug: 'renewal-and-non-renewal-notice',
    title_ar: 'متى يبدأ التجديد وإشعار عدم التجديد',
    excerpt_ar: 'شرح مبسط لفكرة التجديد التلقائي وإشعار عدم التجديد وكيف تضبط تذكيراتك حولهما.',
    body_ar: `${REVIEW_NOTE}

## الفكرة العامة

كثير من عقود الإيجار تتجدد تلقائياً إذا لم يعترض أحد الطرفين في الوقت المحدد. لذلك يهم المكتب أن يعرف **آخر يوم** يمكن فيه إرسال إشعار عدم التجديد.

## كيف تحسب الموعد؟

يُحسب الموعد رجوعاً من تاريخ نهاية العقد بعدد أيام تحدده القواعد المعلنة. هذا العدد يجب أن تتحقق منه من المصدر الرسمي، ولا نكتبه هنا حتى لا يتقادم.

## ماذا تفعل؟

- ضع تذكيراً متدرجاً قبل الموعد بوقت كافٍ.
- اسأل المالك عن قراره مبكراً واحفظ ردّه.
- إذا فات الموعد فراجع العقد والجهة الرسمية قبل أي خطوة.

## تنبيه

هذا المقال معلومات عامة وليس استشارة قانونية. المواعيد في التطبيق للتذكير فقط.`,
  },
  {
    slug: 'riyadh-rent-increase-freeze-office-view',
    title_ar: 'تجميد زيادة الإيجار في الرياض: وش يعني للمكتب',
    excerpt_ar: 'نظرة عملية لمكتب العقار على أثر قرار تجميد زيادة الإيجارات في الرياض على التجديد والتذكير.',
    body_ar: `${REVIEW_NOTE}

## ما المقصود؟

أُعلن في الرياض قرار يحدّ من زيادة الإيجار في عقود معينة خلال مدة محددة. تفاصيل القرار ومدته ونطاقه يجب أن تُقرأ من المصدر الرسمي مباشرة.

## ماذا يغيّر عملياً؟

- عند تجديد عقد يخضع للقرار، لا يُقترح رفع الإيجار.
- طلب التخفيض يبقى ممكناً، ويحسن أن يُسجَّل بوضوح.
- تذكيرات المكتب والمالك تتغير: لا معنى لتذكير بطلب زيادة لا تسري.

## كيف يتعامل معه عقدي؟

يعرض التطبيق تنبيهاً عندما يرى أن العقد داخل نطاق القاعدة، ويمنع اقتراح زيادة في التجديد. القاعدة مضبوطة في ملف واحد وتحتاج مراجعتك من المصدر الرسمي.

## تنبيه

لا تعتمد على هذا المقال وحده. هو معلومات عامة وليس استشارة قانونية.`,
  },
];

const SETTINGS = [
  { key: 'site_name', value: 'عقدي' },
  { key: 'default_currency', value: 'SAR' },
  { key: 'vat_percent', value: '15' },
  { key: 'trial_days', value: '30' },
  { key: 'invite_valid_days', value: '30' },
  { key: 'reminder_send_hour_riyadh', value: '9' },
  { key: 'support_phone', value: '' },
  { key: 'support_email', value: '' },
  { key: 'maintenance_mode', value: '0' },
];

async function seed(pool) {
  const counts = { plans: 0, templates: 0, settings: 0 };

  for (const plan of PLANS) {
    const [result] = await pool.query(
      `INSERT IGNORE INTO plans
         (code, name_ar, price_monthly, price_yearly, currency, max_contracts, max_units,
          max_members, max_ai_reads_monthly, max_photos, max_listings, features, is_active, sort_order)
       VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        plan.code,
        plan.name_ar,
        plan.price_monthly,
        plan.price_yearly,
        plan.max_contracts,
        plan.max_units,
        plan.max_members,
        plan.max_ai_reads_monthly,
        plan.max_photos,
        plan.max_listings,
        JSON.stringify(plan.features),
        plan.sort_order,
      ],
    );
    counts.plans += result.affectedRows;
  }

  // Platform defaults have office_id NULL, which a unique key cannot dedupe,
  // so insert only when no default exists for that code and channel.
  for (const t of TEMPLATES) {
    const [result] = await pool.query(
      `INSERT INTO message_templates (office_id, code, channel, body_ar)
       SELECT NULL, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (
         SELECT 1 FROM message_templates
         WHERE office_id IS NULL AND code = ? AND channel = ?
       )`,
      [t.code, t.channel, t.body_ar, t.code, t.channel],
    );
    counts.templates += result.affectedRows;
  }

  for (const s of SETTINGS) {
    const [result] = await pool.query(
      'INSERT IGNORE INTO settings (setting_key, setting_value, is_secret) VALUES (?, ?, 0)',
      [s.key, s.value],
    );
    counts.settings += result.affectedRows;
  }

  return counts;
}

/** Public site content: the draft articles and the FAQ. Idempotent; never overwrites an admin's edits. */
async function seedContent(pool) {
  const counts = { posts: 0, faqs: 0 };
  for (const post of BLOG_DRAFTS) {
    const [result] = await pool.query(
      `INSERT IGNORE INTO blog_posts (slug, title_ar, excerpt_ar, body_ar, status, needs_review, meta_description)
       VALUES (?, ?, ?, ?, 'draft', 1, ?)`,
      [post.slug, post.title_ar, post.excerpt_ar, post.body_ar, post.excerpt_ar],
    );
    counts.posts += result.affectedRows;
  }

  // The FAQ: only when the table is empty, so an admin's edits are never overwritten.
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM faqs');
  if (Number(n) === 0) {
    const { DEFAULT_FAQS } = require('../services/siteContent');
    for (const [i, [q, a]] of DEFAULT_FAQS.entries()) {
      await pool.query('INSERT INTO faqs (question_ar, answer_ar, sort_order, is_active) VALUES (?, ?, ?, 1)', [q, a, i + 1]);
      counts.faqs += 1;
    }
  }

  return counts;
}

module.exports = { seed, seedContent, PLANS, TEMPLATES, SETTINGS, BLOG_DRAFTS };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const db = require('../config/db');
  const logger = require('../utils/logger');
  (async () => {
    let ok = false;
    try {
      if (!(await db.ensureSchema()).ok) throw new Error('schema check failed');
      const counts = { ...(await seed(db.pool)), ...(await seedContent(db.pool)) };
      logger.info(
        `Seed complete: ${counts.plans} plans, ${counts.templates} templates, ${counts.settings} settings, ${counts.posts} draft posts, ${counts.faqs} FAQs added`,
      );
      ok = true;
    } catch (err) {
      logger.error(`Seed failed: ${err.code || err.message}`);
    } finally {
      await db.pool.end();
      process.exitCode = ok ? 0 : 1;
    }
  })();
}
