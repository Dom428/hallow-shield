// Hallow Shield scriptlets: small functions that run inside a page (the MAIN world, at document_start) on the sites a
// filter names (uBO's "##+js(...)" filters). Hallow Shield's own implementations of the commonly used uBlock Origin
// scriptlets - same names and arguments, so the uBO lists can drive them; no uBO code is used.
// tools/build.mjs turns each scriptlet into one bundle: the helpers below + the scriptlet + the sites and arguments it
// runs with (extension/rules/js/<name>.js), registered with chrome.scripting.registerContentScripts({ world: 'MAIN' }).
// Everything here must be self-contained: the functions are serialized with Function.prototype.toString.

// ---------- helpers (included in every bundle) ----------

// uBO pattern: "/regex/flags" or a literal substring; "" matches everything
function shieldRe(p) {
  if (p === undefined || p === null || p === '') return /^/;
  const m = /^\/(.+)\/([dimsuy]*)$/.exec(String(p));
  if (m) { try { return new RegExp(m[1], m[2]); } catch (e) { return /(?!)/; } }
  return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
// a pattern with optional "!" in front (= must NOT match)
function shieldNeedle(needle) {
  const s = String(needle === undefined || needle === null ? '' : needle);
  const not = s.startsWith('!'), re = shieldRe(not ? s.slice(1) : s);
  return text => re.test(String(text)) !== not;
}
function shieldDelay(spec) {
  if (spec === undefined || spec === '') return () => true;
  const s = String(spec), not = s.startsWith('!'), n = parseInt(not ? s.slice(1) : s, 10);
  if (isNaN(n)) return () => true;
  return d => ((Number(d) || 0) === n) !== not;
}
function shieldFnText(f) {
  try { return typeof f === 'function' ? Function.prototype.toString.call(f) : (f && typeof f.handleEvent === 'function') ? Function.prototype.toString.call(f.handleEvent) : String(f); } catch (e) { return ''; }
}
// "key, value, key, value" extra arguments -> { key: value }
function shieldExtra(list) { const o = {}; for (let i = 0; i + 1 < list.length; i += 2) o[list[i]] = list[i + 1]; return o; }
// uBO's set-constant values
function shieldConst(raw, trusted) {
  if (trusted) { try { return [true, JSON.parse(raw)]; } catch (e) { return [true, String(raw)]; } }
  switch (raw) {
    case 'undefined': return [true, undefined];
    case 'false': return [true, false];
    case 'true': return [true, true];
    case 'null': return [true, null];
    case "''": case 'emptyStr': case '': return [true, ''];
    case 'noopFunc': return [true, function () { }];
    case 'trueFunc': return [true, function () { return true; }];
    case 'falseFunc': return [true, function () { return false; }];
    case 'throwFunc': return [true, function () { throw new Error(''); }];
    case 'noopCallbackFunc': return [true, function () { return function () { }; }];
    case 'emptyObj': case '{}': return [true, {}];
    case 'emptyArr': case '[]': return [true, []];
    case 'NaN': return [true, NaN];
    case 'Infinity': return [true, Infinity];
    case '-Infinity': return [true, -Infinity];
    case 'yes': case 'no': case 'on': case 'off': return [true, raw];
  }
  if (/^-?\d+$/.test(raw)) { const n = parseInt(raw, 10); if (Math.abs(n) <= 0x7FFF) return [true, n]; }
  return [false];
}
// trap a property chain on window ("a.b.c"): makeLast(owner, prop) returns the descriptor for the last link;
// links that don't exist yet are watched, so the trap is set when the page creates them
function shieldTrap(chain, makeLast) {
  const links = String(chain).replace(/^window\./, '').split('.');
  const attach = (owner, i) => {
    const prop = links[i];
    let desc; try { desc = Object.getOwnPropertyDescriptor(owner, prop); } catch (e) { return; }
    if (desc && desc.configurable === false) return;
    if (i === links.length - 1) {
      let d; try { d = makeLast(owner, prop, desc); } catch (e) { return; }
      if (d) try { Object.defineProperty(owner, prop, Object.assign({ configurable: true, enumerable: true }, d)); } catch (e) { }
      return;
    }
    let cur; try { cur = owner[prop]; } catch (e) { }
    if (cur instanceof Object) attach(cur, i + 1);
    try {
      Object.defineProperty(owner, prop, {
        configurable: true, enumerable: desc ? desc.enumerable : true,
        get() { return desc && desc.get ? desc.get.call(this) : cur; },
        set(v) { if (desc && desc.set) desc.set.call(this, v); else cur = v; if (v instanceof Object) attach(v, i + 1); },
      });
    } catch (e) { }
  };
  attach(window, 0);
}
// JSON pruning paths: "a.b", "[]" or "*" = every element/key, "[-]" = drop the array elements where the rest exists
function shieldHas(x, segs, i) {
  if (i === segs.length) return true;
  if (x === null || typeof x !== 'object') return false;
  const s = segs[i];
  if (s === '[]' || s === '*' || s === '[-]' || s === '{-}') return Object.keys(x).some(k => shieldHas(x[k], segs, i + 1));
  const eq = s.indexOf('=');
  if (eq > 0 && i === segs.length - 1) { const k = s.slice(0, eq); return Object.prototype.hasOwnProperty.call(x, k) && String(x[k]) === s.slice(eq + 1); }
  return Object.prototype.hasOwnProperty.call(x, s) && shieldHas(x[s], segs, i + 1);
}
function shieldDel(x, segs, i) {
  if (x === null || typeof x !== 'object') return false;
  const s = segs[i], last = i === segs.length - 1;
  if (s === '[-]' || s === '{-}') {
    let changed = false;
    if (Array.isArray(x)) { for (let k = x.length - 1; k >= 0; k--) if (shieldHas(x[k], segs, i + 1)) { x.splice(k, 1); changed = true; } }
    else for (const k of Object.keys(x)) if (shieldHas(x[k], segs, i + 1)) { delete x[k]; changed = true; }
    return changed;
  }
  if (s === '[]' || s === '*') {
    let changed = false;
    for (const k of Object.keys(x)) { if (last) { delete x[k]; changed = true; } else if (shieldDel(x[k], segs, i + 1)) changed = true; }
    return changed;
  }
  if (!Object.prototype.hasOwnProperty.call(x, s)) return false;
  if (last) { delete x[s]; return true; }
  return shieldDel(x[s], segs, i + 1);
}
function shieldPruner(rawPrune, rawNeed) {
  const prune = String(rawPrune || '').split(/ +/).filter(Boolean).map(p => p.split('.'));
  const need = String(rawNeed || '').split(/ +/).filter(Boolean).map(p => p.split('.'));
  return obj => {
    if (!prune.length || obj === null || typeof obj !== 'object') return false;
    if (need.length && !need.every(p => shieldHas(obj, p, 0))) return false;
    let changed = false;
    for (const p of prune) if (shieldDel(obj, p, 0)) changed = true;
    return changed;
  };
}
// "propsToMatch": "url:/re/ method:POST" or a bare pattern (= the address)
function shieldReqMatch(props) {
  if (props === undefined || props === null || props === '') return () => true;
  const keys = ['url', 'method', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity'];
  const conds = String(props).split(/\s+/).filter(Boolean).map(part => {
    const m = /^([a-zA-Z]+):(.+)$/.exec(part);
    return m && keys.includes(m[1]) ? [m[1], shieldNeedle(m[2])] : ['url', shieldNeedle(part)];
  });
  return d => conds.every(([k, t]) => t(d[k] === undefined || d[k] === null ? '' : d[k]));
}
function shieldFetchDetails(args) {
  const res = args[0], init = args[1], d = {};
  if (res instanceof Request) { d.url = res.url; d.method = res.method; }
  else d.url = String(res);
  if (init && typeof init === 'object') for (const k of Object.keys(init)) d[k] = init[k];
  try { d.url = new URL(d.url, location.href).href; } catch (e) { }
  d.method = String(d.method || 'GET').toUpperCase();
  return d;
}
function shieldResponse(text, like) {
  const r = new Response(text, { status: like.status || 200, statusText: like.statusText || '', headers: like.headers || {} });
  try { Object.defineProperties(r, { url: { value: like.url || '' }, type: { value: like.type || 'basic' }, redirected: { value: !!like.redirected } }); } catch (e) { }
  return r;
}
// fetch: transform(text) -> new text or undefined, for requests that match
function shieldFetchHook(match, transform) {
  const native = window.fetch;
  if (typeof native !== 'function') return;
  window.fetch = new Proxy(native, {
    apply(target, self, args) {
      const p = Reflect.apply(target, self, args);
      let d; try { d = shieldFetchDetails(args); } catch (e) { return p; }
      if (!match(d)) return p;
      return p.then(resp => resp.clone().text().then(text => {
        const out = transform(text);
        return typeof out === 'string' && out !== text ? shieldResponse(out, resp) : resp;
      }).catch(() => resp));
    },
  });
}
// XMLHttpRequest: the same, applied when the page reads response / responseText
function shieldXhrHook(match, transform) {
  const X = XMLHttpRequest.prototype, info = new WeakMap();
  X.open = new Proxy(X.open, {
    apply(t, xhr, args) {
      try { info.set(xhr, { m: match({ url: new URL(String(args[1]), location.href).href, method: String(args[0] || 'GET').toUpperCase() }), done: false, out: null }); } catch (e) { }
      return Reflect.apply(t, xhr, args);
    },
  });
  for (const name of ['response', 'responseText']) {
    const d = Object.getOwnPropertyDescriptor(X, name);
    if (!d || !d.get) continue;
    Object.defineProperty(X, name, {
      configurable: true, enumerable: d.enumerable,
      get: new Proxy(d.get, {
        apply(g, xhr, a) {
          const v = Reflect.apply(g, xhr, a), st = info.get(xhr);
          if (!st || !st.m || xhr.readyState !== 4) return v;
          if (!st.done) {
            st.done = true;
            const text = typeof v === 'string' ? v : (xhr.responseType === 'json' && v) ? JSON.stringify(v) : null;
            if (text !== null) { const out = transform(text); if (typeof out === 'string' && out !== text) st.out = out; }
          }
          if (st.out === null) return v;
          if (name === 'response' && xhr.responseType === 'json') { try { return JSON.parse(st.out); } catch (e) { return v; } }
          return st.out;
        },
      }),
    });
  }
}
// run now / at DOMContentLoaded / at load, and keep running on DOM changes with "stay"
function shieldWhen(behavior, run, filter) {
  const b = String(behavior || '');
  const start = () => {
    run();
    if (!b.includes('stay')) return;
    let pending = false;
    const opts = { childList: true, subtree: true }; if (filter) { opts.attributes = true; opts.attributeFilter = filter; }
    new MutationObserver(() => { if (pending) return; pending = true; setTimeout(() => { pending = false; run(); }, 30); }).observe(document, opts);
  };
  if (b.includes('asap')) start();
  else if (b.includes('complete')) { if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true }); }
  else if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
function shieldTimerHook(name, match, change) {
  const native = window[name];
  if (typeof native !== 'function') return;
  window[name] = new Proxy(native, {
    apply(t, self, args) { if (match(shieldFnText(args[0]), args[1])) change(args); return Reflect.apply(t, self, args); },
  });
}

export const HELPERS = [shieldRe, shieldNeedle, shieldDelay, shieldFnText, shieldExtra, shieldConst, shieldTrap, shieldHas, shieldDel, shieldPruner,
  shieldReqMatch, shieldFetchDetails, shieldResponse, shieldFetchHook, shieldXhrHook, shieldWhen, shieldTimerHook];

// ---------- the scriptlets ----------

function setConstant(chain, raw, ...rest) {
  const [ok, value0] = shieldConst(String(raw === undefined ? '' : raw), false);
  if (!ok || !chain) return;
  const as = shieldExtra(rest).as;
  let value = value0;
  if (as === 'function') value = function () { return value0; };
  else if (as === 'callback') value = function () { return function () { return value0; }; };
  else if (as === 'resolved') value = Promise.resolve(value0);
  else if (as === 'rejected') value = Promise.reject(value0);
  shieldTrap(chain, (owner, prop) => {
    let aborted = false, real;
    // like uBO: if the page stores a value of a different kind, stop faking (it's not what the filter was about)
    const differs = v => v !== undefined && v !== null && value !== undefined && value !== null && typeof v !== typeof value;
    try { if (differs(owner[prop])) return null; } catch (e) { }
    return { get() { return aborted ? real : value; }, set(v) { if (aborted) real = v; else if (differs(v)) { aborted = true; real = v; } } };
  });
}
function trustedSetConstant(chain, raw) {
  const [ok, value] = shieldConst(String(raw === undefined ? '' : raw), true);
  if (!ok || !chain) return;
  shieldTrap(chain, () => ({ get() { return value; }, set() { } }));
}
function abortOnPropertyRead(chain) {
  if (!chain) return;
  shieldTrap(chain, () => ({ get() { throw new ReferenceError('Shield'); }, set() { } }));
}
function abortOnPropertyWrite(chain) {
  if (!chain) return;
  shieldTrap(chain, (owner, prop) => { let v; try { v = owner[prop]; } catch (e) { } return { get() { return v; }, set() { throw new ReferenceError('Shield'); } }; });
}
function abortCurrentScript(chain, needle, context) {
  if (!chain) return;
  const test = shieldNeedle(needle || ''), ctx = context ? shieldRe(context) : null;
  const self = document.currentScript;
  const check = () => {
    const e = document.currentScript;
    if (!(e instanceof HTMLScriptElement) || e === self) return;
    if (ctx && !ctx.test(e.src)) return;
    const text = (e.src ? e.src + '\n' : '') + (e.textContent || '');
    if (test(text)) throw new ReferenceError('Shield');
  };
  shieldTrap(chain, (owner, prop, desc) => {
    let v; try { v = owner[prop]; } catch (e) { }
    return {
      get() { check(); return desc && desc.get ? desc.get.call(this) : v; },
      set(nv) { check(); if (desc && desc.set) desc.set.call(this, nv); else v = nv; },
    };
  });
}
function abortOnStackTrace(chain, needle) {
  if (!chain) return;
  const test = shieldNeedle(needle || '');
  const check = () => { if (test(new Error().stack || '')) throw new ReferenceError('Shield'); };
  shieldTrap(chain, (owner, prop, desc) => {
    let v; try { v = owner[prop]; } catch (e) { }
    return { get() { check(); return desc && desc.get ? desc.get.call(this) : v; }, set(nv) { check(); if (desc && desc.set) desc.set.call(this, nv); else v = nv; } };
  });
}
function jsonPrune(rawPrune, rawNeed, stackNeedle) {
  const prune = shieldPruner(rawPrune, rawNeed);
  const stack = stackNeedle ? shieldNeedle(stackNeedle) : null;
  const ok = () => !stack || stack(new Error().stack || '');
  JSON.parse = new Proxy(JSON.parse, { apply(t, self, args) { const o = Reflect.apply(t, self, args); if (ok()) prune(o); return o; } });
  Response.prototype.json = new Proxy(Response.prototype.json, { apply(t, self, args) { return Reflect.apply(t, self, args).then(o => { prune(o); return o; }); } });
}
function jsonPruneFetchResponse(rawPrune, rawNeed, ...rest) {
  const prune = shieldPruner(rawPrune, rawNeed), extra = shieldExtra(rest);
  shieldFetchHook(shieldReqMatch(extra.propsToMatch), text => { let o; try { o = JSON.parse(text); } catch (e) { return; } return prune(o) ? JSON.stringify(o) : undefined; });
}
function jsonPruneXhrResponse(rawPrune, rawNeed, ...rest) {
  const prune = shieldPruner(rawPrune, rawNeed), extra = shieldExtra(rest);
  shieldXhrHook(shieldReqMatch(extra.propsToMatch), text => { let o; try { o = JSON.parse(text); } catch (e) { return; } return prune(o) ? JSON.stringify(o) : undefined; });
}
function shieldReplacer(pattern, replacement) {
  if (!pattern) return null;
  if (pattern === '*') return () => String(replacement || '');
  const m = /^\/(.+)\/([dimsuy]*)$/.exec(pattern);
  let re; try { re = m ? new RegExp(m[1], m[2] + 'g') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (e) { return null; }
  return text => text.replace(re, replacement || '');
}
function trustedReplaceFetchResponse(pattern, replacement, propsToMatch) {
  const rep = shieldReplacer(pattern, replacement);
  if (rep) shieldFetchHook(shieldReqMatch(propsToMatch), rep);
}
function trustedReplaceXhrResponse(pattern, replacement, propsToMatch) {
  const rep = shieldReplacer(pattern, replacement);
  if (rep) shieldXhrHook(shieldReqMatch(propsToMatch), rep);
}
function preventFetch(propsToMatch, responseBody, responseType) {
  if (propsToMatch === undefined || propsToMatch === '') return;
  const match = shieldReqMatch(propsToMatch);
  const body = { emptyObj: '{}', emptyArr: '[]', true: 'true', false: 'false', emptyStr: '' }[responseBody] ?? '';
  const native = window.fetch;
  window.fetch = new Proxy(native, {
    apply(target, self, args) {
      let d; try { d = shieldFetchDetails(args); } catch (e) { return Reflect.apply(target, self, args); }
      if (!match(d)) return Reflect.apply(target, self, args);
      const type = ['basic', 'cors', 'opaque'].includes(responseType) ? responseType : 'basic';
      return Promise.resolve(shieldResponse(body, { status: type === 'opaque' ? 0 : 200, statusText: type === 'opaque' ? '' : 'OK', url: d.url, type }));
    },
  });
}
function preventXhr(propsToMatch, directive) {
  if (propsToMatch === undefined || propsToMatch === '') return;
  const match = shieldReqMatch(propsToMatch), X = XMLHttpRequest.prototype, flagged = new WeakMap();
  X.open = new Proxy(X.open, {
    apply(t, xhr, args) {
      try { const url = new URL(String(args[1]), location.href).href; if (match({ url, method: String(args[0] || 'GET').toUpperCase() })) flagged.set(xhr, url); else flagged.delete(xhr); } catch (e) { }
      return Reflect.apply(t, xhr, args);
    },
  });
  X.send = new Proxy(X.send, {
    apply(t, xhr, args) {
      const url = flagged.get(xhr);
      if (url === undefined) return Reflect.apply(t, xhr, args);
      const text = directive === 'true' ? 'true' : '';
      const v = xhr.responseType === 'json' ? null : text;
      Object.defineProperties(xhr, {
        readyState: { value: 4, configurable: true }, status: { value: 200, configurable: true }, statusText: { value: 'OK', configurable: true },
        responseURL: { value: url, configurable: true }, response: { value: v, configurable: true }, responseText: { value: text, configurable: true },
      });
      setTimeout(() => { for (const ev of ['readystatechange', 'load', 'loadend']) xhr.dispatchEvent(new Event(ev)); }, 1);
    },
  });
}
function preventSetTimeout(needle, delay) {
  const t = shieldNeedle(needle || ''), d = shieldDelay(delay);
  shieldTimerHook('setTimeout', (text, ms) => t(text) && d(ms), args => { args[0] = function () { }; });
}
function preventSetInterval(needle, delay) {
  const t = shieldNeedle(needle || ''), d = shieldDelay(delay);
  shieldTimerHook('setInterval', (text, ms) => t(text) && d(ms), args => { args[0] = function () { }; });
}
function preventRequestAnimationFrame(needle) {
  const t = shieldNeedle(needle || '');
  shieldTimerHook('requestAnimationFrame', text => t(text), args => { args[0] = function () { }; });
}
function adjustSetTimeout(needle, delay, boost) { shieldAdjust('setTimeout', needle, delay, boost); }
function adjustSetInterval(needle, delay, boost) { shieldAdjust('setInterval', needle, delay, boost); }
function shieldAdjust(name, needle, delay, boost) {
  const t = shieldNeedle(needle || ''), want = delay === undefined || delay === '' ? 1000 : parseInt(delay, 10);
  let b = boost === undefined || boost === '' ? 0.05 : parseFloat(boost);
  if (!(b >= 0.001 && b <= 50)) b = 0.05;
  shieldTimerHook(name, (text, ms) => t(text) && (want === '*' || isNaN(want) || Number(ms) === want), args => { args[1] = Math.round(Number(args[1] || 0) * b); });
}
function addEventListenerDefuser(type, pattern) {
  if (!type && !pattern) return;
  const ty = shieldNeedle(type || ''), pat = shieldNeedle(pattern || '');
  const proto = EventTarget.prototype;
  proto.addEventListener = new Proxy(proto.addEventListener, {
    apply(t, self, args) { if (ty(String(args[0])) && pat(shieldFnText(args[1]))) return undefined; return Reflect.apply(t, self, args); },
  });
}
function noWindowOpenIf(pattern) {
  const test = shieldNeedle(pattern || '');
  const fake = () => {
    const noop = function () { };
    return new Proxy({ closed: false, opener: window, location: { href: '' }, document: document.implementation.createHTMLDocument('') }, {
      get(o, k) { return k in o ? o[k] : noop; }, set() { return true; },
    });
  };
  window.open = new Proxy(window.open, {
    apply(t, self, args) { if (!test(String(args[0] === undefined ? '' : args[0]))) return Reflect.apply(t, self, args); return fake(); },
  });
}
function removeAttr(rawAttrs, selector, behavior) {
  const attrs = String(rawAttrs || '').split(/\s*\|\s*/).filter(Boolean);
  if (!attrs.length) return;
  const sel = selector || attrs.map(a => '[' + CSS.escape(a) + ']').join(',');
  shieldWhen(behavior, () => { try { for (const el of document.querySelectorAll(sel)) for (const a of attrs) el.removeAttribute(a); } catch (e) { } }, attrs);
}
function removeClass(rawClasses, selector, behavior) {
  const classes = String(rawClasses || '').split(/\s*\|\s*/).filter(Boolean);
  if (!classes.length) return;
  const sel = selector || classes.map(c => '.' + CSS.escape(c)).join(',');
  shieldWhen(behavior, () => { try { for (const el of document.querySelectorAll(sel)) el.classList.remove(...classes); } catch (e) { } }, ['class']);
}
// text of matching nodes (e.g. inline <script>s) replaced as the parser adds them; like uBO: nodes already there and
// nodes added until the page is interactive (longer with quitAfter / "stay"), only those whose text has "includes"
function shieldNodeText(nodeName, pattern, replacement, extra) {
  if (!nodeName) return;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = (p, flags, exact) => { const m = /^\/(.+)\/([dimsuy]*)$/.exec(p); try { return m ? new RegExp(m[1], m[2] || flags) : new RegExp(exact ? '^' + esc(p) + '$' : esc(p), flags); } catch (e) { return /(?!)/; } };
  const name = rx(nodeName, 'i', true), pat = pattern ? rx(pattern, 'gms') : null;
  const inc = extra.includes || extra.condition ? rx(extra.includes || extra.condition, 'ms') : null, exc = extra.excludes ? rx(extra.excludes, 'ms') : null;
  const self = document.currentScript;
  const handle = n => {
    if (n === self || !name.test(n.nodeName)) return;
    const before = n.textContent;
    if (inc && !inc.test(before)) return;
    if (exc && exc.test(before)) return;
    if (pat) { pat.lastIndex = 0; if (!pat.test(before)) return; pat.lastIndex = 0; }
    try { n.textContent = pat ? before.replace(pat, replacement || '') : (replacement || ''); } catch (e) { }
  };
  const tree = root => { const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) handle(n); };
  if (document.documentElement) tree(document.documentElement);
  const obs = new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) handle(n); });
  obs.observe(document, { childList: true, subtree: true });
  if (extra.stay) return;
  const stop = () => { const left = obs.takeRecords(); obs.disconnect(); for (const m of left) for (const n of m.addedNodes) handle(n); };
  const quit = () => { const q = Number(extra.quitAfter) || 0; if (q) setTimeout(stop, q); else stop(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', quit, { once: true }); else quit();
}
function removeNodeText(nodeName, includes, ...rest) { shieldNodeText(nodeName, '', '', Object.assign(shieldExtra(rest), { includes: includes || '' })); }
function trustedReplaceNodeText(nodeName, pattern, replacement, ...rest) { shieldNodeText(nodeName, pattern, replacement, shieldExtra(rest)); }
function noWebrtc() {
  const Stub = function () { };
  Stub.prototype = { close() { }, createDataChannel() { return {}; }, createOffer() { return Promise.resolve({}); }, setLocalDescription() { return Promise.resolve(); },
    setRemoteDescription() { return Promise.resolve(); }, addIceCandidate() { return Promise.resolve(); }, addEventListener() { }, removeEventListener() { } };
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) if (window[k]) window[k] = Stub;
}
function preventFab() {
  const Det = function () { };
  Det.prototype = {
    check() { return this; }, emitEvent() { return this; }, clearEvent() { return this; }, setOption() { return this; }, options: {},
    on(detected, fn) { if (!detected && typeof fn === 'function') setTimeout(() => { try { fn(); } catch (e) { } }, 1); return this; },
    onDetected() { return this; }, onNotDetected(fn) { return this.on(false, fn); },
  };
  const inst = new Det();
  window.fuckAdBlock = window.blockAdBlock = window.sniffAdBlock = inst;
  window.FuckAdBlock = window.BlockAdBlock = window.SniffAdBlock = Det;
}
function shieldSetAttr(selector, attr, value, trusted) {
  if (!selector || !attr || /^on/i.test(attr)) return;
  let v = String(value === undefined ? '' : value);
  if (!trusted && !['', 'true', 'false'].includes(v) && !/^\d{1,5}$/.test(v) && !/^\[[\w-]+\]$/.test(v)) return;
  shieldWhen('stay', () => {
    try {
      for (const el of document.querySelectorAll(selector)) {
        const nv = /^\[[\w-]+\]$/.test(v) ? el.getAttribute(v.slice(1, -1)) : v;
        if (nv !== null && el.getAttribute(attr) !== nv) el.setAttribute(attr, nv);
      }
    } catch (e) { }
  }, [attr]);
}
function setAttr(selector, attr, value) { shieldSetAttr(selector, attr, value, false); }
function trustedSetAttr(selector, attr, value) { shieldSetAttr(selector, attr, value, true); }
function trustedSetCookie(name, value, offset, path) {
  if (!name || /[;\s]/.test(name)) return;
  let exp = '';
  const s = parseInt(offset, 10);
  if (s > 0) exp = '; expires=' + new Date(Date.now() + s * 1000).toUTCString();
  document.cookie = encodeURIComponent(name) + '=' + String(value === undefined ? '' : value).replace(/;/g, '') + exp + '; path=' + (path && path.startsWith('/') ? path : '/');
}
function trustedSetLocalStorageItem(key, value) { try { if (key) localStorage.setItem(key, String(value === undefined ? '' : value)); } catch (e) { } }
function trustedSetSessionStorageItem(key, value) { try { if (key) sessionStorage.setItem(key, String(value === undefined ? '' : value)); } catch (e) { } }
function windowCloseIf(pattern) { if (shieldNeedle(pattern || '')(location.href)) { try { window.close(); } catch (e) { } } }
function alertBuster() { window.alert = new Proxy(window.alert, { apply() { } }); }
const SHIELD_SAFE_VALUES = ['true', 'false', 'yes', 'y', 'no', 'n', 'ok', 'on', 'off', 'accept', 'accepted', 'reject', 'rejected', 'allow', 'allowed', 'deny', 'denied',
  'necessary', 'required', 'approved', 'disapproved', 'hide', 'hidden', 'essential', 'nonessential', 'checked', 'unchecked', 'forbidden', 'forever', 'dismiss', 'dismissed', ''];
function setCookie(name, value, path) {
  if (!name || !/^[^\s;=,]+$/.test(name)) return;
  const v = String(value === undefined ? '' : value);
  if (!SHIELD_SAFE_VALUES.includes(v.toLowerCase()) && !/^\d{1,5}$/.test(v)) return;
  const now = document.cookie.split(/;\s*/).find(c => c.split('=')[0] === encodeURIComponent(name));
  if (now && now.slice(now.indexOf('=') + 1) === encodeURIComponent(v)) return;
  document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(v) + (path === 'none' ? '' : '; path=' + (path && path.startsWith('/') ? path : '/'));
}
function shieldStorage(kind, key, value) {
  if (!key) return;
  let store; try { store = window[kind]; } catch (e) { return; }
  if (!store) return;
  if (value === '$remove$') {
    const re = key.startsWith('/') ? shieldRe(key) : null;
    try { for (const k of Object.keys(store)) if (re ? re.test(k) : k === key) store.removeItem(k); } catch (e) { }
    return;
  }
  const map = { undefined: 'undefined', false: 'false', true: 'true', null: 'null', emptyObj: '{}', emptyArr: '[]', emptyStr: '', "''": '', yes: 'yes', no: 'no', on: 'on', off: 'off', '': '' };
  let v = map[value];
  if (v === undefined && /^\d{1,5}$/.test(String(value))) v = String(value);
  if (v === undefined) return;
  try { store.setItem(key, v); } catch (e) { }
}
function setLocalStorageItem(key, value) { shieldStorage('localStorage', key, value); }
function setSessionStorageItem(key, value) { shieldStorage('sessionStorage', key, value); }
function removeCookie(needle) {
  const test = shieldRe(needle || '');
  const run = () => {
    for (const c of document.cookie.split(/;\s*/)) {
      const name = c.split('=')[0]; if (!name || !test.test(decodeURIComponent(name))) continue;
      const host = location.hostname.split('.');
      for (let i = 0; i < host.length - 1; i++) for (const dom of ['', '; domain=' + host.slice(i).join('.'), '; domain=.' + host.slice(i).join('.')])
        document.cookie = name + '=; path=/; max-age=0' + dom;
    }
  };
  run(); window.addEventListener('beforeunload', run);
}
function noevalIf(needle) {
  const test = shieldNeedle(needle || '');
  window.eval = new Proxy(window.eval, { apply(t, self, args) { if (test(String(args[0]))) return undefined; return Reflect.apply(t, self, args); } });
}

// ---------- 1.5: JSON editing (uBO's documented JSONPath-like syntax), argument replacement, link cleaning ----------

// a uBO-style JSONPath edit, compiled once: returns edit(obj) -> true if obj changed, or null if the query can't be used.
//   path               remove what the path matches (every list)
//   path=value         set it to a JSON value; path+={...} add properties to the matched objects;
//   path=repl({"pattern"|"regex": "...", "replacement": "..."})  replace inside matched strings (trusted lists only)
//   a{1,};b            sub-queries: run b only if a matches (quantifiers {x} {x,} {,y} {x,y}; default {1,})
// Paths: "$" / "@" root, ".name", "..name" (anywhere below), ".*" / "[*]", "[2]" / "[-1]", "['a','b']", "./re/" or
// "[/re/]" (keys matching a regex), "[?filter]". A filter is "@.path OP value" (RFC style: tests the children) or
// ".path OP value" (uBO's older style: tests array elements, or the object itself); OP is == != < <= > >= ^= $= *=
// or =/regex/; without OP the path just has to exist. "v2:" in front is accepted and changes nothing here.
function shieldJsonEdit(raw, trusted) {
  let q = String(raw === undefined || raw === null ? '' : raw).trim();
  if (q.startsWith('v2:')) q = q.slice(3).trim();
  if (!q) return null;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // walk s from i, calling at(i, ch) for characters at bracket depth 0 outside quotes and regex literals
  const scan = (s, at, from = 0) => {
    let depth = 0, quote = '', re = false;
    for (let i = from; i < s.length; i++) {
      const ch = s[i];
      if (quote || re) { if (ch === '\\') { i++; continue; } if ((quote && ch === quote) || (re && ch === '/')) { quote = ''; re = false; } continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '/' && (i === from || /[.[=(,]/.test(s[i - 1]))) { re = true; continue; }
      if (ch === '[' || ch === '(' || ch === '{') { depth++; if (depth === 1 && at(i, ch, true)) return i; continue; }
      if (ch === ']' || ch === ')' || ch === '}') { depth--; if (depth === 0 && at(i, ch, true)) return i; continue; }
      if (depth === 0 && at(i, ch, false)) return i;
    }
    return -1;
  };
  const closeOf = (s, i) => { let d = 0; return scan(s, (j, ch, br) => { if (!br) return false; d += ch === '[' || ch === '(' || ch === '{' ? 1 : -1; return d === 0; }, i); };
  const regexOf = s => { const m = /^\/((?:\\.|[^\\/])+)\/([dimsuy]*)$/.exec(s); if (!m) return null; try { return new RegExp(m[1], m[2]); } catch (e) { return null; } };
  const literal = s => {
    s = s.trim();
    if (/^'.*'$/s.test(s)) return s.slice(1, -1);
    try { return JSON.parse(s); } catch (e) { return s; }
  };
  const split = (s, sep) => { const out = []; let last = 0; scan(s, (i, ch, br) => { if (!br && ch === sep) { out.push(s.slice(last, i)); last = i + 1; } return false; }); out.push(s.slice(last)); return out; };
  function filterOf(expr) {
    expr = expr.trim();
    if (/^\(.*\)$/s.test(expr)) expr = expr.slice(1, -1).trim();
    const rfc = expr.startsWith('@');
    let op = '', at = -1;
    scan(expr, (i, ch, br) => {
      if (br) return false;
      const two = expr.substr(i, 2);
      if (['==', '!=', '<=', '>=', '^=', '$='].includes(two)) { op = two; at = i; return true; }
      if (two === '*=' && expr[i + 2] !== '=') { op = two; at = i; return true; }
      if (ch === '<' || ch === '>') { op = ch; at = i; return true; }
      if (ch === '=' && expr[i + 1] === '/') { op = '=/'; at = i; return true; }
      return false;
    });
    const left = op ? expr.slice(0, at) : expr;
    const segs = pathOf(left.trim().replace(/^@/, ''), true);
    if (!segs) return null;
    let test;
    if (!op) test = () => true;
    else {
      const rhs = expr.slice(at + (op === '=/' ? 1 : op.length)).trim();
      if (op === '=/') { const re = regexOf(rhs); if (!re) return null; test = v => typeof v === 'string' && re.test(v); }
      else {
        const want = literal(rhs);
        test = {
          '==': v => v === want || (typeof v === 'object' && v !== null && JSON.stringify(v) === JSON.stringify(want)),
          '!=': v => !(v === want || (typeof v === 'object' && v !== null && JSON.stringify(v) === JSON.stringify(want))),
          '<': v => typeof v === typeof want && v < want, '<=': v => typeof v === typeof want && v <= want,
          '>': v => typeof v === typeof want && v > want, '>=': v => typeof v === typeof want && v >= want,
          '^=': v => typeof v === 'string' && v.startsWith(String(want)), '$=': v => typeof v === 'string' && v.endsWith(String(want)),
          '*=': v => typeof v === 'string' && v.includes(String(want)),
        }[op];
      }
    }
    return { t: 'filter', rfc, test: node => { const box = { r: node }; return select(segs, [box, 'r']).some(([o, k]) => test(o[k])); } };
  }
  function bracketOf(inner) {
    const s = inner.trim();
    if (s === '*') return { t: 'any' };
    if (/^-?\d+$/.test(s)) return { t: 'index', i: parseInt(s, 10) };
    if (s.startsWith('?')) return filterOf(s.slice(1));
    if (s.startsWith('/')) { const re = regexOf(s); return re ? { t: 're', re } : null; }
    const ks = split(s, ',').map(x => x.trim());
    if (!ks.length || !ks.every(k => /^(["']).*\1$/s.test(k))) return null;
    return { t: 'names', ks: ks.map(k => k[0] === '"' ? (() => { try { return JSON.parse(k); } catch (e) { return k.slice(1, -1); } })() : k.slice(1, -1)) };
  }
  function pathOf(p) {
    const segs = []; let i = 0;
    if (p[0] === '$' || p[0] === '@') i = 1;
    while (i < p.length) {
      let deep = false;
      if (p.startsWith('..', i)) { deep = true; i += 2; }
      else if (p[i] === '.') i++;
      else if (p[i] !== '[' && i !== 0) return null;
      if (i >= p.length) return null;
      const ch = p[i];
      if (ch === '[') {
        const j = closeOf(p, i); if (j < 0) return null;
        const seg = bracketOf(p.slice(i + 1, j)); if (!seg) return null;
        seg.deep = deep; segs.push(seg); i = j + 1; continue;
      }
      if (ch === '*') { segs.push({ t: 'any', deep }); i++; continue; }
      if (ch === '/') {
        const m = /^\/((?:\\.|[^\\/])+)\/([dimsuy]*)/.exec(p.slice(i)); if (!m) return null;
        const re = regexOf(m[0]); if (!re) return null;
        segs.push({ t: 're', re, deep }); i += m[0].length; continue;
      }
      const m = /^[^.[\]]+/.exec(p.slice(i)); if (!m) return null;
      segs.push({ t: 'name', k: m[0], deep }); i += m[0].length;
    }
    return segs;
  }
  // refs are [parent, key]; the root is [{ r: root }, 'r']
  function descend(ref, out, seen) {
    const v = ref[0][ref[1]];
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const k of Object.keys(v)) { const r = [v, k]; out.push(r); descend(r, out, seen); }
  }
  function select(segs, rootRef, create) {
    let cur = [rootRef];
    for (let n = 0; n < segs.length && cur.length; n++) {
      const s = segs[n], last = n === segs.length - 1, next = [], dupe = new Map();
      const add = r => { let ks = dupe.get(r[0]); if (!ks) dupe.set(r[0], ks = new Set()); if (!ks.has(r[1])) { ks.add(r[1]); next.push(r); } };
      for (const ref of cur) {
        const cands = [ref]; if (s.deep) descend(ref, cands, new Set());
        for (const c of cands) {
          const v = c[0][c[1]];
          if (v === null || typeof v !== 'object') continue;
          if (s.t === 'name') { if (own(v, s.k) || (create && last && !s.deep && !Array.isArray(v))) add([v, s.k]); }
          else if (s.t === 'names') { for (const k of s.ks) if (own(v, k)) add([v, k]); }
          else if (s.t === 'any') { for (const k of Object.keys(v)) add([v, k]); }
          else if (s.t === 'index') { if (Array.isArray(v)) { const i = s.i < 0 ? v.length + s.i : s.i; if (i >= 0 && i < v.length) add([v, String(i)]); } }
          else if (s.t === 're') { for (const k of Object.keys(v)) if (s.re.test(k)) add([v, k]); }
          else if (s.t === 'filter') {
            if (Array.isArray(v) || s.rfc) { for (const k of Object.keys(v)) if (s.test(v[k])) add([v, k]); }
            else if (s.test(v)) add(c);
          }
        }
      }
      cur = next;
    }
    return cur;
  }
  // the parts: conditions (with quantifiers), then the final query with its operation
  const parts = split(q, ';').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const conds = [];
  for (const part of parts.slice(0, -1)) {
    const m = /\{(\d*)(,?)(\d*)\}$/.exec(part);
    let min = 1, max = Infinity, body = part;
    if (m) { body = part.slice(0, m.index); min = m[1] === '' ? 0 : +m[1]; max = m[2] ? (m[3] === '' ? Infinity : +m[3]) : (m[1] === '' ? Infinity : +m[1]); }
    const segs = pathOf(body.trim(), false); if (!segs) return null;
    conds.push({ segs, min, max });
  }
  const fin = parts[parts.length - 1];
  const eq = scan(fin, (i, ch, br) => !br && ch === '=');
  let pathText = fin, op = '', value;
  if (eq >= 0) {
    if (!trusted) return null;   // only trusted lists may change values
    const plus = fin[eq - 1] === '+';
    pathText = fin.slice(0, plus ? eq - 1 : eq);
    const vs = fin.slice(eq + 1).trim();
    if (plus) { op = '+='; try { value = JSON.parse(vs); } catch (e) { return null; } if (value === null || typeof value !== 'object' || Array.isArray(value)) return null; }
    else if (/^repl\(.*\)$/s.test(vs)) {
      let o; try { o = JSON.parse(vs.slice(5, -1)); } catch (e) { return null; }
      if (!o || typeof o !== 'object') return null;
      let re; try { re = o.regex !== undefined ? new RegExp(o.regex, o.flags || '') : new RegExp(String(o.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); } catch (e) { return null; }
      op = 'repl'; value = [re, String(o.replacement === undefined ? '' : o.replacement)];
    } else if (/^call\(/.test(vs)) return null;   // calling page functions: not supported
    else { op = '='; try { value = JSON.stringify(JSON.parse(vs)); } catch (e) { value = JSON.stringify(vs); } }
  }
  const segs = pathOf(pathText.trim(), false);
  if (!segs || !segs.length) return null;
  return root => {
    if (root === null || typeof root !== 'object') return false;
    const box = { r: root }, rootRef = [box, 'r'];
    for (const c of conds) { const n = select(c.segs, rootRef).length; if (n < c.min || n > c.max) return false; }
    const refs = select(segs, rootRef, op === '=').filter(r => r[0] !== box);
    if (!refs.length) return false;
    let changed = false;
    if (!op) {
      // remove: array elements from the end, so the indexes stay right
      const arrays = new Map();
      for (const [o, k] of refs) { if (Array.isArray(o)) { if (!arrays.has(o)) arrays.set(o, []); arrays.get(o).push(+k); } else if (own(o, k)) { delete o[k]; changed = true; } }
      for (const [a, ks] of arrays) for (const k of [...new Set(ks)].sort((x, y) => y - x)) { a.splice(k, 1); changed = true; }
      return changed;
    }
    for (const [o, k] of refs) {
      if (op === '=') { o[k] = JSON.parse(value); changed = true; }
      else if (op === '+=') { const t = o[k]; if (t !== null && typeof t === 'object' && !Array.isArray(t)) { Object.assign(t, JSON.parse(JSON.stringify(value))); changed = true; } }
      else if (op === 'repl') { if (typeof o[k] === 'string') { const nv = o[k].replace(value[0], value[1]); if (nv !== o[k]) { o[k] = nv; changed = true; } } }
    }
    return changed;
  };
}
// the arguments after the query: "propsToMatch, value" pairs, or the propsToMatch value on its own first
function shieldEditArgs(rest) {
  const a = rest.filter(x => x !== '' && x !== undefined && x !== null), o = {};
  let i = 0;
  if (a.length % 2 === 1) { o.propsToMatch = a[0]; i = 1; }
  for (; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1];
  return o;
}
// text -> edited text (JSON, or JSON lines), undefined when nothing changed
function shieldJsonText(edit, lines) {
  const one = t => { let o; try { o = JSON.parse(t); } catch (e) { return undefined; } return edit(o) ? JSON.stringify(o) : undefined; };
  if (!lines) return one;
  return text => { let changed = false; const out = text.split('\n').map(l => { if (!l.trim()) return l; const n = one(l); if (n === undefined) return l; changed = true; return n; }); return changed ? out.join('\n') : undefined; };
}
// replace the function at a property chain ("JSON.stringify", "Element.prototype.append", "matchMedia.call") with
// wrap(original); if it doesn't exist yet, it is wrapped when the page creates it
function shieldWrapFn(chain, wrap) {
  const links = String(chain).replace(/^window\./, '').split('.');
  let owner = window;
  for (let i = 0; i < links.length - 1 && owner; i++) { try { owner = owner[links[i]]; } catch (e) { owner = null; } }
  const prop = links[links.length - 1];
  let cur; try { cur = owner ? owner[prop] : undefined; } catch (e) { }
  if (typeof cur === 'function') {
    let d; try { d = Object.getOwnPropertyDescriptor(owner, prop); } catch (e) { }
    const w = wrap(cur);
    try { Object.defineProperty(owner, prop, { value: w, writable: true, configurable: true, enumerable: d ? !!d.enumerable : false }); } catch (e) { try { owner[prop] = w; } catch (e2) { } }
    return;
  }
  shieldTrap(chain, (o, p) => { let f; try { f = o[p]; } catch (e) { } if (typeof f === 'function') f = wrap(f); return { get() { return f; }, set(v) { f = typeof v === 'function' ? wrap(v) : v; } }; });
}
function shieldJsonEditParse(query, rest, trusted) {
  const edit = shieldJsonEdit(query, trusted); if (!edit) return;
  const extra = shieldEditArgs(rest), m = extra.matches ? shieldNeedle(extra.matches) : null;
  JSON.parse = new Proxy(JSON.parse, { apply(t, self, args) { const v = Reflect.apply(t, self, args); try { if (!m || m(String(args[0]))) edit(v); } catch (e) { } return v; } });
}
function shieldJsonEditResponse(kind, query, rest, trusted, lines) {
  const edit = shieldJsonEdit(query, trusted); if (!edit) return;
  const match = shieldReqMatch(shieldEditArgs(rest).propsToMatch), text = shieldJsonText(edit, lines);
  if (kind === 'fetch') shieldFetchHook(match, text); else shieldXhrHook(match, text);
}
function shieldJsonEditRequest(kind, query, rest, trusted) {
  const edit = shieldJsonEdit(query, trusted); if (!edit) return;
  const match = shieldReqMatch(shieldEditArgs(rest).propsToMatch), text = shieldJsonText(edit, false);
  if (kind === 'fetch') {
    if (typeof window.fetch !== 'function') return;
    window.fetch = new Proxy(window.fetch, {
      apply(t, self, args) {
        try {
          const init = args[1];
          if (init && typeof init === 'object' && typeof init.body === 'string' && match(shieldFetchDetails(args))) {
            const out = text(init.body);
            if (out !== undefined) args = [args[0], Object.assign({}, init, { body: out })];
          }
        } catch (e) { }
        return Reflect.apply(t, self, args);
      },
    });
    return;
  }
  const X = XMLHttpRequest.prototype, on = new WeakMap();
  X.open = new Proxy(X.open, { apply(t, xhr, args) { try { on.set(xhr, match({ url: new URL(String(args[1]), location.href).href, method: String(args[0] || 'GET').toUpperCase() })); } catch (e) { } return Reflect.apply(t, xhr, args); } });
  X.send = new Proxy(X.send, { apply(t, xhr, args) { try { if (on.get(xhr) && typeof args[0] === 'string') { const out = text(args[0]); if (out !== undefined) args = [out]; } } catch (e) { } return Reflect.apply(t, xhr, args); } });
}
// edit-inbound-object: the object passed as one argument is edited (a copy, so the page's own object stays as it was)
function shieldEditInbound(chain, pos, query, trusted) {
  const edit = shieldJsonEdit(query, trusted), n = parseInt(pos, 10);
  if (!chain || !edit || isNaN(n)) return;
  const str = JSON.stringify, parse = JSON.parse;
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) {
      const i = n < 0 ? args.length + n : n, v = args[i];
      if (i >= 0 && v !== null && typeof v === 'object') {
        try { const c = Reflect.apply(parse, JSON, [Reflect.apply(str, JSON, [v])]); if (edit(c)) { args = Array.from(args); args[i] = c; } } catch (e) { }
      }
      return Reflect.apply(t, self, args);
    },
  }));
}
// edit-outbound-object: what the function returns is edited (also when it's a promise)
function shieldEditOutbound(chain, query, trusted) {
  const edit = shieldJsonEdit(query, trusted);
  if (!chain || !edit) return;
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) {
      const r = Reflect.apply(t, self, args);
      try { if (r instanceof Promise) return r.then(v => { try { edit(v); } catch (e) { } return v; }); edit(r); } catch (e) { }
      return r;
    },
  }));
}
function jsonEdit(query, ...rest) { shieldJsonEditParse(query, rest, false); }
function trustedJsonEdit(query, ...rest) { shieldJsonEditParse(query, rest, true); }
function jsonEditFetchResponse(query, ...rest) { shieldJsonEditResponse('fetch', query, rest, false, false); }
function trustedJsonEditFetchResponse(query, ...rest) { shieldJsonEditResponse('fetch', query, rest, true, false); }
function jsonEditXhrResponse(query, ...rest) { shieldJsonEditResponse('xhr', query, rest, false, false); }
function trustedJsonEditXhrResponse(query, ...rest) { shieldJsonEditResponse('xhr', query, rest, true, false); }
function jsonlEditFetchResponse(query, ...rest) { shieldJsonEditResponse('fetch', query, rest, false, true); }
function trustedJsonlEditFetchResponse(query, ...rest) { shieldJsonEditResponse('fetch', query, rest, true, true); }
function jsonlEditXhrResponse(query, ...rest) { shieldJsonEditResponse('xhr', query, rest, false, true); }
function trustedJsonlEditXhrResponse(query, ...rest) { shieldJsonEditResponse('xhr', query, rest, true, true); }
function jsonEditFetchRequest(query, ...rest) { shieldJsonEditRequest('fetch', query, rest, false); }
function trustedJsonEditFetchRequest(query, ...rest) { shieldJsonEditRequest('fetch', query, rest, true); }
function jsonEditXhrRequest(query, ...rest) { shieldJsonEditRequest('xhr', query, rest, false); }
function trustedJsonEditXhrRequest(query, ...rest) { shieldJsonEditRequest('xhr', query, rest, true); }
function editInboundObject(chain, pos, query) { shieldEditInbound(chain, pos, query, false); }
function trustedEditInboundObject(chain, pos, query) { shieldEditInbound(chain, pos, query, true); }
function editOutboundObject(chain, query) { shieldEditOutbound(chain, query, false); }
function trustedEditOutboundObject(chain, query) { shieldEditOutbound(chain, query, true); }

// trusted-replace-argument: when the function is called (or constructed), one argument - or "this" - is replaced by a
// fixed value (set-constant's names, a number, "json:<JSON>") or edited with "repl:/regex/replacement/flags", only when
// "condition" (if given) matches the argument
function trustedReplaceArgument(chain, rawPos, rawValue, ...rest) {
  if (!chain || rawPos === undefined || rawPos === '') return;
  const isThis = rawPos === 'this', n = parseInt(rawPos, 10);
  if (!isThis && isNaN(n)) return;
  const raw = String(rawValue === undefined ? '' : rawValue);
  let make;
  const rm = /^repl:\/((?:\\.|[^\\/])*)\/((?:\\.|[^\\/])*)\/([dgimsuy]*)$/s.exec(raw);
  if (rm) { let re; try { re = new RegExp(rm[1], rm[3]); } catch (e) { return; } const rep = rm[2].replace(/\\\//g, '/'); make = old => String(old).replace(re, rep); }
  else if (raw.startsWith('repl:')) return;
  else {
    let v;
    if (raw.startsWith('json:')) { try { v = JSON.parse(raw.slice(5)); } catch (e) { return; } }
    else { const c = shieldConst(raw, false); v = c[0] ? c[1] : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw; }
    make = () => v;
  }
  const extra = shieldExtra(rest), cond = extra.condition !== undefined && extra.condition !== '' ? shieldNeedle(extra.condition) : null;
  const swap = (self, args) => {
    if (isThis) return cond && !cond(self) ? [self, args] : [make(self), args];
    const i = n < 0 ? args.length + n : n;
    if (i < 0 || (cond && !cond(args[i]))) return [self, args];
    const a = Array.from(args); a[i] = make(a[i]); return [self, a];
  };
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) { let r = [self, args]; try { r = swap(self, args); } catch (e) { } return Reflect.apply(t, r[0], r[1]); },
    construct(t, args, nt) { let a = args; try { if (!isThis) a = swap(undefined, args)[1]; } catch (e) { } return Reflect.construct(t, a, nt); },
  }));
}

// href-sanitizer: links that go through a redirect/tracking address get the real destination as their href. The
// destination is the link's text (no tokens), an attribute ("[title]") or taken from the href with uBO's urlskip steps:
// "?name" (a query parameter), "&1" (the name of the first parameter), "#" (the hash), "/regex/" (its first group),
// "+https", "-base64", "-safebase64", "-uricomponent". Only an http(s) address is ever written.
function hrefSanitizer(selector, source) {
  if (!selector) return;
  const steps = String(source || '').trim().split(/\s+/).filter(Boolean);
  const b64 = (s, safe) => { let t = safe ? s.replace(/-/g, '+').replace(/_/g, '/') : s; while (t.length % 4) t += '='; return atob(t); };
  const target = el => {
    let s = null, i = 0;
    if (!steps.length) s = (el.textContent || '').trim();
    else if (/^\[.+\]$/.test(steps[0])) { s = el.getAttribute(steps[0].slice(1, -1)); i = 1; }
    else s = el.href;
    for (; i < steps.length && s; i++) {
      const st = steps[i];
      try {
        if (st[0] === '?') s = new URL(s, location.href).searchParams.get(st.slice(1));
        else if (/^&\d+$/.test(st)) { const ks = [...new URL(s, location.href).searchParams.keys()]; s = ks[parseInt(st.slice(1), 10) - 1] || null; }
        else if (st === '#') { const h = new URL(s, location.href).hash; s = h ? h.slice(1) : null; }
        else if (/^\/.+\/[a-z]*$/.test(st)) { const m = shieldRe(st).exec(s); s = m && m[1] !== undefined ? m[1] : null; }
        else if (st === '+https') s = /^https?:\/\//i.test(s) ? s.replace(/^http:/i, 'https:') : 'https://' + s.replace(/^\/\//, '');
        else if (st === '-base64' || st === '-safebase64') s = b64(s, st === '-safebase64');
        else if (st === '-uricomponent') s = decodeURIComponent(s);
        else if (st !== '-blocked') s = null;
      } catch (e) { s = null; }
    }
    if (!s) return null;
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : null; } catch (e) { return null; }
  };
  shieldWhen('stay', () => {
    let els; try { els = document.querySelectorAll(selector); } catch (e) { return; }
    for (const el of els) {
      if (!el.hasAttribute('href')) continue;
      const u = target(el);
      if (u && u !== el.href) el.setAttribute('href', u);
    }
  }, ['href']);
}

// trusted-prevent-dom-bypass: a page can dodge scriptlets by taking a fresh fetch / open / ... from a blank iframe it
// just added; after the method adds an element, blank same-origin frames in it hand back the page's own (Shield-checked)
// targetProp, or the page's own window when no targetProp is given
function trustedPreventDomBypass(methodPath, targetProp) {
  if (!methodPath) return;
  const prop = String(targetProp || '');
  const fixFrame = f => {
    try {
      const w = f.contentWindow; if (!w) return;
      let href; try { href = w.location.href; } catch (e) { return; }   // another site's frame: not a bypass
      if (href !== 'about:blank' && href !== 'about:srcdoc') return;
      if (!prop) { Object.defineProperty(f, 'contentWindow', { value: window, configurable: true }); return; }
      const links = prop.split('.');
      let mine = window, theirs = w;
      for (let i = 0; i < links.length - 1; i++) { mine = mine[links[i]]; theirs = theirs[links[i]]; if (!mine || !theirs) return; }
      theirs[links[links.length - 1]] = mine[links[links.length - 1]];
    } catch (e) { }
  };
  shieldWrapFn(methodPath, fn => new Proxy(fn, {
    apply(t, self, args) {
      const els = [];
      for (const a of args) { try { if (a instanceof Element) els.push(a); else if (a instanceof DocumentFragment) els.push(...a.children); } catch (e) { } }
      const r = Reflect.apply(t, self, args);
      for (const el of els) {
        try {
          if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) fixFrame(el);
          for (const f of el.querySelectorAll('iframe,frame')) fixFrame(f);
        } catch (e) { }
      }
      return r;
    },
  }));
}

// ---------- 1.8 ----------
// Written from uBO's documentation of each scriptlet (names and arguments as the lists use them); no uBO code.

// trusted-replace-outbound-text: what a function returns (a text) is changed - "condition" (the text must match) and
// "encoding, base64" (the text is decoded first and encoded again after) as extra arguments
function trustedReplaceOutboundText(chain, pattern, replacement, ...rest) {
  if (!chain || pattern === undefined || pattern === '') return;
  const extra = shieldExtra(rest), rep = String(replacement === undefined ? '' : replacement);
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(String(pattern));
  let re; try { re = m ? new RegExp(m[1], m[2]) : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); } catch (e) { return; }
  const cond = extra.condition !== undefined && extra.condition !== '' ? shieldNeedle(extra.condition) : null;
  const b64 = extra.encoding === 'base64', A = window.atob, B = window.btoa;
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) {
      const out = Reflect.apply(t, self, args);
      if (typeof out !== 'string') return out;
      try {
        const text = b64 ? Reflect.apply(A, window, [out]) : out;
        if (cond && !cond(text)) return out;
        re.lastIndex = 0;
        const next = text.replace(re, rep);
        return next === text ? out : b64 ? Reflect.apply(B, window, [next]) : next;
      } catch (e) { return out; }
    },
  }));
}

// one item of a call's signature ("a|b|c", one per argument): "window" / "document" / true / false / null / undefined /
// a number are that value; {"key":"value"} an object with those properties; "/re/" (quoted or not) a pattern, any other
// text a part of the argument as text
function shieldSigSplit(sig) {
  const out = []; let cur = '', q = null, re = false;
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i];
    if (q) { cur += c; if (c === '\\') { cur += sig[++i] || ''; continue; } if (c === q) q = null; continue; }
    if (re) { cur += c; if (c === '\\') { cur += sig[++i] || ''; continue; } if (c === '/') re = false; continue; }
    if (c === '"' && cur.trim() === '') { q = c; cur += c; continue; }
    if (c === '/' && cur.trim() === '') { re = true; cur += c; continue; }
    if (c === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
function shieldSigItem(raw) {
  const s = String(raw).trim();
  if (s === '') return () => true;
  const fixed = { window: window, document: typeof document === 'undefined' ? {} : document, true: true, false: false, null: null, undefined: undefined };
  if (Object.prototype.hasOwnProperty.call(fixed, s)) { const v = fixed[s]; return a => a === v; }
  let v = s;
  if (/^["{[\d-]/.test(s)) { try { v = JSON.parse(s); } catch (e) { v = s; } }
  if (typeof v === 'number') return a => a === v || String(a) === String(v);
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).map(k => [k, shieldSigItem(typeof v[k] === 'string' ? JSON.stringify(v[k]) : JSON.stringify(v[k]))]);
    return a => { if (a === null || (typeof a !== 'object' && typeof a !== 'function')) return false; try { return keys.every(([k, t]) => t(a[k])); } catch (e) { return false; } };
  }
  const re = shieldRe(String(v));
  return a => { let t; try { t = String(a); } catch (e) { return false; } return re.test(t); };
}
// a stack-trace condition: a pattern, or "inlineScript" (called from a script inside the page itself)
function shieldStackTest(needle) {
  if (needle === undefined || needle === '') return null;
  if (needle === 'inlineScript') {
    return () => { const doc = location.href.split('#')[0]; return (new Error().stack || '').split('\n').slice(2).some(l => l.includes(doc + ':')); };
  }
  const t = shieldNeedle(needle);
  return () => t(new Error().stack || '');
}
// trusted-suppress-native-method: a call of a built-in function with these arguments doesn't happen - "abort" (the
// default) throws, "prevent" returns undefined; the fourth argument is a stack-trace condition
function trustedSuppressNativeMethod(chain, signature, how, stack) {
  if (!chain) return;
  const items = shieldSigSplit(String(signature === undefined ? '' : signature)).map(shieldSigItem);
  const abort = how !== 'prevent', st = shieldStackTest(stack);
  const hit = args => { try { return items.every((m, i) => m(args[i])) && (!st || st()); } catch (e) { return false; } };
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) { if (!hit(args)) return Reflect.apply(t, self, args); if (abort) throw new ReferenceError('Shield'); return undefined; },
    construct(t, args, nt) { if (!hit(args)) return Reflect.construct(t, args, nt); if (abort) throw new ReferenceError('Shield'); return {}; },
  }));
}

// HTML text -> nodes of this document (through a Trusted Types policy where the page requires one)
function shieldMarkup(html) {
  let s = String(html);
  try { if (window.trustedTypes && trustedTypes.createPolicy) s = trustedTypes.createPolicy('hallow-shield-' + Math.random().toString(36).slice(2, 8), { createHTML: x => x }).createHTML(s); } catch (e) { }
  const doc = new DOMParser().parseFromString(s, 'text/html'), frag = document.createDocumentFragment();
  for (const n of [...doc.head.childNodes, ...doc.body.childNodes]) frag.appendChild(document.adoptNode(n));
  return frag;
}
// trusted-create-html: elements added to the first element the selector names (when it's there), removed again after
// the given milliseconds
function trustedCreateHtml(parentSelector, html, duration) {
  if (!parentSelector || !html) return;
  const ms = parseInt(duration, 10);
  let done = false, obs = null;
  const insert = () => {
    if (done) return true;
    let parent; try { parent = document.querySelector(parentSelector); } catch (e) { done = true; return true; }
    if (!parent) return false;
    done = true;
    let frag; try { frag = shieldMarkup(html); } catch (e) { return true; }
    const added = [...frag.childNodes];
    try { parent.append(frag); } catch (e) { return true; }
    if (ms > 0) setTimeout(() => { for (const n of added) { try { n.remove(); } catch (e) { } } }, ms);
    return true;
  };
  const start = () => {
    if (insert()) return;
    obs = new MutationObserver(() => { if (insert()) obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
    window.addEventListener('load', () => setTimeout(() => obs.disconnect(), 10000), { once: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}

// XML (VAST / VMAP / DASH manifests) with the nodes a CSS selector or xpath(...) names taken out (attributes too);
// "check": a selector the document must have, else it's left alone
function shieldXmlPruner(selector, check) {
  if (!selector) return null;
  const xp = /^xpath\((.+)\)$/s.exec(String(selector).trim());
  return text => {
    if (!/^\s*</.test(text)) return;
    let doc; try { doc = new DOMParser().parseFromString(text, 'text/xml'); } catch (e) { return; }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return;
    try { if (check && !doc.querySelector(check)) return; } catch (e) { return; }
    const hits = [];
    try {
      if (xp) { const r = doc.evaluate(xp[1], doc, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null); for (let i = 0; i < r.snapshotLength; i++) hits.push(r.snapshotItem(i)); }
      else hits.push(...doc.querySelectorAll(selector));
    } catch (e) { return; }
    if (!hits.length) return;
    for (const n of hits) { try { if (n.nodeType === 2) { if (n.ownerElement) n.ownerElement.removeAttributeNode(n); } else if (n.parentNode) n.parentNode.removeChild(n); } catch (e) { } }
    return new XMLSerializer().serializeToString(doc);
  };
}
function xmlPrune(selector, check, urlPattern) {
  const prune = shieldXmlPruner(selector, check);
  if (!prune) return;
  const url = shieldNeedle(urlPattern || ''), match = d => url(d.url);
  shieldFetchHook(match, prune);
  shieldXhrHook(match, prune);
}
function mpegdashPrune(selector, urlPattern) { xmlPrune(selector, '', urlPattern); }

// HLS playlists (.m3u8) without the ad segments: a /re/ with the m or s flag works on the whole text; otherwise each
// line that matches goes, with its segment (#EXTINF and the address that belong together)
function shieldM3uPruner(pattern) {
  if (!pattern) return null;
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(String(pattern));
  let re = null; try { if (m) re = new RegExp(m[1], m[2]); } catch (e) { return null; }
  const lit = re ? null : String(pattern);
  const hit = line => { if (!re) return line.includes(lit); re.lastIndex = 0; return re.test(line); };
  return text => {
    if (!/^\s*#EXTM3U/.test(text)) return;
    if (re && /[ms]/.test(re.flags)) { const g = re.global ? re : new RegExp(re.source, re.flags + 'g'); g.lastIndex = 0; const out = text.replace(g, ''); return out === text ? undefined : out; }
    const lines = text.split(/\r?\n/), drop = lines.map(() => false);
    for (let i = 0; i < lines.length; i++) {
      if (drop[i] || !hit(lines[i])) continue;
      drop[i] = true;
      if (lines[i].startsWith('#EXTINF')) { for (let j = i + 1; j < lines.length; j++) { if (!lines[j]) continue; drop[j] = true; if (!lines[j].startsWith('#')) break; } }
      else if (!lines[i].startsWith('#')) {
        for (let j = i - 1; j >= 0 && lines[j].startsWith('#') && !lines[j].startsWith('#EXTM3U'); j--) { if (lines[j].startsWith('#EXTINF')) { for (let k = j; k < i; k++) drop[k] = true; break; } }
      }
    }
    if (!drop.some(Boolean)) return;
    return lines.filter((l, i) => !drop[i]).join('\n');
  };
}
function m3uPrune(pattern, urlPattern) {
  const prune = shieldM3uPruner(pattern);
  if (!prune) return;
  const url = shieldNeedle(urlPattern || ''), match = d => url(d.url);
  shieldFetchHook(match, prune);
  shieldXhrHook(match, prune);
}

// refresh-defuser: a <meta http-equiv="refresh"> doesn't take the page away (the page stops loading just before the
// refresh would happen; the browser starts the refresh's clock when the page has loaded)
function refreshDefuser(delay) {
  const defuse = () => {
    let meta = null; try { meta = document.querySelector('meta[http-equiv="refresh" i][content]'); } catch (e) { }
    if (!meta) return;
    const s = delay !== undefined && delay !== '' ? delay : meta.getAttribute('content');
    const ms = Math.max(parseFloat(s) || 0, 0) * 1000;
    const stop = () => { try { window.stop(); } catch (e) { } };
    if (ms <= 200) stop(); else setTimeout(stop, ms - 200);
  };
  if (document.readyState === 'complete') defuse(); else window.addEventListener('load', defuse, { capture: true, once: true });
}

// nobab: the "BlockAdBlock" family of anti-adblock scripts (run through eval or a timer) never runs
function nobab() {
  const looksLikeBab = code => {
    const s = String(code);
    if (/blockadblock|babasbm|['"]babn['"]/i.test(s)) return true;
    return ['String.fromCharCode', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'DOMContentLoaded', 'doScroll', 'sessionStorage', 'clientWidth'].every(t => s.includes(t));
  };
  window.eval = new Proxy(window.eval, { apply(t, self, args) { if (typeof args[0] === 'string' && looksLikeBab(args[0])) return undefined; return Reflect.apply(t, self, args); } });
  window.setTimeout = new Proxy(window.setTimeout, { apply(t, self, args) { if (looksLikeBab(shieldFnText(args[0]))) return 0; return Reflect.apply(t, self, args); } });
}

// popads: popads-dummy gives the pop-under script dummies to find; popads.net makes it fail on its first look
function popadsDummy() {
  for (const k of ['PopAds', 'popns']) { try { delete window[k]; Object.defineProperty(window, k, { value: {}, writable: false, configurable: false }); } catch (e) { } }
}
function popadsNet() {
  const err = new ReferenceError('Shield: popads');
  for (const k of ['PopAds', 'popns']) { try { Object.defineProperty(window, k, { configurable: false, get() { throw err; }, set() { throw err; } }); } catch (e) { } }
  window.addEventListener('error', e => { if (e.error === err) e.preventDefault(); }, true);
}

// prevent-innerHTML: setting innerHTML on an element the selector names, to a text that matches, doesn't happen
function preventInnerHTML(selector, pattern) {
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (!d || !d.set) return;
  const test = shieldNeedle(pattern || '');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true, enumerable: d.enumerable, get: d.get,
    set: new Proxy(d.set, { apply(t, el, args) { let hit = false; try { hit = (!selector || el.matches(selector)) && test(String(args[0])); } catch (e) { } if (hit) return; return Reflect.apply(t, el, args); } }),
  });
}
// prevent-canvas: canvas.getContext(type) gives null for these types ("2d", "webgl", ...)
function preventCanvas(contextType) {
  const test = shieldNeedle(contextType || ''), P = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (!P) return;
  P.getContext = new Proxy(P.getContext, { apply(t, self, args) { if (test(String(args[0]))) return null; return Reflect.apply(t, self, args); } });
}
// spoof-css: elements the selector names report these CSS values (getComputedStyle, and the box size / place for
// width, height, top, left) - for pages that check whether their bait was hidden
function spoofCss(selector, ...pairs) {
  if (!selector || pairs.length < 2) return;
  const camel = k => String(k).trim().replace(/-([a-z])/g, (x, c) => c.toUpperCase()), want = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) want[camel(pairs[i])] = String(pairs[i + 1]);
  const has = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(want, camel(k));
  const hit = el => { try { return el instanceof Element && el.matches(selector); } catch (e) { return false; } };
  window.getComputedStyle = new Proxy(window.getComputedStyle, {
    apply(t, self, args) {
      const st = Reflect.apply(t, self, args);
      if (!hit(args[0])) return st;
      return new Proxy(st, {
        get(o, k) {
          if (has(k)) return want[camel(k)];
          if (k === 'getPropertyValue') return name => has(name) ? want[camel(name)] : o.getPropertyValue(name);
          const v = Reflect.get(o, k, o);
          return typeof v === 'function' ? v.bind(o) : v;
        },
      });
    },
  });
  const num = k => want[k] !== undefined && !isNaN(parseFloat(want[k])) ? parseFloat(want[k]) : null;
  if (['width', 'height', 'top', 'left'].some(k => num(k) !== null)) {
    Element.prototype.getBoundingClientRect = new Proxy(Element.prototype.getBoundingClientRect, {
      apply(t, self, args) {
        const r = Reflect.apply(t, self, args);
        if (!hit(self)) return r;
        const v = (k, d) => num(k) === null ? d : num(k);
        return new DOMRect(v('left', r.x), v('top', r.y), v('width', r.width), v('height', r.height));
      },
    });
  }
}
// trusted-override-element-method: a method called on an element the selector names does nothing (returns the
// given value, or throws with "throw")
function trustedOverrideElementMethod(chain, selector, disposition) {
  if (!chain || !selector) return;
  const d = String(disposition === undefined ? '' : disposition), value = d === '' || d === 'throw' ? undefined : shieldConst(d, true)[1];
  shieldWrapFn(chain, fn => new Proxy(fn, {
    apply(t, self, args) {
      let hit = false; try { hit = self instanceof Element && self.matches(selector); } catch (e) { }
      if (!hit) return Reflect.apply(t, self, args);
      if (d === 'throw') throw new ReferenceError('Shield');
      return value;
    },
  }));
}
// disable-newtab-links: links that would open a new tab don't
function disableNewtabLinks() {
  document.addEventListener('click', e => {
    let el = e.target;
    while (el && !(el instanceof HTMLAnchorElement)) el = el.parentElement;
    if (!el) return;
    const t = (el.getAttribute('target') || '').toLowerCase();
    if (!t || t === '_self' || t === '_parent' || t === '_top') return;
    e.preventDefault(); e.stopPropagation();
  }, true);
}
// set-cookie-reload / trusted-set-cookie-reload: the cookie is set, and the page reloaded once if that changed it
function shieldCookieNow(name) {
  const p = document.cookie.split(/;\s*/).find(c => c.split('=')[0] === encodeURIComponent(name));
  return p === undefined ? null : p.slice(p.indexOf('=') + 1);
}
function setCookieReload(name, value, path) {
  const before = shieldCookieNow(name); setCookie(name, value, path);
  const after = shieldCookieNow(name); if (after !== null && after !== before) location.reload();
}
function trustedSetCookieReload(name, value, offset, path) {
  const before = shieldCookieNow(name); trustedSetCookie(name, value, offset, path);
  const after = shieldCookieNow(name); if (after !== null && after !== before) location.reload();
}
// prevent-dialog: <dialog> elements the selector names aren't opened (and are closed when they are)
function preventDialog(selector) {
  const P = window.HTMLDialogElement && HTMLDialogElement.prototype;
  if (!P) return;
  const ok = el => { try { return !selector || el.matches(selector); } catch (e) { return false; } };
  for (const m of ['show', 'showModal']) if (P[m]) P[m] = new Proxy(P[m], { apply(t, self, args) { if (ok(self)) return undefined; return Reflect.apply(t, self, args); } });
  shieldWhen('stay', () => { for (const d of document.querySelectorAll('dialog[open]')) if (ok(d)) { try { d.close(); } catch (e) { } } }, ['open']);
}
// prevent-navigation: the page can't send itself to addresses that match (the Navigation API)
function preventNavigation(pattern) {
  if (!window.navigation || !pattern) return;
  const test = pattern === 'location.href' ? (u => u === location.href) : shieldNeedle(pattern);
  window.navigation.addEventListener('navigate', e => { try { if (e.cancelable && test(e.destination.url)) e.preventDefault(); } catch (er) { } });
}
// prevent-clipboard-write: the page can't put text that matches on the clipboard (the "paste this into Run" scams)
function preventClipboardWrite(pattern) {
  const test = shieldNeedle(pattern || '');
  const C = window.Clipboard && Clipboard.prototype, D = window.DataTransfer && DataTransfer.prototype;
  if (C && C.writeText) C.writeText = new Proxy(C.writeText, { apply(t, self, args) { if (test(String(args[0]))) return Promise.resolve(); return Reflect.apply(t, self, args); } });
  if (D && D.setData) D.setData = new Proxy(D.setData, { apply(t, self, args) { if (test(String(args[1]))) return undefined; return Reflect.apply(t, self, args); } });
}
// fingerprint2: a do-nothing stand-in for the FingerprintJS 2 library (pages that wait for it still go on)
function fingerprint2() {
  const id = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  function Fingerprint2() { }
  const later = cb => { if (typeof cb === 'function') setTimeout(() => cb(id, []), 1); };
  Fingerprint2.get = (o, cb) => later(typeof o === 'function' ? (c => o([], c)) : cb && (() => cb([])));
  Fingerprint2.getPromise = () => Promise.resolve([]);
  Fingerprint2.getV18 = (o, cb) => later(typeof o === 'function' ? o : cb);
  Fingerprint2.x64hash128 = () => id;
  Fingerprint2.prototype.get = function (cb) { later(cb); };
  try { Object.defineProperty(window, 'Fingerprint2', { value: Fingerprint2, writable: false, configurable: true }); } catch (e) { }
}
// edit-object-on-setter: an object the page stores in a property is edited (uBO's JSONPath-like syntax) as it's stored
function shieldEditOnSetter(chain, query, trusted) {
  const edit = shieldJsonEdit(query, trusted);
  if (!chain || !edit) return;
  shieldTrap(chain, (owner, prop) => {
    let v; try { v = owner[prop]; } catch (e) { }
    if (v && typeof v === 'object') { try { edit(v); } catch (e) { } }
    return { get() { return v; }, set(nv) { if (nv && typeof nv === 'object') { try { edit(nv); } catch (e) { } } v = nv; } };
  });
}
function editObjectOnSetter(chain, query) { shieldEditOnSetter(chain, query, false); }
function trustedEditObjectOnSetter(chain, query) { shieldEditOnSetter(chain, query, true); }

// canonical name -> implementation
export const SCRIPTLETS = {
  'set-constant': setConstant, 'trusted-set-constant': trustedSetConstant,
  'abort-on-property-read': abortOnPropertyRead, 'abort-on-property-write': abortOnPropertyWrite,
  'abort-current-script': abortCurrentScript, 'abort-on-stack-trace': abortOnStackTrace,
  'json-prune': jsonPrune, 'json-prune-fetch-response': jsonPruneFetchResponse, 'json-prune-xhr-response': jsonPruneXhrResponse,
  'trusted-replace-fetch-response': trustedReplaceFetchResponse, 'trusted-replace-xhr-response': trustedReplaceXhrResponse,
  'prevent-fetch': preventFetch, 'prevent-xhr': preventXhr,
  'prevent-setTimeout': preventSetTimeout, 'prevent-setInterval': preventSetInterval, 'prevent-requestAnimationFrame': preventRequestAnimationFrame,
  'adjust-setTimeout': adjustSetTimeout, 'adjust-setInterval': adjustSetInterval,
  'addEventListener-defuser': addEventListenerDefuser, 'no-window-open-if': noWindowOpenIf,
  'remove-attr': removeAttr, 'remove-class': removeClass, 'remove-node-text': removeNodeText,
  'set-cookie': setCookie, 'set-local-storage-item': setLocalStorageItem, 'set-session-storage-item': setSessionStorageItem, 'remove-cookie': removeCookie,
  'noeval-if': noevalIf, 'trusted-replace-node-text': trustedReplaceNodeText, nowebrtc: noWebrtc, 'prevent-fab': preventFab,
  'set-attr': setAttr, 'trusted-set-attr': trustedSetAttr, 'trusted-set-cookie': trustedSetCookie,
  'trusted-set-local-storage-item': trustedSetLocalStorageItem, 'trusted-set-session-storage-item': trustedSetSessionStorageItem,
  'window-close-if': windowCloseIf, 'alert-buster': alertBuster,
  // 1.5
  'json-edit': jsonEdit, 'trusted-json-edit': trustedJsonEdit,
  'json-edit-fetch-response': jsonEditFetchResponse, 'trusted-json-edit-fetch-response': trustedJsonEditFetchResponse,
  'json-edit-xhr-response': jsonEditXhrResponse, 'trusted-json-edit-xhr-response': trustedJsonEditXhrResponse,
  'jsonl-edit-fetch-response': jsonlEditFetchResponse, 'trusted-jsonl-edit-fetch-response': trustedJsonlEditFetchResponse,
  'jsonl-edit-xhr-response': jsonlEditXhrResponse, 'trusted-jsonl-edit-xhr-response': trustedJsonlEditXhrResponse,
  'json-edit-fetch-request': jsonEditFetchRequest, 'trusted-json-edit-fetch-request': trustedJsonEditFetchRequest,
  'json-edit-xhr-request': jsonEditXhrRequest, 'trusted-json-edit-xhr-request': trustedJsonEditXhrRequest,
  'edit-inbound-object': editInboundObject, 'trusted-edit-inbound-object': trustedEditInboundObject,
  'edit-outbound-object': editOutboundObject, 'trusted-edit-outbound-object': trustedEditOutboundObject,
  'trusted-replace-argument': trustedReplaceArgument, 'href-sanitizer': hrefSanitizer, 'trusted-prevent-dom-bypass': trustedPreventDomBypass,
  // 1.8
  'trusted-replace-outbound-text': trustedReplaceOutboundText, 'trusted-suppress-native-method': trustedSuppressNativeMethod,
  'trusted-create-html': trustedCreateHtml, 'xml-prune': xmlPrune, 'mpegdash-prune': mpegdashPrune, 'm3u-prune': m3uPrune,
  'refresh-defuser': refreshDefuser, nobab, 'popads-dummy': popadsDummy, 'popads.net': popadsNet,
  'prevent-innerHTML': preventInnerHTML, 'prevent-canvas': preventCanvas, 'spoof-css': spoofCss,
  'trusted-override-element-method': trustedOverrideElementMethod, 'disable-newtab-links': disableNewtabLinks,
  'set-cookie-reload': setCookieReload, 'trusted-set-cookie-reload': trustedSetCookieReload,
  'prevent-dialog': preventDialog, 'prevent-navigation': preventNavigation, 'prevent-clipboard-write': preventClipboardWrite,
  fingerprint2, 'edit-object-on-setter': editObjectOnSetter, 'trusted-edit-object-on-setter': trustedEditObjectOnSetter,
};
const JSON_EDIT = [shieldJsonEdit, shieldEditArgs, shieldJsonText];
const JSON_EDIT_EXTRA = Object.fromEntries(Object.keys(SCRIPTLETS).filter(n => /json-edit|jsonl-edit/.test(n)).map(n => [n, [...JSON_EDIT, /request/.test(n) ? shieldJsonEditRequest : /response/.test(n) ? shieldJsonEditResponse : shieldJsonEditParse]]));
const OBJECT_EDIT_EXTRA = Object.fromEntries(Object.keys(SCRIPTLETS).filter(n => /edit-(in|out)bound-object/.test(n)).map(n => [n, [...JSON_EDIT, shieldWrapFn, /inbound/.test(n) ? shieldEditInbound : shieldEditOutbound]]));
// helpers some scriptlets need on top of HELPERS
export const EXTRA = { 'trusted-replace-fetch-response': [shieldReplacer], 'trusted-replace-xhr-response': [shieldReplacer],
  'adjust-setTimeout': [shieldAdjust], 'adjust-setInterval': [shieldAdjust], 'set-local-storage-item': [shieldStorage], 'set-session-storage-item': [shieldStorage],
  'remove-node-text': [shieldNodeText], 'trusted-replace-node-text': [shieldNodeText], 'set-attr': [shieldSetAttr], 'trusted-set-attr': [shieldSetAttr],
  ...JSON_EDIT_EXTRA, ...OBJECT_EDIT_EXTRA, 'trusted-replace-argument': [shieldWrapFn], 'trusted-prevent-dom-bypass': [shieldWrapFn],
  // 1.8
  'trusted-replace-outbound-text': [shieldWrapFn], 'trusted-suppress-native-method': [shieldWrapFn, shieldSigSplit, shieldSigItem, shieldStackTest],
  'trusted-create-html': [shieldMarkup], 'xml-prune': [shieldXmlPruner], 'mpegdash-prune': [shieldXmlPruner, xmlPrune], 'm3u-prune': [shieldM3uPruner],
  'trusted-override-element-method': [shieldWrapFn], 'set-cookie-reload': [shieldCookieNow, setCookie], 'trusted-set-cookie-reload': [shieldCookieNow, trustedSetCookie],
  'edit-object-on-setter': [...JSON_EDIT, shieldEditOnSetter], 'trusted-edit-object-on-setter': [...JSON_EDIT, shieldEditOnSetter] };
// for the unit tests
export const JSON_EDIT_SOURCE = shieldJsonEdit;
export const CONSTS = { 'set-cookie': `const SHIELD_SAFE_VALUES = ${JSON.stringify(SHIELD_SAFE_VALUES)};`, 'set-cookie-reload': `const SHIELD_SAFE_VALUES = ${JSON.stringify(SHIELD_SAFE_VALUES)};` };

// the runner around a scriptlet: which arguments apply on this page (hostname, its parent domains, "name.*" entities)
function shieldRun(main, ARGS, HOSTS, EXC) {
  const p = location.hostname.toLowerCase().split('.'), keys = [];
  for (let i = 0; i < p.length; i++) keys.push(p.slice(i).join('.'));
  for (let i = 0; i < p.length - 1; i++) if (p.length - i - 1 <= 2) keys.push(p[i] + '.*');
  const use = new Set();
  for (const k of keys) if (HOSTS[k]) for (const i of HOSTS[k]) use.add(i);
  for (const k of keys) if (EXC[k]) { if (EXC[k].includes(-1)) use.clear(); else for (const i of EXC[k]) use.delete(i); }
  for (const i of use) { try { main(...ARGS[i]); } catch (e) { } }
}
// one bundle (a classic script, no module syntax) for one or more scriptlets: { name: { args, hosts, exc } }
export function bundleMany(parts, title) {
  const names = Object.keys(parts);
  const helpers = [...new Set([...HELPERS, ...names.flatMap(n => EXTRA[n] || [])])].map(h => h.toString()).join('\n');
  const consts = [...new Set(names.map(n => CONSTS[n]).filter(Boolean))].join('\n');
  return `// Hallow Shield scriptlets (${title}) - generated by tools/build.mjs from the filter lists; runs in the page (MAIN world).\n` +
    `(function () {\n'use strict';\n${consts}\n${helpers}\n${shieldRun.toString()}\n` +
    names.map(n => `${SCRIPTLETS[n].toString()}\nshieldRun(${SCRIPTLETS[n].name}, ${JSON.stringify(parts[n].args)}, ${JSON.stringify(parts[n].hosts)}, ${JSON.stringify(parts[n].exc)});`).join('\n') +
    `\n})();\n`;
}
export const bundle = (name, data) => bundleMany({ [name]: data }, name);

// 1.5: the runner of a bundle for many sites. KEYS is "|site=[[filter ids],[exception ids]]|site2=..." - a plain string,
// which costs the page almost nothing to load - and ARGS (the filters' arguments, a JSON text) is only read on a page
// whose site is in KEYS. An exception id below 0 turns every filter of that scriptlet off (-1 = the first scriptlet).
function shieldSites(FNS, KEYS, ARGS) {
  const p = location.hostname.toLowerCase().split('.'), keys = [];
  for (let i = 0; i < p.length; i++) keys.push(p.slice(i).join('.'));
  for (let i = 0; i < p.length - 1; i++) if (p.length - i - 1 <= 2) keys.push(p[i] + '.*');
  let inc = null; const exc = [];
  for (const k of keys) {
    if (!k) continue;
    const at = KEYS.indexOf('|' + k + '=');
    if (at < 0) continue;
    const from = at + k.length + 2, to = KEYS.indexOf('|', from);
    let v; try { v = JSON.parse(KEYS.slice(from, to < 0 ? KEYS.length : to)); } catch (e) { continue; }
    if (!inc) inc = new Set();
    for (const id of v[0]) inc.add(id);
    for (const x of v[1]) exc.push(x);
  }
  if (!inc || !inc.size) return;
  const table = JSON.parse(ARGS);
  for (const x of exc) { if (x >= 0) inc.delete(x); else for (const id of [...inc]) if (table[id][0] === -x - 1) inc.delete(id); }
  for (const id of [...inc].sort((a, c) => a - c)) { const [n, a] = table[id]; try { FNS[n](...a); } catch (e) { } }
}
// one bundle (a classic script) for the sites of several scriptlets: parts = { name: { args, hosts, exc } }
export function bundleSites(parts, title) {
  const names = Object.keys(parts), table = [], idOf = new Map(), keys = new Map();
  names.forEach((n, ni) => parts[n].args.forEach((a, i) => { idOf.set(n + ' ' + i, table.length); table.push([ni, a]); }));
  const entry = k => { if (!keys.has(k)) keys.set(k, [[], []]); return keys.get(k); };
  names.forEach((n, ni) => {
    for (const [k, l] of Object.entries(parts[n].hosts)) for (const i of l) entry(k)[0].push(idOf.get(n + ' ' + i));
    for (const [k, l] of Object.entries(parts[n].exc)) for (const i of l) entry(k)[1].push(i < 0 ? -(ni + 1) : idOf.get(n + ' ' + i));
  });
  const K = [...keys].map(([k, v]) => '|' + k + '=' + JSON.stringify(v)).join('') + '|';
  const helpers = [...new Set([...HELPERS, ...names.flatMap(n => EXTRA[n] || [])])].map(h => h.toString()).join('\n');
  const consts = [...new Set(names.map(n => CONSTS[n]).filter(Boolean))].join('\n');
  return `// Hallow Shield scriptlets (${title}) - generated by tools/build.mjs from the filter lists; runs in the page (MAIN world).\n` +
    `(function () {\n'use strict';\n${consts}\n${helpers}\n${shieldSites.toString()}\n` +
    names.map(n => SCRIPTLETS[n].toString()).join('\n') +
    `\nshieldSites([${names.map(n => SCRIPTLETS[n].name).join(', ')}], ${JSON.stringify(K)}, ${JSON.stringify(JSON.stringify(table))});\n})();\n`;
}

// ---------- 1.8: page fixes split by site ----------
// 1.5 put each top-level domain's fixes in one bundle (the .com one was 0.7 MB) that every frame under that domain
// loaded in full. Now:
//   rules/js/core.js         the scriptlets' code, once (MAIN world, every frame where page fixes are on)
//   rules/js/<bundle>.js     a small loader per bundle (ISOLATED world) with a Bloom filter of the bundle's sites: a
//                            frame whose site (or parent domain, or name.*) isn't in it does nothing more
//   rules/sl/<bundle>-<n>.json   the sites' filters, in shards by site; a frame reads only its own site's shard(s)
//                            (from the extension, synchronously, so the fixes still run before the page's scripts)
// The loader hands the filters to the core with a DOM event (both worlds share the document); the core runs them.
export const SL_RUN = 'hallowshield-sl-run', SL_READY = 'hallowshield-sl-ready';
const BLOOM_K = 11, BLOOM_BITS = 16;   // about 0.05 % false positives per key: a frame checks up to ~5 keys in up to 4 bundles
function shieldFnv(s, h) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export const fnv = shieldFnv;
export const bloomIndexes = (key, m) => { const a = shieldFnv(key, 2166136261), b = shieldFnv(key, 3735928559) | 1; return Array.from({ length: BLOOM_K }, (_, i) => ((a + Math.imul(i, b)) >>> 0) % m); };
export const shardOf = (key, n) => shieldFnv(key, 2166136261) % n;

// MAIN world: the code of every scriptlet named, and the receiver for the loaders' filters
function shieldCore(FNS, RUN, READY) {
  const onRun = e => {
    let msg; try { msg = JSON.parse(String(e.detail)); } catch (er) { return; }
    if (!msg || !Array.isArray(msg.c)) return;
    e.preventDefault();
    for (const call of msg.c) { const f = FNS[call[0]]; if (typeof f === 'function') { try { f(...call[1]); } catch (er) { } } }
  };
  document.addEventListener(RUN, onRun);
  document.dispatchEvent(new CustomEvent(READY));
  document.addEventListener('DOMContentLoaded', () => document.removeEventListener(RUN, onRun), { once: true });
}
export function coreBundle(names) {
  names = [...new Set(names)].filter(n => SCRIPTLETS[n]).sort();
  const fns = new Set([...HELPERS, ...names.flatMap(n => EXTRA[n] || []), ...names.map(n => SCRIPTLETS[n])]);
  const consts = [...new Set(names.map(n => CONSTS[n]).filter(Boolean))].join('\n');
  return `// Hallow Shield page fixes: the code (MAIN world) - generated by tools/build.mjs; Hallow Shield's own scriptlets.\n` +
    `(function () {\n'use strict';\n${consts}\n${[...fns].map(f => f.toString()).join('\n')}\n${shieldCore.toString()}\n` +
    `shieldCore({${names.map(n => JSON.stringify(n) + ': ' + SCRIPTLETS[n].name).join(', ')}}, ${JSON.stringify(SL_RUN)}, ${JSON.stringify(SL_READY)});\n})();\n`;
}

// ISOLATED world: is this frame's site in the bundle? Then read its shard(s) and hand the filters to the core.
function shieldLoader(ID, N, M, BITS, RUN, READY) {
  const ext = globalThis.browser || globalThis.chrome;
  const p = location.hostname.toLowerCase().split('.'), keys = [];
  for (let i = 0; i < p.length; i++) keys.push(p.slice(i).join('.'));
  for (let i = 0; i < p.length - 1; i++) if (p.length - i - 1 <= 2) keys.push(p[i] + '.*');
  const fnv = (s, h) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const bits = atob(BITS);
  const has = k => { const a = fnv(k, 2166136261), b = fnv(k, 3735928559) | 1; for (let i = 0; i < 11; i++) { const x = ((a + Math.imul(i, b)) >>> 0) % M; if (!(bits.charCodeAt(x >> 3) & (1 << (x & 7)))) return false; } return true; };
  const want = keys.filter(k => k && has(k));
  if (!want.length) return;
  const files = [...new Set(want.map(k => fnv(k, 2166136261) % N))];
  const run = shards => {
    let inc = null; const exc = [], table = {};
    for (const s of shards) {
      if (!s) continue;
      for (const k of want) { const v = s.k[k]; if (!v) continue; inc = inc || new Set(); for (const id of v[0]) { inc.add(id); table[id] = s.t[id]; } for (const x of v[1]) exc.push(x); }
    }
    if (!inc || !inc.size) return;
    for (const x of exc) { if (typeof x === 'number') inc.delete(x); else for (const id of [...inc]) if (table[id] && table[id][0] === x) inc.delete(id); }
    const calls = [...inc].sort((a, c) => a - c).map(id => table[id]).filter(Boolean);
    if (!calls.length) return;
    const detail = JSON.stringify({ b: ID, c: calls });
    const send = () => document.dispatchEvent(new CustomEvent(RUN, { detail, cancelable: true }));
    if (send()) { const again = () => { document.removeEventListener(READY, again); send(); }; document.addEventListener(READY, again); }
  };
  const url = n => ext.runtime.getURL('rules/sl/' + ID + '-' + n + '.json');
  let shards = null;
  try {
    shards = files.map(n => { const x = new XMLHttpRequest(); x.open('GET', url(n), false); x.send(); if (x.status && x.status !== 200) throw new Error(String(x.status)); return JSON.parse(x.responseText); });
  } catch (e) { shards = null; }
  if (shards) run(shards);
  else Promise.all(files.map(n => fetch(url(n)).then(r => r.json()).catch(() => null))).then(run);   // late, but better than not at all
}

// parts = { canonical name: { args, hosts, exc } } (as for bundleSites) -> the loader and its shards
export function siteBundle(id, parts, title, shardBytes = 6000) {
  const names = Object.keys(parts), table = [], idOf = new Map(), keys = new Map();
  names.forEach(n => parts[n].args.forEach((a, i) => { idOf.set(n + ' ' + i, table.length); table.push([n, a]); }));
  const entry = k => { if (!keys.has(k)) keys.set(k, [[], []]); return keys.get(k); };
  names.forEach(n => {
    for (const [k, l] of Object.entries(parts[n].hosts)) for (const i of l) entry(k)[0].push(idOf.get(n + ' ' + i));
    for (const [k, l] of Object.entries(parts[n].exc)) for (const i of l) entry(k)[1].push(i < 0 ? n : idOf.get(n + ' ' + i));
  });
  // shards of about shardBytes each
  const size = [...keys].reduce((s, [k, v]) => s + k.length + JSON.stringify(v).length + v[0].reduce((t, i) => t + JSON.stringify(table[i]).length, 0), 0);
  const n = Math.max(1, Math.min(512, Math.round(size / shardBytes)));
  const shards = Array.from({ length: n }, () => ({ k: {}, t: {} }));
  for (const [k, v] of keys) { const s = shards[shardOf(k, n)]; s.k[k] = v; for (const i of v[0]) s.t[i] = table[i]; }
  // the Bloom filter (a false positive = a frame that reads a shard for nothing)
  const m = Math.max(64, Math.ceil(keys.size * BLOOM_BITS / 8) * 8), bits = new Uint8Array(m / 8);
  for (const k of keys.keys()) for (const x of bloomIndexes(k, m)) bits[x >> 3] |= 1 << (x & 7);
  const loader = `// Hallow Shield page fixes for ${title} - the loader (ISOLATED world), generated by tools/build.mjs.\n` +
    `(function () {\n'use strict';\n${shieldLoader.toString()}\nshieldLoader(${JSON.stringify(id)}, ${n}, ${m}, ${JSON.stringify(Buffer.from(bits).toString('base64'))}, ${JSON.stringify(SL_RUN)}, ${JSON.stringify(SL_READY)});\n})();\n`;
  return { loader, shards: shards.map(s => JSON.stringify(s)), keys: keys.size, names };
}
