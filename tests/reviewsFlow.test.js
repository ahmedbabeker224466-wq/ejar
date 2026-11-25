'use strict';

// Office ratings against real MySQL: only linked tenants and landlords rate,
// another office answers 404, comments wait for the admin, public output has
// no names, and the score ranks offices. Runs only when TEST_DB_NAME is set.

require('dotenv').config({ quiet: true });
if (process.env.TEST_DB_NAME) process.env.DB_NAME = process.env.TEST_DB_NAME;

const { retryOnDeadlock } = require('../services/transaction');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeHttp } = require('./helpers/officeHttp');
const { createFixtures } = require('./helpers/fixtures');

const TEST_DB = process.env.TEST_DB_NAME;
const skip = TEST_DB ? false : 'set TEST_DB_NAME to run database tests';

// Every phone this file signs in with: 9665000035NN.
const phone = (n) => `9665000035${String(n).padStart(2, '0')}`;
const PHONES = Array.from({ length: 100 }, (_, i) => phone(i));
const saved = {};
let db;
let http;
let fx;
let reviews;

test.before(async () => {
  if (!TEST_DB) return;
  for (const k of ['NODE_ENV', 'JWT_SECRET']) saved[k] = process.env[k];
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-long-enough-000000';
  process.env.NODE_ENV = 'test';
  db = require('../config/db');
  await db.ensureSchema();
  await cleanup();
  await db.pool.query(
    `INSERT INTO plans (code, name_ar, price_monthly, price_yearly, max_units, max_contracts, max_members, max_photos, max_listings, is_active, sort_order)
     VALUES ('test_rev', 'اختبار التقييم', 1, 1, NULL, NULL, NULL, NULL, NULL, 0, 135)
     ON DUPLICATE KEY UPDATE max_units = NULL, max_contracts = NULL, max_members = NULL, max_photos = NULL, max_listings = NULL, is_active = 0`,
  );
  reviews = require('../services/reviews');
  http = createOfficeHttp(db);
  await http.start();
  fx = createFixtures({ db, http, phone, planCode: 'test_rev' });
});

async function cleanup() {
  const marks = PHONES.map(() => '?').join(',');
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM offices WHERE owner_id IN (SELECT id FROM users WHERE phone IN (${marks}))`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM users WHERE phone IN (${marks})`, PHONES), { retries: 5 });
  await retryOnDeadlock(() => db.pool.query(`DELETE FROM otp_codes WHERE phone IN (${marks})`, PHONES), { retries: 5 });
}

test.after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (http) http.stop();
  if (db) {
    await cleanup();
    await db.pool.end();
  }
});

const post = (path, cookie, form) => http.request(path, { method: 'POST', cookie, form });

test('pure: the score pulls few reviews toward the middle and validation refuses contacts', { skip: false }, () => {
  const r = require('../services/reviews');
  assert.equal(r.score(0, 0), 3);
  assert.ok(r.score(5 * 20, 20) > r.score(5, 1));
  assert.ok(r.validate({ rating: '0' }).errors.rating);
  assert.ok(r.validate({ rating: '6' }).errors.rating);
  assert.ok(r.validate({ rating: '4', comment: 'كلموني على 0501234567' }).errors.comment);
  assert.deepEqual(r.validate({ rating: '5', comment: 'تعامل راقٍ وسريع' }).errors, {});
});

test('only linked people rate; comments wait for the admin; the public sees no names', { skip }, async () => {
  const a = await fx.office(1, 'تجربة-تقييم-أ');
  const b = await fx.office(2, 'تجربة-تقييم-ب');
  const contractId = await fx.contract(a);
  const tenant = await fx.tenantOf(contractId, 10);
  const landlord = await fx.landlordOf(a, 11);
  const stranger = await fx.person(12);

  // The page lists only the user's own office.
  const page = await http.request('/tenant/review', { cookie: tenant.cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('تجربة-تقييم-أ'));
  assert.ok(!page.text.includes('تجربة-تقييم-ب'));

  // Another office's id answers 404; a person without links has no area.
  assert.equal((await post('/tenant/review', tenant.cookie, { office_id: String(b.office.id), rating: '5' })).status, 404);
  assert.notEqual((await post('/tenant/review', stranger.cookie, { office_id: String(a.office.id), rating: '5' })).status, 302);
  assert.equal((await post('/tenant/review', tenant.cookie, { office_id: String(a.office.id), rating: '9' })).status, 422);

  // Stars only: counted at once, nothing pending.
  const ok = await post('/landlord/review', landlord.cookie, { office_id: String(a.office.id), rating: '4' });
  assert.equal(ok.status, 302);
  // Stars and a comment: pending until moderated.
  const withComment = await post('/tenant/review', tenant.cookie, { office_id: String(a.office.id), rating: '5', comment: 'تعامل ممتاز ومتابعة دقيقة' });
  assert.equal(withComment.status, 302);
  assert.match(withComment.location, /done=pending/);
  assert.deepEqual(await reviews.summary(db.pool, a.office.id), { avg: 4.5, count: 2 });
  assert.equal((await reviews.publicComments(db.pool, a.office.id)).length, 0);

  // Saving again updates the same row.
  await post('/landlord/review', landlord.cookie, { office_id: String(a.office.id), rating: '3' });
  assert.deepEqual(await reviews.summary(db.pool, a.office.id), { avg: 4, count: 2 });

  const [[row]] = await db.pool.query("SELECT id FROM office_reviews WHERE office_id = ? AND comment_status = 'pending'", [a.office.id]);
  assert.equal(await reviews.moderate(db.pool, { id: row.id, decision: 'approved', adminId: tenant.user.id, reason: 'تعليق مناسب' }), true);
  assert.equal(await reviews.moderate(db.pool, { id: row.id, decision: 'approved', adminId: tenant.user.id, reason: 'مرة ثانية' }), false);
  const shown = await reviews.publicComments(db.pool, a.office.id);
  assert.equal(shown.length, 1);
  assert.deepEqual(Object.keys(shown[0]).sort(), ['comment', 'month', 'rating', 'role']);

  // A changed comment goes back to review.
  await post('/tenant/review', tenant.cookie, { office_id: String(a.office.id), rating: '5', comment: 'تعديل على التعليق السابق' });
  assert.equal((await reviews.publicComments(db.pool, a.office.id)).length, 0);

  // Audit rows never hold the comment text.
  const [audits] = await db.pool.query("SELECT after_json FROM audit_logs WHERE office_id = ? AND action LIKE 'review.%'", [a.office.id]);
  assert.ok(audits.length >= 3);
  for (const x of audits) assert.ok(!String(x.after_json).includes('تعامل'));
});
