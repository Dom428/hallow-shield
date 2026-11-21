// Hallow Shield cosmetic content script (isolated world, every frame). It tells Shield's own background script the
// site's name; the background adds that site's "hide this ad box" CSS and sends back the site's procedural filters
// (":has-text", ":upward" and friends), which this script applies as the page changes. It reads nothing else and sends
// nothing anywhere.
(() => {
  const ext = globalThis.browser ?? chrome;
  let progs = [];
  const req = ext.runtime.sendMessage({ t: 'cosmetic', host: location.hostname });
  if (req && req.then) req.then(r => { if (r && r.proc && r.proc.length) start(r.proc); }).catch(() => { });

  const reOf = (s, exact) => {
    const m = /^\/(.+)\/([imsu]*)$/.exec(s);
    if (m) { try { return new RegExp(m[1], m[2]); } catch { return /(?!)/; } }
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(exact ? '^' + esc + '$' : esc);
  };
  const uniq = a => [...new Set(a)];
  function rel(el, css) {
    css = css.trim();
    if (!css) return [el];
    if (/^[+~]/.test(css)) {
      const p = el.parentElement; if (!p) return [];
      const k = Array.prototype.indexOf.call(p.children, el) + 1;
      return [...p.querySelectorAll(`:scope > :nth-child(${k}) ${css}`)];
    }
    return [...el.querySelectorAll(`:scope ${css}`)];
  }
  // run one compiled program: top level (inputs null) starts from the document; nested ones from the given elements
  function run(prog, inputs, self) {
    let els;
    if (inputs === null) els = prog.s ? [...document.querySelectorAll(prog.s)] : [document.documentElement];
    else if (self) els = prog.s ? inputs.filter(e => e.matches(prog.s)) : inputs;
    else els = prog.s ? uniq(inputs.flatMap(e => rel(e, prog.s))) : inputs;
    for (const [op, ...a] of prog.t) {
      if (!els.length) break;
      els = step(op, a, els);
    }
    return els;
  }
  function step(op, a, els) {
    switch (op) {
      case 'spath': return uniq(els.flatMap(e => rel(e, a[0])));
      case 'has': return els.filter(e => run(a[0], [e], false).length > 0);
      case 'not': return els.filter(e => run(a[0], [e], true).length === 0);
      case 'text': { const re = reOf(a[0], false); return els.filter(e => re.test(e.textContent)); }
      case 'minlen': return els.filter(e => (e.textContent || '').length >= a[0]);
      case 'up': return uniq(els.map(e => {
        if (typeof a[0] === 'number') { let x = e; for (let i = 0; i < a[0] && x; i++) x = x.parentElement; return x; }
        return e.parentElement ? e.parentElement.closest(a[0]) : null;
      }).filter(Boolean));
      case 'css': { const re = reOf(a[2], true); return els.filter(e => re.test(getComputedStyle(e, a[0]).getPropertyValue(a[1]))); }
      case 'attr': {
        const nre = reOf(a[0], true), vre = a[1] === null ? null : reOf(a[1], true);
        return els.filter(e => [...e.attributes].some(at => nre.test(at.name) && (!vre || vre.test(at.value))));
      }
      case 'path': return reOf(a[0], false).test(location.pathname + location.search) ? els : [];
      case 'media': return matchMedia(a[0]).matches ? els : [];
      case 'xpath': return uniq(els.flatMap(e => {
        const out = [], r = document.evaluate(a[0], e, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) { const n = r.snapshotItem(i); if (n.nodeType === 1) out.push(n); }
        return out;
      }));
    }
    return [];
  }
  function act(a, e) {
    if (!a) { if (e.style.getPropertyValue('display') !== 'none' || e.style.getPropertyPriority('display') !== 'important') e.style.setProperty('display', 'none', 'important'); return; }
    switch (a[0]) {
      case 'remove': e.remove(); return;
      case 'style': for (const d of a[1].split(';')) { const i = d.indexOf(':'); if (i > 0) e.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).replace(/!important/i, '').trim(), 'important'); } return;
      case 'ra': for (const n of a[1].split('|')) if (e.hasAttribute(n.trim())) e.removeAttribute(n.trim()); return;
      case 'rc': for (const n of a[1].split('|')) if (e.classList.contains(n.trim())) e.classList.remove(n.trim()); return;
    }
  }
  function applyAll() {
    for (const p of progs) {
      let els; try { els = run(p, null); } catch { continue; }
      for (const e of els) try { act(p.a, e); } catch { }
    }
  }
  function start(list) {
    progs = list;
    let timer = 0, last = 0;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = 0; last = Date.now(); applyAll(); }, Math.max(50, 200 - (Date.now() - last)));
    };
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyAll, { once: true });
    applyAll();
  }
})();
