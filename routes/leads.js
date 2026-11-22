'use strict';

// /office/leads: prospective tenants on a board (new -> contacted -> viewing ->
// awaiting Ejar -> won | lost). Capability 'leads' (every office role).
// Mounted inside routes/office.js: req.office comes from loadOffice and every
// query is scoped to it. Another office's lead (or a malformed id) answers 404.

const express = require('express');
const db = require('../config/db');
const leads = require('../services/leads');
const team = require('../services/team');
const money = require('../services/money');
const { parseId } = require('../services/landlords');
const { riyadhDate } = require('../services/contractDates');
const { requirePerm } = require('../middleware/permissions');

const router = express.Router();
const guard = requirePerm('leads');
const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const DONE = { created: 'تمت إضافة العميل.', saved: 'تم حفظ التعديلات.', moved: 'تم نقل العميل.', existed: 'هذا الاستفسار مضاف من قبل.' };
const blank = { label: '', contact_label: '', phone: '', source: 'phone', budget: '', next_date: '', note: '', assignee: '', unit_id: '' };
const FIELDS = Object.keys(blank);
const shown = (body) => Object.fromEntries(FIELDS.map((k) => [k, String(body[k] ?? '').slice(0, 600)]));

async function formLocals(req) {
  return {
    sources: leads.SOURCES,
    limits: leads.LIMITS,
    members: await team.listMembers(db.pool, req.office.id, { activeOnly: true }),
    units: await leads.unitOptions(db.pool, req.office.id),
  };
}

router.get('/office/leads', guard, wrap(async (req, res) => {
  const mine = req.query.mine === '1';
  const showLost = req.query.lost === '1';
  const data = await leads.board(db.pool, req.office.id, { today: today(), mine: mine ? req.user.id : null, showLost });
  return res.render('leads/board', {
    title: 'العملاء المحتملون',
    ...data,
    stages: leads.STAGES,
    shownStages: showLost ? Object.keys(leads.STAGES) : Object.keys(leads.STAGES).filter((s) => s !== 'lost'),
    mine,
    showLost,
    fmt: money.formatHalalas,
    message: DONE[req.query.done] || null,
  });
}));

router.get('/office/leads/new', guard, wrap(async (req, res) => res.render('leads/form', {
  title: 'عميل جديد', action: '/office/leads', values: blank, errors: {}, ...(await formLocals(req)), lead: null, stages: leads.STAGES,
})));

router.post('/office/leads', guard, wrap(async (req, res) => {
  const { values, errors } = leads.validateLead(req.body);
  const render = async (errs) => res.status(422).render('leads/form', { title: 'عميل جديد', action: '/office/leads', values: shown(req.body), errors: errs, ...(await formLocals(req)), lead: null, stages: leads.STAGES });
  if (Object.keys(errors).length) return render(errors);
  const result = await leads.createLead(db.pool, req.office.id, { values, actorId: req.user.id, ip: req.ip });
  if (!result.ok) return render(result.errors);
  return res.redirect('/office/leads?done=created');
}));

router.post('/office/leads/from-inquiry/:inquiryId', guard, wrap(async (req, res) => {
  const inquiryId = parseId(req.params.inquiryId);
  if (!inquiryId) return notFound(res);
  const result = await leads.fromInquiry(db.pool, req.office.id, inquiryId, { actorId: req.user.id, ip: req.ip });
  if (result.notFound) return notFound(res);
  return res.redirect(`/office/leads/${result.id}?done=${result.existed ? 'existed' : 'created'}`);
}));

async function loadLead(req, res) {
  const id = parseId(req.params.id);
  const lead = id ? await leads.getLead(db.pool, req.office.id, id, today()) : null;
  if (!lead) notFound(res);
  return lead;
}

const valuesOf = (lead) => ({
  label: lead.label, contact_label: lead.contactLabel || '', phone: lead.phone, source: lead.source,
  budget: lead.budget === null ? '' : money.toDecimal(lead.budget), next_date: lead.next || '', note: lead.note || '',
  assignee: lead.assignedTo ? String(lead.assignedTo) : '', unit_id: lead.unitId ? String(lead.unitId) : '',
});

router.get('/office/leads/:id', guard, wrap(async (req, res) => {
  const lead = await loadLead(req, res);
  if (!lead) return undefined;
  return res.render('leads/form', {
    title: lead.label, action: `/office/leads/${lead.id}`, values: valuesOf(lead), errors: {}, ...(await formLocals(req)), lead, stages: leads.STAGES, message: DONE[req.query.done] || null,
  });
}));

router.post('/office/leads/:id', guard, wrap(async (req, res) => {
  const lead = await loadLead(req, res);
  if (!lead) return undefined;
  const { values, errors } = leads.validateLead(req.body);
  const render = async (errs) => res.status(422).render('leads/form', { title: lead.label, action: `/office/leads/${lead.id}`, values: shown(req.body), errors: errs, ...(await formLocals(req)), lead, stages: leads.STAGES });
  if (Object.keys(errors).length) return render(errors);
  const result = await leads.updateLead(db.pool, req.office.id, lead.id, { values, actorId: req.user.id, ip: req.ip });
  if (result.notFound) return notFound(res);
  if (!result.ok) return render(result.errors);
  return res.redirect(`/office/leads/${lead.id}?done=saved`);
}));

router.post('/office/leads/:id/stage', guard, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const result = await leads.moveLead(db.pool, req.office.id, id, { stage: String(req.body.stage || ''), actorId: req.user.id, ip: req.ip });
  if (result.notFound) return notFound(res);
  if (!result.ok) return res.status(422).redirect(`/office/leads/${id}`);
  return res.redirect(req.body.back === 'lead' ? `/office/leads/${id}?done=moved` : '/office/leads?done=moved');
}));

module.exports = router;
