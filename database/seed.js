'use strict';

// Default rows: plans, platform message templates and settings.
// Idempotent: existing rows are never changed, so running it twice (or after an
// admin edits a price or a template) changes nothing.
//
//   node database/seed.js

// Feature switches of a plan (see services/plans.js FEATURE_FLAGS). The trial
// has everything on so a new office can try it all.
const ALL_FEATURES = { whatsapp: true, telegram: true, reports_csv: true, ai_reading: true };

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
    features: { whatsapp: false, telegram: false, reports_csv: true, ai_reading: true },
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
          max_members, max_ai_reads_monthly, max_photos, features, is_active, sort_order)
       VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, ?, ?, 1, ?)`,
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

module.exports = { seed, PLANS, TEMPLATES, SETTINGS };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const db = require('../config/db');
  const logger = require('../utils/logger');
  (async () => {
    let ok = false;
    try {
      if (!(await db.ensureSchema()).ok) throw new Error('schema check failed');
      const counts = await seed(db.pool);
      logger.info(
        `Seed complete: ${counts.plans} plans, ${counts.templates} templates, ${counts.settings} settings added`,
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
