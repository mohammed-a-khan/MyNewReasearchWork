/**
 * Keyboard operability (WCAG 2.1.1 Keyboard, 2.1.2 No Keyboard Trap, 2.4.3
 * Focus Order, 2.4.7 Focus Visible), checked deterministically by driving
 * the real keyboard: Tab through the page (or one container) from the start,
 * and record where focus goes.
 *
 *   Expect the page to be keyboard operable
 *   Expect the "Checkout" form to be keyboard operable
 *
 * Fails, naming the element, when a focusable element is never reached, when
 * Tab does not move focus away from an element (a trap; Escape is tried
 * first), when focus cycles inside a part of the container and never reaches
 * the rest, or when the focused element shows no visible focus indicator.
 * Positive tabindex reordering is reported as a warning.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, slugify, type Step } from '../core/index.js';
import { pageFunction } from '../heal/fingerprint.js';
import { resolveTarget, rootFor } from '../runner/locate.js';
import type { CustomStepHandler, StepContext } from '../runner/types.js';

export const KEYBOARD_STEP = 'eztest.keyboard';

interface Collected {
  count: number;
  items: Array<{ index: number; desc: string; tabindex: number }>;
}

interface Active {
  /** Index in the collected list, -1 outside the container, -2 nothing focused (body). */
  index: number;
  desc: string;
  visible: boolean;
}

const COLLECT = String.raw`(arg) => {
  var root = arg && arg.root;
  var scope = root || document.body;
  var sel = 'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';
  var list = [];
  var desc = function (el) {
    var t = el.tagName.toLowerCase();
    var name = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return t + (el.id ? '#' + el.id : '') + (name ? ' "' + name + '"' : '');
  };
  var all = scope.querySelectorAll(sel);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) continue;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
    if (!el.getClientRects().length) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.closest('[inert]')) continue;
    list.push(el);
  }
  var sig = function (el) {
    var c = getComputedStyle(el);
    return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderTopWidth, c.backgroundColor, c.color, c.textDecorationLine].join('|');
  };
  window.__ezKb = { scope: scope, list: list, base: list.map(sig), sig: sig, desc: desc };
  return { count: list.length, items: list.map(function (el, i) { return { index: i, desc: desc(el), tabindex: Number(el.getAttribute('tabindex') || 0) }; }) };
}`;

const ACTIVE = String.raw`() => {
  var kb = window.__ezKb;
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { index: -2, desc: 'the page (nothing focused)', visible: false };
  var i = kb.list.indexOf(a);
  var c = getComputedStyle(a);
  var outline = c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0;
  var changed = i >= 0 ? kb.sig(a) !== kb.base[i] : true;
  return { index: kb.scope.contains(a) ? i : -1, desc: kb.desc(a), visible: outline || changed };
}`;

const collectFn = pageFunction<{ root: unknown }, Collected>(COLLECT);
const activeFn = pageFunction<void, Active>(ACTIVE);

export interface KeyboardCheckResult {
  passed: boolean;
  reachable: number;
  reached: number;
  order: string[];
  problems: string[];
  warnings: string[];
}

/** Drive Tab through the page (or `root`) and check reachability, traps, focus visibility and order. */
export async function checkKeyboard(page: Page, opts: { root?: Locator; maxTabs?: number } = {}): Promise<KeyboardCheckResult> {
  const handle = opts.root ? await opts.root.elementHandle({ timeout: 5000 }) : null;
  const collected = (await page.evaluate(collectFn, { root: handle })) as Collected;
  await handle?.dispose().catch(() => undefined);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!collected.count) return { passed: false, reachable: 0, reached: 0, order: [], problems: ['no focusable elements found'], warnings };
  // Start from the top: blur whatever has focus, then Tab.
  await page.evaluate('(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); })()');
  const maxTabs = opts.maxTabs ?? Math.min(200, collected.count * 2 + 10);
  const reached = new Set<number>();
  const order: string[] = [];
  const invisible = new Set<string>();
  let prev: Active | undefined;
  let stale = 0;
  /** Indices focused since the last new element (where focus is cycling). */
  let cycle: number[] = [];
  let enteredScope = false;
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const a = (await page.evaluate(activeFn, undefined)) as Active;
    if (a.index >= 0) {
      enteredScope = true;
      if (!reached.has(a.index)) {
        reached.add(a.index);
        order.push(a.desc);
        stale = 0;
        cycle = [];
      } else {
        stale++;
        if (!cycle.includes(a.index)) cycle.push(a.index);
      }
      if (!a.visible) invisible.add(a.desc);
    } else if (enteredScope && opts.root) {
      // Focus left the container: everything reachable from inside it has been seen once we wrapped.
      if (reached.size >= collected.count) break;
      stale++;
    } else stale++;
    if (prev && a.index >= 0 && prev.index === a.index && prev.desc === a.desc) {
      // Tab did not move focus: try Escape, the standard way out of a widget.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      const b = (await page.evaluate(activeFn, undefined)) as Active;
      if (b.index === a.index && b.desc === a.desc) {
        problems.push(`keyboard trap at ${a.desc}: Tab (and Escape, then Tab) does not move focus away`);
        break;
      }
    }
    prev = a;
    if (reached.size >= collected.count) break;
    // Focus keeps cycling through the same elements while others are never reached: a trap around them.
    if (stale > Math.max(4, reached.size + 2)) {
      const missing = collected.items.filter((x) => !reached.has(x.index));
      if (missing.length) {
        await page.keyboard.press('Escape');
        problems.push(`focus is trapped among ${[...cycle].sort((x, y) => x - y).slice(0, 6).map((k) => collected.items[k].desc).join(', ')}; never reached: ${missing.slice(0, 6).map((x) => x.desc).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}`);
      }
      break;
    }
  }
  const unreached = collected.items.filter((x) => !reached.has(x.index));
  if (unreached.length && !problems.some((p) => p.startsWith('focus is trapped') || p.startsWith('keyboard trap'))) {
    problems.push(`not reachable with Tab: ${unreached.slice(0, 8).map((x) => x.desc).join(', ')}${unreached.length > 8 ? ` and ${unreached.length - 8} more` : ''}`);
  }
  for (const d of invisible) problems.push(`no visible focus indicator on ${d}`);
  const positive = collected.items.filter((x) => x.tabindex > 0);
  if (positive.length) warnings.push(`positive tabindex changes the focus order: ${positive.slice(0, 5).map((x) => `${x.desc} (tabindex=${x.tabindex})`).join(', ')}`);
  return { passed: problems.length === 0, reachable: collected.count, reached: reached.size, order, problems, warnings };
}

/** Custom step "eztest.keyboard": `Expect <the page | an element> to be keyboard operable`. */
export function createKeyboardStepHandler(): CustomStepHandler {
  return async (page: Page, step: Step, ctx: StepContext) => {
    let root: Locator | undefined;
    if (step.target) {
      const r = await resolveTarget(rootFor(page, [...(ctx.session?.frames ?? []), ...(step.target.frames ?? [])]), step.target, ctx.vars(), step.timeoutMs ?? 10_000);
      if (!r.locator) throw new EzTestError(`${step.target.description}: not found exactly once (${r.notes.join('; ')})`, 'TARGET_NOT_FOUND');
      root = r.locator;
    }
    const res = await checkKeyboard(page, { ...(root ? { root } : {}), ...(typeof step.args?.maxTabs === 'number' ? { maxTabs: step.args.maxTabs } : {}) });
    await ctx.evidence.store('data', `a11y/${slugify(ctx.journey.id)}/keyboard-${slugify(step.id)}.json`, JSON.stringify(res, null, 2), {
      journeyId: ctx.journey.id, stepId: step.id, description: `keyboard check: ${res.passed ? 'operable' : `${res.problems.length} problem(s)`}`,
    });
    if (!res.passed) throw new EzTestError(`Keyboard check failed (${res.reached}/${res.reachable} focusable elements reached): ${res.problems.join('; ')}`, 'KEYBOARD_NOT_OPERABLE');
    return { keyboard: { reached: res.reached, reachable: res.reachable, warnings: res.warnings } };
  };
}
