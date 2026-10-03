'use strict';

// Pure subscription rules (no database, the clock is passed in).
//
// A paid period ends (exclusively) at subscription_ends_at. After it:
//   grace   the first GRACE_DAYS days: the office can read everything but not
//           change anything ("وضع القراءة فقط"), with a red banner
//   expired after the grace: the office is suspended (data is kept)

const billing = require('../config/billing');
const { daysAfter, periodDaysLeft } = require('./contractDates');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a paid period stands at `now`:
 * { state: 'active' | 'grace' | 'expired', daysLeft, graceDaysLeft }.
 * daysLeft counts Riyadh calendar days to the last day of access (0 on that
 * day, negative after it). graceDaysLeft is 0 outside the grace.
 */
function periodState(endsAt, now, graceDays = billing.GRACE_DAYS) {
  const end = new Date(endsAt);
  const daysLeft = periodDaysLeft(end, now);
  if (now.getTime() < end.getTime()) return { state: 'active', daysLeft, graceDaysLeft: 0 };
  const graceEnd = daysAfter(end, graceDays);
  if (now.getTime() < graceEnd.getTime()) {
    return { state: 'grace', daysLeft, graceDaysLeft: Math.max(1, Math.ceil((graceEnd.getTime() - now.getTime()) / DAY_MS)) };
  }
  return { state: 'expired', daysLeft, graceDaysLeft: 0 };
}

/**
 * The status change the daily job should make for an office, or null:
 * a paid period that ended -> 'past_due' (grace), after the grace -> 'suspended'.
 * Offices without a paid period (trial, or the older past_due without a date)
 * and suspended offices are never touched here.
 */
function planTransition(office, now) {
  if (!office.subscription_ends_at) return null;
  if (office.status !== 'active' && office.status !== 'past_due') return null;
  const { state } = periodState(office.subscription_ends_at, now);
  if (state === 'expired') return 'suspended';
  if (state === 'grace' && office.status === 'active') return 'past_due';
  return null;
}

/** The reminder threshold (7, 3 or 1 days before the last day) that falls today, else null. */
function reminderThreshold(daysLeft) {
  return billing.REMINDER_DAYS.includes(daysLeft) ? daysLeft : null;
}

module.exports = { periodState, planTransition, reminderThreshold };
