'use strict';

const db = require('../config/db');
const logger = require('../utils/logger');

// High-frequency actions that would flood audit_logs without adding value.
const SKIPPED_ACTIONS = new Set(['page.view', 'activity.ping', 'staff.activity', 'session.refresh']);

// Never write these into the audit trail, even when they appear in before/after.
const SECRET_KEYS = new Set([
  'password',
  'code',
  'code_hash',
  'token',
  'token_id',
  'twofa_secret',
  'secret_value',
  'raw_payload',
]);

function redact(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = {};
  for (const [key, v] of Object.entries(value)) {
    copy[key] = SECRET_KEYS.has(key) ? '[redacted]' : v;
  }
  return copy;
}

function createAudit(pool) {
  /**
   * Records who did what. Never throws: a failed audit write is logged and the
   * user's action continues.
   */
  async function log(actorId, officeId, action, entityType, entityId, before, after, ip) {
    if (SKIPPED_ACTIONS.has(action)) return false;
    try {
      const b = redact(before);
      const a = redact(after);
      await pool.query(
        `INSERT INTO audit_logs
           (office_id, actor_id, action, entity_type, entity_id, before_json, after_json, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          officeId || null,
          actorId || null,
          action,
          entityType,
          entityId || null,
          b === null ? null : JSON.stringify(b),
          a === null ? null : JSON.stringify(a),
          ip || null,
        ],
      );
      return true;
    } catch (err) {
      logger.error(`Audit write failed for ${action}: ${err.code || err.message}`);
      return false;
    }
  }

  return { log };
}

module.exports = { ...createAudit(db.pool), createAudit, SKIPPED_ACTIONS };
