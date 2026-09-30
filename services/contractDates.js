'use strict';

// All date math lives here, as pure functions (no database, no clock unless
// passed in). Dates are 'YYYY-MM-DD' strings (Gregorian); points in time are
// Date objects (UTC). Calendar days are counted in Asia/Riyadh.

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 14;
const INVITE_DAYS = 30;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date in Riyadh at a point in time, as 'YYYY-MM-DD'. */
function riyadhDate(at) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function parseYmd(ymd) {
  const match = YMD.exec(String(ymd));
  if (!match) throw new Error(`Invalid date: ${ymd}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 'YYYY-MM-DD' plus n calendar days (n may be negative). */
function addDays(ymd, n) {
  return new Date(parseYmd(ymd) + n * DAY_MS).toISOString().slice(0, 10);
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
  riyadhDate,
  addDays,
  daysBetween,
  daysAfter,
  trialEndsAt,
  inviteExpiresAt,
  isTrialExpired,
  trialDaysLeft,
};
