'use strict';

// Office accounting (/office/accounting, capability 'accounting': owner and
// manager) and the landlord's monthly account (/landlord/account, from their
// database links only). `office` is mounted in routes/office.js, `portal` in
// routes/areas.js. The app records money; it never moves it.

const express = require('express');
const db = require('../config/db');
const accounting = require('../services/accounting');
const money = require('../services/money');
const dates = require('../services/contractDates');
const { sendCsv } = require('../services/csv');
const { parseId } = require('../services/landlords');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { csvLimit } = require('../middleware/csvLimit');
const { loadArea } = require('./portal');

const today = () => dates.riyadhDate(new Date());
const guard = requirePerm('accounting');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthName = (period) => MONTHS[Number(period.slice(5, 7)) - 1];
const monthLabel = (period) => `${monthName(period)} ${period.slice(0, 4)}`;

/** Previous / next month links (no next past the current month). */
function monthNav(period, day) {
  const next = dates.shiftMonth(period, 1);
  return { prev: dates.shiftMonth(period, -1), next: next <= day.slice(0, 7) ? next : null };
}

const DONE = {
  created: 'تم حفظ القيد.',
  voided: 'تم إلغاء القيد.',
  commission: 'تم حفظ نسبة العمولة.',
};

const helpers = { fmt: money.formatHalalas, monthLabel, monthName };

// ------------------------------------------------------------ office

const office = express.Router();

office.get('/office/accounting', guard, wrap(async (req, res) => {
  const day = today();
  const period = accounting.parseMonth(req.query.month, day);
  const summary = await accounting.monthSummary(db.pool, req.office.id, period);
  const rows = await accounting.movements(db.pool, req.office.id, period);
  return res.render('accounting/index', {
    title: 'المحاسبة',
    ...helpers,
    summary,
    rows: rows.slice(0, 50),
    more: rows.length > 50,
    nav: monthNav(period, day),
    percent: accounting.percentText(summary.bp),
    message: DONE[req.query.done] || null,
    error: req.query.error === 'commission' ? 'اكتب نسبة بين 0 و50، مثل 5 أو 2.5.' : null,
  });
}));

office.get('/office/accounting/csv', guard, csvLimit, wrap(async (req, res) => {
  const period = accounting.parseMonth(req.query.month, today());
  const rows = await accounting.movements(db.pool, req.office.id, period);
  return sendCsv(
    res,
    `accounting-${period}.csv`,
    ['التاريخ', 'البيان', 'النوع', 'وارد', 'صادر', 'الحالة'],
    rows.map((r) => [r.day, r.description ? `${r.label} (${r.description})` : r.label, r.typeLabel, r.tone === 'in' ? money.toDecimal(r.h) : '', r.tone === 'out' ? money.toDecimal(r.h) : '', r.voided ? 'ملغى' : '']),
  );
}));

const blankEntry = { kind: 'expense', category: 'maintenance', entry_date: '', amount: '', landlord_id: '', unit_id: '', description: '' };

async function renderEntryForm(req, res, { status = 200, values = blankEntry, errors = {} } = {}) {
  return res.status(status).render('accounting/new', {
    title: 'قيد جديد',
    values,
    errors,
    kinds: accounting.KINDS,
    categories: accounting.CATEGORIES,
    options: await accounting.formOptions(db.pool, req.office.id),
    today: today(),
  });
}

office.get('/office/accounting/new', guard, wrap(async (req, res) => {
  const kind = Object.hasOwn(accounting.KINDS, String(req.query.kind)) ? String(req.query.kind) : 'expense';
  const landlord = /^\d{1,12}$/.test(String(req.query.landlord || '')) ? String(req.query.landlord) : '';
  return renderEntryForm(req, res, { values: { ...blankEntry, kind, category: kind === 'expense' ? 'maintenance' : Object.keys(accounting.CATEGORIES[kind])[0], landlord_id: landlord, entry_date: today() } });
}));

office.post('/office/accounting', guard, wrap(async (req, res) => {
  const day = today();
  const shown = Object.fromEntries(Object.keys(blankEntry).map((k) => [k, String(req.body[k] ?? '').slice(0, 200)]));
  const { values, errors } = accounting.validateEntry(req.body, day);
  if (Object.keys(errors).length) return renderEntryForm(req, res, { status: 422, values: shown, errors });
  const result = await accounting.createEntry(db.pool, req.office.id, { values, actorId: req.user.id, ip: req.ip });
  if (!result.ok) return renderEntryForm(req, res, { status: 422, values: shown, errors: result.errors });
  return res.redirect(`/office/accounting?month=${values.entry_date.slice(0, 7)}&done=created`);
}));

office.post('/office/accounting/commission', guard, wrap(async (req, res) => {
  const result = await accounting.setCommission(db.pool, req.office.id, { input: req.body.percent, actorId: req.user.id, ip: req.ip });
  return res.redirect(result.ok ? '/office/accounting?done=commission' : '/office/accounting?error=commission');
}));

office.post('/office/accounting/:id/void', guard, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const result = await accounting.voidEntry(db.pool, req.office.id, id, { reason: req.body.reason, actorId: req.user.id, ip: req.ip });
  if (result.notFound) return notFound(res);
  const month = accounting.parseMonth(req.body.month, today());
  if (!result.ok) {
    return res.status(422).render('accounting/error', { title: 'تعذّر الإلغاء', message: result.error, back: `/office/accounting?month=${month}` });
  }
  return res.redirect(`/office/accounting?month=${month}&done=voided`);
}));

office.get('/office/accounting/owners', guard, wrap(async (req, res) => {
  const day = today();
  const period = accounting.parseMonth(req.query.month, day);
  const balances = await accounting.ownerBalances(db.pool, req.office.id, period);
  return res.render('accounting/owners', { title: 'حسابات الملّاك', ...helpers, period, balances, nav: monthNav(period, day), percent: accounting.percentText(balances.bp) });
}));

office.get('/office/accounting/owners/:id', guard, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const day = today();
  const period = accounting.parseMonth(req.query.month, day);
  const statement = await accounting.ownerStatement(db.pool, req.office.id, id, period);
  if (!statement) return notFound(res);
  const view = {
    title: `كشف حساب ${statement.landlord.label}`,
    ...helpers,
    statement,
    officeName: req.office.name,
    nav: monthNav(period, day),
    base: `/office/accounting/owners/${id}`,
  };
  if (req.query.print === '1') return res.render('accounting/statement-print', { ...view, layout: 'layouts/print', backUrl: `${view.base}?month=${period}` });
  return res.render('accounting/statement', view);
}));

// ------------------------------------------------------------ landlord

const portal = express.Router();
const area = [requireAuth, loadArea('landlord'), requirePerm('own.reports')];

portal.get('/landlord/account', ...area, wrap(async (req, res) => {
  const day = today();
  const period = accounting.parseMonth(req.query.month, day);
  const statements = [];
  for (const link of req.links) {
    const statement = await accounting.ownerStatement(db.pool, link.office_id, Number(link.landlord_id), period);
    if (statement) statements.push({ officeName: link.office_name, statement });
  }
  return res.render('accounting/landlord', { title: 'حسابي الشهري', ...helpers, period, statements, nav: monthNav(period, day) });
}));

module.exports = { office, portal };
