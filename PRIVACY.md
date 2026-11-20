# Hallow Shield - privacy

- **Nothing you browse leaves your PC.** Hallow Shield has no server, no account, no analytics and no telemetry.
- **The browser does the blocking.** The blocking rules are handed to the browser (Chrome's declarativeNetRequest); the
  browser applies them itself. Hallow Shield's own code never sees the addresses you visit or the requests pages make.
- **What the content script does:** on each page it tells Shield's own background script the site's name, so the right
  "hide this ad box" CSS can be added. It reads nothing else from the page and sends nothing anywhere.
- **What is stored, on your PC only:** the sites you paused Shield on and your three switches (browser extension storage).
- **The count in the popup** comes from the browser, for the tab you opened the popup on, and is never stored.
- **Updates to the filter lists** come with new versions of the extension (built from EasyList and EasyPrivacy every
  week); the extension itself never downloads anything.
