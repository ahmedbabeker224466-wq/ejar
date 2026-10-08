'use strict';

// Launch readiness: one list of checks that tell the platform admin whether the
// platform is safe to open to real users. Each check is
// { id, status: 'pass' | 'warn' | 'fail', titleAr, detailAr } and may carry
// `confirm` (the key of a manual confirmation form) and `record` (when it was
// confirmed). Nothing here ever returns, shows or logs a secret VALUE: the
// answers are only "present", "looks strong", "set" or a count.
//
// Things the app cannot see (a password it was never given, a lawyer's review,
// a restore drill) are confirmed by hand on /admin/launch and stored in the
// settings table as launch.<key> = JSON { on, at, note, source, by }.

const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const logger = require('../utils/logger');
const dates = require('./contractDates');
const RULES = require('../config/ejarRules');
const platformSettings = require('./platformSettings');
const email = require('./channels/email');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SETTING_PREFIX = 'launch.';

// ------------------------------------------------------------ manual confirmations

/**
 * The confirmations an admin can record. `fields`: on = a date (Riyadh, not in the
 * future, default today); note / source = text with a minimum length.
 */
const CONFIRMS = Object.freeze({
  secrets_rotated: { button: 'أكدت تغيير الأسرار', fields: [], help: 'أكّد أنك غيّرت JWT_SECRET وSECRET_BOX_KEY وCRON_SECRET إلى قيم جديدة خاصة بالإنتاج.' },
  db_password_rotated: { button: 'أكدت تغيير كلمة مرور قاعدة البيانات', fields: [], help: 'لا يستطيع التطبيق قراءة كلمة المرور؛ نسجّل تأكيدك وتاريخه فقط.' },
  admin_backup_codes: { button: 'أكدت إعادة توليد رموز النسخ الاحتياطي', fields: [], help: 'أعد توليد رموز المصادقة الثنائية الاحتياطية لكل مدير منصة واحفظها خارج الخادم.' },
  restore_drill: { button: 'سجّل تمرين الاستعادة', fields: ['on', 'note'], noteMin: 3, noteLabel: 'ملاحظة (مثلاً: استعدنا نسخة الأمس في قاعدة تجريبية وتطابقت الأعداد)', help: 'نفّذ خطوات الاستعادة في DEPLOY.md ثم سجّلها هنا.' },
  ejar_rules: { button: 'سجّل التحقق من قواعد إيجار', fields: ['on', 'source'], sourceMin: 10, sourceLabel: 'المصدر الرسمي (رابط أو اسم المستند ورقمه، 10 أحرف على الأقل)', help: 'قارن القيم أدناه بالمصدر الرسمي لإيجار/الهيئة العامة للعقار. لا تُعدَّل القواعد من هنا.' },
  legal_review: { button: 'أكدت مراجعة المحامي', fields: ['on', 'note'], noteMin: 3, noteLabel: 'اسم المراجع أو ملاحظته', help: 'عند التأكيد يختفي تنبيه «يراجعها محامٍ قبل الإطلاق» من صفحات الخصوصية والشروط وإخلاء المسؤولية.' },
  npm_audit: { button: 'سجّل نتيجة npm audit', fields: ['on', 'note'], noteMin: 0, noteLabel: 'النتيجة (اختياري)', help: 'شغّل `npm audit --omit=dev` على جهازك قبل الإطلاق ثم سجّل التاريخ.' },
});

const MAX_NOTE = 300;

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validates a confirmation form. Returns { ok: true, record } or { ok: false, error } (Arabic). */
function validateConfirm(key, body = {}, now = new Date()) {
  const spec = Object.hasOwn(CONFIRMS, key) ? CONFIRMS[key] : null;
  if (!spec) return { ok: false, error: 'تأكيد غير معروف.' };
  const record = {};
  const today = dates.riyadhDate(now);
  if (spec.fields.includes('on')) {
    const on = clean(body.on, 10) || today;
    if (!dates.isValidYmd(on)) return { ok: false, error: 'التاريخ غير صحيح.' };
    if (dates.compareYmd(on, today) > 0) return { ok: false, error: 'التاريخ لا يمكن أن يكون في المستقبل.' };
    record.on = on;
  } else {
    record.on = today;
  }
  if (spec.fields.includes('note')) {
    const note = clean(body.note, MAX_NOTE);
    if (note.length < (spec.noteMin || 0)) return { ok: false, error: 'اكتب الملاحظة (3 أحرف على الأقل).' };
    if (note) record.note = note;
  }
  if (spec.fields.includes('source')) {
    const source = clean(body.source, MAX_NOTE);
    if (source.length < spec.sourceMin) return { ok: false, error: 'اكتب المصدر الرسمي (10 أحرف على الأقل).' };
    record.source = source;
  }
  return { ok: true, record };
}

async function loadRecords(pool) {
  const [rows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'launch.%'");
  const out = {};
  for (const r of rows) {
    try {
      out[r.setting_key.slice(SETTING_PREFIX.length)] = JSON.parse(r.setting_value);
    } catch {
      // an unreadable record counts as not confirmed
    }
  }
  return out;
}

/** Stores a confirmation (the caller has validated it). */
async function saveRecord(pool, key, record, { userId, now = new Date() }) {
  const value = JSON.stringify({ ...record, at: now.toISOString(), by: Number(userId) || null });
  await pool.query(
    'INSERT INTO settings (setting_key, setting_value, is_secret) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [`${SETTING_PREFIX}${key}`, value],
  );
  platformSettings.invalidate();
  if (key === 'legal_review') platformSettings.setLegalReviewed(true);
}

/** Result of the last "send test email": { at, ok, error? }. Never the address. */
async function saveSmtpTest(pool, result, now = new Date()) {
  const record = { at: now.toISOString(), ok: Boolean(result.ok) };
  if (!result.ok) record.error = String(result.error || 'error').slice(0, 40);
  await pool.query(
    "INSERT INTO settings (setting_key, setting_value, is_secret) VALUES ('launch.smtp_test', ?, 0) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
    [JSON.stringify(record)],
  );
  return record;
}

// ------------------------------------------------------------ secret strength (never returns the value)

const COMMON = ['changeme', 'change-me', 'change_me', 'password', 'passw0rd', 'secret', 'example', 'default', 'qwerty', 'letmein', '123456', 'admin', 'test-', 'your-', 'xxxxxx', 'aaaaaa'];

function entropyBits(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

const isPeriodic = (s) => {
  for (let p = 1; p <= Math.floor(s.length / 2); p += 1) if (s.slice(p) === s.slice(0, s.length - p)) return true;
  return false;
};

/**
 * 'ok' or why not: missing | format | short | repeated | low_variety | common.
 * hex64: SECRET_BOX_KEY must be exactly 64 hex characters.
 */
function secretProblem(value, { hex64 = false } = {}) {
  const v = typeof value === 'string' ? value : '';
  if (!v.trim()) return 'missing';
  if (hex64) {
    if (!/^[0-9a-fA-F]{64}$/.test(v)) return 'format';
  } else if (v.length < 32) return 'short';
  if (isPeriodic(v)) return 'repeated';
  const lower = v.toLowerCase();
  if (COMMON.some((word) => lower.includes(word))) return 'common';
  if (new Set(lower).size < (hex64 ? 8 : 10) || entropyBits(lower) < (hex64 ? 3 : 3.2)) return 'low_variety';
  return 'ok';
}

const PROBLEM_AR = {
  missing: 'غير مضبوط',
  format: 'الصيغة غير صحيحة (يجب 64 خانة سداسية عشرية)',
  short: 'قصير (أقل من 32 حرفاً)',
  repeated: 'نمط متكرر',
  low_variety: 'قليل التنوع (سهل التخمين)',
  common: 'يحتوي كلمة شائعة أو قيمة افتراضية',
};

// ------------------------------------------------------------ the checks

const result = (id, status, titleAr, detailAr, extra = {}) => ({ id, status, titleAr, detailAr, ...extra });
const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

function dirProblem(dir, label, exists = fs.existsSync, access = fs.accessSync) {
  const resolved = path.resolve(dir);
  if (resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep)) return { status: FAIL, detail: `مجلد ${label} داخل المجلد العام public، وهذا يكشف الملفات.` };
  if (!exists(resolved)) return { status: WARN, detail: `مجلد ${label} غير موجود بعد (يُنشأ عند أول استخدام). أنشئه بنفسك وتأكد من الصلاحيات.` };
  try {
    access(resolved, fs.constants.W_OK);
  } catch {
    return { status: FAIL, detail: `مجلد ${label} غير قابل للكتابة من التطبيق.` };
  }
  return { status: PASS, detail: `مجلد ${label} خارج المجلد العام وقابل للكتابة.` };
}

/**
 * Runs every check. ctx: { pool, env, now, host (request host or null), hsts (the
 * Strict-Transport-Security header of the response or null), fsApi (tests) }.
 */
async function runChecks({ pool = db.pool, env = process.env, now = new Date(), host = null, hsts = null, fsApi = {} } = {}) {
  const records = await loadRecords(pool);
  const out = [];
  const production = env.NODE_ENV === 'production';
  const recordLine = (r) => (r && r.on ? `سُجّل بتاريخ ${r.on}.` : '');

  // 1. NODE_ENV
  out.push(production
    ? result('node_env', PASS, 'وضع التشغيل', 'التطبيق يعمل في وضع الإنتاج.')
    : result('node_env', WARN, 'وضع التشغيل', 'التطبيق ليس في وضع الإنتاج (NODE_ENV). اضبطه على production قبل الإطلاق.'));

  // 2. SMS
  const provider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  const smsConfigured = provider === 'unifonic' ? Boolean(env.SMS_API_KEY && env.SMS_SENDER)
    : provider === 'msegat' ? Boolean(env.SMS_API_KEY && env.SMS_SENDER && env.SMS_USERNAME) : false;
  if (provider === 'unifonic' || provider === 'msegat') {
    out.push(smsConfigured
      ? result('sms_provider', PASS, 'مزوّد الرسائل القصيرة', 'مزوّد حقيقي مضبوط بمفاتيحه.')
      : result('sms_provider', FAIL, 'مزوّد الرسائل القصيرة', 'المزوّد محدد لكن مفاتيحه أو اسم المرسل ناقصة، ولن تصل رموز الدخول.'));
  } else if (provider === 'console') {
    out.push(result('sms_provider', production ? FAIL : WARN, 'مزوّد الرسائل القصيرة', 'مزوّد «console» للتجربة فقط؛ التطبيق يرفضه في الإنتاج ولن تصل رموز الدخول. اختر unifonic أو msegat.'));
  } else {
    out.push(result('sms_provider', production ? FAIL : WARN, 'مزوّد الرسائل القصيرة', 'لا يوجد مزوّد رسائل حقيقي (SMS_PROVIDER). بدونه لا يستطيع أحد تسجيل الدخول في الإنتاج.'));
  }

  // 3. secrets: strength, then the manual rotation confirmation
  const weak = [];
  for (const [name, opts] of [['JWT_SECRET', {}], ['SECRET_BOX_KEY', { hex64: true }], ['CRON_SECRET', {}]]) {
    const problem = secretProblem(env[name], opts);
    if (problem !== 'ok') weak.push(`${name}: ${PROBLEM_AR[problem]}`);
  }
  out.push(weak.length
    ? result('secrets_strength', FAIL, 'قوة الأسرار', `${weak.join('؛ ')}.`)
    : result('secrets_strength', PASS, 'قوة الأسرار', 'JWT_SECRET وSECRET_BOX_KEY وCRON_SECRET موجودة وتبدو قوية (الطول والتنوع فقط، دون عرض القيم).'));
  const rotated = records.secrets_rotated;
  out.push(rotated
    ? result('secrets_rotated', PASS, 'تغيير الأسرار قبل الإطلاق', `أكّدت تغيير الأسرار. ${recordLine(rotated)}`, { confirm: 'secrets_rotated', record: rotated })
    : result('secrets_rotated', FAIL, 'تغيير الأسرار قبل الإطلاق', 'لم تؤكد بعد أنك غيّرت الأسرار إلى قيم جديدة للإنتاج.', { confirm: 'secrets_rotated' }));

  // 4. DB password (cannot be read: a confirmation only)
  const dbRot = records.db_password_rotated;
  out.push(dbRot
    ? result('db_password_rotated', PASS, 'تغيير كلمة مرور قاعدة البيانات', `أكّدت تغييرها. ${recordLine(dbRot)}`, { confirm: 'db_password_rotated', record: dbRot })
    : result('db_password_rotated', FAIL, 'تغيير كلمة مرور قاعدة البيانات', 'لم تؤكد بعد تغيير كلمة المرور (لا يستطيع التطبيق قراءتها).', { confirm: 'db_password_rotated' }));

  // 5. admin 2FA
  const [[admins]] = await pool.query("SELECT COUNT(*) AS total, COALESCE(SUM(twofa_enabled), 0) AS enabled FROM users WHERE role = 'platform_admin' AND is_active = 1");
  const total = Number(admins.total);
  const enabled = Number(admins.enabled);
  const skip2fa = String(env.REQUIRE_ADMIN_2FA ?? '').trim().toLowerCase() === 'false';
  if (skip2fa) out.push(result('admin_2fa', FAIL, 'المصادقة الثنائية للمدير', 'REQUIRE_ADMIN_2FA مضبوط على false. احذف هذا المتغير.'));
  else if (total === 0) out.push(result('admin_2fa', FAIL, 'المصادقة الثنائية للمدير', 'لا يوجد مدير منصة نشط.'));
  else if (enabled < total) out.push(result('admin_2fa', FAIL, 'المصادقة الثنائية للمدير', `${total - enabled} من ${total} مديري المنصة لم يفعّلوا المصادقة الثنائية.`));
  else out.push(result('admin_2fa', PASS, 'المصادقة الثنائية للمدير', `كل مديري المنصة (${total}) فعّلوا المصادقة الثنائية، والمتغير غير مضبوط على false.`));
  const codes = records.admin_backup_codes;
  out.push(codes
    ? result('admin_backup_codes', PASS, 'رموز المصادقة الاحتياطية', `أكّدت إعادة توليدها. ${recordLine(codes)}`, { confirm: 'admin_backup_codes', record: codes })
    : result('admin_backup_codes', FAIL, 'رموز المصادقة الاحتياطية', 'لم تؤكد بعد إعادة توليد رموز المصادقة الاحتياطية وحفظها.', { confirm: 'admin_backup_codes' }));

  // 6. backups
  const [[lastBackup]] = await pool.query("SELECT MAX(created_at) AS at FROM backups WHERE status = 'ok'");
  if (!lastBackup.at) out.push(result('backup_recent', FAIL, 'النسخ الاحتياطي', 'لا توجد نسخة احتياطية ناجحة بعد.'));
  else if (new Date(lastBackup.at) < dates.hoursAfter(now, -36)) out.push(result('backup_recent', FAIL, 'النسخ الاحتياطي', 'آخر نسخة ناجحة أقدم من 36 ساعة.'));
  else out.push(result('backup_recent', PASS, 'النسخ الاحتياطي', 'آخر نسخة ناجحة خلال 36 ساعة.'));
  const drill = records.restore_drill;
  out.push(drill
    ? result('restore_drill', PASS, 'تمرين الاستعادة', `سُجّل تمرين استعادة بتاريخ ${drill.on}.`, { confirm: 'restore_drill', record: drill })
    : result('restore_drill', FAIL, 'تمرين الاستعادة', 'لم يُسجَّل أي تمرين استعادة. جرّب الاستعادة في قاعدة تجريبية (DEPLOY.md) ثم سجّلها.', { confirm: 'restore_drill' }));
  let backupDirPath = null;
  try {
    backupDirPath = require('./backup').backupDir(env);
  } catch {
    backupDirPath = null;
  }
  const bd = backupDirPath ? dirProblem(backupDirPath, 'النسخ الاحتياطي', fsApi.exists, fsApi.access) : { status: FAIL, detail: 'مجلد النسخ الاحتياطي داخل المجلد العام public.' };
  out.push(result('backup_dir', bd.status, 'مجلد النسخ الاحتياطي', bd.detail));

  // 7. seller details
  const seller = await platformSettings.seller(pool);
  const missingSeller = [];
  if (!seller.legal_name) missingSeller.push('الاسم النظامي');
  if (!seller.address) missingSeller.push('العنوان');
  if (missingSeller.length) out.push(result('seller_details', FAIL, 'بيانات الجهة البائعة', `ينقص: ${missingSeller.join('، ')}. أكملها من إعدادات المنصة.`));
  else if (!seller.vat_number) out.push(result('seller_details', WARN, 'بيانات الجهة البائعة', 'الاسم والعنوان موجودان. الرقم الضريبي فارغ، لذلك تبقى المستندات «إيصال دفع» وليست فاتورة ضريبية مبسطة.'));
  else out.push(result('seller_details', PASS, 'بيانات الجهة البائعة', 'الاسم والعنوان والرقم الضريبي مضبوطة.'));

  // 8. Ejar rules verification (the rules themselves are never changed here)
  const fromConfig = RULES.verifiedAt && RULES.verifiedSource && String(RULES.verifiedSource).trim().length >= 10 ? { on: RULES.verifiedAt, source: RULES.verifiedSource } : null;
  const ejar = records.ejar_rules || fromConfig;
  out.push(ejar
    ? result('ejar_rules', PASS, 'التحقق من قواعد إيجار', `تم التحقق بتاريخ ${ejar.on}. المصدر: ${ejar.source}`, { confirm: 'ejar_rules', record: ejar })
    : result('ejar_rules', FAIL, 'التحقق من قواعد إيجار', 'لم يُسجَّل التحقق من القواعد (مهلة الإشعار، التجديد التلقائي، تجميد الرياض، حدود المراحل) مقابل المصدر الرسمي.', { confirm: 'ejar_rules' }));

  // 9. legal pages
  const legal = records.legal_review;
  out.push(legal
    ? result('legal_review', PASS, 'مراجعة الصفحات القانونية', `أكّدت مراجعة المحامي بتاريخ ${legal.on}. ${legal.note || ''}`.trim(), { confirm: 'legal_review', record: legal })
    : result('legal_review', FAIL, 'مراجعة الصفحات القانونية', 'لم تؤكد مراجعة المحامي للخصوصية والشروط وإخلاء المسؤولية؛ ما زال تنبيه «يراجعها محامٍ قبل الإطلاق» ظاهراً للزوار.', { confirm: 'legal_review' }));

  // 10. SMTP + test email
  const smtp = email.smtpConfig(env);
  const test = records.smtp_test;
  if (!smtp) out.push(result('smtp', FAIL, 'البريد الإلكتروني', 'إعدادات SMTP غير مكتملة (SMTP_HOST وMAIL_FROM).', { smtpTest: true }));
  else if (!test) out.push(result('smtp', FAIL, 'البريد الإلكتروني', 'الإعدادات موجودة لكن لم تُرسَل رسالة تجربة بعد.', { smtpTest: true }));
  else if (!test.ok) out.push(result('smtp', FAIL, 'البريد الإلكتروني', `آخر رسالة تجربة فشلت (${test.error || 'error'}).`, { smtpTest: true, record: test }));
  else if (new Date(test.at) < dates.daysAfter(now, -7)) out.push(result('smtp', FAIL, 'البريد الإلكتروني', 'نجحت رسالة تجربة لكنها أقدم من 7 أيام. أرسل رسالة جديدة.', { smtpTest: true, record: test }));
  else out.push(result('smtp', PASS, 'البريد الإلكتروني', 'SMTP مضبوط ونجحت رسالة تجربة خلال آخر 7 أيام.', { smtpTest: true, record: test }));

  // 11. Moyasar
  const sk = env.MOYASAR_SECRET_KEY || '';
  const pk = env.MOYASAR_PUBLISHABLE_KEY || '';
  const hook = env.MOYASAR_WEBHOOK_SECRET || '';
  if (!sk && !pk) out.push(result('moyasar', WARN, 'الدفع بالبطاقة (ميسر)', 'مفاتيح ميسر غير مضبوطة: الدفع بالبطاقة متوقف والتحويل البنكي يعمل.'));
  else if (!sk || !pk) out.push(result('moyasar', FAIL, 'الدفع بالبطاقة (ميسر)', 'أحد المفتاحين فقط مضبوط. اضبط المفتاح السري والمفتاح العام معاً.'));
  else if (!hook) out.push(result('moyasar', FAIL, 'الدفع بالبطاقة (ميسر)', 'سر الويب هوك (MOYASAR_WEBHOOK_SECRET) غير مضبوط.'));
  else if (production && (/^sk_test_/.test(sk) || /^pk_test_/.test(pk))) out.push(result('moyasar', WARN, 'الدفع بالبطاقة (ميسر)', 'المفاتيح تجريبية (test) بينما التطبيق في الإنتاج: لن تُحصَّل مدفوعات حقيقية.'));
  else out.push(result('moyasar', PASS, 'الدفع بالبطاقة (ميسر)', 'المفتاحان وسر الويب هوك مضبوطة.'));

  // 12. APP_URL, cookies, HSTS
  let appHost = null;
  let https = false;
  try {
    const u = new URL(env.APP_URL || '');
    appHost = u.host;
    https = u.protocol === 'https:';
  } catch {
    appHost = null;
  }
  if (!appHost) out.push(result('app_url', FAIL, 'عنوان الموقع وملفات الارتباط', 'APP_URL غير مضبوط أو غير صحيح.'));
  else if (!https) out.push(result('app_url', FAIL, 'عنوان الموقع وملفات الارتباط', 'APP_URL ليس https.'));
  else if (host && host.toLowerCase() !== appHost.toLowerCase()) out.push(result('app_url', FAIL, 'عنوان الموقع وملفات الارتباط', 'APP_URL لا يطابق النطاق الذي تفتح منه هذه الصفحة.'));
  else if (!production) out.push(result('app_url', WARN, 'عنوان الموقع وملفات الارتباط', 'APP_URL صحيح، لكن ملفات الارتباط لا تكون Secure إلا في وضع الإنتاج.'));
  else if (!hsts) out.push(result('app_url', WARN, 'عنوان الموقع وملفات الارتباط', 'APP_URL صحيح وملفات الارتباط Secure، لكن ترويسة HSTS غير ظاهرة في هذه الاستجابة.'));
  else out.push(result('app_url', PASS, 'عنوان الموقع وملفات الارتباط', 'APP_URL بصيغة https ويطابق النطاق، وملفات الارتباط Secure، وترويسة HSTS موجودة.'));

  // 13. cron heartbeat and deliveries
  const [[beat]] = await pool.query("SELECT MAX(started_at) AS at FROM cron_runs WHERE job_name IN ('deliver', 'purge_auth') AND status = 'ok'");
  const [[stuck]] = await pool.query("SELECT COUNT(*) AS n FROM delivery_log WHERE status = 'pending' AND next_retry_at < ?", [dates.hoursAfter(now, -1)]);
  const [[failedDay]] = await pool.query("SELECT COUNT(*) AS n FROM delivery_log WHERE status = 'failed' AND updated_at >= ?", [dates.daysAfter(now, -1)]);
  if (!beat.at || new Date(beat.at) < dates.hoursAfter(now, -20 / 60)) out.push(result('cron_heartbeat', FAIL, 'المهام المجدولة', 'لم تعمل المهام المتكررة خلال آخر 20 دقيقة. تأكد من cron أو من RUN_CRON.'));
  else if (Number(stuck.n) > 0) out.push(result('cron_heartbeat', FAIL, 'المهام المجدولة', `المهام تعمل، لكن ${Number(stuck.n)} رسالة معلّقة منذ أكثر من ساعة.`));
  else if (Number(failedDay.n) > 0) out.push(result('cron_heartbeat', WARN, 'المهام المجدولة', `المهام تعمل، وفشل إرسال ${Number(failedDay.n)} رسالة خلال آخر 24 ساعة.`));
  else out.push(result('cron_heartbeat', PASS, 'المهام المجدولة', 'المهام تعمل (آخر تشغيل خلال 20 دقيقة) ولا رسائل عالقة.'));

  // 14. uploads dir
  let uploadsPath;
  try {
    uploadsPath = require('./images').uploadDir(env);
  } catch {
    uploadsPath = null;
  }
  const ud = uploadsPath ? dirProblem(uploadsPath, 'الصور المرفوعة', fsApi.exists, fsApi.access) : { status: FAIL, detail: 'UPLOAD_DIR داخل المجلد العام public.' };
  out.push(result('uploads_dir', ud.status, 'مجلد الصور المرفوعة', ud.detail));

  // 15. npm audit (cannot run here: the date of the last recorded run)
  const audit = records.npm_audit;
  if (!audit) out.push(result('npm_audit', FAIL, 'فحص npm audit', 'لم يُسجَّل أي فحص. شغّل `npm audit --omit=dev` ثم سجّل التاريخ.', { confirm: 'npm_audit' }));
  else if (dates.compareYmd(audit.on, dates.riyadhDate(dates.daysAfter(now, -30))) < 0) out.push(result('npm_audit', WARN, 'فحص npm audit', `آخر فحص مسجّل بتاريخ ${audit.on} (أقدم من 30 يوماً). أعد الفحص.`, { confirm: 'npm_audit', record: audit }));
  else out.push(result('npm_audit', PASS, 'فحص npm audit', `آخر فحص مسجّل بتاريخ ${audit.on}.${audit.note ? ` ${audit.note}` : ''}`, { confirm: 'npm_audit', record: audit }));

  return out;
}

function summarize(checks) {
  const count = (s) => checks.filter((c) => c.status === s).length;
  const fail = count(FAIL);
  return { pass: count(PASS), warn: count(WARN), fail, ready: fail === 0 };
}

/** The Ejar rules as shown next to the verification form (values from config/ejarRules.js only). */
function ruleSummary() {
  const f = RULES.RIYADH_RENT_FREEZE;
  return [
    { label: 'مهلة إشعار عدم التجديد (أيام قبل نهاية العقد)', value: RULES.NON_RENEWAL_NOTICE_DAYS },
    { label: 'مهلة طلب تغيير الإيجار (أيام قبل نهاية العقد)', value: RULES.RENT_CHANGE_NOTICE_DAYS },
    { label: 'التجديد التلقائي افتراضياً', value: RULES.AUTO_RENEW_DEFAULT ? 'نعم' : 'لا' },
    { label: 'تجميد رفع الإيجار في الرياض', value: `من ${f.from} لمدة ${f.years} سنوات`, highlight: true },
    { label: 'مرحلة «قريب» (أيام)', value: RULES.STAGE_THRESHOLDS.soonDays },
    { label: 'مرحلة «عاجل» (أيام)', value: RULES.STAGE_THRESHOLDS.urgentDays },
  ];
}

/** Production start-up note: which checks fail, by id only. Never throws. */
async function logStartupGuard({ pool = db.pool, env = process.env } = {}) {
  if (env.NODE_ENV !== 'production') return null;
  try {
    const checks = await runChecks({ pool, env });
    const failing = checks.filter((c) => c.status === FAIL).map((c) => c.id);
    if (failing.length) logger.warn(`Launch readiness: ${failing.length} checks fail (${failing.join(', ')}). Open /admin/launch before real users arrive.`);
    else logger.info('Launch readiness: no failing checks.');
    return failing;
  } catch (err) {
    logger.error(`Launch readiness check failed: ${err.code || err.name}`);
    return null;
  }
}

module.exports = { CONFIRMS, validateConfirm, loadRecords, saveRecord, saveSmtpTest, secretProblem, runChecks, summarize, ruleSummary, logStartupGuard, dirProblem };
