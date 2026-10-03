// Starts Moyasar's hosted payment form with the settings the server printed
// as JSON (own-origin script, no inline code).
(function () {
  'use strict';
  var holder = document.getElementById('moyasar-config');
  var missing = document.getElementById('moyasar-missing');
  if (!holder) return;
  try {
    var config = JSON.parse(holder.textContent);
    if (!window.Moyasar || typeof window.Moyasar.init !== 'function') throw new Error('no form');
    window.Moyasar.init(config);
  } catch (err) {
    if (missing) missing.hidden = false;
  }
})();
