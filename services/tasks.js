'use strict';

// Internal tasks of an office (a Kanban board: todo / doing / done). A task has
// a title, description, due date, an assignee (an active team member) and an
// optional link to a contract, unit or maintenance request of the SAME
// office. Comments live in internal_notes (entity_type 'task'). Assigning a
// task notifies the assignee; "due tomorrow" reminders come from the reminder
// engine (services/reminders.js taskReminders), idempotent by dedupe key.
//
// Everything is office-only: landlords and tenants never see tasks.
// Notifications carry the task number and a linked unit nickname, never the
// task text.

const engine = require('./contractEngine');
const { scopeToOffice } = require('./scopeToOffice');
const { createAudit } = require('./audit');
const { createNotification } = require('./notifications');
const team = require('./team');

const STATUSES = { todo: 'للتنفيذ', doing: 'قيد التنفيذ', done: 'منجزة' };
const LINK_TYPES = { contract: 'عقد', unit: 'وحدة', maintenance: 'طلب صيانة' };
const LIMITS = { title: 160, description: 1000, comment: 1000 };
const LINK_TABLES = { contract: 'contracts', unit: 'units', maintenance: 'maintenance_requests' };
const LINK_URLS = { contract: (id) => `/office/contracts/${id}`, unit: (id) => `/office/units/${id}`, maintenance: (id) => `/office/maintenance/${id}` };

const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

function cleanText(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return { text, tooLong: text.length > max };
}

/** Checks the task form. Returns { values, errors }. assignee/link ids are checked against the office later. */
function validateTask(body = {}) {
  const errors = {};
  const title = cleanText(body.title, LIMITS.title);
  const description = cleanText(body.description, LIMITS.description);
  if (!title.text) errors.title = 'اكتب عنوان المهمة.';
  else if (title.tooLong) errors.title = `العنوان ${LIMITS.title} حرفاً كحد أقصى.`;
  if (description.tooLong) errors.description = `الوصف ${LIMITS.description} حرف كحد أقصى.`;
  const dueRaw = String(body.due_date || '').trim();
  if (dueRaw && !engine.isValidDate(dueRaw)) errors.due_date = 'اختر تاريخاً صحيحاً.';
  const linkType = String(body.link_type || '');
  const linkId = Number(body.link_id);
  if (linkType && !has(LINK_TYPES, linkType)) errors.link = 'نوع الربط غير صحيح.';
  else if (linkType && !(Number.isInteger(linkId) && linkId > 0)) errors.link = 'اكتب رقم صحيح للعنصر المرتبط.';
  const assignee = String(body.assignee || '').trim();
  if (assignee && !/^\d{1,12}$/.test(assignee)) errors.assignee = 'اختر عضواً من الفريق.';
  return {
    values: {
      title: title.text,
      description: description.text || null,
      due_date: dueRaw || null,
      link_type: linkType || null,
      link_id: linkType ? linkId : null,
      assignee: assignee ? Number(assignee) : null,
    },
    errors,
  };
}

/** Whether the linked item exists in this office. */
async function linkExists(scoped, type, id) {
  const table = LINK_TABLES[type];
  if (!table) return false;
  const [row] = await scoped.query(`SELECT id FROM ${table} WHERE id = ? AND office_id = :office_id`, [id]);
  return Boolean(row);
}

async function checkRefs(pool, officeId, values) {
  const errors = {};
  const scoped = scopeToOffice(pool, officeId);
  if (values.link_type && !(await linkExists(scoped, values.link_type, values.link_id))) errors.link = 'العنصر المرتبط غير موجود في مكتبك.';
  if (values.assignee !== null) {
    const members = await team.listMembers(pool, officeId, { activeOnly: true });
    if (!members.some((m) => m.user_id === values.assignee)) errors.assignee = 'اختر عضواً فعّالاً من الفريق.';
  }
  return errors;
}

const SELECT_TASK = `
  SELECT t.*, a.name AS assignee_name, a.phone AS assignee_phone, c.name AS creator_name, c.phone AS creator_phone
    FROM office_tasks t
    LEFT JOIN users a ON a.id = t.assigned_to
    LEFT JOIN users c ON c.id = t.created_by`;

function shape(row, today) {
  const due = row.due_date ? String(row.due_date).slice(0, 10) : null;
  return {
    ...row,
    id: Number(row.id),
    due,
    statusLabel: STATUSES[row.status],
    assigneeLabel: row.assigned_to ? team.displayName({ name: row.assignee_name, phone: row.assignee_phone }) : null,
    creatorLabel: row.created_by ? team.displayName({ name: row.creator_name, phone: row.creator_phone }) : null,
    overdue: Boolean(due && row.status !== 'done' && engine.isAfter(today, due)),
    linkLabel: row.entity_type ? LINK_TYPES[row.entity_type] : null,
    linkUrl: row.entity_type ? LINK_URLS[row.entity_type](row.entity_id) : null,
  };
}

/** The board: tasks grouped by status. assignee 'me' keeps the person's own. */
async function board(pool, officeId, { userId, assignee = '', today }) {
  const where = assignee === 'me' ? ' AND t.assigned_to = ?' : '';
  const rows = await scopeToOffice(pool, officeId).query(
    `${SELECT_TASK} WHERE t.office_id = :office_id${where}
      ORDER BY (t.due_date IS NULL), t.due_date, t.id DESC LIMIT 300`,
    assignee === 'me' ? [userId] : [],
  );
  const columns = { todo: [], doing: [], done: [] };
  for (const row of rows) columns[row.status].push(shape(row, today));
  columns.done = columns.done.slice(0, 30);
  return columns;
}

async function getTask(pool, officeId, id, today) {
  if (!id) return null;
  const [row] = await scopeToOffice(pool, officeId).query(`${SELECT_TASK} WHERE t.id = ? AND t.office_id = :office_id`, [id]);
  return row ? shape(row, today) : null;
}

async function notifyAssignee(pool, officeId, task, assigneeId, actorId) {
  if (!assigneeId || Number(assigneeId) === Number(actorId)) return;
  await createNotification(pool, {
    userId: assigneeId,
    officeId,
    kind: 'task_assigned',
    title: `أُسندت إليك مهمة رقم ${task.id}`,
    body: `أُسندت إليك مهمة داخلية في المكتب${task.due ? ` موعدها ${task.due}` : ''}. افتحها لمعرفة التفاصيل.`,
    link: `/office/tasks/${task.id}`,
  });
}

/** Creates a task. Returns { ok, id } or { ok: false, errors }. */
async function createTask(pool, officeId, { values, actorId, today, ip }) {
  const errors = await checkRefs(pool, officeId, values);
  if (Object.keys(errors).length) return { ok: false, errors };
  const id = await scopeToOffice(pool, officeId).insert('office_tasks', {
    title: values.title,
    description: values.description,
    assigned_to: values.assignee,
    due_date: values.due_date,
    entity_type: values.link_type,
    entity_id: values.link_id,
    status: 'todo',
    created_by: actorId,
  });
  await createAudit(pool).log(actorId, officeId, 'task.create', 'office_task', id, null, { assigned_to: values.assignee, due_date: values.due_date, link: values.link_type }, ip);
  await notifyAssignee(pool, officeId, { id, due: values.due_date }, values.assignee, actorId);
  return { ok: true, id };
}

/** Edits a task. Returns { ok } or { ok: false, errors | error: 'not_found' }. */
async function updateTask(pool, officeId, { id, values, actorId, today, ip }) {
  const task = await getTask(pool, officeId, id, today);
  if (!task) return { ok: false, error: 'not_found' };
  const errors = await checkRefs(pool, officeId, values);
  if (Object.keys(errors).length) return { ok: false, errors };
  await scopeToOffice(pool, officeId).query(
    `UPDATE office_tasks SET title = ?, description = ?, assigned_to = ?, due_date = ?, entity_type = ?, entity_id = ?
      WHERE id = ? AND office_id = :office_id`,
    [values.title, values.description, values.assignee, values.due_date, values.link_type, values.link_id, id],
  );
  await createAudit(pool).log(actorId, officeId, 'task.update', 'office_task', id, { assigned_to: task.assigned_to }, { assigned_to: values.assignee, due_date: values.due_date }, ip);
  if (values.assignee !== null && Number(task.assigned_to) !== values.assignee) {
    await notifyAssignee(pool, officeId, { id, due: values.due_date }, values.assignee, actorId);
  }
  return { ok: true };
}

/** Moves a task between columns (any to any). Returns { ok } or { ok: false, error }. */
async function moveTask(pool, officeId, { id, status, actorId, ip }) {
  if (!has(STATUSES, status)) return { ok: false, error: 'invalid' };
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query('SELECT id, status FROM office_tasks WHERE id = ? AND office_id = :office_id', [id]);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status === status) return { ok: true, unchanged: true };
  await scoped.query(
    `UPDATE office_tasks SET status = ?, completed_at = IF(? = 'done', UTC_TIMESTAMP(), NULL) WHERE id = ? AND office_id = :office_id`,
    [status, status, id],
  );
  await createAudit(pool).log(actorId, officeId, 'task.move', 'office_task', id, { status: row.status }, { status }, ip);
  return { ok: true };
}

// ------------------------------------------------------------ comments

async function commentsFor(pool, officeId, taskId) {
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT n.id, n.body, n.created_at, u.name, u.phone FROM internal_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.entity_type = 'task' AND n.entity_id = ? AND n.office_id = :office_id ORDER BY n.id`,
    [taskId],
  );
  return rows.map((r) => ({ ...r, author: team.displayName(r) }));
}

/** Adds a comment (office members only; the task must be in this office). Returns { ok } | { ok: false, error }. */
async function addComment(pool, officeId, { taskId, body, actorId, today, ip }) {
  const task = await getTask(pool, officeId, taskId, today);
  if (!task) return { ok: false, error: 'not_found' };
  const { text, tooLong } = cleanText(body, LIMITS.comment);
  if (!text) return { ok: false, error: 'empty' };
  if (tooLong) return { ok: false, error: 'too_long' };
  const id = await scopeToOffice(pool, officeId).insert('internal_notes', { entity_type: 'task', entity_id: taskId, author_id: actorId, body: text });
  await createAudit(pool).log(actorId, officeId, 'task.comment', 'office_task', taskId, null, { note_id: id }, ip);
  if (task.assigned_to && Number(task.assigned_to) !== Number(actorId)) {
    await createNotification(pool, {
      userId: task.assigned_to,
      officeId,
      kind: 'task_assigned',
      title: `تعليق جديد على المهمة رقم ${taskId}`,
      body: 'أضاف أحد أعضاء الفريق تعليقاً على مهمة مسندة إليك.',
      link: `/office/tasks/${taskId}`,
    });
  }
  return { ok: true, id };
}

module.exports = {
  STATUSES,
  LINK_TYPES,
  LIMITS,
  validateTask,
  checkRefs,
  board,
  getTask,
  createTask,
  updateTask,
  moveTask,
  commentsFor,
  addComment,
};
