// Hallow Shield: small helpers shared by the background, the popup, the build and the tests.
// dynamic rule ids: 1.. the dynamic fallback (lists without room), PAUSE_BASE.. paused sites, USER_BASE.. My filters,
// STRICT_BASE.. the extra rules for sites set to Strict
export const PAUSE_BASE = 1000000;
export const USER_BASE = 2000000;
export const STRICT_BASE = 3000000;
export const STRICT_MAX = 5000;      // dynamic rules for Strict sites (pop-up hosts + the annoyance lists' rules, limited to those sites)
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
// 1.5: the class or id a generic hiding selector starts with (".ad-box > a" or "div.ad-box" -> ".ad-box"), or null.
// Selectors with a token are only sent to a page that has that class / id (content.js reports them); the others stay
// in generic.css.
export function genericKey(sel) {
  if (sel.includes(',')) return null;
  const m = /^(?:[a-zA-Z][a-zA-Z0-9]*)?([.#])(-?[A-Za-z_][\w-]*)(?=$|[\s.#:[>+~])/.exec(sel);
  return m ? m[1] + m[2] : null;
}

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
// per-site mode: "off" (= paused), "strict" (Complete + annoyances on that site only), "normal" (the global settings),
// and since 1.5 the two in-between steps "Try fixing this site" can leave a site on: "nohide" (blocking and page fixes,
// no hiding) and "blockonly" (blocking only: no hiding, no page fixes, no cookie-banner clicks)
// storage key of each mode's site list
export const MODE_KEYS = { off: 'paused', strict: 'strict', nohide: 'noHide', blockonly: 'blockOnly' };
export function siteModeOf(s, host) {
  if (!host) return 'normal';
  if (onList(host, s.paused || [])) return 'off';
  if (onList(host, s.blockOnly || [])) return 'blockonly';
  if (onList(host, s.noHide || [])) return 'nohide';
  if (onList(host, s.strict || [])) return 'strict';
  return 'normal';
}
// the new site lists after choosing a mode for a site
export function withSiteMode(s, site, mode) {
  const out = {};
  for (const [m, k] of Object.entries(MODE_KEYS)) {
    const l = (s[k] || []).filter(d => d !== site);
    if (mode === m) l.push(site);
    out[k] = l.slice(-500);
  }
  return out;
}
// "Try fixing this site": the steps it goes through, mildest first, and what each one means
export const FIX_STEPS = ['normal', 'nohide', 'blockonly', 'off'];
export const MODE_LABEL = {
  strict: 'Strict', normal: 'Normal', off: 'Off (paused)',
  nohide: 'No hiding (blocking and page fixes only)', blockonly: 'Blocking only (no hiding, no page fixes)',
};
// the badge colour (the count on Shield's toolbar icon): follows the blocking level, or the site's own mode
export const BADGE_COLORS = { basic: '#5b6b85', optimal: '#f07820', complete: '#e0306a', strict: '#c0392b', nohide: '#5b6b85', blockonly: '#5b6b85', off: '#3a3248' };
export function badgeColor(level, mode = 'normal') {
  if (mode && mode !== 'normal' && BADGE_COLORS[mode]) return BADGE_COLORS[mode];
  return BADGE_COLORS[LEVELS.includes(level) ? level : DEFAULT_LEVEL];
}
const within = (a, b) => a === b || a.endsWith('.' + b);
// a list rule for Strict sites only: its initiator sites narrowed to those sites (null if it can't apply there, or is a
// kind that would eat into the browser's smaller budgets: regex, redirect, header rules)
export function strictRule(rule, sites, id) {
  const c = rule.condition || {}, t = rule.action && rule.action.type;
  if (!sites.length || c.regexFilter || !['block', 'allow', 'allowAllRequests', 'upgradeScheme'].includes(t)) return null;
  let init = sites;
  if (c.initiatorDomains) {
    init = [...new Set([...c.initiatorDomains.filter(d => sites.some(s => within(d, s))), ...sites.filter(s => c.initiatorDomains.some(d => within(s, d)))])];
    if (!init.length) return null;
  }
  if (c.excludedInitiatorDomains) init = init.filter(s => !c.excludedInitiatorDomains.some(d => within(s, d)));
  if (!init.length) return null;
  return { ...rule, id, condition: { ...c, initiatorDomains: init } };
}
// which rulesets should be on: every list unless switched off in Advanced (a list in a group only while its group is
// on), plus strict pop-up blocking at "Complete"
export function wantedRulesets(s, listIds, groupOf = {}) {
  const on = listIds.filter(id => s.lists?.[id] !== false && groupOn(s, groupOf[id]));
  if (s.level === 'complete') on.push('popups');
  return on;
}
