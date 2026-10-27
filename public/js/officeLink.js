// Live check of the office link while typing (the server checks again on save).
(function () {
  'use strict';
  var form = document.querySelector('[data-slug-form]');
  if (!form) return;
  var input = form.querySelector('input[name="slug"]');
  var error = form.querySelector('[data-slug-error]');
  var min = Number(form.getAttribute('data-min')) || 3;
  var max = Number(form.getAttribute('data-max')) || 40;

  function problem(value) {
    if (!value) return 'اكتب الرابط المطلوب.';
    if (!/^[a-z0-9-]+$/.test(value)) return 'استخدم حروفاً إنجليزية صغيرة (a-z) وأرقاماً وشرطة واحدة (-) بين الكلمات فقط.';
    if (value.length < min || value.length > max) return 'الرابط من ' + min + ' إلى ' + max + ' حرفاً.';
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return 'لا تبدأ الرابط أو تنهِه بشرطة، ولا تكتب شرطتين متتاليتين.';
    return '';
  }

  input.addEventListener('input', function () {
    var lowered = input.value.toLowerCase();
    if (lowered !== input.value) input.value = lowered;
    var text = problem(input.value.trim());
    error.textContent = text;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  });
})();
