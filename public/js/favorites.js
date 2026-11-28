'use strict';
// Favourite listings, kept only in this browser (localStorage). Nothing is sent to the server
// except the ids in the favourites page address.
(function () {
  var KEY = 'mi3aad.favorites';
  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(function (n) { return /^\d{1,18}$/.test(String(n)); }).map(String) : []; } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-60))); } catch (e) { /* private mode: ignore */ }
  }
  function paint() {
    var favs = read();
    document.querySelectorAll('[data-fav]').forEach(function (b) {
      var on = favs.indexOf(b.getAttribute('data-fav')) >= 0;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-fav-count]').forEach(function (el) { el.textContent = favs.length ? String(favs.length) : ''; el.hidden = !favs.length; });
    document.querySelectorAll('a[data-fav-link]').forEach(function (a) { a.href = '/listings/favorites' + (favs.length ? '?ids=' + favs.join(',') : ''); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-fav]');
    if (!b) return;
    e.preventDefault();
    var id = b.getAttribute('data-fav');
    var favs = read();
    var i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1); else favs.push(id);
    write(favs);
    paint();
  });
  var page = document.querySelector('[data-fav-page]');
  if (page && page.getAttribute('data-asked') !== '1') {
    var favs = read();
    if (favs.length) { location.replace('/listings/favorites?ids=' + favs.join(',')); return; }
  }
  paint();
})();
