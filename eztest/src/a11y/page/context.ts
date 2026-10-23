/**
 * The scan context of one engine run: the documents it reaches (the
 * evaluating document, its open shadow trees and same-origin frames), the
 * include/exclude scope, selector paths, element boxes and the result
 * collector the rules report into.
 */
import { deepElements, deepQuery, isElement, lowerTag } from '../../browser/injected/page/dom.js';
import type { PageBox, PageNode, PageRuleResult } from '../protocol.js';

export interface DocInfo {
  doc: Document;
  /** Selector paths of the frame elements leading to this document from the evaluating one. */
  framePath: string[];
  /** Position of this document's viewport inside the evaluating document's viewport. */
  offset: { x: number; y: number };
  frameElement: Element | null;
  /** The evaluating document. */
  top: boolean;
  elements: Element[];
}

export type Outcome = 'fail' | 'review';

export class Ctx {
  readonly docs: DocInfo[] = [];
  readonly results: Record<string, PageRuleResult> = {};
  private readonly docOfDocument = new Map<Document, DocInfo>();
  private readonly reported = new Map<string, Set<Element>>();
  private readonly scopeMemo = new Map<Element, boolean>();
  private readonly includes: Set<Element> | null;
  private readonly excludes: Set<Element>;
  private byTagIndex: Map<string, Element[]> | null = null;
  private allIndex: Element[] | null = null;
  current = '';

  constructor(readonly root: Document, opts: { include?: string[]; exclude?: string[]; maxNodes?: number }, readonly maxNodes = opts.maxNodes ?? 100) {
    this.addDoc(root, [], { x: 0, y: 0 }, null, true);
    this.includes = opts.include?.length ? new Set(opts.include.flatMap((s) => resolveSelector(root, s))) : null;
    this.excludes = new Set((opts.exclude ?? []).flatMap((s) => resolveSelector(root, s)));
  }

  private addDoc(doc: Document, framePath: string[], offset: { x: number; y: number }, frameElement: Element | null, top: boolean): void {
    const info: DocInfo = { doc, framePath, offset, frameElement, top, elements: doc.documentElement ? [doc.documentElement, ...deepElements(doc.documentElement)] : [] };
    this.docs.push(info);
    this.docOfDocument.set(doc, info);
    for (const el of info.elements) {
      const tag = lowerTag(el);
      if (tag !== 'iframe' && tag !== 'frame') continue;
      let child: Document | null = null;
      try {
        child = (el as HTMLIFrameElement).contentDocument;
      } catch {
        child = null;
      }
      if (!child || !child.documentElement || this.docOfDocument.has(child)) continue;
      const r = el.getBoundingClientRect();
      const s = doc.defaultView!.getComputedStyle(el);
      const off = {
        x: offset.x + r.left + parseFloat(s.borderLeftWidth || '0') + parseFloat(s.paddingLeft || '0'),
        y: offset.y + r.top + parseFloat(s.borderTopWidth || '0') + parseFloat(s.paddingTop || '0'),
      };
      this.addDoc(child, [...framePath, this.localSelector(el)], off, el, false);
    }
  }

  /** Every element of every reached document, shadow-including tree order. */
  all(): Element[] {
    if (!this.allIndex) this.allIndex = this.docs.flatMap((d) => d.elements);
    return this.allIndex;
  }

  byTag(tag: string): Element[] {
    if (!this.byTagIndex) {
      this.byTagIndex = new Map();
      for (const el of this.all()) {
        const t = lowerTag(el);
        let l = this.byTagIndex.get(t);
        if (!l) this.byTagIndex.set(t, (l = []));
        l.push(el);
      }
    }
    return this.byTagIndex.get(tag) ?? [];
  }

  tags(...tags: string[]): Element[] {
    if (tags.length === 1) return this.byTag(tags[0]);
    const set = new Set<Element>();
    for (const t of tags) for (const e of this.byTag(t)) set.add(e);
    return this.all().filter((e) => set.has(e));
  }

  docOf(el: Element): DocInfo {
    return this.docOfDocument.get(el.ownerDocument) ?? this.docs[0];
  }

  /** Inside the include scope (when given) and outside every excluded element; climbs out of frames. */
  inScope(el: Element): boolean {
    const memo = this.scopeMemo.get(el);
    if (memo !== undefined) return memo;
    let included = !this.includes;
    let excluded = false;
    for (let n: Element | null = el; n; ) {
      if (this.excludes.has(n)) {
        excluded = true;
        break;
      }
      if (this.includes?.has(n)) included = true;
      const p: Node | null = n.parentNode;
      if (p && p.nodeType === 11) n = (p as ShadowRoot).host;
      else if (p && isElement(p)) n = p;
      else n = this.docOfDocument.get(n.ownerDocument)?.frameElement ?? null;
    }
    const r = included && !excluded;
    this.scopeMemo.set(el, r);
    return r;
  }

  private bucket(rule: string): PageRuleResult {
    let b = this.results[rule];
    if (!b) this.results[rule] = b = { fail: [], review: [], failCount: 0, reviewCount: 0, pass: 0 };
    return b;
  }

  /** Make sure a rule that ran but found nothing applicable still appears (as inapplicable). */
  touch(rule: string): void {
    this.bucket(rule);
  }

  report(outcome: Outcome, el: Element, message: string, rule = this.current): void {
    if (!this.inScope(el)) return;
    const key = `${rule}|${outcome}`;
    let seen = this.reported.get(key);
    if (!seen) this.reported.set(key, (seen = new Set()));
    if (seen.has(el)) return;
    seen.add(el);
    const b = this.bucket(rule);
    if (outcome === 'fail') {
      b.failCount++;
      if (b.fail.length < this.maxNodes) b.fail.push(this.node(el, message));
    } else {
      b.reviewCount++;
      if (b.review.length < this.maxNodes) b.review.push(this.node(el, message));
    }
  }

  fail(el: Element, message: string): void {
    this.report('fail', el, message);
  }

  review(el: Element, message: string): void {
    this.report('review', el, message);
  }

  pass(el: Element, rule = this.current): void {
    if (!this.inScope(el)) return;
    this.bucket(rule).pass++;
  }

  node(el: Element, message: string): PageNode {
    return { target: this.selectorPath(el), html: startTag(el), message, box: this.box(el) };
  }

  box(el: Element): PageBox | undefined {
    if (!el.isConnected) return undefined;
    const r = el.getBoundingClientRect();
    const o = this.docOf(el).offset;
    return { x: r.left + o.x, y: r.top + o.y, width: r.width, height: r.height };
  }

  /** Selector path from the evaluating document: frames as separate entries, shadow hops joined with " >>> ". */
  selectorPath(el: Element): string[] {
    return [...this.docOf(el).framePath, this.localSelector(el)];
  }

  localSelector(el: Element): string {
    return localSelector(el);
  }
}

/** Selector of an element in its own document, piercing shadow roots with " >>> ". */
export function localSelector(el: Element): string {
  const hops: string[] = [];
  for (let cur: Element | null = el; cur; ) {
    const root = cur.getRootNode() as Document | ShadowRoot;
    hops.unshift(treeSelector(cur, root));
    cur = root.nodeType === 11 ? (root as ShadowRoot).host : null;
  }
  return hops.join(' >>> ');
}

function resolveSelector(root: Document, sel: string): Element[] {
  const hops = sel.split(/\s*>>>\s*/);
  let scope: Array<Document | ShadowRoot> = [root];
  let found: Element[] = [];
  for (let i = 0; i < hops.length; i++) {
    found = [];
    for (const s of scope) {
      try {
        found.push(...(i === 0 ? deepQuery(s, hops[i]) : Array.from(s.querySelectorAll(hops[i]))));
      } catch {
        throw new Error(`Invalid selector in include/exclude: ${sel}`);
      }
    }
    scope = found.map((e) => e.shadowRoot).filter((r): r is ShadowRoot => !!r);
  }
  return found;
}

function cssEscape(s: string): string {
  const g = globalThis as unknown as { CSS?: { escape(s: string): string } };
  return g.CSS?.escape ? g.CSS.escape(s) : s.replace(/[^\w-]/g, (c) => '\\' + c);
}

function uniqueIn(root: Document | ShadowRoot, sel: string, el: Element): boolean {
  try {
    const m = root.querySelectorAll(sel);
    return m.length === 1 && m[0] === el;
  } catch {
    return false;
  }
}

/** A short selector unique in the element's tree (document or shadow root). */
function treeSelector(el: Element, root: Document | ShadowRoot): string {
  const tag = lowerTag(el);
  if (tag === 'html' && root.nodeType === 9) return 'html';
  if (el.id) {
    const s = `#${cssEscape(el.id)}`;
    if (uniqueIn(root, s, el)) return s;
  }
  for (const attr of ['data-testid', 'data-test-id', 'data-test']) {
    const v = el.getAttribute(attr);
    if (v) {
      const s = `${tag}[${attr}="${v.replace(/["\\]/g, '\\$&')}"]`;
      if (uniqueIn(root, s, el)) return s;
    }
  }
  const parts: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const t = lowerTag(cur);
    if (cur !== el && cur.id && uniqueIn(root, `#${cssEscape(cur.id)}`, cur)) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    if (t === 'html' || t === 'body') {
      parts.unshift(t);
      break;
    }
    let part = /^[a-z][a-z0-9-]*$/.test(t) ? t : '*';
    const parent = cur.parentElement ?? (cur.parentNode as ParentNode | null);
    if (parent) {
      const same = Array.from(parent.children).filter((c) => lowerTag(c) === t);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
  }
  // The full path is unique by construction; try a few shorter suffixes for readability.
  for (let k = 1; k < Math.min(parts.length, 4); k++) {
    const s = parts.slice(-k).join(' > ');
    if (uniqueIn(root, s, el)) return s;
  }
  return parts.join(' > ');
}

/** The start tag of an element, attributes included, at most 300 characters. */
export function startTag(el: Element): string {
  let s = `<${lowerTag(el)}`;
  for (const a of Array.from(el.attributes)) {
    const v = a.value.length > 80 ? a.value.slice(0, 79) + '…' : a.value;
    s += ` ${a.name}="${v.replace(/"/g, '&quot;')}"`;
    if (s.length > 300) break;
  }
  s += '>';
  return s.length > 300 ? s.slice(0, 299) + '…' : s;
}
