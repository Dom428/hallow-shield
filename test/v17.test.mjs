// Hallow Shield 1.7: light and dark mode. The popup, the options page and the element picker / zapper follow the
// browser's prefers-color-scheme. Checks: the light palette is the Hallow family's, every text / background pair in it
// is at least 4.5:1 (3:1 for large text, chart marks and lines), the dark look is unchanged, and no colour is hard-coded
// outside the palette blocks (so nothing stays dark in light mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL('../extension/' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const mf = JSON.parse(read('manifest.json'));

function lum(h) {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function hsl(h) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let H = 0, S = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; S = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); H = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6; }
  return [H, S, l];
}
function hex([h, s, l]) {
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return '#' + [0, 8, 4].map(n => f(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}
// the spec's rule: darken the accent in HSL until it reads at 4.5:1 on the light surfaces it sits on
function darkenFor(c, surfaces) { let [h, s, l] = hsl(c); let x = c.toUpperCase(); while (surfaces.some(b => contrast(x, b) < 4.5) && l > 0) { l -= 0.005; x = hex([h, s, l]); } return x; }

// custom properties of the first `:root { }` (dark) and of the `@media (prefers-color-scheme: light)` block
function vars(block) { const o = {}; for (const m of block.matchAll(/--([\w-]+):\s*([^;}]+)/g)) o[m[1]] = m[2].trim(); return o; }
function palettes(css, sel = ':root') {
  const lightAt = css.indexOf('@media (prefers-color-scheme: light)');
  assert.ok(lightAt > 0, 'has a prefers-color-scheme: light block');
  const darkStart = css.indexOf(sel + ' {'); const dark = vars(css.slice(darkStart, css.indexOf('}', darkStart)));
  const ls = css.indexOf(sel + ' {', lightAt); const light = { ...dark, ...vars(css.slice(ls, css.indexOf('}', ls))) };
  return { dark, light, lightAt };
}
const pickerCss = read('picker.js').match(/<style>([\s\S]*?)<\/style>/)[1];
const files = { popup: read('popup.css'), options: read('options.css'), picker: pickerCss };
const sel = { popup: ':root', options: ':root', picker: ':host' };

test('1.7: the manifest and package agree on the version (1.8 checks the number itself)', () => {
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, mf.version + '.0');
});

test('light palette = the Hallow family light palette', () => {
  for (const [name, css] of Object.entries(files)) {
    const { light } = palettes(css, sel[name]);
    assert.equal(light.bg, '#F6F4FA', name + ' bg'); assert.equal(light.panel, '#FFFFFF', name + ' panel');
    assert.equal(light.panel2, '#EEEAF5', name + ' panel 2'); assert.equal(light.line, '#DAD3E6', name + ' border');
    assert.equal(light.text, '#1E1A26', name + ' text'); assert.equal(light.muted, '#6B6478', name + ' muted');
    assert.equal(light.accent, '#f07820', name + ' filled accent keeps the real orange');
    assert.equal(light['accent-text'], darkenFor('#f07820', ['#FFFFFF', '#F6F4FA']), name + ' accent text = darkened in HSL');
  }
  assert.equal(palettes(files.options).light.trackers, '#7A5CC0', 'lilac');
  assert.equal(palettes(files.options).light.bad, '#C2333F', 'status red');
});

test('dark look unchanged (the pre-1.7 values)', () => {
  const was = { bg: '#14101b', panel: '#1f1929', line: '#3a3248', text: '#ece8f4', muted: '#a59cb6', accent: '#f07820', 'accent-text': '#f07820', 'on-accent': '#14101b', panel2: '#3a3248' };
  for (const [name, css] of Object.entries(files)) {
    const { dark } = palettes(css, sel[name]);
    for (const [k, v] of Object.entries(was)) assert.equal(dark[k], v, `${name} dark --${k}`);
  }
  const o = palettes(files.options).dark;
  assert.deepEqual([o.bad, o.good, o['mode-strict'], o.ads, o.trackers, o.other, o.field], ['#ff7a7a', '#7ad49a', '#ff8a7a', '#f07820', '#9b7ede', '#5d536e', '#14101b']);
});

test('light mode: every text / background pair >= 4.5:1, large text, marks and lines >= 3:1', () => {
  for (const [name, css] of Object.entries(files)) {
    const p = palettes(css, sel[name]).light;
    const surfaces = [p.bg, p.panel, ...(p.field ? [p.field] : [])];
    const text = [['text', 4.5], ['muted', 4.5], ['accent-text', 4.5]];
    for (const [k, min] of text) for (const s of surfaces) assert.ok(contrast(p[k], s) >= min, `${name} --${k} ${p[k]} on ${s}: ${contrast(p[k], s).toFixed(2)}`);
    for (const k of ['text', 'muted']) assert.ok(contrast(p[k], p.panel2) >= 4.5, `${name} --${k} on panel 2 (buttons, hover)`);
    assert.ok(contrast(p['on-accent'], p.accent) >= 4.5, `${name} text on the filled accent`);
    assert.ok(contrast(p['on-accent'], p.accent) > contrast('#FFFFFF', p.accent), `${name} dark text reads better than white on the accent`);
    if (p.strict) assert.ok(contrast(p['on-strict'], p.strict) >= 4.5, `${name} text on Strict`);
    if (p.bad) for (const k of ['bad', 'good', 'mode-strict']) assert.ok(contrast(p[k], p.panel) >= 4.5, `${name} --${k} on panel`);
    if (p.ads) for (const k of ['ads', 'trackers', 'other']) assert.ok(contrast(p[k], p.panel) >= 3, `${name} chart --${k} on panel (3:1)`);
    if (p['off-knob']) assert.ok(contrast(p.text, p['off-knob']) >= 3, `${name} switch knob on its off track (3:1)`);
  }
});

test('no hard-coded colours outside the palette blocks', () => {
  for (const [name, css] of Object.entries(files)) {
    const rest = css.split('\n').filter(l => !/^\s*(:root|:host|--|@media|\})/.test(l) && !/^\s+:(root|host) \{/.test(l)).join('\n')
      .replace(/rgba\(240, 120, 32, \.(07|18)\)/g, '');   // the accent tint (reads on both)
    assert.doesNotMatch(rest, /#[0-9a-f]{3,8}\b|rgba?\(/i, name + ': a colour outside var(--...)');
  }
});

test('scrollbars, inputs and the picker follow (color-scheme)', () => {
  for (const [name, css] of Object.entries(files)) {
    assert.match(css, /color-scheme: dark/, name); assert.match(css.slice(palettes(css, sel[name]).lightAt), /color-scheme: light/, name);
  }
});
