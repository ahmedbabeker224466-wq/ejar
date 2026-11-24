'use strict';

// Which AI service reads uploaded contracts, chosen by the platform admin at
// /admin/settings (owner's request, Nov 2026): provider (claude | gemini), model
// and API key. The key is sealed with SECRET_BOX_KEY in the settings table,
// never logged, never sent back to a page and never in an audit row.
//
// Requests read the choice from memory only: refresh() runs with the 30-second
// settings refresh (platformSettings.refreshBanner) and right after a save.
// Without a stored key, CLAUDE_API_KEY / CLAUDE_MODEL from the environment
// still work as before.

const secretBox = require('./secretBox');
const logger = require('../utils/logger');

const PROVIDERS = Object.freeze({
  claude: { label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-4-5' },
  gemini: { label: 'Gemini (Google)', defaultModel: 'gemini-2.5-flash' },
});

const KEYS = Object.freeze({
  provider: 'ai.provider',
  model: 'ai.model',
  key: 'ai.key_sealed',
});

let state = { provider: '', model: '', apiKey: '' };

/** The stored choice right now (memory only). apiKey is '' when none is stored. */
function now() {
  return state;
}

/** Loads the stored choice into memory. Never throws; a bad seal counts as no key. */
async function refresh(pool) {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key IN (?)', [Object.values(KEYS)]);
    const values = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value === null ? '' : String(r.setting_value)]));
    let apiKey = '';
    if (values[KEYS.key]) {
      try {
        apiKey = secretBox.open(Buffer.from(values[KEYS.key], 'base64'));
      } catch {
        logger.error('AI key could not be opened (SECRET_BOX_KEY changed?)');
      }
    }
    const provider = Object.hasOwn(PROVIDERS, values[KEYS.provider]) ? values[KEYS.provider] : '';
    state = { provider, model: values[KEYS.model] || '', apiKey };
  } catch {
    // Keep the last known choice when the database is briefly unreachable.
  }
  return state;
}

/** Checks the admin form. Returns { values, errors }; values.key is '' when the field was left blank. */
function validate(body = {}) {
  const errors = {};
  const provider = String(body.ai_provider || '').trim();
  if (!Object.hasOwn(PROVIDERS, provider)) errors.ai_provider = 'اختر مزوّد الذكاء الاصطناعي.';
  const model = String(body.ai_model || '').trim();
  if (model && !/^[A-Za-z0-9._-]{2,80}$/.test(model)) errors.ai_model = 'اسم النموذج حروف إنجليزية وأرقام فقط، مثل gemini-2.5-flash.';
  const key = String(body.ai_key || '').trim();
  if (key && !/^[\x21-\x7e]{20,300}$/.test(key)) errors.ai_key = 'المفتاح غير صحيح. انسخه كما هو من لوحة المزوّد.';
  return { values: { provider, model, key, clearKey: body.ai_clear_key === '1' }, errors };
}

/** Saves the choice and returns the names of what changed (never a value). */
async function save(pool, { provider, model, key, clearKey }) {
  const before = await refresh(pool);
  const changed = [];
  const put = async (settingKey, value, secret = 0) => {
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value, is_secret) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), is_secret = VALUES(is_secret)`,
      [settingKey, value, secret],
    );
  };
  if (before.provider !== provider) { await put(KEYS.provider, provider); changed.push('provider'); }
  if (before.model !== model) { await put(KEYS.model, model); changed.push('model'); }
  if (key) {
    await put(KEYS.key, secretBox.seal(key).toString('base64'), 1);
    changed.push('key');
  } else if (clearKey && before.apiKey) {
    await pool.query('DELETE FROM settings WHERE setting_key = ?', [KEYS.key]);
    changed.push('key_removed');
  }
  await refresh(pool);
  return changed;
}

/** What the admin page shows: never the key, only whether one is stored. */
function view() {
  return { provider: state.provider, model: state.model, keySet: Boolean(state.apiKey), envKey: Boolean(String(process.env.CLAUDE_API_KEY || '').trim()) };
}

/** Test hook. */
function setForTests(next) {
  state = { provider: '', model: '', apiKey: '', ...next };
}

module.exports = { PROVIDERS, KEYS, now, refresh, validate, save, view, setForTests };
