/**
 * Locators: lazy, strict, chainable element queries with auto-waiting.
 *
 * A locator is a scope (page, frame, or a frame reached through
 * frameLocator()) plus a selector chain for the injected engine. Nothing is
 * looked up until an action runs; every attempt re-resolves the chain, so
 * locators survive re-renders and navigations. Actions require exactly one
 * match (the single-match rule); count()/all()/evaluateAll() do not.
 */
import { writeFile } from 'node:fs/promises';
import type { SelectorChain, SelectorStep, TextMatch } from './injected/contract.js';
import { TimeoutError, isClosedError, isContextGoneError } from './errors.js';
import { FRAME_GONE_TEXT, closedMessage, timeoutMessage, tooManyMatchesMessage } from './messages.js';
import { parseSelector } from './selector-parser.js';
import type { FilePayload, Rect } from './types.js';
import { Deadline, isRegExp, pollDelay, quote, sleep } from './util.js';
import * as actions from './actions.js';
import type { ChromiumFrame } from './chromium/frame.js';
import type { ChromiumPage } from './chromium/page.js';
import type { ElementHandle, JSHandle } from './chromium/handles.js';
import type { PageFunctionOn } from './eval-types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type LocatorScope =
  | { kind: 'page'; page: ChromiumPage }
  | { kind: 'frame'; frame: ChromiumFrame }
  | { kind: 'frameLocator'; parent: LocatorScope; chain: SelectorChain; description: string };

export function frameScope(frame: ChromiumFrame): LocatorScope {
  return { kind: 'frame', frame };
}

export interface LocatorOptions {
  has?: Locator;
  hasNot?: Locator;
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  visible?: boolean;
}

export interface TextOptions {
  exact?: boolean;
}

/** Options of the layout filters (below, above, rightOf, leftOf, near). */
export interface LayoutOptions {
  /** Only matches within this many CSS pixels of the anchor (near: default 50). */
  maxDistance?: number;
  /** Keep only the closest matches (default true). */
  nearest?: boolean;
}

export interface GetByRoleOptions {
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  pressed?: boolean;
  selected?: boolean;
}

/** Attribute used by getByTestId (selectors.setTestIdAttribute). */
let testIdAttribute = 'data-testid';
export function setTestIdAttribute(name: string): void {
  testIdAttribute = name;
}

/** Selector settings: `selectors.setTestIdAttribute('data-qa')` changes what getByTestId matches. */
export const selectors = {
  setTestIdAttribute,
};

function toTextMatch(v: string | RegExp): TextMatch {
  return isRegExp(v) ? { regex: v.source, flags: v.flags } : v;
}

function describeText(v: string | RegExp): string {
  return isRegExp(v) ? String(v) : quote(v);
}

function scopePage(s: LocatorScope): ChromiumPage {
  if (s.kind === 'page') return s.page;
  if (s.kind === 'frame') return s.frame.page();
  return scopePage(s.parent);
}

function scopeDescription(s: LocatorScope): string {
  if (s.kind === 'frameLocator') {
    const parent = scopeDescription(s.parent);
    return `${parent}${parent ? '.' : ''}${s.description}`;
  }
  return '';
}

class FrameNotReady extends Error {}

/** Resolve a scope to its frame (waiting is done by the caller's retry loop). */
async function resolveScope(s: LocatorScope): Promise<ChromiumFrame> {
  if (s.kind === 'page') return s.page.mainFrame();
  if (s.kind === 'frame') {
    if (s.frame.isDetached()) throw new Error(FRAME_GONE_TEXT);
    return s.frame;
  }
  const parent = await resolveScope(s.parent);
  const ctx = await parent.context('engine');
  const els = await ctx.queryElements(s.chain);
  try {
    if (els.length === 0) throw new FrameNotReady(`waiting for ${scopeDescription(s)}`);
    if (els.length > 1) {
      throw new Error(tooManyMatchesMessage(scopeDescription(s), els.length));
    }
    const frame = await els[0].contentFrame();
    if (!frame) throw new FrameNotReady(`waiting for the content frame of ${scopeDescription(s)}`);
    return frame;
  } finally {
    for (const e of els) void e.dispose();
  }
}

export class Locator {
  constructor(
    readonly scope: LocatorScope,
    readonly chain: SelectorChain,
    private readonly desc: string,
  ) {}

  /** An empty locator on a scope (only for building getBy* locators). */
  static root(scope: LocatorScope): Locator {
    return new Locator(scope, [], scopeDescription(scope));
  }

  static fromScope(scope: LocatorScope, selector: string | Locator, options?: LocatorOptions): Locator {
    return Locator.root(scope).locator(selector, options);
  }

  private derive(steps: SelectorStep[], descPart: string): Locator {
    const sep = this.desc ? '.' : '';
    return new Locator(this.scope, [...this.chain, ...steps], `${this.desc}${sep}${descPart}`);
  }

  private withFilters(loc: Locator, o: LocatorOptions | undefined): Locator {
    if (!o) return loc;
    let l = loc;
    if (o.hasText !== undefined) l = l.derive([{ hasText: toTextMatch(o.hasText) }], `filter({ hasText: ${describeText(o.hasText)} })`);
    if (o.hasNotText !== undefined) l = l.derive([{ hasNotText: toTextMatch(o.hasNotText) }], `filter({ hasNotText: ${describeText(o.hasNotText)} })`);
    if (o.has) l = l.derive([{ has: o.has.chain }], `filter({ has: ${o.has.toString()} })`);
    if (o.hasNot) l = l.derive([{ hasNot: o.hasNot.chain }], `filter({ hasNot: ${o.hasNot.toString()} })`);
    if (o.visible !== undefined) l = l.derive([{ visible: o.visible }], `filter({ visible: ${o.visible} })`);
    return l;
  }

  // ------------------------------------------------------------------ building
  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    if (typeof selector !== 'string') {
      if (scopePage(selector.scope) !== this.page()) throw new Error('Both locators must come from the same page; build the inner locator from this page.');
      return this.withFilters(this.derive(selector.chain, `locator(${selector.toString()})`), options);
    }
    return this.withFilters(this.derive(parseSelector(selector), `locator(${quote(selector)})`), options);
  }

  getByRole(role: string, o: GetByRoleOptions = {}): Locator {
    const step: SelectorStep = {
      role,
      ...(o.name !== undefined ? { name: toTextMatch(o.name) } : {}),
      ...(o.exact !== undefined ? { exact: o.exact } : {}),
      ...(o.checked !== undefined ? { checked: o.checked } : {}),
      ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
      ...(o.expanded !== undefined ? { expanded: o.expanded } : {}),
      ...(o.includeHidden !== undefined ? { includeHidden: o.includeHidden } : {}),
      ...(o.level !== undefined ? { level: o.level } : {}),
      ...(o.pressed !== undefined ? { pressed: o.pressed } : {}),
      ...(o.selected !== undefined ? { selected: o.selected } : {}),
    };
    const opts = Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v) : String(v)}`);
    return this.derive([step], `getByRole(${quote(role)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`);
  }

  getByText(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ text: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByText(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  getByLabel(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ label: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByLabel(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  getByPlaceholder(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ placeholder: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByPlaceholder(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  getByAltText(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ altText: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByAltText(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  getByTitle(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ title: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByTitle(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.derive([{ testId: toTextMatch(testId), attr: testIdAttribute }], `getByTestId(${describeText(testId)})`);
  }

  nth(index: number): Locator {
    return this.derive([{ nth: index }], `nth(${index})`);
  }

  first(): Locator {
    return this.derive([{ nth: 0 }], 'first()');
  }

  last(): Locator {
    return this.derive([{ nth: -1 }], 'last()');
  }

  filter(options: LocatorOptions = {}): Locator {
    return this.withFilters(this, options);
  }

  /**
   * Layout filters: keep the matches below / above / right of / left of / near
   * `anchor` (a locator of the same page or frame). By default only the closest
   * matches are kept (`nearest: false` keeps every match on that side, closest
   * first is not implied); `near` uses `maxDistance` (default 50 px).
   */
  below(anchor: Locator, o: LayoutOptions = {}): Locator {
    return this.layout('below', anchor, o);
  }

  above(anchor: Locator, o: LayoutOptions = {}): Locator {
    return this.layout('above', anchor, o);
  }

  rightOf(anchor: Locator, o: LayoutOptions = {}): Locator {
    return this.layout('rightOf', anchor, o);
  }

  leftOf(anchor: Locator, o: LayoutOptions = {}): Locator {
    return this.layout('leftOf', anchor, o);
  }

  near(anchor: Locator, o: LayoutOptions = {}): Locator {
    return this.layout('near', anchor, o);
  }

  private layout(rel: 'below' | 'above' | 'rightOf' | 'leftOf' | 'near', anchor: Locator, o: LayoutOptions): Locator {
    if (scopePage(anchor.scope) !== this.page()) throw new Error('Layout anchors must belong to the same page.');
    const step: SelectorStep = {
      layout: rel,
      anchor: anchor.chain,
      ...(o.maxDistance !== undefined ? { maxDistance: o.maxDistance } : {}),
      ...(o.nearest === false ? { nearest: false } : {}),
    };
    const opts = [o.maxDistance !== undefined ? `maxDistance: ${o.maxDistance}` : '', o.nearest === false ? 'nearest: false' : ''].filter(Boolean);
    return this.derive([step], `${rel}(${anchor.toString()}${opts.length ? `, { ${opts.join(', ')} }` : ''})`);
  }

  /** Containers labelled `text` (landmark name, fieldset legend or first heading) inside this locator. */
  getBySection(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ section: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getBySection(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  /** Row-like elements (tr, li, role=row, repeated siblings) containing `text`. */
  getByRow(text: string | RegExp, o: TextOptions = {}): Locator {
    return this.derive([{ row: toTextMatch(text), ...(o.exact ? { exact: true } : {}) }], `getByRow(${describeText(text)}${o.exact ? ', { exact: true }' : ''})`);
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.scopeForChildren(), selector, this.chain, this.desc);
  }

  /** A FrameLocator for the iframe this locator points to. */
  contentFrame(): FrameLocator {
    return FrameLocator.fromChain(this.scope, this.chain, `${this.desc}.contentFrame()`);
  }

  private scopeForChildren(): LocatorScope {
    return this.scope;
  }

  page(): ChromiumPage {
    return scopePage(this.scope);
  }

  toString(): string {
    return this.desc || 'locator(":root")';
  }

  /** A copy of this locator with a human-readable description (used in messages and traces). */
  describe(description: string): Locator {
    return new Locator(this.scope, this.chain, description);
  }

  // ------------------------------------------------------------------ resolution
  /** All matches now (engine-world handles), with their frame. */
  async queryAll(): Promise<{ frame: ChromiumFrame; handles: ElementHandle[] }> {
    const frame = await resolveScope(this.scope);
    for (let attempt = 0; ; attempt++) {
      try {
        const ctx = await frame.context('engine');
        return { frame, handles: await ctx.queryElements(this.chain) };
      } catch (e) {
        if (attempt < 5 && (isContextGoneError(e) || (e as { contextGone?: boolean }).contextGone)) {
          await sleep(30);
          continue;
        }
        throw e;
      }
    }
  }

  private async strictViolation(frame: ChromiumFrame, handles: ElementHandle[]): Promise<Error> {
    const descs: string[] = [];
    for (const h of handles.slice(0, 10)) descs.push(await h.context.callEngine((e, _h, el) => e.describe(el), [h]).catch(() => '<element>'));
    for (const h of handles) void h.dispose();
    void frame;
    return new Error(tooManyMatchesMessage(this.toString(), handles.length, descs, handles.length > 10));
  }

  /** The action target: exactly one element per attempt, or null while there is none. */
  target(strict = true): actions.ElementTarget {
    return {
      description: this.toString(),
      page: this.page(),
      resolve: async () => {
        let res: { frame: ChromiumFrame; handles: ElementHandle[] };
        try {
          res = await this.queryAll();
        } catch (e) {
          if (e instanceof FrameNotReady) return null;
          throw e;
        }
        if (res.handles.length === 0) return null;
        if (res.handles.length > 1 && strict) throw await this.strictViolation(res.frame, res.handles);
        for (const h of res.handles.slice(1)) void h.dispose();
        return { frame: res.frame, el: res.handles[0] };
      },
    };
  }

  /** Wait for one element and run fn on it (read-only operations). */
  private async withElement<T>(api: string, options: { timeout?: number }, fn: (r: actions.Resolved) => Promise<T>): Promise<T> {
    const t = this.target();
    return actions.retrying(api, t, options.timeout ?? this.page().defaultTimeout(), async (r) => ({ done: await fn(r) }));
  }

  // ------------------------------------------------------------------ actions
  private traced<T>(method: string, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const page = this.page();
    const tracing = page.context().tracing;
    if (!tracing.isRecording()) return fn();
    return tracing.action(page, 'Frame', method, { selector: this.toString(), ...params }, fn, this.scope.kind === 'page' ? this.chain : undefined);
  }

  click(options: actions.ClickOptions = {}): Promise<void> {
    return this.traced('click', {}, () => actions.pointerAction('locator.click', this.target(), 'click', options));
  }

  dblclick(options: actions.ClickOptions = {}): Promise<void> {
    return this.traced('dblclick', {}, () => actions.pointerAction('locator.dblclick', this.target(), 'dblclick', options));
  }

  hover(options: actions.PointerOptions = {}): Promise<void> {
    return this.traced('hover', {}, () => actions.pointerAction('locator.hover', this.target(), 'hover', options));
  }

  tap(options: actions.PointerOptions = {}): Promise<void> {
    return this.traced('tap', {}, () => actions.pointerAction('locator.tap', this.target(), 'tap', options));
  }

  fill(value: string, options: actions.ActionOptions = {}): Promise<void> {
    return this.traced('fill', { value }, () => actions.fill('locator.fill', this.target(), value, options));
  }

  clear(options: actions.ActionOptions = {}): Promise<void> {
    return this.traced('clear', {}, () => actions.fill('locator.clear', this.target(), '', options));
  }

  press(key: string, options: actions.TypeOptions = {}): Promise<void> {
    return this.traced('press', { key }, () => actions.pressKey('locator.press', this.target(), key, options));
  }

  pressSequentially(text: string, options: actions.TypeOptions = {}): Promise<void> {
    return this.traced('pressSequentially', { text }, () => actions.typeText('locator.pressSequentially', this.target(), text, options));
  }

  type(text: string, options: actions.TypeOptions = {}): Promise<void> {
    return this.traced('type', { text }, () => actions.typeText('locator.type', this.target(), text, options));
  }

  focus(options: actions.ActionOptions = {}): Promise<void> {
    return this.traced('focus', {}, () => actions.focus('locator.focus', this.target(), options));
  }

  blur(options: actions.ActionOptions = {}): Promise<void> {
    return actions.blur('locator.blur', this.target(), options);
  }

  check(options: actions.ClickOptions = {}): Promise<void> {
    return this.traced('check', {}, () => actions.setChecked('locator.check', this.target(), true, options));
  }

  uncheck(options: actions.ClickOptions = {}): Promise<void> {
    return this.traced('uncheck', {}, () => actions.setChecked('locator.uncheck', this.target(), false, options));
  }

  setChecked(checked: boolean, options: actions.ClickOptions = {}): Promise<void> {
    return this.traced('setChecked', { checked }, () => actions.setChecked('locator.setChecked', this.target(), checked, options));
  }

  selectOption(values: actions.SelectValues, options: actions.ActionOptions = {}): Promise<string[]> {
    return this.traced('selectOption', { values }, () => actions.selectOption('locator.selectOption', this.target(), values, options));
  }

  selectText(options: actions.ActionOptions = {}): Promise<void> {
    return actions.selectText('locator.selectText', this.target(), options);
  }

  setInputFiles(files: string | FilePayload | string[] | FilePayload[], options: actions.ActionOptions = {}): Promise<void> {
    return this.traced('setInputFiles', {}, () => actions.setInputFiles('locator.setInputFiles', this.target(), files, options));
  }

  dispatchEvent(type: string, eventInit: Record<string, unknown> = {}, options: actions.ActionOptions = {}): Promise<void> {
    return actions.dispatchEvent('locator.dispatchEvent', this.target(), type, eventInit, options);
  }

  scrollIntoViewIfNeeded(options: actions.ActionOptions = {}): Promise<void> {
    return actions.scrollIntoView('locator.scrollIntoViewIfNeeded', this.target(), options);
  }

  async dragTo(target: Locator, options: { timeout?: number; force?: boolean; sourcePosition?: { x: number; y: number }; targetPosition?: { x: number; y: number }; trial?: boolean } = {}): Promise<void> {
    const page = this.page();
    await actions.pointerAction('locator.dragTo', this.target(), 'hover', { timeout: options.timeout, force: options.force, position: options.sourcePosition, trial: options.trial });
    if (options.trial) return;
    await page.mouse.down();
    const box = await target.boundingBox({ timeout: options.timeout });
    if (!box) throw new Error('locator.dragTo: the drop target has no visible box to drop onto');
    const tx = box.x + (options.targetPosition?.x ?? box.width / 2);
    const ty = box.y + (options.targetPosition?.y ?? box.height / 2);
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
  }

  async highlight(): Promise<void> {
    /* no inspector overlay */
  }

  async screenshot(options: actions.ElementScreenshotOptions & { path?: string } = {}): Promise<Buffer> {
    const buf = await actions.elementScreenshot('locator.screenshot', this.target(), options);
    if (options.path) await writeFile(options.path, buf);
    return buf;
  }

  // ------------------------------------------------------------------ reading
  async textContent(options: { timeout?: number } = {}): Promise<string | null> {
    return this.withElement('locator.textContent', options, (r) => r.el.context.callEngine((_e, _h, el) => el.textContent, [r.el]));
  }

  async innerText(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.innerText', options, (r) => r.el.context.callEngine((_e, h, el) => h.innerText(el), [r.el]));
  }

  async innerHTML(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.innerHTML', options, (r) => r.el.context.callEngine((_e, _h, el) => el.innerHTML, [r.el]));
  }

  async getAttribute(name: string, options: { timeout?: number } = {}): Promise<string | null> {
    return this.withElement('locator.getAttribute', options, (r) => r.el.context.callEngine((_e, _h, el, n) => el.getAttribute(n), [r.el, name]));
  }

  async inputValue(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.inputValue', options, (r) => r.el.context.callEngine((_e, h, el) => h.inputValue(h.resolveControl(el, 'control')), [r.el]));
  }

  private async stateNow(api: string, state: 'visible' | 'hidden'): Promise<boolean> {
    let res: { frame: ChromiumFrame; handles: ElementHandle[] };
    try {
      res = await this.queryAll();
    } catch (e) {
      if (e instanceof FrameNotReady || isContextGoneError(e)) return state === 'hidden';
      throw Object.assign(e as Error, { message: `${api}: ${(e as Error).message}` });
    }
    if (res.handles.length === 0) return state === 'hidden';
    if (res.handles.length > 1) {
      const err = await this.strictViolation(res.frame, res.handles);
      err.message = `${api}: ${err.message}`;
      throw err;
    }
    const h = res.handles[0];
    try {
      return await h.context.callEngine((e, _h, el, s) => e.checkState(el, s), [h, state]);
    } finally {
      void h.dispose();
    }
  }

  isVisible(_options: { timeout?: number } = {}): Promise<boolean> {
    return this.stateNow('locator.isVisible', 'visible');
  }

  isHidden(_options: { timeout?: number } = {}): Promise<boolean> {
    return this.stateNow('locator.isHidden', 'hidden');
  }

  private state(api: string, s: 'enabled' | 'disabled' | 'editable' | 'checked', options: { timeout?: number }): Promise<boolean> {
    return this.withElement(api, options, (r) => r.el.context.callEngine((e, h, el, st) => {
      const t = st === 'checked' || st === 'editable' ? h.resolveControl(el, 'control') : el;
      // Checkboxes and radios are editable when enabled and not read-only (they can be toggled).
      if (st === 'editable' && t.localName === 'input' && /^(checkbox|radio)$/i.test(t.type)) return !t.disabled && !t.readOnly && !e.checkState(t, 'disabled');
      return e.checkState(t, st);
    }, [r.el, s]));
  }

  isEnabled(options: { timeout?: number } = {}): Promise<boolean> {
    return this.state('locator.isEnabled', 'enabled', options);
  }

  isDisabled(options: { timeout?: number } = {}): Promise<boolean> {
    return this.state('locator.isDisabled', 'disabled', options);
  }

  isEditable(options: { timeout?: number } = {}): Promise<boolean> {
    return this.state('locator.isEditable', 'editable', options);
  }

  isChecked(options: { timeout?: number } = {}): Promise<boolean> {
    return this.state('locator.isChecked', 'checked', options);
  }

  async count(): Promise<number> {
    let res;
    try {
      res = await this.queryAll();
    } catch (e) {
      if (e instanceof FrameNotReady) return 0;
      throw Object.assign(e as Error, { message: `locator.count: ${(e as Error).message}` });
    }
    for (const h of res.handles) void h.dispose();
    return res.handles.length;
  }

  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  async allInnerTexts(): Promise<string[]> {
    const { handles } = await this.queryAll().catch((e) => (e instanceof FrameNotReady ? { handles: [] as ElementHandle[] } : Promise.reject(e)));
    try {
      return await Promise.all(handles.map((h) => h.context.callEngine((_e, hp, el) => hp.innerText(el), [h])));
    } finally {
      for (const h of handles) void h.dispose();
    }
  }

  async allTextContents(): Promise<string[]> {
    const { handles } = await this.queryAll().catch((e) => (e instanceof FrameNotReady ? { handles: [] as ElementHandle[] } : Promise.reject(e)));
    try {
      return await Promise.all(handles.map((h) => h.context.callEngine((_e, _h, el) => el.textContent ?? '', [h])));
    } finally {
      for (const h of handles) void h.dispose();
    }
  }

  async boundingBox(options: { timeout?: number } = {}): Promise<Rect | null> {
    return this.withElement('locator.boundingBox', options, (r) => actions.boundingBox(r.el));
  }

  /** Boxes of all matches (top-level viewport px); used for screenshot masks. */
  async boundingBoxesAll(): Promise<Rect[]> {
    let res;
    try {
      res = await this.queryAll();
    } catch {
      return [];
    }
    const out: Rect[] = [];
    for (const h of res.handles) {
      const b = await actions.boundingBox(h).catch(() => null);
      if (b) out.push(b);
      void h.dispose();
    }
    return out;
  }

  async waitFor(options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const timeout = options.timeout ?? this.page().defaultTimeout();
    const deadline = new Deadline(timeout);
    for (let attempt = 0; ; attempt++) {
      let n = 0;
      let visible = false;
      try {
        const res = await this.queryAll();
        n = res.handles.length;
        if (n > 1 && (state === 'visible' || state === 'attached')) {
          // Strict: waitFor needs exactly one element.
          const err = await this.strictViolation(res.frame, res.handles);
          err.message = `locator.waitFor: ${err.message}`;
          throw err;
        }
        if (n === 1) visible = await res.handles[0].context.callEngine((e, _h, el) => e.checkState(el, 'visible'), [res.handles[0]]);
        for (const h of res.handles) void h.dispose();
        if (n > 1) visible = true;
      } catch (e) {
        if (isClosedError(e) || this.page().isClosed()) throw new Error(closedMessage('locator.waitFor'));
        if (!(e instanceof FrameNotReady) && !isContextGoneError(e) && !(e as { contextGone?: boolean }).contextGone) throw e;
      }
      const ok = state === 'attached' ? n > 0 : state === 'detached' ? n === 0 : state === 'visible' ? visible : !visible;
      if (ok) return;
      if (deadline.expired()) {
        throw new TimeoutError(timeoutMessage('locator.waitFor', timeout, [`waiting for ${this.toString()} to be ${state}`]));
      }
      await sleep(Math.min(pollDelay(attempt), deadline.remaining()));
    }
  }

  // ------------------------------------------------------------------ evaluation and handles
  async evaluate<R, Arg = unknown, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: PageFunctionOn<E, Arg, R>, arg?: Arg, options: { timeout?: number } = {}): Promise<R> {
    return this.withElement('locator.evaluate', options, async (r) => {
      const main = await r.el.inMain();
      try {
        return (await main.context.evaluate(fn as any, [main, arg], true)) as R;
      } finally {
        void main.dispose();
      }
    });
  }

  async evaluateHandle<R, Arg = unknown, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: PageFunctionOn<E, Arg, R>, arg?: Arg, options: { timeout?: number } = {}): Promise<JSHandle<R>> {
    return this.withElement('locator.evaluateHandle', options, async (r) => {
      const main = await r.el.inMain();
      return (await main.context.evaluate(fn as any, [main, arg], false)) as JSHandle<R>;
    });
  }

  async evaluateAll<R, Arg = unknown, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: PageFunctionOn<E[], Arg, R>, arg?: Arg): Promise<R> {
    let res: { frame: ChromiumFrame; handles: ElementHandle[] };
    try {
      res = await this.queryAll();
    } catch (e) {
      if (!(e instanceof FrameNotReady)) throw e;
      const frame = await resolveScope(this.scope).catch(() => this.page().mainFrame());
      res = { frame, handles: [] };
    }
    const mains = await Promise.all(res.handles.map((h) => h.inMain()));
    for (const h of res.handles) void h.dispose();
    const ctx = mains[0]?.context ?? (await res.frame.context('main'));
    try {
      return (await ctx.evaluate(fn as any, [mains, arg], true)) as R;
    } finally {
      for (const m of mains) void m.dispose();
    }
  }

  /** Accessible name (accname 1.2), as assistive technology announces it. */
  async accessibleName(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.accessibleName', options, (r) => r.el.context.callEngine((e, _h, el) => e.accessibleName(el), [r.el]) as Promise<string>);
  }

  /** Accessible description (aria-describedby, aria-description, title). */
  async accessibleDescription(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.accessibleDescription', options, (r) => r.el.context.callEngine((e, _h, el) => (typeof e.accessibleDescription === 'function' ? e.accessibleDescription(el) : ''), [r.el]) as Promise<string>);
  }

  /** ARIA role (explicit, else implicit from HTML-AAM); '' when the element has none. */
  async ariaRole(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.ariaRole', options, (r) => r.el.context.callEngine((e, _h, el) => e.role(el) ?? '', [r.el]) as Promise<string>);
  }

  async elementHandle(options: { timeout?: number } = {}): Promise<ElementHandle> {
    return this.withElement('locator.elementHandle', options, async (r) => r.el.inMain());
  }

  async elementHandles(): Promise<ElementHandle[]> {
    let res;
    try {
      res = await this.queryAll();
    } catch (e) {
      if (e instanceof FrameNotReady) return [];
      throw e;
    }
    const mains = await Promise.all(res.handles.map((h) => h.inMain()));
    for (const h of res.handles) void h.dispose();
    return mains;
  }

  /** Accessibility snapshot of the element as YAML. */
  async ariaSnapshot(options: { timeout?: number } = {}): Promise<string> {
    return this.withElement('locator.ariaSnapshot', options, (r) =>
      r.el.context.callEngine((e, _h, el) => (typeof e.ariaSnapshot === 'function' ? e.ariaSnapshot(el) : `- ${e.role(el) ?? 'generic'} ${JSON.stringify(e.accessibleName(el))}`), [r.el]),
    );
  }
}

export class FrameLocator {
  private readonly frameScope_: LocatorScope;

  constructor(parent: LocatorScope, selector: string, baseChain: SelectorChain = [], baseDesc = '') {
    const chain = [...baseChain, ...parseSelector(selector)];
    const description = `${baseDesc}${baseDesc ? '.' : ''}frameLocator(${quote(selector)})`;
    this.frameScope_ = { kind: 'frameLocator', parent, chain, description };
  }

  static fromChain(parent: LocatorScope, chain: SelectorChain, description: string): FrameLocator {
    const fl = Object.create(FrameLocator.prototype) as FrameLocator;
    (fl as unknown as { frameScope_: LocatorScope }).frameScope_ = { kind: 'frameLocator', parent, chain, description };
    return fl;
  }

  private root(): Locator {
    return Locator.root(this.frameScope_);
  }

  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    return this.root().locator(selector, options);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return this.root().getByRole(role, options);
  }

  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByText(text, options);
  }

  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByLabel(text, options);
  }

  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByPlaceholder(text, options);
  }

  getByAltText(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByAltText(text, options);
  }

  getByTitle(text: string | RegExp, options?: TextOptions): Locator {
    return this.root().getByTitle(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.root().getByTestId(testId);
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.frameScope_, selector);
  }

  private withIframeStep(step: SelectorStep, part: string): FrameLocator {
    const s = this.frameScope_ as Extract<LocatorScope, { kind: 'frameLocator' }>;
    return FrameLocator.fromChain(s.parent, [...s.chain, step], `${s.description}.${part}`);
  }

  first(): FrameLocator {
    return this.withIframeStep({ nth: 0 }, 'first()');
  }

  last(): FrameLocator {
    return this.withIframeStep({ nth: -1 }, 'last()');
  }

  nth(index: number): FrameLocator {
    return this.withIframeStep({ nth: index }, `nth(${index})`);
  }

  /** A locator for the <iframe> element itself. */
  owner(): Locator {
    const s = this.frameScope_ as Extract<LocatorScope, { kind: 'frameLocator' }>;
    return new Locator(s.parent, s.chain, s.description.replace(/frameLocator\(/, 'locator('));
  }

  toString(): string {
    return (this.frameScope_ as Extract<LocatorScope, { kind: 'frameLocator' }>).description;
  }
}
