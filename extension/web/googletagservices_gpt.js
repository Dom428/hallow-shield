// Hallow Shield stand-in for Google Publisher Tag (gpt.js): googletag works, no ads are requested.
(function () {
  'use strict';
  var noop = function () { };
  var chain = function () { return this; };
  var slot = function (path, id) {
    var s = {};
    ['addService', 'clearCategoryExclusions', 'clearTargeting', 'defineSizeMapping', 'set', 'setCategoryExclusion', 'setClickUrl', 'setCollapseEmptyDiv',
      'setConfig', 'setForceSafeFrame', 'setSafeFrameConfig', 'setTargeting', 'updateTargetingFromMap'].forEach(function (k) { s[k] = chain; });
    s.get = function () { return null; }; s.getAdUnitPath = function () { return path || ''; }; s.getSlotElementId = function () { return id || ''; };
    s.getTargeting = function () { return []; }; s.getTargetingKeys = function () { return []; }; s.getResponseInformation = function () { return null; };
    s.getSizes = function () { return []; }; s.getAttributeKeys = function () { return []; }; s.getCategoryExclusions = function () { return []; };
    return s;
  };
  var pubads = {};
  ['addEventListener', 'clear', 'clearCategoryExclusions', 'clearTagForChildDirectedTreatment', 'clearTargeting', 'collapseEmptyDivs', 'defineOutOfPagePassback',
    'definePassback', 'disableInitialLoad', 'display', 'enableAsyncRendering', 'enableLazyLoad', 'enableSingleRequest', 'enableSyncRendering', 'enableVideoAds',
    'refresh', 'removeEventListener', 'set', 'setCategoryExclusion', 'setCentering', 'setCookieOptions', 'setForceSafeFrame', 'setLocation', 'setPrivacySettings',
    'setPublisherProvidedId', 'setRequestNonPersonalizedAds', 'setSafeFrameConfig', 'setTagForChildDirectedTreatment', 'setTargeting', 'setVideoContent',
    'updateCorrelator', 'setConfig'].forEach(function (k) { pubads[k] = chain; });
  pubads.get = function () { return null; }; pubads.getAttributeKeys = function () { return []; }; pubads.getTargeting = function () { return []; };
  pubads.getTargetingKeys = function () { return []; }; pubads.getSlots = function () { return []; }; pubads.isInitialLoadDisabled = function () { return true; };
  var gt = window.googletag || {};
  var cmd = Array.isArray(gt.cmd) ? gt.cmd : [];
  gt.apiReady = true; gt.pubadsReady = true;
  gt.pubads = function () { return pubads; };
  gt.companionAds = function () { return { setRefreshUnfilledSlots: noop, addEventListener: noop }; };
  gt.content = function () { return { setContent: noop, addEventListener: noop }; };
  gt.defineSlot = function (p, s, id) { return slot(p, id); };
  gt.defineOutOfPageSlot = function (p, id) { return slot(p, id); };
  gt.destroySlots = function () { return true; };
  gt.disablePublisherConsole = noop; gt.display = noop; gt.enableServices = noop; gt.openConsole = noop; gt.setAdIframeTitle = noop; gt.setConfig = noop;
  gt.getVersion = function () { return ''; };
  gt.sizeMapping = function () { var b = { addSize: function () { return b; }, build: function () { return []; } }; return b; };
  gt.cmd = { push: function (f) { try { f.call(window); } catch (e) { } return 1; } };
  window.googletag = gt;
  for (var i = 0; i < cmd.length; i++) gt.cmd.push(cmd[i]);
})();
