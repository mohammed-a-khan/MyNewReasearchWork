/** JSHandle and ElementHandle: references to page objects. */
import { writeFile } from 'node:fs/promises';
import type { ElementStateName, SelectorChain } from '../injected/contract.js';
import * as actions from '../actions.js';
import { deserializeValue } from '../serializer.js';
import type { FilePayload, Rect } from '../types.js';
import type { ExecutionContext, RemoteObject } from './exec-context.js';
import type { ChromiumFrame } from './frame.js';
import { parseSelector } from '../selector-parser.js';
import { tooManyMatchesMessage } from '../messages.js';
import type { PageFunctionOn } from '../eval-types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export class JSHandle<T = unknown> {
  disposed = false;
  /** Marker for type-level compatibility (unused at runtime). */
  declare readonly __type?: T;

  constructor(
    readonly context: ExecutionContext,
    readonly remote: RemoteObject,
  ) {}

  get objectId(): string | undefined {
    return this.remote.objectId;
  }

  /** Primitive value when the remote object has no id. */
  primitiveValue(): unknown {
    if (this.remote.unserializableValue !== undefined) return deserializeValue({ __ez$: 'n', v: this.remote.unserializableValue });
    return this.remote.value;
  }

  async evaluate<R, Arg = unknown>(fn: PageFunctionOn<T, Arg, R>, arg?: Arg): Promise<R> {
    return (await this.context.evaluate(fn as any, [this.argSelf(), arg], true)) as R;
  }

  async evaluateHandle<R, Arg = unknown>(fn: PageFunctionOn<T, Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    return (await this.context.evaluate(fn as any, [this.argSelf(), arg], false)) as JSHandle<R>;
  }

  /** The handle itself as an evaluate() argument (primitives are passed by value). */
  argSelf(): unknown {
    return this.objectId ? this : this.primitiveValue();
  }

  async jsonValue(): Promise<T> {
    if (!this.objectId) return this.primitiveValue() as T;
    return (await this.context.evaluate((o: unknown) => o, [this], true)) as T;
  }

  async getProperty(name: string): Promise<JSHandle> {
    return (await this.context.evaluate((o: any, n: string) => o[n], [this, name], false)) as JSHandle;
  }

  async getProperties(): Promise<Map<string, JSHandle>> {
    if (!this.objectId) return new Map();
    return this.context.getProperties(this);
  }

  asElement(): ElementHandle<any> | null {
    return null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.context.releaseHandle(this);
  }

  toString(): string {
    if (!this.objectId) return `JSHandle:${String(this.primitiveValue())}`;
    return `JSHandle@${this.remote.subtype ?? this.remote.type}`;
  }
}

export class ElementHandle<T extends Node = Element> extends JSHandle<T> {
  override asElement(): ElementHandle<any> {
    return this;
  }

  get frame(): ChromiumFrame {
    return this.context.frame!;
  }

  /** The handle in the frame's engine world (where the engine lives). */
  async inEngineWorld(): Promise<ElementHandle> {
    if (this.context.world === 'engine') return this as unknown as ElementHandle;
    const ctx = await this.frame.context('engine');
    return ctx.adoptElement(this as unknown as ElementHandle);
  }

  /** The handle in the frame's main world (where page scripts live). */
  async inMain(): Promise<ElementHandle> {
    if (this.context.world === 'main') return this as unknown as ElementHandle;
    const ctx = await this.frame.context('main');
    return ctx.adoptElement(this as unknown as ElementHandle);
  }

  override async evaluate<R, Arg = unknown>(fn: PageFunctionOn<T, Arg, R>, arg?: Arg): Promise<R> {
    const main = await this.inMain();
    return (await main.context.evaluate(fn as any, [main, arg], true)) as R;
  }

  override async evaluateHandle<R, Arg = unknown>(fn: PageFunctionOn<T, Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    const main = await this.inMain();
    return (await main.context.evaluate(fn as any, [main, arg], false)) as JSHandle<R>;
  }

  async ownerFrame(): Promise<ChromiumFrame | null> {
    return this.frame;
  }

  /** The frame an <iframe>/<frame> element shows, or null. */
  async contentFrame(): Promise<ChromiumFrame | null> {
    return this.context.contentFrameOf(this as unknown as ElementHandle);
  }

  private target(): actions.ElementTarget {
    return actions.handleTarget(this as unknown as ElementHandle);
  }

  async boundingBox(): Promise<Rect | null> {
    return actions.boundingBox(this as unknown as ElementHandle);
  }

  async click(options: actions.ClickOptions = {}): Promise<void> {
    await actions.pointerAction('elementHandle.click', this.target(), 'click', options);
  }

  async dblclick(options: actions.ClickOptions = {}): Promise<void> {
    await actions.pointerAction('elementHandle.dblclick', this.target(), 'dblclick', options);
  }

  async hover(options: actions.PointerOptions = {}): Promise<void> {
    await actions.pointerAction('elementHandle.hover', this.target(), 'hover', options);
  }

  async tap(options: actions.PointerOptions = {}): Promise<void> {
    await actions.pointerAction('elementHandle.tap', this.target(), 'tap', options);
  }

  async fill(value: string, options: actions.ActionOptions = {}): Promise<void> {
    await actions.fill('elementHandle.fill', this.target(), value, options);
  }

  async clear(options: actions.ActionOptions = {}): Promise<void> {
    await actions.fill('elementHandle.clear', this.target(), '', options);
  }

  async type(text: string, options: actions.TypeOptions = {}): Promise<void> {
    await actions.typeText('elementHandle.type', this.target(), text, options);
  }

  async press(key: string, options: actions.TypeOptions = {}): Promise<void> {
    await actions.pressKey('elementHandle.press', this.target(), key, options);
  }

  async focus(): Promise<void> {
    await actions.focus('elementHandle.focus', this.target(), {});
  }

  async check(options: actions.ClickOptions = {}): Promise<void> {
    await actions.setChecked('elementHandle.check', this.target(), true, options);
  }

  async uncheck(options: actions.ClickOptions = {}): Promise<void> {
    await actions.setChecked('elementHandle.uncheck', this.target(), false, options);
  }

  async setChecked(checked: boolean, options: actions.ClickOptions = {}): Promise<void> {
    await actions.setChecked('elementHandle.setChecked', this.target(), checked, options);
  }

  async selectOption(values: actions.SelectValues, options: actions.ActionOptions = {}): Promise<string[]> {
    return actions.selectOption('elementHandle.selectOption', this.target(), values, options);
  }

  async selectText(options: actions.ActionOptions = {}): Promise<void> {
    await actions.selectText('elementHandle.selectText', this.target(), options);
  }

  async setInputFiles(files: string | FilePayload | string[] | FilePayload[], options: actions.ActionOptions = {}): Promise<void> {
    await actions.setInputFiles('elementHandle.setInputFiles', this.target(), files, options);
  }

  async dispatchEvent(type: string, eventInit: Record<string, unknown> = {}): Promise<void> {
    await actions.dispatchEvent('elementHandle.dispatchEvent', this.target(), type, eventInit, {});
  }

  async scrollIntoViewIfNeeded(options: actions.ActionOptions = {}): Promise<void> {
    await actions.scrollIntoView('elementHandle.scrollIntoViewIfNeeded', this.target(), options);
  }

  async screenshot(options: actions.ElementScreenshotOptions = {}): Promise<Buffer> {
    const buf = await actions.elementScreenshot('elementHandle.screenshot', this.target(), options);
    if (options.path) await writeFile(options.path, buf);
    return buf;
  }

  async textContent(): Promise<string | null> {
    return this.evaluate((e: Node) => e.textContent);
  }

  async innerText(): Promise<string> {
    const u = await this.inEngineWorld();
    return u.context.callEngine((_e, h, el) => h.innerText(el), [u]);
  }

  async innerHTML(): Promise<string> {
    return this.evaluate((e: Node) => (e as Element).innerHTML);
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.evaluate((e: Node, n: string) => (e as Element).getAttribute(n), name);
  }

  async inputValue(): Promise<string> {
    const u = await this.inEngineWorld();
    return u.context.callEngine((_e, h, el) => h.inputValue(el), [u]);
  }

  private async state(s: ElementStateName): Promise<boolean> {
    const u = await this.inEngineWorld();
    return u.context.callEngine((e, _h, el, st) => e.checkState(el, st), [u, s]);
  }

  isVisible(): Promise<boolean> {
    return this.state('visible');
  }

  isHidden(): Promise<boolean> {
    return this.state('hidden');
  }

  isEnabled(): Promise<boolean> {
    return this.state('enabled');
  }

  isDisabled(): Promise<boolean> {
    return this.state('disabled');
  }

  isEditable(): Promise<boolean> {
    return this.state('editable');
  }

  isChecked(): Promise<boolean> {
    return this.state('checked');
  }

  async waitForElementState(state: 'visible' | 'hidden' | 'stable' | 'enabled' | 'disabled' | 'editable', options: { timeout?: number } = {}): Promise<void> {
    await actions.waitForElementState(this as unknown as ElementHandle, state, options.timeout ?? this.frame._page.defaultTimeout());
  }

  /** First element matching `selector` under this element, or null. */
  async $(selector: string): Promise<ElementHandle | null> {
    const all = await this.$$(selector);
    if (all.length > 1 && this.frame.page().context().options.strictSelectors) {
      for (const h of all) await h.dispose();
      throw new Error(`elementHandle.$: ${tooManyMatchesMessage(`"${selector}"`, all.length)} (strictSelectors is on for this context)`);
    }
    for (const h of all.slice(1)) await h.dispose();
    return all[0] ?? null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.queryChain(parseSelector(selector));
  }

  /** Query a chain under this element (engine-world handles). */
  async queryChain(chain: SelectorChain): Promise<ElementHandle[]> {
    const u = await this.inEngineWorld();
    return u.context.queryElements(chain, u);
  }

  async $eval<R, Arg = unknown>(selector: string, fn: (el: Element, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    const el = await this.$(selector);
    if (!el) throw new Error(`$eval: nothing under this element matches the selector "${selector}"`);
    try {
      return await el.evaluate(fn as any, arg);
    } finally {
      await el.dispose();
    }
  }

  async $$eval<R, Arg = unknown>(selector: string, fn: (els: Element[], arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    const els = await this.$$(selector);
    const mains = await Promise.all(els.map((e) => e.inMain()));
    const ctx = mains[0]?.context ?? (await this.frame.context('main'));
    return (await ctx.evaluate(fn as any, [mains, arg], true)) as R;
  }

  override toString(): string {
    return `JSHandle@${this.remote.description ?? 'node'}`;
  }
}
