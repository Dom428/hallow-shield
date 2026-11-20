// Hallow Shield: small helpers shared by the background and the popup (and the tests).
export const PAUSE_BASE = 1000000;

// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"]
export function hostsFor(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean); const o = [];
  for (let i = 0; i < parts.length - 1; i++) o.push(parts.slice(i).join('.'));
  return o;
}
// the site from a page address, or null for pages Shield doesn't touch (browser pages, files)
export function siteOf(url) {
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return u.hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}
// CSS for one site: its own ad boxes hidden, and the generic ones the lists say must stay visible here shown again
export function siteCss(cos, host) {
  const hide = [], show = [];
  for (const h of hostsFor(host)) { if (cos.sites[h]) hide.push(...cos.sites[h]); if (cos.except[h]) show.push(...cos.except[h]); }
  const shown = new Set(show);
  return hide.filter(s => !shown.has(s)).map(s => `${s}{display:none!important}`).join('\n') + (show.length ? '\n' + show.map(s => `${s}{display:revert!important}`).join('\n') : '');
}
export function pauseRule(domain, id) {
  return { id, priority: 100, action: { type: 'allowAllRequests' }, condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] } };
}
export const validDomain = d => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);
