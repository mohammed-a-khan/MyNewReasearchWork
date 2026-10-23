/**
 * Page side of the dynamic checks: text spacing (1.4.12, applied and removed
 * within one call), the reflow measurement the driver takes at 320 CSS px
 * (1.4.10), and the focus probes of the keyboard walk (2.1.2, 2.4.3, 2.4.7,
 * 2.4.11).
 */
import { deepElements, flatParent, lowerTag, normalizeWhitespace, style, withCaches } from '../../browser/injected/page/dom.js';
import { withRoleCache } from '../../browser/injected/page/roles.js';
import type { FocusStop, PageNode, ReflowResult } from '../protocol.js';
import { Ctx, startTag } from './context.js';
import { isTabbable, isVisible } from './util.js';

// ------------------------------------------------------------------ text spacing

/** WCAG 1.4.12 values: line height 1.5, paragraph spacing 2em, letter spacing 0.12em, word spacing 0.16em. */
export const TEXT_SPACING_CSS =
  '*, *::before, *::after { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }\n' +
  'p { margin-bottom: 2em !important; }';

interface Clipper {
  el: Element;
  dx: number;
  dy: number;
}

function clippers(c: Ctx): Clipper[] {
  const out: Clipper[] = [];
  for (const el of c.all()) {
    if (!c.inScope(el)) continue;
    const tag = lowerTag(el);
    if (tag === 'html' || tag === 'body' || tag === 'textarea' || tag === 'select' || tag === 'input') continue;
    const s = style(el);
    const hy = s.overflowY === 'hidden' || s.overflowY === 'clip';
    const hx = s.overflowX === 'hidden' || s.overflowX === 'clip';
    if (!hy && !hx) continue;
    if (!normalizeWhitespace(el.textContent || '') || !isVisible(el)) continue;
    if (el.clientHeight < 2 || el.clientWidth < 2) continue; // visually hidden text
    out.push({ el, dx: hx ? el.scrollWidth - el.clientWidth : 0, dy: hy ? el.scrollHeight - el.clientHeight : 0 });
  }
  return out;
}

/** Apply the spacing overrides to every document and open shadow root, measure, remove them. */
export function checkTextSpacing(c: Ctx): void {
  const before = withCaches(() => clippers(c));
  const added: Array<() => void> = [];
  try {
    for (const d of c.docs) {
      const st = d.doc.createElement('style');
      st.setAttribute('data-eztest-a11y', 'text-spacing');
      st.textContent = TEXT_SPACING_CSS;
      (d.doc.head ?? d.doc.documentElement).appendChild(st);
      added.push(() => st.remove());
      for (const el of d.elements) {
        const sr = el.shadowRoot;
        if (!sr) continue;
        try {
          const Sheet = d.doc.defaultView!.CSSStyleSheet;
          const sheet = new Sheet();
          sheet.replaceSync(TEXT_SPACING_CSS);
          sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, sheet];
          added.push(() => {
            sr.adoptedStyleSheets = sr.adoptedStyleSheets.filter((x) => x !== sheet);
          });
        } catch {
          /* constructable stylesheets unsupported */
        }
      }
    }
    c.current = 'text.spacing';
    for (const b of before) {
      const el = b.el;
      const s = getComputedStyle(el);
      const hy = s.overflowY === 'hidden' || s.overflowY === 'clip';
      const hx = s.overflowX === 'hidden' || s.overflowX === 'clip';
      const dy = hy ? el.scrollHeight - el.clientHeight : 0;
      const dx = hx ? el.scrollWidth - el.clientWidth : 0;
      const grewY = dy > Math.max(b.dy, 0) + 2;
      const grewX = dx > Math.max(b.dx, 0) + 2 && s.whiteSpace !== 'nowrap' && s.textOverflow !== 'ellipsis';
      if (grewY || grewX) {
        c.fail(el, `With increased text spacing, the text overflows this ${hy && grewY ? 'height' : 'width'}-limited box by ${Math.round(grewY ? dy : dx)}px and is cut off (overflow: hidden). Let the box grow with its content.`);
      } else c.pass(el);
    }
  } finally {
    for (const undo of added) undo();
  }
}

// ------------------------------------------------------------------ reflow

const TWO_D = 'table, pre, code, [role="grid"], [role="treegrid"], [role="table"], canvas, video, svg, iframe, map, img, [role="img"], [role="application"], [role="toolbar"], math';

/** Measured by the driver with the viewport at 320 CSS px. */
export function measureReflow(c: Ctx): ReflowResult {
  const doc = c.root;
  const vw = doc.documentElement.clientWidth;
  const sw = Math.max(doc.scrollingElement?.scrollWidth ?? 0, doc.documentElement.scrollWidth);
  const out: ReflowResult = { viewportWidth: vw, scrollWidth: sw, offenders: [] };
  if (sw <= vw + 1) return out;
  const sx = doc.defaultView!.scrollX;
  const over = (el: Element) => el.getBoundingClientRect().right + sx > vw + 1;
  const clippedByScroller = (el: Element) => {
    for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
      const ox = style(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && p.getBoundingClientRect().right + sx <= vw + 1) return true;
    }
    return false;
  };
  const list: Array<PageNode & { exempt: boolean; width: number }> = [];
  for (const el of c.docs[0].elements) {
    const tag = lowerTag(el);
    if (tag === 'html' || tag === 'body' || !isVisible(el) || !over(el)) continue;
    if (style(el).position === 'fixed' && el.getBoundingClientRect().left >= vw) continue;
    if (clippedByScroller(el)) continue;
    const kids = Array.from(el.children).some((k) => isVisible(k) && over(k) && !clippedByScroller(k));
    if (kids) continue; // report the innermost offenders
    const exempt = !!el.closest(TWO_D);
    const r = el.getBoundingClientRect();
    list.push({ ...c.node(el, `Extends to ${Math.round(r.right + sx)}px at a ${vw}px wide viewport${exempt ? ' (two-dimensional content such as a table, code or media may scroll)' : ''}.`), exempt, width: r.width });
  }
  list.sort((a, b) => Number(a.exempt) - Number(b.exempt) || b.width - a.width);
  out.offenders = list.slice(0, 10).map(({ width: _w, ...n }) => n);
  return out;
}

// ------------------------------------------------------------------ keyboard walk

interface KbState {
  ctx: Ctx;
  keys: WeakMap<Element, number>;
  next: number;
  looks: WeakMap<Element, string>;
  order: Map<Element, number>;
  restore: Element | null;
  scroll: { x: number; y: number };
  tabbables: number;
  lastTabbable: Element | null;
}

let kb: KbState | null = null;

function look(el: Element): string {
  const parts: string[] = [];
  const add = (s: CSSStyleDeclaration) =>
    parts.push(
      [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset, s.boxShadow, s.borderTopColor, s.borderRightColor, s.borderBottomColor,
        s.borderLeftColor, s.borderTopWidth, s.borderBottomWidth, s.backgroundColor, s.backgroundImage, s.color, s.textDecorationLine, s.textDecorationColor,
        s.transform, s.filter, s.opacity].join('|'),
    );
  const win = el.ownerDocument.defaultView!;
  add(win.getComputedStyle(el));
  for (const p of ['::before', '::after']) {
    const s = win.getComputedStyle(el, p);
    parts.push(s.content === 'none' ? '-' : [s.content, s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderBottomColor, s.borderBottomWidth, s.opacity, s.transform].join('|'));
  }
  const parent = flatParent(el);
  if (parent) {
    const s = win.getComputedStyle(parent);
    parts.push([s.outlineStyle, s.outlineWidth, s.boxShadow, s.backgroundColor, s.borderBottomColor].join('|'));
  }
  return parts.join('#');
}

function deepActive(doc: Document): { el: Element | null; opaque: boolean } {
  let a: Element | null = doc.activeElement;
  for (;;) {
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const tag = a ? lowerTag(a) : '';
    if (a && (tag === 'iframe' || tag === 'frame')) {
      let inner: Document | null = null;
      try {
        inner = (a as HTMLIFrameElement).contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) return { el: a, opaque: true };
      if (!inner.activeElement || inner.activeElement === inner.body) return { el: a, opaque: false };
      a = inner.activeElement;
      continue;
    }
    return { el: a, opaque: false };
  }
}

export function kbPrepare(root: Document): { tabbables: number } {
  return withCaches(() =>
    withRoleCache(() => {
      const ctx = new Ctx(root, {});
      const active = deepActive(root).el;
      (active as HTMLElement | null)?.blur?.();
      const state: KbState = { ctx, keys: new WeakMap(), next: 1, looks: new WeakMap(), order: new Map(), restore: active, scroll: { x: root.defaultView!.scrollX, y: root.defaultView!.scrollY }, tabbables: 0, lastTabbable: null };
      ctx.all().forEach((el, i) => state.order.set(el, i));
      for (const el of ctx.all()) {
        if (!isTabbable(el)) continue;
        state.tabbables++;
        state.lastTabbable = el;
        state.looks.set(el, look(el));
        // A visually hidden control (custom file input, checkbox) shows its focus on its label.
        for (const l of Array.from((el as HTMLInputElement).labels ?? [])) if (!state.looks.has(l)) state.looks.set(l, look(l));
      }
      kb = state;
      // Start from the top of the document, like a user who just loaded it, in a focused window.
      root.defaultView!.focus();
      root.defaultView!.scrollTo(0, 0);
      const b = root.body as HTMLElement | null;
      if (b) {
        const had = b.hasAttribute('tabindex');
        if (!had) b.setAttribute('tabindex', '-1');
        b.focus({ preventScroll: true });
        b.blur();
        if (!had) b.removeAttribute('tabindex');
      }
      return { tabbables: state.tabbables };
    }),
  );
}

export function kbProbe(root: Document): FocusStop {
  const st = kb;
  if (!st) throw new Error('keyboard walk not prepared');
  const { el, opaque } = deepActive(root);
  const win = root.defaultView!;
  if (!el || el === root.body || el === root.documentElement) {
    return { key: 0, target: [], html: '', label: 'the document', inOpaqueFrame: false, visible: true, indicator: null, obscured: false, inModal: false, order: -1, last: false };
  }
  let key = st.keys.get(el);
  if (!key) st.keys.set(el, (key = st.next++));
  const node = st.ctx.node(el, '');
  const box = node.box ? { ...node.box, x: node.box.x + win.scrollX, y: node.box.y + win.scrollY } : undefined;
  const r = el.getBoundingClientRect();
  const s = el.ownerDocument.defaultView!.getComputedStyle(el);
  const tiny = r.width < 2 && r.height < 2;
  const off = r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight;
  const clipped = s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(s.clipPath);
  const visible = !opaque ? withCaches(() => isVisible(el)) && !tiny && !off && !clipped && parseFloat(s.opacity) > 0 : true;
  // An invisible control with a visible label is seen (and shows focus) through the label.
  let shown: Element = el;
  let visibleNow = visible;
  if (!visible && !opaque) {
    const label = Array.from((el as HTMLInputElement).labels ?? []).find((l) => withCaches(() => isVisible(l)));
    if (label) {
      shown = label;
      visibleNow = true;
    }
  }
  const before = st.looks.get(shown);
  const indicator = opaque ? null : before === undefined ? null : before !== look(shown);
  let obscured = false;
  if (visible && !opaque && el.ownerDocument === root) {
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight);
    const rootNode = el.getRootNode() as Document | ShadowRoot;
    obscured = pts.length > 0 && pts.every(([x, y]) => {
      const top = (rootNode.elementFromPoint ? rootNode.elementFromPoint(x, y) : root.elementFromPoint(x, y)) as Element | null;
      // A custom control's own label (a styled switch track over a transparent input) does not obscure it.
      const ownLabels = Array.from((el as HTMLInputElement).labels ?? []);
      return !!top && top !== el && !el.contains(top) && !top.contains(el) && !ownLabels.some((l) => l.contains(top));
    });
  }
  const modal = el.closest('[aria-modal="true"]') ?? el.closest('dialog');
  const inModal = !!modal && (modal.getAttribute('aria-modal') === 'true' || (() => {
    try {
      return modal.matches(':modal');
    } catch {
      return false;
    }
  })());
  return {
    key, target: node.target, html: startTag(el), label: describeShort(el), box, inOpaqueFrame: opaque, visible: visibleNow, indicator, obscured, inModal,
    order: st.order.get(el) ?? -1,
    last: el === st.lastTabbable,
  };
}

/** For a cycle of keys: how many tab stops lie outside the smallest element containing all of them. */
export function kbOutside(keys: number[]): { container: string; outside: number } {
  const st = kb;
  if (!st) throw new Error('keyboard walk not prepared');
  const els: Element[] = [];
  for (const el of st.order.keys()) {
    const k = st.keys.get(el);
    if (k && keys.includes(k)) els.push(el);
  }
  if (!els.length) return { container: '', outside: 0 };
  let lca: Element | null = els[0];
  const contains = (a: Element, b: Element) => {
    for (let n: Element | null = b; n; n = flatParent(n)) if (n === a) return true;
    return false;
  };
  while (lca && !els.every((e) => contains(lca as Element, e))) lca = flatParent(lca);
  if (!lca) return { container: '', outside: 0 };
  const inside = new Set([lca, ...deepElements(lca)]);
  let outside = 0;
  withCaches(() => {
    for (const el of st.ctx.all()) if (!inside.has(el) && isTabbable(el)) outside++;
  });
  return { container: st.ctx.localSelector(lca), outside };
}

export function kbFinish(root: Document): void {
  const st = kb;
  kb = null;
  const { el } = deepActive(root);
  (el as HTMLElement | null)?.blur?.();
  if (st?.restore && st.restore.isConnected) (st.restore as HTMLElement).focus?.({ preventScroll: true });
  if (st) root.defaultView!.scrollTo(st.scroll.x, st.scroll.y);
}

function describeShort(el: Element): string {
  const t = normalizeWhitespace((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '');
  return `<${lowerTag(el)}>${t ? ` "${t.length > 40 ? t.slice(0, 39) + '…' : t}"` : ''}`;
}
