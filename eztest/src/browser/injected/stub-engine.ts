/**
 * Interim page-side selector / actionability engine, implementing the
 * contract in ./contract.ts until the full engine lands. It covers css
 * (open shadow roots pierced), xpath, text, and practical approximations of
 * role / accessible name, label, placeholder, alt text, title and test id.
 *
 * Everything lives inside createStubEngine(): it is stringified and
 * evaluated in the page's isolated world, so it may not reference anything
 * outside its own body.
 */
import type {
  ActionabilityOptions,
  ActionabilityResult,
  ActionKind,
  ElementStateName,
  InjectedEngine,
  SelectorChain,
  SelectorStep,
  TextMatch,
} from './contract.js';

export function createStubEngine(): InjectedEngine {
  type Root = Element | Document | ShadowRoot;
  const norm = (s: string) => s.replace(/[\s ​]+/g, ' ').trim();

  function textMatcher(m: TextMatch, exact?: boolean): (s: string) => boolean {
    if (typeof m !== 'string') {
      const re = new RegExp(m.regex, m.flags ?? '');
      return (s) => {
        re.lastIndex = 0;
        return re.test(norm(s));
      };
    }
    const want = norm(m);
    if (exact) return (s) => norm(s) === want;
    const lw = want.toLowerCase();
    return (s) => norm(s).toLowerCase().includes(lw);
  }

  /** Every element below root (not root itself), shadow roots included, in document order. */
  function deepElements(root: Root): Element[] {
    const out: Element[] = [];
    const visit = (n: Node) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const el = c as Element;
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        visit(el);
      }
    };
    if ((root as Element).shadowRoot) visit((root as Element).shadowRoot as ShadowRoot);
    visit(root);
    return out;
  }

  function shadowRootsUnder(root: Root): ShadowRoot[] {
    const out: ShadowRoot[] = [];
    for (const el of [...(root.nodeType === 1 ? [root as Element] : []), ...deepElements(root)]) if (el.shadowRoot) out.push(el.shadowRoot);
    return out;
  }

  function cssAll(root: Root, selector: string): Element[] {
    const set = new Set<Element>();
    const add = (r: Root) => {
      for (const e of Array.from(r.querySelectorAll(selector))) set.add(e);
    };
    add(root);
    for (const sr of shadowRootsUnder(root)) add(sr);
    return sortDocOrder([...set]);
  }

  function sortDocOrder(list: Element[]): Element[] {
    if (list.length < 2) return list;
    const all = deepElements(document);
    const idx = new Map<Element, number>();
    all.forEach((e, i) => idx.set(e, i));
    return list.sort((a, b) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0));
  }

  function xpathAll(root: Root, expr: string): Element[] {
    const doc = root.nodeType === 9 ? (root as Document) : (root as Element).ownerDocument!;
    const ctx = root.nodeType === 11 ? (root as ShadowRoot).host : root;
    const r = doc.evaluate(expr, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out: Element[] = [];
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n && n.nodeType === 1) out.push(n as Element);
    }
    return out;
  }

  // ------------------------------------------------------------------ text
  let textCache: Map<Element, string> | undefined;
  function elementText(el: Element): string {
    const cached = textCache?.get(el);
    if (cached !== undefined) return cached;
    let s = '';
    const tag = el.localName;
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') s = '';
    else if (tag === 'input' && /^(button|submit|reset)$/i.test((el as HTMLInputElement).type)) s = (el as HTMLInputElement).value;
    else {
      const parts: string[] = [];
      const walk = (n: Node) => {
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) parts.push((c as Text).data);
          else if (c.nodeType === 1) {
            const ce = c as Element;
            if (ce.localName === 'slot') {
              const assigned = (ce as HTMLSlotElement).assignedNodes();
              if (assigned.length) {
                for (const a of assigned) parts.push(a.nodeType === 1 ? elementText(a as Element) : a.textContent ?? '');
              } else walk(ce);
            } else parts.push(elementText(ce));
          }
        }
      };
      walk(el.shadowRoot ?? el);
      s = parts.join('');
    }
    textCache?.set(el, s);
    return s;
  }

  function textCandidates(root: Root): Element[] {
    return deepElements(root).filter((e) => !/^(script|style|noscript|template|head|title|meta|link|html)$/.test(e.localName));
  }

  /** Keep innermost matches: drop an element when one of its element children also matches. */
  function innermost(list: Element[], test: (e: Element) => boolean): Element[] {
    const hits = new Set(list.filter(test));
    return [...hits].filter((e) => {
      const kids = e.shadowRoot ? [...Array.from(e.shadowRoot.children), ...Array.from(e.children)] : Array.from(e.children);
      return !kids.some((k) => hits.has(k));
    });
  }

  // ------------------------------------------------------------------ visibility
  function style(el: Element): CSSStyleDeclaration | undefined {
    return el.ownerDocument.defaultView?.getComputedStyle(el);
  }

  function isVisible(el: Element): boolean {
    const st = style(el);
    if (!st) return false;
    if (st.display === 'contents') {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && isVisible(c as Element)) return true;
        if (c.nodeType === 3 && norm((c as Text).data)) {
          const r = document.createRange();
          r.selectNodeContents(c);
          const b = r.getBoundingClientRect();
          if (b.width > 0 && b.height > 0) return true;
        }
      }
      return false;
    }
    if (typeof (el as Element & { checkVisibility?: (o: unknown) => boolean }).checkVisibility === 'function') {
      if (!(el as Element & { checkVisibility: (o: unknown) => boolean }).checkVisibility({})) return false;
    }
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    return st.visibility === 'visible';
  }

  function isHiddenForAria(el: Element): boolean {
    if (el.localName === 'option' || el.localName === 'optgroup') {
      const sel = el.closest('select, datalist');
      if (sel) return isHiddenForAria(sel);
    }
    for (let e: Element | null = el; e; e = parentElementOrHost(e)) {
      if (e.getAttribute('aria-hidden') === 'true') return true;
      if (e.hasAttribute('inert')) return true;
    }
    const st = style(el);
    if (!st || st.visibility === 'hidden' || st.visibility === 'collapse') return true;
    if (st.display === 'contents') return false;
    // Not rendered: display:none on it or an ancestor.
    for (let e: Element | null = el; e; e = parentElementOrHost(e)) {
      const s = style(e);
      if (s && s.display === 'none') return true;
    }
    return false;
  }

  function parentElementOrHost(e: Element): Element | null {
    if (e.parentElement) return e.parentElement;
    const p = e.parentNode;
    if (p && p.nodeType === 11) return (p as ShadowRoot).host;
    return null;
  }

  // ------------------------------------------------------------------ roles
  const inputRoles: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
    number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox', '': 'textbox',
  };
  const simpleRoles: Record<string, string> = {
    button: 'button', textarea: 'textbox', option: 'option', optgroup: 'group', ul: 'list', ol: 'list', menu: 'list', li: 'listitem',
    nav: 'navigation', main: 'main', aside: 'complementary', article: 'article', dialog: 'dialog', table: 'table', tr: 'row',
    thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup', fieldset: 'group', details: 'group', progress: 'progressbar',
    meter: 'meter', hr: 'separator', output: 'status', p: 'paragraph', blockquote: 'blockquote', code: 'code', strong: 'strong',
    b: 'generic', em: 'emphasis', figure: 'figure', dt: 'term', dd: 'definition', dfn: 'term', caption: 'caption', datalist: 'listbox',
    time: 'time', search: 'search', math: 'math', ins: 'insertion', del: 'deletion', sub: 'subscript', sup: 'superscript',
    address: 'group', hgroup: 'group', legend: 'generic', menuitem: 'menuitem', svg: 'img', dl: 'list', summary: 'button',
  };

  function implicitRole(el: Element, skipNameChecks = false): string | null {
    const tag = el.localName;
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const t = (input.getAttribute('type') ?? '').toLowerCase();
      if (t === 'hidden' || t === 'file' || t === 'color' || /^(date|datetime-local|month|time|week)$/.test(t)) return null;
      if (input.hasAttribute('list') && /^(|text|search|email|tel|url)$/.test(t)) return 'combobox';
      return inputRoles[t] ?? 'textbox';
    }
    if (tag === 'select') {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'img') return el.getAttribute('alt') === '' && !el.hasAttribute('title') ? 'presentation' : 'img';
    if (tag === 'header' || tag === 'footer') {
      if (el.closest('article, aside, main, nav, section') && el.closest('article, aside, main, nav, section') !== el) return 'generic';
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    if (tag === 'form') return skipNameChecks || accessibleName(el) ? 'form' : null;
    if (tag === 'section') return skipNameChecks || accessibleName(el) ? 'region' : null;
    if (tag === 'td') return el.closest('table')?.getAttribute('role') === 'grid' ? 'gridcell' : 'cell';
    if (tag === 'th') {
      const scope = el.getAttribute('scope');
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      const row = el.parentElement;
      if (row && row.parentElement?.localName === 'thead') return 'columnheader';
      if (row && Array.from(row.children).every((c) => c.localName === 'th')) return 'columnheader';
      return row && row.firstElementChild === el ? 'rowheader' : 'columnheader';
    }
    return simpleRoles[tag] ?? null;
  }

  function role(el: Element, skipNameChecks = false): string | null {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0];
    if (explicit) return explicit === 'none' ? 'presentation' : explicit;
    return implicitRole(el, skipNameChecks);
  }

  // ------------------------------------------------------------------ accessible name
  const nameFromContentRoles = new Set([
    'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem', 'caption', 'term', 'definition', 'code',
    'strong', 'emphasis', 'paragraph', 'listitem', 'legend',
  ]);

  function textAlternative(el: Element, visited: Set<Element>, fromContent: boolean, allowHidden = false): string {
    if (visited.has(el)) return '';
    visited.add(el);
    if (fromContent && !allowHidden && isHiddenForAria(el)) return '';
    const label = el.getAttribute('aria-label');
    if (label && norm(label)) return norm(label);
    const tag = el.localName;
    if (tag === 'img' || tag === 'area' || (tag === 'input' && (el as HTMLInputElement).type === 'image')) {
      const alt = el.getAttribute('alt');
      if (alt) return alt;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (fromContent) {
        if (tag === 'select') return Array.from((el as HTMLSelectElement).selectedOptions).map((o) => o.textContent ?? '').join(' ');
        return (el as HTMLInputElement).value ?? '';
      }
    }
    const parts: string[] = [];
    const walk = (n: Node) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) parts.push((c as Text).data);
        else if (c.nodeType === 1) {
          const ce = c as Element;
          if (/^(script|style|noscript|template)$/.test(ce.localName)) continue;
          if (ce.localName === 'slot') {
            const nodes = (ce as HTMLSlotElement).assignedNodes();
            if (nodes.length) {
              for (const a of nodes) {
                if (a.nodeType === 3) parts.push((a as Text).data);
                else if (a.nodeType === 1) parts.push(textAlternative(a as Element, visited, true));
              }
              continue;
            }
            walk(ce);
            continue;
          }
          const st = style(ce);
          const block = st && st.display !== 'inline' && st.display !== 'contents';
          const t = textAlternative(ce, visited, true);
          parts.push(block ? ` ${t} ` : t);
        }
      }
    };
    walk(el.shadowRoot ?? el);
    const content = parts.join('');
    if (norm(content)) return content;
    const title = el.getAttribute('title');
    return title ?? '';
  }

  function byIds(el: Element, attr: string): Element[] {
    const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean);
    const root = el.getRootNode() as Document | ShadowRoot;
    return ids.map((id) => (root.getElementById ? root.getElementById(id) : null) ?? document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  }

  function labelsOf(el: Element): Element[] {
    const labels = (el as HTMLInputElement).labels;
    return labels ? Array.from(labels) : [];
  }

  function accessibleName(el: Element): string {
    const visited = new Set<Element>();
    const lb = byIds(el, 'aria-labelledby');
    if (lb.length) return norm(lb.map((e) => textAlternative(e, new Set(), true, true)).join(' '));
    const aria = el.getAttribute('aria-label');
    if (aria && norm(aria)) return norm(aria);
    const tag = el.localName;
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const t = input.type;
      if (t === 'button' || t === 'submit' || t === 'reset') {
        if (input.hasAttribute('value')) return norm(input.value);
        return t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '';
      }
      if (t === 'image') return norm(input.alt || input.value || input.title || 'Submit');
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'meter' || tag === 'progress' || tag === 'output' || tag === 'button') {
      const ls = labelsOf(el);
      if (ls.length) return norm(ls.map((l) => textAlternative(l, new Set([el]), true)).join(' '));
    }
    if (tag === 'img' || tag === 'area') {
      const alt = el.getAttribute('alt');
      if (alt !== null && norm(alt)) return norm(alt);
    }
    if (tag === 'fieldset') {
      const legend = Array.from(el.children).find((c) => c.localName === 'legend');
      if (legend) return norm(textAlternative(legend, visited, true));
    }
    if (tag === 'table') {
      const caption = Array.from(el.children).find((c) => c.localName === 'caption');
      if (caption) return norm(textAlternative(caption, visited, true));
    }
    if (tag === 'figure') {
      const fc = Array.from(el.children).find((c) => c.localName === 'figcaption');
      if (fc) return norm(textAlternative(fc, visited, true));
    }
    const r = role(el, true);
    if (r && nameFromContentRoles.has(r)) {
      const t = norm(textAlternative(el, visited, false));
      if (t) return t;
    }
    if (tag === 'svg') {
      const title = Array.from(el.children).find((c) => c.localName === 'title');
      if (title) return norm(title.textContent ?? '');
    }
    const title = el.getAttribute('title');
    if (title && norm(title)) return norm(title);
    if (tag === 'input' || tag === 'textarea') {
      const ph = el.getAttribute('placeholder');
      if (ph) return norm(ph);
    }
    return '';
  }

  // ------------------------------------------------------------------ states
  function isDisabled(el: Element): boolean {
    const tag = el.localName;
    const native = /^(button|input|select|textarea|optgroup|option|fieldset)$/.test(tag);
    if (native && (el as HTMLButtonElement).disabled) return true;
    if (native) {
      // Inside a disabled fieldset (but not its first legend).
      const fs = el.parentElement?.closest('fieldset');
      if (fs && (fs as HTMLFieldSetElement).disabled) {
        const legend = Array.from(fs.children).find((c) => c.localName === 'legend');
        if (!legend || !legend.contains(el)) return true;
      }
      if (tag === 'option') {
        const og = el.closest('optgroup');
        if (og && (og as HTMLOptGroupElement).disabled) return true;
      }
    }
    for (let e: Element | null = el; e; e = parentElementOrHost(e)) {
      const v = e.getAttribute('aria-disabled');
      if (v === 'true') return true;
      if (v === 'false') return false;
    }
    return false;
  }

  function checkedState(el: Element): boolean | 'mixed' | undefined {
    const tag = el.localName;
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio') return input.indeterminate && input.type === 'checkbox' ? 'mixed' : input.checked;
    }
    const r = role(el);
    if (r && /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio|option|treeitem)$/.test(r)) {
      const a = el.getAttribute('aria-checked');
      if (a === 'true') return true;
      if (a === 'mixed') return 'mixed';
      if (a === 'false' || r !== 'option') return false;
    }
    return undefined;
  }

  function isEditableKind(el: Element): boolean {
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    const r = role(el);
    return !!r && /^(textbox|searchbox|combobox|spinbutton|slider|checkbox|radio|switch|listbox|gridcell|menuitemcheckbox|menuitemradio|option|treegrid)$/.test(r) && el.hasAttribute('aria-readonly');
  }

  function isReadonly(el: Element): boolean {
    const tag = el.localName;
    if ((tag === 'input' || tag === 'textarea') && (el as HTMLInputElement).readOnly) return true;
    return el.getAttribute('aria-readonly') === 'true';
  }

  function elementState(el: Element, state: ElementStateName): boolean {
    switch (state) {
      case 'attached': return el.isConnected;
      case 'visible': return el.isConnected && isVisible(el);
      case 'hidden': return !el.isConnected || !isVisible(el);
      case 'enabled': return !isDisabled(el);
      case 'disabled': return isDisabled(el);
      case 'editable': return isEditableKind(el) && !isDisabled(el) && !isReadonly(el);
      case 'focused': {
        let a: Element | null = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
        return a === el;
      }
      case 'checked':
      case 'unchecked': {
        const c = checkedState(el);
        if (c === undefined) throw new Error('Not a checkbox or radio button');
        return state === 'checked' ? c === true : c === false;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ query
  function selectStep(root: Root, step: SelectorStep): Element[] {
    const s = step as unknown as Record<string, unknown>;
    if ('css' in s) return cssAll(root, String(s.css));
    if ('xpath' in s) return xpathAll(root, String(s.xpath));
    if ('role' in s) {
      const st = step as Extract<SelectorStep, { role: string }>;
      const nameTest = st.name !== undefined ? textMatcher(st.name, st.exact) : undefined;
      return deepElements(root).filter((e) => {
        if (role(e) !== st.role) return false;
        if (!st.includeHidden && isHiddenForAria(e)) return false;
        if (st.checked !== undefined && checkedState(e) !== st.checked) return false;
        if (st.pressed !== undefined) {
          const p = e.getAttribute('aria-pressed');
          if ((p === 'mixed' ? 'mixed' : p === 'true') !== st.pressed) return false;
        }
        if (st.expanded !== undefined) {
          const x = e.localName === 'details' ? (e as HTMLDetailsElement).open : e.getAttribute('aria-expanded') === 'true';
          if (x !== st.expanded) return false;
        }
        if (st.selected !== undefined) {
          const sel = e.localName === 'option' ? (e as HTMLOptionElement).selected : e.getAttribute('aria-selected') === 'true';
          if (sel !== st.selected) return false;
        }
        if (st.disabled !== undefined && isDisabled(e) !== st.disabled) return false;
        if (st.level !== undefined) {
          const lv = /^h([1-6])$/.exec(e.localName);
          const level = Number(e.getAttribute('aria-level') ?? (lv ? lv[1] : NaN));
          if (level !== st.level) return false;
        }
        if (nameTest && !nameTest(accessibleName(e))) return false;
        return true;
      });
    }
    if ('text' in s) {
      const st = step as Extract<SelectorStep, { text: TextMatch }>;
      const test = textMatcher(st.text, st.exact);
      return innermost(textCandidates(root), (e) => test(elementText(e)));
    }
    if ('label' in s) {
      const st = step as Extract<SelectorStep, { label: TextMatch }>;
      const test = textMatcher(st.label, st.exact);
      return deepElements(root).filter((e) => {
        const lb = byIds(e, 'aria-labelledby');
        if (lb.length && test(lb.map((x) => elementText(x)).join(' '))) return true;
        const aria = e.getAttribute('aria-label');
        if (aria && test(aria)) return true;
        return labelsOf(e).some((l) => test(elementText(l)));
      });
    }
    const attrStep = (attr: string, m: TextMatch, exact?: boolean, filter?: (e: Element) => boolean) => {
      const test = textMatcher(m, exact);
      return deepElements(root).filter((e) => e.hasAttribute(attr) && (!filter || filter(e)) && test(e.getAttribute(attr) ?? ''));
    };
    if ('placeholder' in s) return attrStep('placeholder', (step as { placeholder: TextMatch }).placeholder, (step as { exact?: boolean }).exact);
    if ('altText' in s) return attrStep('alt', (step as { altText: TextMatch }).altText, (step as { exact?: boolean }).exact);
    if ('title' in s) return attrStep('title', (step as { title: TextMatch }).title, (step as { exact?: boolean }).exact);
    if ('testId' in s) {
      const st = step as { testId: TextMatch; attr: string };
      return attrStep(st.attr || 'data-testid', st.testId, true);
    }
    throw new Error(`Unknown selector step ${JSON.stringify(step)}`);
  }

  function applyStep(set: Root[], step: SelectorStep): Root[] {
    const s = step as unknown as Record<string, unknown>;
    if ('nth' in s) {
      const n = Number(s.nth);
      const el = n < 0 ? set[set.length + n] : set[n];
      return el ? [el] : [];
    }
    if ('hasText' in s) {
      const test = textMatcher(s.hasText as TextMatch, s.exact as boolean | undefined);
      return set.filter((e) => e.nodeType === 1 && test(elementText(e as Element)));
    }
    if ('hasNotText' in s) {
      const test = textMatcher(s.hasNotText as TextMatch, s.exact as boolean | undefined);
      return set.filter((e) => e.nodeType === 1 && !test(elementText(e as Element)));
    }
    if ('visible' in s) return set.filter((e) => e.nodeType === 1 && isVisible(e as Element) === !!s.visible);
    if ('has' in s) return set.filter((e) => run(s.has as SelectorChain, e).length > 0);
    if ('hasNot' in s) return set.filter((e) => run(s.hasNot as SelectorChain, e).length === 0);
    const out: Element[] = [];
    const seen = new Set<Element>();
    for (const r of set) {
      for (const e of selectStep(r, step)) {
        if (seen.has(e)) continue;
        seen.add(e);
        out.push(e);
      }
    }
    return set.length > 1 ? sortDocOrder(out) : out;
  }

  function run(chain: SelectorChain, scope: Root): Element[] {
    let set: Root[] = [scope];
    for (const step of chain) set = applyStep(set, step);
    return set.filter((e): e is Element => e.nodeType === 1);
  }

  function query(chain: SelectorChain, scope?: Element | Document): Element[] {
    textCache = new Map();
    try {
      return run(chain, scope ?? document);
    } finally {
      textCache = undefined;
    }
  }

  // ------------------------------------------------------------------ describe
  function describe(el: Element): string {
    const attrs: string[] = [];
    for (const a of ['id', 'class', 'name', 'type', 'role', 'aria-label', 'data-testid', 'href', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      attrs.push(`${a}="${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`);
    }
    const text = norm(elementText(el));
    const shortText = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    const open = `<${el.localName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    return /^(input|img|br|hr|meta|link)$/.test(el.localName) ? open : `${open}${shortText}</${el.localName}>`;
  }

  // ------------------------------------------------------------------ actionability
  const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  function deepElementFromPoint(x: number, y: number): Element | null {
    let root: Document | ShadowRoot = document;
    let el: Element | null = null;
    for (let i = 0; i < 20; i++) {
      const hit: Element | null = root.elementFromPoint(x, y);
      if (!hit || hit === el) break;
      el = hit;
      if (hit.shadowRoot) root = hit.shadowRoot;
      else break;
    }
    return el;
  }

  function composedContains(ancestor: Element, node: Element): boolean {
    for (let e: Element | null = node; e; e = parentElementOrHost(e)) if (e === ancestor) return true;
    return false;
  }

  function actionPoint(el: Element, position?: { x: number; y: number }): { x: number; y: number } | undefined {
    const r = el.getBoundingClientRect();
    if (position) return { x: r.left + position.x, y: r.top + position.y };
    const rects = Array.from(el.getClientRects()).filter((q) => q.width > 0 && q.height > 0);
    const q = rects[0] ?? r;
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const left = Math.max(q.left, 0);
    const top = Math.max(q.top, 0);
    const right = Math.min(q.right, vw);
    const bottom = Math.min(q.bottom, vh);
    if (right <= left || bottom <= top) return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }

  function inViewport(el: Element): boolean {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    return r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
  }

  async function actionability(el: Element, action: ActionKind, options?: ActionabilityOptions): Promise<ActionabilityResult> {
    if (!el.isConnected) return { ok: false, reason: 'element is not attached to the DOM', retry: true };
    const pointer = /^(click|dblclick|hover|tap|check|uncheck|dragTo)$/.test(action);
    const needsVisible = action !== 'focus' && action !== 'setInputFiles';
    const needsStable = pointer || action === 'selectText' || action === 'scrollIntoView' || action === 'screenshot';
    const needsEnabled = pointer ? action !== 'hover' : /^(fill|type|clear|selectOption)$/.test(action);
    const needsEditable = /^(fill|type|clear)$/.test(action);
    if (!options?.force) {
      if (needsVisible && !isVisible(el)) return { ok: false, reason: 'element is not visible', retry: true };
      if (needsEnabled && isDisabled(el)) return { ok: false, reason: 'element is disabled', retry: true };
      if (needsEditable) {
        if (!isEditableKind(el)) {
          return { ok: false, reason: 'Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]', retry: false };
        }
        if (isReadonly(el)) return { ok: false, reason: 'element is not editable', retry: true };
      }
    }
    if (pointer || needsStable) {
      if (!inViewport(el)) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      }
    }
    if (needsStable && !options?.force) {
      const a = el.getBoundingClientRect();
      await raf();
      await raf();
      const b = el.getBoundingClientRect();
      if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return { ok: false, reason: 'element is not stable', retry: true };
    }
    if (!pointer) return { ok: true };
    const point = actionPoint(el, options?.position);
    if (!point) return { ok: false, reason: 'element has no box', retry: true };
    if (!options?.force) {
      const hit = deepElementFromPoint(point.x, point.y);
      const ok = !!hit && (composedContains(el, hit) || ((hit as HTMLLabelElement).control === el) || (hit.closest('label') as HTMLLabelElement | null)?.control === el);
      if (!ok) {
        return { ok: false, reason: hit ? `${describe(hit)} intercepts pointer events` : 'element is outside of the viewport', retry: true };
      }
    }
    return { ok: true, point };
  }

  // ------------------------------------------------------------------ aria snapshot (simple)
  function ariaSnapshot(root: Element): string {
    const lines: string[] = [];
    const visit = (el: Element, depth: number) => {
      if (isHiddenForAria(el)) return;
      const r = role(el);
      let next = depth;
      if (r && r !== 'generic' && r !== 'presentation' && r !== 'none') {
        const name = accessibleName(el);
        const attrs: string[] = [];
        const lv = /^h([1-6])$/.exec(el.localName);
        if (r === 'heading') attrs.push(`[level=${el.getAttribute('aria-level') ?? (lv ? lv[1] : '2')}]`);
        const c = checkedState(el);
        if (c !== undefined) attrs.push(c === 'mixed' ? '[checked=mixed]' : c ? '[checked]' : '');
        if (isDisabled(el)) attrs.push('[disabled]');
        lines.push(`${'  '.repeat(depth)}- ${r}${name ? ` ${JSON.stringify(name)}` : ''}${attrs.filter(Boolean).map((a) => ` ${a}`).join('')}`);
        next = depth + 1;
      } else {
        // Plain text directly under a non-role element.
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => (n as Text).data).join('');
        if (norm(own) && !el.children.length) lines.push(`${'  '.repeat(depth)}- text: ${JSON.stringify(norm(own))}`);
      }
      if (r && nameFromContentRoles.has(r)) return;
      for (const c of Array.from(el.shadowRoot ? el.shadowRoot.children : el.children)) visit(c, next);
    };
    visit(root, 0);
    return lines.join('\n');
  }

  return {
    version: 'eztest-stub-engine/1',
    query,
    actionability,
    elementState,
    accessibleName: (el: Element) => accessibleName(el),
    role: (el: Element) => role(el),
    describe,
    ariaSnapshot,
  };
}

/** Source of an expression evaluating to the stub engine. */
export function engineSource(): string {
  return `(${createStubEngine.toString()})()`;
}
