'use strict';

const logger = require('../utils/logger');

// Must keep four arguments so Express treats it as an error handler.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  // Log what happened and where, never the request body.
  logger.error(`${req.method} ${req.path} failed: ${err.message}`, err.stack);

  if (res.headersSent) return next(err);

  res.status(err.status || 500);
  res.render('errors/500', { title: 'حدث خطأ' }, (renderErr, html) => {
    // If the error page itself fails, fall back to plain text.
    if (renderErr) return res.type('text').send('حدث خطأ غير متوقع');
    res.send(html);
  });
};
