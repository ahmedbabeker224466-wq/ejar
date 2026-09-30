'use strict';

// Date primitives, as pure functions (no database, no clock unless passed
// in). Dates are 'YYYY-MM-DD' strings (Gregorian); points in time are Date
// objects (UTC). Calendar days are counted in Asia/Riyadh. Contract rules
// (deadlines, stages, renewals, schedules) live in services/contractEngine.js,
// which builds on these. Hijri is display only and never enters this file.

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;
const INVITE_DAYS = 30;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/** A date error with a stable machine-readable code (e.g. 'invalid_date'). */
class ContractDateError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ContractDateError';
    this.code = code;
  }
}

/** The calendar date in Riyadh at a point in time, as 'YYYY-MM-DD'. */
function riyadhDate(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Days in a month (month 1-12), leap years included. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Milliseconds (UTC midnight) of a real 'YYYY-MM-DD' date. Strict: exactly
 * that format, years 1900-2200, a real month and a real day of that month.
 * 2025-02-30 or 2025-1-5 throw instead of rolling over.
 */
function parseYmd(ymd) {
  const match = typeof ymd === 'string' ? YMD.exec(ymd) : null;
  if (!match) throw new ContractDateError('invalid_date', `Invalid date: ${ymd}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ContractDateError('invalid_date', `Invalid date: ${ymd}`);
  }
  return Date.UTC(year, month - 1, day);
}

/** True for a real 'YYYY-MM-DD' date inside the supported years. */
function isValidYmd(ymd) {
  try {
    parseYmd(ymd);
    return true;
  } catch {
    return false;
  }
}

function formatUtc(ms) {
  const date = new Date(ms).toISOString().slice(0, 10);
  parseYmd(date); // keeps results inside the supported years
  return date;
}

/** 'YYYY-MM-DD' plus n calendar days (n may be negative). */
function addDays(ymd, n) {
  return formatUtc(parseYmd(ymd) + n * DAY_MS);
}

/**
 * 'YYYY-MM-DD' plus n calendar months (n may be negative). When the day does
 * not exist in the target month it is clamped to that month's last day:
 * 2025-01-31 + 1 month = 2025-02-28, 2024-01-31 + 1 month = 2024-02-29.
 */
function addMonths(ymd, n) {
  parseYmd(ymd);
  const [year, month, day] = ymd.split('-').map(Number);
  const index = year * 12 + (month - 1) + n;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return formatUtc(Date.UTC(targetYear, targetMonth - 1, Math.min(day, daysInMonth(targetYear, targetMonth))));
}

/** -1, 0 or 1, comparing two valid dates. */
function compareYmd(a, b) {
  const diff = parseYmd(a) - parseYmd(b);
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

/** Whole calendar days from one date to another (negative if earlier). */
function daysBetween(fromYmd, toYmd) {
  return Math.round((parseYmd(toYmd) - parseYmd(fromYmd)) / DAY_MS);
}

/** The point in time exactly n days (of 24 hours) after another. */
function daysAfter(at, n) {
  return new Date(at.getTime() + n * DAY_MS);
}

/** When a trial that starts now ends: exactly TRIAL_DAYS later, in UTC. */
function trialEndsAt(now) {
  return daysAfter(now, TRIAL_DAYS);
}

/** When an invite created now stops working: exactly INVITE_DAYS later, in UTC. */
function inviteExpiresAt(now) {
  return daysAfter(now, INVITE_DAYS);
}

/** A trial is over once its end time has passed. No end time counts as over. */
function isTrialExpired(endsAt, now) {
  if (!endsAt) return true;
  return now.getTime() >= new Date(endsAt).getTime();
}

/**
 * Days of trial left as people read a calendar in Riyadh: 14 on the first
 * day, 0 on the last day, never negative.
 */
function trialDaysLeft(endsAt, now) {
  if (isTrialExpired(endsAt, now)) return 0;
  return Math.max(0, daysBetween(riyadhDate(now), riyadhDate(new Date(endsAt))));
}

module.exports = {
  TRIAL_DAYS,
  INVITE_DAYS,
  ContractDateError,
  daysInMonth,
  parseYmd,
  isValidYmd,
  compareYmd,
  riyadhDate,
  addDays,
  addMonths,
  daysBetween,
  daysAfter,
  trialEndsAt,
  inviteExpiresAt,
  isTrialExpired,
  trialDaysLeft,
};
