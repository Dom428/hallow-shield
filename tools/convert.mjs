// Hallow Shield: turns Adblock Plus-style filter lists (EasyList, EasyPrivacy) into
//   - declarativeNetRequest rules (the browser blocks requests itself; the extension never sees them)
//   - cosmetic rules: CSS selectors to hide ad boxes, for every site ("generic") or for named sites
// Only what Manifest V3 can do safely is converted; anything else (regex filters, redirects, scriptlets, $csp, $popup,
// procedural cosmetics like #?# and #$#) is counted and skipped.

const TYPES = { script: 'script', image: 'image', stylesheet: 'stylesheet', xmlhttprequest: 'xmlhttprequest', subdocument: 'sub_frame',
  media: 'media', font: 'font', object: 'object', ping: 'ping', websocket: 'websocket', other: 'other', webrtc: 'webrtc' };
const ALL_SUB = ['script', 'image', 'stylesheet', 'xmlhttprequest', 'sub_frame', 'media', 'font', 'object', 'ping', 'websocket', 'other'];

const isAscii = s => /^[\x20-\x7e]*$/.test(s);
const domainOk = d => /^[a-z0-9.-]+$/.test(d) && d.includes('.') && !d.startsWith('.') && !d.endsWith('.');

function parseDomains(v) {
  const inc = [], exc = [];
  for (let d of v.split('|')) {
    d = d.trim().toLowerCase(); if (!d) continue;
    const neg = d.startsWith('~'); if (neg) d = d.slice(1);
    if (d.endsWith('.*')) return null;            // "example.*" can't be expressed
    if (!domainOk(d)) return null;
    (neg ? exc : inc).push(d);
  }
  return { inc, exc };
}

// one network filter -> one DNR rule (without id), or null with a reason
export function networkRule(line) {
  let allow = false, text = line;
  if (text.startsWith('@@')) { allow = true; text = text.slice(2); }
  let opts = '';
  const dollar = text.lastIndexOf('$');
  if (dollar >= 0 && !/^\/.*\/$/.test(text)) { opts = text.slice(dollar + 1); text = text.slice(0, dollar); }
  if (/^\/.*\/$/.test(text)) return { skip: 'regex' };
  if (!text || text === '*' || text.length < 4) return { skip: 'too broad' };
  if (!isAscii(text)) return { skip: 'non-ascii' };
  const cond = { urlFilter: text };
  const types = [], notTypes = [];
  let document = false, important = false;
  for (const raw of opts ? opts.split(',') : []) {
    const o = raw.trim().toLowerCase(); if (!o) continue;
    const neg = o.startsWith('~'), name = neg ? o.slice(1) : o;
    if (name.startsWith('domain=')) { const d = parseDomains(raw.trim().slice(7)); if (!d) return { skip: 'domain wildcard' }; if (d.inc.length) cond.initiatorDomains = d.inc; if (d.exc.length) cond.excludedInitiatorDomains = d.exc; continue; }
    if (name === 'third-party' || name === '3p') { cond.domainType = neg ? 'firstParty' : 'thirdParty'; continue; }
    if (name === 'first-party' || name === '1p') { cond.domainType = neg ? 'thirdParty' : 'firstParty'; continue; }
    if (name === 'match-case') { cond.isUrlFilterCaseSensitive = true; continue; }
    if (name === 'important') { important = true; continue; }
    if (name === 'document' && allow) { document = true; continue; }
    if (TYPES[name]) { (neg ? notTypes : types).push(TYPES[name]); continue; }
    return { skip: 'option ' + name.split('=')[0] };   // popup, csp, redirect, removeparam, generichide, ...
  }
  if (cond.urlFilter.includes('|') && !/^\|\|?[^|]*\|?$/.test(cond.urlFilter)) return { skip: 'pipe inside' };
  if (types.includes('webrtc')) return { skip: 'webrtc' };
  if (document) return { rule: { priority: 3, action: { type: 'allowAllRequests' }, condition: { ...cond, resourceTypes: ['main_frame', 'sub_frame'] } } };
  if (types.length) cond.resourceTypes = [...new Set(types)];
  else if (notTypes.length) { cond.resourceTypes = ALL_SUB.filter(t => !notTypes.includes(t)); if (!cond.resourceTypes.length) return { skip: 'no types left' }; }
  else cond.resourceTypes = ALL_SUB;               // never block the page you're opening, only what it loads
  return { rule: { priority: allow ? 2 : important ? 2 : 1, action: { type: allow ? 'allow' : 'block' }, condition: cond } };
}

// one cosmetic filter -> { generic | domains, exception, selector } or null
export function cosmeticRule(line) {
  const m = line.match(/^([^#]*)#(@?)#(.+)$/);
  if (!m) return null;
  const [, doms, at, sel] = m;
  if (/^[?$%]/.test(sel) || sel.includes('{') || sel.startsWith('+js(') || !isAscii(sel) || /:(-abp-|has-text|xpath|upward|remove|matches-css|style)/.test(sel)) return { skip: 'procedural' };
  const d = doms ? parseDomains(doms.replace(/,/g, '|')) : { inc: [], exc: [] };
  if (!d) return { skip: 'domain wildcard' };
  return { exception: !!at, selector: sel.trim(), inc: d.inc, exc: d.exc };
}

// a whole list -> { rules, cosmetic: { generic: [...], sites: { domain: [...] }, except: { domain: [...] } }, stats }
export function convertList(text, { maxRules = 30000 } = {}) {
  const block = [], allow = [], stats = { lines: 0, network: 0, cosmetic: 0, skipped: {} };
  const generic = new Set(), sites = {}, except = {};
  const skip = r => { stats.skipped[r] = (stats.skipped[r] || 0) + 1; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); stats.lines++;
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    if (/#@?#/.test(line)) {
      const c = cosmeticRule(line); if (!c || c.skip) { skip(c ? c.skip : 'cosmetic'); continue; }
      stats.cosmetic++;
      if (c.exception) { for (const d of c.inc) (except[d] ||= []).push(c.selector); continue; }
      if (!c.inc.length) { if (!c.exc.length) generic.add(c.selector); else for (const d of c.exc) (except[d] ||= []).push(c.selector), generic.add(c.selector); continue; }
      for (const d of c.inc) (sites[d] ||= []).push(c.selector);
      continue;
    }
    if (/#[?$%]#/.test(line)) { skip('procedural'); continue; }
    const n = networkRule(line); if (!n || n.skip) { skip(n ? n.skip : 'network'); continue; }
    stats.network++;
    (n.rule.action.type === 'block' ? block : allow).push(n.rule);
  }
  // Plain domain filters ("||ads.example^" with the same options) become ONE rule with a list of domains: lists hold tens
  // of thousands of them, and Chrome only guarantees 30,000 rules - one rule per domain would leave most ad servers out.
  const mergedAllow = mergeDomains(allow), mergedBlock = mergeDomains(block);
  // exceptions first so they always fit; then the domain lists; then the rest, the most specific (domain-anchored) first
  mergedBlock.rest.sort((a, b) => score(b) - score(a));
  const ordered = [...mergedAllow.merged, ...mergedAllow.rest, ...mergedBlock.merged, ...mergedBlock.rest];
  const rules = ordered.slice(0, maxRules).map((r, i) => ({ id: i + 1, ...r }));
  stats.dropped = ordered.length - rules.length;
  stats.rules = rules.length;
  stats.domainsMerged = mergedAllow.domains + mergedBlock.domains;
  return { rules, cosmetic: { generic: [...generic], sites, except }, stats };
}
const score = r => (r.condition.urlFilter.startsWith('||') ? 2 : 0) + (r.condition.urlFilter.endsWith('^') ? 1 : 0);

// "||example.com^" (or "^|") matches example.com and its subdomains - exactly what requestDomains does
const PLAIN = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^\|?$/;
export const DOMAINS_PER_RULE = 1000;
export function mergeDomains(list) {
  const groups = new Map(), rest = []; let domains = 0;
  for (const r of list) {
    const m = r.action.type !== 'allowAllRequests' && !r.condition.isUrlFilterCaseSensitive && r.condition.urlFilter.match(PLAIN);
    if (!m) { rest.push(r); continue; }
    const { urlFilter, ...cond } = r.condition;
    const key = JSON.stringify([r.priority, r.action, cond]);
    if (!groups.has(key)) groups.set(key, { priority: r.priority, action: r.action, cond, list: new Set() });
    groups.get(key).list.add(m[1]);
  }
  const merged = [];
  for (const g of groups.values()) {
    const all = [...g.list]; domains += all.length;
    for (let i = 0; i < all.length; i += DOMAINS_PER_RULE)
      merged.push({ priority: g.priority, action: g.action, condition: { ...g.cond, requestDomains: all.slice(i, i + DOMAINS_PER_RULE) } });
  }
  return { merged, rest, domains };
}

// structural check of a DNR rule (what Chrome would refuse to load)
export function validRule(r) {
  if (!Number.isInteger(r.id) || r.id < 1) return false;
  if (!['block', 'allow', 'allowAllRequests'].includes(r.action?.type)) return false;
  const c = r.condition; if (!c) return false;
  if (c.requestDomains !== undefined) { if (!Array.isArray(c.requestDomains) || !c.requestDomains.length || c.requestDomains.length > DOMAINS_PER_RULE || !c.requestDomains.every(domainOk) || c.urlFilter !== undefined) return false; }
  else { if (typeof c.urlFilter !== 'string' || !c.urlFilter || !isAscii(c.urlFilter) || c.urlFilter.startsWith('||*')) return false; }
  if (r.action.type === 'allowAllRequests' && c.resourceTypes.some(t => t !== 'main_frame' && t !== 'sub_frame')) return false;
  if (!Array.isArray(c.resourceTypes) || !c.resourceTypes.length) return false;
  return true;
}
