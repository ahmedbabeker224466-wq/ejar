'use strict';

const logger = require('../../utils/logger');

const DRIVERS = {
  console: () => require('./console'),
  unifonic: () => require('./unifonic'),
  msegat: () => require('./msegat'),
};

/**
 * The driver named by SMS_PROVIDER. Without one, development uses the console
 * driver; production refuses to send rather than silently logging codes.
 */
function selectDriver(env = process.env) {
  const name = (env.SMS_PROVIDER || '').trim().toLowerCase();
  if (DRIVERS[name]) return DRIVERS[name]();
  if (!name && env.NODE_ENV !== 'production') return DRIVERS.console();
  return {
    name: 'none',
    async send() {
      return { ok: false, providerRef: null, error: 'not_configured' };
    },
  };
}

/**
 * Sends through the selected driver and logs destination, status and duration
 * only. The message (which may contain a code) is never logged here.
 */
async function sendSms(toE164, message, driver = selectDriver()) {
  const started = Date.now();
  let result;
  try {
    result = await driver.send(toE164, message);
  } catch (err) {
    result = { ok: false, providerRef: null, error: err.code || 'driver_error' };
  }
  const ms = Date.now() - started;
  const masked = `${toE164.slice(0, 6)}****${toE164.slice(-2)}`;
  if (result.ok) logger.info(`SMS via ${driver.name} to ${masked}: sent in ${ms}ms`);
  else logger.warn(`SMS via ${driver.name} to ${masked}: failed (${result.error}) in ${ms}ms`);
  return result;
}

module.exports = { selectDriver, sendSms };
