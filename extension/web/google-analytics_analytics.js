// Hallow Shield stand-in for Google Analytics (analytics.js): the page keeps working, nothing is sent.
(function () {
  'use strict';
  var noop = function () { };
  var tracker = { get: function () { }, set: noop, send: noop };
  var ga = function () {
    var a = arguments, last = a[a.length - 1];
    if (last && typeof last === 'object' && typeof last.hitCallback === 'function') { try { last.hitCallback(); } catch (e) { } }
    if (typeof last === 'function') { try { last(tracker); } catch (e) { } }
  };
  ga.create = function () { return tracker; };
  ga.getByName = function () { return tracker; };
  ga.getAll = function () { return [tracker]; };
  ga.remove = noop; ga.loaded = true;
  var name = window.GoogleAnalyticsObject || 'ga', q = window[name] && window[name].q;
  window[name] = ga;
  if (Array.isArray(q)) for (var i = 0; i < q.length; i++) { try { ga.apply(null, q[i]); } catch (e) { } }
  var dl = window.dataLayer;
  if (dl && dl.hide && typeof dl.hide.end === 'function') { try { dl.hide.end(); } catch (e) { } }
})();
