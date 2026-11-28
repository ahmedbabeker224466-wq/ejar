'use strict';
// Share button on a listing: the phone's share sheet when available, else copy the link.
(function () {
  document.querySelectorAll('[data-share]').forEach(function (b) {
    b.addEventListener('click', function () {
      var url = location.href.split('#')[0];
      if (navigator.share) { navigator.share({ title: b.getAttribute('data-title') || document.title, url: url }).catch(function () {}); return; }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          var label = b.querySelector('[data-share-label]');
          if (!label) return;
          var old = label.textContent;
          label.textContent = document.documentElement.lang === 'en' ? 'Link copied' : 'تم نسخ الرابط';
          setTimeout(function () { label.textContent = old; }, 2000);
        });
      }
    });
  });
})();
