/**
 * A simulator of EZTest's Windows agent (protocol ez-agent/1) for tests on
 * machines without Windows: an "Invoice" WinForms-like app with a menu bar,
 * labelled text boxes, a check box, a data grid, a tree and the common
 * "Save As" file dialog. It is a mock of the agent's API, not of UI Automation.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentElement, AgentWindow } from '../../../src/desktop/index.js';

interface El extends AgentElement {
  window: string;
}

export class WindowsAgentSim {
  private server?: Server;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  windows: AgentWindow[] = [];
  els: El[] = [];
  saved: string[] = [];
  token = 'sim-token';
  /** Rename the Save button (AutomationId stays) to exercise healing. */
  constructor(private readonly variant: 'standard' | 'renamed' = 'standard') {}

  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        const send = (status: number, o: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (req.headers['x-ez-agent-token'] !== this.token) return send(401, { ok: false, error: { code: 'unauthorized', message: 'missing or wrong X-EZ-Agent-Token' } });
        try {
          const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
          this.calls.push({ method, params });
          send(200, { ok: true, result: this.call(method, params ?? {}) });
        } catch (e) {
          send(200, { ok: false, error: { code: (e as { code?: string }).code ?? 'error', message: (e as Error).message } });
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()) ?? r());
  }

  private el(id: unknown): El {
    const e = this.els.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error(`element ${String(id)} is unknown`), { code: 'stale' });
    return e;
  }

  private add(window: string, e: Omit<El, 'window' | 'id'> & { id?: string }): El {
    const el: El = { id: e.id ?? `${window}.${this.els.length + 1}`, window, enabled: true, visible: true, framework: 'WinForm', ...e } as El;
    this.els.push(el);
    return el;
  }

  private openMain(): AgentWindow {
    const w: AgentWindow = { id: 'w1', title: 'Invoice - Untitled', pid: 4242, className: 'WindowsForms10.Window' };
    this.windows.push(w);
    const root = this.add('w1', { id: 'w1', controlType: 'Window', name: w.title, automationId: 'MainForm', rect: { x: 0, y: 0, width: 800, height: 600 } });
    const bar = this.add('w1', { parent: root.id, controlType: 'MenuBar', name: 'Application' });
    const file = this.add('w1', { id: 'm-file', parent: bar.id, controlType: 'MenuItem', name: 'File', expanded: false });
    this.add('w1', { id: 'm-saveas', parent: file.id, controlType: 'MenuItem', name: 'Save As...', visible: false });
    this.add('w1', { id: 'm-exit', parent: file.id, controlType: 'MenuItem', name: 'Exit', visible: false });
    this.add('w1', { parent: root.id, controlType: 'Text', name: 'Customer:', rect: { x: 10, y: 40, width: 80, height: 20 } });
    this.add('w1', { id: 'customer', parent: root.id, controlType: 'Edit', name: 'Customer:', labeledBy: 'Customer:', automationId: 'txtCustomer', value: '', rect: { x: 100, y: 40, width: 200, height: 20 } });
    this.add('w1', { parent: root.id, controlType: 'Text', name: 'Amount', rect: { x: 10, y: 70, width: 80, height: 20 } });
    this.add('w1', { id: 'amount', parent: root.id, controlType: 'Edit', automationId: 'txtAmount', value: '', rect: { x: 100, y: 70, width: 200, height: 20 } });
    this.add('w1', { id: 'urgent', parent: root.id, controlType: 'CheckBox', name: 'Urgent', automationId: 'chkUrgent', toggle: 'off', rect: { x: 100, y: 100, width: 80, height: 20 } });
    this.add('w1', { id: 'save', parent: root.id, controlType: 'Button', name: this.variant === 'renamed' ? 'Save invoice' : 'Save', automationId: 'btnSave', rect: { x: 100, y: 130, width: 80, height: 24 } });
    this.add('w1', { id: 'grid', parent: root.id, controlType: 'DataGrid', name: 'Lines', automationId: 'gridLines', rect: { x: 10, y: 170, width: 500, height: 200 } });
    const tree = this.add('w1', { id: 'tree', parent: root.id, controlType: 'Tree', name: 'Accounts', automationId: 'treeAccounts' });
    this.add('w1', { parent: tree.id, controlType: 'TreeItem', name: 'Customers', expanded: false });
    this.add('w1', { id: 'status', parent: root.id, controlType: 'StatusBar', name: 'Ready', automationId: 'statusBar' });
    return w;
  }

  private openSaveAs(): void {
    this.windows.push({ id: 'w2', title: 'Save As', pid: 4242, className: '#32770' });
    const root = this.add('w2', { id: 'w2', controlType: 'Window', name: 'Save As', framework: 'Win32' });
    this.add('w2', { parent: root.id, controlType: 'Text', name: 'File name:', framework: 'Win32' });
    this.add('w2', { id: 'fname', parent: root.id, controlType: 'ComboBox', name: 'File name:', automationId: '1148', value: '', framework: 'Win32' });
    this.add('w2', { id: 'dlgsave', parent: root.id, controlType: 'Button', name: 'Save', automationId: '1', framework: 'Win32' });
  }

  private closeWindow(id: string): void {
    this.windows = this.windows.filter((w) => w.id !== id);
    this.els = this.els.filter((e) => e.window !== id);
  }

  private status(text: string): void {
    this.el('status').name = text;
  }

  private grid: string[][] = [['Widget', '2', '9.50']];
  private gridCols = ['Item', 'Qty', 'Price'];
  treeExpanded: string[] = [];

  private call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'hello': return { agent: 'windows', protocol: 'ez-agent/1', version: 'sim', platform: 'simulated Windows' };
      case 'launch': {
        if (String(p.app) !== 'C:\\Apps\\Invoice.exe') throw Object.assign(new Error(`${String(p.app)} not found`), { code: 'not-found' });
        return { window: this.openMain() };
      }
      case 'windows': return { windows: this.windows };
      case 'activate': return {};
      case 'closeWindow': this.closeWindow(String(p.window)); return {};
      case 'elements': {
        const w = String(p.window);
        if (!this.windows.some((x) => x.id === w)) throw Object.assign(new Error(`window ${w} is gone`), { code: 'stale' });
        return { elements: this.els.filter((e) => e.window === w).map(({ window: _w, ...e }) => e) };
      }
      case 'invoke': {
        const e = this.el(p.id);
        if (e.id === 'save') this.status(`Saved invoice for ${this.el('customer').value || '?'}`);
        else if (e.id === 'm-file') this.call('expand', p);
        else if (e.id === 'm-saveas') {
          this.collapseMenu();
          this.openSaveAs();
        } else if (e.id === 'dlgsave') this.finishSave();
        else if (e.id === 'm-exit') this.closeWindow('w1');
        return {};
      }
      case 'expand': {
        const e = this.el(p.id);
        if (e.id !== 'm-file') throw Object.assign(new Error(`${e.controlType} cannot be expanded`), { code: 'not-supported' });
        e.expanded = true;
        for (const k of this.els.filter((x) => x.parent === 'm-file')) k.visible = true;
        return {};
      }
      case 'collapse': this.collapseMenu(); return {};
      case 'setValue': {
        const e = this.el(p.id);
        if (!['Edit', 'ComboBox'].includes(e.controlType)) throw Object.assign(new Error(`${e.controlType} has no value`), { code: 'not-supported' });
        e.value = String(p.value);
        return {};
      }
      case 'getValue': return { value: this.el(p.id).value ?? this.el(p.id).name ?? '' };
      case 'toggle': {
        const e = this.el(p.id);
        e.toggle = p.state ? (p.state as 'on') : e.toggle === 'on' ? 'off' : 'on';
        return {};
      }
      case 'keys': {
        const keys = p.keys as string[];
        if (keys.join('+') === 'ENTER' && p.id === 'fname') this.finishSave();
        if (keys.join('+') === 'CTRL+S') this.status('Saved (Ctrl+S)');
        return {};
      }
      case 'focus': case 'select': case 'typeText': case 'mouse': return {};
      case 'screenshot': return { png: TINY_PNG };
      case 'cell': {
        const row = Number(p.row);
        const col = typeof p.column === 'number' ? p.column - 1 : this.gridCols.findIndex((c) => c.toLowerCase() === String(p.column).toLowerCase());
        if (col < 0 || !this.grid[row - 1]) throw Object.assign(new Error(`no cell row ${row} column ${String(p.column)}`), { code: 'no-cell' });
        if (p.value !== undefined) this.grid[row - 1][col] = String(p.value);
        return { value: this.grid[row - 1][col] };
      }
      case 'treePath': {
        this.treeExpanded.push(`${String(p.op)}:${(p.path as string[]).join('>')}`);
        return {};
      }
      default: throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown-method' });
    }
  }

  private collapseMenu(): void {
    const f = this.els.find((x) => x.id === 'm-file');
    if (f) f.expanded = false;
    for (const k of this.els.filter((x) => x.parent === 'm-file')) k.visible = false;
  }

  private finishSave(): void {
    const name = this.el('fname').value ?? '';
    this.saved.push(name);
    this.closeWindow('w2');
    const main = this.windows.find((w) => w.id === 'w1');
    if (main) main.title = `Invoice - ${name.split('\\').pop()}`;
    this.status(`Saved to ${name}`);
  }
}

/** A 1x1 PNG. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
