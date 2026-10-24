/**
 * Scoping and layout steps of the selector engine (page side):
 *
 * - `section`: containers labelled by a text: landmarks and groups by their
 *   accessible name (region, form, group, dialog, navigation, ...), a
 *   `<fieldset>` by its `<legend>`, and any element whose first heading-like
 *   descendant (h1-h6, role=heading, legend, summary, caption) has the text
 *   and which holds more than that heading. The innermost container wins.
 * - `row`: the row-like ancestor (tr, role=row, li, role=listitem/option/
 *   article, or an element repeated among its siblings with the same tag and
 *   class) of the innermost elements whose text matches.
 * - `layout`: keep elements of the working set that lie above / below / left
 *   of / right of / near the anchor elements (the anchor chain is evaluated
 *   from the same scope as the working set), measured with bounding boxes in
 *   the frame's viewport. With `nearest` (the default) only the elements at
 *   the smallest distance are kept, so "the field below Email" means the
 *   closest one; two at the same distance stay two (the single-match check reports
 *   them).
 */
import type { TextMatch } from '../contract.js';
import { containsDeep, flatParent, isElement, lowerTag, normalizeWhitespace } from './dom.js';
import { accessibleName } from './accname.js';
import { getRole } from './roles.js';
import { isVisible } from './visibility.js';

type Root = Document | Element;

const LANDMARK_ROLES = new Set([
  'region', 'form', 'group', 'dialog', 'alertdialog', 'navigation', 'complementary', 'main', 'banner', 'contentinfo',
  'tabpanel', 'article', 'search', 'radiogroup', 'toolbar', 'menu', 'list', 'table', 'grid', 'treegrid', 'tree', 'listbox',
]);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'summary', 'caption']);

function isHeadingLike(el: Element): boolean {
  if (HEADING_TAGS.has(lowerTag(el))) return true;
  return el.getAttribute('role') === 'heading';
}

/** Element children in tree order (light DOM plus an open shadow root's children). */
function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  const kids = el.shadowRoot ? el.shadowRoot.children : el.children;
  for (let i = 0; i < kids.length; i++) out.push(kids[i]);
  return out;
}

/** First heading-like descendant in tree order (depth-first, shadow roots pierced), or null. */
function firstHeading(el: Element): Element | null {
  const stack: Element[] = elementChildren(el).reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (isHeadingLike(n)) return n;
    const kids = elementChildren(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return null;
}

function allElements(root: Root): Element[] {
  const out: Element[] = [];
  const visit = (n: Element | Document | ShadowRoot) => {
    const kids = (n as Element).children ?? [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      out.push(k);
      if (k.shadowRoot) visit(k.shadowRoot);
      visit(k);
    }
  };
  visit(root);
  return out;
}

/** Keep the innermost elements: drop any element that contains another one of the set. */
function innermost(els: Element[]): Element[] {
  const set = [...new Set(els)];
  return set.filter((a) => !set.some((b) => b !== a && containsDeep(a, b)));
}

function textOf(el: Element): string {
  return normalizeWhitespace((el as HTMLElement).innerText ?? el.textContent ?? '');
}

/** Containers labelled by `match` (see the module comment). */
export function sectionAll(root: Root, match: (s: string) => boolean): Element[] {
  const out: Element[] = [];
  const all = allElements(root);
  for (const el of all) {
    const role = getRole(el);
    if (role && LANDMARK_ROLES.has(role)) {
      const name = accessibleName(el);
      if (name && match(name)) {
        out.push(el);
        continue;
      }
    }
    if (lowerTag(el) === 'fieldset') {
      const legend = elementChildren(el).find((c) => lowerTag(c) === 'legend');
      if (legend && match(textOf(legend))) {
        out.push(el);
        continue;
      }
    }
  }
  // Headed containers: from each matching heading, climb to the first ancestor that holds more than the heading's branch.
  for (const hd of all) {
    if (!isHeadingLike(hd) || !match(textOf(hd))) continue;
    let branch: Element = hd;
    let p = flatParent(hd);
    while (p && root !== p && (isElement(root) ? containsDeep(root, p) : true)) {
      if (lowerTag(p) === 'body' || lowerTag(p) === 'html') break;
      if (elementChildren(p).length > 1) {
        if (firstHeadingIsBranch(p, branch)) out.push(p);
        break;
      }
      branch = p;
      p = flatParent(p);
    }
  }
  return innermost(out);
}

/** The container's first heading lies in `branch` (the heading's own wrapper). */
function firstHeadingIsBranch(container: Element, branch: Element): boolean {
  const f = firstHeading(container);
  return !!f && (f === branch || containsDeep(branch, f));
}

const ROW_TAGS = new Set(['tr', 'li']);
const ROW_ROLES = new Set(['row', 'listitem', 'option', 'article', 'treeitem', 'menuitem', 'gridcell']);

function signature(el: Element): string {
  return `${lowerTag(el)}.${Array.from(el.classList).sort().join('.')}`;
}

/** Row-like: a table row, list item, ARIA row/listitem, or an element repeated among its siblings. */
function isRowLike(el: Element): boolean {
  if (ROW_TAGS.has(lowerTag(el))) return true;
  const r = el.getAttribute('role');
  if (r && ROW_ROLES.has(r) && r !== 'gridcell') return true;
  const p = el.parentElement;
  if (!p || lowerTag(el) === 'body' || lowerTag(p) === 'body' || lowerTag(el) === 'html') return false;
  const sig = signature(el);
  let same = 0;
  for (let i = 0; i < p.children.length; i++) if (signature(p.children[i]) === sig) same++;
  return same >= 2 && el.children.length > 0;
}

/** Rows containing text matching `match`, from the innermost text matches. */
export function rowAll(root: Root, textHits: Element[]): Element[] {
  const out = new Set<Element>();
  for (const hit of textHits) {
    let p: Element | null = hit;
    while (p && p !== root) {
      if (isRowLike(p)) {
        out.add(p);
        break;
      }
      p = flatParent(p);
    }
  }
  return [...out];
}

export type LayoutRelation = 'above' | 'below' | 'leftOf' | 'rightOf' | 'near';

interface Box { left: number; top: number; right: number; bottom: number }

function box(el: Element): Box | undefined {
  if (!isVisible(el)) return undefined;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return undefined;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Tolerance (px) for boxes that touch or overlap slightly. */
const TOL = 2;

/**
 * Distance from the anchor to a candidate for a relation, or undefined when the
 * candidate is not on that side. Directional relations weigh the off-axis gap
 * three times, so an aligned element beats a diagonal one.
 */
export function layoutDistance(rel: LayoutRelation, a: Box, c: Box): number | undefined {
  const gapX = Math.max(0, a.left - c.right, c.left - a.right);
  const gapY = Math.max(0, a.top - c.bottom, c.top - a.bottom);
  switch (rel) {
    case 'below': return c.top >= a.bottom - TOL ? Math.max(0, c.top - a.bottom) + 3 * gapX : undefined;
    case 'above': return c.bottom <= a.top + TOL ? Math.max(0, a.top - c.bottom) + 3 * gapX : undefined;
    case 'rightOf': return c.left >= a.right - TOL ? Math.max(0, c.left - a.right) + 3 * gapY : undefined;
    case 'leftOf': return c.right <= a.left + TOL ? Math.max(0, a.left - c.right) + 3 * gapY : undefined;
    case 'near': return Math.hypot(gapX, gapY);
  }
}

/** Filter (and with `nearest`, narrow) `els` by their position relative to `anchors`. */
export function layoutFilter(els: Element[], anchors: Element[], rel: LayoutRelation, maxDistance: number | undefined, nearest: boolean): Element[] {
  const aBoxes = anchors.map((a) => ({ el: a, b: box(a) })).filter((x): x is { el: Element; b: Box } => !!x.b);
  if (!aBoxes.length) return [];
  const limit = maxDistance ?? (rel === 'near' ? 50 : Infinity);
  const scored: Array<{ el: Element; d: number }> = [];
  for (const el of els) {
    if (aBoxes.some((a) => a.el === el || containsDeep(el, a.el) || containsDeep(a.el, el))) continue;
    const b = box(el);
    if (!b) continue;
    let best: number | undefined;
    for (const a of aBoxes) {
      const d = layoutDistance(rel, a.b, b);
      if (d !== undefined && (best === undefined || d < best)) best = d;
    }
    if (best !== undefined && best <= limit) scored.push({ el, d: best });
  }
  if (!nearest || !scored.length) return scored.map((s) => s.el);
  const min = Math.min(...scored.map((s) => s.d));
  return scored.filter((s) => s.d - min <= 1).map((s) => s.el);
}

export type { TextMatch };
