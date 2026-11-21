// Hallow Shield element picker: the CSS selector for a picked element. A plain script (no imports) so it can be
// injected into a page next to picker.js, and loaded by the unit tests with a small fake DOM.
// The selector is the shortest one that still names only that element, built like this:
//   #id (if the id looks hand-written) > tag.class.class (classes that look hand-written) > the same with its parents
//   ("parent > child"), :nth-of-type() where siblings look alike. Only ASCII, so it can be saved as a filter.
(() => {
  const ASCII_NAME = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
  // ids and classes made by build tools change on every deploy ("css-1x2y3z", "sc-a12bc", "jsx-123456"): left out
  const looksGenerated = s => /\d{4,}/.test(s) || /^(css|sc|jsx|emotion|styled|svelte)-/i.test(s) || /[a-f0-9]{8,}/i.test(s) || (/[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && s.length > 6);
  const goodName = s => !!s && s.length <= 60 && ASCII_NAME.test(s) && !looksGenerated(s);
  const esc = s => s;   // goodName only lets through names that need no escaping

  function classesOf(el) {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c.split(/\s+/).filter(goodName);
  }
  function compound(el, { classes = 2 } = {}) {
    const tag = el.tagName.toLowerCase();
    const cls = classesOf(el).slice(0, classes);
    return tag + cls.map(c => '.' + esc(c)).join('');
  }
  function nthOfType(el) {
    const p = el.parentElement; if (!p) return '';
    const same = Array.prototype.filter.call(p.children, c => c.tagName === el.tagName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
  }
  const STOP = new Set(['HTML', 'BODY']);

  // count(selector) -> how many elements it matches in the page (document.querySelectorAll(sel).length)
  function selectorFor(el, count) {
    if (!el || !el.tagName || STOP.has(el.tagName)) return null;
    const unique = sel => { try { return count(sel) === 1; } catch { return false; } };
    if (goodName(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    let self = compound(el);
    if (self.includes('.') && unique(self)) return self;
    // walk up: "parent > ... > el", each step as specific as it needs to be
    let path = self, node = el;
    for (let depth = 0; depth < 8; depth++) {
      // first try telling the element apart from its siblings
      const nth = nthOfType(node);
      const withNth = path.replace(/^[^ >]+/, m => m + nth);
      if (nth && unique(withNth)) return withNth;
      const parent = node.parentElement;
      if (!parent || STOP.has(parent.tagName)) {
        const top = (parent && parent.tagName === 'BODY' ? 'body > ' : '') + withNth;
        return unique(top) ? top : withNth;
      }
      if (nth) path = withNth;
      const pid = goodName(parent.id) && unique('#' + esc(parent.id)) ? '#' + esc(parent.id) : null;
      path = (pid || compound(parent)) + ' > ' + path;
      if (unique(path)) return path;
      if (pid) return path;   // an id parent and still not unique: nothing more specific to add above it
      node = parent;
    }
    return path;
  }

  const api = { selectorFor, goodName, looksGenerated, compound };
  if (typeof globalThis !== 'undefined') globalThis.HallowShieldSelector = api;
})();
