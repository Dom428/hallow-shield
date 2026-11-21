// Hallow Shield stand-in for FuckAdBlock / BlockAdBlock style detectors: they always report "no ad blocker".
(function () {
  'use strict';
  var Det = function () { };
  Det.prototype = {
    check: function () { return this; }, emitEvent: function () { return this; }, clearEvent: function () { return this; },
    on: function (detected, fn) { if (!detected && typeof fn === 'function') setTimeout(function () { try { fn(); } catch (e) { } }, 1); return this; },
    onDetected: function () { return this; }, onNotDetected: function (fn) { return this.on(false, fn); }, setOption: function () { return this; }, options: {},
  };
  var inst = new Det();
  window.fuckAdBlock = window.blockAdBlock = window.sniffAdBlock = inst;
  window.FuckAdBlock = window.BlockAdBlock = window.SniffAdBlock = Det;
})();
