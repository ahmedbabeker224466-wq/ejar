// Linked selects (unit and contract forms): show only the options of the
// chosen landlord (buildings, or vacant units), and take the city from the
// chosen option. The server checks both again.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var landlord = document.querySelector('[data-landlord-select]');
    var building = document.querySelector('[data-building-select]');
    var city = document.querySelector('[data-city-select]');
    if (!landlord || !building) return;

    function filterBuildings() {
      Array.prototype.forEach.call(building.options, function (option) {
        if (!option.value) return;
        var mine = option.getAttribute('data-landlord') === landlord.value;
        option.hidden = !mine;
        option.disabled = !mine;
        if (!mine && option.selected) building.value = '';
      });
    }

    function takeCity() {
      var chosen = building.options[building.selectedIndex];
      if (city && chosen && chosen.value) city.value = chosen.getAttribute('data-city') || city.value;
    }

    landlord.addEventListener('change', filterBuildings);
    building.addEventListener('change', takeCity);
    filterBuildings();
  });
})();
