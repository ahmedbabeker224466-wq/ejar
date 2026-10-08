'use strict';

// The Ejar / REGA rules the contract engine applies: the ONLY place these
// numbers exist. services/contractEngine.js reads them (every function also
// accepts a `rules` argument so tests can override them).
//
// Each rule: VERIFY against the official Ejar/REGA source before launch.
// A wrong number here means someone misses a real legal deadline.

const RULES = Object.freeze({
  // Notice not to renew must be given at least this many days before end_date.
  // VERIFY against the official Ejar/REGA source before launch.
  NON_RENEWAL_NOTICE_DAYS: 60,

  // The landlord must request a rent change at least this many days before end_date.
  // VERIFY against the official Ejar/REGA source before launch.
  RENT_CHANGE_NOTICE_DAYS: 90,

  // Ejar contracts renew automatically for a term equal to the previous one
  // unless someone acts in time.
  // VERIFY against the official Ejar/REGA source before launch.
  AUTO_RENEW_DEFAULT: true,

  // Rent increases are frozen for residential and commercial units in Riyadh
  // for `years` years from `from`; a reduction request is still allowed. The
  // freeze is judged on the date the new rent would take effect (the first day
  // of the next term). Frozen: from <= effective date < from + years.
  // VERIFY against the official Ejar/REGA source before launch.
  RIYADH_RENT_FREEZE: Object.freeze({ city: 'riyadh', from: '2025-09-25', years: 5 }),

  // Stage thresholds, in days left until the decision (non-renewal notice)
  // deadline: more than soonDays = calm, urgentDays+1..soonDays = soon,
  // 0..urgentDays = urgent, below 0 = deadline passed.
  // VERIFY against the official Ejar/REGA source before launch.
  STAGE_THRESHOLDS: Object.freeze({ soonDays: 30, urgentDays: 7 }),

  // Who checked the numbers above, when, and against which official source.
  // Left null here: the platform admin records the verification on /admin/launch
  // (stored in the database). Filling these two in is also accepted by that page.
  // They are not rules and the engine never reads them.
  verifiedAt: null, // 'YYYY-MM-DD'
  verifiedSource: null, // text, at least 10 characters
});

module.exports = RULES;
