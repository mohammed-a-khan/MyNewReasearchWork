/**
 * A fake adb server speaking the adb smart-socket protocol on a local port,
 * for byte-level tests of EZTest's ADB client and as the "device" side of the
 * mobile e2e tests. It records every raw byte received; port forwards are real
 * TCP proxies to configurable targets (so the agent simulator and a DevTools
 * endpoint can be reached through `adb forward`, as on a real device).
 */
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface FakeDevice {
  serial: string;
  state: string;
  props?: string;
}

export type ShellReply = string | { output: string; exit?: number } | { stream: true; output?: string };

export class FakeAdbServer {
  devices: FakeDevice[] = [{ serial: 'emulator-5554', state: 'device', props: 'product:sdk_gphone64 model:Pixel_8 device:emu64a transport_id:1' }];
  /** Shell handler: command -> reply. Default: empty output, exit 0. */
  shell: (serial: string, cmd: string) => ShellReply = () => '';
  /** Forward remote endpoints ("tcp:6790", "localabstract:x", or per device "<serial>|tcp:6790") to local ports. */
  targets = new Map<string, number>();
  /** Files on the device (sync). */
  readonly files = new Map<string, { data: Buffer; mode: number; mtime: number }>();
  /** Raw bytes received per connection. */
  readonly connections: Buffer[] = [];
  /** Service requests in order (e.g. "host:transport:emulator-5554", "shell:..."). */
  readonly services: string[] = [];
  readonly forwards = new Map<string, { serial: string; remote: string; server: Server }>();
  readonly streams: Socket[] = [];
  private server?: Server;
  port = 0;

  async start(): Promise<number> {
    this.server = createServer((s) => this.handle(s));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.destroy();
    for (const f of this.forwards.values()) f.server.close();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private handle(s: Socket): void {
    const idx = this.connections.push(Buffer.alloc(0)) - 1;
    let buf = Buffer.alloc(0);
    let serial: string | undefined;
    let mode: 'smart' | 'sync' | 'done' = 'smart';
    let syncSend: { path: string; mode: number; chunks: Buffer[] } | undefined;
    const okay = () => s.write('OKAY');
    const fail = (msg: string) => s.write(`FAIL${Buffer.byteLength(msg).toString(16).padStart(4, '0')}${msg}`);
    const str = (v: string) => `${Buffer.byteLength(v).toString(16).padStart(4, '0')}${v}`;
    s.on('error', () => undefined);
    s.on('data', (d: Buffer) => {
      this.connections[idx] = Buffer.concat([this.connections[idx], d]);
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (mode === 'smart') {
          if (buf.length < 4) return;
          const n = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
          if (buf.length < 4 + n) return;
          const svc = buf.subarray(4, 4 + n).toString('utf8');
          buf = buf.subarray(4 + n);
          this.services.push(svc);
          let m: RegExpExecArray | null;
          if (svc === 'host:version') { okay(); s.write(str('0029')); s.end(); mode = 'done'; }
          else if (svc === 'host:devices-l' || svc === 'host:devices') {
            okay();
            s.write(str(this.devices.map((dv) => `${dv.serial.padEnd(22)} ${dv.state}${dv.props ? ` ${dv.props}` : ''}\n`).join('')));
            s.end();
            mode = 'done';
          } else if ((m = /^host:transport:(.+)$/.exec(svc))) {
            const dv = this.devices.find((x) => x.serial === m![1]);
            if (!dv) { fail(`device '${m[1]}' not found`); s.end(); mode = 'done'; } else { serial = dv.serial; okay(); }
          } else if ((m = /^host-serial:([^:]+):forward:(tcp:\d+);(.+)$/.exec(svc))) {
            const [, ser, local, remote] = m;
            const target = this.targets.get(`${ser}|${remote}`) ?? this.targets.get(remote);
            if (target === undefined) { fail(`cannot bind to ${remote}`); s.end(); mode = 'done'; continue; }
            const port = Number(local.slice(4));
            const fwd = createServer((c) => {
              const up = connect({ host: '127.0.0.1', port: target });
              c.pipe(up);
              up.pipe(c);
              c.on('error', () => up.destroy());
              up.on('error', () => c.destroy());
            });
            fwd.listen(port, '127.0.0.1', () => {
              this.forwards.set(local, { serial: ser, remote, server: fwd });
              okay();
              okay();
              s.end();
            });
            mode = 'done';
          } else if ((m = /^host-serial:([^:]+):killforward:(tcp:\d+)$/.exec(svc))) {
            const f = this.forwards.get(m[2]);
            if (!f) { fail(`listener '${m[2]}' not found`); s.end(); mode = 'done'; continue; }
            f.server.close();
            this.forwards.delete(m[2]);
            okay();
            okay();
            s.end();
            mode = 'done';
          } else if ((m = /^(shell|exec):(.*)$/s.exec(svc)) && serial) {
            okay();
            const raw = m[2];
            const marker = /; echo __EZTEST_EXIT__\$\?$/.exec(raw);
            const cmd = marker ? raw.slice(0, marker.index) : raw;
            const r = this.shell(serial, cmd);
            if (typeof r === 'object' && 'stream' in r) {
              if (r.output) s.write(r.output);
              this.streams.push(s);
              mode = 'done';
              return;
            }
            const out = typeof r === 'string' ? r : r.output;
            const exit = typeof r === 'string' ? 0 : (r.exit ?? 0);
            s.end(marker ? `${out}__EZTEST_EXIT__${exit}\n` : out);
            mode = 'done';
          } else if (svc === 'sync:' && serial) { okay(); mode = 'sync'; }
          else { fail(`unknown service ${svc}`); s.end(); mode = 'done'; }
        } else if (mode === 'sync') {
          if (buf.length < 8) return;
          const id = buf.subarray(0, 4).toString('ascii');
          const n = buf.readUInt32LE(4);
          const needsBody = id === 'SEND' || id === 'RECV' || id === 'STAT' || id === 'DATA';
          if (needsBody && buf.length < 8 + n) return;
          const body = needsBody ? buf.subarray(8, 8 + n) : Buffer.alloc(0);
          buf = buf.subarray(needsBody ? 8 + n : 8);
          const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
          if (id === 'SEND') {
            const spec = body.toString('utf8');
            const comma = spec.lastIndexOf(',');
            syncSend = { path: spec.slice(0, comma), mode: Number(spec.slice(comma + 1)), chunks: [] };
          } else if (id === 'DATA') syncSend?.chunks.push(Buffer.from(body));
          else if (id === 'DONE') {
            if (syncSend) {
              if (syncSend.path.startsWith('/readonly/')) s.write(Buffer.concat([Buffer.from('FAIL'), u32(18), Buffer.from('Read-only file sys')]));
              else {
                this.files.set(syncSend.path, { data: Buffer.concat(syncSend.chunks), mode: syncSend.mode, mtime: n });
                s.write(Buffer.concat([Buffer.from('OKAY'), u32(0)]));
              }
            }
            syncSend = undefined;
          } else if (id === 'RECV') {
            const f = this.files.get(body.toString('utf8'));
            if (!f) {
              const msg = 'No such file or directory';
              s.write(Buffer.concat([Buffer.from('FAIL'), u32(msg.length), Buffer.from(msg)]));
            } else {
              for (let off = 0; off < f.data.length; off += 65536) {
                const c = f.data.subarray(off, off + 65536);
                s.write(Buffer.concat([Buffer.from('DATA'), u32(c.length), c]));
              }
              s.write(Buffer.concat([Buffer.from('DONE'), u32(0)]));
            }
          } else if (id === 'STAT') {
            const f = this.files.get(body.toString('utf8'));
            s.write(Buffer.concat([Buffer.from('STAT'), u32(f ? f.mode : 0), u32(f ? f.data.length : 0), u32(f ? f.mtime : 0)]));
          } else if (id === 'QUIT') { s.end(); mode = 'done'; }
        } else return;
      }
    });
  }
}
