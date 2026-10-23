/**
 * A TN5250 host simulator (an IBM i stand-in for offline tests): a telnet
 * server that negotiates TERMINAL-TYPE, NEW-ENVIRON (it asks for DEVNAME and
 * USER like the IBM i Telnet server), BINARY and END-OF-RECORD, sends the
 * 5250 Query, then serves screens as Write To Display streams with Start Of
 * Field orders and a Read MDT Fields command, and decodes the operator's
 * inbound records (cursor, AID, modified fields). Applications can answer
 * with a new screen or a Write Error Code message (which needs Reset), and
 * SysReq/Attn arrive as header flags.
 *
 * It is written from the 5250 functions reference, independently of the
 * client in client.ts, so the two check each other.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { decodeEbcdic, encodeEbcdic } from '../tn3270/ebcdic.js';
import { DO, EOR, IAC, OPT, SB, SE, WILL } from '../telnet.js';

export interface Sim5250Field {
  row: number;
  col: number;
  /** Output text (protected). */
  text?: string;
  /** An input field of `length` positions, reported back under `name`. */
  name?: string;
  length?: number;
  value?: string;
  hidden?: boolean;
  /** Shift: numeric only / digits only / signed numeric. */
  numeric?: 'numeric' | 'digits' | 'signed';
  monocase?: boolean;
  mandatoryEnter?: boolean;
  /** Input-capable but bypass (output field of a format). */
  bypass?: boolean;
  intensified?: boolean;
  /** Right adjust with zero fill (5) or blank fill (6). */
  rightAdjust?: 'zero' | 'blank';
}

export interface Sim5250Screen {
  fields: Sim5250Field[];
  cursor?: string | { row: number; col: number };
  /** Read Input Fields instead of Read MDT Fields. */
  readAll?: boolean;
}

export interface Sim5250Session {
  terminalType?: string;
  /** NEW-ENVIRON values the client sent (VAR and USERVAR). */
  environ: Record<string, string>;
  /** The 5250 Query reply bytes (after the GDS header). */
  queryReply?: Buffer;
  screen: string;
  inputs: Record<string, string>;
  state: Record<string, unknown>;
  history: Array<{ screen: string; aid: string; inputs: Record<string, string>; cursor: { row: number; col: number } }>;
}

export type Sim5250Answer = string | { error: string } | undefined;

export interface Sim5250App {
  start: string;
  screens: Record<string, (s: Sim5250Session) => Sim5250Screen>;
  /** AID names: ENTER, F1..F24, ROLLUP, ROLLDOWN, HELP, PRINT, CLEAR, SYSREQ, ATTN. */
  onAid(s: Sim5250Session, aid: string, changed: Record<string, string>): Sim5250Answer;
}

export interface Simulator5250Options {
  port?: number;
  host?: string;
  delayMs?: number;
  /** Send the 5250 Query after negotiation (default true, as IBM i does). */
  query?: boolean;
}

const AID_NAMES = new Map<number, string>([
  [0xf1, 'ENTER'], [0xf3, 'HELP'], [0xf4, 'ROLLDOWN'], [0xf5, 'ROLLUP'], [0xf6, 'PRINT'], [0xf8, 'RECORDBACKSPACE'], [0xbd, 'CLEAR'], [0x3f, 'AUTOENTER'],
  ...Array.from({ length: 12 }, (_, i) => [0x31 + i, `F${i + 1}`] as [number, string]),
  ...Array.from({ length: 12 }, (_, i) => [0xb1 + i, `F${i + 13}`] as [number, string]),
]);

function gds(opcode: number, data: number[] | Buffer): Buffer {
  const len = 10 + data.length;
  return Buffer.concat([Buffer.from([len >> 8, len & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, opcode]), Buffer.from(data)]);
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

/** Build the Write To Display stream for a screen, and where each named input field starts (row:col). */
export function build5250Screen(screen: Sim5250Screen, rows = 24, cols = 80): { data: Buffer; inputs: Map<string, Sim5250Field> } {
  const out: number[] = [0x04, 0x40, 0x04, 0x11, 0x00, 0x08]; // Clear Unit; Write To Display, CC1 none, CC2 unlock keyboard
  out.push(0x01, 0x07, 0x00, 0x00, 0x00, rows, 0x00, 0x00, 0x00); // SOH: error row = last row, all F keys enabled
  const inputs = new Map<string, Sim5250Field>();
  const chk = (r: number, c: number) => {
    if (r < 1 || c < 1 || r > rows || c > cols) throw new Error(`5250 simulator: row ${r} column ${c} is outside ${rows}x${cols}`);
  };
  for (const f of screen.fields) {
    chk(f.row, f.col);
    const attr = f.hidden ? 0x27 : f.intensified ? 0x22 : f.name ? 0x24 : 0x20; // inputs are underlined
    if (f.name) {
      const len = f.length ?? 1;
      if (f.col < 2) throw new Error('5250 simulator: an input field needs its attribute in the column before it');
      const shift = f.numeric === 'digits' ? 5 : f.numeric === 'signed' ? 7 : f.numeric ? 3 : 0;
      const ffw1 = 0x40 | (f.bypass ? 0x20 : 0) | shift;
      const ffw2 = (f.monocase ? 0x20 : 0) | (f.mandatoryEnter ? 0x08 : 0) | (f.rightAdjust === 'zero' ? 5 : f.rightAdjust === 'blank' ? 6 : 0);
      out.push(0x11, f.row, f.col - 1, 0x1d, ffw1, ffw2, attr, len >> 8, len & 0xff, ...encodeEbcdic((f.value ?? '').slice(0, len)));
      const endCol = f.col + len;
      if (endCol <= cols) out.push(0x11, f.row, endCol, 0x20);
      inputs.set(`${f.row}:${f.col}`, f);
    } else {
      const text = f.text ?? '';
      if (f.col > 1) out.push(0x11, f.row, f.col - 1, attr, ...encodeEbcdic(text));
      else out.push(0x11, f.row, f.col, ...encodeEbcdic(text));
      const endCol = f.col + text.length;
      if (attr !== 0x20 && endCol <= cols) out.push(0x11, f.row, endCol, 0x20);
    }
  }
  let cursor: { row: number; col: number } | undefined;
  if (typeof screen.cursor === 'object') cursor = screen.cursor;
  else {
    const f = screen.fields.find((x) => x.name && !x.bypass && (screen.cursor === undefined || x.name === screen.cursor));
    if (f) cursor = { row: f.row, col: f.col };
  }
  if (cursor) out.push(0x13, cursor.row, cursor.col);
  out.push(0x04, screen.readAll ? 0x42 : 0x52, 0x00, 0x00); // Read Input / Read MDT Fields
  return { data: Buffer.from(out), inputs };
}

/** A TN5250 host serving one Sim5250App to every connection. */
export class Ibmi5250Simulator {
  private server?: Server;
  readonly sessions: Sim5250Session[] = [];
  private readonly sockets = new Set<Socket>();

  constructor(readonly app: Sim5250App, readonly options: Simulator5250Options = {}) {}

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
    const session: Sim5250Session = { screen: this.app.start, environ: {}, inputs: {}, state: {}, history: [] };
    this.sessions.push(session);
    let rows = 24;
    let cols = 80;
    let inputs = new Map<string, Sim5250Field>();
    let negotiated = false;
    let awaitingQuery = false;
    const agreed = new Set<string>();
    const send = (b: number[]) => sock.writable && sock.write(Buffer.from(b));
    const write = (rec: Buffer) => {
      const go = () => sock.writable && sock.write(frame(rec));
      if (this.options.delayMs) setTimeout(go, this.options.delayMs);
      else go();
    };
    const show = () => {
      const scr = this.app.screens[session.screen];
      if (!scr) throw new Error(`5250 simulator has no screen "${session.screen}"`);
      const built = build5250Screen(scr(session), rows, cols);
      inputs = built.inputs;
      write(gds(0x03, built.data));
    };
    const errorCode = (text: string) => {
      // Write Error Code: the message replaces the error line; the keyboard stays inhibited until Reset.
      write(gds(0x03, [0x04, 0x21, 0x22, ...encodeEbcdic(text.slice(0, cols - 2)), 0x20, 0x04, 0x52, 0x00, 0x00]));
    };
    const begin = () => {
      if (negotiated) return;
      negotiated = true;
      if (session.terminalType === 'IBM-3477-FC') {
        rows = 27;
        cols = 132;
      }
      if (this.options.query !== false) {
        awaitingQuery = true;
        write(gds(0x00, [0x04, 0xf3, 0x00, 0x05, 0xd9, 0x70, 0x00]));
      } else show();
    };
    const onRecord = (rec: Buffer) => {
      if (rec.length < 10 || rec[2] !== 0x12 || rec[3] !== 0xa0) throw new Error('not a GDS record');
      const flags = rec[7];
      const data = rec.subarray(6 + rec[6]);
      if (awaitingQuery) {
        if (data[2] !== 0x88 || data[5] !== 0xd9 || data[6] !== 0x70) throw new Error('expected a 5250 query reply');
        awaitingQuery = false;
        session.queryReply = Buffer.from(data);
        show();
        return;
      }
      let aid: string;
      const changed: Record<string, string> = {};
      let cursor = { row: 1, col: 1 };
      if (flags & 0x04) aid = 'SYSREQ';
      else if (flags & 0x40) aid = 'ATTN';
      else {
        cursor = { row: data[0], col: data[1] };
        aid = AID_NAMES.get(data[2]) ?? `0x${data[2].toString(16)}`;
        let i = 3;
        while (i < data.length && data[i] === 0x11) {
          const key = `${data[i + 1]}:${data[i + 2]}`;
          i += 3;
          const start = i;
          while (i < data.length && data[i] !== 0x11) i++;
          const f = inputs.get(key);
          if (f?.name) changed[f.name] = decodeEbcdic(data.subarray(start, i)).replace(/\s+$/, '');
        }
      }
      Object.assign(session.inputs, changed);
      session.history.push({ screen: session.screen, aid, inputs: { ...changed }, cursor });
      const next = this.app.onAid(session, aid, changed);
      if (next && typeof next === 'object') {
        errorCode(next.error);
        return;
      }
      if (next) session.screen = next;
      show();
    };
    // ---- telnet (server side)
    let state: 'data' | 'iac' | 'cmd' | 'sb' | 'sbiac' = 'data';
    let cmd = 0;
    let rec: number[] = [];
    let sb: number[] = [];
    const maybeBegin = () => {
      if (['will-0', 'do-0', 'will-25', 'do-25'].every((k) => agreed.has(k)) && session.terminalType) begin();
    };
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
          if (cmd === WILL && b === OPT.NEW_ENVIRON) send([IAC, SB, OPT.NEW_ENVIRON, 1, 0, ...Buffer.from('USER'), 3, ...Buffer.from('DEVNAME'), IAC, SE]);
          if (cmd === WILL && b === OPT.TTYPE) send([IAC, SB, OPT.TTYPE, 1, IAC, SE]);
          if (cmd === WILL) agreed.add(`will-${b}`);
          if (cmd === DO) agreed.add(`do-${b}`);
          maybeBegin();
        } else if (state === 'sb') {
          if (b === IAC) state = 'sbiac';
          else sb.push(b);
        } else if (state === 'sbiac') {
          if (b === SE) {
            state = 'data';
            if (sb[0] === OPT.TTYPE && sb[1] === 0) {
              session.terminalType = Buffer.from(sb.slice(2)).toString('ascii');
              send([IAC, DO, OPT.EOR, IAC, WILL, OPT.EOR, IAC, DO, OPT.BINARY, IAC, WILL, OPT.BINARY]);
            } else if (sb[0] === OPT.NEW_ENVIRON && sb[1] === 0) {
              // IS: (VAR|USERVAR) name VALUE value ...
              let k = 2;
              while (k < sb.length) {
                if (sb[k] !== 0 && sb[k] !== 3) break;
                k++;
                let name = '';
                while (k < sb.length && sb[k] !== 1 && sb[k] !== 0 && sb[k] !== 3) name += String.fromCharCode(sb[k++]);
                let value = '';
                if (sb[k] === 1) {
                  k++;
                  while (k < sb.length && sb[k] !== 0 && sb[k] !== 3) value += String.fromCharCode(sb[k++]);
                }
                if (name) session.environ[name] = value;
              }
            }
            maybeBegin();
          } else {
            sb.push(b);
            state = 'sb';
          }
        }
      }
    });
    send([IAC, DO, OPT.NEW_ENVIRON, IAC, DO, OPT.TTYPE]);
  }
}

// ------------------------------------------------------------------ a demo IBM i application

export interface DemoIbmiOptions {
  system?: string;
  users?: Record<string, string>;
  customers?: Record<string, { name: string; balance: string; status: string }>;
  /** "moved" relabels "User" as "Profile name" and shifts the field (for healing demos). */
  variant?: 'standard' | 'moved';
}

const dots = (label: string, width = 35) => `${label} ${'. '.repeat(Math.max(0, Math.floor((width - label.length - 1) / 2)))}`.slice(0, width).padEnd(width);

/**
 * The IBM i sign-on screen, a main menu, a customer inquiry with a numeric
 * field, F3/F12 conventions, function key legend and a Write Error Code on a
 * bad customer number.
 */
export function createDemoIbmiApp(o: DemoIbmiOptions = {}): Sim5250App {
  const system = o.system ?? 'EZ400';
  const users = o.users ?? { CLERK01: 'SECRET1' };
  const customers = o.customers ?? {
    '100001': { name: 'ADA LOVELACE', balance: '1,250.00', status: 'ACTIVE' },
    '100002': { name: 'CHARLES BABBAGE', balance: '0.00', status: 'CLOSED' },
    '42': { name: 'GRACE HOPPER', balance: '42.00', status: 'ACTIVE' },
  };
  const moved = o.variant === 'moved';
  const msg = (s: Sim5250Session): Sim5250Field => ({ row: 24, col: 2, text: String(s.state.message ?? ''), intensified: true });
  return {
    start: 'signon',
    screens: {
      signon: (s) => ({
        fields: [
          { row: 1, col: 36, text: 'Sign On', intensified: true },
          { row: 2, col: 49, text: `System  . . . . . :   ${system}` },
          { row: 3, col: 49, text: 'Subsystem . . . . :   QINTER' },
          { row: 4, col: 49, text: `Display . . . . . :   ${s.environ.DEVNAME || 'QPADEV0001'}` },
          { row: 6, col: 17, text: moved ? dots('Profile name', 38) : dots('User') },
          { row: 6, col: moved ? 56 : 53, name: 'user', length: 10, monocase: true },
          { row: 7, col: 17, text: dots('Password') },
          { row: 7, col: 53, name: 'password', length: 10, hidden: true },
          { row: 8, col: 17, text: dots('Program/procedure') },
          { row: 8, col: 53, name: 'program', length: 10, monocase: true },
          { row: 9, col: 17, text: dots('Menu') },
          { row: 9, col: 53, name: 'menu', length: 10, monocase: true },
          { row: 10, col: 17, text: dots('Current library') },
          { row: 10, col: 53, name: 'curlib', length: 10, monocase: true },
          { row: 23, col: 40, text: '(C) COPYRIGHT EZTEST SIMULATOR' },
          msg(s),
        ],
      }),
      main: (s) => ({
        fields: [
          { row: 1, col: 2, text: 'MAIN' },
          { row: 1, col: 33, text: 'IBM i Main Menu', intensified: true },
          { row: 2, col: 63, text: `System:   ${system}` },
          { row: 3, col: 2, text: 'Select one of the following:' },
          { row: 5, col: 6, text: '1. Customer inquiry' },
          { row: 6, col: 6, text: '2. Order entry' },
          { row: 8, col: 5, text: '90. Sign off' },
          { row: 19, col: 2, text: 'Selection or command' },
          { row: 20, col: 2, text: '===>' },
          { row: 20, col: 7, name: 'selection', length: 40 },
          { row: 22, col: 2, text: 'F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel' },
          msg(s),
        ],
      }),
      inquiry: (s) => {
        const c = s.state.customer as { name: string; balance: string; status: string } | undefined;
        return {
          fields: [
            { row: 1, col: 2, text: 'CUSINQ' },
            { row: 1, col: 32, text: 'Customer Inquiry', intensified: true },
            { row: 4, col: 3, text: dots('Customer number', 30) },
            { row: 4, col: 34, name: 'customer', length: 6, numeric: 'digits', rightAdjust: 'zero', value: String(s.state.customerNo ?? '') },
            { row: 6, col: 3, text: dots('Name', 30) },
            { row: 6, col: 34, text: c?.name ?? '' },
            { row: 7, col: 3, text: dots('Balance', 30) },
            { row: 7, col: 34, text: c?.balance ?? '' },
            { row: 8, col: 3, text: dots('Status', 30) },
            { row: 8, col: 34, text: c?.status ?? '' },
            { row: 22, col: 2, text: 'F3=Exit   F5=Refresh   F12=Cancel' },
            msg(s),
          ],
        };
      },
      sysreq: (s) => ({
        fields: [
          { row: 1, col: 31, text: 'System Request', intensified: true },
          { row: 3, col: 2, text: 'Select one of the following:' },
          { row: 5, col: 6, text: '90. Sign off' },
          { row: 20, col: 2, text: 'Selection' },
          { row: 20, col: 12, name: 'option', length: 2, numeric: 'digits' },
          { row: 22, col: 2, text: 'F3=Exit   F12=Cancel' },
          msg(s),
        ],
      }),
    },
    onAid(s, aid, changed) {
      s.state.message = '';
      if (aid === 'SYSREQ' && s.screen !== 'signon') {
        s.state.returnTo = s.screen;
        return 'sysreq';
      }
      if (s.screen === 'signon') {
        if (aid !== 'ENTER') return undefined;
        const u = (changed.user ?? s.inputs.user ?? '').trim().toUpperCase();
        const p = (changed.password ?? '').trim();
        if (!u) {
          s.state.message = 'CPF1110 User profile must be specified.';
          return undefined;
        }
        if (users[u] === undefined) {
          s.state.message = `CPF1120 User ${u} does not exist.`;
          return undefined;
        }
        if (users[u] !== p) {
          s.state.message = 'CPF1107 Password not correct for user profile.';
          return undefined;
        }
        s.state.user = u;
        return 'main';
      }
      if (s.screen === 'main') {
        if (aid === 'F3' || aid === 'F12') return undefined;
        const sel = (changed.selection ?? '').trim().toUpperCase();
        if (sel === '1') return 'inquiry';
        if (sel === '90' || sel === 'SIGNOFF') {
          s.state.message = '';
          return 'signon';
        }
        if (!sel) return undefined;
        s.state.message = `CPD9898 Selection or command ${sel} not valid.`;
        return undefined;
      }
      if (s.screen === 'inquiry') {
        if (aid === 'F3') return 'main';
        if (aid === 'F12') {
          delete s.state.customer;
          delete s.state.customerNo;
          return 'main';
        }
        const no = (changed.customer ?? String(s.state.customerNo ?? '')).trim().replace(/^0+(?=\d)/, '');
        const c = customers[no];
        if (!c) return { error: `CUS0001 Customer number ${no || '(blank)'} not found.` };
        s.state.customerNo = no.padStart(6, '0');
        s.state.customer = c;
        s.state.message = 'Customer found.';
        return undefined;
      }
      if (s.screen === 'sysreq') {
        if (aid === 'F3' || aid === 'F12') return String(s.state.returnTo ?? 'main');
        if ((changed.option ?? '').trim() === '90') return 'signon';
        return undefined;
      }
      return undefined;
    },
  };
}
