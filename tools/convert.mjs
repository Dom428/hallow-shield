// Hallow Shield: turns Adblock Plus / uBlock Origin style filter lists into what a Manifest V3 extension can use:
//   - declarativeNetRequest rules: block, allow, redirect to Shield's own harmless stand-ins ($redirect), strip
//     tracking parameters ($removeparam), add a Content-Security-Policy ($csp), block pop-up ad hosts ($popup)
//   - cosmetic filters: CSS to hide ad boxes (generic, per site, exceptions), procedural filters (:has-text, :upward...)
//     compiled to small JSON programs for the cosmetic content script, and uBO scriptlets (##+js(...)).
// The approach follows uBlock Origin Lite (https://github.com/uBlockOrigin/uBOL-home); the code is Hallow Shield's own.
// Anything that can't be expressed is counted and skipped, never half-converted.

// rule priorities: higher wins; at equal priority the browser prefers allow > allowAllRequests > block > redirect
export const PRI = { modify: 5, block: 10, redirect: 11, allow: 20, important: 30, importantRedirect: 31, pause: 1000 };

const TYPES = { script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
  subdocument: 'sub_frame', frame: 'sub_frame', media: 'media', font: 'font', object: 'object', 'object-subrequest': 'object',
  ping: 'ping', beacon: 'ping', websocket: 'websocket', other: 'other' };
export const ALL_SUB = ['script', 'image', 'stylesheet', 'xmlhttprequest', 'sub_frame', 'media', 'font', 'object', 'ping', 'websocket', 'other'];

// uBO redirect resource names -> Shield's own stand-ins in extension/web/
export const REDIRECTS = {
  'noop.js': 'noop.js', noopjs: 'noop.js', 'noop.html': 'noop.html', noopframe: 'noop.html', 'noop.txt': 'noop.txt', nooptext: 'noop.txt',
  'noop.json': 'noop.json', noopjson: 'noop.json', 'noop.css': 'noop.css', noopcss: 'noop.css',
  '1x1.gif': '1x1.gif', '1x1-transparent.gif': '1x1.gif', '2x2.png': '2x2.png', '2x2-transparent.png': '2x2.png',
  '3x2.png': '3x2.png', '3x2-transparent.png': '3x2.png', '32x32.png': '32x32.png', '32x32-transparent.png': '32x32.png',
  'noop-vmap1.xml': 'noop-vmap1.xml', 'noop-vmap1.0.xml': 'noop-vmap1.xml', 'noopvmap-1.0': 'noop-vmap1.xml',
  'google-analytics_analytics.js': 'google-analytics_analytics.js', 'google-analytics.com/analytics.js': 'google-analytics_analytics.js',
  'googletagmanager_gtm.js': 'googletagmanager_gtm.js', 'googletagmanager.com/gtm.js': 'googletagmanager_gtm.js',
  'google-analytics_ga.js': 'google-analytics_ga.js', 'google-analytics.com/ga.js': 'google-analytics_ga.js',
  'googlesyndication_adsbygoogle.js': 'googlesyndication_adsbygoogle.js', 'googlesyndication.com/adsbygoogle.js': 'googlesyndication_adsbygoogle.js',
  'googletagservices_gpt.js': 'googletagservices_gpt.js', 'googletagservices.com/gpt.js': 'googletagservices_gpt.js',
  'amazon_apstag.js': 'amazon_apstag.js', 'amazon-adsystem.com/aax2/apstag.js': 'amazon_apstag.js',
  'scorecardresearch_beacon.js': 'scorecardresearch_beacon.js', 'scorecardresearch.com/beacon.js': 'scorecardresearch_beacon.js',
  'fuckadblock.js-3.2.0': 'fuckadblock.js', 'fuckadblock.js': 'fuckadblock.js', 'nobab.js': 'fuckadblock.js',
};
export const REDIRECT_FILES = [...new Set(Object.values(REDIRECTS))];

const isAscii = s => /^[\x20-\x7e]*$/.test(s);
const domainOk = d => /^[a-z0-9_.-]+$/.test(d) && d.includes('.') && !d.startsWith('.') && !d.endsWith('.') && !d.includes('..');
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

// "a|~b|c" -> { inc, exc }; null when something can't be expressed (entities like google.* unless allowed, regex)
export function parseDomains(v, sep = '|', { entities = false } = {}) {
  const inc = [], exc = [];
  for (let d of v.split(sep)) {
    d = d.trim().toLowerCase(); if (!d) continue;
    const neg = d.startsWith('~'); if (neg) d = d.slice(1);
    if (d.endsWith('.*')) { if (!entities || !domainOk(d.slice(0, -2) + '.x')) return null; (neg ? exc : inc).push(d); continue; }
    if (!domainOk(d)) return null;
    (neg ? exc : inc).push(d);
  }
  return { inc, exc };
}

// split a filter's options on commas that aren't escaped (uBO writes \, inside values)
function splitOptions(s) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === ',') { cur += ','; i++; continue; }
    if (s[i] === ',') { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur); return out.map(x => x.trim()).filter(Boolean);
}
// pattern and options: the options start at the last "$" that isn't inside a regex body
// (the rightmost "$" followed by something shaped like an option: "/ad.js$xhr,replace=/a/b/" is not a regex filter,
// "/^https:\/\/x\/$/" is one, "/x$/$script" is a regex with options)
function splitFilter(text) {
  for (let i = text.lastIndexOf('$'); i >= 0; i = i > 0 ? text.lastIndexOf('$', i - 1) : -1) {
    if (/^~?[a-z0-9_-]+(?:=|,|$)/i.test(text.slice(i + 1))) return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, ''];
}
// a filter as text, normalized, so $badfilter can name it: options lowercased and sorted, the badfilter option removed
export function filterKey(line) {
  const [pat, opts] = splitFilter(line.trim());
  const o = splitOptions(opts).map(x => x.toLowerCase()).filter(x => x !== 'badfilter')
    .map(x => /^(domain|from|to|denyallow)=/.test(x) ? x.split('=')[0] + '=' + x.slice(x.indexOf('=') + 1).split('|').sort().join('|') : x).sort();
  return pat + (o.length ? '$' + o.join(',') : '');
}
// RE2 (what the browser's regexFilter uses) has no look-around and no back-references
export const re2ok = re => !/\(\?<?[=!]|\\[1-9]|\(\?<[a-zA-Z]/.test(re) && re.length <= 1000 && isAscii(re);

// one network filter -> { rule, kind } (rule without id) | { skip } | { cosmeticException } | { badfilter }
export function networkRule(line) {
  let allow = false, text = line.trim();
  if (text.startsWith('@@')) { allow = true; text = text.slice(2); }
  let [pattern, opts] = splitFilter(text);
  const cond = {};
  const types = [], notTypes = [];
  let mainFrame = false, important = false, popup = false, redirect = null, redirectRule = false, removeparam = null, csp = null,
    cosmeticEx = null, badfilter = false, documentAllow = false, allTypes = false;
  for (const raw of splitOptions(opts)) {
    const o = raw.toLowerCase();
    const neg = o.startsWith('~'), name = (neg ? o.slice(1) : o).split('=')[0], value = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : null;
    switch (name) {
      case 'domain': case 'from': {
        if (value && value.includes('/')) return { skip: 'domain regex' };
        const d = parseDomains(value || ''); if (!d) return { skip: 'domain wildcard' };
        if (d.inc.length) cond.initiatorDomains = d.inc; if (d.exc.length) cond.excludedInitiatorDomains = d.exc; continue;
      }
      case 'to': {
        const d = parseDomains(value || ''); if (!d) return { skip: 'to wildcard' };
        if (d.inc.length) cond.requestDomains = d.inc; if (d.exc.length) cond.excludedRequestDomains = d.exc; continue;
      }
      case 'denyallow': {
        const d = parseDomains(value || ''); if (!d || d.exc.length) return { skip: 'denyallow wildcard' };
        cond.excludedRequestDomains = [...(cond.excludedRequestDomains || []), ...d.inc]; continue;
      }
      case 'method': {
        const inc = [], exc = [];
        for (const m of (value || '').toLowerCase().split('|')) { if (!m) continue; (m.startsWith('~') ? exc : inc).push(m.replace(/^~/, '')); }
        const okM = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'];
        if ([...inc, ...exc].some(m => !okM.includes(m))) return { skip: 'method' };
        if (inc.length) cond.requestMethods = inc; if (exc.length) cond.excludedRequestMethods = exc; continue;
      }
      case 'third-party': case '3p': case 'strict3p': cond.domainType = neg ? 'firstParty' : 'thirdParty'; continue;
      case 'first-party': case '1p': case 'strict1p': cond.domainType = neg ? 'thirdParty' : 'firstParty'; continue;
      case 'match-case': cond.isUrlFilterCaseSensitive = true; continue;
      case 'important': important = true; continue;
      case 'badfilter': badfilter = true; continue;
      case '_': case '__': case '___': continue;   // uBO's "no-op" option
      case 'all': allTypes = true; continue;
      case 'document': case 'doc':
        if (neg) { notTypes.push('main_frame'); continue; }
        if (allow) documentAllow = true; else mainFrame = true; continue;
      case 'popup': if (allow) return { skip: 'popup exception' }; popup = true; continue;
      case 'elemhide': case 'ehide': case 'generichide': case 'ghide': case 'specifichide': case 'shide':
        if (!allow) return { skip: 'option ' + name };
        cosmeticEx = { elemhide: 'elemhide', ehide: 'elemhide', generichide: 'generichide', ghide: 'generichide', specifichide: 'specifichide', shide: 'specifichide' }[name]; continue;
      case 'redirect': case 'redirect-rule': {
        if (allow) return { skip: 'redirect exception' };
        const res = (value || '').replace(/:\d+$/, '').trim();
        if (!REDIRECTS[res]) return { skip: 'redirect ' + (res || '?') };
        redirect = REDIRECTS[res]; redirectRule = name === 'redirect-rule'; continue;
      }
      case 'empty': if (allow) return { skip: 'empty exception' }; redirect = 'noop.txt'; continue;
      case 'removeparam': case 'queryprune': {
        if (allow) return { skip: 'removeparam exception' };
        if (value && (value.startsWith('/') || value.startsWith('~') || value.includes('|'))) return { skip: 'removeparam regex' };
        removeparam = value || ''; continue;
      }
      case 'csp': if (allow) return { skip: 'csp exception' }; if (!value) return { skip: 'csp empty' }; if (!isAscii(value)) return { skip: 'csp non-ascii' }; csp = value; continue;
      case 'inline-script': if (allow || neg) return { skip: 'inline-script exception' }; csp = "script-src 'unsafe-eval' * blob: data:"; continue;
      default:
        if (TYPES[name]) { (neg ? notTypes : types).push(TYPES[name]); continue; }
        if (name === 'webrtc') return { skip: 'webrtc' };
        return { skip: 'option ' + name };   // header, permissions, replace, urlskip, cname, ipaddress, genericblock, mp4, ...
    }
  }
  if (badfilter) return { badfilter: filterKey(line) };

  // the address pattern
  if (/^\/.+\/$/.test(pattern)) {
    const re = pattern.slice(1, -1);
    if (!re2ok(re)) return { skip: 'regex unsupported' };
    cond.regexFilter = re;
  } else {
    if (!isAscii(pattern)) return { skip: 'non-ascii' };
    if (HOSTNAME.test(pattern.toLowerCase()) && !IPV4.test(pattern)) pattern = '||' + pattern.toLowerCase() + '^';   // uBO: a bare hostname means ||host^
    if (!pattern.startsWith('|')) pattern = pattern.replace(/^\*+/, '');
    if (pattern.startsWith('||*')) pattern = pattern.slice(3).replace(/^\*+/, '');
    if (pattern.endsWith('*') && !pattern.endsWith('|*')) pattern = pattern.replace(/\*+$/, '');
    if (pattern.includes('|') && !/^\|\|?[^|]*\|?$/.test(pattern)) return { skip: 'pipe inside' };
    if (pattern === '||' || pattern === '|') pattern = '';
    if (pattern) cond.urlFilter = pattern;
  }
  const scoped = !!(cond.initiatorDomains || cond.requestDomains);
  const f = cond.urlFilter || '';
  const hostOf = () => { const m = f.match(/^\|\|([a-z0-9.-]+)\^?\|?$/i); return m ? m[1].toLowerCase() : null; };
  if (cosmeticEx) {
    // @@||site^$generichide etc: the hostnames it names (from ||host^ or domain=)
    const h = hostOf();
    const doms = h ? [h] : (!f && cond.initiatorDomains) ? cond.initiatorDomains : null;
    return doms ? { cosmeticException: { type: cosmeticEx, domains: doms } } : { skip: 'cosmetic exception not by host' };
  }
  if (!cond.urlFilter && !cond.regexFilter && !scoped && removeparam === null) return { skip: 'too broad' };
  if (cond.urlFilter && f.replace(/[|^*]/g, '').length < 3 && !scoped) return { skip: 'too broad' };

  // $document exception: everything a matching page loads is allowed (and its ad boxes stay)
  if (documentAllow) {
    const h = hostOf();
    return { rule: { priority: PRI.allow, action: { type: 'allowAllRequests' }, condition: { ...cond, resourceTypes: ['main_frame', 'sub_frame'] } }, kind: 'allowAll', elemhide: h ? [h] : null };
  }
  let rt;
  if (allTypes) rt = [...ALL_SUB, 'main_frame'];
  else if (types.length || mainFrame) rt = [...new Set([...types, ...(mainFrame ? ['main_frame'] : [])])];
  else if (notTypes.length) rt = ALL_SUB.filter(t => !notTypes.includes(t));
  else rt = null;
  if (rt && notTypes.length) rt = rt.filter(t => !notTypes.includes(t));
  if (rt && !rt.length) return { skip: 'no types left' };

  if (removeparam !== null) {
    if (popup || redirect || csp) return { skip: 'removeparam combined' };
    const action = { type: 'redirect', redirect: { transform: removeparam ? { queryTransform: { removeParams: [removeparam] } } : { query: '' } } };
    return { rule: { priority: PRI.modify, action, condition: { ...cond, resourceTypes: rt || ['main_frame', 'sub_frame', 'xmlhttprequest'] } }, kind: 'modify' };
  }
  if (csp !== null) {
    const action = { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: csp }] };
    const t = rt ? rt.filter(x => x === 'main_frame' || x === 'sub_frame') : ['main_frame', 'sub_frame'];
    if (!t.length) return { skip: 'csp types' };
    return { rule: { priority: PRI.modify, action, condition: { ...cond, resourceTypes: t } }, kind: 'modify' };
  }
  if (popup && !types.length && !allTypes && !mainFrame) {
    // the browser can't tell a pop-up from any other new page: only whole ad hosts, only when opened from another site
    if (!hostOf() || cond.initiatorDomains) return { skip: 'popup not a host' };
    return { rule: { priority: important ? PRI.important : PRI.block, action: { type: 'block' }, condition: { ...cond, domainType: 'thirdParty', resourceTypes: ['main_frame'] } }, kind: 'popup' };
  }
  if (!rt) rt = ALL_SUB;   // never the page you're opening, only what it loads (unless the filter says $document / $all)
  if (redirect) {
    // $redirect-rule only applies where something else blocks: kept only for filters on a named host (which the lists block anyway)
    if (redirectRule && !/^\|\|[a-z0-9.-]+[/^]/i.test(f)) return { skip: 'redirect-rule broad' };
    const t = rt.filter(x => x !== 'main_frame');
    if (!t.length) return { skip: 'redirect types' };
    return { rule: { priority: important ? PRI.importantRedirect : PRI.redirect, action: { type: 'redirect', redirect: { extensionPath: '/web/' + redirect } }, condition: { ...cond, resourceTypes: t } }, kind: 'redirect' };
  }
  if (allow) return { rule: { priority: PRI.allow, action: { type: 'allow' }, condition: { ...cond, resourceTypes: rt } }, kind: 'allow' };
  return { rule: { priority: important ? PRI.important : PRI.block, action: { type: 'block' }, condition: { ...cond, resourceTypes: rt } }, kind: 'block' };
}

// ---------- cosmetic filters ----------

const PROC_OPS = ['has-text', '-abp-contains', 'contains', '-abp-has', 'has', 'not', 'if', 'if-not', 'upward', 'nth-ancestor', 'remove', 'remove-attr', 'remove-class',
  'matches-css', 'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path', 'matches-media', 'min-text-length', 'xpath', 'style', 'watch-attr', 'others', 'matches-prop'];
const OP_RE = new RegExp(`^:(${PROC_OPS.map(o => o.replace(/-/g, '\\-')).sort((a, b) => b.length - a.length).join('|')})\\(`);
const TEXTY = new Set(['has-text', 'contains', '-abp-contains', 'xpath', 'matches-path', 'matches-attr', 'matches-css', 'matches-css-before', 'matches-css-after']);

// split a selector at its procedural operators: [{ css }, { op, arg }, { css }, ...]; null if parentheses don't balance
function splitOps(sel) {
  const parts = []; let css = '', i = 0, quote = null, brackets = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (quote) { css += ch; if (ch === '\\') { css += sel[i + 1] || ''; i += 2; continue; } if (ch === quote) quote = null; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; css += ch; i++; continue; }
    if (ch === '[') brackets++; if (ch === ']') brackets--;
    const m = ch === ':' && brackets === 0 && sel.slice(i).match(OP_RE);
    if (m) {
      // the matching ")" (backslash escapes respected; quotes too, except in text/regex arguments)
      let depth = 1, j = i + m[0].length, q = null;
      for (; j < sel.length && depth; j++) {
        const c = sel[j];
        if (c === '\\') { j++; continue; }
        if (q) { if (c === q) q = null; continue; }
        if ((c === '"' || c === "'") && !TEXTY.has(m[1])) { q = c; continue; }
        if (c === '(') depth++; else if (c === ')') depth--;
      }
      if (depth) return null;
      const arg = sel.slice(i + m[0].length, j - 1), op = m[1];
      // :has() / :not() with plain CSS inside stays CSS (the browser does it natively)
      if ((op === 'has' || op === 'not') && !hasProcedural(arg)) { css += sel.slice(i, j); i = j; continue; }
      if (css) parts.push({ css }); css = '';
      parts.push({ op, arg }); i = j; continue;
    }
    css += ch; i++;
  }
  if (quote || brackets) return null;
  if (css) parts.push({ css });
  return parts;
}
export function hasProcedural(sel) {
  const parts = splitOps(sel);
  return !parts || parts.some(p => p.op);
}
// compile a procedural selector into a small program for extension/cosmetic.js:
//   { s: 'css to start from' (or ''), t: [[op, ...args], ...], a: [action, arg] }   or { skip }
export function compileProcedural(sel, nested = false) {
  sel = sel.trim().replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(');
  const parts = splitOps(sel);
  if (!parts) return { skip: 'procedural syntax' };
  const out = { s: '', t: [] };
  let action = null, bad = null;
  parts.forEach((p, k) => {
    if (bad) return;
    if (action) { if (p.css === undefined || p.css.trim()) bad = 'procedural action not last'; return; }
    if (p.css !== undefined) { if (k === 0) out.s = p.css.trim(); else out.t.push(['spath', p.css]); return; }
    const { op, arg } = p;
    switch (op) {
      case 'has': case 'if': case 'not': case 'if-not': {
        const sub = compileProcedural(arg, true);
        if (sub.skip) { bad = sub.skip; return; }
        out.t.push([op === 'has' || op === 'if' ? 'has' : 'not', sub]); return;
      }
      case 'has-text': case 'contains': case '-abp-contains': out.t.push(['text', arg]); return;
      case 'upward': case 'nth-ancestor': {
        const n = Number(arg);
        if (arg.trim() && Number.isInteger(n)) { if (n < 1 || n > 256) { bad = 'upward range'; return; } out.t.push(['up', n]); }
        else if (op === 'upward' && arg.trim()) out.t.push(['up', arg.trim()]);
        else bad = 'upward arg';
        return;
      }
      case 'matches-css': case 'matches-css-before': case 'matches-css-after': {
        const c = arg.indexOf(':'); if (c < 1) { bad = 'matches-css arg'; return; }
        out.t.push(['css', op === 'matches-css' ? null : op.endsWith('before') ? '::before' : '::after', arg.slice(0, c).trim(), arg.slice(c + 1).trim()]); return;
      }
      case 'matches-attr': {
        const m = arg.match(/^\s*("?)(.*?)\1\s*(?:=\s*("?)(.*)\3)?\s*$/);
        out.t.push(['attr', m ? m[2] : arg, m && m[4] !== undefined ? m[4] : null]); return;
      }
      case 'matches-path': out.t.push(['path', arg]); return;
      case 'matches-media': out.t.push(['media', arg]); return;
      case 'min-text-length': { const n = Number(arg); if (!Number.isInteger(n)) { bad = 'min-text-length arg'; return; } out.t.push(['minlen', n]); return; }
      case 'xpath': out.t.push(['xpath', arg]); return;
      case 'watch-attr': return;   // Shield re-checks on every DOM change anyway
      case 'remove': if (arg.trim()) { bad = 'remove arg'; return; } action = ['remove']; return;
      case 'style': if (!arg.trim() || /url\(|expression|@import|\\|[{}]/i.test(arg)) { bad = 'style unsafe'; return; } action = ['style', arg.trim()]; return;
      case 'remove-attr': action = ['ra', arg.trim()]; return;
      case 'remove-class': action = ['rc', arg.trim()]; return;
      default: bad = 'procedural ' + op;
    }
  });
  if (bad) return { skip: bad };
  if (action) { if (nested) return { skip: 'procedural action nested' }; out.a = action; }
  if (!nested && !out.s && !out.t.length) return { skip: 'procedural empty' };
  if (!nested && !out.s && !['xpath', 'path', 'media'].includes(out.t[0][0])) return { skip: 'procedural no base' };
  return out;
}

// uBO scriptlet names and their aliases -> Shield's canonical name (implemented in tools/scriptlets.mjs)
export const SCRIPTLET_ALIASES = {
  'set': 'set-constant', 'set-constant': 'set-constant', 'trusted-set': 'trusted-set-constant', 'trusted-set-constant': 'trusted-set-constant',
  aopr: 'abort-on-property-read', 'abort-on-property-read': 'abort-on-property-read', aopw: 'abort-on-property-write', 'abort-on-property-write': 'abort-on-property-write',
  acs: 'abort-current-script', acis: 'abort-current-script', 'abort-current-script': 'abort-current-script', 'abort-current-inline-script': 'abort-current-script',
  aost: 'abort-on-stack-trace', 'abort-on-stack-trace': 'abort-on-stack-trace',
  'json-prune': 'json-prune', jpfr: 'json-prune-fetch-response', 'json-prune-fetch-response': 'json-prune-fetch-response', jpxr: 'json-prune-xhr-response', 'json-prune-xhr-response': 'json-prune-xhr-response',
  'no-fetch-if': 'prevent-fetch', 'prevent-fetch': 'prevent-fetch', 'no-xhr-if': 'prevent-xhr', 'prevent-xhr': 'prevent-xhr',
  nostif: 'prevent-setTimeout', 'no-setTimeout-if': 'prevent-setTimeout', 'prevent-setTimeout': 'prevent-setTimeout', 'setTimeout-defuser': 'prevent-setTimeout',
  nosiif: 'prevent-setInterval', 'no-setInterval-if': 'prevent-setInterval', 'prevent-setInterval': 'prevent-setInterval', 'setInterval-defuser': 'prevent-setInterval',
  ra: 'remove-attr', 'remove-attr': 'remove-attr', rc: 'remove-class', 'remove-class': 'remove-class',
  'trusted-rpfr': 'trusted-replace-fetch-response', 'trusted-replace-fetch-response': 'trusted-replace-fetch-response',
  'trusted-rpxr': 'trusted-replace-xhr-response', 'trusted-replace-xhr-response': 'trusted-replace-xhr-response',
  nowoif: 'no-window-open-if', 'no-window-open-if': 'no-window-open-if', 'prevent-window-open': 'no-window-open-if', 'window.open-defuser': 'no-window-open-if',
  aeld: 'addEventListener-defuser', 'addEventListener-defuser': 'addEventListener-defuser', 'prevent-addEventListener': 'addEventListener-defuser',
  'nano-sib': 'adjust-setInterval', 'nano-setInterval-booster': 'adjust-setInterval', 'adjust-setInterval': 'adjust-setInterval',
  'nano-stb': 'adjust-setTimeout', 'nano-setTimeout-booster': 'adjust-setTimeout', 'adjust-setTimeout': 'adjust-setTimeout',
  rmnt: 'remove-node-text', 'remove-node-text': 'remove-node-text',
  'set-cookie': 'set-cookie', 'set-local-storage-item': 'set-local-storage-item', 'set-session-storage-item': 'set-session-storage-item',
  'remove-cookie': 'remove-cookie', 'cookie-remover': 'remove-cookie',
  norafif: 'prevent-requestAnimationFrame', 'no-requestAnimationFrame-if': 'prevent-requestAnimationFrame', 'prevent-requestAnimationFrame': 'prevent-requestAnimationFrame',
  'noeval-if': 'noeval-if', 'prevent-eval-if': 'noeval-if', noeval: 'noeval-if', 'silent-noeval': 'noeval-if',
  rpnt: 'trusted-replace-node-text', 'replace-node-text': 'trusted-replace-node-text', 'trusted-rpnt': 'trusted-replace-node-text', 'trusted-replace-node-text': 'trusted-replace-node-text',
  nowebrtc: 'nowebrtc', nofab: 'prevent-fab', 'prevent-fab': 'prevent-fab', 'fuckadblock.js-3.2.0': 'prevent-fab',
  'set-attr': 'set-attr', 'trusted-set-attr': 'trusted-set-attr', 'trusted-set-cookie': 'trusted-set-cookie',
  'trusted-set-local-storage-item': 'trusted-set-local-storage-item', 'trusted-set-session-storage-item': 'trusted-set-session-storage-item',
  'trusted-prevent-fetch': 'prevent-fetch', 'trusted-prevent-xhr': 'prevent-xhr',
  'window-close-if': 'window-close-if', 'close-window': 'window-close-if', 'alert-buster': 'alert-buster',
};

// scriptlet arguments: comma separated, "\," is a literal comma, an argument may be quoted
export function splitArgs(s) {
  const out = []; let i = 0;
  while (i <= s.length) {
    while (s[i] === ' ') i++;
    const q = s[i];
    if (q === '"' || q === "'" || q === '`') {
      // a quoted argument: up to the matching quote, if only spaces follow before the next comma (or the end)
      let j = i + 1, v = '';
      for (; j < s.length; j++) { if (s[j] === '\\' && s[j + 1] === q) { v += q; j++; continue; } if (s[j] === q) break; v += s[j]; }
      let k = j + 1; while (s[k] === ' ') k++;
      if (j < s.length && (k >= s.length || s[k] === ',')) { out.push(v); i = k + 1; if (k >= s.length) break; continue; }
    }
    let v = '';
    for (; i < s.length; i++) { if (s[i] === '\\' && s[i + 1] === ',') { v += ','; i++; continue; } if (s[i] === ',') break; v += s[i]; }
    out.push(v.trim()); i++;
    if (i > s.length) break;
  }
  return out;
}

// one cosmetic filter -> { kind: 'hide'|'style'|'procedural'|'scriptlet', inc, exc, exception, ... } | { skip } | null (not cosmetic)
export function cosmeticRule(line) {
  const m = line.match(/^([^#]*)#(@?)([?$%]?)#(.*)$/s);
  if (!m) return null;
  const [, doms, at, kindCh, body] = m;
  if (/^\/.*\/$/.test(doms.trim())) return { skip: 'cosmetic regex domain' };
  if (/[/|^$=?&]/.test(doms)) return null;   // "#" inside a network filter, not a cosmetic one
  const d = doms.trim() && doms.trim() !== '*' ? parseDomains(doms, ',', { entities: true }) : { inc: [], exc: [] };
  if (!d) return { skip: 'cosmetic domain' };
  const exception = !!at, base = { inc: d.inc, exc: d.exc, exception };
  if (kindCh === '$' || kindCh === '%') return { skip: kindCh === '$' ? 'adguard css' : 'adguard js' };
  let sel = body.trim();
  if (!sel) return { skip: 'cosmetic empty' };
  if (sel.startsWith('^')) return { skip: 'html filter' };
  if (sel.startsWith('+js(')) {
    if (!sel.endsWith(')')) return { skip: 'scriptlet syntax' };
    const inner = sel.slice(4, -1).trim();
    if (!inner) return exception ? { kind: 'scriptlet', ...base, name: '', canonical: '', args: [] } : { skip: 'scriptlet empty' };
    const args = splitArgs(inner);
    const name = args.shift().replace(/\.js$/, '');
    return { kind: 'scriptlet', ...base, name, canonical: SCRIPTLET_ALIASES[name] || null, args };
  }
  if (!isAscii(sel)) return { skip: 'non-ascii selector' };
  sel = sel.replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(');
  if (/[{}]|<\/?style/i.test(sel.replace(/:style\(.*\)$/s, ''))) return { skip: 'selector with braces' };
  if (!hasProcedural(sel)) return { kind: 'hide', ...base, selector: sel };
  // plain CSS + :style(...) at the end is just CSS
  const sm = sel.match(/^(.*?):style\((.*)\)$/s);
  if (sm && sm[1].trim() && !hasProcedural(sm[1])) {
    if (/url\(|expression|@import|\\|[{}]/i.test(sm[2])) return { skip: 'style unsafe' };
    return { kind: 'style', ...base, selector: sm[1].trim(), style: sm[2].trim() };
  }
  const prog = compileProcedural(sel);
  if (prog.skip) return { skip: prog.skip };
  return { kind: 'procedural', ...base, selector: sel, prog };
}

// ---------- whole lists ----------

// !#if / !#else / !#endif (uBO's preprocessor), answered with the env flags; !#include is resolved by the build before this
export function preprocess(text, env = {}) {
  const out = [], stack = [];
  const truth = expr => {
    const js = expr.replace(/[a-z_][a-z_0-9]*/gi, n => env[n] ? 'true' : 'false');
    if (!/^[\s()!&|a-z]*$/.test(js) || /[a-z]/.test(js.replace(/true|false/g, ''))) return false;
    try { return Function('return (' + js + ')')(); } catch { return false; }
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('!#if ')) { stack.push(truth(t.slice(5))); continue; }
    if (t === '!#else') { if (stack.length) stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
    if (t === '!#endif') { stack.pop(); continue; }
    if (stack.every(Boolean)) out.push(line);
  }
  return out.join('\n');
}

// the $badfilter keys of a list (they cancel filters in every list, as in uBO)
export function badfilters(text) {
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('!') || !/badfilter/.test(l) || cosmeticRule(l)) continue;
    const n = networkRule(l); if (n.badfilter) keys.add(n.badfilter);
  }
  return keys;
}

const score = r => {
  const c = r.condition, f = c.urlFilter || '';
  return (c.requestDomains ? 4 : 0) + (f.startsWith('||') ? 2 : 0) + (f.endsWith('^') ? 1 : 0) + (c.initiatorDomains ? 1 : 0);
};
const MERGE_CHUNK = 1000;

// a whole list -> { rules, popups, cosmetic, scriptlets, stats }
//   rules: DNR rules without ids, exceptions first, then header/parameter rules, then blocks and redirects
export function convertList(text, { maxRules = 30000, trusted = false, bad = new Set(), maxRegex = 1000 } = {}) {
  const stats = { lines: 0, network: 0, cosmetic: 0, scriptlets: 0, procedural: 0, skipped: {}, badfiltered: 0, merged: 0, regex: 0 };
  const skip = r => { stats.skipped[r] = (stats.skipped[r] || 0) + 1; };
  const allow = [], modify = [], block = [], popups = [];
  const cosmetic = { generic: new Set(), genericExcept: new Set(), specificGeneric: new Set(), hide: [], style: [], procedural: [], generichide: new Set(), elemhide: new Set(), specifichide: new Set() };
  const scriptlets = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); stats.lines++;
    if (!line || line.startsWith('!') || (line.startsWith('[') && line.endsWith(']'))) continue;
    const c = cosmeticRule(line);
    if (c) {
      if (c.skip) { skip(c.skip); continue; }
      stats.cosmetic++;
      const generic = !c.inc.length;
      if (c.kind === 'scriptlet') {
        if (generic && !c.exception) { skip('scriptlet generic'); continue; }
        if (!c.exception && !c.canonical) { skip('scriptlet ' + c.name); scriptlets.push({ ...c, unsupported: true }); continue; }
        if (c.canonical && c.canonical.startsWith('trusted-') && !trusted) { skip('trusted scriptlet from untrusted list'); continue; }
        stats.scriptlets++; scriptlets.push(c); continue;
      }
      if (c.kind === 'hide') {
        if (c.exception) { if (generic) cosmetic.genericExcept.add(c.selector); else cosmetic.hide.push(c); continue; }
        if (generic) {
          if (line.startsWith('*##')) cosmetic.specificGeneric.add(c.selector);
          else if (c.exc.length) { cosmetic.generic.add(c.selector); cosmetic.hide.push({ ...c, inc: c.exc, exc: [], exception: true }); }
          else cosmetic.generic.add(c.selector);
          continue;
        }
        cosmetic.hide.push(c); continue;
      }
      if (generic && !c.exception) { skip(c.kind + ' generic'); continue; }
      if (c.kind === 'style') { cosmetic.style.push(c); continue; }
      stats.procedural++; cosmetic.procedural.push(c); continue;
    }
    const n = networkRule(line);
    if (n.badfilter) continue;
    if (n.skip) { skip(n.skip); continue; }
    if (bad.has(filterKey(line))) { stats.badfiltered++; continue; }
    if (n.cosmeticException) { for (const d of n.cosmeticException.domains) cosmetic[n.cosmeticException.type].add(d); continue; }
    stats.network++;
    if (n.elemhide) for (const d of n.elemhide) cosmetic.elemhide.add(d);
    if (n.kind === 'popup') { popups.push(n.rule); continue; }
    (n.kind === 'allow' || n.kind === 'allowAll' ? allow : n.kind === 'modify' ? modify : block).push(n.rule);
  }
  // regex rules are scarce (the browser allows 1,000 in all): keep the first ones the list names, up to maxRegex
  let regexLeft = maxRegex;
  const keepRegex = r => { if (!r.condition.regexFilter) return true; if (regexLeft <= 0) { skip('regex over budget'); return false; } regexLeft--; stats.regex++; return true; };
  const A = merge(allow, stats).filter(keepRegex), M = mergeParams(merge(modify, stats)).filter(keepRegex), B = merge(block, stats);
  B.sort((a, b) => score(b) - score(a));
  let rules = [...A, ...M, ...B.filter(keepRegex)];
  stats.dropped = Math.max(0, rules.length - maxRules);
  rules = rules.slice(0, maxRules);
  stats.allow = Math.min(A.length, rules.length); stats.modify = Math.max(0, Math.min(M.length, rules.length - A.length));
  stats.rules = rules.length;
  return { rules, popups: merge(popups, stats), cosmetic, scriptlets, stats };
}
// identical rules apart from the host of a plain "||host^" filter -> one rule with requestDomains (as uBO Lite does)
export function merge(rules, stats = { merged: 0 }) {
  const out = [], groups = new Map(), seen = new Set();
  for (const r of rules) {
    const sig = JSON.stringify(r); if (seen.has(sig)) { stats.merged++; continue; } seen.add(sig);
    const m = r.condition.urlFilter && !r.condition.requestDomains && r.condition.urlFilter.match(/^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^$/i);
    if (!m || IPV4.test(m[1]) || r.condition.isUrlFilterCaseSensitive) { out.push(r); continue; }
    const { urlFilter, ...rest } = r.condition;
    const key = JSON.stringify({ ...r, condition: rest });
    if (!groups.has(key)) { const g = { r: { ...r, condition: rest }, hosts: [] }; groups.set(key, g); out.push(g); }
    groups.get(key).hosts.push(m[1].toLowerCase());
  }
  return out.flatMap(x => {
    if (!x.hosts) return [x];
    const set = new Set(x.hosts);
    // a host already covered by its parent domain in the same group adds nothing
    const min = [...set].filter(h => { const p = h.split('.'); for (let i = 1; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return false; return true; }).sort();
    if (min.length === 1) return [{ ...x.r, condition: { urlFilter: '||' + min[0] + '^', ...x.r.condition } }];
    const chunks = [];
    for (let i = 0; i < min.length; i += MERGE_CHUNK) chunks.push({ ...x.r, condition: { requestDomains: min.slice(i, i + MERGE_CHUNK), ...x.r.condition } });
    stats.merged += x.hosts.length - chunks.length;
    return chunks;
  });
}
// $removeparam filters with the same conditions -> one rule removing all their parameters (one redirect per request)
function mergeParams(rules) {
  const out = [], groups = new Map();
  for (const r of rules) {
    const qt = r.action.redirect?.transform?.queryTransform;
    if (!qt) { out.push(r); continue; }
    const key = JSON.stringify([r.priority, r.condition]);
    if (!groups.has(key)) { const g = structuredClone(r); groups.set(key, g); out.push(g); }
    else { const p = groups.get(key).action.redirect.transform.queryTransform.removeParams; for (const x of qt.removeParams) if (!p.includes(x)) p.push(x); }
  }
  return out;
}

// structural check of a DNR rule (what Chrome would refuse to load)
export function validRule(r) {
  if (!Number.isInteger(r.id) || r.id < 1) return false;
  const a = r.action?.type;
  if (!['block', 'allow', 'allowAllRequests', 'redirect', 'modifyHeaders'].includes(a)) return false;
  const c = r.condition; if (!c) return false;
  if (c.urlFilter !== undefined && (typeof c.urlFilter !== 'string' || !c.urlFilter || !isAscii(c.urlFilter) || c.urlFilter.startsWith('||*'))) return false;
  if (c.urlFilter && c.regexFilter) return false;
  if (c.regexFilter !== undefined && (typeof c.regexFilter !== 'string' || !c.regexFilter)) return false;
  if (!Array.isArray(c.resourceTypes) || !c.resourceTypes.length) return false;
  if (a === 'allowAllRequests' && c.resourceTypes.some(t => t !== 'main_frame' && t !== 'sub_frame')) return false;
  if (a === 'redirect') { const rd = r.action.redirect; if (!rd || !(rd.extensionPath || rd.transform)) return false; if (rd.extensionPath && !rd.extensionPath.startsWith('/')) return false; }
  if (a === 'modifyHeaders' && !(r.action.responseHeaders?.length || r.action.requestHeaders?.length)) return false;
  for (const k of ['requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains']) if (c[k] && (!Array.isArray(c[k]) || !c[k].length || c[k].some(d => !d || !isAscii(d)))) return false;
  return true;
}
