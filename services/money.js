'use strict';

// Money display and arithmetic helpers. Amounts are integer halalas in code
// (exact), DECIMAL(12,2) in the database (services never use floats for sums).

const engine = require('./contractEngine');

const MAX_HALALAS = 999999999999; // DECIMAL(12,2)

/** Halalas (integer) to 'DDDD.DD', the form DECIMAL(12,2) columns take. */
function toDecimal(halalas) {
  const h = Math.round(Number(halalas));
  const sign = h < 0 ? '-' : '';
  const abs = Math.abs(h);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A DECIMAL column value (string or number) to integer halalas. */
function fromDecimal(value) {
  const h = engine.toHalalas(String(value ?? '0'));
  return h === null ? 0 : h;
}

/** Halalas to a display string in SAR: '1,234.50'. */
function formatHalalas(halalas) {
  const [whole, cents] = toDecimal(halalas).split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** Parses what a person typed ('1500', '1,500.50', Arabic digits). Positive halalas or null. */
function parseAmount(input) {
  const h = engine.toHalalas(typeof input === 'string' ? input : String(input ?? ''));
  return h !== null && h > 0 && h <= MAX_HALALAS ? h : null;
}

module.exports = { MAX_HALALAS, toDecimal, fromDecimal, formatHalalas, parseAmount };
