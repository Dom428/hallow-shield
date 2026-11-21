# Hallow Shield

An ad and tracker blocker for **Chrome, Edge, Brave, Opera and Firefox** - part of the Hallow family with
[Hallow Keys](https://github.com/Dom428/hallow-keys), [Hallow Hub](https://github.com/Dom428/hallow-hub) and the others.

Shield aims to block like Brave Shields and uBlock Origin Lite, within what Manifest V3 allows:

- **The lists the good blockers use:** uBlock filters (+ Badware risks, Privacy, Unbreak, Quick fixes), EasyList,
  EasyPrivacy and Peter Lowe's list, rebuilt from the newest versions every week. Switch any of them off under
  **Advanced** in the popup.
- **Cookie banners and annoyances:** uBlock filters - Cookie notices and the EasyList Cookie List hide consent
  pop-ups (**Hide cookie banners**, on by default); uBlock filters - Annoyances, Fanboy's Annoyances (newsletters,
  notifications, chat) and Fanboy's Social hide newsletter nags, chat bubbles and social widgets (**Hide annoyances**,
  off by default). Both switches are in the popup and under **Advanced**, where single lists can be switched off too.
- **Hide something on this page:** an element zapper like uBlock Origin's picker. Point at something, widen or narrow
  the pick with the arrow keys (or the buttons), click, and it stays hidden on that site (saved as `site##selector` in
  My filters). **Zap once** removes it from this page only. The picker's panel lives in a closed shadow root, so pages
  can't restyle or break it; it is only injected into the tab when you click the button.
- **My filters:** your own filters in Adblock Plus / uBlock Origin syntax on the options page - hiding filters
  (`site##selector`, `##selector`, procedural ones with a site) and network filters (`||host^`, `@@` exceptions,
  `$script`, `$third-party`, `$domain=`, `$removeparam=`, ...). Network filters are converted in the extension, with
  the same converter the lists go through, into the browser's own (dynamic) rules when you save. Every line that can't
  be used says why. Export / import as a text file. Scriptlet filters (`##+js`) are refused: Shield only runs the
  page fixes that ship with it.
- **YouTube ads:** uBlock Origin's YouTube filters run on YouTube - the ad data is removed from the player's
  initial data and from its player API responses (fetch and XHR) before the player sees it.
- **Fast and private:** the browser blocks requests itself (`declarativeNetRequest`). Shield's code never sees what
  you browse, there's no Hallow server, and the extension never downloads anything. See [PRIVACY.md](PRIVACY.md).
- **More than plain blocking:** regex filters (checked by the browser at build time), `$redirect` to Shield's own
  harmless stand-ins (so pages that expect an ad library keep working), `$removeparam` (tracking parameters such as
  `utm_source` and `fbclid` stripped), `$csp`, `$important`, `$badfilter`, `$denyallow`, `$to`/`$from`, `$document`
  blocking of badware sites, and strict blocking of pop-up ad sites.
- **Hides what's left:** ad boxes hidden on every site and site by site, procedural filters (`:has-text`, `:upward`,
  `:has`, `:matches-css`, `:remove`, `:style`, `:xpath`, ...) that keep working as the page changes, and the lists'
  exceptions (`#@#`, `$generichide`, `$elemhide`).
- **Page fixes (scriptlets):** Shield's own versions of the uBO scriptlets the lists use most - `set-constant`,
  `json-prune` (+ fetch / XHR response), `abort-on-property-read/write`, `abort-current-script`, `prevent-fetch`,
  `prevent-xhr`, `prevent-setTimeout/setInterval`, `remove-attr/class`, `remove/replace-node-text`,
  `trusted-replace-fetch/xhr-response`, `no-window-open-if`, `addEventListener-defuser`, `adjust-setTimeout/setInterval`
  and more (38 in all) - running in the page at document start on the sites the lists name.
- **Blocking: Basic / Optimal / Complete,** like uBO Lite. *Basic* blocks requests only and runs nothing in pages.
  *Optimal* (the default) adds ad-box hiding and the page fixes on the sites Shield may access. *Complete* adds strict
  blocking of pop-up and pop-under ad sites.
- **Pause on this site** in one click, a per-page blocked count, and **Report a broken site**, which copies the
  details to your clipboard (nothing is sent).

## Install

Download the zip for your browser from the [latest release](https://github.com/Dom428/hallow-shield/releases/latest)
(`hallow-shield-chrome-1.2.zip` or `hallow-shield-firefox-1.2.zip`) and unzip it into a folder of its own:

- **Chrome, Edge, Brave, Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**,
  click **Load unpacked** and pick that folder. Keep the folder - the browser loads Shield from it. To update, unzip
  the new version over the same folder and click the reload arrow on Shield's card.
- **Firefox (128 or newer):** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, pick
  `manifest.json` in the unzipped folder (temporary until the add-on is signed on addons.mozilla.org). Firefox asks
  you to allow access to all sites - Shield needs it to hide ad boxes and fix YouTube; the popup has a button for it.

## Honest limits (compared with Brave Shields and uBlock Origin)

- **Manifest V3 limits apply.** Shield can't do what full uBlock Origin does with its own network code: no
  `$redirect-rule` for broad patterns (311 skipped), no `$replace`/`$urlskip`/`$header`/`$cname`, no HTML filtering
  (`##^`), no regex `$removeparam`, no entity domains (`site.*`) in network filters (about 340 skipped). Cosmetic and
  scriptlet filters *do* support entities.
- **About 1,360 of ~17,200 scriptlet filters are skipped** - the ones using scriptlets Shield doesn't implement yet.
  Most (about 880) are the cookie lists' `trusted-click-element` filters that click "Reject" for you; the rest are
  `json-edit*`, `trusted-replace-argument`, `href-sanitizer`, `trusted-prevent-dom-bypass`, ... A handful are YouTube
  quick fixes; the main YouTube filters (initial data, player API) all run.
- **YouTube changes often.** The YouTube filters are uBO's; Shield is tested against a local page shaped like
  YouTube's (initial player data + player API), not against youtube.com itself, and gets uBO's fixes only when a new
  Shield version is built (weekly) - full uBO updates its lists more often.
- **Rule room:** with the default lists (ads, privacy, cookie banners) Shield uses about 22,300 rules, inside
  the 30,000 Chrome guarantees every extension (host filters are merged into shared rules, as uBO Lite does). With
  **Hide annoyances** on too it's about 23,900; the rest comes from the browser's shared pool, and if a list ever
  didn't fit, Shield loads it as dynamic rules instead and says so under Advanced. Regex rules: about 145 of the
  browser's 1,000; ones the browser refuses are left out at build time. My filters may add up to 2,000 network rules.
- **Cookie banners are hidden, not answered.** Shield hides consent pop-ups and blocks their scripts where the lists
  say so; it doesn't click "reject" for you (uBO's `trusted-click-element` isn't implemented), so a site that waits
  for an answer may keep asking or show less. Switch **Hide cookie banners** off for that site's sake, or pause Shield.
- **Hiding needs Optimal or Complete** for the lists' filters. What you hid yourself (zapper, My filters) is also
  applied at Basic.
- **Pop-ups:** the browser can't tell a pop-up from any other new tab, so `$popup` filters only become rules for whole
  ad hosts opened from another site, and only at *Complete*.
- **Firefox:** the Firefox package is built and linted in CI, but the end-to-end tests run in Chromium only.

## Building

- `npm install`, then `npm run rules` (downloads the newest lists and converts them), `npm run regex` (Chromium checks
  every regex rule), `npm run package` (zips into `dist/`).
- Tests: `npm test` (converter, scriptlets, the picker's selectors, My filters), `npm run rules:sample && npm run e2e`
  (the real extension in Chromium against local test pages: blocking, redirects, `$removeparam`, `$csp`, procedural
  filters, scriptlets, a fake YouTube page, pause, levels, lists, the dynamic-rule fallback, cookie banners and
  annoyances on and off, the zapper (hide + reload, zap once, Esc), My filters (network + hiding, errors per line,
  export / import), the popup), `npm run smoke` (the real rules: they all load, real ad servers are blocked, uBO's
  real YouTube filters clean a fake YouTube page, and real cookie-notice and annoyance selectors hide boxes on a test
  page). CI runs all of them on every push and every Monday. `node tools/explain.mjs <url> <page>` shows which filters
  touch a request and what became of them.

## Credits

- Filter lists: uBlock filters (incl. Cookie notices and Annoyances) by Raymond Hill and contributors (GPLv3);
  EasyList, EasyPrivacy, EasyList Cookie List, Fanboy's Annoyances and Fanboy's Social by The EasyList authors and
  Fanboy (GPLv3 / CC BY-SA 3.0); Peter Lowe's list. See [extension/LISTS-LICENSE.txt](extension/LISTS-LICENSE.txt).
- The approach follows [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) (GPLv3). Shield's converter,
  scriptlets, procedural filter engine, element picker and redirect stand-ins are its own code - no uBO code is included.
