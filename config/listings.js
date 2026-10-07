'use strict';

// Public listing rules in one place.

module.exports = Object.freeze({
  // A published listing hides itself this many days after publishing or renewing.
  LISTING_DAYS: 60,
  // The owner is reminded this many days before it hides itself.
  REMIND_DAYS: 7,
  MAX_PHOTOS: 8,
  DESCRIPTION_MAX: 800,
  INQUIRY_MESSAGE_MAX: 500,
  // Visitors' own contact details are deleted after this many days.
  INQUIRY_KEEP_DAYS: 90,
  PAGE_SIZE: 12,
  // Anti-spam limits for the public forms (per hour).
  INQUIRY_PER_IP_PER_HOUR: 5,
  INQUIRY_PER_LISTING_PER_HOUR: 10,
  REPORT_PER_IP_PER_HOUR: 5,
  CONTACT_PER_IP_PER_HOUR: 5,
  THUMB_SIDE: 480,
});
