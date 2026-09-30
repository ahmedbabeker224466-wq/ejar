'use strict';

// Shared, in-process state set by the startup self-check. While `maintenance`
// is true every page shows the maintenance screen instead of touching the
// database. Starts false so tests and scripts that import the app work normally.

const state = {
  maintenance: false,
  reasons: [],
  report: null,
};

function setReport(report) {
  state.report = report;
  state.maintenance = report.maintenance;
  state.reasons = report.reasons;
}

module.exports = { state, setReport };
