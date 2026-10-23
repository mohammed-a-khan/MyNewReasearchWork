/**
 * Input forwarding from a live-view client to the page: CDP `Input.dispatch*`
 * in Chromium, the driver's mouse/keyboard elsewhere. Coordinates are CSS
 * pixels in the page viewport (map screencast frame pixels with the frame
 * metadata before sending).
 */
import type { CDPSession, Page } from '../../browser/index.js';
import { EzTestError } from '../../core/index.js';

export type InputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX?: number; deltaY?: number }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'text'; text: string };

const sessions = new WeakMap<Page, Promise<CDPSession | undefined>>();

/** A CDP session for Chromium pages (cached), undefined for other engines. */
export function cdpFor(page: Page): Promise<CDPSession | undefined> {
  let s = sessions.get(page);
  if (!s) {
    s = page.context().newCDPSession(page).catch(() => undefined);
    sessions.set(page, s);
  }
  return s;
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new EzTestError(`input ${name} must be a finite number`, 'BAD_INPUT');
  return v;
}

/** Validate an untrusted input event (e.g. from a JSON POST). */
export function parseInputEvent(raw: unknown): InputEvent {
  const e = (raw ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'mouse': {
      if (!['move', 'down', 'up', 'click'].includes(String(e.action))) throw new EzTestError('mouse action must be move, down, up or click', 'BAD_INPUT');
      const button = e.button === undefined ? undefined : String(e.button);
      if (button !== undefined && !['left', 'right', 'middle'].includes(button)) throw new EzTestError('mouse button must be left, right or middle', 'BAD_INPUT');
      return { type: 'mouse', action: e.action as 'move', x: num(e.x, 'x'), y: num(e.y, 'y'), button: button as 'left' | undefined, clickCount: e.clickCount === undefined ? undefined : num(e.clickCount, 'clickCount'), modifiers: e.modifiers === undefined ? undefined : num(e.modifiers, 'modifiers') };
    }
    case 'wheel':
      return { type: 'wheel', x: num(e.x, 'x'), y: num(e.y, 'y'), deltaX: e.deltaX === undefined ? 0 : num(e.deltaX, 'deltaX'), deltaY: e.deltaY === undefined ? 0 : num(e.deltaY, 'deltaY') };
    case 'key':
      if (!['down', 'up', 'press'].includes(String(e.action))) throw new EzTestError('key action must be down, up or press', 'BAD_INPUT');
      if (typeof e.key !== 'string' || !e.key || e.key.length > 32) throw new EzTestError('key must be a short string', 'BAD_INPUT');
      return { type: 'key', action: e.action as 'down', key: e.key, code: typeof e.code === 'string' ? e.code : undefined, text: typeof e.text === 'string' ? e.text : undefined, modifiers: e.modifiers === undefined ? undefined : num(e.modifiers, 'modifiers') };
    case 'text':
      if (typeof e.text !== 'string' || e.text.length > 10_000) throw new EzTestError('text must be a string (max 10000 chars)', 'BAD_INPUT');
      return { type: 'text', text: e.text };
    default:
      throw new EzTestError('input type must be mouse, wheel, key or text', 'BAD_INPUT');
  }
}

/** Dispatch one input event to the page. */
export async function dispatchInput(page: Page, e: InputEvent): Promise<void> {
  const cdp = await cdpFor(page);
  if (cdp) return dispatchCdp(cdp, e);
  switch (e.type) {
    case 'mouse':
      if (e.action === 'move') return page.mouse.move(e.x, e.y);
      if (e.action === 'click') return page.mouse.click(e.x, e.y, { button: e.button, clickCount: e.clickCount });
      await page.mouse.move(e.x, e.y);
      return e.action === 'down' ? page.mouse.down({ button: e.button }) : page.mouse.up({ button: e.button });
    case 'wheel':
      await page.mouse.move(e.x, e.y);
      return page.mouse.wheel(e.deltaX ?? 0, e.deltaY ?? 0);
    case 'key':
      if (e.action === 'press') return page.keyboard.press(e.key);
      return e.action === 'down' ? page.keyboard.down(e.key) : page.keyboard.up(e.key);
    case 'text':
      return page.keyboard.insertText(e.text);
  }
}

async function dispatchCdp(cdp: CDPSession, e: InputEvent): Promise<void> {
  switch (e.type) {
    case 'mouse': {
      const base = { x: e.x, y: e.y, button: e.button ?? 'left', modifiers: e.modifiers ?? 0 };
      if (e.action === 'move') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e.x, y: e.y, modifiers: e.modifiers ?? 0 });
        return;
      }
      const clickCount = e.clickCount ?? 1;
      if (e.action === 'down' || e.action === 'click') await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount });
      if (e.action === 'up' || e.action === 'click') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount });
      return;
    }
    case 'wheel':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX ?? 0, deltaY: e.deltaY ?? 0 });
      return;
    case 'key': {
      const printable = e.text ?? (e.key.length === 1 ? e.key : undefined);
      const base = { key: e.key, code: e.code, modifiers: e.modifiers ?? 0, windowsVirtualKeyCode: VK[e.key] };
      if (e.action === 'down' || e.action === 'press') await cdp.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: printable } : {}) });
      if (e.action === 'up' || e.action === 'press') await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return;
    }
    case 'text':
      await cdp.send('Input.insertText', { text: e.text });
      return;
  }
}

const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};
