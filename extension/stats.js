// Hallow Shield stats: what was blocked per day (last 30 days), on which sites, and which hosts - kept in the
// extension's own storage on this PC (storage.local) and never sent anywhere. Pure functions, shared by the background
// (which records), the options page (which shows) and the unit tests.
//   stats = { v: 1, days: { 'YYYY-MM-DD': { ads, trackers, other, clicks, sites: { site: n }, domains: { host: n } } },
//             since: ms, last: ms (newest matched-rule time already counted) }
import { PAUSE_BASE, USER_BASE, STRICT_BASE } from './shared.js';

export const STATS_DAYS = 30;
const KEEP_PER_DAY = 300;   // sites / hosts kept per day (the biggest), so storage stays small
export const SHARED = '(shared host rules)';   // blocked by a rule that names many hosts at once: the host isn't known

export const emptyStats = () => ({ v: 1, days: {}, since: null, last: 0 });
// the local day of a time
export function dayOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const bucket = (st, t) => (st.days[dayOf(t)] ||= { ads: 0, trackers: 0, other: 0, clicks: 0, sites: {}, domains: {} });

// one block: cat 'ads' | 'trackers' | 'other'; site = the page's site (or null), domain = the blocked host (or null)
export function addBlock(st, { t, cat, site = null, domain = null }, n = 1) {
  const b = bucket(st, t);
  b[cat in b ? cat : 'other'] += n;
  if (site) b.sites[site] = (b.sites[site] || 0) + n;
  if (domain) b.domains[domain] = (b.domains[domain] || 0) + n;
  st.since ??= t;
  return st;
}
// one click on a cookie banner's "Reject" (1.5: per site too, for the popup's "N cookie banners answered here")
export function addClick(st, t, site = null) {
  const b = bucket(st, t); b.clicks++;
  if (site) { b.clickSites ||= {}; b.clickSites[site] = (b.clickSites[site] || 0) + 1; }
  st.since ??= t;
  return st;
}
// days older than 30 dropped, the per-day site / host tables cut to the biggest
export function prune(st, now = Date.now()) {
  const keep = new Set(lastDays(now).map(d => d.day));
  for (const k of Object.keys(st.days)) if (!keep.has(k)) delete st.days[k];
  for (const b of Object.values(st.days)) for (const f of ['sites', 'domains', 'clickSites']) {
    const e = Object.entries(b[f] || {});
    if (e.length > KEEP_PER_DAY) b[f] = Object.fromEntries(e.sort((x, y) => y[1] - x[1]).slice(0, KEEP_PER_DAY));
  }
  return st;
}
// the last 30 local days, oldest first: [{ day, label }]
export function lastDays(now = Date.now(), n = STATS_DAYS) {
  const out = [], d = new Date(now); d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); out.push({ day: dayOf(x.getTime()), label: `${x.getMonth() + 1}/${x.getDate()}` }); }
  return out;
}
// what the stats page shows
export function summary(st, now = Date.now(), top = 10) {
  const days = lastDays(now).map(({ day, label }) => {
    const b = st.days[day] || {};
    return { day, label, ads: b.ads || 0, trackers: b.trackers || 0, other: b.other || 0, clicks: b.clicks || 0 };
  });
  const sum = k => days.reduce((n, d) => n + d[k], 0);
  const merge = f => { const o = {}; for (const { day } of days) for (const [k, v] of Object.entries((st.days[day] || {})[f] || {})) o[k] = (o[k] || 0) + v; return Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); };
  const today = days[days.length - 1];
  return {
    days, since: st.since,
    totals: { ads: sum('ads'), trackers: sum('trackers'), other: sum('other'), clicks: sum('clicks'), blocked: sum('ads') + sum('trackers') + sum('other') },
    today: { blocked: today.ads + today.trackers + today.other, clicks: today.clicks },
    topSites: merge('sites').slice(0, top),
    topDomains: merge('domains').filter(([d]) => d !== SHARED).slice(0, top),
    shared: merge('domains').find(([d]) => d === SHARED)?.[1] || 0,
  };
}

// cookie banners answered on one site (and its subdomains) in the last 30 days
export function clicksOn(st, site, now = Date.now()) {
  if (!site) return 0;
  let n = 0;
  for (const { day } of lastDays(now)) for (const [k, v] of Object.entries((st.days[day] || {}).clickSites || {})) if (k === site || k.endsWith('.' + site)) n += v;
  return n;
}

// which lists count as ads and which as trackers (the rest - badware, cookie banners, annoyances, My filters - "other")
const ADS = new Set(['ublock-filters', 'easylist', 'plowe', 'ublock-quick-fixes', 'ublock-unbreak', 'popups']);
const TRACKERS = new Set(['easyprivacy', 'ublock-privacy']);
// a matched rule -> 'ads' | 'trackers' | 'other', or null if it didn't block (exceptions, header / parameter rules)
//   meta: rules/meta.json; notBlock: { fallback: Set, user: Set, strict: Set } (dynamic rule ids that aren't blocks)
export function categoryOf({ rulesetId, ruleId }, meta, notBlock = {}) {
  if (rulesetId === '_dynamic') {
    if (ruleId < PAUSE_BASE) return notBlock.fallback?.has(ruleId) ? null : 'other';
    if (ruleId >= STRICT_BASE) return notBlock.strict?.has(ruleId) ? null : 'other';
    if (ruleId >= USER_BASE) return notBlock.user?.has(ruleId) ? null : 'other';
    return null;   // a paused site's "allow everything"
  }
  if (rulesetId === '_session') return null;
  const rs = meta.rulesets[rulesetId];
  if (!rs || ruleId <= rs.allow + rs.modify) return null;   // in each ruleset: exceptions first, then header/parameter rules, then blocks
  return ADS.has(rulesetId) ? 'ads' : TRACKERS.has(rulesetId) ? 'trackers' : 'other';
}
// the host a rule blocks, when the rule names one ("||host^...", or one requestDomain); SHARED when it names several
export function domainOfRule(rule) {
  const c = rule && rule.condition; if (!c) return null;
  if (c.requestDomains) return c.requestDomains.length === 1 ? c.requestDomains[0] : SHARED;
  const m = /^\|\|([a-z0-9.-]+\.[a-z0-9-]+)(?:[\^/:]|$)/i.exec(c.urlFilter || '');
  return m ? m[1].toLowerCase() : null;
}
export const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null; } catch { return null; } };
