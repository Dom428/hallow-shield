// Hallow Shield background: keeps the per-site pause list, the ad-box hiding (CSS) registration and the badge.
// The blocking itself is done by the browser from the rule files - this script never sees your requests.
import { hostsFor, siteCss, pauseRule, PAUSE_BASE } from './shared.js';

const ext = globalThis.browser ?? chrome;
let cosmetic = null;   // { sites: { domain: [selectors] }, except: { domain: [selectors] } }
async function loadCosmetic() {
  if (!cosmetic) cosmetic = await (await fetch(ext.runtime.getURL('rules/sites.json'))).json();
  return cosmetic;
}
async function settings() {
  const s = await ext.storage.local.get({ paused: [], hide: true, ads: true, privacy: true });
  return s;
}

// the generic ad-box CSS goes in through a registered content script, so paused sites can be left out
async function syncCss() {
  const s = await settings();
  try { await ext.scripting.unregisterContentScripts({ ids: ['shield-css'] }); } catch { }
  if (!s.hide) return;
  const exclude = s.paused.flatMap(d => [`*://${d}/*`, `*://*.${d}/*`]);
  const script = { id: 'shield-css', matches: ['<all_urls>'], excludeMatches: exclude, css: ['rules/generic.css'], js: ['content.js'], allFrames: true, runAt: 'document_start' };
  try { await ext.scripting.registerContentScripts([{ ...script, persistAcrossSessions: true }]); }
  catch { await ext.scripting.registerContentScripts([script]); }   // browsers without persistAcrossSessions: re-registered at startup
}
// a paused site: one dynamic "allow everything" rule per site, above every block rule
async function syncPauses() {
  const s = await settings();
  const old = await ext.declarativeNetRequest.getDynamicRules();
  await ext.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.filter(r => r.id >= PAUSE_BASE).map(r => r.id),
    addRules: s.paused.map((d, i) => pauseRule(d, PAUSE_BASE + i)),
  });
}
async function syncRulesets() {
  const s = await settings();
  await ext.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['ads', 'privacy'].filter(k => s[k]), disableRulesetIds: ['ads', 'privacy'].filter(k => !s[k]) });
}
async function syncAll() { await Promise.all([syncCss(), syncPauses(), syncRulesets()]); }

ext.runtime.onInstalled.addListener(() => { syncAll(); try { ext.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true }); } catch { } });
ext.runtime.onStartup?.addListener(() => syncAll());
ext.storage.onChanged.addListener(() => syncAll());

// site-specific ad boxes: the content script asks once per page; the CSS is added by the browser (works with any page CSP)
ext.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.t !== 'site-css' || !sender.tab) return;
  (async () => {
    const s = await settings(); const host = String(msg.host || '').toLowerCase();
    if (!s.hide || s.paused.some(d => host === d || host.endsWith('.' + d))) return reply({ ok: false });
    const css = siteCss(await loadCosmetic(), host);
    if (css) await ext.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, css });
    reply({ ok: true, hosts: hostsFor(host).length });
  })();
  return true;
});
