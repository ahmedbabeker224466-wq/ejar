'use strict';

// Timestamped console logging with levels. Callers pass messages and small
// metadata objects only; never pass request bodies, contract contents or secrets.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;

function write(level, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta === undefined) out(line);
  else out(line, meta);
}

module.exports = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
