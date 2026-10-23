/**
 * A TN5250 client in TypeScript (RFC 1205, RFC 2877 environment options):
 * telnet negotiation (TERMINAL-TYPE IBM-3179-2 or IBM-3477-FC, BINARY,
 * END-OF-RECORD, NEW-ENVIRON with DEVNAME and friends), GDS record framing,
 * the 5250 data stream (see screen.ts), attention keys, SysReq/Attn through
 * header flags, and the local keys of a display station (Field Exit, Field+,
 * Field-, Reset, Erase EOF). TLS uses node:tls with certificate checks on.
 *
 * Sign-on is done on the IBM i sign-on screen like an operator does; RFC 4777
 * automatic sign-on with an encrypted password substitute is not implemented.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { TelnetConnection } from '../telnet.js';
import { fieldAtRowCol, fieldByLabel, type FieldMatch } from '../tn3270/fields.js';
import { TerminalError, type ScreenField, type ScreenSnapshot } from '../tn3270/screen.js';
import type { TerminalClient } from '../types.js';
import { AID5250, HFLAG, OPCODE, Screen5250, aid5250Name } from './screen.js';

export interface Tn5250Options {
  host: string;
  port?: number;
  tls?: boolean | { ca?: string | Buffer; servername?: string };
  /** 24x80 (default) or 27x132 display. */
  wide?: boolean;
  /** Terminal type override (default IBM-3179-2, or IBM-3477-FC for wide). */
  terminalType?: string;
  /** Virtual device name requested from the host (NEW-ENVIRON USERVAR DEVNAME). */
  deviceName?: string;
  /** Extra NEW-ENVIRON user variables (KBDTYPE, CODEPAGE, CHARSET ...). */
  environ?: Record<string, string>;
  connectTimeoutMs?: number;
}

export interface Tn5250WaitOptions {
  timeoutMs?: number;
  /** Quiet time after the keyboard unlocks before the screen counts as complete. Default 120ms. */
  settleMs?: number;
}

/** Build a GDS record: 10-byte header (length, 0x12A0, flow, header length, flags, opcode) + data. */
export function gdsRecord(opcode: number, data: Uint8Array = new Uint8Array(), flags = 0): Buffer {
  const len = 10 + data.length;
  return Buffer.concat([Buffer.from([(len >> 8) & 0xff, len & 0xff, 0x12, 0xa0, 0x00, 0x00, 0x04, flags, 0x00, opcode]), Buffer.from(data)]);
}

/** Split a GDS record into header fields and data. */
export function parseGds(rec: Uint8Array): { length: number; flags: number; opcode: number; data: Uint8Array } {
  if (rec.length < 10 || rec[2] !== 0x12 || rec[3] !== 0xa0) throw new TerminalError(`not a 5250 GDS record (${rec.length} bytes)`);
  const varLen = rec[6];
  return { length: (rec[0] << 8) | rec[1], flags: rec[7], opcode: rec[9], data: rec.subarray(6 + varLen) };
}

export class Tn5250Client implements TerminalClient {
  readonly protocol = 'tn5250' as const;
  readonly keyHelp = 'Enter, F1-F24, Page Up/Down (Roll), Help, Print, Clear, SysReq, Attn, Field Exit, Field+, Field-, Reset';
  readonly screen: Screen5250;
  private readonly telnet: TelnetConnection;
  private lastRecordAt = 0;
  private closed = false;
  private error?: Error;
  private waiters = new Set<() => void>();
  /** Records exchanged, for evidence. */
  readonly log: Array<{ dir: 'in' | 'out'; bytes: number; at: number; opcode: number; note?: string }> = [];

  private constructor(socket: Socket | TLSSocket, readonly options: Tn5250Options) {
    this.screen = new Screen5250(!!options.wide);
    const environ: Record<string, string> = { ...(options.environ ?? {}) };
    if (options.deviceName) environ.DEVNAME = options.deviceName;
    this.telnet = new TelnetConnection(socket, {
      terminalType: options.terminalType ?? (options.wide ? 'IBM-3477-FC' : 'IBM-3179-2'),
      ...(Object.keys(environ).length ? { environ } : { environ: {} }),
    });
    this.telnet.on('record', (rec: Buffer) => this.onRecord(rec));
    this.telnet.on('close', () => {
      this.closed = true;
      this.wake();
    });
    this.telnet.on('error', (e: Error) => {
      this.error = e;
      this.wake();
    });
  }

  static async connect(options: Tn5250Options): Promise<Tn5250Client> {
    const port = options.port ?? (options.tls ? 992 : 23);
    const timeout = options.connectTimeoutMs ?? 10_000;
    const socket: Socket | TLSSocket = options.tls
      ? tlsConnect({ host: options.host, port, ...(typeof options.tls === 'object' ? { ca: options.tls.ca, servername: options.tls.servername ?? options.host } : { servername: options.host }) })
      : netConnect({ host: options.host, port });
    const client = new Tn5250Client(socket, options);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TerminalError(`TN5250 negotiation with ${options.host}:${port} did not finish within ${timeout}ms${client.telnet.trace.length ? ` (${client.telnet.trace.join('; ')})` : ''}`));
      }, timeout);
      const done = (e?: Error) => {
        clearTimeout(timer);
        if (e) reject(e);
        else resolve();
      };
      client.telnet.once('negotiated', () => done());
      socket.once('error', (e) => done(new TerminalError(`cannot connect to ${options.host}:${port}: ${e.message}`)));
      socket.once('close', () => done(new TerminalError(`${options.host}:${port} closed the connection during negotiation`)));
    });
    return client;
  }

  get negotiationTrace(): string[] {
    return this.telnet.trace;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  keyName(key: string): string | undefined {
    return aid5250Name(key);
  }

  private onRecord(rec: Buffer): void {
    this.lastRecordAt = Date.now();
    try {
      const g = parseGds(rec);
      this.log.push({ dir: 'in', bytes: rec.length, at: this.lastRecordAt, opcode: g.opcode });
      if (this.log.length > 500) this.log.shift();
      if (g.opcode === OPCODE.MESSAGE_ON) this.screen.messageWaiting = true;
      else if (g.opcode === OPCODE.MESSAGE_OFF) this.screen.messageWaiting = false;
      for (const reply of this.screen.process(g.data)) {
        if (reply === 'query') this.send(gdsRecord(OPCODE.NO_OP, this.screen.queryReply()), 'query reply');
        else if (reply === 'readImmediate') this.send(gdsRecord(OPCODE.PUT_GET, this.screen.inbound(0x00)), 'read immediate');
        else if (reply === 'readScreenImmediate') this.send(gdsRecord(OPCODE.NO_OP, this.screen.screenImage()), 'read screen');
        else if (reply === 'saveScreen') this.send(gdsRecord(OPCODE.NO_OP, this.screen.saveImage()), 'save screen');
      }
    } catch (e) {
      this.error = e as Error;
    }
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private send(rec: Buffer, note?: string): void {
    if (this.closed) throw new TerminalError('the terminal session is closed');
    this.log.push({ dir: 'out', bytes: rec.length, at: Date.now(), opcode: rec[9], ...(note ? { note } : {}) });
    this.telnet.sendRecord(rec);
  }

  private check(): void {
    if (this.error) {
      const e = this.error;
      this.error = undefined;
      throw e instanceof TerminalError ? e : new TerminalError(`terminal session error: ${e.message}`);
    }
  }

  async waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.check();
      if (pred()) return;
      if (this.closed) throw new TerminalError(`the host closed the session while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new TerminalError(`timed out after ${timeoutMs}ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const waiters = this.waiters;
        const t = setTimeout(done, Math.min(50, left));
        function done() {
          clearTimeout(t);
          waiters.delete(done);
          resolve();
        }
        waiters.add(done);
      });
    }
  }

  /** A screen is complete when the keyboard is unlocked (or an error message inhibits it) and the host has been quiet for `settleMs`. */
  async waitForScreen(o: Tn5250WaitOptions = {}): Promise<void> {
    const settle = o.settleMs ?? 120;
    await this.waitUntil(() => (!this.screen.keyboardLocked || this.screen.errorState) && Date.now() - this.lastRecordAt >= settle, o.timeoutMs ?? 15_000, 'the host screen (keyboard unlock)');
  }

  async waitForText(text: string, o: Tn5250WaitOptions = {}): Promise<void> {
    await this.waitUntil(() => (!this.screen.keyboardLocked || this.screen.errorState) && this.screen.text().includes(text), o.timeoutMs ?? 15_000, `the screen to contain "${text}"`);
  }

  /** Press an attention key (Enter, F1-F24, Roll Up/Down, Help, Print, Clear) or SysReq/Attn. */
  press(key: string): void {
    const name = aid5250Name(key);
    if (!name) throw new TerminalError(`"${key}" is not a 5250 attention key (use ${this.keyHelp})`);
    this.check();
    if (name === 'SYSREQ' || name === 'ATTN') {
      // These interrupt the job whatever the keyboard state: a header-only record with the flag set.
      this.send(gdsRecord(OPCODE.NO_OP, new Uint8Array(), name === 'SYSREQ' ? HFLAG.SRQ : HFLAG.ATN), name);
      this.screen.keyboardLocked = true;
      return;
    }
    if (this.screen.errorState) throw new TerminalError(`cannot press ${name}: an error message inhibits the keyboard (press Reset first)`);
    if (this.screen.keyboardLocked) throw new TerminalError(`cannot press ${name}: the keyboard is locked (wait for the screen first)`);
    const aid = AID5250[name];
    const data = this.screen.inbound(aid);
    this.screen.keyboardLocked = true;
    this.screen.pendingRead = undefined;
    this.send(gdsRecord(OPCODE.PUT_GET, data, name === 'HELP' && this.screen.errorState ? HFLAG.HLP : 0), name);
  }

  async pressAndWait(key: string, o: Tn5250WaitOptions = {}): Promise<void> {
    const v = this.screen.version;
    this.press(key);
    await this.waitUntil(() => this.screen.version !== v, o.timeoutMs ?? 15_000, `the host to answer ${key}`);
    await this.waitForScreen(o);
  }

  /** Keys the display station handles itself. Returns what was done, or undefined when `key` is not one. */
  localKey(key: string): string | undefined {
    const k = key.trim().toUpperCase().replace(/[\s_]+/g, '');
    if (k === 'RESET') {
      this.screen.reset();
      return 'Reset';
    }
    if (k === 'FIELDEXIT') {
      this.screen.fieldExit('exit');
      return 'Field Exit';
    }
    if (k === 'FIELD+' || k === 'FIELDPLUS') {
      this.screen.fieldExit('plus');
      return 'Field+';
    }
    if (k === 'FIELD-' || k === 'FIELDMINUS') {
      this.screen.fieldExit('minus');
      return 'Field-';
    }
    return undefined;
  }

  typeAt(row: number, col: number, text: string, opts: { replace?: boolean } = {}): ScreenField {
    this.check();
    const f = fieldAtRowCol(this.screen, row, col);
    const addr = this.screen.addressOf(row, col);
    if (opts.replace !== false && addr === f.address) this.screen.fillField(f, text);
    else this.screen.typeAt(addr, text);
    return f;
  }

  fill(field: ScreenField, text: string): void {
    this.check();
    this.screen.fillField(field, text);
  }

  field(label: string): FieldMatch {
    return fieldByLabel(this.screen, label);
  }

  moveCursor(row: number, col: number): void {
    this.screen.cursor = this.screen.addressOf(row, col);
  }

  text(): string {
    return this.screen.text();
  }

  snapshot(): ScreenSnapshot {
    return this.screen.snapshot();
  }

  close(): void {
    this.closed = true;
    this.telnet.close();
  }
}
