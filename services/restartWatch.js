'use strict';

// Restart on deploy. The shared host keeps the old Node process alive even
// after a restart from the cPanel Node.js page, so new code never loads. The
// deploy (and a manual upload) touches tmp/restart.txt; this watcher sees the
// newer modification time, closes the server and exits, and the web server
// starts a fresh process with the new code on the next request.

const fs = require('fs');
const path = require('path');

const RESTART_FILE = path.join(__dirname, '..', 'tmp', 'restart.txt');
const CHECK_MS = 15 * 1000;
const FORCE_EXIT_MS = 10 * 1000;

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

// Pure: should a process that saw `startMtime` at boot restart now?
function shouldRestart(startMtime, currentMtime) {
  if (currentMtime === null) return false;
  if (startMtime === null) return true;
  return currentMtime > startMtime;
}

function start({ server, logger, file = RESTART_FILE, checkMs = CHECK_MS, exit = (code) => process.exit(code) }) {
  const startMtime = mtimeOf(file);
  let stopping = false;
  const timer = setInterval(() => {
    if (stopping || !shouldRestart(startMtime, mtimeOf(file))) return;
    stopping = true;
    clearInterval(timer);
    logger.info('restart.txt changed: exiting so the new code loads');
    setTimeout(() => exit(0), FORCE_EXIT_MS).unref();
    if (server && typeof server.close === 'function') server.close(() => exit(0));
    else exit(0);
  }, checkMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, shouldRestart, RESTART_FILE };
