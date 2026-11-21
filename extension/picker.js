// Hallow Shield element picker ("Hide something on this page" / "Zap once"), injected into the tab you opened the
// popup on (activeTab + scripting), only when you click the button. Its UI lives in a closed shadow root, so the page's
// CSS can't change it and the page's scripts can't reach it.
//   hover: highlights an element and shows its selector      Up / W / "Wider": the parent
//   Down / S / "Narrower": back towards what you pointed at     click / Enter: hide it    Esc: cancel
// Hide: the rule is saved as "site##selector" in My filters (stored in the extension, on this PC). Zap once: the
// element is removed from this page only and nothing is saved.
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
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px "Segoe UI", system-ui, sans-serif; }
    .box { position: fixed; pointer-events: none; border: 2px solid #f07820; background: rgba(240, 120, 32, .18); border-radius: 3px; display: none; z-index: 2; }
    .bar { position: fixed; right: 16px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px); padding: 10px 12px; background: #1f1929; color: #ece8f4;
      border: 1px solid #3a3248; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.45); z-index: 3; }
    .title { font-weight: 600; margin-bottom: 6px; } .title b { color: #f07820; }
    .sel { font: 12px Consolas, monospace; background: #14101b; border: 1px solid #3a3248; border-radius: 6px; padding: 5px 7px; word-break: break-all; min-height: 26px; }
    .n { color: #a59cb6; font-size: 11.5px; margin-top: 4px; }
    .row { display: flex; gap: 6px; margin-top: 8px; }
    button { flex: 1; padding: 6px 4px; border: 0; border-radius: 7px; background: #3a3248; color: #ece8f4; cursor: pointer; font-weight: 600; }
    button.go { background: #f07820; color: #14101b; }
    button:disabled { opacity: .5; cursor: default; }
    .hint { color: #a59cb6; font-size: 11px; margin-top: 6px; }
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
  const countOf = sel => document.querySelectorAll(sel).length;
  function show(el) {
    current = el;
    if (!el) { box.style.display = 'none'; selector = null; selBox.textContent = 'Point at something on the page'; count.textContent = ''; go.disabled = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 2) + 'px', height: Math.max(r.height, 2) + 'px' });
    selector = S.selectorFor(el, countOf);
    selBox.textContent = selector || '(this element can\'t be named)';
    const n = selector ? countOf(selector) : 0;
    count.textContent = selector ? (n === 1 ? 'Matches this element only' : `Matches ${n} elements`) : '';
    go.disabled = !selector;
  }
  const ours = e => e.composedPath().includes(host);
  const pick = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host && el !== document.documentElement && el !== document.body ? el : null;
  };
  function wider() {
    if (!current) return;
    const p = current.parentElement;
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
    for (const e of document.querySelectorAll(sel)) e.style.setProperty('display', 'none', 'important');
    stop();
    ext.runtime.sendMessage({ t: 'zap-save', host: location.hostname, selector: sel }).catch?.(() => { });
  }
  function stop() {
    for (const [t, f] of handlers) window.removeEventListener(t, f, true);
    window.removeEventListener('scroll', reposition, true);
    host.remove();
    delete globalThis.__hallowShieldPicker;
  }
  const reposition = () => { if (current) show(current); };
  const swallow = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const handlers = [
    ['mousemove', e => {
      if (ours(e)) return;
      const el = pick(e.clientX, e.clientY);
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
  for (const [t, f] of handlers) window.addEventListener(t, f, true);
  window.addEventListener('scroll', reposition, true);
  $('.wider').addEventListener('click', wider);
  $('.narrower').addEventListener('click', narrower);
  go.addEventListener('click', commit);
  $('.cancel').addEventListener('click', stop);
  document.documentElement.appendChild(host);
  globalThis.__hallowShieldPicker = { setMode, stop };
})();
