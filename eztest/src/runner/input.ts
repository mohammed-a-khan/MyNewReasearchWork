/**
 * Keyboard, mouse, drag and drop, scrolling, focus, touch and DOM events.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, NotSupportedError, sleep, type Step, type Target } from '../core/index.js';
import { dispatchCustom, dispatchGlobal, html5Drag, scrollElement, scrollWindow, touchSwipe } from './inpage.js';
import { resolveTarget, rootFor } from './locate.js';
import type { StepContext } from './types.js';

// ------------------------------------------------------------------ keys

const KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', windows: 'Meta', super: 'Meta',
  mod: 'ControlOrMeta', controlormeta: 'ControlOrMeta', cmdorctrl: 'ControlOrMeta', ctrlorcmd: 'ControlOrMeta',
  alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', bksp: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  capslock: 'CapsLock', numlock: 'NumLock', scrolllock: 'ScrollLock', printscreen: 'PrintScreen', pause: 'Pause', contextmenu: 'ContextMenu',
  plus: '+', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\', semicolon: ';',
  quote: "'", backquote: '`', bracketleft: '[', bracketright: ']',
};

/** Every key name the grammar accepts (besides single characters, F1-F24, Digit0-9, KeyA-Z and Numpad keys). */
export const NAMED_KEYS = Object.keys(KEY_ALIASES);

/**
 * Normalise a key or combo for the driver: "ctrl+shift+k" -> "Control+Shift+K",
 * "Mod+S" -> "ControlOrMeta+S" (Command on macOS, Control elsewhere).
 */
export function normalizeKey(combo: string): string {
  const parts = combo.trim() === '+' ? ['+'] : combo.split(/\+(?!$)/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p, i) => {
    const lower = p.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (/^f([1-9]|1\d|2[0-4])$/i.test(p)) return p.toUpperCase();
    if (/^(?:digit\d|key[a-z]|numpad(?:\d|add|subtract|multiply|divide|decimal|enter))$/i.test(p)) {
      return p.replace(/^(digit|key|numpad)/i, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).replace(/(Key)([a-z])$/, (_w, k: string, c: string) => k + c.toUpperCase());
    }
    // A letter combined with modifiers is the physical key (upper-case); alone it is typed as written.
    if (/^[a-z]$/i.test(p) && parts.length > 1 && i === parts.length - 1) return p.toUpperCase();
    return p;
  }).join('+');
}

/** Press a key or combo on a target or the page, `times` times. */
export async function pressKey(page: Page, loc: Locator | undefined, key: string, times: number, timeout: number): Promise<void> {
  const k = normalizeKey(key);
  for (let i = 0; i < Math.max(1, times); i++) {
    if (loc) await loc.press(k, { timeout });
    else await page.keyboard.press(k);
  }
}

// ------------------------------------------------------------------ helpers

type Args = Record<string, unknown>;
const num = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new EzTestError(`${what} must be a number, got "${String(v)}"`, 'BAD_VALUE');
  return n;
};

/** Resolve a second target (e.g. a drag destination) strictly in the current page and frame chain. */
export async function resolveSecond(target: Target, ctx: StepContext, timeoutMs: number): Promise<Locator> {
  const root = rootFor(ctx.page, [...(ctx.session?.frames ?? []), ...(target.frames ?? [])]);
  const r = await resolveTarget(root, target, ctx.vars(), timeoutMs);
  if (!r.locator) throw new EzTestError(`no locator candidate matched exactly one element for ${target.description} (${r.notes.join('; ')})`, 'NOT_FOUND');
  return r.locator;
}

async function centerOf(loc: Locator, timeout: number): Promise<{ x: number; y: number }> {
  await loc.scrollIntoViewIfNeeded({ timeout });
  const b = await loc.boundingBox({ timeout });
  if (!b) throw new EzTestError('element has no bounding box (not visible)', 'NOT_VISIBLE');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const MODIFIERS = new Set(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']);
/** Normalise a modifier list ("ctrl", "cmd", "mod", ...). */
export function normalizeModifiers(list: unknown): Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'> {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    const k = normalizeKey(String(m));
    if (!MODIFIERS.has(k)) throw new EzTestError(`"${String(m)}" is not a modifier key (Shift, Control, Alt, Meta, Mod)`, 'BAD_VALUE');
    return k as 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
  });
}

// ------------------------------------------------------------------ actions

export async function keyboardAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<void> {
  const a: Args = step.args ?? {};
  const page = ctx.page;
  const op = String(a.op ?? 'type');
  const v = step.value === undefined ? '' : ctx.interpolate(step.value);
  switch (op) {
    case 'down': await page.keyboard.down(normalizeKey(v)); return;
    case 'up': await page.keyboard.up(normalizeKey(v)); return;
    case 'insert':
      if (loc) await loc.focus({ timeout });
      await page.keyboard.insertText(v);
      return;
    case 'type': {
      const delay = a.delayMs === undefined ? 100 : num(a.delayMs, 'delay');
      if (loc) {
        if (a.clear) await loc.fill('', { timeout });
        await loc.pressSequentially(v, { delay, timeout: Math.max(timeout, v.length * (delay + 50) + 2000) });
      } else await page.keyboard.type(v, { delay });
      return;
    }
    default: throw new NotSupportedError(`keyboard op "${op}"`);
  }
}

export async function mouseAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<void> {
  const a: Args = step.args ?? {};
  const page = ctx.page;
  const op = String(a.op ?? 'move');
  const button = (a.button as 'left' | 'right' | 'middle' | undefined) ?? 'left';
  const x = a.x === undefined ? undefined : num(a.x, 'x');
  const y = a.y === undefined ? undefined : num(a.y, 'y');
  switch (op) {
    case 'move':
      if (loc) await loc.hover({ timeout, ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}) });
      else await page.mouse.move(x ?? 0, y ?? 0, { steps: Number(a.steps ?? 5) });
      return;
    case 'down':
      if (loc) await page.mouse.move(...Object.values(await centerOf(loc, timeout)) as [number, number]);
      await page.mouse.down({ button });
      return;
    case 'up':
      if (loc) await page.mouse.move(...Object.values(await centerOf(loc, timeout)) as [number, number]);
      await page.mouse.up({ button });
      return;
    case 'wheel': await page.mouse.wheel(num(a.dx ?? 0, 'dx'), num(a.dy ?? 0, 'dy')); return;
    case 'clickAt':
      if (loc) await loc.click({ timeout, button, position: { x: x ?? 0, y: y ?? 0 }, modifiers: normalizeModifiers(a.modifiers) });
      else await page.mouse.click(x ?? 0, y ?? 0, { button });
      return;
    default: throw new NotSupportedError(`mouse op "${op}"`);
  }
}

/**
 * Drag the step's target onto `step.to` (or by args.offset). HTML5 drag and
 * drop (draggable="true") is driven by dispatching DataTransfer events,
 * which mouse-only dragging does not trigger in many apps.
 */
export async function dragAction(step: Step, loc: Locator, ctx: StepContext, timeout: number): Promise<void> {
  const a: Args = step.args ?? {};
  const page = ctx.page;
  const offset = a.offset as { x?: number; y?: number } | undefined;
  if (offset) {
    const from = await centerOf(loc, timeout);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + num(offset.x ?? 0, 'offset x'), from.y + num(offset.y ?? 0, 'offset y'), { steps: 12 });
    await page.mouse.up();
    return;
  }
  if (!step.to) throw new EzTestError(`Step "${step.intent}" needs a drop target (to) or an offset`, 'MISSING_TARGET');
  const dest = await resolveSecond(step.to, ctx, timeout);
  let mode = String(a.mode ?? 'auto');
  if (mode === 'auto') mode = (await loc.getAttribute('draggable', { timeout }).catch(() => null)) === 'true' ? 'html5' : 'mouse';
  if (mode === 'html5') {
    const handle = await dest.elementHandle({ timeout });
    if (!handle) throw new EzTestError(`${step.to.description} is not attached`, 'NOT_FOUND');
    try {
      await loc.evaluate(html5Drag, handle, { timeout });
    } finally {
      await handle.dispose();
    }
    return;
  }
  // Mouse drag with intermediate moves (sortable lists and pointer-event libraries need them).
  const from = await centerOf(loc, timeout);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const to = await centerOf(dest, timeout);
  await page.mouse.move(from.x + 5, from.y + 5, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

const DIRS: Record<string, [number, number]> = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };

export async function scrollAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<Record<string, unknown> | void> {
  const a: Args = step.args ?? {};
  const page = ctx.page;
  const op = String(a.op ?? 'page');
  const dir = String(a.direction ?? 'down');
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const amount = a.amount === undefined ? undefined : num(a.amount, 'scroll amount');
  const delta = (): { x: number; y: number; to?: string } => {
    if (['top', 'bottom'].includes(dir) || (['left', 'right'].includes(dir) && a.edge)) return { x: 0, y: 0, to: dir };
    const [dx, dy] = DIRS[dir] ?? DIRS.down;
    const n = amount ?? (dy ? vp.height * 0.8 : vp.width * 0.8);
    return { x: dx * n, y: dy * n };
  };
  switch (op) {
    case 'page':
      await page.evaluate(scrollWindow, delta());
      return;
    case 'element':
      if (!loc) throw new EzTestError('scroll element needs a target', 'MISSING_TARGET');
      await loc.evaluate(scrollElement, delta(), { timeout });
      return;
    case 'intoView':
      if (!loc) throw new EzTestError('scroll into view needs a target', 'MISSING_TARGET');
      await loc.scrollIntoViewIfNeeded({ timeout });
      return;
    case 'untilVisible': {
      // Infinite lists: scroll (the page, or a container) until the target exists and is visible.
      if (!step.target) throw new EzTestError('scroll until visible needs a target', 'MISSING_TARGET');
      const max = a.max === undefined ? 50 : num(a.max, 'max scrolls');
      const container = a.container ? await resolveSecond(a.container as Target, ctx, timeout) : undefined;
      const root = rootFor(page, [...(ctx.session?.frames ?? []), ...(step.target.frames ?? [])]);
      for (let i = 0; i <= max; i++) {
        const r = await resolveTarget(root, step.target, ctx.vars(), 300);
        if (r.locator && (await r.locator.isVisible())) {
          await r.locator.scrollIntoViewIfNeeded({ timeout });
          return { scrolls: i };
        }
        if (i === max) break;
        if (container) await container.evaluate(scrollElement, delta(), { timeout });
        else {
          await page.evaluate(scrollWindow, delta());
          await page.mouse.wheel(0, 1);
        }
        await sleep(Number(a.pauseMs ?? 250));
      }
      throw new EzTestError(`${step.target.description} did not appear after scrolling ${max} times`, 'NOT_FOUND');
    }
    default: throw new NotSupportedError(`scroll op "${op}"`);
  }
}

export async function touchAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<void> {
  const a: Args = step.args ?? {};
  const op = String(a.op ?? 'tap');
  if (op === 'tap') {
    if (!loc) throw new EzTestError('tap needs a target', 'MISSING_TARGET');
    try {
      await loc.tap({ timeout });
    } catch (e) {
      if (/hasTouch/i.test((e as Error).message)) {
        throw new EzTestError('Tap needs touch emulation: add "Device: iPhone 13" (or "Touch: on") to the journey header', 'NO_TOUCH');
      }
      throw e;
    }
    return;
  }
  if (op !== 'swipe') throw new NotSupportedError(`touch op "${op}"`);
  const dir = String(a.direction ?? 'left');
  const [ux, uy] = DIRS[dir] ?? DIRS.left;
  const dist = a.distance === undefined ? 200 : num(a.distance, 'swipe distance');
  const page = ctx.page;
  const target = loc ?? page.locator('body');
  // Prefer real touch input via the DevTools protocol (Chromium); fall back to synthetic TouchEvents.
  if (ctx.session) {
    try {
      const cdp = await ctx.session.cdpSession('touch swipe');
      const from = await centerOf(target, timeout);
      const pts = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from.x, from.y) });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from.x + (ux * dist * i) / 10, from.y + (uy * dist * i) / 10) });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return;
    } catch (e) {
      if (!/needs Chromium/.test((e as Error).message)) throw e;
    }
  }
  await target.evaluate(touchSwipe, { dx: ux * dist, dy: uy * dist, steps: 10 }, { timeout });
}

export async function focusAction(step: Step, loc: Locator, timeout: number): Promise<void> {
  if ((step.args?.op ?? 'focus') === 'blur') await loc.blur({ timeout });
  else await loc.focus({ timeout });
}

/** Dispatch a DOM event on the target (or window/document) with an event init dictionary. */
export async function dispatchAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<void> {
  const type = step.value === undefined ? '' : ctx.interpolate(step.value);
  if (!type) throw new EzTestError('dispatch needs an event type', 'MISSING_VALUE');
  const rawInit = (step.args?.init ?? {}) as Record<string, unknown>;
  const init = JSON.parse(ctx.interpolate(JSON.stringify(rawInit))) as Record<string, unknown>;
  if (!loc) {
    await ctx.page.evaluate(dispatchGlobal, { type, init, on: String(step.args?.on ?? 'window') });
    return;
  }
  if ('detail' in init || !KNOWN_EVENT.test(type)) await loc.evaluate(dispatchCustom, { type, init }, { timeout });
  else await loc.dispatchEvent(type, init, { timeout });
}

const KNOWN_EVENT = /^(?:click|dblclick|mouse\w+|pointer\w+|key\w+|focus\w*|blur|input|change|submit|drag\w*|drop|touch\w+|wheel|scroll|contextmenu)$/;
