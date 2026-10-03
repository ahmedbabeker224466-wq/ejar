// Print buttons: <button data-print>.
(function () {
  'use strict';
  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-print]')) window.print();
  });
})();
