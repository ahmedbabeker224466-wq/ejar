'use strict';

// Every read or write of office-owned data goes through scopeToOffice(), which
// pins the query to one office. It throws instead of running an unscoped query,
// so a coding mistake fails loudly rather than leaking another office's rows.
//
//   const scoped = scopeToOffice(pool, req.session.officeId);
//   const units = await scoped.select('units', { status: 'vacant' });
//   await scoped.insert('landlords', { label: 'أبو فهد' });
//   await scoped.query('SELECT COUNT(*) AS n FROM contracts WHERE office_id = :office_id');

class OfficeScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfficeScopeError';
  }
}

/** Tables that carry office_id NOT NULL. */
const OFFICE_TABLES = new Set([
  'office_members',
  'office_branches',
  'office_settings',
  'office_secrets',
  'landlords',
  'buildings',
  'units',
  'contracts',
  'contract_payments',
  'contract_documents',
  'extraction_jobs',
  'ai_reads_usage',
  'invites',
  'vendors',
  'maintenance_requests',
  'listings',
  'listing_inquiries',
  'subscriptions',
  'subscription_invoices',
  'platform_payments',
  'promo_usages',
  'reminders',
  'conversations',
  'tickets',
  'staff_activity',
  'office_tasks',
  'internal_notes',
]);

/** Office-owned tables without office_id: scoped through their parent row. */
const CHILD_TABLES = {
  unit_photos: { parent: 'units', key: 'unit_id' },
  unit_amenities: { parent: 'units', key: 'unit_id' },
  contract_members: { parent: 'contracts', key: 'contract_id' },
  contract_events: { parent: 'contracts', key: 'contract_id' },
  contract_notices: { parent: 'contracts', key: 'contract_id' },
  contract_renewals: { parent: 'contracts', key: 'old_contract_id' },
  maintenance_messages: { parent: 'maintenance_requests', key: 'request_id' },
  maintenance_photos: { parent: 'maintenance_requests', key: 'request_id' },
  listing_views: { parent: 'listings', key: 'listing_id' },
  messages: { parent: 'conversations', key: 'conversation_id' },
  ticket_messages: { parent: 'tickets', key: 'ticket_id' },
};

const ALL_SCOPED = new Set([...OFFICE_TABLES, ...Object.keys(CHILD_TABLES)]);
const TABLE_PATTERN = new RegExp(`\\b(${[...ALL_SCOPED].join('|')})\\b`, 'i');
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ORDER_BY = /^[a-z_][a-z0-9_]*( (ASC|DESC))?$/i;

function identifier(name) {
  if (!IDENTIFIER.test(name)) throw new OfficeScopeError(`Invalid identifier: ${name}`);
  return `\`${name}\``;
}

function assertOfficeId(officeId) {
  const id = typeof officeId === 'string' && /^\d+$/.test(officeId) ? Number(officeId) : officeId;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new OfficeScopeError('Refusing to query office data without a valid office_id');
  }
  return id;
}

function assertScopedTable(table) {
  if (!ALL_SCOPED.has(table)) {
    throw new OfficeScopeError(
      `${table} is not an office-owned table; query it without scopeToOffice()`,
    );
  }
}

/**
 * Returns query helpers pinned to one office. Throws immediately when officeId
 * is missing or invalid.
 */
function scopeToOffice(pool, officeId) {
  const id = assertOfficeId(officeId);

  /** WHERE clause that limits a table to this office, plus extra equality filters. */
  function scopedWhere(table, where) {
    const clauses = [];
    const params = [];
    const child = CHILD_TABLES[table];
    if (child) {
      clauses.push(
        `${identifier(child.key)} IN (SELECT id FROM ${identifier(child.parent)} WHERE office_id = ?)`,
      );
    } else {
      clauses.push('`office_id` = ?');
    }
    params.push(id);

    for (const [column, value] of Object.entries(where || {})) {
      if (column === 'office_id') continue; // already pinned
      if (value === null) {
        clauses.push(`${identifier(column)} IS NULL`);
      } else {
        clauses.push(`${identifier(column)} = ?`);
        params.push(value);
      }
    }
    return { sql: clauses.join(' AND '), params };
  }

  /** For child tables: the parent row must belong to this office. */
  async function assertParentInOffice(table, parentId) {
    const child = CHILD_TABLES[table];
    const [rows] = await pool.query(
      `SELECT 1 FROM ${identifier(child.parent)} WHERE id = ? AND office_id = ? LIMIT 1`,
      [parentId, id],
    );
    if (rows.length === 0) {
      throw new OfficeScopeError(`${child.parent} ${parentId} does not belong to office ${id}`);
    }
  }

  function assertNoOfficeChange(data) {
    if ('office_id' in data && Number(data.office_id) !== id) {
      throw new OfficeScopeError('Refusing to write a row into another office');
    }
  }

  return {
    officeId: id,

    async select(table, where = {}, { columns = ['*'], orderBy, limit } = {}) {
      assertScopedTable(table);
      const cols = columns.map((c) => (c === '*' ? '*' : identifier(c))).join(', ');
      const { sql, params } = scopedWhere(table, where);
      let query = `SELECT ${cols} FROM ${identifier(table)} WHERE ${sql}`;
      if (orderBy) {
        if (!ORDER_BY.test(orderBy)) throw new OfficeScopeError(`Invalid orderBy: ${orderBy}`);
        const [column, direction = 'ASC'] = orderBy.split(' ');
        query += ` ORDER BY ${identifier(column)} ${direction.toUpperCase()}`;
      }
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1) throw new OfficeScopeError('Invalid limit');
        query += ` LIMIT ${limit}`;
      }
      const [rows] = await pool.query(query, params);
      return rows;
    },

    async selectOne(table, where = {}, options = {}) {
      const rows = await this.select(table, where, { ...options, limit: 1 });
      return rows[0] || null;
    },

    async insert(table, data) {
      assertScopedTable(table);
      assertNoOfficeChange(data);
      const row = { ...data };
      const child = CHILD_TABLES[table];
      if (child) {
        await assertParentInOffice(table, row[child.key]);
        delete row.office_id;
      } else {
        row.office_id = id;
      }
      const columns = Object.keys(row);
      if (columns.length === 0) throw new OfficeScopeError('Nothing to insert');
      const [result] = await pool.query(
        `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(', ')}) VALUES (${columns
          .map(() => '?')
          .join(', ')})`,
        columns.map((c) => row[c]),
      );
      return result.insertId;
    },

    async update(table, where, data) {
      assertScopedTable(table);
      if (!where || Object.keys(where).length === 0) {
        throw new OfficeScopeError('Refusing to update without a WHERE condition');
      }
      assertNoOfficeChange(data);
      const changes = { ...data };
      delete changes.office_id;
      const child = CHILD_TABLES[table];
      if (child && child.key in changes) await assertParentInOffice(table, changes[child.key]);
      const columns = Object.keys(changes);
      if (columns.length === 0) throw new OfficeScopeError('Nothing to update');
      const { sql, params } = scopedWhere(table, where);
      const [result] = await pool.query(
        `UPDATE ${identifier(table)} SET ${columns.map((c) => `${identifier(c)} = ?`).join(', ')} WHERE ${sql}`,
        [...columns.map((c) => changes[c]), ...params],
      );
      return result.affectedRows;
    },

    async remove(table, where) {
      assertScopedTable(table);
      if (!where || Object.keys(where).length === 0) {
        throw new OfficeScopeError('Refusing to delete without a WHERE condition');
      }
      const { sql, params } = scopedWhere(table, where);
      const [result] = await pool.query(`DELETE FROM ${identifier(table)} WHERE ${sql}`, params);
      return result.affectedRows;
    },

    /**
     * Raw SQL for joins and reports. Any query touching an office-owned table
     * must use the :office_id placeholder, which is bound to this office.
     */
    async query(sql, params = []) {
      if (TABLE_PATTERN.test(sql) && !sql.includes(':office_id')) {
        throw new OfficeScopeError('Raw queries on office-owned tables must filter by :office_id');
      }
      const parts = sql.split(':office_id');
      const bound = [];
      let positional = 0;
      let text = parts[0];
      // Re-thread parameters: each :office_id becomes ? bound to this office,
      // interleaved correctly with the caller's own ? placeholders.
      for (let i = 1; i < parts.length; i += 1) {
        const before = (parts[i - 1].match(/\?/g) || []).length;
        bound.push(...params.slice(positional, positional + before), id);
        positional += before;
        text += '?' + parts[i];
      }
      bound.push(...params.slice(positional));
      const [rows] = await pool.query(text, bound);
      return rows;
    },
  };
}

module.exports = { scopeToOffice, OfficeScopeError, OFFICE_TABLES, CHILD_TABLES };
