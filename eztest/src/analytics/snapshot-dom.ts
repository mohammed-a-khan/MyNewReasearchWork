/**
 * A small, strict reader for the DOM snapshots EZTest's trace serializer
 * writes (src/runner/trace/serializer.ts): every element carries
 * `data-ez-nid`, text and attribute values are escaped, void elements have no
 * end tag, `<style>` holds raw CSS, same-origin iframes are nested documents
 * in `srcdoc` and open shadow roots are `<template shadowrootmode>`.
 *
 * It extracts the interactive elements of a snapshot by accessible role and
 * name (a deterministic subset of the ARIA role and accname rules), for the UI
 * coverage map. Nothing is executed: the HTML is only tokenized.
 */

export interface SnapNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<SnapNode | string>;
  parent?: SnapNode;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['style', 'script', 'textarea', 'title']);

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** Parse snapshot HTML into a tree (tolerant: unknown end tags are ignored, unclosed elements close at the end). */
export function parseSnapshotHtml(html: string): SnapNode {
  const root: SnapNode = { tag: '#document', attrs: {}, children: [] };
  let cur = root;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      cur.children.push(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) cur.children.push(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end < 0 ? n : end).trim().toLowerCase();
      for (let p: SnapNode | undefined = cur; p && p !== root; p = p.parent) {
        if (p.tag === name) {
          cur = p.parent ?? root;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Start tag: find the closing ">" outside quotes.
    let j = lt + 1;
    let q: string | undefined;
    for (; j < n; j++) {
      const c = html[j];
      if (q) {
        if (c === q) q = undefined;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    const inner = html.slice(lt + 1, j);
    const m = /^([A-Za-z][\w:-]*)/.exec(inner);
    if (!m) {
      cur.children.push('<');
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs: Record<string, string> = {};
    const rest = inner.slice(m[1].length);
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(rest); a; a = ATTR.exec(rest)) {
      const name = a[1].toLowerCase();
      if (name === '/') continue;
      attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    const node: SnapNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    i = j + 1;
    if (VOID.has(tag) || inner.endsWith('/')) continue;
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const text = html.slice(i, close < 0 ? n : close);
      node.children.push(tag === 'style' || tag === 'script' ? text : decodeEntities(text));
      const gt = close < 0 ? n : html.indexOf('>', close);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

export function* walk(node: SnapNode): Generator<SnapNode> {
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    yield c;
    yield* walk(c);
  }
}

const SKIP_TEXT = new Set(['style', 'script', 'template', 'head', 'title', 'noscript', 'select', 'datalist', 'option']);

/** Visible-ish text content (alt of images included), whitespace collapsed. */
export function textOf(node: SnapNode | string, depth = 0): string {
  if (typeof node === 'string') return node;
  if (depth > 40) return '';
  if (node.tag === 'img' || (node.tag === 'input' && node.attrs.type === 'image')) return node.attrs.alt ? ` ${node.attrs.alt} ` : '';
  if (SKIP_TEXT.has(node.tag) || isHiddenSelf(node)) return '';
  const inline = node.tag === 'span' || node.tag === 'b' || node.tag === 'strong' || node.tag === 'em' || node.tag === 'i' || node.tag === 'a' || node.tag === 'code';
  const parts = node.children.map((c) => textOf(c, depth + 1)).join(inline ? '' : ' ');
  return inline ? parts : ` ${parts} `;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function isHiddenSelf(n: SnapNode): boolean {
  const a = n.attrs;
  if ('hidden' in a || a['aria-hidden'] === 'true' || a['data-ez-hidden'] === '1') return true;
  if (n.tag === 'input' && (a.type ?? '').toLowerCase() === 'hidden') return true;
  const st = (a.style ?? '').toLowerCase().replace(/\s+/g, '');
  return /(?:^|;)display:none/.test(st) || /(?:^|;)visibility:hidden/.test(st);
}

/** Hidden by itself or an ancestor (attribute-level: hidden, aria-hidden, inline display/visibility, the serializer's marker). */
export function isHidden(n: SnapNode): boolean {
  for (let p: SnapNode | undefined = n; p && p.tag !== '#document'; p = p.parent) {
    if (isHiddenSelf(p)) return true;
    if (p.tag === 'head' || (p.tag === 'template' && !('shadowrootmode' in p.attrs))) return true;
    if (p.tag === 'details' && !('open' in p.attrs) && p !== n && !isSummaryPath(n, p)) return true;
  }
  return false;
}

function isSummaryPath(n: SnapNode, details: SnapNode): boolean {
  for (let p: SnapNode | undefined = n; p && p !== details; p = p.parent) if (p.tag === 'summary' && p.parent === details) return true;
  return false;
}

/** Roles that count as interactive elements in the coverage map. */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'option',
]);

const INPUT_ROLE: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
  number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox',
  date: 'textbox', 'datetime-local': 'textbox', month: 'textbox', week: 'textbox', time: 'textbox', color: 'button',
};

/** The element's role (explicit `role`, else the implicit role of its tag), or undefined. */
export function roleOf(n: SnapNode): string | undefined {
  const explicit = (n.attrs.role ?? '').trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) return explicit;
  switch (n.tag) {
    case 'a': case 'area': return 'href' in n.attrs ? 'link' : undefined;
    case 'button': return 'button';
    case 'summary': return 'button';
    case 'select': return 'multiple' in n.attrs || Number(n.attrs.size ?? 0) > 1 ? 'listbox' : 'combobox';
    case 'textarea': return 'textbox';
    case 'input': return INPUT_ROLE[(n.attrs.type ?? 'text').toLowerCase()] ?? 'textbox';
    default:
      if ((n.attrs.contenteditable ?? '').toLowerCase() === 'true' || n.attrs.contenteditable === '') return 'textbox';
      return undefined;
  }
}

export interface DocIndex {
  byId: Map<string, SnapNode>;
  labelsFor: Map<string, SnapNode[]>;
}

export function indexDoc(root: SnapNode): DocIndex {
  const byId = new Map<string, SnapNode>();
  const labelsFor = new Map<string, SnapNode[]>();
  for (const n of walk(root)) {
    if (n.attrs.id && !byId.has(n.attrs.id)) byId.set(n.attrs.id, n);
    if (n.tag === 'label' && n.attrs.for) labelsFor.set(n.attrs.for, [...(labelsFor.get(n.attrs.for) ?? []), n]);
  }
  return { byId, labelsFor };
}

const DEFAULT_BUTTON: Record<string, string> = { submit: 'Submit', reset: 'Reset', file: 'Choose file' };

/** Accessible name (aria-labelledby, aria-label, label, content, title, placeholder), whitespace collapsed. */
export function accessibleName(n: SnapNode, idx: DocIndex): string {
  const a = n.attrs;
  if (a['aria-labelledby']) {
    const t = clean(a['aria-labelledby'].split(/\s+/).map((id) => { const x = idx.byId.get(id); return x ? textOf(x) : ''; }).join(' '));
    if (t) return t;
  }
  if (a['aria-label']?.trim()) return clean(a['aria-label']);
  const role = roleOf(n);
  const formControl = n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea';
  if (n.tag === 'input') {
    const type = (a.type ?? 'text').toLowerCase();
    if (type === 'image' && a.alt) return clean(a.alt);
    if (['submit', 'reset', 'button'].includes(type)) return clean(a.value ?? '') || DEFAULT_BUTTON[type] || '';
  }
  if (formControl || role === 'textbox' || role === 'combobox' || role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'slider' || role === 'spinbutton') {
    const labels = a.id ? idx.labelsFor.get(a.id) ?? [] : [];
    let t = clean(labels.map((l) => textOf(l)).join(' '));
    if (!t) {
      for (let p = n.parent; p && p.tag !== '#document'; p = p.parent) {
        if (p.tag === 'label') {
          t = clean(textOf(p));
          break;
        }
      }
    }
    if (t) return t;
    if (!formControl) {
      const c = clean(textOf(n));
      if (c) return c;
    }
    return clean(a.title ?? '') || clean(a.placeholder ?? '') || clean(a['aria-placeholder'] ?? '');
  }
  const content = clean(textOf(n));
  return content || clean(a.title ?? '') || clean(a.alt ?? '');
}

export interface SnapshotElement {
  nid: number;
  role: string;
  name: string;
  tag: string;
  /** Short identifying attributes for unnamed elements and locator matching. */
  id?: string;
  testId?: string;
  nameAttr?: string;
  href?: string;
  disabled?: boolean;
  /** Same-origin iframe nesting depth (0: the main document). */
  frame: number;
}

/** Nearest element (itself or an ancestor) with an interactive role, for mapping a click target to its control. */
export function interactiveAncestor(n: SnapNode): SnapNode | undefined {
  for (let p: SnapNode | undefined = n; p && p.tag !== '#document'; p = p.parent) {
    const r = roleOf(p);
    if (r && INTERACTIVE_ROLES.has(r)) return p;
  }
  return undefined;
}

export interface ParsedSnapshot {
  elements: SnapshotElement[];
  /** nid -> element (all elements, for target lookups). */
  nodes: Map<number, SnapNode>;
  /** nid -> nid of the interactive element it belongs to. */
  owner(nid: number): number | undefined;
}

/** All visible interactive elements of a snapshot (iframes included), in document order. */
export function interactiveElements(html: string, opts: { testIdAttribute?: string } = {}): ParsedSnapshot {
  const testAttr = opts.testIdAttribute ?? 'data-testid';
  const elements: SnapshotElement[] = [];
  const nodes = new Map<number, SnapNode>();
  const visit = (doc: string, frame: number) => {
    if (frame > 4) return;
    const root = parseSnapshotHtml(doc);
    const idx = indexDoc(root);
    for (const n of walk(root)) {
      const nid = Number(n.attrs['data-ez-nid']);
      if (Number.isFinite(nid) && nid > 0) nodes.set(nid, n);
      if (n.tag === 'iframe' && n.attrs.srcdoc) visit(n.attrs.srcdoc, frame + 1);
      const role = roleOf(n);
      if (!role || !INTERACTIVE_ROLES.has(role) || !Number.isFinite(nid)) continue;
      // An <option> is part of its select; ARIA options (listbox popups) count.
      if (n.tag === 'option') continue;
      if (isHidden(n)) continue;
      const a = n.attrs;
      elements.push({
        nid, role, name: accessibleName(n, idx).slice(0, 120), tag: n.tag, frame,
        ...(a.id ? { id: a.id } : {}), ...(a[testAttr] ? { testId: a[testAttr] } : {}), ...(a.name ? { nameAttr: a.name } : {}),
        ...(role === 'link' && a.href ? { href: a.href } : {}),
        ...('disabled' in a || a['aria-disabled'] === 'true' ? { disabled: true } : {}),
      });
    }
  };
  visit(html, 0);
  const own = new Map(elements.map((e) => [e.nid, e.nid]));
  return {
    elements,
    nodes,
    owner(nid: number) {
      const hit = own.get(nid);
      if (hit) return hit;
      const n = nodes.get(nid);
      const a = n ? interactiveAncestor(n) : undefined;
      const anid = a ? Number(a.attrs['data-ez-nid']) : NaN;
      return Number.isFinite(anid) && own.has(anid) ? anid : undefined;
    },
  };
}
