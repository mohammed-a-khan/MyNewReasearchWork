/**
 * Actionability: before EZTest acts on an element it waits until the element
 * is attached, visible, enabled, stable (same box across an animation frame),
 * not animating (finite CSS/Web animations on it or its ancestors) and not
 * covered by another element (an overlay, backdrop, cookie banner, toast...).
 *
 * When the deadline passes the error names what is wrong, e.g.
 *   the "Save" button is covered by <div#cookie-banner.overlay role=dialog> "We use cookies…"
 * so a failure reads as "an overlay was in the way", not "Timeout 10000ms exceeded".
 *
 * The driver's own auto-wait still runs on the action; this layer adds the
 * named overlay diagnosis, animation waits and the root-cause record that the
 * flake classifier uses.
 */
import type { Locator } from '../../browser/index.js';
import { EzTestError, sleep } from '../../core/index.js';
import { isClosedError } from '../../browser/errors.js';
import { pageFunction } from '../../heal/fingerprint.js';

export interface ActionabilityProbe {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  /** Same bounding box across one animation frame. */
  stable: boolean;
  /** Finite animations running on the element or an ancestor. */
  animating: number;
  /** Description of the element that would receive a click at the element's center, when it is not the element itself. */
  obscuredBy?: string;
  /** True when the obscuring element looks like an overlay (fixed/absolute layer, dialog, backdrop, banner...). */
  overlay?: boolean;
}

export type BlockCause = 'overlay' | 'animation' | 'unstable' | 'disabled' | 'hidden' | 'detached';

export interface ActionabilityResult {
  ok: boolean;
  waitedMs: number;
  /** What was in the way at some point while waiting (the root causes of the wait). */
  causes: BlockCause[];
  last?: ActionabilityProbe;
  /** The overlay that was seen in the way (first one). */
  overlay?: string;
}

const PROBE = String.raw`(el, opts) => new Promise(function (resolve) {
  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var describe = function (n) {
    var s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    if (n.classList && n.classList.length) s += '.' + Array.prototype.slice.call(n.classList, 0, 3).join('.');
    var role = n.getAttribute('role');
    if (role) s += ' role=' + role;
    var t = clean(n.getAttribute('aria-label') || n.innerText || n.textContent).slice(0, 60);
    return '<' + s + '>' + (t ? ' "' + t + (t.length >= 60 ? '…' : '') + '"' : '');
  };
  var OVERLAY_WORDS = /overlay|backdrop|modal|mask|spinner|loading|loader|cookie|consent|banner|toast|snackbar|popup|blocker|curtain|busy/i;
  var looksOverlay = function (n) {
    for (var p = n, depth = 0; p && p.nodeType === 1 && depth < 8; p = p.parentElement, depth++) {
      var cs = getComputedStyle(p);
      var cls = (typeof p.className === 'string' ? p.className : '') + ' ' + (p.id || '');
      if (cs.position === 'fixed' || p.getAttribute('aria-modal') === 'true' || /^(dialog|alertdialog)$/.test(p.getAttribute('role') || '') || p.tagName === 'DIALOG' || OVERLAY_WORDS.test(cls)) return p;
    }
    return undefined;
  };
  if (!el.isConnected) { resolve({ attached: false, visible: false, enabled: false, stable: false, animating: 0 }); return; }
  var r1 = el.getBoundingClientRect();
  var cs = getComputedStyle(el);
  var visible = r1.width > 0 && r1.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  var enabled = !(el.matches && el.matches(':disabled')) && !(el.closest && el.closest('[aria-disabled="true"]'));
  if (visible && opts.scroll) {
    var vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
    if (r1.bottom < 0 || r1.top > vh || r1.right < 0 || r1.left > vw) { el.scrollIntoView({ block: 'center', inline: 'center' }); r1 = el.getBoundingClientRect(); }
  }
  var animating = 0;
  if (typeof document.getAnimations === 'function') {
    document.getAnimations().forEach(function (a) {
      if (a.playState !== 'running') return;
      var t = a.effect && a.effect.target;
      var timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
      if (timing.iterations === Infinity) return; // spinners never finish: not something to wait for
      if (t && t.nodeType === 1 && (t === el || t.contains(el))) animating++;
    });
  }
  // The real animation frame even when EZTest's browser clock is paused (src/browser/clock.ts).
  var raf = window.__eztestClock ? window.__eztestClock.native.requestAnimationFrame : requestAnimationFrame;
  raf(function () {
    var r2 = el.isConnected ? el.getBoundingClientRect() : r1;
    var stable = Math.abs(r1.x - r2.x) < 0.5 && Math.abs(r1.y - r2.y) < 0.5 && Math.abs(r1.width - r2.width) < 0.5 && Math.abs(r1.height - r2.height) < 0.5;
    var out = { attached: el.isConnected, visible: visible, enabled: enabled, stable: stable, animating: animating };
    if (visible && opts.hit) {
      var x = r2.left + r2.width / 2, y = r2.top + r2.height / 2;
      var root = el.getRootNode && el.getRootNode();
      var hit = root && root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
      // A custom checkbox or radio draws a span over its hidden input inside the same <label>: a click there is
      // a click on the label, which checks the input, so the decoration is part of the control, not an overlay.
      var hitLabel = hit && hit.closest ? hit.closest('label') : null;
      var mine = !hit || hit === el || el.contains(hit) || (hit.control && hit.control === el) || (el.labels && Array.prototype.indexOf.call(el.labels, hit) >= 0) || (hit.contains && hit.contains(el) && hit.tagName === 'LABEL') || (hitLabel && hitLabel.control === el);
      if (!mine) {
        var layer = looksOverlay(hit);
        out.obscuredBy = describe(layer || hit);
        out.overlay = !!layer;
      }
    }
    resolve(out);
  });
})`;

const probeFn = pageFunction<{ hit: boolean; scroll: boolean }, ActionabilityProbe>(PROBE);

/** Probe one element once (the locator must resolve to exactly one element). */
export async function probeActionability(loc: Locator, opts: { hit?: boolean; scroll?: boolean; timeoutMs?: number } = {}): Promise<ActionabilityProbe> {
  return loc.evaluate(probeFn as unknown as (el: Element, a: { hit: boolean; scroll: boolean }) => ActionabilityProbe, { hit: opts.hit ?? true, scroll: opts.scroll ?? true }, { timeout: opts.timeoutMs ?? 2000 });
}

/** Actions whose click lands on the element's center (a covering element would receive it). */
export const POINTER_ACTIONS: ReadonlySet<string> = new Set(['click', 'dblclick', 'check', 'uncheck', 'hover', 'download', 'touch']);
/** Actions that need an enabled, visible, settled element but do not click its center. */
export const INPUT_ACTIONS: ReadonlySet<string> = new Set(['fill', 'clear', 'select']);

export interface WaitActionableOptions {
  timeoutMs: number;
  /** Require that the element receives the pointer (no overlay over its center). */
  hit: boolean;
  /** Require it to be enabled (default true). */
  enabled?: boolean;
  /** Poll interval (default 50 ms). */
  intervalMs?: number;
  /** Throw a named error when the deadline passes (default true). */
  throwOnTimeout?: boolean;
  /** Human description of the target for messages. */
  description?: string;
}

function problem(p: ActionabilityProbe, o: WaitActionableOptions): BlockCause | undefined {
  if (!p.attached) return 'detached';
  if (!p.visible) return 'hidden';
  if (o.enabled !== false && !p.enabled) return 'disabled';
  if (p.animating > 0) return 'animation';
  if (!p.stable) return 'unstable';
  if (o.hit && p.obscuredBy) return 'overlay';
  return undefined;
}

/** Message for an element that did not become actionable in time. */
export function actionabilityMessage(desc: string, cause: BlockCause, p: ActionabilityProbe | undefined, waitedMs: number): string {
  const what = {
    overlay: `is covered by ${p?.obscuredBy ?? 'another element'}${p?.overlay ? ' (an overlay)' : ''}; the click would land on it`,
    animation: `is still animating (${p?.animating ?? 0} running animation(s))`,
    unstable: 'keeps moving (its position changed between animation frames)',
    disabled: 'is disabled',
    hidden: 'is not visible',
    detached: 'was removed from the page (re-rendered)',
  }[cause];
  return `${desc} ${what} - waited ${waitedMs} ms`;
}

/**
 * Wait until the element is actionable. Returns what was in the way while waiting.
 * A detached element returns at once (the caller re-resolves the target).
 */
export async function waitActionable(loc: Locator, o: WaitActionableOptions): Promise<ActionabilityResult> {
  const t0 = Date.now();
  const deadline = t0 + o.timeoutMs;
  const causes = new Set<BlockCause>();
  let overlay: string | undefined;
  let last: ActionabilityProbe | undefined;
  for (;;) {
    try {
      last = await probeActionability(loc, { hit: o.hit, timeoutMs: Math.max(200, Math.min(2000, deadline - Date.now())) });
    } catch (e) {
      // Element gone between resolve and probe (SPA re-render), or the page navigated.
      const msg = (e as Error).message;
      if (isClosedError(e) || /Target (?:page, context or browser )?(?:has been )?closed/i.test(msg)) throw e;
      causes.add('detached');
      return { ok: false, waitedMs: Date.now() - t0, causes: [...causes], last: { attached: false, visible: false, enabled: false, stable: false, animating: 0 } };
    }
    const p = problem(last, o);
    if (!p) return { ok: true, waitedMs: Date.now() - t0, causes: [...causes], last, ...(overlay ? { overlay } : {}) };
    causes.add(p);
    if (p === 'overlay') overlay ??= last.obscuredBy;
    if (p === 'detached') return { ok: false, waitedMs: Date.now() - t0, causes: [...causes], last };
    if (Date.now() >= deadline) {
      const waited = Date.now() - t0;
      if (o.throwOnTimeout === false) return { ok: false, waitedMs: waited, causes: [...causes], last, ...(overlay ? { overlay } : {}) };
      throw new EzTestError(actionabilityMessage(o.description ?? 'the element', p, last, waited), p === 'overlay' ? 'OBSCURED' : 'NOT_ACTIONABLE', { cause: p, obscuredBy: last.obscuredBy });
    }
    await sleep(Math.min(o.intervalMs ?? 50, Math.max(10, deadline - Date.now())));
  }
}
