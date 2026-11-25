'use strict';

// The office's own list of maintenance workers and companies (plumber,
// electrician, AC technician...). Office-only: tenants and landlords never see
// a worker's number. Audit rows hold ids, trades and is_active only.

const { normalizeSaudi, toLocal } = require('../utils/phone');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');

const TRADES = {
  plumbing: 'سباكة',
  electrical: 'كهرباء',
  ac: 'تكييف',
  carpentry: 'نجارة',
  painting: 'دهانات',
  cleaning: 'نظافة',
  appliances: 'أجهزة منزلية',
  pest: 'مكافحة حشرات',
  general: 'صيانة عامة',
};
const LIMITS = { name: 60, notes: 200 };

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function clean(value) {
  return String(value ?? '').replace(/\r\n?/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function looksLikeAccount(text) {
  const squeezed = text.replace(/[\s\-._/]/g, '');
  return /[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}/.test(squeezed) || /\d{10,}/.test(squeezed);
}

/** Checks the vendor form. Returns { values, errors }. */
function validateVendor(body = {}) {
  const errors = {};
  const name = clean(body.name);
  if (name.length < 2) errors.name = 'اكتب اسم الفني أو الشركة.';
  else if (name.length > LIMITS.name) errors.name = `${LIMITS.name} حرفاً كحد أقصى.`;
  else if (/\d{6,}/.test(name)) errors.name = 'لا تكتب أرقاماً في الاسم.';
  const trade = String(body.trade || '');
  if (!has(TRADES, trade)) errors.trade = 'اختر التخصص.';
  const phone = normalizeSaudi(String(body.phone || '').trim());
  if (!phone) errors.phone = 'اكتب رقم جوال سعودي صحيح، مثل 05xxxxxxxx.';
  const notes = clean(body.notes);
  if (notes.length > LIMITS.notes) errors.notes = `${LIMITS.notes} حرف كحد أقصى.`;
  else if (looksLikeAccount(notes)) errors.notes = 'لا تكتب أرقام حسابات أو هويات في الملاحظات.';
  return { values: { name, trade, phone, notes: notes || null, phoneLocal: String(body.phone || '').trim() }, errors };
}

function shape(row) {
  return { ...row, tradeLabel: TRADES[row.trade] || row.trade, phoneLocal: toLocal(row.phone), is_active: Boolean(Number(row.is_active)) };
}

/** Every vendor of the office with how many maintenance requests each was given. */
async function listVendors(pool, officeId, { activeOnly = false, trade = null } = {}) {
  const where = ['v.office_id = :office_id'];
  const params = [];
  if (activeOnly) where.push('v.is_active = 1');
  if (trade && has(TRADES, trade)) { where.push('v.trade = ?'); params.push(trade); }
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT v.id, v.name, v.trade, v.phone, v.notes, v.is_active, v.created_at,
            (SELECT COUNT(*) FROM maintenance_requests m WHERE m.assigned_vendor_id = v.id AND m.office_id = :office_id) AS jobs,
            (SELECT COUNT(*) FROM maintenance_requests m WHERE m.assigned_vendor_id = v.id AND m.office_id = :office_id AND m.status IN ('new','seen','in_progress')) AS open_jobs
       FROM vendors v WHERE ${where.join(' AND ')}
      ORDER BY v.is_active DESC, v.trade, v.name`,
    params,
  );
  return rows.map(shape);
}

async function getVendor(pool, officeId, id) {
  if (!id) return null;
  const rows = await scopeToOffice(pool, officeId).query('SELECT * FROM vendors WHERE id = ? AND office_id = :office_id', [id]);
  return rows[0] ? shape(rows[0]) : null;
}

async function createVendor(pool, officeId, { values, actorId, ip }) {
  const id = await scopeToOffice(pool, officeId).insert('vendors', {
    name: values.name, trade: values.trade, phone: values.phone, notes: values.notes, is_active: 1,
  });
  await createAudit(pool).log(actorId, officeId, 'vendor.create', 'vendor', id, null, { trade: values.trade }, ip);
  return id;
}

async function updateVendor(pool, officeId, id, { values, actorId, ip }) {
  const result = await scopeToOffice(pool, officeId).query(
    'UPDATE vendors SET name = ?, trade = ?, phone = ?, notes = ? WHERE id = ? AND office_id = :office_id',
    [values.name, values.trade, values.phone, values.notes, id],
  );
  if (!result || !result.affectedRows) return false;
  await createAudit(pool).log(actorId, officeId, 'vendor.update', 'vendor', id, null, { trade: values.trade }, ip);
  return true;
}

async function setActive(pool, officeId, id, active, { actorId, ip }) {
  const result = await scopeToOffice(pool, officeId).query(
    'UPDATE vendors SET is_active = ? WHERE id = ? AND office_id = :office_id', [active ? 1 : 0, id],
  );
  if (!result || !result.affectedRows) return false;
  await createAudit(pool).log(actorId, officeId, 'vendor.active', 'vendor', id, null, { is_active: active }, ip);
  return true;
}

/** Deletes a vendor. Requests it worked on keep their history (assigned_vendor_id becomes NULL). */
async function deleteVendor(pool, officeId, id, { actorId, ip }) {
  const result = await scopeToOffice(pool, officeId).query('DELETE FROM vendors WHERE id = ? AND office_id = :office_id', [id]);
  if (!result || !result.affectedRows) return false;
  await createAudit(pool).log(actorId, officeId, 'vendor.delete', 'vendor', id, null, null, ip);
  return true;
}

/** Gives a maintenance request to an active vendor of the same office (or clears it with null). */
async function assignToRequest(pool, officeId, requestId, vendorId, { actorId, ip }) {
  const scoped = scopeToOffice(pool, officeId);
  if (vendorId) {
    const rows = await scoped.query('SELECT id FROM vendors WHERE id = ? AND office_id = :office_id AND is_active = 1', [vendorId]);
    if (!rows.length) return { ok: false, error: 'vendor' };
  }
  const result = await scoped.query(
    'UPDATE maintenance_requests SET assigned_vendor_id = ? WHERE id = ? AND office_id = :office_id', [vendorId || null, requestId],
  );
  if (!result || !result.affectedRows) return { ok: false, error: 'not_found' };
  await createAudit(pool).log(actorId, officeId, 'maintenance.vendor', 'maintenance_request', requestId, null, { vendor_id: vendorId || null }, ip);
  return { ok: true };
}

module.exports = {
  TRADES, LIMITS, validateVendor, listVendors, getVendor, createVendor, updateVendor, setActive, deleteVendor, assignToRequest,
};
