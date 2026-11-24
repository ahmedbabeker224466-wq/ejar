'use strict';
// Admin tables on small screens: every cell gets its column name, so CSS can
// show each row as a card (see .adm-table in main.css).
(function () {
  document.querySelectorAll('table.adm-table').forEach(function (table) {
    var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    table.querySelectorAll('tbody tr').forEach(function (row) {
      Array.prototype.forEach.call(row.children, function (cell, i) {
        if (heads[i]) cell.setAttribute('data-label', heads[i]);
      });
    });
    table.classList.add('adm-table--cards');
  });
})();
