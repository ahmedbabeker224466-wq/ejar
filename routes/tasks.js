'use strict';

// /office/tasks: the internal task board (todo / doing / done), task pages with
// comments. Capability 'tasks' (every office role). Mounted inside
// routes/office.js: req.office comes from loadOffice and every query is
// scoped to it. Landlords and tenants have no access.

const express = require('express');
const db = require('../config/db');
const tasks = require('../services/tasks');
const team = require('../services/team');
const { parseId } = require('../services/landlords');
const { riyadhDate } = require('../services/contractDates');
const { riyadhNow } = require('../utils/time');
const { requirePerm } = require('../middleware/permissions');

const router = express.Router();
const guard = requirePerm('tasks');
const today = () => riyadhDate(new Date());

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const DONE = { created: 'تمت إضافة المهمة.', saved: 'تم حفظ المهمة.', moved: 'تم نقل المهمة.', commented: 'تمت إضافة التعليق.' };
const NEXT = { todo: [['doing', 'ابدأ'], ['done', 'أنجزت']], doing: [['todo', 'إعادة'], ['done', 'أنجزت']], done: [['todo', 'إعادة فتح']] };

const blankForm = { title: '', description: '', due_date: '', link_type: '', link_id: '', assignee: '' };

async function renderBoard(req, res, { status = 200, errors = {}, values = blankForm } = {}) {
  const assignee = req.query.assignee === 'me' ? 'me' : '';
  return res.status(status).render('tasks/board', {
    title: 'مهام المكتب',
    columns: await tasks.board(db.pool, req.office.id, { userId: req.user.id, assignee, today: today() }),
    members: await team.listMembers(db.pool, req.office.id, { activeOnly: true }),
    statuses: tasks.STATUSES,
    linkTypes: tasks.LINK_TYPES,
    next: NEXT,
    assignee,
    values,
    errors,
    limits: tasks.LIMITS,
    today: today(),
    message: DONE[req.query.done] || null,
  });
}

router.get('/office/tasks', guard, wrap((req, res) => renderBoard(req, res)));

router.post('/office/tasks', guard, wrap(async (req, res) => {
  const { values, errors } = tasks.validateTask(req.body);
  const shown = { title: String(req.body.title || '').slice(0, 200), description: String(req.body.description || '').slice(0, 1200), due_date: String(req.body.due_date || '').slice(0, 10), link_type: String(req.body.link_type || ''), link_id: String(req.body.link_id || '').slice(0, 12), assignee: String(req.body.assignee || '') };
  if (Object.keys(errors).length) return renderBoard(req, res, { status: 422, errors, values: shown });
  const result = await tasks.createTask(db.pool, req.office.id, { values, actorId: req.user.id, today: today(), ip: req.ip });
  if (!result.ok) return renderBoard(req, res, { status: 422, errors: result.errors, values: shown });
  return res.redirect('/office/tasks?done=created');
}));

async function renderTask(req, res, { task, status = 200, errors = {}, values = null, commentError = null }) {
  return res.status(status).render('tasks/show', {
    title: `مهمة رقم ${task.id}`,
    task,
    comments: (await tasks.commentsFor(db.pool, req.office.id, task.id)).map((c) => ({ ...c, at: riyadhNow(new Date(c.created_at)).slice(0, 16) })),
    members: await team.listMembers(db.pool, req.office.id, { activeOnly: true }),
    statuses: tasks.STATUSES,
    linkTypes: tasks.LINK_TYPES,
    next: NEXT,
    values: values || {
      title: task.title, description: task.description || '', due_date: task.due || '', link_type: task.entity_type || '', link_id: task.entity_id ? String(task.entity_id) : '', assignee: task.assigned_to ? String(task.assigned_to) : '',
    },
    errors,
    commentError,
    limits: tasks.LIMITS,
    today: today(),
    message: DONE[req.query.done] || null,
  });
}

async function loadTask(req, res) {
  return tasks.getTask(db.pool, req.office.id, parseId(req.params.id), today());
}

router.get('/office/tasks/:id', guard, wrap(async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return notFound(res);
  return renderTask(req, res, { task });
}));

router.post('/office/tasks/:id', guard, wrap(async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return notFound(res);
  const { values, errors } = tasks.validateTask(req.body);
  const shown = { title: String(req.body.title || '').slice(0, 200), description: String(req.body.description || '').slice(0, 1200), due_date: String(req.body.due_date || '').slice(0, 10), link_type: String(req.body.link_type || ''), link_id: String(req.body.link_id || '').slice(0, 12), assignee: String(req.body.assignee || '') };
  if (Object.keys(errors).length) return renderTask(req, res, { task, status: 422, errors, values: shown });
  const result = await tasks.updateTask(db.pool, req.office.id, { id: task.id, values, actorId: req.user.id, today: today(), ip: req.ip });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) return renderTask(req, res, { task, status: 422, errors: result.errors, values: shown });
  return res.redirect(`/office/tasks/${task.id}?done=saved`);
}));

router.post('/office/tasks/:id/status', guard, wrap(async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return notFound(res);
  const result = await tasks.moveTask(db.pool, req.office.id, { id: task.id, status: String(req.body.status || ''), actorId: req.user.id, ip: req.ip });
  if (!result.ok) return res.status(422).render('tasks/error', { title: 'تعذر نقل المهمة', message: 'الحالة غير صحيحة.', back: '/office/tasks' });
  const back = String(req.body.back || '') === 'task' ? `/office/tasks/${task.id}?done=moved` : '/office/tasks?done=moved';
  return res.redirect(back);
}));

router.post('/office/tasks/:id/comments', guard, wrap(async (req, res) => {
  const task = await loadTask(req, res);
  if (!task) return notFound(res);
  const result = await tasks.addComment(db.pool, req.office.id, { taskId: task.id, body: req.body.body, actorId: req.user.id, today: today(), ip: req.ip });
  if (result.error === 'not_found') return notFound(res);
  if (!result.ok) {
    return renderTask(req, res, { task, status: 422, commentError: result.error === 'too_long' ? `التعليق ${tasks.LIMITS.comment} حرف كحد أقصى.` : 'اكتب تعليقاً.' });
  }
  return res.redirect(`/office/tasks/${task.id}?done=commented#comments`);
}));

module.exports = router;
