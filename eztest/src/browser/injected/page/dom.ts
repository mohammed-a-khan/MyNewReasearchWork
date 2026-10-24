/**
 * DOM helpers shared by the page-side engine: flat-tree navigation across
 * open shadow roots and slots, shadow-including traversal, text
 * normalisation and per-call caches.
 *
 * Runs in the page. No imports from Node, no runtime dependencies.
 */

/** Collapse runs of whitespace (incl. NBSP) to one space and trim. */
export function normalizeWhitespace(s: string): string {
  return s.replace(PRIVATE_USE, '').replace(/[\s ​]+/g, ' ').trim();
}

/**
 * Private Use Area characters: the glyphs of icon fonts (Material Icons, Font Awesome, Bootstrap Icons) put in
 * text or in ::before content. They are icons, not words (screen readers say nothing), so a "Products" link with
 * a cart icon in front is named and matched as "Products".
 */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g;

export function isElement(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === 1;
}

export function lowerTag(el: Element): string {
  return el.localName || el.nodeName.toLowerCase();
}

/**
 * Parent in the flat tree: the assigned slot for slotted nodes, the host for
 * shadow-root children, else the parent element.
 */
export function flatParent(node: Node): Element | null {
  const slot = (node as Element | Text).assignedSlot;
  if (slot) return slot;
  const p = node.parentNode;
  if (!p) return null;
  if (p.nodeType === 11) return (p as ShadowRoot).host ?? null;
  return isElement(p) ? p : null;
}

/** Parent across shadow boundaries but ignoring slots (the composed DOM parent). */
export function composedParent(node: Node): Element | null {
  const p = node.parentNode;
  if (!p) return null;
  if (p.nodeType === 11) return (p as ShadowRoot).host ?? null;
  return isElement(p) ? p : null;
}

/**
 * Children in the flat tree: a shadow host renders its shadow root's
 * children; a slot renders its assigned nodes, or its own children when
 * nothing is assigned; other elements render their children.
 */
export function flatChildren(node: Node): Node[] {
  if (isElement(node)) {
    const sr = node.shadowRoot;
    if (sr) return Array.from(sr.childNodes);
    if (lowerTag(node) === 'slot') {
      const assigned = (node as HTMLSlotElement).assignedNodes();
      if (assigned.length) return assigned;
    }
  }
  return Array.from(node.childNodes);
}

/** `flatChildren` without allocating for the common case (no shadow root, not a slot). */
export function forEachFlatChild(node: Node, tag: string, cb: (child: Node) => void): void {
  const sr = (node as Element).shadowRoot;
  if (sr) {
    for (let c = sr.firstChild; c; c = c.nextSibling) cb(c);
    return;
  }
  if (tag === 'slot') {
    const assigned = (node as HTMLSlotElement).assignedNodes();
    if (assigned.length) {
      for (const c of assigned) cb(c);
      return;
    }
  }
  for (let c = node.firstChild; c; c = c.nextSibling) cb(c);
}

/** True when `ancestor` is `node` or one of its flat-tree or composed ancestors. */
export function containsDeep(ancestor: Node, node: Node | null): boolean {
  for (let n: Node | null = node; n; ) {
    if (n === ancestor) return true;
    const slot = (n as Element).assignedSlot;
    if (slot && slot === ancestor) return true;
    const p: Node | null = n.parentNode;
    n = p && p.nodeType === 11 ? (p as ShadowRoot).host : p;
  }
  return false;
}

/** Element by id in the same tree (document or shadow root) as `el`. */
export function getByIdInTree(el: Element, id: string): Element | null {
  const root = el.getRootNode() as Document | ShadowRoot;
  if (root && typeof (root as Document).getElementById === 'function') return (root as Document).getElementById(id);
  return el.ownerDocument.getElementById(id);
}

/** Elements referenced by an IDREFS attribute, in attribute order, without misses. */
export function idrefs(el: Element, attr: string): Element[] {
  const v = el.getAttribute(attr);
  if (!v) return [];
  const out: Element[] = [];
  for (const id of v.split(/\s+/)) {
    if (!id) continue;
    const t = getByIdInTree(el, id);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link']);
export function isNonRenderedTag(tag: string): boolean {
  return SKIP_TEXT_TAGS.has(tag);
}

type Tree = Document | Element | ShadowRoot;

/** Elements of `tree` itself (not inside nested shadow trees) that host an open shadow root, in order. */
function shadowHostsIn(tree: Tree): Element[] {
  const memo = callMemo<Tree, Element[]>('hosts');
  const cached = memo?.get(tree);
  if (cached) return cached;
  const all = tree.querySelectorAll('*');
  const hosts: Element[] = [];
  for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) hosts.push(all[i]);
  memo?.set(tree, hosts);
  return hosts;
}

/**
 * `querySelectorAll(selector)` under `root`, piercing open shadow roots, in
 * shadow-including tree order (a host's shadow tree comes right after the
 * host, before its light descendants). Each tree's matches come from the
 * browser; trees are merged around their hosts, so no sorting is needed.
 */
export function deepQuery(root: Tree, selector: string): Element[] {
  const out: Element[] = [];
  const visit = (tree: Tree) => {
    const matches = tree.querySelectorAll(selector);
    const hosts = shadowHostsIn(tree);
    let i = 0;
    let j = 0;
    while (i < matches.length || j < hosts.length) {
      if (j >= hosts.length) {
        out.push(matches[i++]);
      } else if (i >= matches.length) {
        visit(hosts[j++].shadowRoot as ShadowRoot);
      } else {
        const m = matches[i];
        const h = hosts[j];
        if (m === h) {
          out.push(m);
          i++;
          visit(h.shadowRoot as ShadowRoot);
          j++;
        } else if (m.compareDocumentPosition(h) & 4 /* h follows m */) {
          out.push(m);
          i++;
        } else {
          visit(h.shadowRoot as ShadowRoot);
          j++;
        }
      }
    }
  };
  if (isElement(root as Node) && (root as Element).shadowRoot) visit((root as Element).shadowRoot as ShadowRoot);
  visit(root);
  return out;
}

/** Every element under `root` (descendants only), shadow-including tree order. `pierce = false` stays in the root's tree. */
export function deepElements(root: Tree, pierce = true): Element[] {
  if (!pierce) return Array.from(root.querySelectorAll('*'));
  const memo = callMemo<Tree, Element[]>('deepElements');
  const cached = memo?.get(root);
  if (cached) return cached;
  const all = deepQuery(root, '*');
  memo?.set(root, all);
  return all;
}

/**
 * Order elements in shadow-including document order and drop duplicates.
 * Plain `compareDocumentPosition` cannot order nodes in different shadow
 * trees, so positions come from one deep traversal when needed.
 */
export function sortDocumentOrder(els: Element[]): Element[] {
  const uniq = Array.from(new Set(els));
  if (uniq.length < 2) return uniq;
  let sameTree = true;
  const r0 = uniq[0].getRootNode();
  for (const e of uniq) if (e.getRootNode() !== r0) { sameTree = false; break; }
  if (sameTree) {
    return uniq.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1; // b follows a
      if (pos & 2) return 1;
      return 0;
    });
  }
  // Mixed trees: index the whole document once per call.
  const doc = uniq[0].ownerDocument;
  const memo = callMemo<Document, Map<Element, number>>('docIndex');
  let index = memo?.get(doc);
  if (!index) {
    index = new Map<Element, number>();
    deepElements(doc).forEach((e, i) => (index as Map<Element, number>).set(e, i));
    memo?.set(doc, index);
  }
  const ix = index;
  return uniq.sort((a, b) => (ix.get(a) ?? 1e9) - (ix.get(b) ?? 1e9));
}

/** Per-call memo for computed styles (reset at the start of each public call). */
let styleCache: Map<Element, CSSStyleDeclaration> | null = null;
let pseudoCache: Map<string, Map<Element, CSSStyleDeclaration>> | null = null;
let memos: Map<string, Map<unknown, unknown>> | null = null;
let depth = 0;

/** A per-call memo table (null outside a public engine call). */
export function callMemo<K, V>(name: string): Map<K, V> | null {
  if (!memos) return null;
  let m = memos.get(name);
  if (!m) memos.set(name, (m = new Map()));
  return m as Map<K, V>;
}

export function withCaches<T>(fn: () => T): T {
  if (depth === 0) {
    styleCache = new Map();
    pseudoCache = new Map();
    memos = new Map();
  }
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    if (depth === 0) {
      styleCache = null;
      pseudoCache = null;
      memos = null;
    }
  }
}

interface PseudoIndex {
  /** Some rule could not be read or analysed: every element may have generated content. */
  any: boolean;
  /** Selectors (without the pseudo-element) of rules that target ::before / ::after, as one list. */
  list: string;
  parts: string[];
}

const PSEUDO_RE = /::?(before|after)\b/i;

/** Rules of a sheet (and of its @media / @supports / @layer / @container blocks, imports, nesting). */
function collectPseudoSelectors(rules: CSSRuleList, out: PseudoIndex, depth = 0): void {
  if (depth > 8) {
    out.any = true;
    return;
  }
  for (const rule of Array.from(rules)) {
    const r = rule as CSSRule & { selectorText?: string; cssRules?: CSSRuleList; styleSheet?: CSSStyleSheet; style?: CSSStyleDeclaration };
    if (r.type === 3 /* IMPORT_RULE */) {
      try {
        if (r.styleSheet) collectPseudoSelectors(r.styleSheet.cssRules, out, depth + 1);
      } catch {
        out.any = true;
      }
      continue;
    }
    if (typeof r.selectorText === 'string') {
      const sel = r.selectorText;
      if (r.cssRules && r.cssRules.length) {
        // CSS nesting: nested selectors are relative to this one; do not try to resolve them.
        for (const n of Array.from(r.cssRules)) if (PSEUDO_RE.test((n as CSSRule & { selectorText?: string }).selectorText ?? '')) out.any = true;
      }
      if (!PSEUDO_RE.test(sel)) continue;
      if (!r.style || !r.style.getPropertyValue('content')) continue; // no `content`: generates nothing
      for (const one of sel.split(',')) {
        if (!PSEUDO_RE.test(one)) continue;
        if (/:host|::slotted|::part|&/.test(one)) {
          out.any = true;
          continue;
        }
        const base = one.replace(/::?(before|after)\b/gi, '').trim() || '*';
        out.parts.push(base);
      }
      continue;
    }
    if (r.cssRules) collectPseudoSelectors(r.cssRules, out, depth + 1);
  }
}

/** The ::before/::after rules that apply in an element's tree (document or shadow root), memoised per call. */
function pseudoIndex(el: Element): PseudoIndex {
  const root = el.getRootNode() as Document | ShadowRoot;
  const memo = callMemo<Node, PseudoIndex>('pseudoIndex');
  const hit = memo?.get(root);
  if (hit) return hit;
  const out: PseudoIndex = { any: false, list: '', parts: [] };
  const sheets: CSSStyleSheet[] = [];
  const add = (r: Document | ShadowRoot) => {
    sheets.push(...Array.from(r.styleSheets ?? []));
    sheets.push(...Array.from((r as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []));
  };
  add(root);
  if (root !== el.ownerDocument) add(el.ownerDocument);
  for (const sheet of sheets) {
    try {
      collectPseudoSelectors(sheet.cssRules, out);
    } catch {
      out.any = true; // cross-origin sheet: unreadable
    }
    if (out.any) break;
  }
  out.list = out.parts.join(',');
  memo?.set(root, out);
  return out;
}

/**
 * Can `el` have ::before / ::after generated content? False only when no readable style rule
 * with a `content` declaration targets a pseudo-element of an element like it (UA styles give
 * generated content to <q> only). Lets the accessible-name computation skip the expensive
 * pseudo-element style for nearly every element.
 */
export function mayHavePseudoContent(el: Element): boolean {
  if (lowerTag(el) === 'q' || el.shadowRoot) return true;
  const idx = pseudoIndex(el);
  if (idx.any) return true;
  if (!idx.parts.length) return false;
  try {
    return el.matches(idx.list);
  } catch {
    // One selector the engine does not take (vendor prefix, unknown pseudo-class): check one by one.
    return idx.parts.some((sel) => {
      try {
        return el.matches(sel);
      } catch {
        return true;
      }
    });
  }
}

export function style(el: Element, pseudo?: '::before' | '::after'): CSSStyleDeclaration {
  const win = el.ownerDocument.defaultView ?? window;
  if (pseudo) {
    if (!pseudoCache) return win.getComputedStyle(el, pseudo);
    let m = pseudoCache.get(pseudo);
    if (!m) pseudoCache.set(pseudo, (m = new Map()));
    let s = m.get(el);
    if (!s) m.set(el, (s = win.getComputedStyle(el, pseudo)));
    return s;
  }
  if (!styleCache) return win.getComputedStyle(el);
  let s = styleCache.get(el);
  if (!s) styleCache.set(el, (s = win.getComputedStyle(el)));
  return s;
}

/** Truncate for messages. */
export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** CSS-ish short label: tag#id or tag.class1.class2. */
export function cssLabel(el: Element): string {
  let s = lowerTag(el);
  if (el.id) return s + '#' + cssIdent(el.id);
  const cls = Array.from(el.classList || []).filter((c) => c && c.length < 40).slice(0, 2);
  if (cls.length) s += '.' + cls.map(cssIdent).join('.');
  return s;
}

function cssIdent(s: string): string {
  return /^[A-Za-z_-][\w-]*$/.test(s) ? s : s.replace(/[^\w-]/g, (c) => '\\' + c);
}
