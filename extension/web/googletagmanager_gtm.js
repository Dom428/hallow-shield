// Hallow Shield stand-in for Google Tag Manager (gtm.js): pages waiting for GTM callbacks keep working.
(function () {
  'use strict';
  window.ga = window.ga || function () { };
  var dl = window.dataLayer;
  if (!dl) return;
  if (dl.hide && typeof dl.hide.end === 'function') { try { dl.hide.end(); } catch (e) { } dl.hide.end = function () { }; }
  var run = function (o) { if (o && typeof o.eventCallback === 'function') setTimeout(function () { try { o.eventCallback(); } catch (e) { } }, 1); };
  if (typeof dl.push === 'function') {
    for (var i = 0; i < dl.length; i++) run(dl[i]);
    dl.push = function () { for (var i = 0; i < arguments.length; i++) run(arguments[i]); return Array.prototype.push.apply(this, arguments); };
  }
})();
