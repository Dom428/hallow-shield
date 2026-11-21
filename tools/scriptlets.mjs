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
function removeNodeText(nodeName, pattern) {
  if (!nodeName) return;
  const name = shieldRe(nodeName.startsWith('/') ? nodeName : '/^' + nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$/i'), test = shieldRe(pattern || '');
  const check = n => { try { if (name.test(n.nodeName.toLowerCase()) && test.test(n.textContent)) n.textContent = ''; } catch (e) { } };
  const scan = root => { check(root); if (root.querySelectorAll) for (const n of root.querySelectorAll('*')) { if (name.test(n.nodeName.toLowerCase())) check(n); } };
  new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) { check(n); if (n.nodeType === 3) continue; if (n.childNodes) for (const c of n.childNodes) check(c); } })
    .observe(document, { childList: true, subtree: true });
  if (document.documentElement) scan(document.documentElement);
}
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
  'noeval-if': noevalIf,
};
// helpers some scriptlets need on top of HELPERS
export const EXTRA = { 'trusted-replace-fetch-response': [shieldReplacer], 'trusted-replace-xhr-response': [shieldReplacer],
  'adjust-setTimeout': [shieldAdjust], 'adjust-setInterval': [shieldAdjust], 'set-local-storage-item': [shieldStorage], 'set-session-storage-item': [shieldStorage] };
export const CONSTS = { 'set-cookie': `const SHIELD_SAFE_VALUES = ${JSON.stringify(SHIELD_SAFE_VALUES)};` };

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
// one bundle (a classic script, no module syntax) for one scriptlet
export function bundle(name, data) {
  const f = SCRIPTLETS[name];
  const helpers = [...HELPERS, ...(EXTRA[name] || [])].map(h => h.toString()).join('\n');
  return `// Hallow Shield scriptlet "${name}" - generated by tools/build.mjs from the filter lists; runs in the page (MAIN world).\n` +
    `(function () {\n'use strict';\n` +
    `${CONSTS[name] || ''}\n${helpers}\n${f.toString()}\n${shieldRun.toString()}\n` +
    `shieldRun(${f.name}, ${JSON.stringify(data.args)}, ${JSON.stringify(data.hosts)}, ${JSON.stringify(data.exc)});\n})();\n`;
}
