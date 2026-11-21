// Hallow Shield element picker ("Hide something on this page" / "Zap once"), injected into the tab you opened the
// popup on (activeTab + scripting), only when you click the button. Its UI lives in a closed shadow root, so the page's
// CSS can't change it and the page's scripts can't reach it.
//   hover: highlights an element and shows its selector      Up / W / "Wider": the parent
//   Down / S / "Narrower": back towards what you pointed at     click / Enter: hide it    Esc: cancel
// Hide: the rule is saved as "site##selector" in My filters (stored in the extension, on this PC). Zap once: the
// element is removed from this page only and nothing is saved.
// Frames: inside frames of the page's own origin the picker works as on the page itself (hover, wider / narrower -
// "Wider" from a frame's top element picks the frame); a frame from another site can be picked as a whole.
(() => {
  const ext = globalThis.browser ?? chrome;
  const mode = globalThis.__hallowShieldPickMode === 'zap' ? 'zap' : 'hide';
  if (globalThis.__hallowShieldPicker) { globalThis.__hallowShieldPicker.setMode(mode); return; }
  const S = globalThis.HallowShieldSelector;
  if (!S) return;

  const host = document.createElement('hallow-shield-picker');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    :host { all: initial; --bg: #14101b; --panel: #1f1929; --line: #3a3248; --text: #ece8f4; --muted: #a59cb6; --accent: #f07820; --accent-text: #f07820;
      --on-accent: #14101b; --panel2: #3a3248; --shadow: 0 8px 28px rgba(0,0,0,.45); color-scheme: dark; }
    @media (prefers-color-scheme: light) {
      :host { --bg: #F6F4FA; --panel: #FFFFFF; --line: #DAD3E6; --text: #1E1A26; --muted: #6B6478; --accent-text: #B5540C; --panel2: #EEEAF5;
        --shadow: 0 6px 20px rgba(30,26,38,.16); color-scheme: light; }
    }
    * { box-sizing: border-box; font: 13px "Segoe UI", system-ui, sans-serif; }
    .box { position: fixed; pointer-events: none; border: 2px solid var(--accent-text); background: rgba(240, 120, 32, .18); border-radius: 3px; display: none; z-index: 2; }
    .bar { position: fixed; right: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px); padding: 10px 12px; background: var(--panel); color: var(--text);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); z-index: 3; }
    .title { font-weight: 600; margin-bottom: 6px; } .title b { color: var(--accent-text); }
    .sel { font: 12px Consolas, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; word-break: break-all; min-height: 26px; }
    .n { color: var(--muted); font-size: 11.5px; margin-top: 4px; }
    .row { display: flex; gap: 6px; margin-top: 8px; }
    button { flex: 1; padding: 6px 4px; border: 0; border-radius: 7px; background: var(--panel2); color: var(--text); cursor: pointer; font-weight: 600; }
    button.go { background: var(--accent); color: var(--on-accent); }
    button:disabled { opacity: .5; cursor: default; }
    .hint { color: var(--muted); font-size: 11px; margin-top: 6px; } .hint .verb { font-size: inherit; }
  </style>
  <div class="box"></div>
  <div class="bar" role="dialog" aria-label="Hallow Shield element picker">
    <div class="title"><b>HALLOW</b> SHIELD - <span class="what"></span></div>
    <div class="sel">Point at something on the page</div>
    <div class="n"></div>
    <div class="row"><button class="wider" title="The element around it (Up)">Wider</button><button class="narrower" title="Back towards what you pointed at (Down)">Narrower</button>
      <button class="go" disabled></button><button class="cancel" title="Esc">Cancel</button></div>
    <div class="hint">Up / Down: wider / narrower - click or Enter: <span class="verb"></span> - Esc: cancel</div>
  </div>`;
  const $ = s => root.querySelector(s);
  const box = $('.box'), selBox = $('.sel'), count = $('.n'), go = $('.go');
  let current = null;      // what will be hidden
  let pointed = null;      // what the mouse is on
  let trail = [];          // the way back down from "current" to "pointed" (for Narrower)
  let selector = null, curMode = mode;

  function setMode(m) {
    curMode = m === 'zap' ? 'zap' : 'hide';
    $('.what').textContent = curMode === 'zap' ? 'zap once (removed from this page only)' : 'hide something on this site';
    go.textContent = curMode === 'zap' ? 'Zap' : 'Hide';
    $('.verb').textContent = curMode === 'zap' ? 'zap' : 'hide on this site';
  }
  setMode(mode);
  const countIn = doc => sel => doc.querySelectorAll(sel).length;
  // the frame element a same-origin frame's document sits in (null for the page itself, or a frame we can't reach)
  const frameOf = doc => { try { return doc.defaultView && doc.defaultView !== window ? doc.defaultView.frameElement : null; } catch { return null; } };
  // where an element of a (nested, same-origin) frame is on the page
  function pageRect(el) {
    const r = el.getBoundingClientRect(); let x = r.left, y = r.top, doc = el.ownerDocument, fe;
    while ((fe = frameOf(doc))) {
      const fr = fe.getBoundingClientRect(), cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += fr.left + fe.clientLeft + (parseFloat(cs.paddingLeft) || 0); y += fr.top + fe.clientTop + (parseFloat(cs.paddingTop) || 0);
      doc = fe.ownerDocument;
    }
    return { left: x, top: y, width: r.width, height: r.height };
  }
  function show(el) {
    current = el;
    if (!el) { box.style.display = 'none'; selector = null; selBox.textContent = 'Point at something on the page'; count.textContent = ''; go.disabled = true; return; }
    const r = pageRect(el), countOf = countIn(el.ownerDocument);
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 2) + 'px', height: Math.max(r.height, 2) + 'px' });
    selector = S.selectorFor(el, countOf);
    selBox.textContent = selector || '(this element can\'t be named)';
    const n = selector ? countOf(selector) : 0;
    const where = frameOf(el.ownerDocument) ? ' (in a frame)' : '';
    count.textContent = selector ? (n === 1 ? 'Matches this element only' + where : `Matches ${n} elements${where}`) : '';
    go.disabled = !selector;
  }
  const ours = e => e.composedPath().includes(host);
  const pick = (doc, x, y) => {
    const el = doc.elementFromPoint(x, y);
    return el && el !== host && el !== doc.documentElement && el !== doc.body ? el : null;
  };
  function wider() {
    if (!current) return;
    let p = current.parentElement;
    const doc = current.ownerDocument;
    // from a frame's top element to the frame itself
    if (!p || p === doc.body || p === doc.documentElement) p = frameOf(doc);
    if (!p || p === document.body || p === document.documentElement) return;
    trail.push(current); show(p);
  }
  function narrower() {
    if (!current) return;
    if (trail.length) return show(trail.pop());
    const c = current.firstElementChild;
    if (c) show(c);
  }
  function commit() {
    if (!current || !selector) return;
    const sel = selector, el = current;
    if (curMode === 'zap') { el.remove(); stop(); return; }
    const doc = el.ownerDocument;
    for (const e of doc.querySelectorAll(sel)) e.style.setProperty('display', 'none', 'important');
    stop();
    // a same-origin frame has the page's site; a frame without one of its own (about:blank) is saved for the page
    let h = location.hostname; try { h = doc.location.hostname || h; } catch { }
    ext.runtime.sendMessage({ t: 'zap-save', host: h, selector: sel }).catch?.(() => { });
  }
  function stop() {
    clearInterval(frameTimer); unmarkForeign();
    for (const w of wins) { try { for (const [t, f] of handlers) w.removeEventListener(t, f, true); w.removeEventListener('scroll', reposition, true); } catch { } }
    wins.clear();
    host.remove();
    delete globalThis.__hallowShieldPicker;
  }
  const reposition = () => { if (current) show(current); };
  const swallow = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const handlers = [
    ['mousemove', e => {
      if (ours(e)) return;
      const doc = (e.view && e.view.document) || document;
      const el = (doc === document && foreignAt(e.clientX, e.clientY)) || pick(doc, e.clientX, e.clientY);
      if (el && el !== pointed) { pointed = el; trail = []; show(el); }
    }],
    ['click', e => { if (ours(e)) return; swallow(e); commit(); }],
    ['mousedown', e => { if (!ours(e)) swallow(e); }],
    ['mouseup', e => { if (!ours(e)) swallow(e); }],
    ['pointerdown', e => { if (!ours(e)) swallow(e); }],
    ['pointerup', e => { if (!ours(e)) swallow(e); }],
    ['contextmenu', e => { if (!ours(e)) swallow(e); }],
    ['keydown', e => {
      const k = e.key;
      if (k === 'Escape') { swallow(e); stop(); return; }
      if (k === 'ArrowUp' || k === 'w' || k === 'W') { swallow(e); wider(); return; }
      if (k === 'ArrowDown' || k === 's' || k === 'S') { swallow(e); narrower(); return; }
      if (k === 'Enter') { swallow(e); commit(); }
    }],
  ];
  // the page and every frame of its own origin (checked again every second, for frames added later)
  const wins = new Set();
  function listen(w) {
    if (wins.has(w)) return;
    try { void w.document.documentElement; } catch { return; }   // another site's frame: can't reach inside
    wins.add(w);
    for (const [t, f] of handlers) w.addEventListener(t, f, true);
    w.addEventListener('scroll', reposition, true);
  }
  function listenAll(w, depth = 0) {
    listen(w);
    if (depth > 4) return;
    let frames = []; try { frames = [...w.document.querySelectorAll('iframe, frame')]; } catch { return; }
    for (const f of frames) { let cw = null; try { cw = f.contentWindow; void cw.document.documentElement; } catch { continue; } if (cw) listenAll(cw, depth + 1); }
  }
  // frames from other sites: their pages can't be reached, so while picking they let the mouse through to the page (the
  // frame itself is then picked by where the pointer is)
  const foreign = new Map();
  function markForeign() {
    for (const f of document.querySelectorAll('iframe, frame, embed, object')) {
      if (foreign.has(f)) continue;
      let reachable = false; try { reachable = !!f.contentWindow && !!f.contentWindow.document.documentElement; } catch { }
      if (reachable) continue;
      foreign.set(f, f.style.getPropertyValue('pointer-events') + '|' + f.style.getPropertyPriority('pointer-events'));
      f.style.setProperty('pointer-events', 'none', 'important');
    }
  }
  const foreignAt = (x, y) => {
    for (const f of foreign.keys()) { if (!f.isConnected) continue; const r = f.getBoundingClientRect(); if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return f; }
    return null;
  };
  function unmarkForeign() {
    for (const [f, v] of foreign) { const [val, prio] = v.split('|'); if (val) f.style.setProperty('pointer-events', val, prio); else f.style.removeProperty('pointer-events'); }
    foreign.clear();
  }
  listenAll(window); markForeign();
  const frameTimer = setInterval(() => { listenAll(window); markForeign(); }, 1000);
  $('.wider').addEventListener('click', wider);
  $('.narrower').addEventListener('click', narrower);
  go.addEventListener('click', commit);
  $('.cancel').addEventListener('click', stop);
  document.documentElement.appendChild(host);
  globalThis.__hallowShieldPicker = { setMode, stop };
})();
