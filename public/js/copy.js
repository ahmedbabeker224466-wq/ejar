// Copy buttons: <button data-copy="#target" data-copied="تم النسخ">.
(function () {
  'use strict';

  function selectText(element) {
    var range = document.createRange();
    range.selectNodeContents(element);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var target = document.querySelector(button.getAttribute('data-copy'));
    if (!target) return;
    var text = target.textContent.trim();
    var original = button.textContent;

    function done() {
      button.textContent = button.getAttribute('data-copied') || original;
      setTimeout(function () {
        button.textContent = original;
      }, 2000);
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        selectText(target);
      });
    } else {
      // Older browsers or plain http: select it so the person can copy.
      selectText(target);
    }
  });
})();
