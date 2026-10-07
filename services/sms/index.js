'use strict';

const logger = require('../../utils/logger');

const DRIVERS = {
  console: () => require('./console'),
  unifonic: () => require('./unifonic'),
  msegat: () => require('./msegat'),
};

const NOT_CONFIGURED = {
  name: 'none',
  async send() {
    return { ok: false, providerRef: null, error: 'not_configured' };
  },
};

/**
 * The driver named by SMS_PROVIDER. Without one, development uses the console
 * driver. Production never uses the console driver, even when asked, because
 * it writes login codes to the log; it gets the not-configured driver instead.
 */
function selectDriver(env = process.env) {
  const name = (env.SMS_PROVIDER || '').trim().toLowerCase();
  if (env.NODE_ENV === 'production' && name === 'console') {
    logger.error(
      'SMS_PROVIDER=console cannot be used in production (it writes login codes to the log); ' +
        'no SMS will be sent until a real provider is configured',
    );
    return NOT_CONFIGURED;
  }
  if (DRIVERS[name]) return DRIVERS[name]();
  if (!name && env.NODE_ENV !== 'production') return DRIVERS.console();
  return NOT_CONFIGURED;
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

/**
 * The account balance of the selected provider: { supported: false } for the
 * console driver or an unconfigured one, otherwise { supported: true, ok, balance | error }.
 * Never logs keys or numbers.
 */
async function getBalance(driver = selectDriver()) {
  if (!driver || typeof driver.getBalance !== 'function') return { supported: false };
  try {
    return await driver.getBalance();
  } catch (err) {
    return { supported: true, ok: false, error: err.code || 'driver_error' };
  }
}

module.exports = { selectDriver, sendSms, getBalance };
