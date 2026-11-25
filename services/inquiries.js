'use strict';

// Inquiries from the public listing page, the abuse reports and the platform
// contact form. The visitor's details are their own; they are kept for the
// office only, never shown publicly, and deleted after INQUIRY_KEEP_DAYS.

const rules = require('../config/listings');
const { scopeToOffice } = require('./scopeToOffice');
const { createNotification } = require('./notifications');
const { cleanText, hasLink } = require('./publicText');
const { normalizeSaudi, toWesternDigits } = require('../utils/phone');
const { daysAfter, riyadhDate, addDays, weekdayOf, isValidYmd, compareYmd } = require('./contractDates');

const REPORT_REASONS = { spam: 'إعلان مزعج أو مكرر', wrong_info: 'معلومات غير صحيحة', fake: 'إعلان وهمي', other: 'سبب آخر' };
const INQUIRY_STATUSES = { new: 'جديد', contacted: 'تم التواصل', closed: 'مغلق' };

/** A phone typed by a visitor: a Saudi mobile in canonical form, or 7-15 digits (international). Returns null when invalid. */
function cleanPhone(input) {
  const text = toWesternDigits(String(input ?? '')).trim();
  if (!text) return '';
  const saudi = normalizeSaudi(text);
  if (saudi) return saudi;
  const compact = text.replace(/[\s\-().]/g, '');
  return /^\+?\d{7,15}$/.test(compact) ? compact.replace(/^\+/, '') : null;
}

function cleanEmail(input) {
  const email = String(input ?? '').trim().toLowerCase();
  if (!email) return '';
  return email.length <= 190 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email) ? email : null;
}

/**
 * Checks a public contact form (listing inquiry or platform contact).
 * `website` is the honeypot: a real visitor never fills it. Returns
 * { values, errors, bot } where bot is true when the honeypot was filled.
 */
function validateContact(body = {}, { messageMax, messageRequired = false } = {}) {
  const errors = {};
  const values = {};
  const bot = String(body.website ?? '').trim() !== '';

  values.name = cleanText(body.name, 60);
  if (hasLink(values.name)) errors.name = 'اكتب اسماً أو لقباً بدون روابط.';

  const phone = cleanPhone(body.phone);
  const email = cleanEmail(body.email);
  if (phone === null) errors.phone = 'رقم الجوال غير صحيح.';
  if (email === null) errors.email = 'البريد الإلكتروني غير صحيح.';
  values.phone = phone || null;
  values.email = email || null;
  if (!errors.phone && !errors.email && !values.phone && !values.email) errors.contact = 'اكتب رقم جوالك أو بريدك الإلكتروني ليتواصل معك المكتب.';

  values.message = cleanText(body.message, messageMax + 1, { multiline: true });
  if (values.message.length > messageMax) errors.message = `الرسالة ${messageMax} حرفاً كحد أقصى.`;
  else if (messageRequired && values.message.length < 3) errors.message = 'اكتب رسالتك.';
  else if (hasLink(values.message)) errors.message = 'لا نقبل الروابط في الرسالة.';
  return { values, errors, bot };
}

// Viewing requests (owner's decision, Nov 2026): the visitor picks a day in
// the next VISIT_DAYS days (from tomorrow, Riyadh calendar) and a part of the day.
const VISIT_DAYS = 14;
const VISIT_SLOTS = { morning: 'صباحاً (9 إلى 12)', afternoon: 'ظهراً (12 إلى 4)', evening: 'مساءً (4 إلى 9)' };
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/** Pure: the days a visitor may pick, [{ value: 'YYYY-MM-DD', label: 'الخميس 26/11' }]. */
function visitDays(now = new Date()) {
  const today = riyadhDate(now);
  return Array.from({ length: VISIT_DAYS }, (_, i) => {
    const day = addDays(today, i + 1);
    return { value: day, weekday: WEEKDAYS[weekdayOf(day)], weekdayEn: WEEKDAYS_EN[weekdayOf(day)], label: `${WEEKDAYS[weekdayOf(day)]} ${Number(day.slice(8))}/${Number(day.slice(5, 7))}` };
  });
}

function validateInquiry(body = {}, now = new Date()) {
  const result = validateContact(body, { messageMax: rules.INQUIRY_MESSAGE_MAX });
  const { values, errors } = result;
  if (!errors.phone && !values.phone) {
    delete errors.contact;
    errors.phone = 'اكتب رقم جوالك ليتواصل معك المكتب ويؤكد الموعد.';
  }
  const day = String(body.visit_date ?? '').trim();
  const today = riyadhDate(now);
  if (!isValidYmd(day) || compareYmd(day, today) <= 0 || compareYmd(day, addDays(today, VISIT_DAYS)) > 0) errors.visit_date = 'اختر يوم المعاينة من القائمة.';
  else values.visit_date = day;
  const slot = String(body.visit_slot ?? '');
  if (!Object.hasOwn(VISIT_SLOTS, slot)) errors.visit_slot = 'اختر وقت المعاينة.';
  else values.visit_slot = slot;
  return result;
}

/** Active owner and managers of an office: who hears about an inquiry. */
async function recipients(pool, officeId) {
  const [rows] = await pool.query(
    "SELECT user_id FROM office_members WHERE office_id = ? AND is_active = 1 AND role IN ('office_owner','office_manager')",
    [officeId],
  );
  return rows.map((r) => Number(r.user_id));
}

/**
 * Stores an inquiry for the listing's own office (the office id comes from
 * the listing row, never from the request) and notifies its owner and
 * managers. The notification text holds no contact detail and no message.
 */
async function createInquiry(pool, { listing, values, now = new Date() }) {
  const scoped = scopeToOffice(pool, listing.officeId);
  const id = await scoped.insert('listing_inquiries', {
    listing_id: listing.id, name: values.name || null, phone: values.phone, email: values.email, message: values.message || null,
    visit_date: values.visit_date || null, visit_slot: values.visit_slot || null,
  });
  for (const userId of await recipients(pool, listing.officeId)) {
    await createNotification(pool, {
      userId, officeId: listing.officeId, kind: 'listing_inquiry', title: values.visit_date ? 'طلب معاينة جديد' : 'استفسار جديد على إعلان',
      body: values.visit_date
        ? `وصلك طلب معاينة للإعلان رقم ${listing.id} يوم ${values.visit_date} ${VISIT_SLOTS[values.visit_slot] || ''}. افتح صفحة الإعلان لتؤكد الموعد مع الزائر.`
        : `وصلك استفسار جديد على الإعلان رقم ${listing.id}. افتح صفحة الإعلان لتراه.`,
      link: `/office/listings/${listing.id}`, dedupeKey: `listing_inquiry:${id}:u${userId}`, now,
    });
  }
  return id;
}

async function inquiriesFor(pool, officeId, listingId) {
  const scoped = scopeToOffice(pool, officeId);
  return scoped.query(
    `SELECT id, name, phone, email, message, visit_date, visit_slot, status, created_at FROM listing_inquiries
      WHERE listing_id = ? AND office_id = :office_id ORDER BY id DESC LIMIT 100`,
    [listingId],
  );
}

async function setInquiryStatus(pool, { officeId, listingId, inquiryId, status }) {
  if (!Object.hasOwn(INQUIRY_STATUSES, status)) return false;
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    'UPDATE listing_inquiries SET status = ? WHERE id = ? AND listing_id = ? AND office_id = :office_id',
    [status, inquiryId, listingId],
  );
  return result.affectedRows === 1;
}

/** Deletes inquiries older than INQUIRY_KEEP_DAYS (cron 'purge_inquiries'). Idempotent. */
async function purgeOld({ pool, now = new Date() }) {
  const cutoff = daysAfter(now, -rules.INQUIRY_KEEP_DAYS);
  const [result] = await pool.query('DELETE FROM listing_inquiries WHERE created_at < ?', [cutoff]);
  return result.affectedRows;
}

/** Stores an abuse report (no reporter data) and tells the platform admins. */
async function createReport(pool, { listingId, reason, note, now = new Date() }) {
  if (!Object.hasOwn(REPORT_REASONS, reason)) return null;
  const [result] = await pool.query(
    'INSERT INTO listing_reports (listing_id, reason, note) VALUES (?, ?, ?)',
    [listingId, reason, cleanText(note, 300) || null],
  );
  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'platform_admin' AND is_active = 1");
  for (const { id } of admins) {
    await createNotification(pool, {
      userId: id, kind: 'listing_report', title: 'بلاغ جديد عن إعلان', body: `وصل بلاغ عن الإعلان رقم ${listingId}. راجع قائمة البلاغات.`,
      link: '/admin/reports', dedupeKey: `listing_report:${result.insertId}:u${id}`, now,
    });
  }
  return result.insertId;
}

/** Stores a message from the platform contact form and tells the platform admins. */
async function createContactMessage(pool, { values, now = new Date() }) {
  const [result] = await pool.query(
    'INSERT INTO contact_messages (name, phone, email, message) VALUES (?, ?, ?, ?)',
    [values.name || 'زائر', values.phone, values.email, values.message],
  );
  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'platform_admin' AND is_active = 1");
  for (const { id } of admins) {
    await createNotification(pool, {
      userId: id, kind: 'contact_new', title: 'رسالة جديدة من نموذج التواصل', body: 'وصلت رسالة جديدة من صفحة تواصل معنا. راجع قائمة الرسائل.',
      link: '/admin/messages', dedupeKey: `contact_new:${result.insertId}:u${id}`, now,
    });
  }
  return result.insertId;
}

module.exports = {
  VISIT_SLOTS,
  VISIT_DAYS,
  visitDays,
  REPORT_REASONS,
  INQUIRY_STATUSES,
  cleanPhone,
  cleanEmail,
  validateContact,
  validateInquiry,
  recipients,
  createInquiry,
  inquiriesFor,
  setInquiryStatus,
  purgeOld,
  createReport,
  createContactMessage,
};
