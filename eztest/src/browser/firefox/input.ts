/**
 * Keyboard, mouse, wheel and touch for Firefox through WebDriver BiDi
 * `input.performActions`. Key names resolve through the same US layout table
 * as the CDP engine; keys are sent as WebDriver key values: the character for
 * printable keys, the WebDriver code points (U+E000 block, "Keyboard actions"
 * table of the WebDriver spec) for named keys.
 */
import type { KeyDef } from '../input/us-layout.js';
import { Keyboard, Mouse, Touchscreen } from '../chromium/input.js';
import type { MouseButton } from '../types.js';
import { sleep } from '../util.js';
import { cdpUnavailable } from './stubs.js';

/** WebDriver key values of named keys, by UI Events code. */
export const WEBDRIVER_KEYS: Readonly<Record<string, string>> = {
  Help: '',
  Backspace: '',
  Tab: '',
  Enter: '',
  NumpadEnter: '',
  ShiftLeft: '',
  ControlLeft: '',
  AltLeft: '',
  Pause: '',
  Escape: '',
  PageUp: '',
  PageDown: '',
  End: '',
  Home: '',
  ArrowLeft: '',
  ArrowUp: '',
  ArrowRight: '',
  ArrowDown: '',
  Insert: '',
  Delete: '',
  NumpadEqual: '',
  Numpad0: '',
  Numpad1: '',
  Numpad2: '',
  Numpad3: '',
  Numpad4: '',
  Numpad5: '',
  Numpad6: '',
  Numpad7: '',
  Numpad8: '',
  Numpad9: '',
  NumpadMultiply: '',
  NumpadAdd: '',
  NumpadSubtract: '',
  NumpadDecimal: '',
  NumpadDivide: '',
  F1: '',
  F2: '',
  F3: '',
  F4: '',
  F5: '',
  F6: '',
  F7: '',
  F8: '',
  F9: '',
  F10: '',
  F11: '',
  F12: '',
  MetaLeft: '',
  ShiftRight: '',
  ControlRight: '',
  AltRight: '',
  MetaRight: '',
};

/**
 * The WebDriver key value for a key of the layout table, or undefined when
 * WebDriver has no way to press it (CapsLock, F13+, media keys ...).
 */
export function webdriverKeyValue(def: KeyDef, shift: boolean, name: string): string | undefined {
  if (def.code === '') return [...name].length === 1 ? name : undefined;
  const named = WEBDRIVER_KEYS[def.code];
  if (named) return named;
  if (def.key.length === 1) return shift && def.shiftKey ? def.shiftKey : def.key;
  return undefined;
}

/** What the input devices need from their page. */
export interface InputTarget {
  performActions(actions: unknown[]): Promise<void>;
  /** Fallback for keys WebDriver cannot press: a synthetic (untrusted) KeyboardEvent in the focused frame. */
  syntheticKey(type: 'keydown' | 'keyup', init: Record<string, unknown>): Promise<void>;
  /** Insert text at the caret of the focused element (like an IME commit); false when nothing editable is focused. */
  insertText(text: string): Promise<boolean>;
  viewport(): { width: number; height: number } | null;
}

const MOD_BITS = new Set(['Alt', 'Control', 'Meta', 'Shift']);
const STUB = cdpUnavailable('Input') as never;

export class FfKeyboard extends Keyboard {
  constructor(private readonly target: InputTarget, slowMo: () => number) {
    super(() => STUB, slowMo);
  }

  override async down(key: string): Promise<void> {
    const { def, shifted } = this.def(key);
    const repeat = this.down_.has(def.code);
    this.down_.add(def.code);
    if (MOD_BITS.has(def.key)) this.pressed.add(def.key);
    const shift = this.pressed.has('Shift') || shifted;
    const value = webdriverKeyValue(def, shift, key);
    if (value === undefined) {
      await this.target.syntheticKey('keydown', { key: def.key, code: def.code, keyCode: def.keyCode, location: def.location, repeat, ...this.modifierInit() });
      return;
    }
    await this.target.performActions([{ type: 'key', id: 'ez-keyboard', actions: [{ type: 'keyDown', value }] }]);
  }

  override async up(key: string): Promise<void> {
    const { def, shifted } = this.def(key);
    const shift = this.pressed.has('Shift') || shifted;
    if (MOD_BITS.has(def.key)) this.pressed.delete(def.key);
    this.down_.delete(def.code);
    const value = webdriverKeyValue(def, shift, key);
    if (value === undefined) {
      await this.target.syntheticKey('keyup', { key: def.key, code: def.code, keyCode: def.keyCode, location: def.location, ...this.modifierInit() });
      return;
    }
    await this.target.performActions([{ type: 'key', id: 'ez-keyboard', actions: [{ type: 'keyUp', value }] }]);
  }

  override async insertText(text: string): Promise<void> {
    if (await this.target.insertText(text)) return;
    // Nothing editable focused (or the editor refused): type the graphemes as keys.
    const actions = [...text].flatMap((ch) => [{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }]);
    if (actions.length) await this.target.performActions([{ type: 'key', id: 'ez-keyboard', actions }]);
  }

  private modifierInit(): Record<string, boolean> {
    return { shiftKey: this.pressed.has('Shift'), ctrlKey: this.pressed.has('Control'), altKey: this.pressed.has('Alt'), metaKey: this.pressed.has('Meta') };
  }
}

const BUTTONS: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };

export class FfMouse extends Mouse {
  constructor(private readonly target: InputTarget, keyboard: Keyboard, slowMo: () => number) {
    super(() => STUB, keyboard, slowMo);
  }

  private clamp(x: number, y: number): { x: number; y: number } {
    const vp = this.target.viewport();
    if (!vp) return { x: Math.max(0, x), y: Math.max(0, y) };
    return { x: Math.min(Math.max(0, x), vp.width - 1), y: Math.min(Math.max(0, y), vp.height - 1) };
  }

  private send(actions: unknown[]): Promise<void> {
    return this.target.performActions([{ type: 'pointer', id: 'ez-mouse', parameters: { pointerType: 'mouse' }, actions }]);
  }

  override async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, Math.floor(options.steps ?? 1));
    const fromX = this.x;
    const fromY = this.y;
    const actions: unknown[] = [];
    for (let i = 1; i <= steps; i++) {
      const p = this.clamp(fromX + ((x - fromX) * i) / steps, fromY + ((y - fromY) * i) / steps);
      actions.push({ type: 'pointerMove', x: p.x, y: p.y, origin: 'viewport', duration: 0 });
    }
    await this.send(actions);
    this.x = x;
    this.y = y;
  }

  override async down(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = options.button ?? 'left';
    this.buttons.add(button);
    this.pressesSent++;
    await this.send([{ type: 'pointerDown', button: BUTTONS[button] }]);
  }

  override async up(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = options.button ?? 'left';
    this.buttons.delete(button);
    await this.send([{ type: 'pointerUp', button: BUTTONS[button] }]);
  }

  override async click(x: number, y: number, options: { button?: MouseButton; clickCount?: number; delay?: number } = {}): Promise<void> {
    if (options.delay) return super.click(x, y, options);
    // One command for the whole click: Firefox counts the clicks of a burst (dblclick) itself.
    const count = options.clickCount ?? 1;
    const p = this.clamp(x, y);
    const button = BUTTONS[options.button ?? 'left'];
    const actions: unknown[] = [{ type: 'pointerMove', x: p.x, y: p.y, origin: 'viewport', duration: 0 }];
    for (let i = 0; i < count; i++) actions.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });
    this.pressesSent++;
    await this.send(actions);
    this.x = x;
    this.y = y;
    const slow = this.slowMo();
    if (slow) await sleep(slow);
  }

  override async wheel(deltaX: number, deltaY: number): Promise<void> {
    const p = this.clamp(this.x, this.y);
    await this.target.performActions([{
      type: 'wheel', id: 'ez-wheel', actions: [{ type: 'scroll', x: Math.round(p.x), y: Math.round(p.y), deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), origin: 'viewport' }],
    }]);
  }
}

export class FfTouchscreen extends Touchscreen {
  constructor(private readonly target: InputTarget, keyboard: Keyboard, hasTouch: () => boolean) {
    super(() => STUB, keyboard, hasTouch);
  }

  override async tap(x: number, y: number): Promise<void> {
    if (!this.hasTouch()) throw new Error('hasTouch must be enabled on the browser context before using the touchscreen.');
    this.touchesSent++;
    await this.target.performActions([{
      type: 'pointer', id: 'ez-touch', parameters: { pointerType: 'touch' },
      actions: [{ type: 'pointerMove', x, y, origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
    }]);
  }
}
