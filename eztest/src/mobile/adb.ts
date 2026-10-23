/**
 * EZTest's own ADB client: the adb server's smart-socket protocol on
 * localhost:5037, written directly over TCP (no adb library, no adb binary
 * per command). Supported services:
 *
 *   host:version, host:devices-l, host:transport:<serial>, shell:<cmd>,
 *   exec:<cmd>, host-serial:<serial>:forward:<local>;<remote>,
 *   host-serial:<serial>:killforward:<local>, and sync: (SEND, RECV, STAT, QUIT)
 *   for push/pull; install = push + `pm install`.
 *
 * Protocol: a request is a 4-hex-digit length followed by the service name;
 * the server answers "OKAY" or "FAIL" + 4-hex length + message. After
 * host:transport the same socket talks to the device; shell/exec streams run
 * until the socket closes. Sync packets are a 4-byte id + little-endian u32.
 */
import { Socket, connect } from 'node:net';
import { EzTestError } from '../core/index.js';

export interface AdbDevice {
  serial: string;
  state: string;
  /** Extra fields from `devices -l` (model, product, device, transport_id). */
  props: Record<string, string>;
}

export interface AdbClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class AdbError extends EzTestError {
  constructor(message: string) {
    super(message, 'ADB');
    this.name = 'AdbError';
  }
}

/** Buffered exact reads over a socket. */
class Reader {
  private chunks: Buffer[] = [];
  private size = 0;
  private ended = false;
  private error?: Error;
  private waiter?: () => void;

  constructor(readonly socket: Socket) {
    socket.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.size += d.length;
      this.wake();
    });
    socket.on('end', () => { this.ended = true; this.wake(); });
    socket.on('close', () => { this.ended = true; this.wake(); });
    socket.on('error', (e) => { this.error = e; this.wake(); });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(n)];
    this.size = all.length - n;
    return all.subarray(0, n);
  }

  async read(n: number): Promise<Buffer> {
    while (this.size < n) {
      if (this.error) throw new AdbError(`adb connection error: ${this.error.message}`);
      if (this.ended) throw new AdbError(`adb connection closed (wanted ${n} bytes, got ${this.size})`);
      await new Promise<void>((r) => { this.waiter = r; });
    }
    return this.take(n);
  }

  /** Everything until the socket closes. */
  async readAll(): Promise<Buffer> {
    while (!this.ended && !this.error) await new Promise<void>((r) => { this.waiter = r; });
    if (this.error && !this.ended) throw new AdbError(`adb connection error: ${this.error.message}`);
    return this.take(this.size);
  }
}

/** One smart-socket connection to the adb server. */
export class AdbConnection {
  readonly reader: Reader;

  private constructor(readonly socket: Socket) {
    this.reader = new Reader(socket);
  }

  static open(host: string, port: number, timeoutMs: number): Promise<AdbConnection> {
    return new Promise((resolve, reject) => {
      const s = connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new AdbError(`cannot reach the adb server at ${host}:${port} (timed out after ${timeoutMs} ms); start it with "adb start-server"`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(new AdbConnection(s));
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(new AdbError(`cannot reach the adb server at ${host}:${port} (${e.message}); start it with "adb start-server"`));
      });
    });
  }

  /** Send a service request: 4 hex digits of length + the service. */
  send(service: string): void {
    const body = Buffer.from(service, 'utf8');
    if (body.length > 0xffff) throw new AdbError('adb request too long');
    this.socket.write(Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]));
  }

  /** Read OKAY, or throw with the FAIL message. */
  async status(service: string): Promise<void> {
    const s = (await this.reader.read(4)).toString('ascii');
    if (s === 'OKAY') return;
    if (s === 'FAIL') throw new AdbError(`adb ${service}: ${await this.readString()}`);
    throw new AdbError(`adb ${service}: unexpected reply "${s}"`);
  }

  /** A 4-hex-length-prefixed string. */
  async readString(): Promise<string> {
    const n = parseInt((await this.reader.read(4)).toString('ascii'), 16);
    if (!Number.isFinite(n)) throw new AdbError('adb: bad length prefix');
    return (await this.reader.read(n)).toString('utf8');
  }

  async request(service: string): Promise<void> {
    this.send(service);
    await this.status(service);
  }

  close(): void {
    this.socket.destroy();
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};
const syncPacket = (id: string, payload: Buffer | number) => (typeof payload === 'number' ? Buffer.concat([Buffer.from(id, 'ascii'), u32(payload)]) : Buffer.concat([Buffer.from(id, 'ascii'), u32(payload.length), payload]));

/** Marker appended to shell commands to recover the exit status over the legacy shell protocol. */
const EXIT_MARK = '__EZTEST_EXIT__';

export interface ShellResult {
  output: string;
  exitCode: number;
}

/** A long-running shell command (e.g. the instrumentation that hosts the agent). */
export interface ShellStream {
  output(): string;
  /** Resolves when the command ends (socket closed). */
  done: Promise<string>;
  kill(): void;
}

export class AdbClient {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;

  constructor(opts: AdbClientOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 5037;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private open(): Promise<AdbConnection> {
    return AdbConnection.open(this.host, this.port, this.timeoutMs);
  }

  /** A connection already switched to a device (host:transport:<serial>). */
  async transport(serial: string): Promise<AdbConnection> {
    const c = await this.open();
    try {
      await c.request(`host:transport:${serial}`);
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }

  /** Server protocol version (host:version). */
  async version(): Promise<number> {
    const c = await this.open();
    try {
      await c.request('host:version');
      return parseInt(await c.readString(), 16);
    } finally {
      c.close();
    }
  }

  /** Attached devices (host:devices-l). */
  async devices(): Promise<AdbDevice[]> {
    const c = await this.open();
    try {
      await c.request('host:devices-l');
      return parseDevices(await c.readString());
    } finally {
      c.close();
    }
  }

  /** Run a shell command and return its output and exit status. */
  async shell(serial: string, command: string): Promise<ShellResult> {
    const c = await this.transport(serial);
    try {
      await c.request(`shell:${command}; echo ${EXIT_MARK}$?`);
      const out = (await c.reader.readAll()).toString('utf8');
      const m = new RegExp(`${EXIT_MARK}(\\d+)\\s*$`).exec(out);
      return m ? { output: out.slice(0, m.index), exitCode: Number(m[1]) } : { output: out, exitCode: -1 };
    } finally {
      c.close();
    }
  }

  /** Run a shell command; throw when it exits non-zero or prints a failure. */
  async shellOk(serial: string, command: string, what = command): Promise<string> {
    const r = await this.shell(serial, command);
    if (r.exitCode !== 0 || /^(?:Error|Failure|Exception)\b/m.test(r.output)) throw new AdbError(`${what} failed on ${serial} (exit ${r.exitCode}): ${r.output.trim().slice(0, 300)}`);
    return r.output;
  }

  /** Binary output of a command (exec:, no tty translation), e.g. `screencap -p`. */
  async exec(serial: string, command: string): Promise<Buffer> {
    const c = await this.transport(serial);
    try {
      await c.request(`exec:${command}`);
      return await c.reader.readAll();
    } finally {
      c.close();
    }
  }

  /** Start a long-running shell command and keep its stream open. */
  async shellStream(serial: string, command: string): Promise<ShellStream> {
    const c = await this.transport(serial);
    await c.request(`shell:${command}`);
    let buf = '';
    c.socket.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
    const done = new Promise<string>((r) => c.socket.once('close', () => r(buf)));
    return { output: () => buf, done, kill: () => c.close() };
  }

  /** Forward a local endpoint to a device endpoint (e.g. tcp:41234 -> tcp:6790 or localabstract:...). */
  async forward(serial: string, local: string, remote: string): Promise<void> {
    const c = await this.open();
    try {
      await c.request(`host-serial:${serial}:forward:${local};${remote}`);
      await c.status('forward');
    } finally {
      c.close();
    }
  }

  async removeForward(serial: string, local: string): Promise<void> {
    const c = await this.open();
    try {
      await c.request(`host-serial:${serial}:killforward:${local}`);
      await c.status('killforward');
    } finally {
      c.close();
    }
  }

  private async sync(serial: string): Promise<AdbConnection> {
    const c = await this.transport(serial);
    await c.request('sync:');
    return c;
  }

  /** Push bytes to a device path (sync SEND / DATA / DONE). */
  async push(serial: string, data: Buffer, remotePath: string, mode = 0o644, mtime = Math.floor(Date.now() / 1000)): Promise<void> {
    const c = await this.sync(serial);
    try {
      c.socket.write(syncPacket('SEND', Buffer.from(`${remotePath},${mode | 0o100000}`, 'utf8')));
      for (let off = 0; off < data.length; off += 64 * 1024) c.socket.write(syncPacket('DATA', data.subarray(off, off + 64 * 1024)));
      c.socket.write(syncPacket('DONE', mtime));
      const id = (await c.reader.read(4)).toString('ascii');
      const n = (await c.reader.read(4)).readUInt32LE(0);
      if (id === 'FAIL') throw new AdbError(`adb push ${remotePath}: ${(await c.reader.read(n)).toString('utf8')}`);
      if (id !== 'OKAY') throw new AdbError(`adb push ${remotePath}: unexpected reply "${id}"`);
      c.socket.write(syncPacket('QUIT', 0));
    } finally {
      c.close();
    }
  }

  /** Pull a device file (sync RECV). */
  async pull(serial: string, remotePath: string): Promise<Buffer> {
    const c = await this.sync(serial);
    try {
      c.socket.write(syncPacket('RECV', Buffer.from(remotePath, 'utf8')));
      const parts: Buffer[] = [];
      for (;;) {
        const id = (await c.reader.read(4)).toString('ascii');
        const n = (await c.reader.read(4)).readUInt32LE(0);
        if (id === 'DATA') parts.push(await c.reader.read(n));
        else if (id === 'DONE') break;
        else if (id === 'FAIL') throw new AdbError(`adb pull ${remotePath}: ${(await c.reader.read(n)).toString('utf8')}`);
        else throw new AdbError(`adb pull ${remotePath}: unexpected reply "${id}"`);
      }
      c.socket.write(syncPacket('QUIT', 0));
      return Buffer.concat(parts);
    } finally {
      c.close();
    }
  }

  /** File mode, size and mtime (sync STAT); mode 0 means the file does not exist. */
  async stat(serial: string, remotePath: string): Promise<{ mode: number; size: number; mtime: number }> {
    const c = await this.sync(serial);
    try {
      c.socket.write(syncPacket('STAT', Buffer.from(remotePath, 'utf8')));
      const id = (await c.reader.read(4)).toString('ascii');
      if (id !== 'STAT') throw new AdbError(`adb stat ${remotePath}: unexpected reply "${id}"`);
      const b = await c.reader.read(12);
      c.socket.write(syncPacket('QUIT', 0));
      return { mode: b.readUInt32LE(0), size: b.readUInt32LE(4), mtime: b.readUInt32LE(8) };
    } finally {
      c.close();
    }
  }

  /** Install an APK: push to /data/local/tmp, `pm install -r -g`, remove the copy. */
  async install(serial: string, apk: Buffer, name = 'eztest-install.apk'): Promise<void> {
    const remote = `/data/local/tmp/${name}`;
    await this.push(serial, apk, remote);
    try {
      const out = await this.shellOk(serial, `pm install -r -g ${shellQuote(remote)}`, 'pm install');
      if (!/Success/.test(out)) throw new AdbError(`pm install ${name} on ${serial}: ${out.trim().slice(0, 300)}`);
    } finally {
      await this.shell(serial, `rm -f ${shellQuote(remote)}`).catch(() => undefined);
    }
  }
}

/** Parse `host:devices-l` output. */
export function parseDevices(text: string): AdbDevice[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const props: Record<string, string> = {};
    for (const kv of rest) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { serial, state, props };
  });
}

/** Quote a value for the device shell (single quotes; never interpolated). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
