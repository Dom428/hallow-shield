// Hallow Shield: small helpers shared by the background, the popup, the build and the tests.
// dynamic rule ids: 1.. the dynamic fallback (lists without room), PAUSE_BASE.. paused sites, USER_BASE.. My filters
export const PAUSE_BASE = 1000000;
export const USER_BASE = 2000000;
export const USER_MAX = 2000;        // network rules from My filters (dynamic rules; the fallback leaves room for them)
export const USER_REGEX_MAX = 50;
export const PAUSE_PRIORITY = 1000;   // above every list rule, $important included: a paused site gets everything
export const LEVELS = ['basic', 'optimal', 'complete'];
export const DEFAULT_LEVEL = 'optimal';
export const SHARDS = 32;

// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"]
export function hostsFor(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean); const o = [];
  for (let i = 0; i < parts.length - 1; i++) o.push(parts.slice(i).join('.'));
  return o;
}
// the keys cosmetic filters can be stored under for a host: its domains plus uBO "entities" ("google.*" for google.co.uk)
export function cosmeticKeys(host) {
  const p = String(host || '').toLowerCase().split('.').filter(Boolean), keys = hostsFor(host);
  for (let i = 0; i < p.length - 1; i++) if (p.length - i - 1 <= 2) keys.push(p[i] + '.*');
  return keys;
}
export function shardOf(key, n = SHARDS) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}
// the site from a page address, or null for pages Shield doesn't touch (browser pages, files)
export function siteOf(url) {
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return u.hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}
export const onList = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

// what Shield does on one site, from the cosmetic entries of its keys ({ h, x, s, p } per key, see tools/build.mjs):
//   { css, proc } - css for the browser to add, procedural programs for cosmetic.js
//   isGeneric(selector): is it one of the generic selectors (so a site exception must show it again)
export function siteCosmetics(entries, { specifichide = false, isGeneric = () => false } = {}) {
  const hide = [], style = [], proc = [], except = new Set();
  for (const e of entries) {
    if (!e) continue;
    if (e.x) for (const x of e.x) except.add(x);
    if (specifichide) continue;
    if (e.h) hide.push(...e.h);
    if (e.s) style.push(...e.s);
    if (e.p) proc.push(...e.p);
  }
  const lines = [...new Set(hide)].filter(s => !except.has(s)).map(s => `${s}{display:none!important}`);
  for (const [sel, st] of style) if (!except.has(`${sel}:style(${st})`)) lines.push(`${sel}{${st.split(';').map(d => d.trim()).filter(Boolean).map(d => d.replace(/\s*!important\s*$/, '') + '!important').join(';')}}`);
  for (const x of except) if (isGeneric(x)) lines.push(`${x}{display:revert!important}`);
  return { css: lines.join('\n'), proc: proc.filter(([sel]) => !except.has(sel)).map(([, prog]) => prog) };
}
export function pauseRule(domain, id) {
  return { id, priority: PAUSE_PRIORITY, action: { type: 'allowAllRequests' }, condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] } };
}
export const validDomain = d => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);
// match patterns for a site and its subdomains
export const patternsFor = domains => domains.filter(validDomain).map(d => `*://*.${d}/*`);
// the popup's group switches: cookie banners hidden unless switched off, other annoyances only when switched on
export const groupOn = (s, g) => g === 'main' || !g ? true : g === 'cookies' ? s.cookies !== false : g === 'annoyances' ? s.annoyances === true : false;
// which rulesets should be on: every list unless switched off in Advanced (a list in a group only while its group is
// on), plus strict pop-up blocking at "Complete"
export function wantedRulesets(s, listIds, groupOf = {}) {
  const on = listIds.filter(id => s.lists?.[id] !== false && groupOn(s, groupOf[id]));
  if (s.level === 'complete') on.push('popups');
  return on;
}
