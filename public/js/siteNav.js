'use strict';

// Site header menus (views/site/_mk-header.ejs): one open at a time, closed by
// a click outside or the Escape key. Without this script the menus still open
// and close by themselves (native <details>).
(function () {
  var menus = Array.prototype.slice.call(document.querySelectorAll('.mk-dd'));
  if (!menus.length) return;
  menus.forEach(function (menu) {
    menu.addEventListener('toggle', function () {
      if (!menu.open) return;
      menus.forEach(function (other) { if (other !== menu) other.open = false; });
    });
  });
  document.addEventListener('click', function (event) {
    menus.forEach(function (menu) { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    menus.forEach(function (menu) {
      if (!menu.open) return;
      menu.open = false;
      var summary = menu.querySelector('summary');
      if (summary) summary.focus();
    });
  });
})();
