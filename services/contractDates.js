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

/** The calendar month in Riyadh at a point in time, as 'YYYY-MM'. */
function riyadhMonth(at) {
  return riyadhDate(at).slice(0, 7);
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

// Saudi Arabia keeps UTC+3 all year (no daylight saving), so a Riyadh clock
// time is a fixed offset from UTC.
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a 'HH:MM' 24-hour clock time. */
function isValidClock(value) {
  return typeof value === 'string' && CLOCK.test(value);
}

function clockMinutes(value) {
  const [, h, m] = CLOCK.exec(value);
  return Number(h) * 60 + Number(m);
}

/** Minutes since midnight on the Riyadh clock at a point in time. */
function riyadhMinutes(at) {
  const shifted = new Date(at.getTime() + RIYADH_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The Riyadh clock time at a point in time, as 'HH:MM'. */
function riyadhClock(at) {
  const minutes = riyadhMinutes(at);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Whether a point in time falls inside quiet hours [start, end) on the Riyadh
 * clock. A window may cross midnight (21:00-08:00). start === end means none.
 */
function inQuietHours(at, start, end) {
  if (!isValidClock(start) || !isValidClock(end) || start === end) return false;
  const now = riyadhMinutes(at);
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** The first point in time at or after `at` when the Riyadh clock shows 'HH:MM'. */
function nextRiyadhClock(at, clock) {
  const shifted = new Date(at.getTime() + RIYADH_OFFSET_MS);
  const target = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + clockMinutes(clock) * 60000;
  const atLocal = shifted.getTime() - shifted.getUTCSeconds() * 1000 - shifted.getUTCMilliseconds();
  const next = target >= atLocal ? target : target + DAY_MS;
  return new Date(next - RIYADH_OFFSET_MS);
}

/** When a message may go out: now, or the end of quiet hours if now is inside them. */
function afterQuietHours(at, start, end) {
  return inQuietHours(at, start, end) ? nextRiyadhClock(at, end) : at;
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

/** The point in time exactly n hours after another (n may be negative). */
function hoursAfter(at, n) {
  return new Date(at.getTime() + n * 60 * 60 * 1000);
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

/** The instant a Riyadh calendar day starts (00:00 +03:00), as a Date. */
function riyadhMidnight(ymd) {
  return new Date(parseYmd(ymd) - RIYADH_OFFSET_MS);
}

/**
 * When a subscription period that starts at `startAt` ends: the start of the
 * Riyadh day `months` calendar months after the start day. The end is
 * exclusive: the office has access while now < end.
 */
function subscriptionPeriodEnd(startAt, months) {
  return riyadhMidnight(addMonths(riyadhDate(startAt), months));
}

/**
 * Calendar days (Riyadh) from today to the last day of access of a period
 * that ends (exclusively) at endAt: 0 on the last day, negative once over.
 */
function periodDaysLeft(endAt, now) {
  const lastDay = riyadhDate(new Date(new Date(endAt).getTime() - 1));
  return daysBetween(riyadhDate(now), lastDay);
}

/** The Riyadh calendar year of a point in time (invoice number series). */
function riyadhYear(at) {
  return Number(riyadhDate(at).slice(0, 4));
}

/** Day of the week of a 'YYYY-MM-DD' date: 0 = Sunday ... 6 = Saturday. */
function weekdayOf(ymd) {
  return new Date(parseYmd(ymd)).getUTCDay();
}

/** The month before the one that contains `ymd`, as 'YYYY-MM'. */
function previousMonthOf(ymd) {
  parseYmd(ymd);
  return addMonths(`${ymd.slice(0, 7)}-01`, -1).slice(0, 7);
}

/** The instants a Riyadh month 'YYYY-MM' starts (inclusive) and ends (exclusive). */
function monthBounds(period) {
  const first = `${period}-01`;
  return { start: riyadhMidnight(first), end: riyadhMidnight(addMonths(first, 1)) };
}

module.exports = {
  weekdayOf,
  previousMonthOf,
  monthBounds,
  riyadhMidnight,
  subscriptionPeriodEnd,
  periodDaysLeft,
  riyadhYear,
  TRIAL_DAYS,
  INVITE_DAYS,
  ContractDateError,
  daysInMonth,
  parseYmd,
  isValidYmd,
  compareYmd,
  riyadhDate,
  riyadhMonth,
  addDays,
  addMonths,
  daysBetween,
  daysAfter,
  hoursAfter,
  trialEndsAt,
  inviteExpiresAt,
  isTrialExpired,
  trialDaysLeft,
  isValidClock,
  riyadhClock,
  inQuietHours,
  nextRiyadhClock,
  afterQuietHours,
};
