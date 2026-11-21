// Hallow Shield stand-in for Amazon Publisher Services (apstag.js): bids come back empty right away.
(function () {
  'use strict';
  var noop = function () { };
  var q = window.apstag && window.apstag._Q;
  window.apstag = {
    _Q: [], init: noop, setDisplayBids: noop, targetingKeys: function () { return []; }, renderImp: noop, deleteId: noop, rpa: noop, upa: noop, dpa: noop,
    fetchBids: function (cfg, cb) { if (typeof cb === 'function') setTimeout(function () { try { cb([]); } catch (e) { } }, 1); },
  };
  if (Array.isArray(q)) for (var i = 0; i < q.length; i++) { var c = q[i]; if (c && c[0] === 'f') window.apstag.fetchBids.apply(null, c[1]); }
})();
