/**
 * Minimal telnet layer for block-mode terminals (TN3270, TN5250): option
 * negotiation (BINARY, END-OF-RECORD, TERMINAL-TYPE, NEW-ENVIRON), record
 * framing on IAC EOR and IAC escaping. Everything else is refused.
 */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;
export const EOR = 239;
export const NOP = 241;

export const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, EOR: 25, NEW_ENVIRON: 39, TN3270E: 40 } as const;

export interface TelnetPolicy {
  /** Terminal type sent for TERMINAL-TYPE SEND, e.g. "IBM-3278-2" or "IBM-3179-2". */
  terminalType: string;
  /** NEW-ENVIRON variables (TN5250 device name, user ...), sent when the host asks. */
  environ?: Record<string, string>;
}

/**
 * A telnet connection that yields whole records. Emits `record` (Buffer),
 * `negotiated` (once BINARY+EOR both ways and the terminal type were sent),
 * `close` and `error`.
 */
export class TelnetConnection extends EventEmitter {
  private state: 'data' | 'iac' | 'cmd' | 'sb' | 'sbiac' = 'data';
  private cmd = 0;
  private record: number[] = [];
  private sb: number[] = [];
  private readonly agreed = { binaryIn: false, binaryOut: false, eorIn: false, eorOut: false, ttype: false };
  private negotiatedOnce = false;
  /** Bytes received outside records before negotiation finished (NVT text, banners). */
  readonly nvtText: number[] = [];
  /** Hex-free trace of the telnet exchange, for evidence. */
  readonly trace: string[] = [];

  constructor(readonly socket: Socket | TLSSocket, private readonly policy: TelnetPolicy) {
    super();
    socket.on('data', (d: Buffer) => {
      try {
        this.feed(d);
      } catch (e) {
        this.emit('error', e);
      }
    });
    socket.on('close', () => this.emit('close'));
    socket.on('error', (e) => this.emit('error', e));
  }

  get negotiated(): boolean {
    return this.negotiatedOnce;
  }

  private note(s: string): void {
    if (this.trace.length < 200) this.trace.push(s);
  }

  private feed(d: Buffer): void {
    for (const b of d) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else if (this.negotiatedOnce || this.agreed.binaryIn) this.record.push(b);
          else this.nvtText.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            this.record.push(IAC);
            this.state = 'data';
          } else if (b === EOR) {
            const rec = Buffer.from(this.record);
            this.record = [];
            this.state = 'data';
            this.emit('record', rec);
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = 'cmd';
          } else if (b === SB) {
            this.sb = [];
            this.state = 'sb';
          } else {
            this.state = 'data'; // NOP, GA, ... ignored
          }
          break;
        case 'cmd':
          this.option(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sbiac';
          else this.sb.push(b);
          break;
        case 'sbiac':
          if (b === SE) {
            this.subnegotiation(Buffer.from(this.sb));
            this.state = 'data';
          } else {
            this.sb.push(b);
            this.state = 'sb';
          }
          break;
      }
    }
  }

  private send(bytes: number[]): void {
    this.socket.write(Buffer.from(bytes));
  }

  private option(cmd: number, opt: number): void {
    const name = Object.entries(OPT).find(([, v]) => v === opt)?.[0] ?? String(opt);
    const verb = cmd === DO ? 'DO' : cmd === DONT ? 'DONT' : cmd === WILL ? 'WILL' : 'WONT';
    this.note(`host ${verb} ${name}`);
    const supported = opt === OPT.BINARY || opt === OPT.EOR || opt === OPT.TTYPE || (opt === OPT.NEW_ENVIRON && !!this.policy.environ);
    if (cmd === DO) {
      if (supported) {
        this.send([IAC, WILL, opt]);
        if (opt === OPT.BINARY) this.agreed.binaryOut = true;
        if (opt === OPT.EOR) this.agreed.eorOut = true;
      } else this.send([IAC, WONT, opt]);
    } else if (cmd === WILL) {
      if (opt === OPT.BINARY || opt === OPT.EOR) {
        this.send([IAC, DO, opt]);
        if (opt === OPT.BINARY) this.agreed.binaryIn = true;
        if (opt === OPT.EOR) this.agreed.eorIn = true;
      } else this.send([IAC, DONT, opt]);
    } else if (cmd === DONT) {
      this.send([IAC, WONT, opt]);
    } else {
      this.send([IAC, DONT, opt]);
    }
    this.checkNegotiated();
  }

  private subnegotiation(sb: Buffer): void {
    const opt = sb[0];
    if (opt === OPT.TTYPE && sb[1] === 1) {
      this.note(`host asks terminal type; sending ${this.policy.terminalType}`);
      this.send([IAC, SB, OPT.TTYPE, 0, ...Buffer.from(this.policy.terminalType, 'ascii'), IAC, SE]);
      this.agreed.ttype = true;
    } else if (opt === OPT.NEW_ENVIRON && sb[1] === 1 && this.policy.environ) {
      // IS: VAR name VALUE value / USERVAR name VALUE value
      const out: number[] = [IAC, SB, OPT.NEW_ENVIRON, 0];
      for (const [k, v] of Object.entries(this.policy.environ)) {
        const isVar = k === 'USER';
        out.push(isVar ? 0 : 3, ...escapeIac(Buffer.from(k, 'ascii')), 1, ...escapeIac(Buffer.from(v, 'ascii')));
      }
      out.push(IAC, SE);
      this.note(`host asks environment; sending ${Object.keys(this.policy.environ).join(', ')}`);
      this.send(out);
    }
    this.checkNegotiated();
  }

  private checkNegotiated(): void {
    const a = this.agreed;
    if (!this.negotiatedOnce && a.binaryIn && a.binaryOut && a.eorIn && a.eorOut && a.ttype) {
      this.negotiatedOnce = true;
      this.note('negotiated binary, end-of-record and terminal type');
      this.emit('negotiated');
    }
  }

  /** Send one record (IAC doubled, IAC EOR appended). */
  sendRecord(data: Uint8Array): void {
    this.socket.write(Buffer.from([...escapeIac(data), IAC, EOR]));
  }

  close(): void {
    this.socket.destroy();
  }
}

export function escapeIac(data: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of data) {
    out.push(b);
    if (b === IAC) out.push(IAC);
  }
  return out;
}
