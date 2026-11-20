// Hallow Shield: a small model of how the browser matches one declarativeNetRequest rule against one request.
// Used by tools/explain.mjs ("which filters touch this address, and what became of them") and by the unit tests.
// It follows Chrome's documented urlFilter syntax: || (domain anchor), | (start/end), ^ (separator), * (anything).

const reCache = new Map();
export function urlFilterRegex(f, caseSensitive = false) {
  const key = f + (caseSensitive ? '\u0001' : '');
  if (reCache.has(key)) return reCache.get(key);
  let s = f, pre = '', post = '';
  if (s.startsWith('||')) { pre = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?'; s = s.slice(2); }
  else if (s.startsWith('|')) { pre = '^'; s = s.slice(1); }
  if (s.endsWith('|')) { post = '$'; s = s.slice(0, -1); }
  const body = s.split('').map(ch => ch === '*' ? '.*' : ch === '^' ? '(?:[^a-zA-Z0-9_.%-]|$)' : ch.replace(/[.+?${}()[\]\\/|]/g, '\\$&')).join('');
  const re = new RegExp(pre + body + post, caseSensitive ? '' : 'i');
  reCache.set(key, re);
  return re;
}
const onDomain = (host, list) => list.some(d => host === d || host.endsWith('.' + d));
// "a.b.example.co.uk" -> rough registrable domain (good enough for tests: last two labels, three for common 2nd-level ccTLDs)
export function site(host) {
  const p = host.split('.');
  const n = p.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? 3 : 2;
  return p.slice(-n).join('.');
}
// req: { url, type, initiator (page address or null), method }
export function ruleMatches(rule, req) {
  const c = rule.condition || {};
  const u = new URL(req.url), host = u.hostname.toLowerCase();
  const ini = req.initiator ? new URL(req.initiator).hostname.toLowerCase() : null;
  const types = c.resourceTypes || (rule.action.type === 'allowAllRequests' ? [] : ['main_frame', 'sub_frame', 'script', 'image', 'stylesheet', 'xmlhttprequest', 'media', 'font', 'object', 'ping', 'websocket', 'webtransport', 'webbundle', 'other'].filter(t => t !== 'main_frame'));
  if (!types.includes(req.type)) return false;
  if (c.excludedResourceTypes && c.excludedResourceTypes.includes(req.type)) return false;
  if (c.urlFilter && !urlFilterRegex(c.urlFilter, !!c.isUrlFilterCaseSensitive).test(req.url)) return false;
  if (c.regexFilter && !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i').test(req.url)) return false;
  if (c.requestDomains && !onDomain(host, c.requestDomains)) return false;
  if (c.excludedRequestDomains && onDomain(host, c.excludedRequestDomains)) return false;
  if (c.initiatorDomains && !(ini && onDomain(ini, c.initiatorDomains))) return false;
  if (c.excludedInitiatorDomains && ini && onDomain(ini, c.excludedInitiatorDomains)) return false;
  if (c.domainType) {
    const third = ini ? site(ini) !== site(host) : false;
    if ((c.domainType === 'thirdParty') !== third) return false;
  }
  if (c.requestMethods && !c.requestMethods.includes((req.method || 'get').toLowerCase())) return false;
  return true;
}
// the action the browser would take with these rules: highest priority wins; at equal priority
// allow > allowAllRequests > block > upgradeScheme > redirect (modifyHeaders are applied alongside, not modelled here)
const ORDER = { allow: 0, allowAllRequests: 1, block: 2, upgradeScheme: 3, redirect: 4, modifyHeaders: 5 };
export function decide(rules, req) {
  const hits = rules.filter(r => r.action.type !== 'modifyHeaders' && ruleMatches(r, req));
  hits.sort((a, b) => (b.priority || 1) - (a.priority || 1) || ORDER[a.action.type] - ORDER[b.action.type]);
  return hits[0] || null;
}
