// Hallow Shield: packs the extension for Chrome / Edge / Brave / Opera and for Firefox into dist/.
//   node tools/package.mjs        (after tools/build.mjs)
//   node tools/package.mjs --dev  a development build (version.json says "dev": true: the stats may use onRuleMatchedDebug)
// Each zip carries version.json { name, version, browser, built, lists, dev } so Hallow Setup (and anyone) can tell which
// version is unpacked in a folder.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension'), DIST = path.join(ROOT, 'dist');
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const needed = [...mf.declarative_net_request.rule_resources.map(r => r.path.replace('rules/', '')), 'generic.css', 'specific-generic.css', 'cosmetic-meta.json', 'scriptlets.json', 'meta.json', 'cookies/generic.css', 'annoyances/generic.css'];
for (const f of needed) if (!fs.existsSync(path.join(EXT, 'rules', f))) throw new Error('run tools/build.mjs first: rules/' + f + ' is missing');
fs.rmSync(DIST, { recursive: true, force: true }); fs.mkdirSync(DIST);
const rulesMeta = JSON.parse(fs.readFileSync(path.join(EXT, 'rules', 'meta.json'), 'utf8'));
const built = new Date().toISOString();
const versionInfo = browser => ({ name: 'Hallow Shield', version: mf.version, browser, built, lists: rulesMeta.built, dev: process.argv.includes('--dev') });

// 1.6: the Hallow family bridge goes into both zips (bridge/HallowShieldBridge.exe + install-bridge.ps1); CI builds the
// exe on Windows (bridge/build.ps1). --no-bridge: pack without it (a quick local check only - never for a release).
const BRIDGE = path.join(ROOT, 'bridge'), noBridge = process.argv.includes('--no-bridge');
if (!noBridge && !fs.existsSync(path.join(BRIDGE, 'HallowShieldBridge.exe'))) throw new Error('build the bridge first: bridge/HallowShieldBridge.exe is missing (bridge/build.ps1 on Windows)');
function pack(name, manifest) {
  const stage = path.join(DIST, name); fs.cpSync(EXT, stage, { recursive: true, filter: f => !f.includes('_metadata') });
  if (!noBridge) { fs.mkdirSync(path.join(stage, 'bridge')); for (const f of ['HallowShieldBridge.exe', 'install-bridge.ps1']) fs.copyFileSync(path.join(BRIDGE, f), path.join(stage, 'bridge', f)); }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(stage, 'version.json'), JSON.stringify(versionInfo(name), null, 2) + '\n');
  const zip = path.join(DIST, `hallow-shield-${name}-${mf.version}.zip`);
  execFileSync('zip', ['-qr9X', zip, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true });
  console.log('packed', path.relative(ROOT, zip), Math.round(fs.statSync(zip).size / 1024) + ' KB');
}
pack('chrome', mf);
// Firefox: an event page instead of a service worker, its own add-on id, no Chrome version line
const ff = structuredClone(mf);
ff.background = { scripts: ['background.js'], type: 'module' };
delete ff.minimum_chrome_version;
delete ff.key;   // Chrome's fixed ID; Firefox has its own add-on id below
ff.browser_specific_settings = { gecko: { id: 'hallow-shield@dom428.github.io', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } };
pack('firefox', ff);
