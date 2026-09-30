'use strict';

const { state } = require('../services/runtimeState');

/**
 * While the self-check reports a problem (missing settings, database down),
 * serve an Arabic maintenance page for everything except the health checks.
 * Runs before anything that touches the database.
 */
module.exports = function maintenance(req, res, next) {
  if (!state.maintenance) return next();
  if (req.path === '/health' || req.path.startsWith('/health/')) return next();
  res.set('Retry-After', '120');
  res.set('Cache-Control', 'no-store');
  return res.status(503).render('errors/maintenance', { title: 'الموقع تحت الصيانة' });
};
