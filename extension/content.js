// Hallow Shield cosmetic content script (isolated world, every frame). It tells Shield's own background script the
// site's name; the background adds that site's "hide this ad box" CSS and sends back the site's procedural filters
// (":has-text", ":upward" and friends) and, with "Handle cookie banners" on, the cookie list's "click Reject" jobs.
// 1.5: kept tiny, because it runs in every frame - the procedural engine (procedural.js) and the clicker (clicker.js)
// are injected by the background into this frame only when the site has something for them to do. Each click is
// reported to Shield's background to be counted.
// Also 1.5: generic hiding by class and id. Instead of a 14,000-selector stylesheet in every frame, this script tells
// Shield's background which class and id names the page uses (only the names, as they appear), and the background adds
// the hiding rules for those names. It reads nothing else and sends nothing anywhere.
(() => {
  const ext = globalThis.browser ?? chrome;
  // class / id names seen in this frame, and the ones not yet sent
  const seen = new Set(), queue = [];
  let wanted = null, timer = 0;
  // (attribute strings, not classList: fewer objects to make for every element)
  const add = t => { if (!seen.has(t)) { seen.add(t); queue.push(t); } };
  const note = e => {
    const id = e.getAttribute('id'), cls = e.getAttribute('class');
    if (id) add('#' + id);
    if (cls) for (const c of cls.split(/[ \t\n\f\r]+/)) if (c) add('.' + c);
  };
  const scan = n => {
    if (n.nodeType !== 1) return;
    note(n);
    if (n.firstElementChild) for (const e of n.querySelectorAll('[id],[class]')) note(e);
  };
  const flush = () => {
    timer = 0;
    if (!wanted || !queue.length) return;
    try { ext.runtime.sendMessage({ t: 'generic', host: location.hostname, tokens: queue.splice(0, queue.length) }).catch(() => { }); } catch { }
  };
  const schedule = () => { if (wanted && queue.length && !timer) timer = setTimeout(flush, 30); };
  // while the page is being parsed: one scan when it's parsed (a single querySelectorAll - watching every element the
  // parser adds costs more); after that, only what the page changes
  const mo = new MutationObserver(recs => {
    for (const r of recs) { if (r.type === 'attributes') { if (r.target.nodeType === 1) note(r.target); } else for (const n of r.addedNodes) scan(n); }
    schedule();
  });
  let watching = false;
  const watch = () => {
    if (wanted === false || watching) return;
    watching = true;
    if (document.documentElement) scan(document.documentElement);
    flush();
    mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true }); else watch();
  const stop = () => { wanted = false; mo.disconnect(); seen.clear(); queue.length = 0; };
  const req = ext.runtime.sendMessage({ t: 'cosmetic', host: location.hostname });
  if (!req || !req.then) stop();
  else req.then(r => {
    if (!r || !r.generic) stop(); else { wanted = true; flush(); }
    if (!r) return;
    if (r.proc && r.proc.length && globalThis.HallowShieldProcedural) globalThis.HallowShieldProcedural.start(r.proc);
    if (r.clicks && r.clicks.length && globalThis.HallowShieldClicker) {
      globalThis.HallowShieldClicker.run(r.clicks, { onClick: sel => { try { ext.runtime.sendMessage({ t: 'clicked', host: location.hostname, selector: sel }).catch(() => { }); } catch { } } });
    }
  }).catch(stop);
})();
