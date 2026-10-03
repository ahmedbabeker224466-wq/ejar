// The tenant's maintenance form posts to the chosen contract: <select data-action-template="/tenant/contracts/{id}/maintenance">.
(function () {
  'use strict';
  var select = document.querySelector('[data-action-template]');
  var form = document.getElementById('maintenance-form');
  if (!select || !form) return;
  function update() {
    form.setAttribute('action', select.getAttribute('data-action-template').replace('{id}', encodeURIComponent(select.value)));
  }
  select.addEventListener('change', update);
  update();
})();
