'use strict';

const logger = require('../utils/logger');

/**
 * What is safe to log about an error. Some messages quote user data:
 * body-parser/JSON errors can include part of the request body, and MySQL
 * messages can include column values (e.g. "Duplicate entry '...'"). For
 * those, log only the type or code, never the message or stack.
 */
function describeForLog(err) {
  if (err.type && typeof err.type === 'string' && err.type.startsWith('entity.')) {
    return `request body rejected (${err.type})`;
  }
  if (err.sqlState || (typeof err.code === 'string' && err.code.startsWith('ER_'))) {
    return `database error ${err.code || ''} (errno ${err.errno ?? '?'})`;
  }
  return err.stack || err.message;
}

// Must keep four arguments so Express treats it as an error handler.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  logger.error(`${req.method} ${req.path} failed: ${describeForLog(err)}`);

  if (res.headersSent) return next(err);

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status);
  res.render('errors/500', { title: 'حدث خطأ' }, (renderErr, html) => {
    // If the error page itself fails, fall back to plain text.
    if (renderErr) return res.type('text').send('حدث خطأ غير متوقع');
    res.send(html);
  });
};

module.exports.describeForLog = describeForLog;
