'use strict';

// Sends queued delivery_log rows (email, WhatsApp, Telegram). Each row is
// claimed with an UPDATE before sending, so two workers never send the same
// row. A failure is retried 3 times (1 min, 10 min, 1 hour later), then given
// up as failed. A row that cannot be sent (no address, channel not set up,
// person switched the channel off) is skipped. One channel failing never
// touches the others. delivery_log keeps a status and a short error code
// only: never the text, an address or a secret.

const { scopeToOffice } = require('./scopeToOffice');
const { prefsFor, withDisclaimer } = require('./notifications');
const channelSettings = require('./channelSettings');
const features = require('./features');
const email = require('./channels/email');
const whatsapp = require('./channels/whatsapp');
const telegram = require('./channels/telegram');
const { toE164 } = require('../utils/phone');
const logger = require('../utils/logger');

const BACKOFF_MINUTES = [1, 10, 60];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const CLAIM_MINUTES = 15;

const minutesAfter = (at, n) => new Date(at.getTime() + n * 60000);

async function contactsFor(pool, userId) {
  const [[row]] = await pool.query('SELECT * FROM user_contacts WHERE user_id = ?', [userId]);
  return row || {};
}

/**
 * Sends one message on one channel to one person. officeChannel is the
 * decrypted office settings for WhatsApp / Telegram (or null).
 */
async function sendOne({ channel, user, contacts, officeChannel, title, body }) {
  if (channel === 'email') return email.send({ to: user.email, subject: title, text: body });
  if (channel === 'whatsapp') {
    if (!officeChannel) return { ok: false, error: 'channel_not_configured', skip: true };
    const to = contacts.whatsapp_verified_at && contacts.whatsapp_e164 ? contacts.whatsapp_e164 : null;
    return whatsapp.send({ providerName: officeChannel.provider, config: officeChannel.config, settings: officeChannel.settings, to, title, body });
  }
  if (channel === 'telegram') {
    if (!officeChannel) return { ok: false, error: 'channel_not_configured', skip: true };
    const chatId = contacts.telegram_verified_at ? contacts.telegram_chat_id : null;
    return telegram.send({ token: officeChannel.config.token, chatId, text: `${title}\n\n${body}` });
  }
  return { ok: false, error: 'unknown_channel', skip: true };
}

function officeChannelLoader(pool) {
  const cache = new Map();
  return async (officeId, channel) => {
    if (!officeId || channel === 'email') return null;
    const key = `${officeId}:${channel}`;
    if (!cache.has(key)) {
      try {
        // A plan without the channel sends nothing on it (the row is skipped).
        const allowed = await features.officeAllows(pool, officeId, channel);
        cache.set(key, allowed ? await channelSettings.loadForSending(scopeToOffice(pool, officeId), channel) : null);
      } catch (err) {
        logger.error(`Channel settings unreadable for office ${officeId} (${channel}): ${err.code || 'decrypt_failed'}`);
        cache.set(key, null);
      }
    }
    return cache.get(key);
  };
}

/** The next state of a row after one try. */
function nextState(result, attempts, now) {
  if (result.ok) return { status: 'sent', error_code: null, next_retry_at: null };
  if (result.skip) return { status: 'skipped', error_code: result.error, next_retry_at: null };
  if (result.retryable && attempts < MAX_ATTEMPTS) {
    return { status: 'pending', error_code: result.error, next_retry_at: minutesAfter(now, BACKOFF_MINUTES[attempts - 1]) };
  }
  return { status: 'failed', error_code: result.error, next_retry_at: null };
}

/** Sends due rows. Returns { processed, sent, failed, skipped, retry }. */
async function deliverPending({ pool, now = new Date(), limit = 100 }) {
  const [rows] = await pool.query(
    `SELECT id FROM delivery_log WHERE status = 'pending' AND next_retry_at <= ? ORDER BY next_retry_at, id LIMIT ${Number(limit)}`,
    [now],
  );
  const loadOffice = officeChannelLoader(pool);
  const counts = { processed: 0, sent: 0, failed: 0, skipped: 0, retry: 0 };
  for (const { id } of rows) {
    // Claim: one worker wins; a crash mid-send is retried after CLAIM_MINUTES.
    const [claim] = await pool.query(
      `UPDATE delivery_log SET attempts = attempts + 1, next_retry_at = ?
        WHERE id = ? AND status = 'pending' AND next_retry_at <= ?`,
      [minutesAfter(now, CLAIM_MINUTES), id, now],
    );
    if (claim.affectedRows !== 1) continue;
    counts.processed += 1;
    let state;
    let attempts = 1;
    try {
      const [[row]] = await pool.query(
        `SELECT d.channel, d.attempts, n.user_id, n.office_id, n.kind, n.title, n.body, u.email, u.is_active
           FROM delivery_log d JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.user_id
          WHERE d.id = ?`,
        [id],
      );
      attempts = Number(row.attempts);
      const prefs = await prefsFor(pool, row.user_id);
      let result;
      if (!Number(row.is_active)) result = { ok: false, error: 'user_inactive', skip: true };
      else if (!prefs.channels[row.channel] || prefs.optOuts.has(`${row.channel}:${row.kind}`)) result = { ok: false, error: 'opted_out', skip: true };
      else {
        result = await sendOne({
          channel: row.channel,
          user: row,
          contacts: await contactsFor(pool, row.user_id),
          officeChannel: await loadOffice(row.office_id, row.channel),
          title: row.title,
          body: row.body,
        });
      }
      state = nextState(result, attempts, now);
    } catch (err) {
      logger.error(`Delivery ${id} crashed: ${err.code || err.name}`);
      state = nextState({ ok: false, error: 'internal_error', retryable: true }, attempts, now);
    }
    await pool.query(
      `UPDATE delivery_log SET status = ?, error_code = ?, next_retry_at = ?, sent_at = ${state.status === 'sent' ? 'UTC_TIMESTAMP()' : 'sent_at'}
        WHERE id = ?`,
      [state.status, state.error_code, state.next_retry_at, id],
    );
    if (state.status === 'pending') counts.retry += 1;
    else counts[state.status] += 1;
  }
  return counts;
}

/**
 * "Send a test message to me" from the office settings: one message on one
 * channel, right now, logged like any delivery. Returns the result
 * ({ ok } or { ok: false, error }).
 */
async function sendTest(pool, { officeId, user, channel, officeName }) {
  const title = 'رسالة تجربة من عقدي';
  const body = withDisclaimer(`هذه رسالة تجربة من إعدادات التذكيرات في ${officeName}. إذا وصلتك فالقناة تعمل.`);
  const [insert] = await pool.query(
    "INSERT INTO notifications (user_id, office_id, kind, title, body) VALUES (?, ?, 'test', ?, ?)",
    [user.id, officeId, title, body],
  );
  const officeChannel = channel === 'email' ? null : await officeChannelLoader(pool)(officeId, channel);
  let result;
  try {
    result = await sendOne({ channel, user, contacts: await contactsFor(pool, user.id), officeChannel, title, body });
  } catch (err) {
    result = { ok: false, error: 'internal_error' };
  }
  const status = result.ok ? 'sent' : result.skip ? 'skipped' : 'failed';
  await pool.query(
    `INSERT INTO delivery_log (notification_id, office_id, channel, status, error_code, attempts, sent_at)
     VALUES (?, ?, ?, ?, ?, 1, ${result.ok ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [insert.insertId, officeId, channel, status, result.ok ? null : result.error],
  );
  return result;
}

/** Delivery status counts and the latest notifications of one office (dashboard). */
async function officeDeliverySummary(pool, officeId, { days = 7, limit = 5 } = {}) {
  const scoped = scopeToOffice(pool, officeId);
  const counts = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  const rows = await scoped.query(
    `SELECT status, COUNT(*) AS n FROM delivery_log
      WHERE office_id = :office_id AND created_at > UTC_TIMESTAMP() - INTERVAL ${Number(days)} DAY GROUP BY status`,
  );
  for (const r of rows) counts[r.status] = Number(r.n);
  const latest = await scoped.query(
    `SELECT n.id, n.kind, n.title, n.created_at,
            (SELECT GROUP_CONCAT(CONCAT(d.channel, ':', d.status) ORDER BY d.channel) FROM delivery_log d WHERE d.notification_id = n.id) AS deliveries
       FROM notifications n
      WHERE n.office_id = :office_id AND n.kind <> 'test'
      ORDER BY n.id DESC LIMIT ${Number(limit)}`,
  );
  return {
    counts,
    latest: latest.map((n) => ({
      ...n,
      deliveries: String(n.deliveries || '').split(',').filter(Boolean).map((pair) => {
        const [channel, status] = pair.split(':');
        return { channel, status };
      }),
    })),
  };
}

module.exports = { deliverPending, sendOne, sendTest, nextState, officeDeliverySummary, BACKOFF_MINUTES, MAX_ATTEMPTS };
