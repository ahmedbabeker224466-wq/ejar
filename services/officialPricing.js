'use strict';

// The approved pricing (Prompt 21) and the idempotent migration that moves
// the seeded placeholder plans to it. Prices are SAR, VAT-exclusive, per office.
//
// Rules of the migration (applyOfficialPricing, run by ensureSchema and the seed):
// - Only the four plan rows trial / basic / pro / enterprise are touched, by code.
//   A missing row is not created here (database/seed.js creates them).
// - Prices, limits and feature switches change only while they still hold the
//   OLD placeholder value; anything an admin edited in /admin/plans is kept.
// - The new descriptive columns (custom_domain, audit_level, support_level) and
//   the "published" switches (is_active, is_public for paid plans) are set once
//   per plan; settings 'plans.official_pricing_v1.<code>' records that, so a
//   later admin change is never reverted.
// - offices.plan_id is never changed.
// - The custom-domain add-on is stored as data (settings 'addons.custom_domain'),
//   inserted once. No billing and no domain logic exist for it yet.

const MARKER = 'plans.official_pricing_v1.';
const ADDON_KEY = 'addons.custom_domain';

const ALL_ON = Object.freeze({ whatsapp: true, telegram: true, reports_csv: true, ai_reading: true, listings: true });

// Columns compared against the placeholders. max_contracts is not a separate
// limit in the approved table: NULL (one running contract per unit, so the unit
// limit bounds it). max_photos (maintenance photos) is not in the table either:
// kept, except the trial, which gets the Pro value ("limits equal to Pro").
const MANAGED = ['price_monthly', 'price_yearly', 'max_contracts', 'max_units', 'max_members', 'max_ai_reads_monthly', 'max_photos', 'max_listings', 'features'];

// The values the earlier seed wrote (database/seed.js before Prompt 21).
const PLACEHOLDERS = Object.freeze({
  trial: { price_monthly: 0, price_yearly: 0, max_contracts: 20, max_units: 20, max_members: 2, max_ai_reads_monthly: 10, max_photos: 30, max_listings: 3, features: ALL_ON },
  basic: {
    price_monthly: 99, price_yearly: 990, max_contracts: 100, max_units: 100, max_members: 3, max_ai_reads_monthly: 100, max_photos: 200, max_listings: 10,
    features: { whatsapp: false, telegram: false, reports_csv: true, ai_reading: true, listings: true },
  },
  pro: { price_monthly: 249, price_yearly: 2490, max_contracts: 500, max_units: 500, max_members: 10, max_ai_reads_monthly: 500, max_photos: 1000, max_listings: 50, features: ALL_ON },
  enterprise: { price_monthly: 599, price_yearly: 5990, max_contracts: null, max_units: null, max_members: null, max_ai_reads_monthly: 2000, max_photos: null, max_listings: null, features: ALL_ON },
});

const OFFICIAL = Object.freeze({
  trial: {
    name_ar: 'تجربة مجانية', price_monthly: 0, price_yearly: 0,
    max_contracts: null, max_units: 150, max_members: 6, max_ai_reads_monthly: 100, max_photos: 1000, max_listings: 50,
    features: ALL_ON, custom_domain: 'none', audit_level: 'full', support_level: 'email', sort_order: 1,
  },
  basic: {
    name_ar: 'الأساسية', price_monthly: 149, price_yearly: 1490,
    max_contracts: null, max_units: 30, max_members: 2, max_ai_reads_monthly: 20, max_photos: 200, max_listings: 10,
    features: { whatsapp: false, telegram: true, reports_csv: true, ai_reading: true, listings: true },
    custom_domain: 'none', audit_level: 'basic', support_level: 'email', sort_order: 2,
  },
  pro: {
    name_ar: 'الاحترافية', price_monthly: 349, price_yearly: 3490,
    max_contracts: null, max_units: 150, max_members: 6, max_ai_reads_monthly: 100, max_photos: 1000, max_listings: 50,
    features: ALL_ON, custom_domain: 'addon', audit_level: 'full', support_level: 'email_whatsapp', sort_order: 3,
  },
  enterprise: {
    name_ar: 'المؤسسات', price_monthly: 799, price_yearly: 7990,
    max_contracts: null, max_units: 600, max_members: 20, max_ai_reads_monthly: 400, max_photos: null, max_listings: 200,
    features: ALL_ON, custom_domain: 'included', audit_level: 'full', support_level: 'priority', sort_order: 4,
  },
});

// Above the largest plan: no price, contact form only (not a plan row).
const CUSTOM_PLAN_FROM_UNITS = 600;

const CUSTOM_DOMAIN_ADDON = Object.freeze({ name_ar: 'نطاق مخصص', price_monthly: '49.00', currency: 'SAR', plans: ['pro'] });

// The limits every active plan must carry (launch check "الباقات والأسعار").
const REQUIRED_LIMITS = ['max_units', 'max_members', 'max_ai_reads_monthly', 'max_listings'];

function parseFeatures(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function sameValue(column, current, old) {
  if (column === 'features') {
    const now = parseFeatures(current);
    if (!now) return false;
    return Object.keys(old).every((k) => (now[k] !== false) === old[k]) && Object.keys(now).every((k) => Object.hasOwn(old, k));
  }
  if (old === null) return current === null || current === undefined;
  if (current === null || current === undefined) return false;
  return Number(current) === Number(old);
}

/**
 * Pure: the column changes for one plan row. firstTime = the one-time part has
 * not run for this plan yet. Returns an object of column -> new value (empty
 * when nothing changes).
 */
function planUpdates(code, row, { firstTime }) {
  const official = OFFICIAL[code];
  const old = PLACEHOLDERS[code];
  if (!official || !row) return {};
  const changes = {};
  for (const column of MANAGED) {
    if (sameValue(column, row[column], old[column]) && !sameValue(column, row[column], official[column])) {
      changes[column] = official[column];
    }
  }
  if (firstTime) {
    for (const column of ['custom_domain', 'audit_level', 'support_level']) {
      if (row[column] !== official[column]) changes[column] = official[column];
    }
    if (Number(row.is_active) !== 1) changes.is_active = 1;
    if (code !== 'trial' && Number(row.is_public) !== 1) changes.is_public = 1;
  }
  return changes;
}

function toSql(column, value) {
  if (column === 'features') return JSON.stringify(value);
  if (column === 'price_monthly' || column === 'price_yearly') return Number(value).toFixed(2);
  return value;
}

/** Applies the approved pricing. Idempotent. Returns { updated: [codes], addon: boolean }. */
async function applyOfficialPricing(pool) {
  const codes = Object.keys(OFFICIAL);
  const [rows] = await pool.query(
    `SELECT id, code, price_monthly, price_yearly, max_contracts, max_units, max_members, max_ai_reads_monthly, max_photos, max_listings,
            features, custom_domain, audit_level, support_level, is_active, is_public
       FROM plans WHERE code IN (?)`,
    [codes],
  );
  const [marks] = await pool.query('SELECT setting_key FROM settings WHERE setting_key IN (?)', [codes.map((c) => MARKER + c)]);
  const done = new Set(marks.map((m) => m.setting_key));
  const updated = [];
  for (const row of rows) {
    const firstTime = !done.has(MARKER + row.code);
    const changes = planUpdates(row.code, row, { firstTime });
    const columns = Object.keys(changes);
    if (columns.length) {
      await pool.query(
        `UPDATE plans SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((c) => toSql(c, changes[c])), row.id],
      );
      updated.push(row.code);
    }
    if (firstTime) {
      await pool.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [MARKER + row.code, new Date().toISOString()]);
    }
  }
  const [addon] = await pool.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', [ADDON_KEY, JSON.stringify(CUSTOM_DOMAIN_ADDON)]);
  return { updated, addon: addon.affectedRows === 1 };
}

/** The custom-domain add-on as stored (an admin may have changed the row), or the default. */
async function customDomainAddon(pool) {
  const [[row]] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [ADDON_KEY]);
  const stored = row ? parseFeatures(row.setting_value) : null;
  return { ...CUSTOM_DOMAIN_ADDON, ...(stored || {}) };
}

/**
 * Pure: problems of the active plans for the launch check, in Arabic:
 * a non-trial plan priced 0 (monthly or yearly), a required limit missing, or
 * no paid plan at all.
 */
function planProblems(plans) {
  const problems = [];
  const active = plans.filter((p) => Number(p.is_active) === 1);
  const paid = active.filter((p) => p.code !== 'trial');
  if (!paid.some((p) => Number(p.price_monthly) > 0 && Number(p.is_public) === 1)) problems.push('لا توجد باقة مدفوعة منشورة.');
  for (const p of paid) {
    if (!(Number(p.price_monthly) > 0) || !(Number(p.price_yearly) > 0)) problems.push(`الباقة ${p.code} سعرها صفر.`);
  }
  for (const p of active) {
    const missing = REQUIRED_LIMITS.filter((k) => p[k] === null || p[k] === undefined);
    if (missing.length) problems.push(`الباقة ${p.code} ينقصها حد: ${missing.join('، ')}.`);
  }
  return problems;
}

// ------------------------------------------------------------ public pricing cards

const SUPPORT_LABELS = Object.freeze({ email: 'الدعم: البريد الإلكتروني', email_whatsapp: 'الدعم: البريد الإلكتروني وواتساب', priority: 'دعم بأولوية' });
const AUDIT_LABELS = Object.freeze({ basic: 'سجل العمليات: أساسي', full: 'سجل العمليات والتقارير: كامل' });

// "label: up to N" reads correctly in Arabic for any number (no noun agreement).
const upTo = (label, n, suffix = '') => `${label}: ${n === null || n === undefined ? 'بلا حد' : `حتى ${Number(n).toLocaleString('en-US')}${suffix}`}`;

/**
 * Pure: the lines of one public pricing card. plan = a plans row; addon = the
 * custom-domain add-on; fmt formats halalas. Only what the row says, no claims.
 */
function cardLines(plan, addon, fmt) {
  const f = {};
  const raw = parseFeatures(plan.features) || {};
  for (const k of Object.keys(ALL_ON)) f[k] = raw[k] !== false;
  const channels = ['الموقع', 'البريد الإلكتروني', ...(f.telegram ? ['تيليجرام'] : []), ...(f.whatsapp ? ['واتساب'] : [])];
  const addonHere = plan.custom_domain === 'addon' && addon && Array.isArray(addon.plans) && addon.plans.includes(plan.code);
  const domain = plan.custom_domain === 'included' ? 'نطاق مخصص واحد مشمول (قريباً)'
    : addonHere ? `النطاق المخصص: إضافة اختيارية بـ ${fmt(Math.round(Number(addon.price_monthly) * 100))} ريال شهرياً (قريباً)`
      : 'النطاق المخصص: غير متاح';
  return [
    upTo('الوحدات', plan.max_units),
    upTo('أعضاء الفريق مع المالك', plan.max_members),
    upTo('قراءة العقود بالذكاء الاصطناعي', plan.max_ai_reads_monthly, ' شهرياً'),
    upTo('الإعلانات العامة المنشورة', plan.max_listings),
    `التذكيرات: ${channels.join(' + ')}`,
    'رابط عام لصفحة مكتبك',
    domain,
    AUDIT_LABELS[plan.audit_level] || AUDIT_LABELS.full,
    SUPPORT_LABELS[plan.support_level] || SUPPORT_LABELS.email,
  ];
}

/** Pure: how many months the yearly price equals (10 for 1490 / 149), or null when not a whole number below 12. */
function paidMonths(monthlyHalalas, yearlyHalalas) {
  if (!(monthlyHalalas > 0) || !(yearlyHalalas > 0) || yearlyHalalas % monthlyHalalas !== 0) return null;
  const months = yearlyHalalas / monthlyHalalas;
  return months < 12 ? months : null;
}

module.exports = {
  cardLines,
  paidMonths,
  OFFICIAL,
  PLACEHOLDERS,
  CUSTOM_DOMAIN_ADDON,
  CUSTOM_PLAN_FROM_UNITS,
  REQUIRED_LIMITS,
  ADDON_KEY,
  MARKER,
  planUpdates,
  applyOfficialPricing,
  customDomainAddon,
  planProblems,
};
