'use strict';

// Per-contract message threads between the office, the landlord and the
// tenant(s) of one contract. Plain text only (at most 1000 characters,
// escaped when shown), no attachments. Who may read and write is decided only
// from database links (office membership, landlords.user_id, contract_members),
// never from request input.
//
// Notifications say "you have a new message" with the unit nickname; they
// never contain the message text. A message can be deleted by its author
// within 5 minutes (soft delete: the text is blanked, the row stays).

const { scopeToOffice } = require('./scopeToOffice');
const { createNotification } = require('./notifications');
const { createAudit } = require('./audit');
const { hoursAfter } = require('./contractDates');
const team = require('./team');

const MAX_LENGTH = 1000;
const DELETE_MINUTES = 5;
const PAGE_MESSAGES = 100;
const LINKS = {
  office: (contractId) => `/office/messages/${contractId}`,
  landlord: (contractId) => `/landlord/messages/${contractId}`,
  tenant: (contractId) => `/tenant/messages/${contractId}`,
};

/** Checks a message. Returns { value } or { error }. */
function validateBody(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) return { error: 'اكتب رسالتك أولاً.' };
  if (text.length > MAX_LENGTH) return { error: `الرسالة ${MAX_LENGTH} حرف كحد أقصى.` };
  return { value: text };
}

// ------------------------------------------------------------ access

const CONTRACT_COLUMNS = `c.id, c.landlord_id, c.created_by, c.status, c.start_date, c.end_date, u.label AS unit_label`;
const CONTRACT_FROM = `FROM contracts c LEFT JOIN units u ON u.id = c.unit_id AND u.office_id = :office_id`;

async function contractIn(pool, officeId, contractId) {
  if (!contractId) return null;
  const [row] = await scopeToOffice(pool, officeId).query(
    `SELECT ${CONTRACT_COLUMNS} ${CONTRACT_FROM} WHERE c.id = ? AND c.office_id = :office_id`,
    [contractId],
  );
  return row || null;
}

/**
 * The contract thread this viewer may use, or null. viewer: { kind: 'office',
 * officeId } | { kind: 'landlord', links } | { kind: 'tenant', links } (links
 * come from services/memberships.js). Returns { officeId, contract, kind }.
 */
async function accessFor(pool, viewer, contractId) {
  if (viewer.kind === 'office') {
    const contract = await contractIn(pool, viewer.officeId, contractId);
    return contract ? { officeId: Number(viewer.officeId), contract, kind: 'office' } : null;
  }
  for (const link of viewer.links) {
    const contract = await contractIn(pool, link.office_id, contractId);
    if (!contract) continue;
    if (viewer.kind === 'landlord' && Number(contract.landlord_id) === Number(link.landlord_id)) return { officeId: link.office_id, contract, kind: 'landlord', link };
    if (viewer.kind === 'tenant' && Number(contract.id) === Number(link.contract_id)) return { officeId: link.office_id, contract, kind: 'tenant', link };
  }
  return null;
}

/** The thread row of a contract, created on first use. */
async function conversationFor(pool, officeId, contractId, { create = true } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const find = async () => (await scoped.query('SELECT * FROM conversations WHERE contract_id = ? AND office_id = :office_id', [contractId]))[0] || null;
  let row = await find();
  if (!row && create) {
    await scoped.query('INSERT IGNORE INTO conversations (office_id, contract_id) VALUES (:office_id, ?)', [contractId]);
    row = await find();
  }
  return row;
}

// ------------------------------------------------------------ reading

/** The messages of a thread (oldest first, the latest 100), with who wrote them. */
async function messagesOf(pool, officeId, conversationId, viewerUserId, now = new Date()) {
  const rows = await scopeToOffice(pool, officeId).query(
    `SELECT m.id, m.sender_id, m.sender_role, m.body, m.created_at, m.deleted_at, u.name, u.phone
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND m.conversation_id IN (SELECT id FROM conversations WHERE office_id = :office_id)
      ORDER BY m.id DESC LIMIT ${PAGE_MESSAGES}`,
    [conversationId],
  );
  return rows.reverse().map((m) => {
    const mine = Number(m.sender_id) === Number(viewerUserId);
    return {
      id: Number(m.id),
      role: m.sender_role,
      mine,
      deleted: Boolean(m.deleted_at),
      body: m.deleted_at ? '' : m.body,
      createdAt: m.created_at,
      author: m.sender_role === 'office' ? team.displayName(m) : m.sender_role === 'landlord' ? 'المالك' : 'المستأجر',
      canDelete: mine && !m.deleted_at && hoursAfter(new Date(m.created_at), DELETE_MINUTES / 60).getTime() > now.getTime(),
    };
  });
}

/** Marks everything in the thread as read for this person. */
async function markRead(pool, officeId, conversationId, userId) {
  const scoped = scopeToOffice(pool, officeId);
  const [last] = await scoped.query(
    'SELECT COALESCE(MAX(m.id), 0) AS id FROM messages m WHERE m.conversation_id = ? AND m.conversation_id IN (SELECT id FROM conversations WHERE office_id = :office_id)',
    [conversationId],
  );
  await scoped.query(
    `INSERT INTO message_reads (user_id, conversation_id, last_read_id)
     SELECT ?, c.id, ? FROM conversations c WHERE c.id = ? AND c.office_id = :office_id
     ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))`,
    [userId, Number(last.id), conversationId],
  );
}

const UNREAD_SQL = `(SELECT COUNT(*) FROM messages m
    WHERE m.conversation_id = cv.id AND m.deleted_at IS NULL AND m.sender_id <> ?
      AND m.id > COALESCE((SELECT r.last_read_id FROM message_reads r WHERE r.conversation_id = cv.id AND r.user_id = ?), 0))`;

/**
 * Threads for a list page: each of the viewer's contracts with its thread
 * state and unread count. Office: existing threads, most recent first.
 * Landlord and tenant: their contracts (so they can start a thread).
 */
async function listFor(pool, viewer, userId) {
  const base = (officeId, where, params) => scopeToOffice(pool, officeId).query(
    `SELECT ${CONTRACT_COLUMNS}, cv.id AS conversation_id, cv.last_message_at, cv.office_muted,
            ${UNREAD_SQL} AS unread
       ${CONTRACT_FROM}
       LEFT JOIN conversations cv ON cv.contract_id = c.id AND cv.office_id = :office_id
      WHERE c.office_id = :office_id ${where}
      ORDER BY (cv.last_message_at IS NULL), cv.last_message_at DESC, c.id DESC LIMIT 100`,
    [userId, userId, ...params],
  );
  const shape = (rows, extra = {}) => rows.map((r) => ({ ...r, id: Number(r.id), unread: Number(r.unread || 0), muted: Boolean(Number(r.office_muted)), ...extra }));
  if (viewer.kind === 'office') {
    return shape(await base(viewer.officeId, 'AND cv.id IS NOT NULL', []));
  }
  const all = [];
  for (const link of viewer.links) {
    const rows = viewer.kind === 'landlord'
      ? await base(link.office_id, 'AND c.landlord_id = ?', [link.landlord_id])
      : await base(link.office_id, 'AND c.id = ?', [link.contract_id]);
    all.push(...shape(rows, { officeName: link.office_name }));
  }
  return all.sort((a, b) => (b.unread - a.unread) || (String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''))));
}

/** Total unread messages across the viewer's threads. */
async function unreadTotal(pool, viewer, userId) {
  return (await listFor(pool, viewer, userId)).reduce((sum, t) => sum + t.unread, 0);
}

// ------------------------------------------------------------ recipients and sending

/** Everyone else in the thread, from the database: [{ kind, userId }]. */
async function participants(pool, officeId, contract, conversation) {
  const scoped = scopeToOffice(pool, officeId);
  const out = [];
  if (!Number(conversation.office_muted)) {
    const members = await team.listMembers(pool, officeId, { activeOnly: true });
    const active = new Set(members.map((m) => m.user_id));
    const [office] = await pool.query('SELECT owner_id FROM offices WHERE id = ?', [officeId]).then(([rows]) => rows);
    const inCharge = Number(contract.created_by) && active.has(Number(contract.created_by)) ? Number(contract.created_by) : Number(office && office.owner_id);
    const writers = await scoped.query(
      `SELECT DISTINCT m.sender_id FROM messages m
        WHERE m.conversation_id = ? AND m.sender_role = 'office' AND m.conversation_id IN (SELECT id FROM conversations WHERE office_id = :office_id)`,
      [conversation.id],
    );
    const ids = new Set([inCharge, ...writers.map((w) => Number(w.sender_id))].filter((id) => id && active.has(id)));
    for (const id of ids) out.push({ kind: 'office', userId: id });
  }
  if (contract.landlord_id) {
    const [landlord] = await scoped.query('SELECT user_id FROM landlords WHERE id = ? AND is_active = 1 AND user_id IS NOT NULL AND office_id = :office_id', [contract.landlord_id]);
    if (landlord) out.push({ kind: 'landlord', userId: Number(landlord.user_id) });
  }
  const tenants = await scoped.query(
    `SELECT cm.user_id FROM contract_members cm
      WHERE cm.contract_id = ? AND cm.role = 'tenant' AND cm.contract_id IN (SELECT id FROM contracts WHERE office_id = :office_id)`,
    [contract.id],
  );
  for (const t of tenants) out.push({ kind: 'tenant', userId: Number(t.user_id) });
  return out;
}

/**
 * Stores a message and notifies the others. role: 'office' | 'landlord' |
 * 'tenant'. Returns { ok: true, id } or { ok: false, error: 'invalid', message }.
 */
async function send(pool, officeId, { contract, userId, role, body, ip }) {
  const checked = validateBody(body);
  if (checked.error) return { ok: false, error: 'invalid', message: checked.error };
  const scoped = scopeToOffice(pool, officeId);
  const conversation = await conversationFor(pool, officeId, contract.id);
  const id = await scoped.insert('messages', { conversation_id: conversation.id, sender_id: userId, sender_role: role, body: checked.value });
  await scoped.query('UPDATE conversations SET last_message_at = UTC_TIMESTAMP() WHERE id = ? AND office_id = :office_id', [conversation.id]);
  await markRead(pool, officeId, conversation.id, userId);
  for (const person of await participants(pool, officeId, contract, conversation)) {
    if (person.userId === Number(userId)) continue;
    await createNotification(pool, {
      userId: person.userId,
      officeId,
      kind: 'message_new',
      title: `رسالة جديدة: ${contract.unit_label || 'عقد'}`,
      body: `وصلتك رسالة جديدة في محادثة عقد ${contract.unit_label || ''}. افتحها للرد.`,
      link: LINKS[person.kind](contract.id),
      contractId: contract.id,
      dedupeKey: `message_new:m${id}:u${person.userId}`,
    });
  }
  return { ok: true, id };
}

/** The author deletes their own message within 5 minutes. Returns true when it changed. */
async function deleteOwn(pool, officeId, { conversationId, messageId, userId, ip, now = new Date() }) {
  const scoped = scopeToOffice(pool, officeId);
  const [row] = await scoped.query(
    `SELECT m.id, m.sender_id, m.created_at, m.deleted_at FROM messages m
      WHERE m.id = ? AND m.conversation_id = ? AND m.conversation_id IN (SELECT id FROM conversations WHERE office_id = :office_id)`,
    [messageId, conversationId],
  );
  if (!row || row.deleted_at || Number(row.sender_id) !== Number(userId)) return false;
  if (hoursAfter(new Date(row.created_at), DELETE_MINUTES / 60).getTime() <= now.getTime()) return false;
  const result = await scoped.query(
    `UPDATE messages SET deleted_at = UTC_TIMESTAMP(), body = ''
      WHERE id = ? AND conversation_id = ? AND sender_id = ? AND deleted_at IS NULL
        AND conversation_id IN (SELECT id FROM conversations WHERE office_id = :office_id)`,
    [messageId, conversationId, userId],
  );
  if (result.affectedRows !== 1) return false;
  await createAudit(pool).log(userId, officeId, 'message.delete', 'message', messageId, null, { conversation_id: conversationId }, ip);
  return true;
}

/** Office staff mute or unmute a thread (no notifications to office members while muted). */
async function setMuted(pool, officeId, { contractId, muted, userId, ip }) {
  const conversation = await conversationFor(pool, officeId, contractId);
  await scopeToOffice(pool, officeId).query(
    'UPDATE conversations SET office_muted = ? WHERE id = ? AND office_id = :office_id',
    [muted ? 1 : 0, conversation.id],
  );
  await createAudit(pool).log(userId, officeId, muted ? 'conversation.mute' : 'conversation.unmute', 'contract', contractId, null, null, ip);
  return muted;
}

module.exports = {
  MAX_LENGTH,
  DELETE_MINUTES,
  validateBody,
  accessFor,
  conversationFor,
  messagesOf,
  markRead,
  listFor,
  unreadTotal,
  participants,
  send,
  deleteOwn,
  setMuted,
};
