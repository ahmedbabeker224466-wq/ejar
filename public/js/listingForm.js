// Shows only the neighborhoods of the chosen city (the full list stays in the
// page, so the form works without JavaScript too).
(function () {
  'use strict';
  var city = document.querySelector('[data-hood-city]');
  var hood = document.querySelector('[data-hood-select]');
  if (!city || !hood) return;
  function apply() {
    var groups = hood.querySelectorAll('optgroup');
    for (var i = 0; i < groups.length; i += 1) {
      var show = groups[i].getAttribute('data-city') === city.value;
      groups[i].hidden = !show;
      groups[i].disabled = !show;
    }
    var selected = hood.options[hood.selectedIndex];
    if (selected && selected.parentNode.disabled) hood.value = '';
  }
  city.addEventListener('change', apply);
  apply();
})();
