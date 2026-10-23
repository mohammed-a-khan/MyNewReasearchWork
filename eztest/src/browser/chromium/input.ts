/** Keyboard, mouse and touch input through the Input domain. */
import { resolveKey, type KeyDef } from '../input/us-layout.js';
import type { CDPSession } from '../transport/connection.js';
import type { MouseButton } from '../types.js';
import { sleep } from '../util.js';

const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const isMac = process.platform === 'darwin';

/** Editing commands macOS needs spelled out (headless has no native key bindings there). */
const MAC_COMMANDS: Record<string, string[]> = {
  'Meta+KeyA': ['selectAll'],
  'Meta+KeyC': ['copy'],
  'Meta+KeyX': ['cut'],
  'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
  'Meta+ArrowLeft': ['moveToBeginningOfLine'],
  'Meta+ArrowRight': ['moveToEndOfLine'],
  'Shift+Meta+ArrowLeft': ['moveToBeginningOfLineAndModifySelection'],
  'Shift+Meta+ArrowRight': ['moveToEndOfLineAndModifySelection'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'],
  'Alt+Backspace': ['deleteWordBackward'],
  'Meta+Backspace': ['deleteToBeginningOfLine'],
};

export class Keyboard {
  /** Modifier keys currently held ('Shift', 'Control', 'Alt', 'Meta'). */
  readonly pressed = new Set<string>();
  /** Codes of all keys currently held. */
  protected readonly down_ = new Set<string>();

  constructor(private readonly session: () => CDPSession, protected readonly slowMo: () => number) {}

  modifiers(): number {
    let m = 0;
    for (const k of this.pressed) m |= MOD_BITS[k] ?? 0;
    return m;
  }

  protected def(key: string): { def: KeyDef; shifted: boolean } {
    const name = key === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : key;
    const r = resolveKey(name);
    if (!r) {
      if ([...name].length === 1) {
        // A character outside the layout: no key code, just text.
        return { def: { code: '', keyCode: 0, key: name, location: 0, text: name }, shifted: false };
      }
      throw new Error(`Unknown key: "${key}"`);
    }
    return r;
  }

  async down(key: string): Promise<void> {
    const { def, shifted } = this.def(key);
    const autoRepeat = this.down_.has(def.code);
    this.down_.add(def.code);
    if (def.key in MOD_BITS) this.pressed.add(def.key);
    const shift = this.pressed.has('Shift') || shifted;
    let keyValue = shift && def.shiftKey ? def.shiftKey : def.key;
    if (def.code === '') keyValue = key;
    let text = shift ? (def.shiftText ?? def.text) : def.text;
    if (key.length === 1 && def.code === '') text = key;
    // With Control / Meta / Alt held, keys do not produce text (they are shortcuts).
    if (this.pressed.has('Control') || this.pressed.has('Meta') || (this.pressed.has('Alt') && !isMac)) text = undefined;
    const combo = [...this.pressed].filter((k) => k !== def.key).sort().concat(def.code).join('+');
    const commands = isMac ? MAC_COMMANDS[combo] : undefined;
    await this.session().send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      modifiers: this.modifiers(),
      windowsVirtualKeyCode: def.keyCode,
      code: def.code,
      key: keyValue,
      text,
      unmodifiedText: text,
      autoRepeat,
      location: def.location,
      isKeypad: def.location === 3,
      ...(commands ? { commands } : {}),
    });
  }

  async up(key: string): Promise<void> {
    const { def, shifted } = this.def(key);
    if (def.key in MOD_BITS) this.pressed.delete(def.key);
    this.down_.delete(def.code);
    const shift = this.pressed.has('Shift') || shifted;
    await this.session().send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: this.modifiers(),
      key: shift && def.shiftKey ? def.shiftKey : key.length === 1 && def.code === '' ? key : def.key,
      windowsVirtualKeyCode: def.keyCode,
      code: def.code,
      location: def.location,
    });
  }

  async insertText(text: string): Promise<void> {
    await this.session().send('Input.insertText', { text });
  }

  /** Press a key or a chord like "Control+Shift+A" (the "+" key itself is written "+" or "Shift++"). */
  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    const parts = splitChord(key);
    const main = parts.pop()!;
    for (const m of parts) await this.down(m);
    await this.down(main);
    if (options.delay) await sleep(options.delay);
    await this.up(main);
    for (const m of parts.reverse()) await this.up(m);
    const slow = this.slowMo();
    if (slow) await sleep(slow);
  }

  /** Type text key by key (characters outside the layout are inserted as text). */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') await this.press('Enter');
      else if (resolveKey(ch)) await this.press(ch);
      else await this.insertText(ch);
      if (options.delay) await sleep(options.delay);
    }
  }
}

export function splitChord(key: string): string[] {
  if (key === '+') return ['+'];
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (c === '+' && cur) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => (p === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : p));
}

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export class Mouse {
  x = 0;
  y = 0;
  protected buttons = new Set<MouseButton>();

  constructor(private readonly session: () => CDPSession, protected readonly keyboard: Keyboard, protected readonly slowMo: () => number) {}

  private buttonMask(): number {
    let m = 0;
    for (const b of this.buttons) m |= BUTTON_BITS[b];
    return m;
  }

  private current(): MouseButton | 'none' {
    for (const b of ['left', 'right', 'middle'] as MouseButton[]) if (this.buttons.has(b)) return b;
    return 'none';
  }

  async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, Math.floor(options.steps ?? 1));
    const fromX = this.x;
    const fromY = this.y;
    for (let i = 1; i <= steps; i++) {
      const px = fromX + ((x - fromX) * i) / steps;
      const py = fromY + ((y - fromY) * i) / steps;
      await this.session().send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: px, y: py, button: this.current(), buttons: this.buttonMask(), modifiers: this.keyboard.modifiers(),
      });
    }
    this.x = x;
    this.y = y;
  }

  async down(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = options.button ?? 'left';
    this.buttons.add(button);
    await this.session().send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: this.x, y: this.y, button, buttons: this.buttonMask(), clickCount: options.clickCount ?? 1, modifiers: this.keyboard.modifiers(),
    });
  }

  async up(options: { button?: MouseButton; clickCount?: number } = {}): Promise<void> {
    const button = options.button ?? 'left';
    this.buttons.delete(button);
    await this.session().send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: this.x, y: this.y, button, buttons: this.buttonMask(), clickCount: options.clickCount ?? 1, modifiers: this.keyboard.modifiers(),
    });
  }

  async click(x: number, y: number, options: { button?: MouseButton; clickCount?: number; delay?: number } = {}): Promise<void> {
    const count = options.clickCount ?? 1;
    await this.move(x, y);
    for (let i = 1; i <= count; i++) {
      await this.down({ button: options.button, clickCount: i });
      if (options.delay) await sleep(options.delay);
      await this.up({ button: options.button, clickCount: i });
      if (options.delay && i < count) await sleep(options.delay);
    }
    const slow = this.slowMo();
    if (slow) await sleep(slow);
  }

  async dblclick(x: number, y: number, options: { button?: MouseButton; delay?: number } = {}): Promise<void> {
    await this.click(x, y, { ...options, clickCount: 2 });
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.session().send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.x, y: this.y, deltaX, deltaY, modifiers: this.keyboard.modifiers(), pointerType: 'mouse',
    });
  }
}

export class Touchscreen {
  constructor(private readonly session: () => CDPSession, protected readonly keyboard: Keyboard, protected readonly hasTouch: () => boolean) {}

  async tap(x: number, y: number): Promise<void> {
    if (!this.hasTouch()) throw new Error('hasTouch must be enabled on the browser context before using the touchscreen.');
    const modifiers = this.keyboard.modifiers();
    await this.session().send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], modifiers });
    await this.session().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], modifiers });
  }
}
