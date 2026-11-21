// Hallow Shield stand-in for comScore (beacon.js): nothing is measured, the page's calls still work.
(function () {
  'use strict';
  window.COMSCORE = { beacon: function () { }, purge: function () { window._comscore = []; } };
  window._comscore = [];
})();
