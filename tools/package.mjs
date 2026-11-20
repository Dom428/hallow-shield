// Hallow Shield: packs the extension for Chrome / Edge / Brave / Opera and for Firefox into dist/.
//   node tools/package.mjs        (after tools/build.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension'), DIST = path.join(ROOT, 'dist');
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
for (const f of ['ads.json', 'privacy.json', 'generic.css', 'sites.json', 'meta.json']) if (!fs.existsSync(path.join(EXT, 'rules', f))) throw new Error('run tools/build.mjs first: rules/' + f + ' is missing');
fs.rmSync(DIST, { recursive: true, force: true }); fs.mkdirSync(DIST);

function pack(name, manifest) {
  const stage = path.join(DIST, name); fs.cpSync(EXT, stage, { recursive: true, filter: f => !f.includes('_metadata') });
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
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
ff.browser_specific_settings = { gecko: { id: 'shield@hallow.app', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } };
pack('firefox', ff);
