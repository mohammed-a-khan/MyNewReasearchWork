/** Screen sources for the image/OCR rung. */
import { readFile } from 'node:fs/promises';
import type { AgentClient } from '../agent.js';
import { parseAgentKeys } from '../agent.js';
import type { ElectronSurface } from '../electron.js';
import { RfbClient } from './rfb.js';
import type { ScreenSource } from './surface.js';

/** The slice of a browser page the rung needs (the runner's page object satisfies it structurally). */
export interface BrowserPageLike {
  screenshot(o?: { type?: 'png' }): Promise<Buffer>;
  mouse: { click(x: number, y: number, o?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
}

/** A canvas-only web app in the journey's browser page. */
export function browserSource(page: () => BrowserPageLike): ScreenSource {
  return {
    name: 'browser page',
    capture: () => page().screenshot({ type: 'png' }),
    click: (x, y, o = {}) => page().mouse.click(x, y, { ...(o.button ? { button: o.button } : {}), ...(o.double ? { clickCount: 2 } : {}) }),
    type: (t) => page().keyboard.type(t),
    key: (k) => page().keyboard.press(k.split('+').map((p) => ({ ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', cmd: 'Meta', win: 'Meta', esc: 'Escape', return: 'Enter' } as Record<string, string>)[p.trim().toLowerCase()] ?? p.trim()).join('+')),
  };
}

/** A Citrix/VDI or remote desktop over VNC. */
export async function vncSource(name: string, o: { host: string; port?: number; password?: string; timeoutMs?: number }): Promise<ScreenSource> {
  const c = await RfbClient.connect(o);
  return {
    name: `${name} (VNC ${o.host}:${o.port ?? 5900})`,
    capture: () => c.capture(o.timeoutMs),
    click: async (x, y, opt) => c.click(x, y, opt),
    type: async (t) => c.type(t),
    key: async (k) => c.keys(k),
    close: async () => c.close(),
  };
}

/** The screen of a Windows/Java desktop agent (screen coordinates). */
export function agentSource(name: string, client: AgentClient): ScreenSource {
  return {
    name,
    capture: () => client.screenshot(),
    click: async (x, y, o = {}) => {
      await client.mouse({ x, y, ...(o.button ? { button: o.button } : {}), ...(o.double ? { double: true } : {}) });
    },
    type: async (t) => {
      await client.typeText(t);
    },
    key: async (k) => {
      const keys = parseAgentKeys(k);
      if (!keys) throw new Error(`"${k}" is not a key or key combination`);
      await client.keys(keys);
    },
  };
}

/** An Electron window (renderer coordinates). */
export function electronSource(s: ElectronSurface): ScreenSource {
  return {
    name: s.label,
    capture: () => s.page.screenshot(),
    click: async (x, y, o = {}) => {
      await s.page.mouse('mouseMoved', x, y);
      for (let n = 1; n <= (o.double ? 2 : 1); n++) {
        await s.page.mouse('mousePressed', x, y, { button: o.button ?? 'left', clickCount: n });
        await s.page.mouse('mouseReleased', x, y, { button: o.button ?? 'left', clickCount: n });
      }
    },
    type: (t) => s.page.insertText(t),
    key: (k) => s.pressKeys(k),
  };
}

/** A still screenshot (offline analysis and tests): clicks and keys are recorded, not sent anywhere. */
export function imageSource(path: string): ScreenSource & { actions: Array<{ type: string; x?: number; y?: number; text?: string }> } {
  const actions: Array<{ type: string; x?: number; y?: number; text?: string }> = [];
  return {
    name: path,
    actions,
    capture: () => readFile(path),
    click: async (x, y, o = {}) => {
      actions.push({ type: o.double ? 'dblclick' : o.button === 'right' ? 'rightclick' : 'click', x, y });
    },
    type: async (t) => {
      actions.push({ type: 'type', text: t });
    },
    key: async (k) => {
      actions.push({ type: 'key', text: k });
    },
  };
}
