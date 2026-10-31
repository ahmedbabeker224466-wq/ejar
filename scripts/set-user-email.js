#!/usr/bin/env node
'use strict';

// One-off: gives an existing user (found by login phone) an email address, so
// they can use the email test sign-in (AUTH_EMAIL_TEST=true) without SQL.
// Run on the server (cPanel Terminal) from the app folder, with the database
// settings in .env:
//
//   node scripts/set-user-email.js 0588624755 owner@example.com
//
// The email is stored lower-case and must not belong to another user.
// platform_admin accounts are refused (they keep phone + 2FA). The schema is
// brought up to date first (adds the unique email index if missing).
// Exit code 0 on success, 1 otherwise. Prints no secret.

require('dotenv').config({ quiet: true });

const MESSAGES = {
  invalid_phone: 'The phone is not a valid Saudi mobile number (05XXXXXXXX).',
  invalid_email: 'The email address is not valid.',
  no_user: 'No user signs in with this phone number.',
  platform_admin: 'This is a platform_admin account; it keeps phone + 2FA and gets no email sign-in.',
  taken: 'Another user already has this email address.',
};

async function main() {
  const [phone, email, extra] = process.argv.slice(2);
  if (!phone || !email || extra || phone === '--help' || phone === '-h') {
    console.log('Usage: node scripts/set-user-email.js <phone> <email>');
    return 1;
  }
  const db = require('../config/db');
  const { setUserEmail } = require('../services/emailAuth');
  try {
    const schema = await db.ensureSchema();
    if (!schema.ok) {
      console.error(`Database not ready: ${schema.error}`);
      return 1;
    }
    const result = await setUserEmail(db.pool, phone, email);
    if (!result.ok) {
      console.error(MESSAGES[result.error] || result.error);
      return 1;
    }
    console.log(result.changed
      ? `Done: user ${result.userId} now has this email.`
      : `Nothing to do: user ${result.userId} already has this email.`);
    return 0;
  } finally {
    await db.pool.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`Failed: ${err.code || err.message}`);
    process.exitCode = 1;
  },
);
