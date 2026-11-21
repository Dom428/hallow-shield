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
    Sponsored"). Since 1.5 it also tells the background which class and id names the page's elements use (only those
    names, for example "ad-banner"), so only the generic hiding rules for those names are added instead of a
    14,000-rule stylesheet in every frame. It reads nothing else (no text, no addresses, no form fields) and sends
    nothing anywhere - the background script is part of the extension, on your PC.
  - the lists' small page fixes ("scriptlets") on the sites the lists name - for example the ones that remove the ad
    data from YouTube's player responses, edit a site's JSON settings ("ads: off"), or put a link's real destination
    in place of a tracking redirect (`href-sanitizer`). They change how the page behaves inside your browser and send
    nothing.
  - since 1.5 the procedural hiding engine and the cookie-banner clicker are only added to a page (by Shield's
    background, from inside the extension) when that site has filters for them.
- **The element zapper** ("Hide something on this page" / "Zap once") is injected only into the tab you opened the
  popup on, and only when you click the button (the browser's "activeTab" access). It looks at the page in your
  browser to work out a selector for what you point at. "Hide" saves that rule (`site##selector`) in My filters;
  "Zap once" saves nothing. Nothing is sent anywhere.
- **My filters** (the options page) are converted inside the extension when you save them and handed to the browser as
  its own rules. Export writes them to a text file on your PC; import reads a file you pick. They are never uploaded.
- **Cookie banners answered** ("Handle cookie banners"): on the sites the uBlock cookie list names, Shield's clicker
  clicks the "Reject" / "Necessary only" button the list's filter names, in your browser. It may read the page's own
  cookies or local storage only to check the filter's condition (for example "only if there's no consent cookie
  yet"). It tells Shield's background script that it clicked, so the click is counted; nothing else is sent anywhere.
- **Stats** (options page): per day, how many ads / trackers / other things were blocked, on which sites (the tab's
  site name) and which blocked hosts (when the rule names one), and how many cookie banners were answered - for the
  last 30 days, kept in the extension's own storage on your PC and never sent anywhere. **Clear stats** deletes them.
  Blocked counts only come with the optional "declarativeNetRequestFeedback" permission you can turn on on the Stats
  page (Chrome calls it "Read your browsing history"): with it the browser tells Shield which of its rules matched on
  which tab, not the addresses. Development builds use the browser's debug event, which includes the address, to
  count the blocked host.
- **Try fixing this site** (after **Report a broken site** in the popup) only changes Shield's own setting for that
  site, step by step (Normal, No hiding, Blocking only, Off), reloads the tab and asks you whether it works. The step
  it's on is kept in Shield's storage while you look; the setting you say yes to stays (like Strict or Off). Nothing is
  sent anywhere.
- **The popup's "N cookie banners answered here"** comes from the stats above (the clicks are counted per site since
  1.5), for the last 30 days.
- **What is stored, on your PC only** (browser extension storage): your blocking level, which lists you switched off,
  the cookie-banner and annoyance switches, the sites you set to Strict, Off (paused), No hiding or Blocking only, the
  step "Try fixing this site" is on, My filters (including what you hid with the zapper) and the stats above (with
  cookie banners answered per site).
- **The count in the popup** comes from the browser, for the tab you opened the popup on, and is not stored as such
  (the stats are counted separately, see above).
- **Report a broken site** only copies a short text to your clipboard (the page address without its query string,
  Shield's version, level and list versions, your browser's version). Shield sends nothing - you choose whether and
  where to paste it.
