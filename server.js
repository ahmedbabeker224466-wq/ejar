'use strict';

// Startup file for cPanel ("Setup Node.js App" -> Application startup file).
// Passenger loads this file through its own loader, so it must start the
// server unconditionally (no `require.main === module` check).

require('dotenv').config({ quiet: true });

const app = require('./app');
const logger = require('./utils/logger');
const selfCheck = require('./services/selfCheck');
const { setReport, state } = require('./services/runtimeState');

const DB_RETRY_MS = 30 * 1000;

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason && reason.message ? reason.message : reason}`);
});

/** Retries the database until it answers, then leaves maintenance mode. */
function retryDatabaseUntilReady() {
  const timer = setInterval(async () => {
    const report = await selfCheck.run();
    if (!report.maintenance) {
      clearInterval(timer);
      setReport(report);
      logger.info(`Database is reachable again; serving normally\n${selfCheck.formatReport(report)}`);
    }
  }, DB_RETRY_MS);
  timer.unref();
}

async function start() {
  let report;
  try {
    report = await selfCheck.run();
  } catch (err) {
    report = { maintenance: true, reasons: [`self-check crashed (${err.message})`] };
  }
  setReport(report);
  if (report.node) logger.info(`\n${selfCheck.formatReport(report)}`);

  // Only the database can recover on its own; missing settings need a restart.
  const envOk = report.env && report.env.ok;
  if (state.maintenance && envOk) retryDatabaseUntilReady();

  // Under Passenger (cPanel) listen() is taken over and the port is ignored;
  // PORT or 3000 is for local runs.
  const port = Number(process.env.PORT) || 3000;
  const underPassenger = typeof global.PhusionPassenger !== 'undefined';
  app.listen(port, () =>
    logger.info(underPassenger ? 'Aqdi started under Passenger' : `Aqdi listening on port ${port}`),
  );
}

start();
