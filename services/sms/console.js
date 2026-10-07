'use strict';

const logger = require('../../utils/logger');

// Development driver: prints the message instead of sending it, so the whole
// login flow works before an SMS account exists. This is the only place a code
// ever reaches a log, and only while this driver is selected.
module.exports = {
  name: 'console',
  async send(toE164, message) {
    logger.warn(`[SMS-CONSOLE] >>> to ${toE164}: ${message.replace(/\s*\n\s*/g, ' / ')}`);
    return { ok: true, providerRef: `console-${Date.now()}`, error: null };
  },
  // No account, no balance.
  async getBalance() {
    return { supported: false };
  },
};
