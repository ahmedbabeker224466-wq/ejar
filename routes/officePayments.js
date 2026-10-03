'use strict';

// Office side of payment tracking: the overdue list (/office/payments) with
// filters and CSV, recording a payment on an installment (full or partial),
// undo within 24 hours, and the printable receipt-style statement of one
// contract. Mounted inside routes/office.js, so req.office comes from
// loadOffice and every query is scoped to it.

const express = require('express');
const db = require('../config/db');
const contracts = require('../services/contracts');
const entries = require('../services/paymentEntries');
const money = require('../services/money');
const { sendCsv } = require('../services/csv');
const { parseId } = require('../services/landlords');
const { scopeToOffice } = require('../services/scopeToOffice');
const { riyadhDate } = require('../services/contractDates');
const { requirePerm } = require('../middleware/permissions');
const { csvLimit } = require('../middleware/csvLimit');

const router = express.Router();
const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

async function loadContract(req, res, next) {
  try {
    req.contract = await contracts.getContract(db.pool, req.office.id, parseId(req.params.id));
    return req.contract ? next() : notFound(res);
  } catch (err) {
    return next(err);
  }
}

const ERRORS = {
  closed: 'هذه الدفعة مسددة بالكامل أو ملغاة.',
  exceeds: 'المبلغ أكبر من المتبقي على هذه الدفعة.',
  amount: 'اكتب مبلغاً صحيحاً.',
  not_found: 'الدفعة غير موجودة.',
  expired: 'انتهت مهلة التراجع (24 ساعة).',
  forbidden: 'لا يمكنك التراجع عن هذه الدفعة.',
};

// ------------------------------------------------------------ overdue list

function overdueUrl(filters, page, extra = '') {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.landlordId) params.set('landlord', String(filters.landlordId));
  if (filters.minDays) params.set('days', String(filters.minDays));
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return `/office/payments${extra}${text ? `?${text}` : ''}`;
}

router.get('/office/payments', requirePerm('payments.read'), wrap(async (req, res) => {
  const day = today();
  const filters = entries.parseOverdueFilters(req.query, day);
  const list = await entries.overdueList(db.pool, req.office.id, { today: day, filters, page: req.query.page });
  const landlords = await scopeToOffice(db.pool, req.office.id).query('SELECT id, label FROM landlords WHERE office_id = :office_id ORDER BY label ASC');
  return res.render('payments/overdue', {
    title: 'الدفعات المتأخرة',
    ...list,
    filters,
    landlords,
    buckets: entries.OVERDUE_BUCKETS,
    fmt: money.formatHalalas,
    filtered: Boolean(filters.q || filters.landlordId || filters.minDays || filters.from || filters.to),
    csvUrl: overdueUrl(filters, 1, '.csv'),
    prevUrl: list.page > 1 ? overdueUrl(filters, list.page - 1) : null,
    nextUrl: list.page < list.pages ? overdueUrl(filters, list.page + 1) : null,
  });
}));

router.get('/office/payments.csv', requirePerm('payments.read'), csvLimit, wrap(async (req, res) => {
  const day = today();
  const filters = entries.parseOverdueFilters(req.query, day);
  const rows = await entries.overdueAll(db.pool, req.office.id, { today: day, filters });
  return sendCsv(res, 'overdue-payments.csv',
    ['الوحدة', 'المالك', 'تاريخ الاستحقاق', 'أيام التأخر', 'المبلغ', 'المدفوع', 'المتبقي'],
    rows.map((r) => [r.unit_label, r.landlord_label, String(r.due_date).slice(0, 10), r.daysOverdue,
      money.toDecimal(r.totalHalalas), money.toDecimal(r.paidHalalas), money.toDecimal(r.remainingHalalas)]));
}));

// ------------------------------------------------------------ record and undo

router.post('/office/contracts/:id/payments/:paymentId/entries', requirePerm('payments.write'), loadContract, wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  if (!paymentId) return notFound(res);
  const { values, errors } = entries.validateEntry(req.body, today());
  const back = `/office/contracts/${req.contract.id}`;
  if (Object.keys(errors).length) return res.status(422).render('payments/error', { title: 'تعذر حفظ الدفعة', message: Object.values(errors)[0], back: `${back}#payments` });
  const result = await entries.recordPayment(db.pool, req.office.id, {
    contractId: req.contract.id, paymentId, values, actor: { id: req.user.id, role: 'office' }, ip: req.ip, today: today(),
  });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return res.status(409).render('payments/error', { title: 'تعذر حفظ الدفعة', message: ERRORS[result.error] || ERRORS.amount, back: `${back}#payments` });
  return res.redirect(`${back}?done=recorded#payments`);
}));

router.post('/office/contracts/:id/payments/:paymentId/entries/:entryId/undo', requirePerm('payments.write'), loadContract, wrap(async (req, res) => {
  const paymentId = parseId(req.params.paymentId);
  const entryId = parseId(req.params.entryId);
  if (!paymentId || !entryId) return notFound(res);
  const back = `/office/contracts/${req.contract.id}`;
  const reason = entries.validateReason(req.body.reason);
  if (reason.error) return res.status(422).render('payments/error', { title: 'تعذر التراجع', message: reason.error, back: `${back}#payments` });
  const result = await entries.undoEntry(db.pool, req.office.id, {
    contractId: req.contract.id, paymentId, entryId, reason: reason.value, actor: { id: req.user.id, role: 'office' }, ip: req.ip,
  });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return res.status(409).render('payments/error', { title: 'تعذر التراجع', message: ERRORS[result.error], back: `${back}#payments` });
  return res.redirect(`${back}?done=undone#payments`);
}));

// ------------------------------------------------------------ receipt-style statement

router.get('/office/contracts/:id/receipt', requirePerm('payments.read'), loadContract, wrap(async (req, res) => {
  const day = today();
  const history = await entries.historyFor(db.pool, req.office.id, req.contract.id, day);
  return res.render('payments/receipt', {
    title: 'كشف دفعات العقد',
    officeName: req.office.name,
    unitLabel: req.contract.unit_label,
    startDate: req.contract.start_date,
    endDate: req.contract.end_date,
    today: day,
    history,
    totals: entries.totalsOf(history),
    fmt: money.formatHalalas,
    methods: entries.METHODS,
    paymentLabels: contracts.PAYMENT_LABELS,
    backUrl: `/office/contracts/${req.contract.id}#payments`,
  });
}));

module.exports = router;
