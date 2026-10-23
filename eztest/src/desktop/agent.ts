/**
 * Client for EZTest's own desktop agents (protocol "ez-agent/1"):
 *
 * - agents/windows: a .NET 8 program using Microsoft UI Automation (part of
 *   Windows) for WinForms / WPF / Win32 / UWP apps;
 * - agents/java: a `-javaagent` jar that walks the Swing/AWT component tree
 *   inside the application's JVM.
 *
 * Both serve the same JSON-over-HTTP API: `POST /v1/rpc` with
 * `{ "method": "...", "params": {...} }` and the header `X-EZ-Agent-Token`,
 * answering `{ "ok": true, "result": ... }` or
 * `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
 * Agents report elements with UI Automation control type names (Button,
 * Edit, CheckBox, ComboBox, MenuItem, ...) so locating, healing and evidence
 * are one implementation in TypeScript (agent-surface.ts). No third-party
 * automation tool is involved on either side.
 */

export const AGENT_PROTOCOL = 'ez-agent/1';

export interface AgentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentWindow {
  id: string;
  title: string;
  pid?: number;
  className?: string;
}

/** One element of a window's UI tree (flat list; `parent` links the tree). */
export interface AgentElement {
  id: string;
  parent?: string;
  /** UI Automation control type name: Window, Button, Edit, Text, CheckBox, RadioButton, ComboBox, List, ListItem, Menu, MenuBar, MenuItem, Tab, TabItem, Tree, TreeItem, DataGrid, DataItem, Table, Header, HeaderItem, Pane, Group, Document, Hyperlink, Image, ToolBar, StatusBar, Custom ... */
  controlType: string;
  name?: string;
  automationId?: string;
  className?: string;
  /** Win32, WinForm, WPF, XAML, DirectUI, Swing, AWT ... */
  framework?: string;
  /** Name of the label element that labels this one (UIA LabeledBy / Swing JLabel.labelFor). */
  labeledBy?: string;
  /** Value (ValuePattern / text components) and toggle/expand/selection state. */
  value?: string;
  toggle?: 'on' | 'off' | 'indeterminate';
  expanded?: boolean;
  selected?: boolean;
  enabled?: boolean;
  visible?: boolean;
  rect?: AgentRect;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentClientOptions {
  /** Agent URL, e.g. http://127.0.0.1:47123 (or a Windows test machine). */
  url: string;
  /** Shared token (the agent refuses requests without it). */
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface AgentHello {
  agent: 'windows' | 'java' | string;
  protocol: string;
  version: string;
  platform?: string;
}

export class AgentClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly options: AgentClientOptions) {
    let u: URL;
    try {
      u = new URL(options.url);
    } catch {
      throw new AgentError(`"${options.url}" is not an agent URL`, 'invalid-argument');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AgentError(`agent URL "${options.url}" must be http(s)`, 'invalid-argument');
    this.base = options.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const ctl = new AbortController();
    const limit = timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const t = setTimeout(() => ctl.abort(), limit);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...(this.options.token ? { 'x-ez-agent-token': this.options.token } : {}) },
        body: JSON.stringify({ method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      const m = (e as Error).name === 'AbortError' ? `timed out after ${limit}ms` : (e as Error).message;
      throw new AgentError(`desktop agent ${this.base}: ${method} failed: ${m}`, 'unreachable');
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let body: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new AgentError(`desktop agent ${this.base}: ${method}: HTTP ${res.status} ${text.slice(0, 200)}`, 'protocol');
    }
    if (res.status === 401 || res.status === 403) throw new AgentError(`desktop agent refused the token (${body.error?.message ?? res.status})`, 'unauthorized');
    if (!body.ok) throw new AgentError(`${method}: ${body.error?.message ?? `HTTP ${res.status}`}`, body.error?.code ?? 'error');
    return body.result as T;
  }

  async hello(): Promise<AgentHello> {
    const h = await this.call<AgentHello>('hello');
    if (h.protocol !== AGENT_PROTOCOL) throw new AgentError(`desktop agent speaks ${h.protocol}, EZTest needs ${AGENT_PROTOCOL}`, 'protocol');
    return h;
  }

  launch(p: { app: string; args?: string; workingDir?: string; timeoutMs?: number }): Promise<{ window: AgentWindow }> {
    return this.call('launch', p, (p.timeoutMs ?? 30_000) + 5000);
  }

  async windows(): Promise<AgentWindow[]> {
    return (await this.call<{ windows: AgentWindow[] }>('windows')).windows;
  }

  activate(window: string): Promise<unknown> {
    return this.call('activate', { window });
  }

  closeWindow(window: string): Promise<unknown> {
    return this.call('closeWindow', { window });
  }

  /** All elements of a window (depth first). */
  async elements(window: string, o: { maxDepth?: number; max?: number } = {}): Promise<{ elements: AgentElement[]; truncated?: boolean }> {
    return this.call('elements', { window, ...o });
  }

  invoke(id: string): Promise<unknown> {
    return this.call('invoke', { id });
  }
  setValue(id: string, value: string): Promise<unknown> {
    return this.call('setValue', { id, value });
  }
  async getValue(id: string): Promise<string> {
    return String((await this.call<{ value?: string }>('getValue', { id })).value ?? '');
  }
  toggle(id: string, state?: 'on' | 'off'): Promise<unknown> {
    return this.call('toggle', { id, ...(state ? { state } : {}) });
  }
  expand(id: string): Promise<unknown> {
    return this.call('expand', { id });
  }
  collapse(id: string): Promise<unknown> {
    return this.call('collapse', { id });
  }
  select(id: string): Promise<unknown> {
    return this.call('select', { id });
  }
  focus(id: string): Promise<unknown> {
    return this.call('focus', { id });
  }
  /** A key chord, e.g. ["CTRL", "S"] or ["ENTER"]; sent to the element (focused first) or the active window. */
  keys(keys: string[], id?: string): Promise<unknown> {
    return this.call('keys', { keys, ...(id ? { id } : {}) });
  }
  typeText(text: string, id?: string): Promise<unknown> {
    return this.call('typeText', { text, ...(id ? { id } : {}) });
  }
  /** Click at screen coordinates. */
  mouse(p: { x: number; y: number; button?: 'left' | 'right' | 'middle'; double?: boolean }): Promise<unknown> {
    return this.call('mouse', p);
  }
  /** PNG of a window (or the whole screen when `window` is omitted). */
  async screenshot(window?: string): Promise<Buffer> {
    const r = await this.call<{ png: string }>('screenshot', window ? { window } : {});
    return Buffer.from(r.png, 'base64');
  }
  /** Read (or with `value`, write) a grid/table cell. `column` is a header name or a 0-based index. */
  async cell(id: string, row: number, column: string | number, value?: string): Promise<string> {
    return String((await this.call<{ value?: string }>('cell', { id, row, column, ...(value !== undefined ? { value } : {}) })).value ?? '');
  }
}

/** Key names the agents understand (combos are chords: ["CTRL", "S"]). */
export const AGENT_KEYS = new Set([
  'ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'INSERT',
  'CTRL', 'ALT', 'SHIFT', 'WIN', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

const KEY_ALIASES: Record<string, string> = { RETURN: 'ENTER', ESC: 'ESCAPE', CONTROL: 'CTRL', OPTION: 'ALT', META: 'WIN', CMD: 'WIN', ARROWUP: 'UP', ARROWDOWN: 'DOWN', ARROWLEFT: 'LEFT', ARROWRIGHT: 'RIGHT', DEL: 'DELETE', PGUP: 'PAGEUP', PGDN: 'PAGEDOWN' };

/** "Ctrl+S" / "Alt+F4" / "Enter" -> agent key chord, or undefined when a part is unknown. */
export function parseAgentKeys(combo: string): string[] | undefined {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    const u = p.toUpperCase().replace(/\s+/g, '');
    const k = KEY_ALIASES[u] ?? u;
    if (AGENT_KEYS.has(k)) out.push(k);
    else if (p.length === 1) out.push(p.toUpperCase());
    else return undefined;
  }
  return out;
}
