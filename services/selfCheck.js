'use strict';

// Startup self-check: what a broken deployment needs to know, in one block.
// Reports variable names only, never their values.

const db = require('../config/db');
const { selectDriver } = require('./sms');
const { adminTwoFactorRequired } = require('./auth');

/** The app cannot serve safely without these. */
const REQUIRED = [
  { name: 'DB_USER' },
  { name: 'DB_NAME' },
  { name: 'JWT_SECRET', valid: (v) => v.length >= 32, rule: 'at least 32 characters' },
  { name: 'SECRET_BOX_KEY', valid: (v) => /^[0-9a-fA-F]{64}$/.test(v), rule: '64 hex characters' },
];

/** Missing these degrades one feature; the site still runs. */
const RECOMMENDED = ['DB_PASSWORD', 'APP_URL', 'CRON_SECRET', 'PLATFORM_ADMIN_PHONE'];

const SMS_NEEDS = {
  unifonic: ['SMS_API_KEY', 'SMS_SENDER'],
  msegat: ['SMS_USERNAME', 'SMS_API_KEY', 'SMS_SENDER'],
};

const present = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/** Pure: which variables are missing or malformed. */
function checkEnv(env = process.env) {
  const missing = [];
  const invalid = [];
  for (const { name, valid, rule } of REQUIRED) {
    if (!present(env, name)) missing.push(name);
    else if (valid && !valid(env[name].trim())) invalid.push(`${name} (${rule})`);
  }
  const warnings = RECOMMENDED.filter((name) => !present(env, name)).map((name) => `${name} is not set`);

  const provider = (env.SMS_PROVIDER || '').trim().toLowerCase();
  for (const name of SMS_NEEDS[provider] || []) {
    if (!present(env, name)) warnings.push(`${name} is not set (needed by SMS_PROVIDER=${provider})`);
  }
  if (provider && !['console', ...Object.keys(SMS_NEEDS)].includes(provider)) {
    warnings.push(`SMS_PROVIDER=${provider} is not a known driver`);
  }
  const ignored = ignoredSettings(env);
  if (!ignored.length && !adminTwoFactorRequired(env)) {
    warnings.push('REQUIRE_ADMIN_2FA=false: platform_admin signs in without 2FA (testing only)');
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, warnings, ignored };
}

/** Pure: settings that were set but deliberately ignored, with the reason. */
function ignoredSettings(env = process.env) {
  const ignored = [];
  const skip = String(env.REQUIRE_ADMIN_2FA ?? '').trim().toLowerCase() === 'false';
  if (skip && env.NODE_ENV === 'production') {
    ignored.push('REQUIRE_ADMIN_2FA=false was ignored because NODE_ENV=production: platform_admin 2FA stays mandatory');
  }
  return ignored;
}

/** Pure: describes the SMS driver that will be used. */
function describeSms(env = process.env) {
  const name = selectDriver(env).name;
  if (name === 'console') return { driver: 'console', real: false, note: 'codes are written to the log, not sent' };
  if (name === 'none') return { driver: 'none', real: false, note: 'no SMS provider configured: login codes cannot be sent' };
  return { driver: name, real: true, note: 'real provider' };
}

/**
 * Runs every check. With ensure=true (startup) it creates missing tables;
 * with ensure=false (diagnostics) it only counts them.
 */
async function run({ env = process.env, pool = db.pool, ensure = true } = {}) {
  const report = {
    time: new Date().toISOString(),
    node: process.version,
    nodeEnv: env.NODE_ENV || 'development',
    env: checkEnv(env),
    database: { connected: false, error: null },
    schema: { ok: false, found: 0, created: 0, total: 0, error: null },
    sms: describeSms(env),
    maintenance: false,
    reasons: [],
  };

  if (report.env.missing.length) report.reasons.push(`missing: ${report.env.missing.join(', ')}`);
  if (report.env.invalid.length) report.reasons.push(`invalid: ${report.env.invalid.join(', ')}`);

  // Without DB settings there is nothing to connect to.
  if (present(env, 'DB_USER') && present(env, 'DB_NAME')) {
    try {
      await pool.query('SELECT 1');
      report.database.connected = true;
    } catch (err) {
      report.database.error = err.code || err.message;
      report.reasons.push(`database unreachable (${report.database.error})`);
    }
  } else {
    report.database.error = 'not_configured';
  }

  if (report.database.connected) {
    if (ensure) {
      report.schema = await db.ensureSchema(pool);
    } else {
      const found = await db.countTables(pool).catch(() => 0);
      report.schema = { ok: true, found, created: 0, total: require('../database/schema').TABLES.length, error: null };
      report.schema.ok = found === report.schema.total;
    }
    if (!report.schema.ok) report.reasons.push(`schema incomplete (${report.schema.error || `${report.schema.found} tables`})`);
  }

  report.maintenance = report.reasons.length > 0;
  return report;
}

/** The single log block printed at startup. */
function formatReport(r) {
  const envLine = r.env.ok
    ? 'OK (all required variables present)'
    : [r.env.missing.length && `MISSING ${r.env.missing.join(', ')}`, r.env.invalid.length && `INVALID ${r.env.invalid.join(', ')}`]
        .filter(Boolean)
        .join('; ');
  const dbLine = r.database.connected ? 'connected' : `NOT connected (${r.database.error})`;
  const schemaLine = r.database.connected
    ? `${r.schema.found + r.schema.created}/${r.schema.total} tables (${r.schema.created} created now)${r.schema.ok ? '' : ` FAILED: ${r.schema.error}`}`
    : 'skipped (no database)';
  const lines = [
    '================ Aqdi self-check ================',
    `Node version : ${r.node} (${r.nodeEnv})`,
    `Environment  : ${envLine}`,
    ...r.env.warnings.map((w) => `  warning    : ${w}`),
    `Database     : ${dbLine}`,
    `Schema       : ${schemaLine}`,
    `SMS driver   : ${r.sms.driver} (${r.sms.note})`,
    `Status       : ${r.maintenance ? `MAINTENANCE PAGE: ${r.reasons.join('; ')}` : 'SERVING'}`,
    '=================================================',
  ];
  return lines.join('\n');
}

module.exports = { run, checkEnv, ignoredSettings, describeSms, formatReport, REQUIRED, RECOMMENDED };
