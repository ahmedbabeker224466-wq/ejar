'use strict';

// Arabic-Indic (U+0660-0669) and Persian / Eastern Arabic-Indic (U+06F0-06F9) digits.
const DIGIT_MAP = new Map([
  ...[...'٠١٢٣٤٥٦٧٨٩'].map((d, i) => [d, String(i)]),
  ...[...'۰۱۲۳۴۵۶۷۸۹'].map((d, i) => [d, String(i)]),
]);

/** Converts Arabic-Indic and Persian digits to 0-9; everything else is kept. */
function toWesternDigits(input) {
  return String(input).replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP.get(d));
}

/**
 * Canonical Saudi mobile number: '9665XXXXXXXX' (12 digits, no plus).
 * Accepts 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX and +9665XXXXXXXX, in any digit
 * script, with spaces or dashes between digits. Returns null for anything else.
 */
function normalizeSaudi(input) {
  if (input === null || input === undefined) return null;
  const compact = toWesternDigits(input).trim().replace(/[\s-]/g, '');
  const match =
    /^05(\d{8})$/.exec(compact) ||
    /^5(\d{8})$/.exec(compact) ||
    /^9665(\d{8})$/.exec(compact) ||
    /^\+9665(\d{8})$/.exec(compact);
  return match ? `9665${match[1]}` : null;
}

/** '9665XXXXXXXX' -> '+9665XXXXXXXX' for providers that want E.164. */
function toE164(canonical) {
  return `+${canonical}`;
}

/** '9665XXXXXXXX' -> '05XXXXXXXX', the form people recognise. */
function toLocal(canonical) {
  return `0${canonical.slice(3)}`;
}

/** '9665XXXXXXXX' -> '050****567': enough to recognise, not enough to call. */
function maskPhone(canonical) {
  if (!canonical || String(canonical).length < 8) return '****';
  const local = toLocal(String(canonical));
  return `${local.slice(0, 3)}****${local.slice(-3)}`;
}

module.exports = { normalizeSaudi, toWesternDigits, toE164, toLocal, maskPhone };
