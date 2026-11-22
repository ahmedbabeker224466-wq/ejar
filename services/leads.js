'use strict';

// Prospective tenants of an office, on a board from the first inquiry until
// the lease is registered on Ejar. A lead holds a short label of what the
// person wants, an optional contact nickname and phone, a source, a budget,
// the next follow-up day, a note and the member in charge. Never an ID
// number, an IBAN or an address (the note refuses account-like numbers).
//
// A lead can be made from a listing inquiry (once per inquiry). Contact
// details of leads closed more than INQUIRY_KEEP_DAYS ago are cleared by the
// purge_inquiries job. Audit rows hold ids, stages and sources, never the
// contact or the note.

const engine = require('./contractEngine');
const money = require('./money');
const rules = require('../config/listings');
const { normalizeSaudi, toLocal } = require('../utils/phone');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const team = require('./team');

const STAGES = {
  new: 'جديد',
  contacted: 'تم التواصل',
  viewing: 'موعد معاينة',
  awaiting_ejar: 'بانتظار التوثيق في إيجار',
  won: 'تم التأجير',
  lost: 'لم يكتمل',
};
const OPEN_STAGES = ['new', 'contacted', 'viewing', 'awaiting_ejar'];
const SOURCES = {
  listing: 'من إعلان ميعاد',
  office_page: 'من صفحة المكتب',
  phone: 'اتصال هاتفي',
  walk_in: 'زيارة للمكتب',
  referral: 'إحالة',
  other: 'أخرى',
};
const LIMITS = { label: 80, contact: 60, note: 500 };

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function cleanText(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return { text, tooLong: text.length > max };
}

function looksLikeAccount(text) {
  const squeezed = text.replace(/[\s\-._/]/g, '');
  return /[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}/.test(squeezed) || /\d{10,}/.test(squeezed);
}

/** Checks the lead form. Returns { values, errors }. Assignee and unit are checked against the office later. */
function validateLead(body = {}) {
  const errors = {};
  const label = cleanText(body.label, LIMITS.label);
  if (!label.text) errors.label = 'اكتب ما يبحث عنه العميل، مثل: شقة 3 غرف في حي الملقا.';
  else if (label.tooLong) errors.label = `${LIMITS.label} حرفاً كحد أقصى.`;
  else if (looksLikeAccount(label.text)) errors.label = 'لا تكتب أرقاماً طويلة هنا.';
  const contact = cleanText(body.contact_label, LIMITS.contact);
  if (contact.tooLong) errors.contact_label = `${LIMITS.contact} حرفاً كحد أقصى.`;
  else if (/\d{5,}/.test(contact.text)) errors.contact_label = 'اكتب اسماً أو لقباً فقط، والرقم في خانة الجوال.';
  const phoneRaw = String(body.phone || '').trim();
  const phone = phoneRaw ? normalizeSaudi(phoneRaw) : null;
  if (phoneRaw && !phone) errors.phone = 'اكتب رقم جوال سعودي صحيح، مثل 05xxxxxxxx.';
  const source = has(SOURCES, String(body.source || '')) ? String(body.source) : 'other';
  const budgetRaw = String(body.budget || '').trim();
  const budget = budgetRaw ? money.parseAmount(budgetRaw) : null;
  if (budgetRaw && budget === null) errors.budget = 'اكتب مبلغاً صحيحاً.';
  const nextRaw = String(body.next_date || '').trim();
  if (nextRaw && !engine.isValidDate(nextRaw)) errors.next_date = 'اختر تاريخاً صحيحاً.';
  const note = cleanText(body.note, LIMITS.note);
  if (note.tooLong) errors.note = `${LIMITS.note} حرف كحد أقصى.`;
  else if (looksLikeAccount(note.text)) errors.note = 'لا تكتب أرقام حسابات أو هويات أو أرقاماً طويلة في الملاحظة.';
  const assignee = String(body.assignee || '').trim();
  if (assignee && !/^\d{1,12}$/.test(assignee)) errors.assignee = 'اختر عضواً من الفريق.';
  const unit = String(body.unit_id || '').trim();
  if (unit && !/^\d{1,12}$/.test(unit)) errors.unit_id = 'اختر الوحدة من القائمة.';
  return {
    values: {
      label: label.text,
      contact_label: contact.text || null,
      phone,
      source,
      budget,
      next_date: nextRaw || null,
      note: note.text || null,
      assignee: assignee ? Number(assignee) : null,
      unit_id: unit ? Number(unit) : null,
    },
    errors,
  };
}

async function checkRefs(pool, officeId, values) {
  const errors = {};
  const scoped = scopeToOffice(pool, officeId);
  if (values.unit_id) {
    const [unit] = await scoped.query('SELECT id FROM units WHERE id = ? AND office_id = :office_id', [values.unit_id]);
    if (!unit) errors.unit_id = 'الوحدة غير موجودة في مكتبك.';
  }
  if (values.assignee !== null) {
    const members = await team.listMembers(pool, officeId, { activeOnly: true });
    if (!members.some((m) => m.user_id === values.assignee)) errors.assignee = 'اختر عضواً فعّالاً من الفريق.';
  }
  return errors;
}

const SELECT_LEAD = `
  SELECT ld.*, ROUND(ld.budget * 100) AS budget_h, u.label AS unit_label, a.name AS assignee_name, a.phone AS assignee_phone
    FROM leads ld
    LEFT JOIN units u ON u.id = ld.unit_id AND u.office_id = ld.office_id
    LEFT JOIN users a ON a.id = ld.assigned_to`;

function shape(row, today) {
  const next = row.next_date ? String(row.next_date).slice(0, 10) : null;
  return {
    id: Number(row.id),
    label: row.label,
    contactLabel: row.contact_label,
    phone: row.phone ? toLocal(row.phone) : '',
    stage: row.stage,
    stageLabel: STAGES[row.stage],
    source: row.source,
    sourceLabel: SOURCES[row.source],
    budget: row.budget_h === null || row.budget_h === undefined ? null : Number(row.budget_h),
    next,
    due: Boolean(next && OPEN_STAGES.includes(row.stage) && !engine.isAfter(next, today)),
    note: row.note,
    unitId: row.unit_id ? Number(row.unit_id) : null,
    unitLabel: row.unit_label,
    listingId: row.listing_id ? Number(row.listing_id) : null,
    assignedTo: row.assigned_to ? Number(row.assigned_to) : null,
    assigneeLabel: row.assigned_to ? team.displayName({ name: row.assignee_name, phone: row.assignee_phone }) : null,
  };
}

/** Open stages as columns, plus recent wins; lost leads only as a count unless asked. */
async function board(pool, officeId, { today, mine = null, showLost = false }) {
  const where = mine ? ' AND ld.assigned_to = ?' : '';
  const rows = await scopeToOffice(pool, officeId).query(
    `${SELECT_LEAD}
      WHERE ld.office_id = :office_id${where}
        AND (ld.stage IN ('new','contacted','viewing','awaiting_ejar')
             OR (ld.stage = 'won' AND ld.closed_at > UTC_TIMESTAMP() - INTERVAL 60 DAY)
             ${showLost ? "OR (ld.stage = 'lost' AND ld.closed_at > UTC_TIMESTAMP() - INTERVAL 60 DAY)" : ''})
      ORDER BY (ld.next_date IS NULL), ld.next_date, ld.id DESC LIMIT 400`,
    mine ? [mine] : [],
  );
  const columns = Object.fromEntries(Object.keys(STAGES).map((s) => [s, []]));
  for (const row of rows) columns[row.stage].push(shape(row, today));
  const [lost] = await scopeToOffice(pool, officeId).query("SELECT COUNT(*) AS n FROM leads WHERE office_id = :office_id AND stage = 'lost'");
  return { columns, lostCount: Number(lost.n) };
}

async function getLead(pool, officeId, id, today) {
  if (!id) return null;
  const [row] = await scopeToOffice(pool, officeId).query(`${SELECT_LEAD} WHERE ld.id = ? AND ld.office_id = :office_id`, [id]);
  return row ? shape(row, today) : null;
}

function rowFor(values) {
  return {
    label: values.label,
    contact_label: values.contact_label,
    phone: values.phone,
    source: values.source,
    budget: values.budget === null ? null : money.toDecimal(values.budget),
    next_date: values.next_date,
    note: values.note,
    assigned_to: values.assignee,
    unit_id: values.unit_id,
  };
}

async function createLead(pool, officeId, { values, actorId, ip }) {
  const errors = await checkRefs(pool, officeId, values);
  if (Object.keys(errors).length) return { ok: false, errors };
  const id = await scopeToOffice(pool, officeId).insert('leads', { ...rowFor(values), created_by: actorId, stage_changed_at: new Date() });
  await createAudit(pool).log(actorId, officeId, 'lead.create', 'lead', id, null, { source: values.source, assigned_to: values.assignee }, ip);
  return { ok: true, id };
}

async function updateLead(pool, officeId, id, { values, actorId, ip }) {
  const errors = await checkRefs(pool, officeId, values);
  if (Object.keys(errors).length) return { ok: false, errors };
  const scoped = scopeToOffice(pool, officeId);
  const result = await scoped.query(
    `UPDATE leads SET label = ?, contact_label = ?, phone = ?, source = ?, budget = ?, next_date = ?, note = ?, assigned_to = ?, unit_id = ?
      WHERE id = ? AND office_id = :office_id`,
    [values.label, values.contact_label, values.phone, values.source, values.budget === null ? null : money.toDecimal(values.budget), values.next_date, values.note, values.assignee, values.unit_id, id],
  );
  if (!result || result.affectedRows === 0) return { ok: false, notFound: true };
  await createAudit(pool).log(actorId, officeId, 'lead.update', 'lead', id, null, { source: values.source, assigned_to: values.assignee }, ip);
  return { ok: true };
}

/** Moves a lead to another stage. Won and lost set closed_at; reopening clears it. */
async function moveLead(pool, officeId, id, { stage, actorId, ip }) {
  if (!has(STAGES, stage)) return { ok: false };
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query('SELECT id, stage FROM leads WHERE id = ? AND office_id = :office_id', [id]);
  if (!row) return { ok: false, notFound: true };
  if (row.stage === stage) return { ok: true };
  const closed = stage === 'won' || stage === 'lost';
  await scoped.query(
    `UPDATE leads SET stage = ?, stage_changed_at = UTC_TIMESTAMP(), closed_at = ${closed ? 'UTC_TIMESTAMP()' : 'NULL'}
      WHERE id = ? AND office_id = :office_id`,
    [stage, id],
  );
  await createAudit(pool).log(actorId, officeId, 'lead.move', 'lead', id, { stage: row.stage }, { stage }, ip);
  return { ok: true };
}

/** Makes a lead from a listing inquiry of this office (once per inquiry). */
async function fromInquiry(pool, officeId, inquiryId, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  const [inq] = await scoped.query(
    `SELECT q.id, q.listing_id, q.name, q.phone, l.title, l.unit_id, ROUND(l.price * 100) AS price_h
       FROM listing_inquiries q JOIN listings l ON l.id = q.listing_id AND l.office_id = :office_id
      WHERE q.id = ? AND q.office_id = :office_id`,
    [inquiryId],
  );
  if (!inq) return { ok: false, notFound: true };
  const [existing] = await scoped.query('SELECT id FROM leads WHERE inquiry_id = ? AND office_id = :office_id', [inquiryId]);
  if (existing) return { ok: true, id: Number(existing.id), existed: true };
  const contact = cleanText(inq.name, LIMITS.contact).text;
  const id = await scoped.insert('leads', {
    label: cleanText(inq.title, LIMITS.label).text.slice(0, LIMITS.label) || 'استفسار عن إعلان',
    contact_label: contact && !/\d{5,}/.test(contact) ? contact : null,
    phone: normalizeSaudi(inq.phone),
    source: 'listing',
    listing_id: inq.listing_id,
    inquiry_id: inq.id,
    unit_id: inq.unit_id,
    budget: inq.price_h ? money.toDecimal(Number(inq.price_h)) : null,
    created_by: actorId,
    stage_changed_at: new Date(),
  });
  await scoped.query("UPDATE listing_inquiries SET status = 'contacted' WHERE id = ? AND office_id = :office_id AND status = 'new'", [inquiryId]);
  await createAudit(pool).log(actorId, officeId, 'lead.create', 'lead', id, null, { source: 'listing', inquiry_id: inquiryId }, ip);
  return { ok: true, id };
}

/** Clears the contact of leads closed long ago (cron purge_inquiries). Idempotent. */
async function purgeContacts({ pool, now = new Date() }) {
  const cutoff = new Date(now.getTime() - rules.INQUIRY_KEEP_DAYS * 86400000);
  const [result] = await pool.query(
    `UPDATE leads SET phone = NULL, contact_label = NULL
      WHERE stage IN ('won','lost') AND closed_at < ? AND (phone IS NOT NULL OR contact_label IS NOT NULL)`,
    [cutoff],
  );
  return result.affectedRows;
}

/** Units of the office for the form. */
async function unitOptions(pool, officeId) {
  return scopeToOffice(pool, officeId).query(
    `SELECT u.id, u.label, u.status FROM units u WHERE u.office_id = :office_id ORDER BY (u.status <> 'vacant'), u.label LIMIT 2000`,
  );
}

module.exports = {
  STAGES,
  OPEN_STAGES,
  SOURCES,
  LIMITS,
  validateLead,
  board,
  getLead,
  createLead,
  updateLead,
  moveLead,
  fromInquiry,
  purgeContacts,
  unitOptions,
};
