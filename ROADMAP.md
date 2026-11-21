# Hallow Shield roadmap

## Done

| Version | What |
|---|---|
| **1.0** | EasyList + EasyPrivacy converted to declarativeNetRequest, generic and per-site ad-box CSS with `#@#` exceptions, Pause on this site (dynamic allowAllRequests rule + CSS left out), switches for ads / trackers / ad boxes, per-page count in the popup, Chrome and Firefox packages, weekly rebuild, tests: converter, the extension in Chromium against test pages, the real rules against real ad servers (never released on its own - shipped as part of 1.1) |
| **1.1** | "As good as Brave's blocker, YouTube included": uBlock filters + Badware risks + Privacy + Unbreak + Quick fixes and Peter Lowe's list next to EasyList/EasyPrivacy, one static ruleset each; plain host filters merged into shared `requestDomains` rules (all lists ~20.5k rules, inside the 30k guarantee - this also fixes the gpt.js miss, where the 20k budget dropped `\|\|g.doubleclick.net^`); dynamic-rule fallback when the shared pool has no room; regex filters checked by Chromium; `$redirect`/`$redirect-rule` to Shield's own stand-ins; `$removeparam`, `$csp`, `$popup` (strict, at Complete), `$important` above exceptions, `$badfilter` across lists, `$denyallow`, `$to`/`$from`, `$method`, `$document`, `!#if`/`!#include`; procedural cosmetics (`:has-text`, `:upward`, `:has`, `:matches-css`, `:remove`, `:style`, `:xpath`, ...), specific-generic, `$generichide`/`$elemhide`/`$specifichide`, entities; 38 scriptlets of Shield's own in the page's MAIN world (YouTube: initial data + player API cleaned); Basic / Optimal / Complete levels, Advanced list picker, Report a broken site (clipboard only); tests: unit, e2e incl. a fake YouTube page, real-list smoke incl. uBO's real YouTube filters, Firefox lint |

## Next

- More scriptlets: `json-edit` family, `trusted-replace-argument`, `href-sanitizer`, `trusted-prevent-dom-bypass` (about 470 filters still skipped)
- **Hallow family:** "blocked today" tile in Hallow Remote / Hub (needs a small native bridge - the extension itself has no way to talk to the apps yet)
- Publish: Chrome Web Store / Edge Add-ons / addons.mozilla.org listings (needs your developer accounts)
- Regional lists as opt-in rulesets (EasyList Germany, Liste FR, ...) - there's room: ~20.5k of 30k rules used

## Later

- Cookie-banner hiding (EasyList Cookie List / uBO Annoyances), opt-in
- A Toolkit page that blocks ad and tracker domains for every app on the PC (hosts file), with undo
