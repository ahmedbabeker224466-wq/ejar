'use strict';

// CSV for Excel: UTF-8 with a byte order mark, CRLF lines, and cells that
// could run as a formula (starting with = + - @, tab or carriage return) get
// a single quote in front so Excel shows them as text. Only the values the
// caller passes are written; callers pass nicknames, dates and amounts.

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell as CSV text. Numbers are written as they are; text is neutralized and quoted when needed. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole file: BOM, header row, data rows. */
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Sends a CSV as a download. */
function sendCsv(res, filename, headers, rows) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  return res.send(toCsv(headers, rows));
}

module.exports = { BOM, csvCell, toCsv, sendCsv };
