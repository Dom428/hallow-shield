// Hallow Shield: asks once per page for the ad-box CSS of this site. It reads nothing from the page and sends nothing
// anywhere - only the site's name goes to Shield's own background script.
(globalThis.browser ?? chrome).runtime.sendMessage({ t: 'site-css', host: location.hostname }).catch?.(() => { });
