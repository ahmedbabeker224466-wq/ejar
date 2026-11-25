'use strict';

// A contract's dates as an iCalendar (.ics) file: unpaid installments, the
// renewal decision deadline, the rent-change deadline and the end date. All
// day events. Text holds nicknames, dates and amounts only, never party data.

const { addDays } = require('./contractDates');

const ymdCompact = (ymd) => String(ymd).slice(0, 10).replace(/-/g, '');

/** RFC 5545 text escaping. */
function escapeText(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line to 75 octets as RFC 5545 asks (UTF-8 safe). */
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function event({ uid, date, summary, description, stamp }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymdCompact(date)}`,
    `DTEND;VALUE=DATE:${ymdCompact(addDays(String(date).slice(0, 10), 1))}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-P1D',
    `DESCRIPTION:${escapeText(summary)}`,
    'END:VALARM',
    'END:VEVENT',
  ];
}

function amount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * contract: { id, unit_label, end_date }, described: engine describeContract
 * output, payments: rows with id, due_date, amount, status. now is injectable
 * for tests.
 */
function contractCalendar({ contract, described, payments = [], officeName = '', host = 'mi3aad.com', now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const unit = contract.unit_label || 'عقد الإيجار';
  const uid = (key) => `c${contract.id}-${key}@${String(host).replace(/[^a-z0-9.-]/gi, '')}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mi3aad//Contract dates//AR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`ميعاد: ${unit}`)}`,
  ];
  payments.forEach((p, i) => {
    if (!['due', 'late', 'tenant_reported'].includes(p.status)) return;
    lines.push(...event({
      uid: uid(`p${p.id}`), date: p.due_date, stamp,
      summary: `دفعة إيجار ${i + 1}: ${unit}`,
      description: `${amount(p.amount)} ريال. ${officeName}`,
    }));
  });
  if (described && described.noticeDeadline) {
    lines.push(...event({ uid: uid('notice'), date: described.noticeDeadline, stamp, summary: `آخر موعد لقرار التجديد: ${unit}`, description: officeName }));
  }
  if (described && described.rentChangeDeadline) {
    lines.push(...event({ uid: uid('rent'), date: described.rentChangeDeadline, stamp, summary: `آخر موعد لطلب تغيير الإيجار: ${unit}`, description: officeName }));
  }
  lines.push(...event({ uid: uid('end'), date: contract.end_date, stamp, summary: `نهاية العقد: ${unit}`, description: officeName }));
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { contractCalendar, escapeText, fold };
