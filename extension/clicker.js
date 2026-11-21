// Hallow Shield cookie-banner clicker: Shield's own trusted-click-element (the uBlock cookie list's "click Reject /
// Necessary only" filters). A plain script in the isolated world, next to content.js, so it can also reach closed shadow
// roots (chrome.dom) and pages can't see or change it. content.js starts it with the jobs the background sends for this
// site - only while "Handle cookie banners" is on, never on a paused (or per-site Off) site, and never at Basic.
// Safety: it clicks only the element the list's selector names (querySelector, then a matches() check on that same
// element), gives up after a timeout, and reports every click so it can be counted. Loaded by the unit tests too.
(() => {
  const TIMEOUT = 10000;   // give up this long after the page started

  // "a, b, c" -> ["a", "b", "c"] (the list's selector chain: clicked one after the other)
  const splitSelectors = s => String(s || '').split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);

  // the optional extra-match argument: "cookie:name", "!cookie:name=value", "localStorage:key", "/regex/" values;
  // every assertion must hold or nothing is clicked (e.g. "!cookie:consent" = only while there's no consent cookie yet)
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function parseExtra(extra) {
    if (!extra) return [];
    return String(extra).split(',').map(s => {
      const p1 = s.indexOf(':');
      const s1 = (p1 !== -1 ? s.slice(0, p1) : s).trim();
      const not = s1.startsWith('!'), type = not ? s1.slice(1) : s1;
      const s2 = p1 !== -1 ? s.slice(p1 + 1).trim() : '';
      if (!s2 || (type !== 'cookie' && type !== 'localStorage')) return null;
      const m = /^\/(.+)\/(i?)$/.exec(s2);
      if (m) { try { return { not, type, re: new RegExp(m[1], m[2] || undefined) }; } catch { return { not, type, re: /(?!)/ }; } }
      const p2 = s2.indexOf('=');
      const key = p2 !== -1 ? s2.slice(0, p2).trim() : s2, value = p2 !== -1 ? s2.slice(p2 + 1).trim() : '';
      return { not, type, re: new RegExp(`^${escRe(key)}=${escRe(value)}`) };
    }).filter(Boolean);
  }
  // cookies: "a=1; b=2" (document.cookie), storage: [{ key, value }]
  function extraOk(assertions, { cookies = '', storage = [] } = {}) {
    if (!assertions.length) return true;
    const jar = String(cookies).split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return i < 0 ? { key: c, value: '' } : { key: decodeSafe(c.slice(0, i)), value: decodeSafe(c.slice(i + 1)) }; });
    const has = (list, re) => list.some(({ key, value }) => re.test(`${key}=${value}`));
    for (const { not, type, re } of assertions) {
      if (has(type === 'cookie' ? jar : storage, re) === not) return false;
    }
    return true;
  }
  function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

  // a shadow root, open or closed (closed ones only from an extension's isolated world)
  function shadowOf(el) {
    try {
      const ext = globalThis.chrome;
      if (ext && ext.dom && ext.dom.openOrClosedShadowRoot) return ext.dom.openOrClosedShadowRoot(el) || null;
    } catch { }
    return el.openOrClosedShadowRoot || el.shadowRoot || null;
  }
  // "outer >>> inner": inner is looked up inside outer's shadow root (any depth)
  function find(selector, ctx) {
    const pos = selector.indexOf('>>>');
    if (pos === -1) return { el: ctx.querySelector(selector), last: selector };
    const outside = selector.slice(0, pos).trim(), inside = selector.slice(pos + 3).trim();
    const host = ctx.querySelector(outside);
    if (!host) return { el: null, last: inside };
    const root = shadowOf(host);
    return root ? find(inside, root) : { el: null, last: inside };
  }
  // a selector the browser can't parse is left out (as uBO does)
  function valid(selector, doc) { try { find(selector, doc); return true; } catch { return false; } }

  // one filter's job: [selectors, extraMatch, delay]. opts: { doc, onClick(selector), onDone(clicked, reason), timeout, env }
  function runJob(job, opts) {
    const doc = opts.doc || document;
    const [selectors, extra, delay] = job;
    const done = (n, why) => { try { opts.onDone && opts.onDone(n, why); } catch { } };
    if (!extraOk(parseExtra(extra), opts.env ? opts.env() : envOf(doc))) return done(0, 'extra-match');
    const list = splitSelectors(selectors).filter(s => valid(s, doc));
    if (!list.length) return done(0, 'no-selector');
    const step = Math.max(0, parseInt(delay, 10) || 0);
    const t0 = Date.now(), bye = t0 + (opts.timeout ?? TIMEOUT);
    let tnext = list.length === 1 ? t0 + step : t0, timer = 0, mo = null, clicked = 0, over = false;
    const stop = why => {
      if (over) return; over = true;
      clearTimeout(timer); if (mo) mo.disconnect();
      done(clicked, why);
    };
    const later = ms => { clearTimeout(timer); timer = setTimeout(go, Math.max(1, ms)); };
    const watch = () => {
      if (mo || typeof MutationObserver === 'undefined') return;
      mo = new MutationObserver(() => { if (Date.now() >= tnext) later(1); });
      mo.observe(doc, { childList: true, subtree: true });
    };
    function go() {
      if (over) return;
      const now = Date.now();
      if (now >= bye) return stop('timeout');
      if (now < tnext) return later(tnext - now);
      const sel = list[0];
      const { el, last } = find(sel, doc);
      // exactly the element the selector names: an Element in the page that matches the (innermost) selector itself
      if (!el || el.nodeType !== 1 || !el.isConnected || !safeMatches(el, last)) { watch(); return later(Math.min(250, bye - now)); }
      list.shift();
      try { el.click(); clicked++; opts.onClick && opts.onClick(sel); } catch { }
      if (!list.length) return stop('done');
      tnext = Date.now() + step;
      later(step || 1);
    }
    later(Math.max(1, tnext - t0));
    return { stop: () => stop('stopped') };
  }
  function safeMatches(el, sel) { try { return el.matches(sel); } catch { return false; } }
  function envOf(doc) {
    let cookies = '', storage = [];
    try { cookies = doc.cookie; } catch { }
    try { const ls = doc.defaultView.localStorage; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); storage.push({ key: k, value: ls.getItem(k) }); } } catch { }
    return { cookies, storage };
  }
  const run = (jobs, opts = {}) => (jobs || []).map(j => runJob(j, opts));

  globalThis.HallowShieldClicker = { run, runJob, splitSelectors, parseExtra, extraOk, find, TIMEOUT };
})();
