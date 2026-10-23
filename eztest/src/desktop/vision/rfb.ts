/**
 * A VNC (RFB 3.3/3.7/3.8, RFC 6143) client in TypeScript for the pixels-only
 * rung: Citrix/VDI desktops exposed over VNC, remote test machines, Docker
 * desktops. Security: None and VNC Authentication. Encodings: Raw, CopyRect,
 * DesktopSize. The framebuffer is kept as RGBA and exported as PNG.
 */
import { connect, type Socket } from 'node:net';
import { PNG } from 'pngjs';
import { vncAuthResponse } from './des.js';

export class RfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RfbError';
  }
}

export interface RfbOptions {
  host: string;
  port?: number;
  password?: string;
  timeoutMs?: number;
}

/** X11 keysyms for named keys. */
export const KEYSYMS: Record<string, number> = {
  ENTER: 0xff0d, RETURN: 0xff0d, TAB: 0xff09, ESCAPE: 0xff1b, ESC: 0xff1b, BACKSPACE: 0xff08, DELETE: 0xffff, INSERT: 0xff63,
  HOME: 0xff50, END: 0xff57, PAGEUP: 0xff55, PAGEDOWN: 0xff56, LEFT: 0xff51, UP: 0xff52, RIGHT: 0xff53, DOWN: 0xff54,
  ARROWLEFT: 0xff51, ARROWUP: 0xff52, ARROWRIGHT: 0xff53, ARROWDOWN: 0xff54, SPACE: 0x20,
  SHIFT: 0xffe1, CTRL: 0xffe3, CONTROL: 0xffe3, ALT: 0xffe9, WIN: 0xffeb, META: 0xffe7,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0xffbe + i])),
};

/** Buffered reads over a socket. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiting?: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void };
  private error?: Error;

  constructor(socket: Socket) {
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.pump();
    });
    const fail = (e: Error) => {
      this.error = e;
      this.waiting?.reject(e);
      this.waiting = undefined;
    };
    socket.on('error', (e) => fail(new RfbError(`VNC connection error: ${e.message}`)));
    socket.on('close', () => fail(new RfbError('the VNC server closed the connection')));
  }

  private pump(): void {
    const w = this.waiting;
    if (w && this.buf.length >= w.n) {
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      this.waiting = undefined;
      w.resolve(Buffer.from(out));
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiting = { n, resolve, reject };
      this.pump();
    });
  }
}

export class RfbClient {
  width = 0;
  height = 0;
  name = '';
  private fb = Buffer.alloc(0);
  private updates = 0;
  private waiters: Array<() => void> = [];
  private buttons = 0;
  private loopError?: Error;

  private constructor(
    private readonly socket: Socket,
    private readonly reader: Reader,
  ) {}

  static async connect(o: RfbOptions): Promise<RfbClient> {
    const socket = connect({ host: o.host, port: o.port ?? 5900 });
    const reader = new Reader(socket);
    const timeout = o.timeoutMs ?? 15_000;
    const c = new RfbClient(socket, reader);
    const timer = setTimeout(() => socket.destroy(new Error(`VNC handshake with ${o.host}:${o.port ?? 5900} timed out`)), timeout);
    try {
      await c.handshake(o.password);
    } catch (e) {
      socket.destroy();
      throw e instanceof RfbError ? e : new RfbError((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
    void c.loop();
    return c;
  }

  private async handshake(password?: string): Promise<void> {
    const r = this.reader;
    const ver = (await r.read(12)).toString('latin1');
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(ver);
    if (!m) throw new RfbError(`not a VNC server (got ${JSON.stringify(ver)})`);
    const minor = Number(m[1]) > 3 ? 8 : Math.min(8, Number(m[2]));
    const use = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this.socket.write(`RFB 003.00${use}\n`);
    let type: number;
    if (use === 3) {
      type = (await r.read(4)).readUInt32BE(0);
      if (type === 0) throw new RfbError(`VNC server refused the connection: ${await this.reason()}`);
    } else {
      const n = (await r.read(1))[0];
      if (n === 0) throw new RfbError(`VNC server refused the connection: ${await this.reason()}`);
      const types = [...(await r.read(n))];
      type = password !== undefined && types.includes(2) ? 2 : types.includes(1) ? 1 : types.includes(2) ? 2 : -1;
      if (type < 0) throw new RfbError(`no supported VNC security type (server offers ${types.join(', ')}; EZTest supports None and VNC Authentication)`);
      this.socket.write(Buffer.from([type]));
    }
    if (type === 2) {
      if (password === undefined) throw new RfbError('the VNC server requires a password (citrix.sessions.<name>.password)');
      const challenge = await r.read(16);
      this.socket.write(vncAuthResponse(password, challenge));
    }
    if (type === 2 || use === 8) {
      const result = (await r.read(4)).readUInt32BE(0);
      if (result !== 0) throw new RfbError(`VNC authentication failed${use === 8 ? `: ${await this.reason()}` : ''}`);
    }
    this.socket.write(Buffer.from([1])); // ClientInit: shared
    const init = await r.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = (await r.read(init.readUInt32BE(20))).toString('utf8');
    this.fb = Buffer.alloc(this.width * this.height * 4, 0xff);
    // SetPixelFormat: 32 bpp, depth 24, little endian, true colour, R<<16 G<<8 B.
    const pf = Buffer.alloc(20);
    pf[0] = 0;
    pf.writeUInt8(32, 4);
    pf.writeUInt8(24, 5);
    pf.writeUInt8(0, 6);
    pf.writeUInt8(1, 7);
    pf.writeUInt16BE(255, 8);
    pf.writeUInt16BE(255, 10);
    pf.writeUInt16BE(255, 12);
    pf.writeUInt8(16, 14);
    pf.writeUInt8(8, 15);
    pf.writeUInt8(0, 16);
    this.socket.write(pf);
    const encs = [0, 1, -223];
    const se = Buffer.alloc(4 + encs.length * 4);
    se[0] = 2;
    se.writeUInt16BE(encs.length, 2);
    encs.forEach((e, i) => se.writeInt32BE(e, 4 + i * 4));
    this.socket.write(se);
  }

  private async reason(): Promise<string> {
    const n = (await this.reader.read(4)).readUInt32BE(0);
    return (await this.reader.read(n)).toString('utf8');
  }

  private async loop(): Promise<void> {
    const r = this.reader;
    try {
      for (;;) {
        const t = (await r.read(1))[0];
        if (t === 0) {
          const h = await r.read(3);
          const n = h.readUInt16BE(1);
          for (let i = 0; i < n; i++) {
            const rh = await r.read(12);
            const x = rh.readUInt16BE(0);
            const y = rh.readUInt16BE(2);
            const w = rh.readUInt16BE(4);
            const hh = rh.readUInt16BE(6);
            const enc = rh.readInt32BE(8);
            if (enc === 0) this.blit(x, y, w, hh, await r.read(w * hh * 4));
            else if (enc === 1) {
              const src = await r.read(4);
              this.copyRect(src.readUInt16BE(0), src.readUInt16BE(2), x, y, w, hh);
            } else if (enc === -223) {
              this.width = w;
              this.height = hh;
              this.fb = Buffer.alloc(w * hh * 4, 0xff);
            } else throw new RfbError(`VNC server sent unsupported encoding ${enc}`);
          }
          this.updates++;
          for (const w of this.waiters.splice(0)) w();
        } else if (t === 1) {
          const h = await r.read(5);
          await r.read(h.readUInt16BE(3) * 6);
        } else if (t === 2) {
          /* bell */
        } else if (t === 3) {
          const h = await r.read(7);
          await r.read(h.readUInt32BE(3));
        } else throw new RfbError(`unknown VNC server message ${t}`);
      }
    } catch (e) {
      this.loopError = e as Error;
      for (const w of this.waiters.splice(0)) w();
    }
  }

  private blit(x: number, y: number, w: number, h: number, px: Buffer): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const s = (j * w + i) * 4;
        const d = ((y + j) * this.width + (x + i)) * 4;
        if (d + 3 >= this.fb.length) continue;
        // Little-endian 32-bit B,G,R,X -> RGBA
        this.fb[d] = px[s + 2];
        this.fb[d + 1] = px[s + 1];
        this.fb[d + 2] = px[s];
        this.fb[d + 3] = 255;
      }
    }
  }

  private copyRect(sx: number, sy: number, x: number, y: number, w: number, h: number): void {
    const copy = Buffer.alloc(w * h * 4);
    for (let j = 0; j < h; j++) this.fb.copy(copy, j * w * 4, ((sy + j) * this.width + sx) * 4, ((sy + j) * this.width + sx + w) * 4);
    for (let j = 0; j < h; j++) copy.copy(this.fb, ((y + j) * this.width + x) * 4, j * w * 4, (j + 1) * w * 4);
  }

  /** Request a full frame and return it as PNG. */
  async capture(timeoutMs = 10_000): Promise<Buffer> {
    if (this.loopError) throw this.loopError;
    const before = this.updates;
    const req = Buffer.alloc(10);
    req[0] = 3;
    req[1] = 0;
    req.writeUInt16BE(this.width, 6);
    req.writeUInt16BE(this.height, 8);
    this.socket.write(req);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new RfbError(`no VNC frame within ${timeoutMs}ms`)), timeoutMs);
      const check = () => {
        if (this.loopError) {
          clearTimeout(t);
          reject(this.loopError);
        } else if (this.updates > before) {
          clearTimeout(t);
          resolve();
        } else this.waiters.push(check);
      };
      check();
    });
    const png = new PNG({ width: this.width, height: this.height });
    this.fb.copy(png.data, 0, 0, Math.min(this.fb.length, png.data.length));
    return PNG.sync.write(png);
  }

  pointer(x: number, y: number, mask: number): void {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(Math.max(0, Math.round(x)), 2);
    b.writeUInt16BE(Math.max(0, Math.round(y)), 4);
    this.socket.write(b);
  }

  async click(x: number, y: number, o: { button?: 'left' | 'right' | 'middle'; double?: boolean } = {}): Promise<void> {
    const bit = o.button === 'right' ? 4 : o.button === 'middle' ? 2 : 1;
    for (let n = 0; n < (o.double ? 2 : 1); n++) {
      this.pointer(x, y, this.buttons);
      this.pointer(x, y, this.buttons | bit);
      this.pointer(x, y, this.buttons);
    }
  }

  key(keysym: number, down: boolean): void {
    const b = Buffer.alloc(8);
    b[0] = 4;
    b[1] = down ? 1 : 0;
    b.writeUInt32BE(keysym >>> 0, 4);
    this.socket.write(b);
  }

  /** "Ctrl+S", "Enter", "a" -> key events. */
  keys(combo: string): void {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const syms = parts.map((p) => {
      const k = KEYSYMS[p.toUpperCase()];
      if (k !== undefined) return k;
      if (p.length === 1) return p.charCodeAt(0);
      throw new RfbError(`unknown key "${p}"`);
    });
    for (const s of syms) this.key(s, true);
    for (const s of [...syms].reverse()) this.key(s, false);
  }

  type(text: string): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const sym = cp < 0x100 ? cp : 0x01000000 + cp;
      this.key(sym, true);
      this.key(sym, false);
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
