/**
 * Actionability: may the driver perform `action` on `el` right now?
 *
 * Checks (per action, see the table in contract.ts): attached, visible,
 * stable (same bounding box over two animation frames), enabled, editable,
 * scrolled into view, and "receives events" — a hit test at the action
 * point (`elementFromPoint`, descending into open shadow roots) must land
 * on the element, one of its flat-tree descendants, or a `<label>` of it.
 */
import type { ActionabilityOptions } from '../contract.js';
import type { EngineAction, EngineActionabilityResult } from '../engine-api.js';
import { containsDeep, cssLabel, lowerTag, style } from './dom.js';
import { isDisabled, isReadonly, notFillableReason } from './states.js';
import { isVisible } from './visibility.js';

interface Needs {
  visible: boolean;
  stable: boolean;
  enabled: boolean;
  editable: boolean;
  hit: boolean;
  scroll: boolean;
}

const POINTER: Needs = { visible: true, stable: true, enabled: true, editable: false, hit: true, scroll: true };
const NEEDS: Record<string, Needs> = {
  click: POINTER, dblclick: POINTER, tap: POINTER, check: POINTER, uncheck: POINTER, dragTo: POINTER,
  hover: { ...POINTER, enabled: false },
  fill: { visible: true, stable: false, enabled: true, editable: true, hit: false, scroll: false },
  type: { visible: true, stable: false, enabled: true, editable: true, hit: false, scroll: false },
  clear: { visible: true, stable: false, enabled: true, editable: true, hit: false, scroll: false },
  selectOption: { visible: true, stable: false, enabled: true, editable: false, hit: false, scroll: false },
  selectText: { visible: true, stable: true, enabled: false, editable: false, hit: false, scroll: true },
  scrollIntoView: { visible: true, stable: true, enabled: false, editable: false, hit: false, scroll: true },
  screenshot: { visible: true, stable: true, enabled: false, editable: false, hit: false, scroll: true },
  focus: { visible: false, stable: false, enabled: false, editable: false, hit: false, scroll: false },
  setInputFiles: { visible: false, stable: false, enabled: false, editable: false, hit: false, scroll: false },
};
const ALIASES: Record<string, string> = { select: 'selectOption', scroll: 'scrollIntoView' };

function fail(reason: string, retry: boolean, blocker?: string): EngineActionabilityResult {
  return blocker ? { ok: false, reason, retry, blocker } : { ok: false, reason, retry };
}

/** Wait one animation frame (falls back to a timer where rAF is throttled). */
function frame(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    win.requestAnimationFrame(() => finish());
    win.setTimeout(finish, 100);
  });
}

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Topmost element at a viewport point, descending into open shadow roots. */
export function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
  let hit = doc.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** The control a label element labels (its `control`), or null. */
function labelControl(el: Element): Element | null {
  const label = el.closest('label');
  return label ? (label as HTMLLabelElement).control : null;
}

function actionPoint(el: Element, options?: ActionabilityOptions): { x: number; y: number } | null {
  const win = el.ownerDocument.defaultView as Window;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  if (options?.position) {
    const r = el.getBoundingClientRect();
    const s = style(el);
    const bl = parseFloat(s.borderLeftWidth) || 0;
    const bt = parseFloat(s.borderTopWidth) || 0;
    return { x: r.left + bl + options.position.x, y: r.top + bt + options.position.y };
  }
  const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  // First client rect that intersects the viewport, clipped to it.
  for (const r of rects) {
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, vw);
    const bottom = Math.min(r.bottom, vh);
    if (right > left && bottom > top) return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  return null;
}

/**
 * Is the element's box entirely inside the viewport and inside every scrolling ancestor's visible
 * area, up through the (same-origin) frames that host it? An element can be fully in view inside an
 * iframe whose own box is scrolled out of the top-level viewport.
 */
function fullyInView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return boxInView(el, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
}

function boxInView(el: Element, r: { left: number; top: number; right: number; bottom: number }): boolean {
  const win = el.ownerDocument.defaultView as Window;
  if (r.left < 0 || r.top < 0 || r.right > win.innerWidth || r.bottom > win.innerHeight) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = style(p);
    if (!/(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflowY}`)) continue;
    const c = p.getBoundingClientRect();
    const left = c.left + p.clientLeft;
    const top = c.top + p.clientTop;
    if (r.left < left || r.top < top || r.right > left + p.clientWidth || r.bottom > top + p.clientHeight) return false;
  }
  let host: Element | null = null;
  try {
    host = win.frameElement;
  } catch {
    host = null; // cross-origin parent: nothing more can be checked from here
  }
  if (!host) return true;
  const f = host.getBoundingClientRect();
  const fs = style(host);
  const dx = f.left + (host as HTMLElement).clientLeft + parseFloat(fs.paddingLeft || '0');
  const dy = f.top + (host as HTMLElement).clientTop + parseFloat(fs.paddingTop || '0');
  return boxInView(host, { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy });
}

/**
 * Scroll the element into view only when it is not already (Chromium's scrollIntoViewIfNeeded;
 * Firefox has no such method, and an unconditional scrollIntoView re-centres the element on
 * every action, so virtualized lists re-render under the pointer). Returns whether anything moved.
 */
function scrollIntoViewIfNeeded(el: Element): boolean {
  const before = el.getBoundingClientRect();
  const e = el as Element & { scrollIntoViewIfNeeded?: (center?: boolean) => void };
  if (typeof e.scrollIntoViewIfNeeded === 'function') e.scrollIntoViewIfNeeded(true);
  else if (!fullyInView(el)) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  return !sameRect(before, el.getBoundingClientRect());
}

export async function actionability(el: Element, action: EngineAction, options?: ActionabilityOptions): Promise<EngineActionabilityResult> {
  const name = ALIASES[action] ?? action;
  const needs = NEEDS[name];
  if (!needs) return fail(`unknown action "${action}"`, false);
  if (!el || !el.isConnected) return fail('element is not attached to the DOM', true);

  const force = !!options?.force;
  if (!force) {
    if (needs.visible && !isVisible(el)) return fail('element is not visible', true);
    if (needs.enabled && isDisabled(el)) return fail('element is not enabled', true);
    if (needs.editable) {
      const why = notFillableReason(el);
      if (why) return fail(why, false);
      if (isReadonly(el)) return fail('element is not editable (readonly)', true);
    }
    if (needs.stable) {
      const win = el.ownerDocument.defaultView as Window;
      await frame(win);
      if (!el.isConnected) return fail('element is not attached to the DOM', true);
      const a = el.getBoundingClientRect();
      await frame(win);
      if (!el.isConnected) return fail('element is not attached to the DOM', true);
      const b = el.getBoundingClientRect();
      if (!sameRect(a, b)) return fail('element is not stable (it is moving or resizing)', true);
    }
  }

  if ((needs.scroll || force) && scrollIntoViewIfNeeded(el)) {
    // Scroll events (and the re-render of virtualized lists that listen to them) fire on the next
    // frame: let them run before the hit test, so the input lands on what is rendered then.
    await frame(el.ownerDocument.defaultView as Window);
    if (!el.isConnected) return fail('element was re-rendered after scrolling', true);
  }
  // Only pointer actions report a point and need the hit test.
  if (!needs.hit) return { ok: true };

  const point = actionPoint(el, options);
  if (!point) return fail('element is outside of the viewport', true);
  if (force) return { ok: true, point };

  const hit = deepElementFromPoint(el.ownerDocument, point.x, point.y);
  if (!hit) return fail('element is outside of the viewport', true);
  if (containsDeep(el, hit)) return { ok: true, point };
  if (labelControl(hit) === el) return { ok: true, point };
  if (containsDeep(hit, el) && style(el).pointerEvents === 'none') {
    return fail('element does not receive pointer events (pointer-events: none)', true);
  }
  const blocker = describeBlocker(hit);
  return fail(`${blocker} covers the target`, true, blocker);
}

/** Short CSS-like label of the obstructing element, with its nearest identifiable ancestor when anonymous. */
function describeBlocker(hit: Element): string {
  const self = cssLabel(hit);
  if (self !== lowerTag(hit)) return self;
  const p = hit.parentElement;
  if (p && cssLabel(p) !== lowerTag(p)) return `${cssLabel(p)} > ${self}`;
  return self;
}
