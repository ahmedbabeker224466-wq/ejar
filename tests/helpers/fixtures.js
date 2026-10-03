'use strict';

// Shared fixtures for the database flow tests: offices with landlords and
// units, contracts created through the real form, landlords and tenants that
// join with their invite codes, and multipart uploads.

const assert = require('node:assert/strict');

function createFixtures({ db, http, phone, planCode }) {
  const dates = require('../../services/contractDates');
  const joins = require('../../services/joins');
  const { scopeToOffice } = require('../../services/scopeToOffice');
  const today = () => dates.riyadhDate(new Date());

  async function count(sql, params = []) {
    const [[row]] = await db.pool.query(sql, params);
    return Number(Object.values(row)[0]);
  }

  /** An office on the test plan with `landlords` landlords and `units` units each. */
  async function office(n, name, { city = 'جدة', landlords = 1, units = 3 } = {}) {
    const owner = await http.registerOffice(phone(n), name);
    await db.pool.query('UPDATE offices SET plan_id = (SELECT id FROM plans WHERE code = ?) WHERE id = ?', [planCode, owner.office.id]);
    const scoped = scopeToOffice(db.pool, owner.office.id);
    const landlordIds = [];
    const unitsBy = {};
    for (let l = 1; l <= landlords; l += 1) {
      const landlordId = await scoped.insert('landlords', { label: `مالك ${l} ${name}`, city });
      landlordIds.push(landlordId);
      unitsBy[landlordId] = [];
      for (let i = 1; i <= units; i += 1) unitsBy[landlordId].push(await scoped.insert('units', { landlord_id: landlordId, label: `شقة ${l}-${i}`, city }));
    }
    return { ...owner, scoped, city, landlordIds, landlordId: landlordIds[0], unitsBy, units: unitsBy[landlordIds[0]] };
  }

  /** A running contract created through the office form. Returns its id. */
  async function contract(o, { landlordId = o.landlordId, unitIndex = 0, start = null, end = null, rent = '36000', frequency = 'monthly', cookie = o.cookie } = {}) {
    const from = start || today();
    const res = await http.request('/office/contracts', {
      method: 'POST',
      cookie,
      form: {
        landlord_id: String(landlordId),
        unit_id: String(o.unitsBy[landlordId][unitIndex]),
        tenant_label: 'اسم-سري',
        start_date: from,
        end_date: end || dates.addDays(dates.addMonths(from, 12), -1),
        annual_rent: rent,
        payment_frequency: frequency,
        city: o.city,
        auto_renew: '1',
        ack_warnings: '1',
      },
    });
    assert.equal(res.status, 302, res.text.slice(res.text.indexOf('flash'), res.text.indexOf('flash') + 300));
    return Number(/\/office\/contracts\/(\d+)/.exec(res.location)[1]);
  }

  async function person(n) {
    const { cookie } = await http.login(phone(n));
    return { cookie, user: await http.userByPhone(phone(n)) };
  }

  async function joinAs(n, code) {
    const p = await person(n);
    joins.joinGuard.reset();
    const result = await joins.joinWithCode(db.pool, { userId: p.user.id, code });
    assert.equal(result.ok, true, JSON.stringify(result));
    return { ...p, user: await http.userByPhone(phone(n)) };
  }

  async function landlordOf(o, n, landlordId = o.landlordId) {
    await http.request(`/office/landlords/${landlordId}/invite`, { method: 'POST', cookie: o.cookie });
    const [[row]] = await db.pool.query(
      'SELECT code FROM invites WHERE landlord_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', [landlordId],
    );
    return joinAs(n, row.code);
  }

  async function tenantOf(contractId, n) {
    const [[row]] = await db.pool.query(
      "SELECT code FROM invites WHERE contract_id = ? AND kind = 'tenant' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1", [contractId],
    );
    return joinAs(n, row.code);
  }

  /** Multipart POST (fields and files) like a browser form. files: [{ name, type, data }]. */
  async function multipart(path, cookie, fields, files = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append(f.field || 'photos', new Blob([f.data], { type: f.type || 'image/jpeg' }), f.name || 'photo.jpg');
    const response = await fetch(`${http.base()}${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: http.base() }, body: form, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  }

  async function get(path, cookie) {
    const response = await fetch(`${http.base()}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location'), body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type'), headers: response.headers };
  }

  return { dates, count, office, contract, person, joinAs, landlordOf, tenantOf, multipart, get, today };
}

module.exports = { createFixtures };
