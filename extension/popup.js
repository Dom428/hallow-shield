// Hallow Shield popup: this site (pause / resume), what was blocked on this page, and the three switches.
import { siteOf, validDomain } from './shared.js';
const ext = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);

// the tab you opened the popup on (tests open popup.html?tab=<id> as a page for a given tab)
const forTab = Number(new URLSearchParams(location.search).get('tab'));
const tab = forTab ? await ext.tabs.get(forTab) : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
const site = tab && siteOf(tab.url);
const s = await ext.storage.local.get({ paused: [], hide: true, ads: true, privacy: true });

$('site').textContent = site || 'This page';
for (const k of ['ads', 'privacy', 'hide']) { $(k).checked = s[k]; $(k).onchange = () => ext.storage.local.set({ [k]: $(k).checked }); }

const paused = () => site && s.paused.includes(site);
function show() {
  $('pause').textContent = paused() ? 'Resume on this site' : 'Pause on this site';
  $('pause').classList.toggle('paused', paused());
  $('note').textContent = paused() ? 'Ads and trackers are allowed on ' + site + '. Reload the page to see the change.' : '';
}
if (!site || !validDomain(site)) { $('pause').disabled = true; $('note').textContent = 'Hallow Shield works on web pages (http and https).'; }
$('pause').onclick = async () => {
  s.paused = paused() ? s.paused.filter(d => d !== site) : [...s.paused, site].slice(-500);
  await ext.storage.local.set({ paused: s.paused });
  show();
  if (tab) ext.tabs.reload(tab.id);
};
show();

// what the browser blocked on this tab (allowed because you opened this popup on it)
try {
  const m = await ext.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
  const meta = await (await fetch(ext.runtime.getURL('rules/meta.json'))).json();   // exceptions come first in each list
  const n = m.rulesMatchedInfo.filter(r => meta.allow[r.rule.rulesetId] !== undefined && r.rule.ruleId > meta.allow[r.rule.rulesetId]).length;
  $('count').textContent = String(n);
  $('countText').textContent = n === 1 ? 'ad or tracker blocked on this page' : 'ads and trackers blocked on this page';
} catch { $('count').textContent = '-'; }
