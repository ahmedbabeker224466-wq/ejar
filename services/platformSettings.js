'use strict';

// Platform-wide settings kept in the `settings` table: the seller details
// printed on invoices, bank-transfer details, the support contact and the
// kill switches. Nothing here is hardcoded: every value starts empty and is
// edited by the platform admin. None of these values is a secret (Moyasar
// keys live in the environment only).

const db = require('../config/db');
const { toWesternDigits } = require('../utils/phone');
const { sanitizeSnippet } = require('./analytics');

const KEYS = Object.freeze({
  sellerLegalName: 'seller.legal_name',
  sellerVatNumber: 'seller.vat_number',
  sellerAddress: 'seller.address',
  sellerCr: 'seller.cr_number',
  bankName: 'bank.name',
  bankAccountName: 'bank.account_name',
  bankIban: 'bank.iban',
  supportPhone: 'support_phone',
  supportEmail: 'support_email',
  signupsDisabled: 'kill.signups_disabled',
  aiDisabled: 'kill.ai_disabled',
  bannerMessage: 'banner.message',
  analyticsSnippet: 'analytics.snippet',
});

const CACHE_MS = 15 * 1000;
const BANNER_REFRESH_MS = 30 * 1000;
let cache = null;
// The banner shows on every page, so it is read from memory (never from the
// database inside a request); server.js refreshes it every 30 seconds and a
// save in this process updates it at once.
let bannerText = '';
// The analytics snippet is memory-only too (re-validated when loaded).
let analyticsState = { snippet: '', origins: [] };

/** Forgets the cached values (after a save, and in tests). */
function invalidate() {
  cache = null;
}

async function loadAll(pool) {
  if (cache && Date.now() - cache.at < CACHE_MS && cache.pool === pool) return cache.values;
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key IN (?)', [Object.values(KEYS)]);
  const values = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value === null ? '' : String(r.setting_value)]));
  cache = { at: Date.now(), pool, values };
  return values;
}

/** One setting as text ('' when never set). */
async function get(key, pool = db.pool) {
  return (await loadAll(pool))[key] || '';
}

/** The seller block printed on invoices. Empty-safe: any field may be ''. */
async function seller(pool = db.pool) {
  const all = await loadAll(pool);
  return {
    legal_name: all[KEYS.sellerLegalName] || '',
    vat_number: all[KEYS.sellerVatNumber] || '',
    address: all[KEYS.sellerAddress] || '',
    cr_number: all[KEYS.sellerCr] || '',
  };
}

async function bank(pool = db.pool) {
  const all = await loadAll(pool);
  return { name: all[KEYS.bankName] || '', account_name: all[KEYS.bankAccountName] || '', iban: all[KEYS.bankIban] || '' };
}

async function support(pool = db.pool) {
  const all = await loadAll(pool);
  return { phone: all[KEYS.supportPhone] || '', email: all[KEYS.supportEmail] || '' };
}

/** Kill switches and the maintenance banner message. */
async function switches(pool = db.pool) {
  const all = await loadAll(pool);
  return {
    signupsDisabled: all[KEYS.signupsDisabled] === '1',
    aiDisabled: all[KEYS.aiDisabled] === '1',
    banner: all[KEYS.bannerMessage] || '',
  };
}

async function signupsDisabled(pool = db.pool) {
  return (await switches(pool)).signupsDisabled;
}

async function aiDisabled(pool = db.pool) {
  return (await switches(pool)).aiDisabled;
}

function clean(value, max) {
  return toWesternDigits(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Checks the seller / bank / support form. Returns { values, errors }.
 * values holds every key (blank allowed), ready to store.
 */
function validateDetails(body = {}) {
  const errors = {};
  const values = {
    [KEYS.sellerLegalName]: clean(body.legal_name, 150),
    [KEYS.sellerVatNumber]: clean(body.vat_number, 20).replace(/\s/g, ''),
    [KEYS.sellerAddress]: clean(body.address, 250),
    [KEYS.sellerCr]: clean(body.cr_number, 20).replace(/\s/g, ''),
    [KEYS.bankName]: clean(body.bank_name, 80),
    [KEYS.bankAccountName]: clean(body.bank_account_name, 120),
    [KEYS.bankIban]: clean(body.bank_iban, 34).replace(/\s/g, '').toUpperCase(),
    [KEYS.supportPhone]: clean(body.support_phone, 20).replace(/[\s-]/g, ''),
    [KEYS.supportEmail]: clean(body.support_email, 190).toLowerCase(),
  };
  if (values[KEYS.sellerVatNumber] && !/^\d{15}$/.test(values[KEYS.sellerVatNumber])) {
    errors.vat_number = 'الرقم الضريبي يتكون من 15 رقماً، أو اتركه فارغاً.';
  }
  if (values[KEYS.sellerCr] && !/^\d{10}$/.test(values[KEYS.sellerCr])) {
    errors.cr_number = 'رقم السجل التجاري يتكون من 10 أرقام، أو اتركه فارغاً.';
  }
  if (values[KEYS.bankIban] && !/^SA\d{22}$/.test(values[KEYS.bankIban])) {
    errors.bank_iban = 'الآيبان السعودي يبدأ بـ SA ويتبعه 22 رقماً، أو اتركه فارغاً.';
  }
  if (values[KEYS.supportEmail] && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values[KEYS.supportEmail])) {
    errors.support_email = 'البريد الإلكتروني غير صحيح.';
  }
  if (values[KEYS.supportPhone] && !/^\+?\d{7,15}$/.test(values[KEYS.supportPhone])) {
    errors.support_phone = 'رقم الدعم غير صحيح.';
  }
  return { values, errors };
}

/** Which fields of a details save changed (names only, never the values). */
async function save(pool, values) {
  const before = await loadAll(pool);
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    if ((before[key] || '') === value) continue;
    await pool.query(
      `INSERT INTO settings (setting_key, setting_value, is_secret) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value],
    );
    changed.push(key);
  }
  invalidate();
  if (Object.hasOwn(values, KEYS.bannerMessage)) bannerText = values[KEYS.bannerMessage];
  if (Object.hasOwn(values, KEYS.analyticsSnippet)) setAnalytics(values[KEYS.analyticsSnippet]);
  return changed;
}

function setAnalytics(text) {
  const result = sanitizeSnippet(text);
  analyticsState = result.ok ? { snippet: result.snippet, origins: result.origins } : { snippet: '', origins: [] };
}

/** The analytics snippet and the origins its script needs (memory only; empty by default). */
function analyticsNow() {
  return analyticsState;
}

/** The banner message right now (memory only, '' = none). */
function bannerNow() {
  return bannerText;
}

/** Reads the banner message from the database into memory. Never throws. */
async function refreshBanner(pool = db.pool) {
  try {
    invalidate();
    const all = await loadAll(pool);
    bannerText = all[KEYS.bannerMessage] || '';
    setAnalytics(all[KEYS.analyticsSnippet] || '');
  } catch {
    // Keep the last known message when the database is briefly unreachable.
  }
}

/** Starts the periodic refresh (called by server.js). Returns { stop }. */
function startBannerRefresh(pool = db.pool) {
  refreshBanner(pool);
  const timer = setInterval(() => refreshBanner(pool), BANNER_REFRESH_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** The kill-switch form as stored values: checkboxes to '1'/'0', the banner cleaned. */
function switchValues(body = {}) {
  return {
    [KEYS.signupsDisabled]: body.signups_disabled === '1' ? '1' : '0',
    [KEYS.aiDisabled]: body.ai_disabled === '1' ? '1' : '0',
    [KEYS.bannerMessage]: cleanBanner(body.banner),
  };
}

/** Banner text: plain text, up to 200 characters. */
function cleanBanner(value) {
  return clean(value, 200);
}

module.exports = {
  KEYS,
  invalidate,
  get,
  seller,
  bank,
  support,
  switches,
  signupsDisabled,
  aiDisabled,
  validateDetails,
  cleanBanner,
  switchValues,
  save,
  bannerNow,
  analyticsNow,
  refreshBanner,
  startBannerRefresh,
};
