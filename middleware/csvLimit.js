'use strict';

// One shared limit for every CSV download: 10 per minute per signed-in user.

const { rateLimit } = require('./rateLimit');

const csvLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyFor: (req) => `csv:${req.user ? req.user.id : req.ip}`,
  onLimit: (req, res) => res.status(429).type('text/plain; charset=utf-8').send('طلبات تصدير كثيرة. انتظر دقيقة ثم حاول مرة أخرى.'),
});

module.exports = { csvLimit };
