'use strict';
// Arrow buttons for the horizontal listing rows (the rows also scroll by touch and trackpad).
(function () {
  document.querySelectorAll('.prow').forEach(function (row) {
    var track = row.querySelector('[data-track]');
    if (!track) return;
    var buttons = row.querySelectorAll('[data-scroll]');
    var rtl = getComputedStyle(track).direction === 'rtl';
    function update() {
      var max = track.scrollWidth - track.clientWidth;
      var pos = Math.abs(track.scrollLeft);
      buttons.forEach(function (b) {
        var dir = Number(b.getAttribute('data-scroll'));
        b.hidden = max <= 4;
        b.disabled = dir < 0 ? pos <= 4 : pos >= max - 4;
      });
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var step = track.clientWidth * 0.85 * Number(b.getAttribute('data-scroll'));
        track.scrollBy({ left: rtl ? -step : step, behavior: 'smooth' });
      });
    });
    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  });
})();
