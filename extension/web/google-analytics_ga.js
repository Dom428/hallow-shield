// Hallow Shield stand-in for the old Google Analytics ga.js: the page keeps working, nothing is sent.
(function () {
  'use strict';
  var noop = function () { };
  var tracker = new Proxy({}, { get: function (o, k) { return k === '_getLinkerUrl' ? function (u) { return u; } : noop; } });
  window._gat = { _createTracker: function () { return tracker; }, _getTracker: function () { return tracker; }, _getTrackerByName: function () { return tracker; }, _anonymizeIp: noop };
  var gaq = window._gaq;
  window._gaq = { push: function () { for (var i = 0; i < arguments.length; i++) { var c = arguments[i]; if (typeof c === 'function') { try { c(); } catch (e) { } } } return 0; } };
  if (Array.isArray(gaq)) window._gaq.push.apply(null, gaq);
})();
