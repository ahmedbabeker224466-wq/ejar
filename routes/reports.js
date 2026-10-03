'use strict';

// Reports (/office/reports) with CSV per report, and the landlord's read-only
// statement (/landlord/statement) with CSV. `office` is mounted in
// routes/office.js (capability 'reports': owner and manager); `portal` in
// routes/areas.js (capability 'own.reports': landlords, from their database
// links only). CSV: UTF-8 with BOM, Excel-safe cells, 10 downloads per minute.

const express = require('express');
const db = require('../config/db');
const reports = require('../services/reports');
const maintenance = require('../services/maintenance');
const money = require('../services/money');
const { sendCsv } = require('../services/csv');
const { riyadhDate } = require('../services/contractDates');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { csvLimit } = require('../middleware/csvLimit');
const { loadArea } = require('./portal');

const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

function ctxFor(range, day) {
  return { today: day, range, categories: maintenance.CATEGORIES, statuses: maintenance.STATUSES };
}

const rangeQuery = (range) => `from=${range.from}&to=${range.to}`;

// ------------------------------------------------------------ office

const office = express.Router();

office.get('/office/reports', requirePerm('reports'), wrap(async (req, res) => {
  const day = today();
  const range = reports.parseRange(req.query, day);
  const ctx = ctxFor(range, day);
  const results = {};
  for (const name of Object.keys(reports.REPORTS)) results[name] = await reports.run(db.pool, req.office.id, name, ctx);
  return res.render('reports/index', {
    title: 'التقارير',
    range,
    today: day,
    results,
    meta: reports.REPORTS,
    buckets: reports.BUCKETS,
    fmt: money.formatHalalas,
    categories: maintenance.CATEGORIES,
    statuses: maintenance.STATUSES,
    csvQuery: rangeQuery(range),
  });
}));

office.get('/office/reports/csv/:name', requirePerm('reports'), csvLimit, wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!Object.hasOwn(reports.REPORTS, name)) return notFound(res);
  const day = today();
  const range = reports.parseRange(req.query, day);
  if (range.error) return res.status(400).type('text/plain; charset=utf-8').send(range.error);
  const result = await reports.run(db.pool, req.office.id, name, ctxFor(range, day));
  return sendCsv(res, `${reports.REPORTS[name].file}-${range.from}-${range.to}.csv`, result.headers, result.csvRows);
}));

// ------------------------------------------------------------ landlord statement

const portal = express.Router();
const area = [requireAuth, loadArea('landlord'), requirePerm('own.reports')];

portal.get('/landlord/statement', ...area, wrap(async (req, res) => {
  const day = today();
  const range = reports.parseRange(req.query, day);
  const statement = await reports.landlordStatement(db.pool, req.links, { today: day, range });
  return res.render('reports/statement', { title: 'كشف الحساب', range, statement, fmt: money.formatHalalas, csvQuery: rangeQuery(range) });
}));

portal.get('/landlord/statement/csv', ...area, csvLimit, wrap(async (req, res) => {
  const day = today();
  const range = reports.parseRange(req.query, day);
  if (range.error) return res.status(400).type('text/plain; charset=utf-8').send(range.error);
  const statement = await reports.landlordStatement(db.pool, req.links, { today: day, range });
  return sendCsv(res, `statement-${range.from}-${range.to}.csv`, statement.headers, statement.csvRows);
}));

module.exports = { office, portal };
