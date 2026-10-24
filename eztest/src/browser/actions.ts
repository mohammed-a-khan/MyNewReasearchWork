/**
 * Element actions with auto-waiting: resolve the element (re-resolving on
 * every attempt for locators), ask the injected engine whether the action
 * can happen (visible, stable, enabled, editable, receives events), then
 * perform it with real input events.
 *
 * Engine-independent except for the frame/page objects it is given; a
 * second engine (WebDriver BiDi) provides the same frame / handle methods.
 */
import { resolve as resolvePath, basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ActionabilityResult, ActionKind } from './injected/contract.js';
import { TimeoutError, isClosedError, isContextGoneError } from './errors.js';
import { DETACHED_TEXT, closedMessage, timeoutMessage } from './messages.js';
import type { FilePayload, MouseButton, KeyboardModifier, Rect } from './types.js';
import { Deadline, mimeFor, pollDelay, sleep } from './util.js';
import type { ChromiumFrame } from './chromium/frame.js';
import type { ChromiumPage, ScreenshotOptions } from './chromium/page.js';
import type { ElementHandle, JSHandle } from './chromium/handles.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ActionOptions {
  timeout?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  trial?: boolean;
}

export interface PointerOptions extends ActionOptions {
  position?: { x: number; y: number };
  modifiers?: KeyboardModifier[];
}

export interface ClickOptions extends PointerOptions {
  button?: MouseButton;
  clickCount?: number;
  delay?: number;
}

export interface TypeOptions extends ActionOptions {
  delay?: number;
}

export interface ElementScreenshotOptions extends Omit<ScreenshotOptions, 'fullPage' | 'clip'> {
  timeout?: number;
}

export type SelectValue = string | { value?: string; label?: string; index?: number } | ElementHandle;
export type SelectValues = SelectValue | SelectValue[] | null;

/** An element found in a frame (handle in the frame's engine world). */
export interface Resolved {
  frame: ChromiumFrame;
  el: ElementHandle;
}

/** What an action operates on: a locator (re-resolved each attempt) or a fixed handle. */
export interface ElementTarget {
  description: string;
  page: ChromiumPage;
  /** The element, or null when it does not exist (yet). Throws for errors waiting cannot fix (several matches). */
  resolve(): Promise<Resolved | null>;
}

export function handleTarget(h: ElementHandle): ElementTarget {
  return {
    description: 'element handle',
    page: h.frame.page(),
    resolve: async () => {
      const el = await h.inEngineWorld();
      const attached = await el.context.callEngine((_e, _h, x) => x.isConnected, [el]);
      if (!attached) throw new Error(DETACHED_TEXT);
      return { frame: h.frame, el };
    },
  };
}

class RetryableError extends Error {}

/** Shared retry loop with a call log, and timeout messages that include it. */
export async function retrying<T>(api: string, target: ElementTarget, timeout: number, attemptFn: (r: Resolved, log: string[]) => Promise<{ done: T } | { retry: string }>): Promise<T> {
  const deadline = new Deadline(timeout);
  const log: string[] = [`waiting for ${target.description}`];
  const note = (m: string) => {
    if (log[log.length - 1] !== m) log.push(m);
  };
  for (let attempt = 0; ; attempt++) {
    if (target.page.isClosed()) throw new Error(closedMessage(api));
    let r: Resolved | null = null;
    try {
      r = await target.resolve();
      if (r) {
        const out = await attemptFn(r, log);
        if ('done' in out) return out.done;
        note(out.retry);
      }
    } catch (e) {
      const err = e as Error;
      if (isClosedError(err) || target.page.isClosed()) {
        throw Object.assign(new Error(closedMessage(api)), { name: 'TargetClosedError' });
      }
      if (err instanceof RetryableError || isContextGoneError(err) || (err as { contextGone?: boolean }).contextGone) {
        note(err.message);
      } else {
        if (!err.message.startsWith(`${api}:`)) err.message = `${api}: ${err.message}`;
        throw err;
      }
    } finally {
      // handles are cheap; release eagerly when the action is done or retried
      if (r && target.description !== 'element handle') void r.el.dispose();
    }
    if (deadline.expired()) {
      throw new TimeoutError(timeoutMessage(api, timeout, log));
    }
    await sleep(Math.min(pollDelay(attempt), deadline.remaining()));
  }
}

function timeoutFor(target: ElementTarget, o: { timeout?: number }): number {
  return o.timeout ?? target.page.defaultTimeout();
}

async function actionability(r: Resolved, action: ActionKind, o: { position?: { x: number; y: number }; force?: boolean }, resolveControl = false): Promise<ActionabilityResult> {
  return r.el.context.callEngine(
    (e, h, el, a, opts, rt) => e.actionability(rt ? h.resolveControl(el, 'control') : el, a, opts),
    [r.el, action, { position: o.position, force: o.force }, resolveControl],
  );
}

async function holdModifiers(page: ChromiumPage, mods: KeyboardModifier[] | undefined): Promise<() => Promise<void>> {
  if (!mods?.length) return async () => undefined;
  const mac = process.platform === 'darwin';
  const keys = mods.map((m) => (m === 'ControlOrMeta' ? (mac ? 'Meta' : 'Control') : m)).filter((k) => !page.keyboard.pressed.has(k));
  for (const k of keys) await page.keyboard.down(k);
  return async () => {
    for (const k of keys.reverse()) await page.keyboard.up(k);
  };
}

/** click / dblclick / hover / tap with actionability checks. */
export async function pointerAction(api: string, target: ElementTarget, action: 'click' | 'dblclick' | 'hover' | 'tap', o: ClickOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r, log) => {
    const res = await actionability(r, action, o);
    if (!res.ok) {
      if (!res.retry) throw new Error(res.reason ?? 'action not possible');
      const blocker = (res as ActionabilityResult & { blocker?: string }).blocker;
      return { retry: blocker ? `${blocker} covers the element and would receive the pointer event` : (res.reason ?? 'not actionable') };
    }
    if (o.trial) return { done: undefined };
    const off = await r.frame.viewportOffset();
    const x = res.point!.x + off.x;
    const y = res.point!.y + off.y;
    log.push(`${action} at (${Math.round(x)}, ${Math.round(y)})`);
    const page = target.page;
    const release = await holdModifiers(page, o.modifiers);
    const navBefore = { starts: page.navStarts, ends: page.navEnds, at: Date.now() };
    const pressesBefore = page.mouse.pressesSent + page.touchscreen.touchesSent;
    try {
      if (action === 'hover') await page.mouse.move(x, y);
      else if (action === 'tap') await page.touchscreen.tap(x, y);
      else {
        // Move first, then press: a page can react to the pointer arriving (hover tooltips that
        // re-measure, menus that open) and put something else under the point. Check the hit
        // again after that frame, in the page, and retry when the target is no longer there.
        if (!o.force && (page.mouse.x !== x || page.mouse.y !== y)) {
          await page.mouse.move(x, y);
          const again = await r.el.context.callEngine((_e, h, el, px, py) => h.hitsAfterFrame(el, px, py), [r.el, res.point!.x, res.point!.y]);
          if (!again.ok) return { retry: again.hit ? `${again.hit} covered the element once the pointer moved there` : 'the element moved away once the pointer arrived' };
        }
        await page.mouse.click(x, y, { button: o.button, clickCount: action === 'dblclick' ? 2 : (o.clickCount ?? 1), delay: o.delay });
      }
    } catch (e) {
      // The press reached the page and the page went away while the input command was in flight
      // (its handler ran window.close()): the browser detaches the target before it acknowledges the
      // command, so the command fails "target closed". The click happened; its outcome is the close.
      if (isClosedError(e as Error) && page.mouse.pressesSent + page.touchscreen.touchesSent > pressesBefore) return { done: undefined };
      throw e;
    } finally {
      await release().catch((e: Error) => {
        if (!isClosedError(e) && !page.isClosed()) throw e;
      });
    }
    if (page.isClosed()) return { done: undefined };
    if (!o.noWaitAfter && action !== 'hover') await page.waitForInitiatedNavigation(navBefore, timeoutFor(target, o), api);
    return { done: undefined };
  });
}

/** Fill an input / textarea / contenteditable (selects the old value, inserts the new one). */
export async function fill(api: string, target: ElementTarget, value: string, o: ActionOptions): Promise<void> {
  if (typeof value !== 'string') throw new Error(`${api}: value: expected string, got ${typeof value}`);
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    if (!o.force) {
      const res = await actionability(r, 'fill', o, true);
      if (!res.ok) {
        if (!res.retry) throw new Error(res.reason ?? 'not fillable');
        return { retry: res.reason ?? 'not fillable' };
      }
    }
    const mode = await r.el.context.callEngine((_e, h, el, v) => h.prepareFill(h.resolveControl(el, 'control'), v), [r.el, value]);
    if (mode === 'input') {
      if (value === '') await target.page.keyboard.press('Delete');
      else await target.page.keyboard.insertText(value);
    }
    return { done: undefined };
  });
}

/** Focus the element (no visibility requirement). */
export async function focus(api: string, target: ElementTarget, o: ActionOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    await r.el.context.callEngine((_e, h, el) => h.focus(el), [r.el]);
    return { done: undefined };
  });
}

export async function blur(api: string, target: ElementTarget, o: ActionOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    await r.el.context.callEngine((_e, h, el) => h.blur(el), [r.el]);
    return { done: undefined };
  });
}

/** Focus, then type text key by key. */
export async function typeText(api: string, target: ElementTarget, text: string, o: TypeOptions): Promise<void> {
  await focus(api, target, o);
  await target.page.keyboard.type(text, { delay: o.delay });
}

/** Focus, then press a key / chord. */
export async function pressKey(api: string, target: ElementTarget, key: string, o: TypeOptions): Promise<void> {
  await focus(api, target, o);
  await target.page.keyboard.press(key, { delay: o.delay });
}

/** check / uncheck: click when the state differs, then verify the new state. */
export async function setChecked(api: string, target: ElementTarget, checked: boolean, o: ClickOptions): Promise<void> {
  const state = async () => {
    const r = await target.resolve();
    if (!r) return undefined;
    try {
      return await r.el.context.callEngine((e, h, el) => e.checkState(h.resolveControl(el, 'control'), 'checked'), [r.el]);
    } finally {
      if (target.description !== 'element handle') void r.el.dispose();
    }
  };
  const deadline = new Deadline(timeoutFor(target, o));
  let current: boolean | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      current = await state();
    } catch (e) {
      throw Object.assign(e as Error, { message: `${api}: ${(e as Error).message}` });
    }
    if (current !== undefined) break;
    if (deadline.expired()) throw new TimeoutError(timeoutMessage(api, deadline.timeout, [`waiting for ${target.description}`]));
    await sleep(pollDelay(attempt));
  }
  if (current === checked) return;
  await pointerAction(api, target, 'click', { ...o, timeout: deadline.remaining() || 1 });
  if (o.trial) return;
  const after = await state();
  if (after !== checked) throw new Error(`${api}: the click landed but the control is still ${checked ? 'unchecked' : 'checked'} (the page may handle the click itself; check what the click does)`);
}

/** Select options in a <select> by value or label (or index / option element). */
export async function selectOption(api: string, target: ElementTarget, values: SelectValues, o: ActionOptions): Promise<string[]> {
  const list = values === null ? [] : Array.isArray(values) ? values : [values];
  const specs: Array<{ value?: string; label?: string; index?: number; valueOrLabel?: string }> = [];
  for (const v of list) {
    if (typeof v === 'string') specs.push({ valueOrLabel: v });
    else if (v && typeof (v as ElementHandle).evaluate === 'function') {
      const value = await (v as ElementHandle).evaluate((e: Element) => (e as HTMLOptionElement).value);
      specs.push({ value });
    } else specs.push(v as { value?: string; label?: string; index?: number });
  }
  return retrying<string[]>(api, target, timeoutFor(target, o), async (r) => {
    if (!o.force) {
      const res = await actionability(r, 'selectOption', o);
      if (!res.ok) {
        if (!res.retry) throw new Error(res.reason ?? 'not selectable');
        return { retry: res.reason ?? 'not selectable' };
      }
    }
    const out = await r.el.context.callEngine((_e, h, el, s) => h.selectOptions(h.resolveControl(el, 'control'), s), [r.el, specs]);
    if (!Array.isArray(out)) return { retry: (out as { retry: string }).retry };
    return { done: out as string[] };
  });
}

export async function selectText(api: string, target: ElementTarget, o: ActionOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    if (!o.force) {
      const res = await actionability(r, 'selectText', o);
      if (!res.ok) return res.retry ? { retry: res.reason ?? 'not ready' } : Promise.reject(new Error(res.reason));
    }
    await r.el.context.callEngine((_e, h, el) => h.selectText(el), [r.el]);
    return { done: undefined };
  });
}

export async function dispatchEvent(api: string, target: ElementTarget, type: string, init: Record<string, unknown>, o: ActionOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    await r.el.context.callEngine((_e, h, el, t, i) => h.dispatch(el, t, i), [r.el, type, init ?? {}]);
    return { done: undefined };
  });
}

export async function scrollIntoView(api: string, target: ElementTarget, o: ActionOptions): Promise<void> {
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    const res = await actionability(r, 'scrollIntoView', { force: o.force });
    if (!res.ok) return res.retry ? { retry: res.reason ?? 'not ready' } : Promise.reject(new Error(res.reason));
    return { done: undefined };
  });
}

/** Set the files of an <input type=file> (paths, or in-memory payloads). Empty list clears it. */
export async function setInputFiles(api: string, target: ElementTarget, files: string | FilePayload | string[] | FilePayload[], o: ActionOptions): Promise<void> {
  const list = (Array.isArray(files) ? files : [files]) as Array<string | FilePayload>;
  const paths = list.filter((f): f is string => typeof f === 'string').map((p) => resolvePath(p));
  const payloads = list.filter((f): f is FilePayload => typeof f !== 'string');
  if (paths.length && payloads.length) throw new Error(`${api}: pass either file paths or in-memory files ({ name, mimeType, buffer }), not both in one call`);
  for (const p of paths) await stat(p).catch(() => Promise.reject(new Error(`${api}: the file to upload does not exist: ${p}`)));
  await retrying(api, target, timeoutFor(target, o), async (r) => {
    // Retarget a label to its input.
    const input = (await r.el.context.callEngine((_e, h, el) => h.resolveControl(el, 'control'), [r.el], false)) as unknown as ElementHandle;
    try {
      const kind = await input.context.callEngine((_e, h, el) => h.isFileInput(el), [input]);
      if (kind === 'no') throw new Error('The target is not a file input (<input type=file>) or a label of one');
      if (kind === 'file' && list.length > 1) throw new Error(`This file input takes one file (it has no "multiple" attribute), but ${list.length} were given`);
      if (paths.length) {
        await input.context.setInputFilePaths(input, paths);
      } else {
        const enc = payloads.map((f) => ({ name: f.name, mimeType: f.mimeType || mimeFor(f.name), b64: Buffer.from(f.buffer).toString('base64') }));
        await input.context.callEngine((_e, h, el, fs) => h.setFiles(el, fs), [input, enc]);
      }
    } finally {
      void input.dispose();
    }
    return { done: undefined };
  });
}

/** Read a file payload from disk (for helpers that need the bytes). */
export async function payloadFromPath(p: string): Promise<FilePayload> {
  return { name: basename(p), mimeType: mimeFor(p), buffer: await readFile(p) };
}

/** The element's box in top-level viewport CSS px, or null. */
export async function boundingBox(h: ElementHandle): Promise<Rect | null> {
  const u = await h.inEngineWorld();
  const rect = await u.context.callEngine((_e, hp, el) => hp.rect(el), [u]);
  if (!rect) return null;
  const off = await h.frame.viewportOffset();
  return { x: rect.x + off.x, y: rect.y + off.y, width: rect.width, height: rect.height };
}

/** Screenshot of one element (scrolled into view; clip in page coordinates). */
export async function elementScreenshot(api: string, target: ElementTarget, o: ElementScreenshotOptions): Promise<Buffer> {
  const page = target.page;
  const box = await retrying(api, target, timeoutFor(target, o), async (r) => {
    const res = await actionability(r, 'screenshot', {});
    if (!res.ok) return res.retry ? { retry: res.reason ?? 'not visible' } : Promise.reject(new Error(res.reason));
    const b = await boundingBox(r.el);
    if (!b || b.width === 0 || b.height === 0) return { retry: 'element has no size' };
    return { done: b };
  });
  // Scroll offset of the top-level document (the clip is in page coordinates): asked of the page itself, so any engine works.
  const vv = await page.mainFrame().inEngine(() => {
    const v = window.visualViewport;
    return v ? { pageX: v.pageLeft, pageY: v.pageTop } : { pageX: window.scrollX, pageY: window.scrollY };
  });
  const dpr = page.context().options.deviceScaleFactor ?? 1;
  const clip = { x: box.x + vv.pageX, y: box.y + vv.pageY, width: box.width, height: box.height, scale: o.scale === 'css' && dpr !== 1 ? 1 / dpr : 1 };
  const type = o.type ?? (o.path && /\.jpe?g$/i.test(o.path) ? 'jpeg' : 'png');
  return page.capture({ type, quality: o.quality, clip, beyond: true, options: o, frame: page.mainFrame() });
}

/** Wait for an element-handle state. */
export async function waitForElementState(h: ElementHandle, state: 'visible' | 'hidden' | 'stable' | 'enabled' | 'disabled' | 'editable', timeout: number): Promise<void> {
  const deadline = new Deadline(timeout);
  for (let attempt = 0; ; attempt++) {
    const u = await h.inEngineWorld();
    const ok = state === 'stable'
      ? (await u.context.callEngine((e, _h, el) => e.actionability(el, 'scrollIntoView', {}), [u])).ok
      : await u.context.callEngine((e, _h, el, s) => e.checkState(el, s), [u, state]);
    if (ok) return;
    if (deadline.expired()) throw new TimeoutError(timeoutMessage('elementHandle.waitForElementState', timeout, [`waiting for the element to be ${state}`]));
    await sleep(pollDelay(attempt));
  }
}

/** Element handles from a page-side array handle (the array handle is disposed). */
export async function arrayToElements(arr: JSHandle): Promise<ElementHandle[]> {
  const props = await arr.getProperties();
  await arr.dispose();
  const out: ElementHandle[] = [];
  const entries = [...props.entries()].filter(([k]) => /^\d+$/.test(k)).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [, v] of entries) {
    const el = v.asElement();
    if (el) out.push(el as ElementHandle);
    else await v.dispose();
  }
  return out;
}

export { RetryableError };
