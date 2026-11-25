'use strict';

// Office, landlord and tenant sessions side by side in one browser: each area
// reads its own cookie first. Pure checks plus one HTTP round trip.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../services/auth');

test('each role has its own cookie and each area reads its own first', () => {
  assert.equal(auth.cookieFor('office_owner').name, 'aqdi_session');
  assert.equal(auth.cookieFor('landlord').name, 'aqdi_landlord_session');
  assert.equal(auth.cookieFor('tenant').name, 'aqdi_tenant_session');
  assert.equal(auth.cookieFor('platform_admin').name, 'aqdi_admin_session');
  assert.equal(auth.cookieFor(null).name, 'aqdi_session');
  const names = (p, h) => auth.cookieCandidates(p, h).map((c) => c.name);
  assert.equal(names('/office/contracts')[0], 'aqdi_session');
  assert.equal(names('/landlord')[0], 'aqdi_landlord_session');
  assert.equal(names('/tenant/review')[0], 'aqdi_tenant_session');
  assert.equal(names('/notifications', 'tenant')[0], 'aqdi_tenant_session');
  assert.equal(names('/notifications')[0], 'aqdi_session');
  assert.equal(names('/admin')[0], 'aqdi_admin_session');
  assert.equal(auth.areaOfPath('/officex'), null);
});

const TEST_DB = process.env.TEST_DB_NAME;
test('an office and a landlord signed in together each see their own area', { skip: TEST_DB ? false : 'set TEST_DB_NAME' }, async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  const db = require('../config/db');
  await db.ensureSchema();
  const { createOfficeHttp } = require('./helpers/officeHttp');
  const { createFixtures } = require('./helpers/fixtures');
  const phone = (n) => `9665000036${String(n).padStart(2, '0')}`;
  const http = createOfficeHttp(db);
  await http.start();
  const fx = createFixtures({ db, http, phone });
  const marks = Array.from({ length: 10 }, (_, i) => phone(i));
  const cleanup = async () => {
    const q = marks.map(() => '?').join(',');
    await db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${q}))`, marks);
    await db.pool.query(`DELETE FROM users WHERE phone IN (${q})`, marks);
  };
  try {
    await cleanup();
    const o = await fx.office(1, 'تجربة-جلسات');
    const landlord = await fx.landlordOf(o, 2);
    // The landlord's token in the landlord cookie, next to the office's own cookie.
    const token = landlord.cookie.split('=').slice(1).join('=');
    const both = `${o.cookie}; aqdi_landlord_session=${token}`;
    assert.equal((await http.request('/office', { cookie: both })).status, 200);
    const area = await http.request('/landlord', { cookie: both });
    assert.equal(area.status, 200);
    assert.match(area.text, /صفحة المالك/);
    // Signing the landlord out leaves the office signed in.
    const out = await http.request('/logout', { cookie: `${both}; aqdi_area=landlord` });
    assert.ok(out.response.headers.getSetCookie().some((c) => c.startsWith('aqdi_landlord_session=;')));
    assert.ok(!out.response.headers.getSetCookie().some((c) => c.startsWith('aqdi_session=;')));
    // /login?add=1 shows the form even while signed in.
    const add = await http.request('/login?add=1', { cookie: o.cookie });
    assert.equal(add.status, 200);
  } finally {
    await cleanup();
    http.stop();
    await db.pool.end();
  }
});
