# Hallow Shield

An ad and tracker blocker for **Chrome, Edge, Brave, Opera and Firefox** - part of the Hallow family with
[Hallow Keys](https://github.com/Dom428/hallow-keys), [Hallow Hub](https://github.com/Dom428/hallow-hub) and the others.

Shield aims to block like Brave Shields and uBlock Origin Lite, within what Manifest V3 allows:

- **The lists the good blockers use:** uBlock filters (+ Badware risks, Privacy, Unbreak, Quick fixes), EasyList,
  EasyPrivacy and Peter Lowe's list, rebuilt from the newest versions every week. Switch any of them off under
  **Advanced** in the popup.
- **Cookie banners answered, not just hidden:** with **Handle cookie banners (reject where possible)** on (the
  default), Shield clicks "Reject" / "Necessary only" on about 1,950 sites the uBlock cookie list knows how to answer
  (its 852 `trusted-click-element` filters, run by Shield's own clicker), and hides the consent pop-ups of the rest
  (uBlock filters - Cookie notices and the EasyList Cookie List). The clicker only clicks the element the list's
  selector names (selector chains such as "Settings, then Reject", `>>>` for shadow roots, the cookie / localStorage
  conditions and delays the filters use), gives up after 10 seconds, never runs on a site you set to Off (paused),
  and counts every click.
- **Annoyances:** uBlock filters - Annoyances, Fanboy's Annoyances (newsletters, notifications, chat) and Fanboy's
  Social hide newsletter nags, chat bubbles and social widgets (**Hide annoyances**, off by default). Both switches
  are in the popup and under **Advanced**, where single lists can be switched off too.
- **Strict / Normal / Off per site** in the popup: *Strict* is Complete blocking plus the annoyance lists on that site
  only, *Normal* follows your settings, *Off* is Pause. The options page lists the sites you set, with Delete.
- **Stats** (options page, or **Stats** in the popup): ads and trackers blocked per day for the last 30 days, top
  sites and top blocked hosts, and cookie banners answered - kept in the browser on your PC, never sent, with
  **Clear stats**. Blocked counts need one optional permission (see Honest limits).
- **Hide something on this page:** an element zapper like uBlock Origin's picker. Point at something, widen or narrow
  the pick with the arrow keys (or the buttons), click, and it stays hidden on that site (saved as `site##selector` in
  My filters). It works inside frames of the page's own site too ("Wider" from a frame's content picks the frame);
  a frame from another site is picked as a whole. **Zap once** removes it from this page only. The picker's panel lives in a closed shadow root, so pages
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
  **Measured in CI** on every build (`npm run perf`): a heavy local page (about 4,000 elements, 140 images and
  scripts, 6 frames, 20 ms per response) loads in 513 ms without Shield and 559 ms with Shield at Optimal and the real
  lists (+46 ms, 9 %; Shield's content scripts and page fixes: 17 ms of script time). With the same page served
  instantly it's +59 ms - most of that is the browser applying 24,000 blocking rules to 140 requests; Shield 1.4 added
  about 300 ms to that instant page (see Honest limits). The build fails if Shield adds more than 15 % or 50 ms (a CI
  machine has noisy minutes, so a round over budget gets up to two fresh rounds).
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
  and, new in 1.5, `trusted-replace-argument`, `href-sanitizer` (tracking links get their real destination),
  `trusted-prevent-dom-bypass`, the `json-edit` family (`json-edit`, `json-edit-fetch-response`,
  `json-edit-xhr-response`, `jsonl-edit-*`, `json-edit-*-request` and their `trusted-` twins, with uBO's documented
  JSONPath-like syntax: `..key`, `.*`, `[?.a=="b"]` / `[?@.a>1]` filters, `^=` `$=` `*=` `=/regex/`, `=value`,
  `+={...}`, `repl()`, `;` sub-queries with quantifiers) and `edit-inbound/outbound-object` - 59 in all, running in the
  page at document start on the sites the lists name.
- **Blocking: Basic / Optimal / Complete,** like uBO Lite. *Basic* blocks requests only and runs nothing in pages.
  *Optimal* (the default) adds ad-box hiding and the page fixes on the sites Shield may access. *Complete* adds strict
  blocking of pop-up and pop-under ad sites.
- **Share counts with Hallow apps on this PC** (new in 1.6, options page > Stats, off by default): Hallow Hub and
  Hallow Remote can show how much Shield blocked today and this week. See [Hallow family](#hallow-family) below.
- **Try fixing this site** (new in 1.5, offered after **Report a broken site**): Shield steps the site through
  *Normal*, *No hiding* (blocking and page fixes only), *Blocking only* and *Off*, reloading the tab each time and asking
  "Is it working now?". The mildest step that works stays as that site's own setting (listed under **Sites**, with
  Delete); Cancel, or a site that's broken even with Shield off, puts your setting back. All local.
- **The badge follows the level:** the blocked count on Shield's icon is orange at Optimal, pink at Complete, slate at
  Basic (and on No hiding / Blocking only sites), red on a Strict site. The popup also says **"N cookie banners answered
  here"** when Shield clicked "Reject" on that site in the last 30 days.
- **Off on this site** (Pause) in one click, a per-page blocked count, and **Report a broken site**, which copies the
  details to your clipboard (nothing is sent).

## Install

Download the zip for your browser from the [latest release](https://github.com/Dom428/hallow-shield/releases/latest)
(`hallow-shield-chrome-1.6.zip` or `hallow-shield-firefox-1.6.zip`) and unzip it into a folder of its own - or let
[Hallow Setup](https://github.com/Dom428/hallow-setup) 1.6+ do it (it checks GitHub's checksum and keeps the folder up to
date; 1.8+ also registers the Hallow family bridge). Each zip has a `version.json` with its version and build date.

- **Chrome, Edge, Brave, Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**,
  click **Load unpacked** and pick that folder. Keep the folder - the browser loads Shield from it. To update, unzip
  the new version over the same folder and click the reload arrow on Shield's card.
- **Firefox (128 or newer):** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, pick
  `manifest.json` in the unzipped folder (temporary until the add-on is signed on addons.mozilla.org). Firefox asks
  you to allow access to all sites - Shield needs it to hide ad boxes and fix YouTube; the popup has a button for it.

> **Updating from 1.5 or older to 1.6: remove the old card and load Shield again.** Shield 1.6 has a fixed extension
> ID (a `key` in `manifest.json`, like Hallow Keys) so the Hallow family bridge can trust it. Before 1.6 the browser
> made the ID up from the folder's path, so for the browser 1.6 is a **new extension**: its settings, site modes and
> stats start fresh, and the old card stays until you remove it. Export **My filters** first (options page > My
> filters > Export), then unzip 1.6 over the folder, remove the old Shield card, click **Load unpacked** (or the reload
> arrow - if two cards show, remove the old one) and import My filters again. Firefox keeps its add-on id, so nothing
> changes there. From 1.6 on, updates keep everything again.

## Hallow family

Shield can show up in the other Hallow apps: with **Share counts with Hallow apps on this PC** on (options page >
Stats; **off by default**, and the browser asks for the "communicate with cooperating native applications" access
first), Shield hands a few numbers to the **Hallow family bridge**, `HallowShieldBridge.exe` - a tiny program on your
PC that the browser starts (native messaging host `com.hallow.shield`) - about once a minute and when you open the
popup. Hallow Hub and Hallow Remote read what it writes.

- **What is sent:** `{ blockedToday, blockedWeek, bannersToday, level, version, browser, profile, day }` - blocked
  today, blocked in the last 7 days, cookie banners answered today, the blocking level, Shield's version, the browser's
  name, a random id Shield makes once in each browser profile (so two profiles don't overwrite each other) and the
  PC's local date of the counts. **Never a URL, a site, a host or history.** With blocked counts off (the Stats page's
  optional permission), the three counts are `null`. The bridge also keeps only these fields: anything else in a
  message is thrown away. Nothing leaves your PC.
- **Getting the bridge:** both zips carry it in `bridge\` (with `install-bridge.ps1`).
  [Hallow Setup](https://github.com/Dom428/hallow-setup) 1.8+ registers it when it installs or updates Shield. By hand:
  `powershell -ExecutionPolicy Bypass -File bridge\install-bridge.ps1` in Shield's folder (`-Uninstall` to remove,
  `-Status` to check). It copies the exe to `%LOCALAPPDATA%\Hallow Shield\bridge` and registers it for your Windows
  user only (HKCU, no admin) for Chrome, Edge, Brave (Opera reads Chrome's entry) and Firefox. Chromium browsers only
  let Shield's fixed ID `afghaliocnljjjegfnaonfghpjgpebni` start it, Firefox only `hallow-shield@dom428.github.io`.
- **`%APPDATA%\HallowShield\status.json`** - the only file the bridge writes, replaced atomically (a temp file
  swapped in, so a reader never sees half of it), one entry per browser and profile:

  ```json
  {"version":"1.6","updated":"2026-11-21T15:04:05Z",
   "browsers":[{"name":"Chrome","profile":"Default","version":"1.6","level":"optimal","blockedToday":123,
                "blockedWeek":4567,"bannersToday":3,"updated":"2026-11-21T15:04:05Z","day":"2026-11-21","id":"3f9a0c1d2b4e5f60"}],
   "blockedToday":123,"blockedWeek":4567,"bannersToday":3}
  ```

  - `version`: the bridge's version; `updated`: when the file was last written (UTC, ISO 8601).
  - `browsers[]`: `name` (Chrome, Edge, Brave, Opera, Vivaldi, Chromium or Firefox), `profile` (`Default` for the
    first profile seen in that browser, then `Profile 2`, ...), Shield's `version` and `level` (`basic`,
    `optimal` or `complete`), the three counts (numbers, or `null` when that profile's blocked counts are off), when
    that browser last reported (`updated`), the browser's local date of the counts (`day`) and the random profile
    `id`. Read the fields you need and ignore the rest - more may come.
  - Top-level `blockedToday` / `bannersToday`: the sums over entries reported **today**; `blockedWeek`: the sum
    over entries heard from in the **last 2 days**. Older entries stay listed but aren't counted (a browser you closed
    yesterday still shows, with its `updated` time); entries not heard from for 30 days are dropped. A sum is `null`
    when no counted entry has a number.
  - No file: sharing was never turned on (or the bridge isn't registered). Old `updated`: no browser with Shield and
    sharing on has run lately.

## Honest limits (compared with Brave Shields and uBlock Origin)

- **Manifest V3 limits apply.** Shield can't do what full uBlock Origin does with its own network code: no
  `$redirect-rule` for broad patterns (311 skipped), no `$replace`/`$urlskip`/`$header`/`$cname`, no HTML filtering
  (`##^`), no regex `$removeparam`, no entity domains (`site.*`) in network filters (about 340 skipped). Cosmetic and
  scriptlet filters *do* support entities.
- **About 224 scriptlet filters are still skipped** (1.4: 512, 1.2: 1,364) - the ones using scriptlets Shield doesn't
  implement yet: the 30 `trusted-click-element` filters outside the cookie lists (not used on purpose),
  `trusted-replace-outbound-text` (22), `nobab` (21), `trusted-suppress-native-method` (20), `trusted-create-html` (20),
  `xml-prune` (18), `refresh-defuser` (12), .... The JSONPath edits support uBO's documented syntax except `=call()`,
  slices and `||` / `&&` in filters (a filter using those does nothing). A handful are YouTube quick fixes; the main
  YouTube filters (initial data, player API) all run.
- **YouTube changes often.** The YouTube filters are uBO's; Shield is tested against a local page shaped like
  YouTube's (initial player data + player API), not against youtube.com itself, and gets uBO's fixes only when a new
  Shield version is built (weekly) - full uBO updates its lists more often.
- **Rule room:** with the default lists (ads, privacy, cookie banners) Shield uses about 22,300 rules, inside
  the 30,000 Chrome guarantees every extension (host filters are merged into shared rules, as uBO Lite does). With
  **Hide annoyances** on too it's about 23,900; the rest comes from the browser's shared pool, and if a list ever
  didn't fit, Shield loads it as dynamic rules instead and says so under Advanced. Regex rules: about 220 of the
  browser's 1,000; ones the browser refuses are left out at build time. My filters may add up to 2,000 network rules.
- **Cookie banners: "Reject" only where the list says how.** The clicker runs the uBlock cookie list's
  `trusted-click-element` filters only (about 1,950 sites; filters of this kind in other
  lists aren't used), at Optimal and Complete (or on a Strict site), and only in the isolated world - pages can't see
  or steer it. A site the list doesn't know is hidden, not answered, and may keep asking. A site that changes its
  banner breaks its filter until the list is fixed (Shield gets list fixes weekly). If it ever clicks the wrong thing,
  set that site to Off and report it.
- **Stats need the browser's say-so.** The browser only tells an extension which of its rules matched if it has the
  optional `declarativeNetRequestFeedback` permission, which Chrome words as "Read your browsing history" - so it's
  off until you click **Turn on blocked counts** on the Stats page (cookie-banner clicks are counted either way).
  With it, Shield reads the browser's list of matched rules (which list, which tab, when - not the addresses) about
  once a minute, within the browser's limit of 20 reads per 10 minutes; pages you leave quickly may be under-counted.
  The blocked host is known only when the rule names one host (many hosts share one rule, to fit the browser's
  limits). Development builds (no `version.json`) count each match as it happens (`onRuleMatchedDebug`) instead.
- **Strict per site** adds the pop-up list and the annoyance lists' rules for that site as dynamic rules (at most 5,000;
  their regex, redirect and header rules are left out) plus their hiding and page fixes.
- **Hiding needs Optimal or Complete** for the lists' filters. What you hid yourself (zapper, My filters) is also
  applied at Basic.
- **Generic hiding comes once the page is parsed (1.5).** The lists' hiding rules for every site that start with a class
  or id (about 13,000 of 13,900) are no longer one big stylesheet in every frame - that cost a heavy page with frames
  about 100 ms. Shield's content script reports the class and id names a page uses when it has been parsed (and as it
  changes), and only the matching rules are added. A box hidden only by such a generic rule can show for a moment while
  the page loads; site-specific hiding still applies from the start.
- **Page fixes are bundled per top-level domain (1.5)** (`.com`, `.de`, ...; the small ones share a bundle), each
  registered with one pattern instead of one per site: 1.4's 36,000 site patterns were checked by the browser for every
  frame. The bundle looks the page's site up itself, so a `.com` page loads the `.com` bundle (about 0.7 MB).
- **Pop-ups:** the browser can't tell a pop-up from any other new tab, so `$popup` filters only become rules for whole
  ad hosts opened from another site, and only at *Complete*.
- **Firefox:** the Firefox package is built and linted in CI, but the end-to-end tests run in Chromium only.
- **The Hallow family bridge is Windows only** (the Hallow apps are), and the counts are as fresh as the stats: the
  browser gives Shield its matched rules about once a minute, so Hub and Remote can be a minute behind.

## Building

- `npm install`, then `npm run rules` (downloads the newest lists and converts them), `npm run regex` (Chromium checks
  every regex rule), `npm run package` (zips into `dist/`).
- The bridge: `bridge\build.ps1 -Test` (Windows, the .NET Framework C# compiler that ships with Windows) builds
  `bridge\HallowShieldBridge.exe` and runs its unit tests (message framing, merging browsers and profiles, the atomic
  write, stale entries, registering under a test registry key); `npm run e2e:bridge` runs the real extension in
  Chromium with the switch turned on and checks that a message reaches the host and that what is sent / written has
  the counts and no URLs (on Windows with the real bridge, elsewhere with `test/bridge-standin.mjs`). CI builds the
  bridge on Windows and packs it into both zips.
- Tests: `npm test` (converter, scriptlets, the picker's selectors, My filters, the cookie-banner clicker, stats,
  per-site modes and Strict rules), `npm run rules:sample && npm run e2e`
  (the real extension in Chromium against local test pages: blocking, redirects, `$removeparam`, `$csp`, procedural
  filters, scriptlets, a fake YouTube page, pause, levels, lists, the dynamic-rule fallback, cookie banners and
  annoyances on and off, the zapper (hide + reload, zap once, Esc, inside a frame), My filters (network + hiding,
  errors per line, export / import), cookie banners answered (Reject clicked, Accept never; chains, closed shadow roots,
  frames, cookie conditions, exceptions; nothing when paused, switched off or at Basic), Strict / Normal / Off and the
  Sites list, stats counted and cleared, the popup; 1.5: json-edit on fetch / XHR / JSON.parse, href-sanitizer,
  trusted-replace-argument, trusted-prevent-dom-bypass, the badge colours, "Try fixing this site", "N cookie banners
  answered here"), `npm run smoke` (the real rules: they all load, real ad servers are blocked, uBO's
  real YouTube filters clean a fake YouTube page, and real cookie-notice and annoyance selectors hide boxes on a test
  page), `npm run perf` (a heavy local page with and without Shield at Optimal, with the real rules: fails if Shield adds
  more than 15 % or 50 ms to the load time, or more than 50 ms of script time). CI runs all of them on every push and
  every Monday. `node tools/explain.mjs <url> <page>` shows which filters
  touch a request and what became of them.

## Credits

- Filter lists: uBlock filters (incl. Cookie notices and Annoyances) by Raymond Hill and contributors (GPLv3);
  EasyList, EasyPrivacy, EasyList Cookie List, Fanboy's Annoyances and Fanboy's Social by The EasyList authors and
  Fanboy (GPLv3 / CC BY-SA 3.0); Peter Lowe's list. See [extension/LISTS-LICENSE.txt](extension/LISTS-LICENSE.txt).
- The approach follows [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) (GPLv3). Shield's converter,
  scriptlets, cookie-banner clicker, procedural filter engine, element picker and redirect stand-ins are its own code -
  no uBO code is included.
