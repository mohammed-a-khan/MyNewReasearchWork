/**
 * DOM side of visual testing: a geometry snapshot of the rendered elements
 * (stable key, box, own text, a few computed styles) taken with every
 * screenshot and kept next to the baseline, so that
 *
 * - layout mode compares element boxes instead of pixels,
 * - content mode compares the text of elements,
 * - pixel differences are grouped by the DOM change behind them: one CSS
 *   change (a colour on every button, a panel moved 40px with all its
 *   children) is one finding, not hundreds of pixels.
 *
 * Deterministic: elements are matched by a structural key (tag, id, classes,
 * position among siblings), changes are collapsed into the highest element
 * they explain and grouped by an identical change signature.
 */
import type { Locator, Page } from '../browser/index.js';
import { sha256 } from '../core/index.js';
import { pageFunction } from '../heal/fingerprint.js';
import type { Box } from './visual.js';

/** Computed styles recorded per element (colour-ish and typography changes). */
export const SNAPSHOT_STYLES = ['color', 'background-color', 'border-top-color', 'border-top-width', 'font-size', 'font-weight', 'font-family', 'opacity', 'visibility', 'text-decoration-line', 'box-shadow'] as const;

export interface DomElement {
  /** Structural key (tag, id or test id, position among same-tag siblings): `body>div#summary>p:nth(2)`. */
  key: string;
  /** Short label for messages: `div#summary`. */
  label: string;
  tag: string;
  /** Index of the parent element in the snapshot (-1 for the root). */
  parent: number;
  /** Box in CSS px relative to the screenshot origin. */
  box: Box;
  /** Own (direct) text, trimmed. */
  text: string;
  styles: Record<string, string>;
}

export interface DomSnapshot {
  version: 1;
  origin: 'viewport' | 'page' | 'element';
  devicePixelRatio: number;
  elements: DomElement[];
  /** Masked regions of the screenshot (image px), painted out in both images when compared. */
  masks?: Box[];
}

/**
 * In-page collector, kept as static source (see pageFunction in heal/fingerprint.ts)
 * so the TypeScript toolchain never rewrites it. No user code is evaluated.
 */
const COLLECT = `(root, arg) => {
  const r0 = root.getBoundingClientRect();
  const ox = arg.origin === 'element' ? r0.x : arg.origin === 'page' ? -window.scrollX : 0;
  const oy = arg.origin === 'element' ? r0.y : arg.origin === 'page' ? -window.scrollY : 0;
  const elements = [];
  const label = (el) => {
    const id = el.id && /^[A-Za-z][\\w-]*$/.test(el.id) ? '#' + el.id : '';
    const tid = el.getAttribute('data-testid');
    const cls = Array.from(el.classList).filter((c) => /^[A-Za-z_][\\w-]*$/.test(c)).slice(0, 2).map((c) => '.' + c).join('');
    return el.tagName.toLowerCase() + (id || (tid ? '[data-testid=' + tid + ']' : cls));
  };
  const round = (v) => Math.round(v * 10) / 10;
  const walk = (el, parent, parentKey) => {
    if (elements.length >= arg.max) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return;
    const r = el.getBoundingClientRect();
    const sameTag = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName) : [el];
    // Always indexed among same-tag siblings, so a sibling appearing later does not rename the first one.
    const nth = el.parentElement ? ':nth(' + (sameTag.indexOf(el) + 1) + ')' : '';
    const own = label(el);
    // Keys ignore classes (a renamed class is not a layout change); labels keep them for messages.
    const tid = el.getAttribute('data-testid');
    const part = el.tagName.toLowerCase() + (el.id ? '#' + el.id : tid ? '[data-testid=' + tid + ']' : '');
    const key = parentKey ? parentKey + '>' + part + (el.id ? '' : nth) : part;
    let text = '';
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) text += n.textContent || '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = el.value;
    const styles = {};
    for (const s of arg.styles) styles[s] = cs.getPropertyValue(s);
    const index = elements.length;
    elements.push({
      key, label: own, tag: el.tagName.toLowerCase(), parent,
      box: { x: round(r.x - ox), y: round(r.y - oy), width: round(r.width), height: round(r.height) },
      text: text.replace(/\\s+/g, ' ').trim().slice(0, 300), styles,
    });
    for (const c of Array.from(el.children)) walk(c, index, key);
  };
  walk(root, -1, '');
  return { version: 1, origin: arg.origin, devicePixelRatio: window.devicePixelRatio || 1, elements };
}`;
const collect = pageFunction<{ origin: DomSnapshot['origin']; styles: string[]; max: number }, DomSnapshot>(COLLECT);

/** Take a DOM geometry snapshot of the page (or of one element's subtree). */
export async function captureDomSnapshot(target: Page | Locator, origin: DomSnapshot['origin'], max = 4000): Promise<DomSnapshot> {
  const arg = { origin, styles: [...SNAPSHOT_STYLES], max };
  const root = 'goto' in target ? target.locator('body') : target;
  return root.evaluate(collect as unknown as (el: Element, a: typeof arg) => DomSnapshot, arg);
}

// ------------------------------------------------------------------ comparing snapshots

export type ChangeKind = 'moved' | 'resized' | 'text' | 'style' | 'added' | 'removed';

export interface ElementChange {
  kind: ChangeKind;
  key: string;
  label: string;
  before?: Box;
  after?: Box;
  /** moved: dx,dy (CSS px); resized: dw,dh. */
  delta?: { x: number; y: number };
  property?: string;
  from?: string;
  to?: string;
  /** Elements whose identical change this one explains (descendants following a moved/added/removed/restyled ancestor). */
  covers: number;
}

export interface ChangeGroup {
  /** Stable id of the change signature (same CSS change in other screenshots has the same id). */
  id: string;
  kind: ChangeKind | 'pixels';
  /** e.g. `div#summary moved by 0, 40 px`, `color rgb(…) -> rgb(…) on 3 elements`. */
  summary: string;
  elements: string[];
  /** Pixel regions (image px) explained by this change. */
  regions: Box[];
  diffPixels: number;
  changes: ElementChange[];
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Element-level differences between two snapshots, collapsed into the highest element they explain. */
export function diffSnapshots(before: DomSnapshot, after: DomSnapshot, tol = 1): ElementChange[] {
  const B = new Map(before.elements.map((e, i) => [e.key, { e, i }]));
  const A = new Map(after.elements.map((e, i) => [e.key, { e, i }]));
  const raw = new Map<string, ElementChange[]>();
  const add = (key: string, c: Omit<ElementChange, 'covers'>) => raw.set(key, [...(raw.get(key) ?? []), { ...c, covers: 0 }]);
  for (const [key, { e: b }] of B) {
    const a = A.get(key)?.e;
    if (!a) {
      add(key, { kind: 'removed', key, label: b.label, before: b.box });
      continue;
    }
    if (!near(a.box.width, b.box.width, tol) || !near(a.box.height, b.box.height, tol)) {
      add(key, { kind: 'resized', key, label: a.label, before: b.box, after: a.box, delta: { x: Math.round(a.box.width - b.box.width), y: Math.round(a.box.height - b.box.height) } });
    } else if (!near(a.box.x, b.box.x, tol) || !near(a.box.y, b.box.y, tol)) {
      add(key, { kind: 'moved', key, label: a.label, before: b.box, after: a.box, delta: { x: Math.round(a.box.x - b.box.x), y: Math.round(a.box.y - b.box.y) } });
    }
    if (a.text !== b.text) add(key, { kind: 'text', key, label: a.label, before: b.box, after: a.box, from: b.text, to: a.text });
    for (const p of Object.keys(a.styles)) {
      if (a.styles[p] !== b.styles[p]) add(key, { kind: 'style', key, label: a.label, before: b.box, after: a.box, property: p, from: b.styles[p], to: a.styles[p] });
    }
  }
  for (const [key, { e: a }] of A) if (!B.has(key)) add(key, { kind: 'added', key, label: a.label, after: a.box });

  // Collapse: a change identical to its parent's (same kind, delta, property, values) is explained by the parent.
  const sig = (c: ElementChange) => JSON.stringify([c.kind, c.delta ?? null, c.property ?? null, c.from ?? null, c.to ?? null]);
  const parentKey = (key: string) => (key.includes('>') ? key.slice(0, key.lastIndexOf('>')) : undefined);
  const out: ElementChange[] = [];
  const keys = [...raw.keys()].sort((x, y) => x.split('>').length - y.split('>').length);
  const kept = new Map<string, ElementChange[]>();
  for (const key of keys) {
    for (const c of raw.get(key)!) {
      let explained: ElementChange | undefined;
      for (let p = parentKey(key); p && !explained; p = parentKey(p)) {
        explained = kept.get(p)?.find((pc) => (c.kind === 'added' || c.kind === 'removed' ? pc.kind === c.kind : sig(pc) === sig(c)));
      }
      if (explained) {
        explained.covers++;
        continue;
      }
      kept.set(key, [...(kept.get(key) ?? []), c]);
      out.push(c);
    }
  }
  return out;
}

const overlap = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

function describe(kind: ChangeKind, cs: ElementChange[]): string {
  const labels = [...new Set(cs.map((c) => c.label))];
  const names = labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ');
  const covered = cs.reduce((n, c) => n + c.covers, 0);
  const plus = covered ? ` (with ${covered} descendant${covered === 1 ? '' : 's'})` : '';
  const c = cs[0];
  switch (kind) {
    case 'moved': return `${names} moved by ${c.delta!.x}, ${c.delta!.y} px${plus}`;
    case 'resized': return `${names} resized by ${c.delta!.x}, ${c.delta!.y} px${plus}`;
    case 'text': return cs.length === 1 ? `${names} text changed from "${c.from}" to "${c.to}"` : `text changed on ${names}`;
    case 'style': return `${c.property} changed ${c.from} -> ${c.to} on ${cs.length === 1 ? names : `${cs.length} elements: ${names}`}${plus}`;
    case 'added': return `${names} added${plus}`;
    case 'removed': return `${names} removed${plus}`;
  }
}

/**
 * Group element changes by signature (one CSS rule changing several elements
 * is one group) and attribute differing pixel regions to the groups whose
 * elements cover them. Regions no DOM change explains become "pixels" groups
 * named after the smallest element containing them (images, canvas, fonts).
 */
export function groupChanges(changes: ElementChange[], regions: Array<Box & { pixels?: number }>, after: DomSnapshot | undefined, dpr = 1): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const c of changes) {
    // Same signature = same underlying change (one CSS rule, one shift of the layout).
    const signature = c.kind === 'style' ? `style|${c.property}|${c.from}|${c.to}`
      : c.kind === 'moved' ? `moved|${c.delta!.x}|${c.delta!.y}`
      : c.kind === 'resized' ? `resized|${c.delta!.x}|${c.delta!.y}|${c.key}`
      : c.kind === 'text' ? `text|${c.key}|${c.from}|${c.to}` : `${c.kind}|${c.key}`;
    const id = sha256(signature).slice(0, 12);
    const g = groups.get(id) ?? { id, kind: c.kind, summary: '', elements: [], regions: [], diffPixels: 0, changes: [] };
    g.changes.push(c);
    if (!g.elements.includes(c.label)) g.elements.push(c.label);
    groups.set(id, g);
  }
  for (const g of groups.values()) g.summary = describe(g.kind as ChangeKind, g.changes);
  const list = [...groups.values()];
  for (const r of regions) {
    const css = { x: r.x / dpr, y: r.y / dpr, width: r.width / dpr, height: r.height / dpr };
    let best: { g: ChangeGroup; score: number } | undefined;
    for (const g of list) {
      if (g.kind === 'pixels') continue;
      // Prefer the group whose changed boxes cover the region best; small boxes beat whole-page containers.
      for (const c of g.changes) {
        for (const b of [c.after, c.before]) {
          if (!b) continue;
          const o = overlap(b, css);
          if (!o) continue;
          const score = o / (css.width * css.height) + o / Math.max(1, b.width * b.height);
          if (!best || score > best.score) best = { g, score };
        }
      }
    }
    if (best) {
      best.g.regions.push(r);
      best.g.diffPixels += r.pixels ?? 0;
      continue;
    }
    // No DOM change explains it: name the smallest element containing the region.
    const holder = (after?.elements ?? []).filter((e) => overlap(e.box, css) >= css.width * css.height * 0.5).sort((x, y) => x.box.width * x.box.height - y.box.width * y.box.height)[0];
    const label = holder?.label ?? 'page';
    const id = sha256(`pixels|${holder?.key ?? 'page'}`).slice(0, 12);
    let g = list.find((x) => x.id === id);
    if (!g) {
      g = { id, kind: 'pixels', summary: `pixels changed inside ${label} (no DOM change: image, canvas, font or rendering)`, elements: [label], regions: [], diffPixels: 0, changes: [] };
      list.push(g);
    }
    g.regions.push(r);
    g.diffPixels += r.pixels ?? 0;
  }
  // Most pixels first; without pixels (layout mode) structural changes lead: added/removed, then moves, sizes, text, styles.
  const rank: Record<string, number> = { added: 0, removed: 1, moved: 2, resized: 3, text: 4, style: 5, pixels: 6 };
  return list.sort((a, b) => b.diffPixels - a.diffPixels || rank[a.kind] - rank[b.kind] || a.summary.localeCompare(b.summary));
}

/** Layout mode: only geometry and presence count (text and styles are ignored). */
export function layoutChanges(changes: ElementChange[]): ElementChange[] {
  return changes.filter((c) => c.kind === 'moved' || c.kind === 'resized' || c.kind === 'added' || c.kind === 'removed');
}

/** Content mode: text and presence count (colours, fonts and small shifts are ignored). */
export function contentChanges(changes: ElementChange[]): ElementChange[] {
  return changes.filter((c) => c.kind === 'text' || c.kind === 'added' || c.kind === 'removed');
}
