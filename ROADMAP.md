# Hallow Shield roadmap

## Done

| Version | What |
|---|---|
| **1.0** | EasyList + EasyPrivacy converted to declarativeNetRequest, generic and per-site ad-box CSS with `#@#` exceptions, Pause on this site (dynamic allowAllRequests rule + CSS left out), switches for ads / trackers / ad boxes, per-page count in the popup, Chrome and Firefox packages, weekly rebuild, tests: converter, the extension in Chromium against test pages, the real rules against real ad servers (never released on its own - shipped as part of 1.1) |
| **1.1** | "As good as Brave's blocker, YouTube included": uBlock filters + Badware risks + Privacy + Unbreak + Quick fixes and Peter Lowe's list next to EasyList/EasyPrivacy, one static ruleset each; plain host filters merged into shared `requestDomains` rules (all lists ~20.5k rules, inside the 30k guarantee - this also fixes the gpt.js miss, where the 20k budget dropped `\|\|g.doubleclick.net^`); dynamic-rule fallback when the shared pool has no room; regex filters checked by Chromium; `$redirect`/`$redirect-rule` to Shield's own stand-ins; `$removeparam`, `$csp`, `$popup` (strict, at Complete), `$important` above exceptions, `$badfilter` across lists, `$denyallow`, `$to`/`$from`, `$method`, `$document`, `!#if`/`!#include`; procedural cosmetics (`:has-text`, `:upward`, `:has`, `:matches-css`, `:remove`, `:style`, `:xpath`, ...), specific-generic, `$generichide`/`$elemhide`/`$specifichide`, entities; 38 scriptlets of Shield's own in the page's MAIN world (YouTube: initial data + player API cleaned); Basic / Optimal / Complete levels, Advanced list picker, Report a broken site (clipboard only); tests: unit, e2e incl. a fake YouTube page, real-list smoke incl. uBO's real YouTube filters, Firefox lint |
| **1.2** | Cookie banners and annoyances: uBlock filters - Cookie notices + EasyList Cookie List (**Hide cookie banners**, on by default) and uBlock filters - Annoyances + Fanboy's Annoyances (newsletters, notifications, chat, other) + Fanboy's Social (**Hide annoyances**, off by default), one static ruleset each, their hiding filters and scriptlets kept as switchable groups (default lists ~22.3k rules, every list ~23.9k, inside the 30k guarantee); **element zapper** ("Hide something on this page": hover, widen / narrow with keys or buttons, click; saved as `site##selector`; "Zap once"; closed shadow root, injected with activeTab only when asked); **My filters** options page (network filters converted in the extension by the shared converter into dynamic rules, hiding filters per site and generic, per-line errors, the browser's regex check, zapper rules listed with Delete, export / import), applied at every level; `!#if` parsed without eval; tests: picker selectors and My filters (unit), cookie banners on/off, annoyances, zapper + reload, zap once, Esc, My filters network + hiding, export / import round trip (e2e), real cookie-notice and annoyance selectors (smoke) |

## Next

- More scriptlets: `json-edit` family, `trusted-replace-argument`, `href-sanitizer`, `trusted-prevent-dom-bypass` (about 1,360 filters still skipped, ~880 of them the cookie lists' `trusted-click-element` "click Reject" filters)
- **Hallow family:** "blocked today" tile in Hallow Remote / Hub (needs a small native bridge - the extension itself has no way to talk to the apps yet)
- Publish: Chrome Web Store / Edge Add-ons / addons.mozilla.org listings (needs your developer accounts)
- `trusted-click-element`, so cookie banners can be answered with "Reject" instead of only hidden
- Regional lists as opt-in rulesets (EasyList Germany, Liste FR, ...) - there's room: ~23.9k of 30k rules used with every list on
- Zapper: picking inside frames, and a preview of everything else a selector matches before you hide it

## Later

- A Toolkit page that blocks ad and tracker domains for every app on the PC (hosts file), with undo
