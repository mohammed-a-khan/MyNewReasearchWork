/**
 * The in-page half of the Electron rung: a fixed script (never user code)
 * that resolves EZ locator candidates (role + accessible name, label, text,
 * test id, placeholder, alt, title, CSS, XPath) to elements, reports boxes
 * and fingerprints, and performs DOM-level helpers (focus/select, value,
 * select options, text). Input events themselves go through CDP Input.*.
 */

/** Installs `window.__ez` (idempotent) and returns it. Kept as source text: it runs inside the app's renderer. */
export const EZ_DOM_INSTALL = String.raw`(() => {
  if (window.__ez && window.__ez.v === 1) return window.__ez;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const IMPLICIT = (el) => {
    const t = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.getAttribute('role')) return el.getAttribute('role').split(/\s+/)[0];
    if (t === 'button') return 'button';
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'table') return 'table';
    if (t === 'tr') return 'row';
    if (t === 'td' || t === 'th') return 'cell';
    if (t === 'option') return 'option';
    if (t === 'dialog') return 'dialog';
    if (t === 'nav') return 'navigation';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'li') return 'listitem';
    if (el.isContentEditable) return 'textbox';
    return '';
  };
  const labelsOf = (el) => {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(norm(l.innerText));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) out.push(norm(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ')));
    return out.filter(Boolean);
  };
  const accName = (el) => {
    const a = el.getAttribute('aria-label');
    if (a) return norm(a);
    const l = labelsOf(el);
    if (l.length) return l[0];
    const t = el.tagName.toLowerCase();
    if (t === 'input' && ['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase())) return norm(el.value);
    if (t === 'img') return norm(el.getAttribute('alt'));
    if (t === 'input' || t === 'textarea' || t === 'select') return norm(el.getAttribute('placeholder') || el.getAttribute('title'));
    return norm(el.innerText || el.textContent) || norm(el.getAttribute('title'));
  };
  const all = () => Array.from(document.querySelectorAll('*'));
  const eq = (a, b, exact) => (exact === false ? norm(a).toLowerCase().includes(norm(b).toLowerCase()) : norm(a) === norm(b));
  const byText = (v, exact) => {
    const hits = all().filter((el) => visible(el) && eq(el.innerText, v, exact) && !['HTML', 'BODY', 'SCRIPT', 'STYLE'].includes(el.tagName));
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  };
  const find = (c) => {
    switch (c.strategy) {
      case 'role': return all().filter((el) => IMPLICIT(el) === c.value && (c.name == null || eq(accName(el), c.name, c.exact)));
      case 'label': return all().filter((el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || el.getAttribute('role') === 'textbox')
        .filter((el) => labelsOf(el).some((l) => eq(l, c.value, c.exact)) || eq(el.getAttribute('aria-label') || '\u0000', c.value, c.exact));
      case 'text': return byText(c.value, c.exact);
      case 'testId': return Array.from(document.querySelectorAll('[data-testid="' + CSS.escape(c.value) + '"]'));
      case 'placeholder': return all().filter((el) => el.hasAttribute('placeholder') && eq(el.getAttribute('placeholder'), c.value, c.exact));
      case 'altText': return all().filter((el) => el.hasAttribute('alt') && eq(el.getAttribute('alt'), c.value, c.exact));
      case 'title': return all().filter((el) => el.hasAttribute('title') && eq(el.getAttribute('title'), c.value, c.exact));
      case 'css': return Array.from(document.querySelectorAll(c.value));
      case 'xpath': {
        const r = document.evaluate(c.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < r.snapshotLength; i++) if (r.snapshotItem(i).nodeType === 1) out.push(r.snapshotItem(i));
        return out;
      }
      default: return [];
    }
  };
  const ez = { v: 1, els: [] };
  const keep = (el) => { ez.els.push(el); return ez.els.length - 1; };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const fp = (el) => {
    const attrs = {};
    for (const n of ['name', 'type', 'href', 'aria-label']) if (el.hasAttribute(n)) attrs[n] = el.getAttribute(n);
    const path = [];
    for (let p = el; p && p.nodeType === 1 && path.length < 5; p = p.parentElement) path.unshift(p.tagName.toLowerCase() + (p.id ? '#' + p.id : ''));
    return {
      tag: el.tagName.toLowerCase(), role: IMPLICIT(el) || undefined, name: accName(el) || undefined, text: norm(el.innerText).slice(0, 80) || undefined,
      id: el.id || undefined, testId: el.getAttribute('data-testid') || undefined, classes: Array.from(el.classList),
      attributes: attrs, label: labelsOf(el)[0], placeholder: el.getAttribute('placeholder') || undefined, path: path.join(' > '), box: box(el),
    };
  };
  ez.resolve = (cands) => {
    const notes = [];
    for (const c of cands) {
      let found;
      try { found = find(c); } catch (e) { notes.push(c.strategy + ': ' + e.message); continue; }
      const vis = found.filter(visible);
      const use = vis.length ? vis : found;
      if (use.length === 1) { const el = use[0]; el.scrollIntoView({ block: 'center', inline: 'center' }); return { i: keep(el), box: box(el), fp: fp(el), cand: c, notes }; }
      notes.push(c.strategy + '=' + c.value + (c.name ? ' "' + c.name + '"' : '') + ': ' + (use.length ? use.length + ' matches' : 'no match'));
    }
    return { notes };
  };
  ez.scan = () => {
    ez.els = [];
    return all().filter((el) => visible(el) && (IMPLICIT(el) || el.onclick || el.tagName === 'LABEL')).slice(0, 2000).map((el) => ({ i: keep(el), fp: fp(el) }));
  };
  ez.focusSelect = (i) => {
    const el = ez.els[i];
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true;
  };
  ez.clear = (i) => {
    const el = ez.els[i];
    el.focus();
    if ('value' in el) el.value = ''; else el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  ez.selectOption = (i, v) => {
    const el = ez.els[i];
    if (el.tagName !== 'SELECT') throw new Error('not a <select>');
    const opt = Array.from(el.options).find((o) => norm(o.label) === norm(v) || norm(o.text) === norm(v) || o.value === v);
    if (!opt) throw new Error('no option "' + v + '"');
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return norm(opt.text);
  };
  ez.text = (i) => norm(ez.els[i].innerText || ez.els[i].textContent);
  ez.value = (i) => { const el = ez.els[i]; return el.tagName === 'SELECT' ? norm((el.selectedOptions[0] || {}).text) : 'value' in el ? String(el.value) : norm(el.innerText); };
  ez.state = (i) => { const el = ez.els[i]; return { checked: !!el.checked, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', visible: visible(el), focused: document.activeElement === el, editable: !el.readOnly && !el.disabled }; };
  ez.body = () => norm(document.body ? document.body.innerText : '');
  ez.where = () => ({ url: location.href, title: document.title });
  window.__ez = ez;
  return ez;
})()`;

/** An expression calling `window.__ez.<fn>(...args)` (installing it first when needed). */
export function ezCall(fn: string, ...args: unknown[]): string {
  return `(${EZ_DOM_INSTALL}).${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
}
