/**
 * A small RFB 3.8 server for tests: serves a PNG as the framebuffer (Raw
 * encoding), offers VNC Authentication, and records pointer and key events.
 * A protocol fixture written for EZTest's tests (not a real remote desktop).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { PNG } from 'pngjs';
import { vncAuthResponse } from '../../../src/desktop/index.js';

export class RfbTestServer {
  private server?: Server;
  readonly pointer: Array<{ x: number; y: number; mask: number }> = [];
  readonly keys: Array<{ keysym: number; down: boolean }> = [];
  private png: PNG;
  port = 0;

  constructor(pngPath: string, readonly password?: string) {
    this.png = PNG.sync.read(readFileSync(pngPath));
  }

  /** Clicks (button-down positions). */
  get clicks(): Array<{ x: number; y: number }> {
    return this.pointer.filter((p, i) => p.mask & 1 && !((this.pointer[i - 1]?.mask ?? 0) & 1)).map(({ x, y }) => ({ x, y }));
  }

  async start(): Promise<number> {
    this.server = createServer((s) => void this.serve(s).catch(() => s.destroy()));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server!.address() as AddressInfo).port;
    return this.port;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()) ?? r());
  }

  private async serve(s: Socket): Promise<void> {
    let buf = Buffer.alloc(0);
    let wake: (() => void) | undefined;
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      wake?.();
    });
    s.on('error', () => undefined);
    const read = async (n: number): Promise<Buffer> => {
      while (buf.length < n) {
        if (s.destroyed) throw new Error('closed');
        await new Promise<void>((r) => {
          wake = r;
          s.once('close', r);
        });
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return Buffer.from(out);
    };
    s.write('RFB 003.008\n');
    await read(12);
    s.write(Buffer.from([1, this.password ? 2 : 1]));
    const type = (await read(1))[0];
    if (type === 2) {
      const challenge = randomBytes(16);
      s.write(challenge);
      const resp = await read(16);
      const ok = this.password !== undefined && vncAuthResponse(this.password, challenge).equals(resp);
      const res = Buffer.alloc(4);
      res.writeUInt32BE(ok ? 0 : 1);
      s.write(res);
      if (!ok) {
        const msg = Buffer.from('Authentication failed');
        const len = Buffer.alloc(4);
        len.writeUInt32BE(msg.length);
        s.write(Buffer.concat([len, msg]));
        s.end();
        return;
      }
    } else s.write(Buffer.from([0, 0, 0, 0]));
    await read(1); // ClientInit
    const name = Buffer.from('ez-test-desktop');
    const init = Buffer.alloc(24);
    init.writeUInt16BE(this.png.width, 0);
    init.writeUInt16BE(this.png.height, 2);
    // Server pixel format (the client sets its own).
    init[4] = 32;
    init[5] = 24;
    init[7] = 1;
    init.writeUInt16BE(255, 8);
    init.writeUInt16BE(255, 10);
    init.writeUInt16BE(255, 12);
    init[14] = 16;
    init[15] = 8;
    init.writeUInt32BE(name.length, 20);
    s.write(Buffer.concat([init, name]));
    for (;;) {
      const t = (await read(1))[0];
      if (t === 0) await read(19);
      else if (t === 2) {
        const h = await read(3);
        await read(h.readUInt16BE(1) * 4);
      } else if (t === 3) {
        await read(9);
        const { width: w, height: h, data } = this.png;
        const head = Buffer.alloc(4 + 12);
        head[0] = 0;
        head.writeUInt16BE(1, 2);
        head.writeUInt16BE(w, 8);
        head.writeUInt16BE(h, 10);
        head.writeInt32BE(0, 12);
        const px = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          px[i * 4] = data[i * 4 + 2];
          px[i * 4 + 1] = data[i * 4 + 1];
          px[i * 4 + 2] = data[i * 4];
        }
        s.write(Buffer.concat([head, px]));
      } else if (t === 4) {
        const k = await read(7);
        this.keys.push({ down: k[0] === 1, keysym: k.readUInt32BE(3) });
      } else if (t === 5) {
        const p = await read(5);
        this.pointer.push({ mask: p[0], x: p.readUInt16BE(1), y: p.readUInt16BE(3) });
      } else if (t === 6) {
        const h = await read(7);
        await read(h.readUInt32BE(3));
      } else throw new Error(`unexpected client message ${t}`);
    }
  }
}
