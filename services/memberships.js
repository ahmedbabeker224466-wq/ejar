'use strict';

// Which landlord records and contracts a signed-in person is linked to.
// Landlord: landlords.user_id (one landlord record per office; a person can
// be the landlord of several offices). Tenant: contract_members rows with
// role 'tenant'. Both lookups are keyed by the user id from the verified
// session (never by request data); like offices.membershipsFor, they are how
// the office ids are found, so they cannot go through scopeToOffice(). Every
// query after them is scoped to the office of the link.

const db = require('../config/db');

/** Active landlord records linked to the user, with their office's display name. */
async function landlordLinks(pool, userId) {
  const [rows] = await pool.query(
    `SELECT l.id AS landlord_id, l.office_id, l.label, o.name AS office_name
       FROM landlords l JOIN offices o ON o.id = l.office_id
      WHERE l.user_id = ? AND l.is_active = 1
      ORDER BY l.id`,
    [userId],
  );
  return rows.map((r) => ({ ...r, landlord_id: Number(r.landlord_id), office_id: Number(r.office_id) }));
}

/** Contracts the user is a tenant of, newest first. */
async function tenantLinks(pool, userId) {
  const [rows] = await pool.query(
    `SELECT cm.contract_id, c.office_id, o.name AS office_name
       FROM contract_members cm
       JOIN contracts c ON c.id = cm.contract_id
       JOIN offices o ON o.id = c.office_id
      WHERE cm.user_id = ? AND cm.role = 'tenant'
      ORDER BY c.start_date DESC, c.id DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, contract_id: Number(r.contract_id), office_id: Number(r.office_id) }));
}

/** The areas a person can switch between (for the header switcher). */
async function areasFor(pool = db.pool, userId) {
  const [landlord, tenant] = await Promise.all([landlordLinks(pool, userId), tenantLinks(pool, userId)]);
  const areas = [];
  if (landlord.length) areas.push({ key: 'landlord', href: '/landlord', label: 'صفحة المالك' });
  if (tenant.length) areas.push({ key: 'tenant', href: '/tenant', label: 'صفحة المستأجر' });
  return areas;
}

module.exports = { landlordLinks, tenantLinks, areasFor };
