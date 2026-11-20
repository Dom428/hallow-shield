# Hallow Shield roadmap

## Done

| Version | What |
|---|---|
| **1.0** | EasyList + EasyPrivacy converted to declarativeNetRequest (exceptions first, most specific blocks first, 20k + 10k budget), generic and per-site ad-box CSS with `#@#` exceptions, Pause on this site (dynamic allowAllRequests rule + CSS left out), switches for ads / trackers / ad boxes, per-page count in the popup, Chrome and Firefox packages, weekly rebuild, tests: converter, the extension in Chromium against test pages, the real rules against real ad servers |

## Next

- **Hallow family:** "blocked today" tile in Hallow Remote / Hub (needs a small native bridge - the extension itself has no way to talk to the apps yet)
- Publish: Chrome Web Store / Edge Add-ons / addons.mozilla.org listings (needs your developer accounts)
- Regional lists as opt-in switches (EasyList Germany, Liste FR, ...) within the same 30k budget, or dynamic rules
- A "report a missed ad" button that opens a pre-filled EasyList forum post (nothing sent by Shield itself)

## Later

- Cookie-banner hiding (EasyList Cookie List / "I don't care about cookies"-style CSS), opt-in
- A Toolkit page that blocks ad and tracker domains for every app on the PC (hosts file), with undo
