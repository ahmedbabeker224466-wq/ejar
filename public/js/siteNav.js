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
  // A menu link that stays on the same page (an #anchor) does not reload it,
  // so close the menus, and the phone menu, as soon as any item is chosen.
  var phoneMenu = document.getElementById('mk-menu');
  function closeAll() {
    menus.forEach(function (menu) { menu.open = false; });
    if (phoneMenu) phoneMenu.checked = false;
  }
  document.querySelectorAll('.mk-dd__item, .mk-nav__panel a').forEach(function (link) {
    link.addEventListener('click', closeAll);
  });
  window.addEventListener('hashchange', closeAll);
  window.addEventListener('pageshow', function (event) { if (event.persisted) closeAll(); });
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
