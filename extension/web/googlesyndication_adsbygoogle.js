// Hallow Shield stand-in for Google AdSense (adsbygoogle.js): ad slots stay empty, the page's code doesn't fail.
(function () {
  'use strict';
  var old = window.adsbygoogle;
  window.adsbygoogle = { loaded: true, push: function () { } };
  if (old && typeof old.onload === 'function') { try { old.onload(); } catch (e) { } }
})();
