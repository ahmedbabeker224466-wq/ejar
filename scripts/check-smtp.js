'use strict';

// Sends one test email with the SMTP settings in the environment, to check
// them from cPanel ("Run JS script" -> smtp-test). Prints only the outcome
// and a short error code, never a setting or a password.
// Usage: node scripts/check-smtp.js [address]   (default info@mi3aad.com)

require('dotenv').config({ quiet: true });
const email = require('../services/channels/email');

const to = (process.argv[2] || 'info@mi3aad.com').trim();

(async () => {
  const result = await email.send({
    to,
    subject: 'رسالة تجريبية من ميعاد',
    text: 'هذه رسالة تجريبية للتأكد من أن البريد الصادر في ميعاد يعمل.\nتطبيق خاص غير تابع لمنصة إيجار، والتواريخ للتذكير فقط',
  });
  console.log(result.ok ? `smtp-test: sent to ${to}` : `smtp-test: failed (${result.error})`);
  process.exitCode = result.ok ? 0 : 1;
})();
