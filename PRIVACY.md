# Hallow Shield - privacy

- **Nothing you browse leaves your PC.** Hallow Shield has no server, no account, no analytics and no telemetry.
- **The browser does the blocking.** The blocking rules are handed to the browser (declarativeNetRequest); the browser
  applies them itself. Hallow Shield's own code never sees the addresses you visit or the requests pages make.
- **No remote code, no downloads.** The filter lists are downloaded and converted when a new version of Shield is built
  (on GitHub's build machines, every week). Everything the extension uses - rules, CSS, the small page scripts - ships
  inside the extension. It never fetches anything from the internet.
- **What runs in pages** (only at the Optimal and Complete levels, and only on sites Shield has access to):
  - a content script that tells Shield's own background script the site's name, so the right "hide this ad box" CSS
    can be added, and then applies that site's procedural hiding rules (for example "hide the box that says
    Sponsored"). It reads nothing else and sends nothing anywhere.
  - the lists' small page fixes ("scriptlets") on the sites the lists name - for example the ones that remove the ad
    data from YouTube's player responses. They change how the page behaves inside your browser and send nothing.
- **What is stored, on your PC only** (browser extension storage): your blocking level, which lists you switched off,
  and the sites you paused Shield on.
- **The count in the popup** comes from the browser, for the tab you opened the popup on, and is never stored.
- **Report a broken site** only copies a short text to your clipboard (the page address without its query string,
  Shield's version, level and list versions, your browser's version). Shield sends nothing - you choose whether and
  where to paste it.
