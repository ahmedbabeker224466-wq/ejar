// Progressive enhancement for the listing gallery: clicking a thumbnail shows
// that photo in the large frame. Without JavaScript the links open the photo.
(function () {
  'use strict';
  var gallery = document.querySelector('[data-gallery]');
  if (!gallery) return;
  var main = gallery.querySelector('[data-gallery-main]');
  var mainLink = gallery.querySelector('.gallery__main-link');
  gallery.addEventListener('click', function (event) {
    var link = event.target.closest('[data-gallery-thumb]');
    if (!link || !main) return;
    event.preventDefault();
    main.src = link.getAttribute('href');
    if (mainLink) mainLink.setAttribute('href', link.getAttribute('href'));
  });
})();
