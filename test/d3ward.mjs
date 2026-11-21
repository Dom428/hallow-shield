// Hallow Shield: the public ad-block test page https://d3ward.github.io/toolz/adblock with the real extension (CI only,
// headed Chromium under xvfb, real network). Reports the score; it doesn't gate the build (the page and the network vary).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const run = async withShield => {
  const args = withShield ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [];
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-d3-')), { headless: false, channel: 'chromium', args });
  if (withShield) {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 120000 }).catch(async e => { const p = await ctx.newPage(); await p.goto('chrome://extensions-internals').catch(() => { }); console.log((await p.textContent('body').catch(() => '')).slice(0, 4000)); throw e; });
    await new Promise(r => setTimeout(r, 5000));   // let the background switch every list on
    console.log('enabled:', (await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).join(', '));
  }
  const p = await ctx.newPage();
  await p.goto('https://d3ward.github.io/toolz/adblock', { waitUntil: 'load', timeout: 60000 });
  await p.waitForTimeout(25000);
  const text = await p.evaluate(() => document.body.innerText);
  await ctx.close();
  const m = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/) || text.match(/score[^\d]{0,40}(\d{1,3})/i);
  return { score: m ? m[1] : null, text: text.replace(/\s+/g, ' ').slice(0, 600) };
};
for (const withShield of [false, true]) {
  try { const r = await run(withShield); console.log(`d3ward ${withShield ? 'with Hallow Shield' : 'without (baseline)'}: score ${r.score ?? '?'}%\n  ${r.text}`); }
  catch (e) { console.log('d3ward test failed to run:', e.message); }
}
