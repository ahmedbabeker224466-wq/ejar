// Six-box code entry: auto-advance, backspace to previous box, paste a whole
// code into any box, and a countdown before a new code can be requested.
(function () {
  'use strict';

  var ARABIC = '٠١٢٣٤٥٦٧٨٩';
  var PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

  function digitsOnly(text) {
    return String(text || '')
      .replace(/[٠-٩]/g, function (d) { return String(ARABIC.indexOf(d)); })
      .replace(/[۰-۹]/g, function (d) { return String(PERSIAN.indexOf(d)); })
      .replace(/\D/g, '');
  }

  var form = document.getElementById('otp-form');
  if (form) {
    var boxes = Array.prototype.slice.call(form.querySelectorAll('.otp__box'));
    var hidden = document.getElementById('otp-code');

    function fill(start, digits) {
      for (var i = 0; i < digits.length && start + i < boxes.length; i++) {
        boxes[start + i].value = digits[i];
      }
      var next = Math.min(start + digits.length, boxes.length - 1);
      boxes[next].focus();
      if (boxes.every(function (b) { return b.value; })) form.requestSubmit ? form.requestSubmit() : form.submit();
    }

    boxes.forEach(function (box, index) {
      box.addEventListener('input', function () {
        var digits = digitsOnly(box.value);
        box.value = '';
        if (digits) fill(index, digits);
      });
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' && !box.value && index > 0) {
          boxes[index - 1].value = '';
          boxes[index - 1].focus();
          event.preventDefault();
        }
      });
      box.addEventListener('paste', function (event) {
        var text = (event.clipboardData || window.clipboardData).getData('text');
        var digits = digitsOnly(text).slice(0, 6);
        if (digits) {
          event.preventDefault();
          fill(digits.length === 6 ? 0 : index, digits);
        }
      });
    });

    form.addEventListener('submit', function () {
      hidden.value = boxes.map(function (b) { return digitsOnly(b.value); }).join('');
    });
  }

  var button = document.getElementById('resend-button');
  if (button) {
    var left = parseInt(button.getAttribute('data-wait'), 10) || 0;
    var wait = document.getElementById('resend-wait');
    var seconds = document.getElementById('resend-seconds');
    function tick() {
      if (left <= 0) {
        button.disabled = false;
        if (wait) wait.hidden = true;
        return;
      }
      button.disabled = true;
      if (wait) wait.hidden = false;
      if (seconds) seconds.textContent = String(left);
      left -= 1;
      setTimeout(tick, 1000);
    }
    tick();
  }
})();
