'use strict';

// Billing constants. Money is integer halalas in code; prices are stored
// VAT-exclusive. Nothing here is a secret (Moyasar keys come from the
// environment only) and no company or VAT number is hardcoded: seller
// details are platform settings edited by the platform admin.

module.exports = Object.freeze({
  CURRENCY: 'SAR',
  // VAT in basis points: 1500 = 15.00%. Rounded half up on the whole order.
  VAT_RATE_BP: 1500,
  // After a paid period ends: read-only for this many days, then suspended.
  GRACE_DAYS: 7,
  // Suspended data is kept this long (a policy shown to the owner; nothing is deleted automatically).
  DATA_KEEP_DAYS: 90,
  // A pending order that was never paid expires after this many hours.
  ORDER_TTL_HOURS: 24,
  // Reminders before a period ends (and on the day it ends).
  REMINDER_DAYS: Object.freeze([7, 3, 1]),
  INTERVAL_MONTHS: Object.freeze({ monthly: 1, yearly: 12 }),
  // Invoice numbers: SERIES-YEAR-000001, gap-free per series and year.
  SERIES: Object.freeze({ invoice: 'INV', credit_note: 'CN' }),
  // Moyasar: TEST MODE ONLY. Live keys are refused (see services/moyasar.js).
  MOYASAR: Object.freeze({
    API_BASE: 'https://api.moyasar.com/v1',
    FORM_SCRIPT: 'https://cdn.moyasar.com/mpf/1.14.0/moyasar.js',
    FORM_STYLE: 'https://cdn.moyasar.com/mpf/1.14.0/moyasar.css',
    TIMEOUT_MS: 15000,
  }),
});
