'use strict';

// The contract date engine: THE public entry point for contract deadlines,
// stages, rent-change policy, renewals, payment schedules and sanity checks.
//
// Pure functions only: no database, no HTTP, no clock. "today" is always a
// 'YYYY-MM-DD' string the caller made with riyadhDate(now). All dates are
// Gregorian 'YYYY-MM-DD'; Hijri is produced for display only (formatHijri)
// and never enters a calculation.
//
// The Ejar rule numbers live only in config/ejarRules.js. Every function that
// uses one takes an optional `rules` argument (defaults to that file).

const RULES = require('../config/ejarRules');
const { normalizeCity } = require('../config/saudiCities');
const {
  ContractDateError, parseYmd, isValidYmd, compareYmd, addDays, addMonths, daysBetween,
} = require('./contractDates');
const { toWesternDigits } = require('../utils/phone');

const STAGES = Object.freeze(['calm', 'soon', 'urgent', 'deadline_passed', 'ended', 'renewed', 'terminated']);

// Stages of a contract that is still running (counts for plan limits, keeps
// its unit occupied, gets recomputed).
const LIVE_STAGES = Object.freeze(['calm', 'soon', 'urgent', 'deadline_passed']);

// App policy, not an Ejar rule: a unit is marked rented once its contract has
// started or starts within this many days.
const APP = Object.freeze({ rentedLeadDays: 30 });

// Months between installments.
const FREQUENCIES = Object.freeze({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 });

// Plausibility bounds for sanityWarnings. These are app heuristics for
// catching misread contracts, not Ejar rules.
const SANITY = Object.freeze({
  minTermMonths: 1,
  maxTermMonths: 120,
  maxStartDistanceMonths: 24,
  minAnnualRent: 1000,
  maxAnnualRent: 10000000,
});

function requireDate(value, field) {
  if (!isValidYmd(value)) throw new ContractDateError('invalid_date', `Invalid date in ${field}: ${value}`);
  return value;
}

// ------------------------------------------------------------ deadlines

/** Last day to give notice of non-renewal: end_date minus NON_RENEWAL_NOTICE_DAYS. */
function noticeDeadline(endDate, rules = RULES) {
  return addDays(requireDate(endDate, 'end_date'), -rules.NON_RENEWAL_NOTICE_DAYS);
}

/** Last day for the landlord to request a rent change: end_date minus RENT_CHANGE_NOTICE_DAYS. */
function rentChangeDeadline(endDate, rules = RULES) {
  return addDays(requireDate(endDate, 'end_date'), -rules.RENT_CHANGE_NOTICE_DAYS);
}

/** Days from today to a date: 0 on the day itself, negative once it has passed. */
function daysUntil(today, date) {
  return daysBetween(requireDate(today, 'today'), requireDate(date, 'date'));
}

function checkTerm(contract) {
  requireDate(contract.start_date, 'start_date');
  requireDate(contract.end_date, 'end_date');
  if (compareYmd(contract.end_date, contract.start_date) < 0) {
    throw new ContractDateError('end_before_start', 'end_date is before start_date');
  }
}

/**
 * Both deadlines and the days left to each, for one contract. "open" means
 * today is on or before that deadline (the deadline day itself is still open).
 */
function describeDeadlines(contract, today, rules = RULES) {
  checkTerm(contract);
  requireDate(today, 'today');
  const notice = noticeDeadline(contract.end_date, rules);
  const rentChange = rentChangeDeadline(contract.end_date, rules);
  const daysToNotice = daysBetween(today, notice);
  const daysToRentChange = daysBetween(today, rentChange);
  return {
    noticeDeadline: notice,
    rentChangeDeadline: rentChange,
    daysToNotice,
    daysToRentChange,
    daysToEnd: daysBetween(today, contract.end_date),
    noticeOpen: daysToNotice >= 0,
    rentChangeOpen: daysToRentChange >= 0,
    notStarted: compareYmd(today, contract.start_date) < 0,
  };
}

// ------------------------------------------------------------ stages

function isFlagged(contract, kind) {
  return Boolean(contract[`${kind}_at`]) || contract[kind] === true || contract.status === kind;
}

/**
 * The contract's stage (one of STAGES):
 * terminated > renewed > ended (today after end_date) > deadline_passed
 * (after the notice deadline, up to end_date) > urgent (0..urgentDays days
 * to the notice deadline; the deadline day is urgent) > soon (up to
 * soonDays) > calm. A contract that has not started is classified the same way.
 */
function classifyContract(contract, today, rules = RULES) {
  if (isFlagged(contract, 'terminated')) return 'terminated';
  if (isFlagged(contract, 'renewed')) return 'renewed';
  const d = describeDeadlines(contract, today, rules);
  const { soonDays, urgentDays } = rules.STAGE_THRESHOLDS;
  if (d.daysToEnd < 0) return 'ended';
  if (d.daysToNotice < 0) return 'deadline_passed';
  if (d.daysToNotice <= urgentDays) return 'urgent';
  if (d.daysToNotice <= soonDays) return 'soon';
  return 'calm';
}

/** Stage plus deadlines in one object: what screens and reminders need. */
function describeContract(contract, today, rules = RULES) {
  const autoRenew = contract.auto_renew === undefined || contract.auto_renew === null
    ? rules.AUTO_RENEW_DEFAULT
    : Boolean(Number(contract.auto_renew));
  return {
    stage: classifyContract(contract, today, rules),
    autoRenew,
    ...describeDeadlines(contract, today, rules),
  };
}

// ------------------------------------------------------------ rent change

/**
 * Whether the rent may go up or down for the next term. Judged on the date the
 * new rent would take effect (end_date + 1), not on today. A reduction is
 * always allowed. requestOpen says whether today is still on or before the
 * rent-change deadline. reason: 'riyadh_freeze' | 'not_frozen' | 'unknown_city'.
 */
function rentChangePolicy({ city, today, endDate }, rules = RULES) {
  requireDate(today, 'today');
  const effectiveDate = addDays(requireDate(endDate, 'endDate'), 1);
  const base = {
    increaseAllowed: true,
    reductionAllowed: true,
    effectiveDate,
    requestOpen: daysBetween(today, rentChangeDeadline(endDate, rules)) >= 0,
  };
  const cityKey = normalizeCity(city);
  if (!cityKey) return { ...base, reason: 'unknown_city' };

  const freeze = rules.RIYADH_RENT_FREEZE;
  const freezeEnds = addMonths(freeze.from, freeze.years * 12); // first day no longer frozen
  const frozen = cityKey === freeze.city
    && compareYmd(effectiveDate, freeze.from) >= 0
    && compareYmd(effectiveDate, freezeEnds) < 0;
  if (frozen) {
    return { ...base, increaseAllowed: false, reason: 'riyadh_freeze', freezeUntil: addDays(freezeEnds, -1) };
  }
  return { ...base, reason: 'not_frozen' };
}

// ------------------------------------------------------------ terms and renewal

/**
 * The whole number of months from start to end (inclusive), or null.
 * A term of n months ends on addMonths(start, n) minus one day
 * (2025-03-01..2026-02-28 = 12). When addMonths had to clamp (the start day
 * does not exist in the target month), a term ending on the clamped day is
 * also n months, so 2024-02-29..2025-02-28 = 12.
 */
function termMonths(start, end) {
  requireDate(start, 'start');
  requireDate(end, 'end');
  if (compareYmd(end, start) < 0) return null;
  const [y1, m1] = start.split('-').map(Number);
  const [y2, m2] = end.split('-').map(Number);
  const estimate = (y2 - y1) * 12 + (m2 - m1);
  const dayAfterEnd = addDays(end, 1);
  const startDay = Number(start.slice(8));
  for (const n of [estimate, estimate + 1, estimate - 1]) {
    if (n < 1) continue;
    const target = addMonths(start, n);
    if (target === dayAfterEnd) return n;
    const clamped = Number(target.slice(8)) < startDay;
    if (clamped && target === end) return n;
  }
  return null;
}

/**
 * The next term of an automatic renewal: it starts the day after end_date and
 * has the same length. Whole-month terms repeat by months
 * (end = addMonths(start, n) - 1 day, clamped to month ends); other terms
 * repeat the exact number of days.
 */
function nextTerm(contract) {
  checkTerm(contract);
  const start = addDays(contract.end_date, 1);
  const months = termMonths(contract.start_date, contract.end_date);
  if (months) return { start_date: start, end_date: addDays(addMonths(start, months), -1), months };
  const days = daysBetween(contract.start_date, contract.end_date);
  return { start_date: start, end_date: addDays(start, days), months: null };
}

// ------------------------------------------------------------ money and schedule

/**
 * Money to integer halalas (1 SAR = 100). Accepts numbers and numeric strings
 * ("45000", "45,000.50", "٤٥٠٠٠"). Returns null when it is not a number.
 */
function toHalalas(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const text = toWesternDigits(value).trim().replace(/[,٬\s]/g, '').replace('٫', '.');
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const halalas = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  return match[1] ? -halalas : halalas;
}

function fromHalalas(halalas) {
  return Number((halalas / 100).toFixed(2));
}

/**
 * Installments for one term. Count = months / frequency, rounded up (a
 * 6-month monthly contract has 6). Term total = annual_rent * months / 12,
 * rounded to the halala. Every installment gets the same amount and the
 * rounding remainder goes on the last one, so the sum equals the total
 * exactly. Due dates: start_date, then every `frequency` months counted from
 * start_date (clamped to month ends). Throws ContractDateError with code
 * invalid_date | end_before_start | invalid_rent | unknown_frequency |
 * term_not_whole_months.
 */
function buildSchedule({ start_date: start, end_date: end, annual_rent: annualRent, payment_frequency: frequency }) {
  checkTerm({ start_date: start, end_date: end });
  const annual = toHalalas(annualRent);
  if (annual === null || annual <= 0) throw new ContractDateError('invalid_rent', 'annual_rent must be a positive amount');
  if (!Object.hasOwn(FREQUENCIES, String(frequency))) {
    throw new ContractDateError('unknown_frequency', `Unknown payment_frequency: ${frequency}`);
  }
  const months = termMonths(start, end);
  if (!months) throw new ContractDateError('term_not_whole_months', 'The term is not a whole number of months');

  const step = FREQUENCIES[frequency];
  const count = Math.ceil(months / step);
  const total = Math.round((annual * months) / 12);
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => ({
    due_date: addMonths(start, i * step),
    amount: fromHalalas(i === count - 1 ? total - base * (count - 1) : base),
  }));
}

// ------------------------------------------------------------ sanity warnings

function warning(code, severity, messageAr) {
  return { code, severity, message_ar: messageAr };
}

/**
 * Plausibility checks for contract fields (for example read by AI from an
 * uploaded contract). Returns [{ code, severity: 'warn'|'error', message_ar }].
 */
function sanityWarnings(fields, today, rules = RULES) {
  requireDate(today, 'today');
  const out = [];
  const startOk = isValidYmd(fields.start_date);
  const endOk = isValidYmd(fields.end_date);
  if (!startOk) out.push(warning('start_date_invalid', 'error', 'تاريخ بداية العقد غير موجود أو غير صحيح.'));
  if (!endOk) out.push(warning('end_date_invalid', 'error', 'تاريخ نهاية العقد غير موجود أو غير صحيح.'));

  if (startOk && endOk) {
    const { start_date: start, end_date: end } = fields;
    if (compareYmd(end, start) <= 0) {
      out.push(warning('end_not_after_start', 'error', 'تاريخ نهاية العقد يجب أن يكون بعد تاريخ البداية.'));
    } else {
      const dayAfterEnd = addDays(end, 1);
      if (compareYmd(dayAfterEnd, addMonths(start, SANITY.minTermMonths)) < 0) {
        out.push(warning('term_too_short', 'warn', 'مدة العقد أقل من شهر. تأكد من التواريخ.'));
      }
      if (compareYmd(dayAfterEnd, addMonths(start, SANITY.maxTermMonths)) > 0) {
        out.push(warning('term_too_long', 'warn', 'مدة العقد أكثر من 10 سنوات. تأكد من التواريخ.'));
      }
      const d = describeDeadlines({ start_date: start, end_date: end }, today, rules);
      if (d.daysToEnd < 0) {
        out.push(warning('contract_ended', 'warn', 'انتهت مدة هذا العقد.'));
      } else if (d.daysToNotice < 0) {
        out.push(warning('notice_passed', 'warn', 'فات آخر موعد لإشعار عدم التجديد في هذا العقد.'));
      }
    }
  }
  if (startOk) {
    if (compareYmd(fields.start_date, addMonths(today, -SANITY.maxStartDistanceMonths)) < 0) {
      out.push(warning('start_far_past', 'warn', 'تاريخ البداية قبل أكثر من سنتين. تأكد منه.'));
    }
    if (compareYmd(fields.start_date, addMonths(today, SANITY.maxStartDistanceMonths)) > 0) {
      out.push(warning('start_far_future', 'warn', 'تاريخ البداية بعد أكثر من سنتين. تأكد منه.'));
    }
  }

  const rent = toHalalas(fields.annual_rent);
  if (rent === null || rent <= 0) {
    out.push(warning('rent_invalid', 'error', 'الإيجار السنوي غير موجود أو غير صحيح.'));
  } else {
    if (rent < SANITY.minAnnualRent * 100) out.push(warning('rent_too_low', 'warn', 'الإيجار السنوي أقل من 1,000 ريال. تأكد من المبلغ.'));
    if (rent > SANITY.maxAnnualRent * 100) out.push(warning('rent_too_high', 'warn', 'الإيجار السنوي أكثر من 10,000,000 ريال. تأكد من المبلغ.'));
    const deposit = toHalalas(fields.deposit);
    if (deposit !== null && deposit > rent) {
      out.push(warning('deposit_above_rent', 'warn', 'مبلغ التأمين أكبر من الإيجار السنوي. تأكد من المبلغ.'));
    }
  }
  return out;
}

// ------------------------------------------------------------ helpers for the contract system

/** True when two inclusive date ranges share at least one day (back to back is fine). */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return compareYmd(aStart, bEnd) <= 0 && compareYmd(bStart, aEnd) <= 0;
}

/**
 * Whether the contract's unit should be marked rented today: the contract has
 * started (or starts within APP.rentedLeadDays) and has not ended.
 */
function unitShouldBeRented(contract, today, app = APP) {
  checkTerm(contract);
  requireDate(today, 'today');
  return compareYmd(contract.start_date, addDays(today, app.rentedLeadDays)) <= 0
    && compareYmd(today, contract.end_date) <= 0;
}

/** A payment still 'due' after its due date reads as 'late'. */
function paymentDisplayStatus(payment, today) {
  requireDate(today, 'today');
  if (payment.status === 'due' && compareYmd(requireDate(payment.due_date, 'due_date'), today) < 0) return 'late';
  return payment.status;
}

/** { from: today, to: today + days } for "within N days" filters. */
function dateWindow(today, days) {
  requireDate(today, 'today');
  return { from: today, to: addDays(today, days) };
}

/** True when a date is after today (for "not in the future" checks). */
function isAfter(date, today) {
  return compareYmd(requireDate(date, 'date'), requireDate(today, 'today')) > 0;
}

// ------------------------------------------------------------ display (Hijri is display only)

// Hijri here is for display ONLY and must never feed a calculation. The ICU
// Umm al-Qura table can differ by one day from the official calendar, so every
// screen that shows it labels it "تقريبي".
const HIJRI = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
});
const GREGORIAN_AR = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});

/** '2026-01-01' -> '١٤٤٧/٠٧/١٢ هـ' style (approximate; display only). */
function formatHijri(ymd) {
  const parts = Object.fromEntries(HIJRI.formatToParts(new Date(parseYmd(ymd))).map((p) => [p.type, p.value]));
  return `${parts.year}/${parts.month}/${parts.day} هـ`;
}

/** '2026-01-01' -> '١ يناير ٢٠٢٦'. */
function formatGregorianAr(ymd) {
  return GREGORIAN_AR.format(new Date(parseYmd(ymd)));
}

module.exports = {
  RULES,
  STAGES,
  LIVE_STAGES,
  APP,
  FREQUENCIES,
  SANITY,
  ContractDateError,
  noticeDeadline,
  rentChangeDeadline,
  daysUntil,
  describeDeadlines,
  classifyContract,
  describeContract,
  rentChangePolicy,
  termMonths,
  nextTerm,
  toHalalas,
  buildSchedule,
  sanityWarnings,
  rangesOverlap,
  unitShouldBeRented,
  paymentDisplayStatus,
  dateWindow,
  isAfter,
  isValidDate: isValidYmd,
  compareDates: compareYmd,
  formatHijri,
  formatGregorianAr,
};
