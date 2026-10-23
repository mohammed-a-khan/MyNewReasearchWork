/**
 * A small TN3270 host simulator: a telnet server that negotiates TN3270,
 * sends 3270 screens built from field definitions and decodes the operator's
 * Read Modified input. Use it to develop and test mainframe journeys without a
 * host, and as the fixture for EZTest's own TN3270 client tests.
 *
 * Screens are plain data (rows/columns/text/input fields); application logic
 * is a function from (screen, AID key, inputs) to the next screen.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { CODE_TABLE, decodeAddress, decodeEbcdic, encodeAddress, encodeEbcdic } from './ebcdic.js';
import { AID, MODELS, ORDER } from './screen.js';
import { DO, EOR, IAC, OPT, SB, SE, WILL } from '../telnet.js';

export interface SimField {
  row: number;
  col: number;
  /** Protected text (a label or output). */
  text?: string;
  /** An input field (unprotected) of `length` positions, reported back under `name`. */
  name?: string;
  length?: number;
  /** Initial content of an input field. */
  value?: string;
  hidden?: boolean;
  numeric?: boolean;
  intensified?: boolean;
}

export interface SimScreen {
  fields: SimField[];
  /** Cursor position: an input field name or a row/col. Default: the first input field. */
  cursor?: string | { row: number; col: number };
}

export interface SimSession {
  terminalType?: string;
  /** Raw Query Reply received (when the terminal advertised -E). */
  queryReply?: Buffer;
  /** Name of the current screen. */
  screen: string;
  /** Last values of input fields by name (as typed by the operator). */
  inputs: Record<string, string>;
  /** Free-form application state. */
  state: Record<string, unknown>;
  /** Every AID received, with the inputs that came with it. */
  history: Array<{ screen: string; aid: string; inputs: Record<string, string>; cursor: { row: number; col: number } }>;
}

export interface SimApp {
  start: string;
  screens: Record<string, (s: SimSession) => SimScreen>;
  /** Next screen for an AID key ("ENTER", "PF3", "CLEAR", ...); return undefined to stay. */
  onAid(s: SimSession, aid: string, changed: Record<string, string>): string | undefined;
}

export interface SimulatorOptions {
  port?: number;
  host?: string;
  /** Screen model the simulator formats for (default 2: 24x80). */
  model?: 2 | 3 | 4 | 5;
  /** Delay before each screen is sent (simulates host latency). */
  delayMs?: number;
}

const AID_NAMES = new Map(Object.entries(AID).map(([k, v]) => [v, k]));

function attrByte(f: SimField, input: boolean): number {
  let a = 0;
  if (!input) a |= 0x20;
  if (f.numeric) a |= 0x10;
  if (f.hidden) a |= 0x0c;
  else if (f.intensified) a |= 0x08;
  return CODE_TABLE[a & 0x3f];
}

/** Build an Erase/Write record for a screen. Also returns where each input field's data starts. */
export function buildScreen(screen: SimScreen, rows = 24, cols = 80): { record: Buffer; inputs: Map<number, SimField> } {
  const size = rows * cols;
  const wrap = (a: number) => ((a % size) + size) % size;
  const at = (r: number, c: number) => {
    if (r < 1 || c < 1 || r > rows || c > cols) throw new Error(`field at row ${r} column ${c} is outside ${rows}x${cols}`);
    return (r - 1) * cols + (c - 1);
  };
  const attrs = new Map<number, { attr: number; data: string }>();
  const inputs = new Map<number, SimField>();
  for (const f of screen.fields) {
    const start = at(f.row, f.col);
    const isInput = !!f.name;
    const content = isInput ? (f.value ?? '').slice(0, f.length ?? 0) : (f.text ?? '');
    attrs.set(wrap(start - 1), { attr: attrByte(f, isInput), data: content });
    if (isInput) {
      inputs.set(start, f);
      const end = wrap(start + (f.length ?? 1));
      if (!attrs.has(end)) attrs.set(end, { attr: CODE_TABLE[0x20], data: '' });
    } else {
      const end = wrap(start + content.length);
      if (!attrs.has(end)) attrs.set(end, { attr: CODE_TABLE[0x20], data: '' });
    }
  }
  const out: number[] = [0xf5, 0xc3]; // Erase/Write; WCC: reset, keyboard restore, reset MDT
  for (const [addr, { attr, data }] of [...attrs.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(ORDER.SBA, ...encodeAddress(addr), ORDER.SF, attr, ...encodeEbcdic(data));
  }
  let cursor: number | undefined;
  if (typeof screen.cursor === 'object') cursor = at(screen.cursor.row, screen.cursor.col);
  else {
    const name = screen.cursor;
    const f = screen.fields.find((x) => x.name && (name === undefined || x.name === name));
    if (f) cursor = at(f.row, f.col);
  }
  if (cursor !== undefined) out.push(ORDER.SBA, ...encodeAddress(cursor), ORDER.IC);
  return { record: Buffer.from(out), inputs };
}

function frame(data: Uint8Array): Buffer {
  const out: number[] = [];
  for (const b of data) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  out.push(IAC, EOR);
  return Buffer.from(out);
}

/** A TN3270 host that serves a SimApp to every connection. */
export class MainframeSimulator {
  private server?: Server;
  readonly sessions: SimSession[] = [];
  private readonly sockets = new Set<Socket>();

  constructor(readonly app: SimApp, readonly options: SimulatorOptions = {}) {}

  async start(): Promise<{ host: string; port: number }> {
    this.server = createServer((sock) => this.serve(sock));
    const host = this.options.host ?? '127.0.0.1';
    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, host, resolve));
    return { host, port: (this.server.address() as AddressInfo).port };
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private serve(sock: Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => undefined);
    const { rows, cols } = MODELS[this.options.model ?? 2];
    const session: SimSession = { screen: this.app.start, inputs: {}, state: {}, history: [] };
    this.sessions.push(session);
    let inputs = new Map<number, SimField>();
    let negotiated = false;
    let awaitingQuery = false;
    const agreed = new Set<string>();
    const send = (b: number[]) => sock.write(Buffer.from(b));
    const show = () => {
      const scr = this.app.screens[session.screen];
      if (!scr) throw new Error(`simulator has no screen "${session.screen}"`);
      const built = buildScreen(scr(session), rows, cols);
      inputs = built.inputs;
      const write = () => sock.writable && sock.write(frame(built.record));
      if (this.options.delayMs) setTimeout(write, this.options.delayMs);
      else write();
    };
    const begin = () => {
      if (negotiated) return;
      negotiated = true;
      if (session.terminalType?.endsWith('-E')) {
        awaitingQuery = true;
        sock.write(frame(Buffer.from([0xf3, 0x00, 0x05, 0x01, 0xff, 0x02]))); // WSF Read Partition Query
      } else show();
    };
    const onRecord = (rec: Buffer) => {
      if (awaitingQuery && rec[0] === AID.SF) {
        awaitingQuery = false;
        session.queryReply = rec;
        show();
        return;
      }
      const aid = AID_NAMES.get(rec[0]) ?? `0x${rec[0].toString(16)}`;
      const changed: Record<string, string> = {};
      let cursor = { row: 1, col: 1 };
      if (rec.length >= 3) {
        const c = decodeAddress(rec[1], rec[2]);
        cursor = { row: Math.floor(c / cols) + 1, col: (c % cols) + 1 };
        let i = 3;
        while (i < rec.length) {
          if (rec[i] !== ORDER.SBA) break;
          const addr = decodeAddress(rec[i + 1], rec[i + 2]);
          i += 3;
          const start = i;
          while (i < rec.length && rec[i] !== ORDER.SBA) i++;
          const f = inputs.get(addr);
          if (f?.name) changed[f.name] = decodeEbcdic(rec.subarray(start, i)).replace(/\s+$/, '');
        }
      }
      Object.assign(session.inputs, changed);
      session.history.push({ screen: session.screen, aid, inputs: { ...changed }, cursor });
      const next = this.app.onAid(session, aid, changed);
      if (next) session.screen = next;
      show();
    };
    // ---- telnet (server side)
    let state: 'data' | 'iac' | 'cmd' | 'sb' | 'sbiac' = 'data';
    let cmd = 0;
    let rec: number[] = [];
    let sb: number[] = [];
    sock.on('data', (d: Buffer) => {
      for (const b of d) {
        if (state === 'data') {
          if (b === IAC) state = 'iac';
          else rec.push(b);
        } else if (state === 'iac') {
          if (b === IAC) {
            rec.push(IAC);
            state = 'data';
          } else if (b === EOR) {
            const r = Buffer.from(rec);
            rec = [];
            state = 'data';
            try {
              onRecord(r);
            } catch {
              sock.destroy();
            }
          } else if (b === SB) {
            sb = [];
            state = 'sb';
          } else if (b >= 251 && b <= 254) {
            cmd = b;
            state = 'cmd';
          } else state = 'data';
        } else if (state === 'cmd') {
          state = 'data';
          if (cmd === WILL && b === OPT.TTYPE) send([IAC, SB, OPT.TTYPE, 1, IAC, SE]);
          if (cmd === WILL) agreed.add(`will-${b}`);
          if (cmd === DO) agreed.add(`do-${b}`);
          if (['will-0', 'do-0', 'will-25', 'do-25'].every((k) => agreed.has(k)) && session.terminalType) begin();
        } else if (state === 'sb') {
          if (b === IAC) state = 'sbiac';
          else sb.push(b);
        } else if (state === 'sbiac') {
          if (b === SE) {
            state = 'data';
            if (sb[0] === OPT.TTYPE && sb[1] === 0) {
              session.terminalType = Buffer.from(sb.slice(2)).toString('ascii');
              send([IAC, DO, OPT.EOR, IAC, WILL, OPT.EOR, IAC, DO, OPT.BINARY, IAC, WILL, OPT.BINARY]);
            }
          } else {
            sb.push(b);
            state = 'sb';
          }
        }
      }
    });
    send([IAC, DO, OPT.TTYPE]);
  }
}

// ------------------------------------------------------------------ a demo application

export interface DemoBankOptions {
  users?: Record<string, string>;
  accounts?: Record<string, { name: string; balance: string; status: string }>;
  /** Layout variant: "moved" renames the USERID label to "USER ID" and shifts the field (for healing demos). */
  variant?: 'standard' | 'moved';
}

/**
 * A three-screen green-screen application (sign-on, main menu, account
 * inquiry) used by the docs and tests.
 */
export function createDemoBankApp(o: DemoBankOptions = {}): SimApp {
  const users = o.users ?? { CLERK01: 'SECRET1' };
  const accounts = o.accounts ?? {
    '10000001': { name: 'ADA LOVELACE', balance: '1,250.00', status: 'ACTIVE' },
    '10000002': { name: 'CHARLES BABBAGE', balance: '0.00', status: 'CLOSED' },
  };
  const moved = o.variant === 'moved';
  const msg = (s: SimSession): SimField => ({ row: 22, col: 2, text: String(s.state.message ?? ''), intensified: true });
  return {
    start: 'logon',
    screens: {
      logon: (s) => ({
        fields: [
          { row: 1, col: 28, text: 'ACME BANKING SYSTEM', intensified: true },
          { row: 3, col: 2, text: 'SIGN ON' },
          moved ? { row: 5, col: 10, text: 'USER ID     ===>' } : { row: 5, col: 10, text: 'USERID   ===>' },
          { row: 5, col: moved ? 28 : 24, name: 'userid', length: 8 },
          { row: 6, col: 10, text: 'PASSWORD ===>' },
          { row: 6, col: 24, name: 'password', length: 8, hidden: true },
          msg(s),
          { row: 24, col: 2, text: 'ENTER=SIGN ON  PF3=EXIT' },
        ],
      }),
      menu: (s) => ({
        fields: [
          { row: 1, col: 32, text: 'MAIN MENU', intensified: true },
          { row: 2, col: 2, text: `USER: ${String(s.state.user ?? '')}` },
          { row: 5, col: 10, text: '1  ACCOUNT INQUIRY' },
          { row: 6, col: 10, text: '2  FUNDS TRANSFER' },
          { row: 20, col: 2, text: 'OPTION ===>' },
          { row: 20, col: 14, name: 'option', length: 2, numeric: true },
          msg(s),
          { row: 24, col: 2, text: 'ENTER=SELECT  PF3=SIGN OFF' },
        ],
      }),
      inquiry: (s) => {
        const acct = s.state.account as { name: string; balance: string; status: string } | undefined;
        return {
          fields: [
            { row: 1, col: 29, text: 'ACCOUNT INQUIRY', intensified: true },
            { row: 4, col: 2, text: 'ACCOUNT NUMBER ===>' },
            { row: 4, col: 22, name: 'account', length: 8, numeric: true, value: String(s.state.accountNo ?? '') },
            { row: 6, col: 2, text: 'NAME' },
            { row: 6, col: 22, text: acct?.name ?? '' },
            { row: 7, col: 2, text: 'BALANCE' },
            { row: 7, col: 22, text: acct?.balance ?? '' },
            { row: 8, col: 2, text: 'STATUS' },
            { row: 8, col: 22, text: acct?.status ?? '' },
            msg(s),
            { row: 24, col: 2, text: 'ENTER=INQUIRE  PF3=RETURN' },
          ],
        };
      },
    },
    onAid(s, aid, changed) {
      s.state.message = '';
      if (s.screen === 'logon') {
        if (aid === 'PF3') {
          s.state.message = 'GOODBYE';
          return 'logon';
        }
        if (aid !== 'ENTER') {
          s.state.message = 'INVALID KEY';
          return undefined;
        }
        const u = (changed.userid ?? s.inputs.userid ?? '').trim().toUpperCase();
        const p = (changed.password ?? '').trim();
        if (users[u] !== undefined && users[u] === p) {
          s.state.user = u;
          s.state.message = `WELCOME ${u}`;
          return 'menu';
        }
        s.state.message = 'INVALID USERID OR PASSWORD';
        return undefined;
      }
      if (s.screen === 'menu') {
        if (aid === 'PF3') {
          s.state.message = 'SIGNED OFF';
          return 'logon';
        }
        if (aid === 'ENTER' && (changed.option ?? '').trim() === '1') return 'inquiry';
        s.state.message = 'INVALID OPTION';
        return undefined;
      }
      if (s.screen === 'inquiry') {
        if (aid === 'PF3') {
          delete s.state.account;
          delete s.state.accountNo;
          return 'menu';
        }
        const no = (changed.account ?? String(s.state.accountNo ?? '')).trim();
        s.state.accountNo = no;
        const acct = accounts[no];
        s.state.account = acct;
        s.state.message = acct ? 'ACCOUNT FOUND' : 'ACCOUNT NOT FOUND';
        return undefined;
      }
      return undefined;
    },
  };
}
