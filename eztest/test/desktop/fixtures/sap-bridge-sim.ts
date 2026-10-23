/**
 * A simulator of EZTest's SAP GUI bridge (agents/sap/ez-sap-bridge.ps1,
 * protocol ez-agent/1): SAP Easy Access, VA01 initial screen, the order
 * overview with an items table, and the status bar. Mock of the bridge API,
 * not of SAP GUI.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SapElement, SapScreen } from '../../../src/desktop/index.js';

type Screen = 'logon' | 'easy' | 'va01' | 'overview';

export class SapBridgeSim {
  private server?: Server;
  url = '';
  token = 'sap-token';
  screen: Screen = 'logon';
  values: Record<string, string> = {};
  status = { type: '', text: '' };
  items: Array<{ material: string; qty: string }> = [{ material: '', qty: '' }];
  orders: string[] = [];
  calls: string[] = [];
  user?: string;

  constructor(private readonly variant: 'standard' | 'relabelled' = 'standard') {}

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
          this.calls.push(method);
          send(200, { ok: true, result: this.call(method, params ?? {}) });
        } catch (e) {
          send(200, { ok: false, error: { code: 'error', message: (e as Error).message } });
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

  private elements(): SapElement[] {
    const tb: SapElement[] = [
      { id: 'wnd[0]/tbar[0]/okcd', type: 'GuiOkCodeField', name: 'okcd', changeable: true },
      { id: 'wnd[0]/tbar[0]/btn[11]', type: 'GuiButton', name: 'btn[11]', tooltip: 'Save   (Ctrl+S)', text: '' },
      { id: 'wnd[0]/tbar[0]/btn[3]', type: 'GuiButton', name: 'btn[3]', tooltip: 'Back   (F3)', text: '' },
    ];
    const f = (id: string, label: string, type = 'GuiCTextField'): SapElement => ({ id: `wnd[0]/usr/${id}`, type, name: id.replace(/^[a-z]+/, ''), leftLabel: label, text: this.values[`wnd[0]/usr/${id}`] ?? '', changeable: true });
    switch (this.screen) {
      case 'logon': return [...tb, f('txtRSYST-MANDT', 'Client', 'GuiTextField'), f('txtRSYST-BNAME', 'User', 'GuiTextField'), f('pwdRSYST-BCODE', 'Password', 'GuiPasswordField')];
      case 'easy': return [...tb, { id: 'wnd[0]/usr/lblWELCOME', type: 'GuiLabel', text: 'SAP Easy Access' }];
      case 'va01': return [...tb, f('ctxtVBAK-AUART', 'Order Type'), f('ctxtVBAK-VKORG', 'Sales Organization'), f('ctxtVBAK-VTWEG', 'Distribution Channel'), f('ctxtVBAK-SPART', 'Division')];
      case 'overview': return [
        ...tb,
        f('subSUBSCREEN_HEADER:SAPMV45A:4021/subPART-SUB:SAPMV45A:4701/ctxtKUAGV-KUNNR', this.variant === 'relabelled' ? 'Customer' : 'Sold-To Party'),
        f('subSUBSCREEN_HEADER:SAPMV45A:4021/txtVBKD-BSTKD', 'Cust. Reference', 'GuiTextField'),
        { id: 'wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01', type: 'GuiTab', name: 'T\\01', text: 'Sales' },
        { id: 'wnd[0]/usr/tabsTAXI_TABSTRIP_OVERVIEW/tabpT\\01/ssubSUBSCREEN_BODY:SAPMV45A:4400/subSUBSCREEN_TC:SAPMV45A:4900/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', type: 'GuiTableControl', name: 'SAPMV45ATCTRL_U_ERF_AUFTRAG', tooltip: 'All Items', columns: ['Item', 'Material', 'Order Quantity'] },
      ];
    }
  }

  private find(id: unknown): SapElement {
    const e = this.elements().find((x) => x.id === id);
    if (!e) throw new Error(`no SAP element ${String(id)} on this screen`);
    return e;
  }

  private title(): string {
    return { logon: 'SAP', easy: 'SAP Easy Access', va01: 'Create Sales Order: Initial Screen', overview: 'Create Standard Order: Overview' }[this.screen];
  }

  private call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'hello': return { agent: 'sap', protocol: 'ez-agent/1', version: 'sim', platform: 'simulated SAP GUI' };
      case 'open': {
        if (p.connection !== 'ERP Development') throw new Error(`SAP Logon has no connection "${String(p.connection)}"`);
        this.screen = 'logon';
        return { session: '/app/con[0]/ses[0]' };
      }
      case 'login': {
        if (p.user === 'TESTER' && p.password === 'S3cret!' && p.client === '100') {
          this.user = String(p.user);
          this.screen = 'easy';
          this.status = { type: '', text: '' };
        } else this.status = { type: 'E', text: 'Name or password is incorrect (repeat logon)' };
        return this.status;
      }
      case 'transaction': {
        if (this.screen === 'logon') throw new Error('not logged on');
        if (String(p.code).toUpperCase() === 'VA01') this.screen = 'va01';
        else this.status = { type: 'E', text: `Transaction ${String(p.code)} does not exist` };
        this.values = {};
        return {};
      }
      case 'dump': return { window: { id: 'wnd[0]', title: this.title(), transaction: this.screen === 'va01' || this.screen === 'overview' ? 'VA01' : this.screen === 'easy' ? 'SESSION_MANAGER' : 'S000' }, elements: this.elements() } satisfies SapScreen;
      case 'get': {
        const e = this.find(p.id);
        return { value: this.values[e.id] ?? e.text ?? '' };
      }
      case 'set': {
        const e = this.find(p.id);
        if (!e.changeable) throw new Error(`${e.id} is not changeable`);
        this.values[e.id] = String(p.value);
        return {};
      }
      case 'press': {
        const e = this.find(p.id);
        if (e.name === 'btn[11]') this.save();
        if (e.name === 'btn[3]') this.screen = this.screen === 'overview' ? 'va01' : 'easy';
        return {};
      }
      case 'select': this.find(p.id); return {};
      case 'vkey': {
        const k = Number(p.key);
        if (k === 0 && this.screen === 'va01') {
          if (this.values['wnd[0]/usr/ctxtVBAK-AUART'] !== 'OR') this.status = { type: 'E', text: 'Enter a valid sales document type' };
          else {
            this.screen = 'overview';
            this.status = { type: '', text: '' };
          }
        } else if (k === 11) this.save();
        else if (k === 3) this.screen = 'easy';
        return {};
      }
      case 'status': return this.status;
      case 'cell': {
        const row = Number(p.row);
        const col = String(p.column);
        while (this.items.length < row) this.items.push({ material: '', qty: '' });
        const item = this.items[row - 1];
        const key = col === 'Material' ? 'material' : col === 'Order Quantity' ? 'qty' : undefined;
        if (!key) throw new Error(`no column ${col}`);
        if (p.value !== undefined) item[key] = String(p.value);
        return { value: item[key] };
      }
      case 'screenshot': return { png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
      case 'close': return {};
      default: throw new Error(`unknown method ${method}`);
    }
  }

  private save(): void {
    if (this.screen !== 'overview') return;
    const soldTo = Object.entries(this.values).find(([k]) => k.endsWith('ctxtKUAGV-KUNNR'))?.[1];
    if (!soldTo) {
      this.status = { type: 'E', text: 'Enter a sold-to party' };
      return;
    }
    if (!this.items[0]?.material) {
      this.status = { type: 'E', text: 'Enter at least one item' };
      return;
    }
    const no = String(12345 + this.orders.length);
    this.orders.push(no);
    this.status = { type: 'S', text: `Standard Order ${no} has been saved.` };
  }
}
