/**
 * Electron apps: the most semantic rung of the ladder. EZTest launches the app
 * itself with `--remote-debugging-port=0`, reads the DevTools endpoint and
 * drives the renderer through a small seam (`CdpPageSeam`): evaluate a fixed
 * locator script, dispatch input, capture screenshots. The normal web
 * phrasings (Click, Type, Select, Check, Press, Expect ...) work in its windows.
 *
 * SEAM NOTE: `cdpSeam()` adapts the temporary CDP client in cdp.ts. When the
 * EZTest browser driver in src/browser/ lands (with its own Electron
 * launcher), adapt its page object to `CdpPageSeam` and drop cdp.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { Condition, ConditionResult, ElementFingerprint, LocatorCandidate, Step, Target } from '../core/index.js';
import { pickBest, scoreFingerprint } from '../heal/score.js';
import { describeTarget } from '../intent/target.js';
import type { ConditionEnv } from '../runner/conditions.js';
import type { InterceptorRuntime } from '../runner/surface.js';
import type { StepContext } from '../runner/types.js';
import { CdpConnection, CdpError, listTargets, type CdpTarget } from './cdp.js';
import { ezCall } from './electron-dom.js';
import { evaluateTextConditions, unsupported, type ActResult, type DesktopSurface, type SurfaceCapture } from './surface.js';

/** What the Electron surface needs from a page (any CDP driver can provide it). */
export interface CdpPageSeam {
  /** Evaluate an expression in the page and return its JSON value (rejects with the page's exception). */
  evaluate<T>(expression: string): Promise<T>;
  mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, o?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
  key(type: 'keyDown' | 'keyUp' | 'char', o: { key: string; code?: string; keyCode?: number; text?: string; modifiers?: number }): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

/** Adapt a raw CDP connection to the seam. */
export function cdpSeam(conn: CdpConnection): CdpPageSeam {
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const r = await conn.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new CdpError((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
      return r.result.value as T;
    },
    async mouse(type, x, y, o = {}) {
      await conn.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : (o.button ?? 'left'), clickCount: o.clickCount ?? 1 });
    },
    async insertText(text) {
      await conn.send('Input.insertText', { text });
    },
    async key(type, o) {
      await conn.send('Input.dispatchKeyEvent', { type, key: o.key, ...(o.code ? { code: o.code } : {}), ...(o.keyCode ? { windowsVirtualKeyCode: o.keyCode, nativeVirtualKeyCode: o.keyCode } : {}), ...(o.text ? { text: o.text } : {}), modifiers: o.modifiers ?? 0 });
    },
    async screenshot() {
      const r = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    },
    async close() {
      conn.close();
    },
  };
}

export interface ElectronLaunchOptions {
  /** Main script or app directory. */
  app: string;
  args?: string[];
  /** Electron binary; default: the `electron` package resolved from `baseDir`. */
  executable?: string;
  baseDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** The `electron` package's binary, resolved from the project. */
export function resolveElectron(baseDir: string): string {
  try {
    const req = createRequire(join(baseDir, 'package.json'));
    const p = req('electron') as unknown;
    if (typeof p === 'string') return p;
  } catch {
    /* fall through */
  }
  throw new CdpError('the electron package is not installed in this project (npm i -D electron) and desktop.electron.executablePath is not set');
}

/** A launched Electron app: its DevTools endpoint and window targets. */
export class ElectronApp {
  private constructor(
    readonly process: ChildProcess,
    readonly httpBase: string,
    private readonly output: () => string,
  ) {}

  static async launch(o: ElectronLaunchOptions): Promise<ElectronApp> {
    const base = o.baseDir ?? process.cwd();
    const exe = o.executable ?? resolveElectron(base);
    const app = isAbsolute(o.app) || /^[a-z][a-z0-9+.-]*:\/\//i.test(o.app) ? o.app : resolve(base, o.app);
    const sandbox = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
    const proc = spawn(exe, ['--remote-debugging-port=0', ...sandbox, app, ...(o.args ?? [])], { env: { ...process.env, ...(o.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timeoutMs = o.timeoutMs ?? 30_000;
    const endpoint = await new Promise<string>((resolveUrl, reject) => {
      const t = setTimeout(() => reject(new CdpError(`Electron did not open its DevTools endpoint within ${timeoutMs}ms: ${out.slice(-400)}`)), timeoutMs);
      const onData = (d: Buffer) => {
        out = (out + d.toString('utf8')).slice(-8000);
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(out);
        if (m) {
          clearTimeout(t);
          resolveUrl(m[1]);
        }
      };
      proc.stderr?.on('data', onData);
      proc.stdout?.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(t);
        reject(new CdpError(`Electron exited (code ${code}) before its DevTools endpoint opened: ${out.slice(-400)}`));
      });
      proc.once('error', (e) => {
        clearTimeout(t);
        reject(new CdpError(`cannot start Electron (${exe}): ${e.message}`));
      });
    });
    const u = new URL(endpoint);
    return new ElectronApp(proc, `http://${u.host}`, () => out);
  }

  /** Page targets (windows), waiting for the first one. */
  async windows(waitMs = 15_000): Promise<CdpTarget[]> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const pages = (await listTargets(this.httpBase).catch(() => [] as CdpTarget[])).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length || Date.now() >= deadline) return pages;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async connect(target: CdpTarget): Promise<CdpPageSeam> {
    const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
    await conn.send('Runtime.enable');
    await conn.send('Page.enable');
    return cdpSeam(conn);
  }

  get logs(): string {
    return this.output();
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill('SIGTERM');
    await new Promise((r) => {
      const t = setTimeout(() => {
        this.process.kill('SIGKILL');
        r(undefined);
      }, 3000);
      this.process.once('exit', () => {
        clearTimeout(t);
        r(undefined);
      });
    });
  }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  ENTER: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, TAB: { key: 'Tab', code: 'Tab', keyCode: 9 }, ESCAPE: { key: 'Escape', code: 'Escape', keyCode: 27 },
  BACKSPACE: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, DELETE: { key: 'Delete', code: 'Delete', keyCode: 46 }, SPACE: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ARROWUP: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ARROWDOWN: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, ARROWLEFT: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ARROWRIGHT: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, HOME: { key: 'Home', code: 'Home', keyCode: 36 }, END: { key: 'End', code: 'End', keyCode: 35 },
  PAGEUP: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, PAGEDOWN: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const ALIASES: Record<string, string> = { RETURN: 'ENTER', ESC: 'ESCAPE', UP: 'ARROWUP', DOWN: 'ARROWDOWN', LEFT: 'ARROWLEFT', RIGHT: 'ARROWRIGHT' };
const MODS: Record<string, number> = { ALT: 1, CTRL: 2, CONTROL: 2, META: 4, CMD: 4, SHIFT: 8 };

type Resolved = { i: number; box: { x: number; y: number; width: number; height: number }; fp: ElementFingerprint; cand: LocatorCandidate; notes: string[] };

export class ElectronSurface implements DesktopSurface {
  readonly kind = 'electron' as const;
  private title = '';

  constructor(
    readonly name: string,
    readonly app: ElectronApp,
    public page: CdpPageSeam,
    private target: CdpTarget,
  ) {
    this.title = target.title;
  }

  get label(): string {
    return `Electron app "${this.name}"${this.title ? ` (window "${this.title}")` : ''}`;
  }

  static async launch(name: string, o: ElectronLaunchOptions): Promise<ElectronSurface> {
    const app = await ElectronApp.launch(o);
    try {
      const [first] = await app.windows(o.timeoutMs ?? 15_000);
      if (!first) throw new CdpError(`Electron app "${name}" opened no window: ${app.logs.slice(-300)}`);
      const page = await app.connect(first);
      const s = new ElectronSurface(name, app, page, first);
      await s.waitReady();
      return s;
    } catch (e) {
      await app.close();
      throw e;
    }
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const st = await this.page.evaluate<string>('document.readyState').catch(() => 'loading');
      if (st === 'complete' || st === 'interactive') return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  accepts(step: Step): boolean {
    return !['api', 'db', 'set', 'wait', 'useData', 'compareDocument', 'email', 'sms', 'ws', 'compareData', 'login', 'runJourney'].includes(step.action);
  }

  private async resolve(target: Target, ctx: StepContext, rt: InterceptorRuntime, step: Step, timeoutMs: number): Promise<{ r: Resolved; heal?: ActResult['heal'] }> {
    const cands = target.locators.length ? target.locators.map((c) => ({ ...c, value: ctx.interpolate(c.value), ...(c.name ? { name: ctx.interpolate(c.name) } : {}) })) : describeTarget(target.description).locators;
    const deadline = Date.now() + timeoutMs;
    let notes: string[] = [];
    for (;;) {
      const r = await this.page.evaluate<Partial<Resolved>>(ezCall('resolve', cands));
      if (r.i !== undefined) return { r: r as Resolved };
      notes = r.notes ?? [];
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const why = `no locator candidate matched exactly one element for ${target.description} (${notes.join('; ')})`;
    const mem = rt.store.get(ctx.journey.id, step.id);
    if (mem?.fingerprint) {
      const scan = await this.page.evaluate<Array<{ i: number; fp: ElementFingerprint }>>(ezCall('scan'));
      const pick = pickBest(scan.map((s) => ({ item: s, score: scoreFingerprint(mem.fingerprint!, s.fp).score })), 0.7, 0.1);
      if (pick.ok) {
        const best = pick.best.item;
        const healed: LocatorCandidate = best.fp.testId ? { strategy: 'testId', value: best.fp.testId } : best.fp.role && best.fp.name ? { strategy: 'role', value: best.fp.role, name: best.fp.name, exact: true } : { strategy: 'css', value: best.fp.path ?? best.fp.tag ?? '*' };
        const again = await this.page.evaluate<Partial<Resolved>>(ezCall('resolve', [healed]));
        if (again.i !== undefined) {
          return { r: again as Resolved, heal: { tier: 'T1-fingerprint', confidence: Math.round(pick.best.score * 100) / 100, reason: `${why}; ${best.fp.tag} "${best.fp.name ?? ''}" matches the recorded fingerprint`, original: target.locators, healed } };
        }
      }
    }
    throw new CdpError(why);
  }

  private result(r: Resolved, extra: Partial<ActResult> = {}): ActResult {
    return {
      surface: { driver: 'electron', rung: 'object', via: `${r.cand.strategy}${r.cand.name ? ` ${r.cand.value} "${r.cand.name}"` : ` "${r.cand.value}"`} in window "${this.title}"`, box: r.box },
      usedLocator: r.cand,
      fingerprint: r.fp,
      ...extra,
    };
  }

  private async click(r: Resolved, button: 'left' | 'right' | 'middle', count: number): Promise<void> {
    const x = r.box.x + r.box.width / 2;
    const y = r.box.y + r.box.height / 2;
    await this.page.mouse('mouseMoved', x, y);
    for (let n = 1; n <= count; n++) {
      await this.page.mouse('mousePressed', x, y, { button, clickCount: n });
      await this.page.mouse('mouseReleased', x, y, { button, clickCount: n });
    }
  }

  async pressKeys(combo: string): Promise<void> {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    let modifiers = 0;
    const main = parts.pop() ?? '';
    for (const m of parts) {
      const bit = MODS[m.toUpperCase()];
      if (bit === undefined) throw new CdpError(`unknown modifier "${m}" in "${combo}"`);
      modifiers |= bit;
    }
    const u = main.toUpperCase();
    const k = KEYS[ALIASES[u] ?? u] ?? (main.length === 1 ? { key: main, code: `Key${main.toUpperCase()}`, keyCode: main.toUpperCase().charCodeAt(0), text: modifiers & 3 ? undefined : main } : undefined);
    if (!k) throw new CdpError(`unknown key "${main}"`);
    await this.page.key('keyDown', { ...k, modifiers, ...(k.text && !(modifiers & 3) ? { text: k.text } : {}) });
    await this.page.key('keyUp', { key: k.key, code: k.code, keyCode: k.keyCode, modifiers });
  }

  async act(step: Step, ctx: StepContext, rt: InterceptorRuntime): Promise<ActResult | undefined> {
    const v = (s: string | undefined) => ctx.interpolate(s ?? '');
    const timeout = Math.min(step.timeoutMs ?? rt.stepTimeoutMs, 5000);
    const args = step.args ?? {};
    switch (step.action) {
      case 'click':
      case 'dblclick': {
        const { r, heal } = await this.resolve(step.target!, ctx, rt, step, timeout);
        await this.click(r, (args.button as 'right') ?? 'left', step.action === 'dblclick' ? 2 : 1);
        return this.result(r, heal ? { heal } : {});
      }
      case 'hover': {
        const { r, heal } = await this.resolve(step.target!, ctx, rt, step, timeout);
        await this.page.mouse('mouseMoved', r.box.x + r.box.width / 2, r.box.y + r.box.height / 2);
        return this.result(r, heal ? { heal } : {});
      }
      case 'fill':
      case 'clear': {
        const { r, heal } = await this.resolve(step.target!, ctx, rt, step, timeout);
        const text = step.action === 'clear' ? '' : v(step.value);
        if (text) {
          await this.page.evaluate(`window.__ez.focusSelect(${r.i})`);
          await this.page.insertText(text);
        } else await this.page.evaluate(`window.__ez.clear(${r.i})`);
        const now = await this.page.evaluate<string>(`window.__ez.value(${r.i})`);
        return this.result(r, { implied: { ok: now === text, message: now === text ? 'the field holds the typed value' : `the field holds "${now}"` }, ...(heal ? { heal } : {}) });
      }
      case 'select': {
        const { r, heal } = await this.resolve(step.target!, ctx, rt, step, timeout);
        const got = await this.page.evaluate<string>(`window.__ez.selectOption(${r.i}, ${JSON.stringify(v(step.value))})`);
        return this.result(r, { implied: { ok: got.length > 0, message: `selected "${got}"` }, ...(heal ? { heal } : {}) });
      }
      case 'check':
      case 'uncheck': {
        const { r, heal } = await this.resolve(step.target!, ctx, rt, step, timeout);
        const st = await this.page.evaluate<{ checked: boolean }>(`window.__ez.state(${r.i})`);
        if (st.checked !== (step.action === 'check')) await this.click(r, 'left', 1);
        const now = await this.page.evaluate<{ checked: boolean }>(`window.__ez.state(${r.i})`);
        return this.result(r, { implied: { ok: now.checked === (step.action === 'check'), message: `the box is ${now.checked ? 'checked' : 'unchecked'}` }, ...(heal ? { heal } : {}) });
      }
      case 'press': {
        if (step.target) {
          const { r, heal } = await this.resolve(step.target, ctx, rt, step, timeout);
          await this.page.evaluate(`window.__ez.els[${r.i}].focus()`);
          await this.pressKeys(v(step.value));
          return this.result(r, heal ? { heal } : {});
        }
        await this.pressKeys(v(step.value));
        return { surface: { driver: 'electron', rung: 'object', via: `key ${v(step.value)}` } };
      }
      case 'capture': {
        if (!step.target || !step.captureAs) return unsupported(this, step);
        const { r, heal } = await this.resolve(step.target, ctx, rt, step, timeout);
        const value = await this.page.evaluate<string>(args.mode === 'value' ? `window.__ez.value(${r.i})` : `window.__ez.text(${r.i})`);
        return this.result(r, { captured: { [step.captureAs]: value }, ...(heal ? { heal } : {}) });
      }
      case 'tab': {
        if (args.op === 'switch' && typeof args.value === 'string') {
          await this.switchWindow(v(args.value));
          return { surface: { driver: 'electron', rung: 'object', via: `window "${this.title}"` }, newScreen: true };
        }
        if (args.op === 'switch' && args.by === 'new') {
          await this.switchWindow(undefined);
          return { surface: { driver: 'electron', rung: 'object', via: `window "${this.title}"` }, newScreen: true };
        }
        return unsupported(this, step);
      }
      case 'assert':
        return { surface: { driver: 'electron', rung: 'object', via: `window "${this.title}"` } };
      default:
        return unsupported(this, step);
    }
  }

  /** Switch to the window titled `title` (or, when undefined, the newest other window). */
  async switchWindow(title: string | undefined): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const wins = await this.app.windows(0);
      const pick = title === undefined ? wins.filter((w) => w.id !== this.target.id).at(-1) : (wins.find((w) => w.title === title) ?? wins.find((w) => w.title.includes(title)));
      if (pick) {
        await this.page.close();
        this.page = await this.app.connect(pick);
        this.target = pick;
        this.title = pick.title;
        await this.waitReady();
        return;
      }
      if (Date.now() >= deadline) throw new CdpError(`no Electron window ${title === undefined ? 'other than the current one' : `titled "${title}"`} (open: ${wins.map((w) => `"${w.title}"`).join(', ')})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async evaluate(c: Condition, env: ConditionEnv): Promise<ConditionResult | undefined> {
    if (c.type === 'urlContains' || c.type === 'titleContains') {
      const w = await this.page.evaluate<{ url: string; title: string }>(ezCall('where'));
      const got = c.type === 'urlContains' ? w.url : w.title;
      const want = env.interpolate(c.value);
      return got.includes(want) ? { condition: c, passed: true, actual: got } : { condition: c, passed: false, message: `${c.type === 'urlContains' ? 'URL' : 'title'} "${got}" does not contain "${want}"`, actual: got };
    }
    if (c.type === 'state') {
      const r = await this.page.evaluate<Partial<Resolved>>(ezCall('resolve', c.target.locators));
      if (r.i === undefined) return { condition: c, passed: false, message: `${c.target.description}: not found exactly once` };
      const st = await this.page.evaluate<{ checked: boolean; disabled: boolean; visible: boolean; focused: boolean; editable: boolean }>(`window.__ez.state(${r.i})`);
      const map: Record<string, boolean> = { checked: st.checked, unchecked: !st.checked, enabled: !st.disabled, disabled: st.disabled, visible: st.visible, hidden: !st.visible, focused: st.focused, editable: st.editable, readonly: !st.editable };
      if (!(c.state in map)) return undefined;
      return map[c.state] ? { condition: c, passed: true, actual: c.state } : { condition: c, passed: false, message: `${c.target.description} is not ${c.state}` };
    }
    return evaluateTextConditions(c, env, {
      label: this.label,
      screenText: () => this.page.evaluate<string>(ezCall('body')),
      elementText: async (t, field) => {
        const r = await this.page.evaluate<Partial<Resolved>>(ezCall('resolve', t.locators.length ? t.locators : describeTarget(t.description).locators));
        if (r.i === undefined) return undefined;
        return this.page.evaluate<string>(field === 'value' || r.fp?.role === 'textbox' || r.fp?.role === 'combobox' ? `window.__ez.value(${r.i})` : `window.__ez.text(${r.i})`);
      },
    });
  }

  async capture(): Promise<SurfaceCapture> {
    const png = await this.page.screenshot().catch(() => undefined);
    const html = await this.page.evaluate<string>('document.documentElement.outerHTML').catch(() => undefined);
    return { ...(png ? { image: { data: png, ext: 'png' as const } } : {}), ...(html ? { snapshot: { data: html, ext: 'html' as const, description: 'dom' } } : {}) };
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
    await this.app.close();
  }
}
