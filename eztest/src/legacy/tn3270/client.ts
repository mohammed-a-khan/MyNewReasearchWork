/**
 * A TN3270 client in TypeScript: telnet negotiation (RFC 1576 / RFC 2355
 * fallback: TN3270E is refused, plain TN3270 is used), the 3270 data stream,
 * fields, AID keys and keyboard-lock handling. TLS uses node:tls with
 * certificate verification always on.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { TelnetConnection } from '../telnet.js';
import type { TerminalClient } from '../types.js';
import { fieldAtRowCol, fieldByLabel, type FieldMatch } from './fields.js';
import { AID, MODELS, Screen3270, TerminalError, aidName, type ScreenField, type ScreenSnapshot } from './screen.js';

export interface Tn3270Options {
  host: string;
  port?: number;
  /** TLS (TN3270 over SSL/TLS). `ca` adds trusted certificates; verification cannot be turned off. */
  tls?: boolean | { ca?: string | Buffer; servername?: string };
  /** 3278 model 2 (24x80, default), 3 (32x80), 4 (43x80) or 5 (27x132). */
  model?: 2 | 3 | 4 | 5;
  /** Terminal type override (default IBM-3278-<model>-E: extended data stream, so the host can query the screen size). */
  terminalType?: string;
  connectTimeoutMs?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Quiet time after the keyboard unlocks before the screen counts as complete. Default 120ms. */
  settleMs?: number;
}

export class Tn3270Client implements TerminalClient {
  readonly protocol = 'tn3270' as const;
  readonly keyHelp = 'Enter, PF1-PF24, PA1-PA3, Clear, SysReq';
  readonly screen: Screen3270;
  private readonly telnet: TelnetConnection;
  private lastRecordAt = 0;
  private closed = false;
  private error?: Error;
  private waiters = new Set<() => void>();
  /** Records exchanged (direction and size), kept for evidence. */
  readonly log: Array<{ dir: 'in' | 'out'; bytes: number; at: number; note?: string }> = [];

  private constructor(socket: Socket | TLSSocket, readonly options: Tn3270Options) {
    const model = options.model ?? 2;
    if (!MODELS[model]) throw new TerminalError(`unknown 3278 model ${String(model)} (use 2, 3, 4 or 5)`);
    this.screen = new Screen3270(model);
    this.telnet = new TelnetConnection(socket, { terminalType: options.terminalType ?? `IBM-3278-${model}-E` });
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

  /** Connect and finish telnet negotiation (the first screen may still be on its way: call waitForScreen). */
  static async connect(options: Tn3270Options): Promise<Tn3270Client> {
    const port = options.port ?? (options.tls ? 992 : 23);
    const timeout = options.connectTimeoutMs ?? 10_000;
    const socket: Socket | TLSSocket = options.tls
      ? tlsConnect({ host: options.host, port, ...(typeof options.tls === 'object' ? { ca: options.tls.ca, servername: options.tls.servername ?? options.host } : { servername: options.host }) })
      : netConnect({ host: options.host, port });
    const client = new Tn3270Client(socket, options);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TerminalError(`TN3270 negotiation with ${options.host}:${port} did not finish within ${timeout}ms${client.telnet.trace.length ? ` (${client.telnet.trace.join('; ')})` : ''}`));
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

  keyName(key: string): string | undefined {
    return aidName(key);
  }

  get negotiationTrace(): string[] {
    return this.telnet.trace;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onRecord(rec: Buffer): void {
    this.lastRecordAt = Date.now();
    this.log.push({ dir: 'in', bytes: rec.length, at: this.lastRecordAt });
    if (this.log.length > 500) this.log.shift();
    try {
      const r = this.screen.process(rec);
      if (r.read === 'query') this.send(this.screen.queryReply(), 'query reply');
      else if (r.read === 'buffer') this.send(this.screen.readBuffer(AID.NONE), 'read buffer');
      else if (r.read === 'modified' || r.read === 'modifiedAll') this.send(this.screen.readModified(AID.NONE, r.read === 'modifiedAll'), 'read modified');
    } catch (e) {
      this.error = e as Error;
    }
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private send(data: Buffer, note?: string): void {
    if (this.closed) throw new TerminalError('the terminal session is closed');
    this.log.push({ dir: 'out', bytes: data.length, at: Date.now(), ...(note ? { note } : {}) });
    this.telnet.sendRecord(data);
  }

  private check(): void {
    if (this.error) {
      const e = this.error;
      this.error = undefined;
      throw e instanceof TerminalError ? e : new TerminalError(`terminal session error: ${e.message}`);
    }
  }

  /** Wait until `pred` holds (re-checked on every host record and every 50ms). */
  async waitUntil(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.check();
      if (pred()) return;
      if (this.closed) throw new TerminalError(`the host closed the session while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new TerminalError(`timed out after ${timeoutMs}ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(50, left));
        function done() {
          clearTimeout(t);
          waiters.delete(done);
          resolve();
        }
        const waiters = this.waiters;
        waiters.add(done);
      });
    }
  }

  /** Wait for the host to finish a screen: keyboard unlocked and no data for `settleMs`. */
  async waitForScreen(o: WaitOptions = {}): Promise<void> {
    const settle = o.settleMs ?? 120;
    await this.waitUntil(() => !this.screen.keyboardLocked && Date.now() - this.lastRecordAt >= settle, o.timeoutMs ?? 15_000, 'the host screen (keyboard unlock)');
  }

  /** Wait until the screen shows `text` (case-sensitive substring of the screen text). */
  async waitForText(text: string, o: WaitOptions = {}): Promise<void> {
    await this.waitUntil(() => !this.screen.keyboardLocked && this.screen.text().includes(text), o.timeoutMs ?? 15_000, `the screen to contain "${text}"`);
  }

  /** Press an AID key: Enter, PF1-PF24, PA1-PA3, Clear, SysReq. Locks the keyboard until the host answers. */
  press(key: string): void {
    const name = aidName(key);
    if (!name) throw new TerminalError(`"${key}" is not a 3270 key (use Enter, PF1-PF24, PA1-PA3, Clear or SysReq)`);
    this.check();
    if (this.screen.keyboardLocked) throw new TerminalError(`cannot press ${name}: the keyboard is locked (wait for the screen first)`);
    const aid = AID[name];
    const data = this.screen.readModified(aid);
    if (name === 'CLEAR') this.screen.clearLocal();
    this.screen.keyboardLocked = true;
    this.send(data, name);
  }

  /** Press a key and wait for the answering screen. */
  async pressAndWait(key: string, o: WaitOptions = {}): Promise<void> {
    const v = this.screen.version;
    this.press(key);
    await this.waitUntil(() => this.screen.version !== v, o.timeoutMs ?? 15_000, `the host to answer ${key}`);
    await this.waitForScreen(o);
  }

  /** Type into the field at 1-based row/column (replaces the field's content from that position). */
  typeAt(row: number, col: number, text: string, opts: { replace?: boolean } = {}): ScreenField {
    this.check();
    const f = fieldAtRowCol(this.screen, row, col);
    const addr = this.screen.addressOf(row, col);
    if (opts.replace !== false && addr === f.address) this.screen.fillField(f, text);
    else this.screen.typeAt(addr, text);
    return f;
  }

  /** Replace the content of a field. */
  fill(field: ScreenField, text: string): void {
    this.check();
    this.screen.fillField(field, text);
  }

  /** The input field labelled `label` on the current screen. */
  field(label: string): FieldMatch {
    return fieldByLabel(this.screen, label);
  }

  /** Move the cursor to a 1-based position. */
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
