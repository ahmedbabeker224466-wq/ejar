'use strict';

// Per-contract message threads: /office/messages (office), /landlord/messages
// and /tenant/messages. `office` is mounted in routes/office.js (after
// loadOffice), `portal` in routes/areas.js. Participation comes only from
// database links (services/threads.js accessFor); an id outside them is 404.

const express = require('express');
const db = require('../config/db');
const threads = require('../services/threads');
const { parseId } = require('../services/landlords');
const { riyadhNow } = require('../utils/time');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../middleware/permissions');
const { rateLimit } = require('../middleware/rateLimit');
const { loadArea } = require('./portal');

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notFound(res) {
  return res.status(404).render('errors/404', { title: 'الصفحة غير موجودة' });
}

const stamp = (at) => riyadhNow(new Date(at)).slice(0, 16);
const ROLE = { office: 'office', landlord: 'landlord', tenant: 'tenant' };
const DONE = { muted: 'تم كتم المحادثة. لن تصلك إشعارات عنها.', unmuted: 'تم إلغاء الكتم.', deleted: 'تم حذف الرسالة.' };

// 10 messages per minute per person, across all threads.
const sendLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyFor: (req) => `message:${req.user.id}`,
  onLimit: async (req, res) => {
    const found = await threads.accessFor(db.pool, req.viewer, parseId(req.params.contractId));
    if (!found) return notFound(res);
    return renderThread(req, res, { kind: req.threadKind, found, status: 429, error: 'أرسلت رسائل كثيرة. انتظر دقيقة ثم حاول مرة أخرى.', draft: String(req.body.body || '').slice(0, threads.MAX_LENGTH) });
  },
});

async function renderThread(req, res, { kind, found, status = 200, error = null, draft = '' }) {
  const conversation = await threads.conversationFor(db.pool, found.officeId, found.contract.id, { create: true });
  const messages = await threads.messagesOf(db.pool, found.officeId, conversation.id, req.user.id);
  if (status === 200) await threads.markRead(db.pool, found.officeId, conversation.id, req.user.id);
  const base = `/${kind}/messages/${found.contract.id}`;
  return res.status(status).render('messages/thread', {
    title: `محادثة: ${found.contract.unit_label || 'عقد'}`,
    kind,
    contract: found.contract,
    conversation,
    muted: Boolean(Number(conversation.office_muted)),
    messages: messages.map((m) => ({ ...m, at: stamp(m.createdAt) })),
    base,
    listUrl: `/${kind}/messages`,
    maxLength: threads.MAX_LENGTH,
    error,
    draft,
    message: DONE[req.query.done] || null,
  });
}

async function renderList(req, res, { kind, viewer }) {
  const rows = await threads.listFor(db.pool, viewer, req.user.id);
  return res.render('messages/list', {
    title: 'الرسائل',
    kind,
    rows: rows.map((r) => ({ ...r, at: r.last_message_at ? stamp(r.last_message_at) : null })),
    base: `/${kind}/messages`,
  });
}

function handlers(kind, getViewer) {
  const viewerOf = (req) => getViewer(req);
  return {
    list: wrap((req, res) => renderList(req, res, { kind, viewer: viewerOf(req) })),
    thread: wrap(async (req, res) => {
      const found = await threads.accessFor(db.pool, viewerOf(req), parseId(req.params.contractId));
      if (!found) return notFound(res);
      return renderThread(req, res, { kind, found });
    }),
    send: wrap(async (req, res) => {
      const found = await threads.accessFor(db.pool, req.viewer, parseId(req.params.contractId));
      if (!found) return notFound(res);
      const result = await threads.send(db.pool, found.officeId, { contract: found.contract, userId: req.user.id, role: ROLE[kind], body: req.body.body, ip: req.ip });
      if (!result.ok) return renderThread(req, res, { kind, found, status: 422, error: result.message, draft: String(req.body.body || '').slice(0, threads.MAX_LENGTH) });
      return res.redirect(`/${kind}/messages/${found.contract.id}#end`);
    }),
    remove: wrap(async (req, res) => {
      const found = await threads.accessFor(db.pool, viewerOf(req), parseId(req.params.contractId));
      const messageId = parseId(req.params.messageId);
      if (!found || !messageId) return notFound(res);
      const conversation = await threads.conversationFor(db.pool, found.officeId, found.contract.id, { create: false });
      if (!conversation) return notFound(res);
      const ok = await threads.deleteOwn(db.pool, found.officeId, { conversationId: conversation.id, messageId, userId: req.user.id, ip: req.ip });
      if (!ok) return renderThread(req, res, { kind, found, status: 409, error: 'يمكنك حذف رسالتك فقط خلال 5 دقائق من إرسالها.' });
      return res.redirect(`/${kind}/messages/${found.contract.id}?done=deleted`);
    }),
  };
}

// ------------------------------------------------------------ office

const office = express.Router();
const setOffice = (req, res, next) => {
  req.viewer = { kind: 'office', officeId: req.office.id };
  req.threadKind = 'office';
  next();
};
const o = handlers('office', (req) => ({ kind: 'office', officeId: req.office.id }));
const officePerm = [requirePerm('messages'), setOffice];

office.get('/office/messages', ...officePerm, o.list);
office.get('/office/messages/:contractId', ...officePerm, o.thread);
office.post('/office/messages/:contractId', ...officePerm, sendLimit, o.send);
office.post('/office/messages/:contractId/mute', ...officePerm, wrap(async (req, res) => {
  const contractId = parseId(req.params.contractId);
  const found = await threads.accessFor(db.pool, req.viewer, contractId);
  if (!found) return notFound(res);
  const muted = String(req.body.muted) === '1';
  await threads.setMuted(db.pool, req.office.id, { contractId, muted, userId: req.user.id, ip: req.ip });
  return res.redirect(`/office/messages/${contractId}?done=${muted ? 'muted' : 'unmuted'}`);
}));
office.post('/office/messages/:contractId/:messageId/delete', ...officePerm, o.remove);

// ------------------------------------------------------------ landlord and tenant

const portal = express.Router();

for (const kind of ['landlord', 'tenant']) {
  const area = [requireAuth, loadArea(kind)];
  const perm = requirePerm(kind === 'landlord' ? 'messages' : 'messages');
  const setViewer = (req, res, next) => {
    req.viewer = { kind, links: req.links };
    req.threadKind = kind;
    next();
  };
  const h = handlers(kind, (req) => ({ kind, links: req.links }));
  const chain = [...area, perm, setViewer];
  portal.get(`/${kind}/messages`, ...chain, h.list);
  portal.get(`/${kind}/messages/:contractId`, ...chain, h.thread);
  portal.post(`/${kind}/messages/:contractId`, ...chain, sendLimit, h.send);
  portal.post(`/${kind}/messages/:contractId/:messageId/delete`, ...chain, h.remove);
}

module.exports = { office, portal };
