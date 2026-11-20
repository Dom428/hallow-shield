# Hallow Shield

An ad and tracker blocker for **Chrome, Edge, Brave, Opera and Firefox** - part of the Hallow family with
[Hallow Keys](https://github.com/Dom428/hallow-keys), [Hallow Hub](https://github.com/Dom428/hallow-hub) and the others.

- **Blocks ads and trackers** with the community's [EasyList and EasyPrivacy](https://easylist.to/) filter lists, rebuilt
  from the newest lists every week.
- **Fast and private:** the browser blocks the requests itself (Manifest V3 `declarativeNetRequest`). Hallow Shield's code
  never sees what you browse, and there's no Hallow server. See [PRIVACY.md](PRIVACY.md).
- **Hides empty ad boxes** - on every site, and site by site as the lists say (and shows a box again where a list says
  a site needs it).
- **Pause on this site** in one click (for a site that breaks, or one you want to support), and switches for ads,
  trackers and ad boxes.
- The popup shows how many ads and trackers were blocked on the page you're looking at.

## Install

Download the zip for your browser from the latest build (Actions > Build > **hallow-shield** artifact) and unzip it:

- **Chrome, Edge, Brave, Opera:** open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**,
  click **Load unpacked** and pick the unzipped `hallow-shield-chrome` folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, pick `manifest.json` in the
  unzipped `hallow-shield-firefox` folder (temporary until the add-on is signed on addons.mozilla.org). Firefox asks you
  to allow access to all sites - Shield needs it to hide ad boxes.

## Honest limits

- **YouTube ads** change their tricks constantly and need code that runs inside the page; Shield doesn't promise to block
  them. [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) is the reference for that.
- Chrome guarantees every extension **30,000** blocking rules; Shield uses up to 20,000 from EasyList and 10,000 from
  EasyPrivacy, the most specific ones first. Filters the browser can't express (regular expressions, redirects,
  scriptlets, `$csp`, `$popup`, procedural cosmetics) are left out - `rules/meta.json` and the build log say how many.

## Building

- `npm install`, then `npm run rules` (downloads the newest EasyList and EasyPrivacy and converts them),
  `npm run package` (zips into `dist/`).
- Tests: `npm test` (the converter), `npm run rules:sample && npm run e2e` (the real extension in Chromium against
  test pages: blocking, exceptions, ad boxes, pause, switches, the count), `node test/smoke-real.mjs` (the real rules
  block real ad servers). CI runs all of them on every push and every Monday.

## Credits

Filter lists: EasyList and EasyPrivacy by The EasyList authors, CC BY-SA 3.0 / GPLv3 - see
[extension/LISTS-LICENSE.txt](extension/LISTS-LICENSE.txt). The converted rules carry the same CC BY-SA 3.0 license.
