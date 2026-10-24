/**
 * `ui`: browser actions and reads. Every call becomes a runner step, so it is
 * located strictly (a candidate must match exactly one element), fingerprinted,
 * healed only when its post-conditions hold, screenshotted per policy, checked
 * by lenses, captured in the time-travel trace, paused by the debugger and
 * recorded in the evidence vault, exactly like an `.ez` step.
 */
import type { Condition, ElementState } from '../core/index.js';
import type { DownloadRecord } from '../runner/ledger.js';
import { describe, literal, literalDeep, run, show, target, tempKey, type ActionOptions } from './internal.js';
import { currentHost } from './runtime.js';
import type { TargetInput } from './screen.js';
import { componentStepToText, widgetTarget, type ComponentWidget } from '../intent/rules-components.js';
import { parseIntent } from '../intent/parse.js';
import { toConditions, type Where } from '../runner/components/index.js';

export type { ActionOptions };

/** A downloaded file (kept as evidence; read it with `files.rows(download)`). */
export type Download = DownloadRecord;

/**
 * Arguments of a component step (see docs/components.md): `where` names a grid
 * row by its cell values, `value` is the value to write; the rest are the
 * operation's own arguments (column, dir, options, path, ...).
 */
export interface ComponentArgs {
  where?: Where;
  value?: string | number;
  [arg: string]: unknown;
}

export interface ReadOptions {
  timeoutMs?: number;
  intent?: string;
}

async function read<T>(step: Parameters<typeof run>[0], key: string, o: ReadOptions = {}): Promise<T> {
  const r = await run({ ...step, captureAs: key }, o);
  const v = r.captured?.[key];
  currentHost().deleteVar(key);
  return v as T;
}

export const ui = {
  /** Open a URL or a path relative to the base URL. */
  async open(url: string, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Open ${url}`, action: 'navigate', value: literal(url) }, o);
  },
  /** Reload the page. */
  async reload(o: ActionOptions = {}): Promise<void> {
    await run({ intent: 'Reload the page', action: 'navigate', args: { mode: 'reload' } }, o);
  },
  async back(o: ActionOptions = {}): Promise<void> {
    await run({ intent: 'Go back', action: 'navigate', args: { mode: 'back' } }, o);
  },
  async forward(o: ActionOptions = {}): Promise<void> {
    await run({ intent: 'Go forward', action: 'navigate', args: { mode: 'forward' } }, o);
  },
  /** Accept the next JavaScript dialog (alert/confirm), or answer the next prompt. */
  async acceptNextDialog(answer?: string): Promise<void> {
    await run(answer === undefined
      ? { intent: 'Accept the next dialog', action: 'dialog', args: { op: 'accept' } }
      : { intent: `Answer the next prompt with ${show(answer)}`, action: 'dialog', value: literal(answer), args: { op: 'answer', kind: 'prompt' } });
  },
  /** Dismiss the next JavaScript dialog. */
  async dismissNextDialog(): Promise<void> {
    await run({ intent: 'Dismiss the next dialog', action: 'dialog', args: { op: 'dismiss' } });
  },
  /** The message of the last dialog that appeared (undefined when none did). */
  async lastDialog(): Promise<string | undefined> {
    const key = tempKey('dialog');
    const r = await run({ intent: 'Read the last dialog message', action: 'query', args: { what: 'dialog' }, captureAs: key }, { optional: true });
    currentHost().deleteVar(key);
    return r.status === 'passed' ? (r.captured?.[key] as string | undefined) : undefined;
  },
  /** Sign the browser out: clear cookies, local and session storage (e.g. before signing in as someone else). */
  async clearSession(): Promise<void> {
    await run({ intent: 'Clear cookies', action: 'browser', args: { op: 'clearCookies' } });
    await run({ intent: 'Clear local storage', action: 'browser', args: { op: 'clearStorage', area: 'local' } }, { optional: true });
    await run({ intent: 'Clear session storage', action: 'browser', args: { op: 'clearStorage', area: 'session' } }, { optional: true });
  },
  async click(t: TargetInput, o: ActionOptions & { button?: 'left' | 'right' | 'middle'; newTab?: boolean } = {}): Promise<void> {
    await run({ intent: `Click ${describe(t)}`, action: 'click', target: target(t), args: { ...(o.button ? { button: o.button } : {}), ...(o.newTab ? { newPage: true } : {}) } }, o);
  },
  async dblclick(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Double-click ${describe(t)}`, action: 'dblclick', target: target(t) }, o);
  },
  async hover(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Hover over ${describe(t)}`, action: 'hover', target: target(t) }, o);
  },
  /** Replace the field's content with `value`. */
  async fill(t: TargetInput, value: string | number, o: ActionOptions = {}): Promise<void> {
    const v = String(value);
    await run({ intent: `Type ${show(v)} into ${describe(t)}`, action: 'fill', target: target(t), value: literal(v) }, o);
  },
  async clear(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Clear ${describe(t)}`, action: 'clear', target: target(t) }, o);
  },
  /** Choose an option (by value or label) in a select. */
  async select(t: TargetInput, option: string, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Select ${show(option)} from ${describe(t)}`, action: 'select', target: target(t), value: literal(option) }, o);
  },
  async check(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Check ${describe(t)}`, action: 'check', target: target(t) }, o);
  },
  async uncheck(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Uncheck ${describe(t)}`, action: 'uncheck', target: target(t) }, o);
  },
  /** Press a key (Enter, Tab, Control+A ...), on an element or the page. */
  async press(key: string, t?: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Press ${key}${t ? ` in ${describe(t)}` : ''}`, action: 'press', value: literal(key), ...(t ? { target: target(t) } : {}) }, o);
  },
  /** Drag an element onto another (HTML5 drag and drop for draggable elements, else a stepwise mouse drag). */
  async drag(from: TargetInput, to: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Drag ${describe(from)} to ${describe(to)}`, action: 'drag', target: target(from), to: target(to) }, o);
  },
  // ------------------------------------------------------------ tabs, windows and frames
  /**
   * Make another tab, window or popup the one the journey works on: `'new'` (the one that opened last and has
   * not been used yet; waited for), `'main'`, `'previous'`, a 1-based number, `{ title }` or `{ url }` (a part of it).
   */
  async switchToTab(which: 'new' | 'main' | 'previous' | number | { title: string } | { url: string }, o: ActionOptions = {}): Promise<void> {
    const args = typeof which === 'number' ? { by: 'index', value: String(which) }
      : typeof which === 'string' ? { by: which }
        : 'title' in which ? { by: 'title', value: literal(which.title) } : { by: 'url', value: literal(which.url) };
    const words = typeof which === 'number' ? `tab ${which}` : typeof which === 'string' ? `the ${which} tab` : 'title' in which ? `the tab titled ${show(which.title)}` : `the tab with URL ${show(which.url)}`;
    await run({ intent: `Switch to ${words}`, action: 'tab', args: { op: 'switch', ...args } }, o);
  },
  /** Close the current tab; the journey goes back to the tab it came from. */
  async closeTab(o: ActionOptions = {}): Promise<void> {
    await run({ intent: 'Close the tab', action: 'tab', args: { op: 'close' } }, o);
  },
  /**
   * Run `fn` inside a frame (outermost first for nested frames: `['outer', 'inner']`), found by name, id, title,
   * address or selector as in `.ez`; the journey is back in the page afterwards, also when `fn` throws.
   */
  async inFrame<T>(frames: string | string[], fn: () => Promise<T>): Promise<T> {
    const path = Array.isArray(frames) ? frames : [frames];
    await run({ intent: `Switch to frame ${path.map((f) => show(f)).join(' > ')}`, action: 'frame', args: { op: 'enter', path: path.map(literal) } });
    try {
      return await fn();
    } finally {
      for (let i = 0; i < path.length; i++) await run({ intent: 'Switch to the parent frame', action: 'frame', args: { op: 'parent' } });
    }
  },
  /**
   * Run one plain-English `.ez` step, exactly as it would run in an `.ez` file (`'Accept the next confirm dialog'`,
   * `'Scroll down until the "Item 50" text is visible'`). `${...}` in it is the journey's variables.
   */
  async perform(line: string, o: ActionOptions = {}): Promise<void> {
    const { id: _id, ...step } = parseIntent(line);
    await run(step, o);
  },
  /** Attach files (paths relative to the project) to a file input. */
  async upload(t: TargetInput, files: string | string[], o: ActionOptions = {}): Promise<void> {
    const list = Array.isArray(files) ? files : [files];
    await run({ intent: `Upload ${list.map((f) => show(f)).join(', ')} to ${describe(t)}`, action: 'upload', target: target(t), value: literal(list[0] ?? ''), args: { files: list.map(literal) } }, o);
  },
  /** Click an element that downloads a file; the file is kept as evidence. */
  async download(t: TargetInput, o: ActionOptions = {}): Promise<Download> {
    const key = tempKey('download');
    const r = await run({ intent: `Download ${describe(t)}`, action: 'download', target: target(t), captureAs: key }, o);
    currentHost().deleteVar(key);
    return r.captured?.[key] as Download;
  },
  async scrollIntoView(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Scroll to ${describe(t)}`, action: 'scroll', target: target(t), args: { op: 'intoView' } }, o);
  },
  async focus(t: TargetInput, o: ActionOptions = {}): Promise<void> {
    await run({ intent: `Focus ${describe(t)}`, action: 'focus', target: target(t), args: { op: 'focus' } }, o);
  },
  /** Wait until an element reaches a state (default visible). */
  async waitFor(t: TargetInput, state: ElementState = 'visible', o: ReadOptions = {}): Promise<void> {
    await run({ intent: `Wait for ${describe(t)} to be ${state}`, action: 'wait', target: target(t), args: { for: 'state', state, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) } }, { ...o, timeoutMs: undefined });
  },
  /** Wait until the URL matches (glob or /regex/). */
  async waitForUrl(pattern: string, o: ReadOptions = {}): Promise<void> {
    await run({ intent: `Wait for the URL to match ${show(pattern)}`, action: 'wait', args: { for: 'url', url: literal(pattern), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) } }, { ...o, timeoutMs: undefined });
  },
  /** Wait for the page to reach a load state (default "load"). */
  async waitForLoad(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', o: ReadOptions = {}): Promise<void> {
    await run({ intent: `Wait for the page to ${state === 'load' ? 'load' : `reach ${state}`}`, action: 'wait', args: { for: 'load', state, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) } }, { ...o, timeoutMs: undefined });
  },
  /** A fixed pause. Prefer post-conditions and waitFor: EZTest waits for elements automatically. */
  async wait(ms: number): Promise<void> {
    await run({ intent: `Wait ${ms} ms`, action: 'wait', value: String(Math.max(0, Math.round(ms))) });
  },
  /**
   * A component-library widget step, run like the `.ez` phrasing (strict widget
   * lookup, library detection, read-back verification, component healing and
   * evidence): `ui.component('grid', 'Orders', 'editCell', { where: { Id: 42 }, column: 'Amount', value: 150 })`.
   * Returns what the operation reads (`readCell`, `readAll`, `capture`), else undefined.
   * Dialogs take an optional title (undefined: the top dialog); toasts take no name (`{ text }` in args).
   */
  async component<T = unknown>(widget: ComponentWidget, name: string | undefined, op: string, args: ComponentArgs = {}, o: ActionOptions = {}): Promise<T | undefined> {
    const { where, value, ...rest } = args;
    const key = tempKey('component');
    const step = {
      action: 'component' as const,
      ...(name !== undefined && widget !== 'dialog' && widget !== 'toast' ? { target: literalDeep(widgetTarget(name, widget)) } : {}),
      ...(value !== undefined ? { value: literal(String(value)) } : {}),
      args: literalDeep({ widget, op, ...(name !== undefined && widget === 'dialog' ? { dialog: name } : {}), ...(where ? { where: toConditions(where) } : {}), ...rest }),
      captureAs: key,
    };
    let intent: string;
    try {
      intent = componentStepToText(step as never).replace(/^Capture (.*) as \S+$/, 'Read $1');
    } catch {
      intent = `${op} in the ${name ?? ''} ${widget}`.replace(/\s+/g, ' ');
    }
    const r = await run({ intent, ...step }, o);
    const v = r.captured?.[key];
    currentHost().deleteVar(key);
    return v as T | undefined;
  },
  // ------------------------------------------------------------ reads (located strictly, healable)
  /** Visible text of an element (whitespace collapsed). */
  async text(t: TargetInput, o: ReadOptions = {}): Promise<string> {
    return read<string>({ intent: o.intent ?? `Read the text of ${describe(t)}`, action: 'query', target: target(t), args: { what: 'text' } }, tempKey('text'), o).then((v) => String(v ?? '').replace(/\s+/g, ' ').trim());
  },
  /** Current value of an input, select or textarea. */
  async value(t: TargetInput, o: ReadOptions = {}): Promise<string> {
    return read<string>({ intent: o.intent ?? `Read the value of ${describe(t)}`, action: 'query', target: target(t), args: { what: 'value' } }, tempKey('value'), o).then((v) => String(v ?? ''));
  },
  async attribute(t: TargetInput, name: string, o: ReadOptions = {}): Promise<string | null> {
    return read<string | null>({ intent: o.intent ?? `Read the ${name} attribute of ${describe(t)}`, action: 'query', target: target(t), args: { what: 'attribute', name: literal(name) } }, tempKey('attr'), o);
  },
  /** Rows of an HTML table (header-mapped). */
  async table(t: TargetInput, o: ReadOptions = {}): Promise<Array<Record<string, string>>> {
    return read<Array<Record<string, string>>>({ intent: o.intent ?? `Read the rows of ${describe(t)}`, action: 'query', target: target(t), args: { what: 'table' } }, tempKey('table'), o);
  },
  /** How many elements match (0 is fine). */
  async count(t: TargetInput, o: ReadOptions = {}): Promise<number> {
    return read<number>({ intent: o.intent ?? `Count ${describe(t)}`, action: 'query', target: target(t), args: { what: 'count' } }, tempKey('count'), o).then(Number);
  },
  /** Texts of all matching elements. */
  async texts(t: TargetInput, o: ReadOptions = {}): Promise<string[]> {
    return read<string[]>({ intent: o.intent ?? `Read the texts of ${describe(t)}`, action: 'query', target: target(t), args: { what: 'texts' } }, tempKey('texts'), o);
  },
  async url(): Promise<string> {
    return read<string>({ intent: 'Read the URL', action: 'query', args: { what: 'url' } }, tempKey('url'));
  },
  async title(): Promise<string> {
    return read<string>({ intent: 'Read the page title', action: 'query', args: { what: 'title' } }, tempKey('title'));
  },
  // ------------------------------------------------------------ checks that never fail the journey
  /** True when the element is visible within `timeoutMs` (default 0: right now). */
  async isVisible(t: TargetInput, o: { timeoutMs?: number } = {}): Promise<boolean> {
    return probe({ type: 'visible', target: target(t) }, o.timeoutMs);
  },
  async isHidden(t: TargetInput, o: { timeoutMs?: number } = {}): Promise<boolean> {
    return probe({ type: 'hidden', target: target(t) }, o.timeoutMs);
  },
  async isEnabled(t: TargetInput, o: { timeoutMs?: number } = {}): Promise<boolean> {
    return probe({ type: 'state', target: target(t), state: 'enabled' }, o.timeoutMs);
  },
  async isChecked(t: TargetInput, o: { timeoutMs?: number } = {}): Promise<boolean> {
    return probe({ type: 'state', target: target(t), state: 'checked' }, o.timeoutMs);
  },
  /** Sign in as an Identity Vault role (default: the journey's role). */
  async login(role?: string, o: ActionOptions = {}): Promise<void> {
    await run({ intent: role ? `Log in as ${role}` : 'Log in', action: 'login', ...(role ? { value: literal(role) } : {}) }, o);
  },
  /** Screenshot of the page as evidence; returns the evidence id. */
  async screenshot(name = 'screenshot'): Promise<string | undefined> {
    return currentHost('ui.screenshot').screenshot(name, `screenshot "${name}" taken by code`);
  },
  /**
   * The live browser Page (eztest/browser), for what the SDK does not cover. Actions on it are
   * not located strictly, healed, verified or traced: prefer `ui.*`.
   */
  page<P = import('../browser/index.js').Page>(): P {
    return currentHost('ui.page').page() as P;
  },
};

export type Ui = typeof ui;

async function probe(c: Condition, timeoutMs = 0): Promise<boolean> {
  return currentHost('ui.is*').probe(c, timeoutMs);
}
