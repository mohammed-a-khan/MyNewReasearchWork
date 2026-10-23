/**
 * A small RFC 6455 WebSocket client on node:http / node:https, for the
 * driver's protocol connections (CDP over ws://, WebDriver BiDi).
 *
 * Why not Node's global WebSocket: in the Node 22 line we test on, a
 * process stops being able to talk to the browser after its WebSockets have
 * sent about 4096 messages in total (the connection is dropped, code 1006,
 * and every later connection of the process fails the same way) - fatal for
 * a long test run. This client only does what the driver needs: text
 * messages (binary ones are decoded as UTF-8), fragmentation, ping / pong
 * and the closing handshake; no extensions.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A URL for messages: user info and query values (tokens of remote endpoints) are hidden. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '****';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '****');
    return u.toString();
  } catch {
    return url;
  }
}

export class SimpleWebSocket {
  onmessage?: (text: string) => void;
  onclose?: (reason: string) => void;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;

  /** See eagerAck(). */
  private ackScheduled = false;
  private eagerAck_ = false;

  private constructor(private readonly socket: Duplex, head: Buffer) {
    socket.on('data', (d: Buffer) => {
      this.receive(d);
      if (this.eagerAck_) this.scheduleAck();
    });
    socket.on('close', () => this.finish('websocket closed'));
    socket.on('error', (e: Error) => this.finish(`websocket error: ${e.message}`));
    if (head.length) queueMicrotask(() => this.receive(head));
  }

  /**
   * Open a connection to a ws:// or wss:// URL. `headers` go on the handshake request (e.g. an
   * Authorization header for a remote browser endpoint); the handshake's own headers cannot be overridden.
   */
  static connect(url: string, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<SimpleWebSocket> {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return Promise.reject(new Error(`Not a WebSocket URL: ${url}`));
    const key = randomBytes(16).toString('base64');
    const request = u.protocol === 'wss:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request({
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: Number(u.port || (u.protocol === 'wss:' ? 443 : 80)),
        path: `${u.pathname || '/'}${u.search}`,
        headers: {
          ...Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(?:connection|upgrade|sec-websocket-(?:version|key))$/i.test(k))),
          // Credentials in the URL (wss://user:pass@host) become HTTP basic authentication.
          ...(u.username && !Object.keys(headers).some((k) => /^authorization$/i.test(k)) ? { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` } : {}),
          Host: u.host, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        },
        agent: false,
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Timed out connecting to ${redactUrl(url)}`));
      }, timeoutMs);
      req.on('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
        clearTimeout(timer);
        const expected = createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          reject(new Error(`WebSocket handshake with ${redactUrl(url)} failed (bad Sec-WebSocket-Accept)`));
          return;
        }
        (socket as Duplex & { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true);
        resolve(new SimpleWebSocket(socket, head));
      });
      req.on('response', (res: IncomingMessage) => {
        clearTimeout(timer);
        res.resume();
        reject(new Error(`Could not connect to ${redactUrl(url)}: HTTP ${res.statusCode}`));
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${redactUrl(url)}: ${e.message}`));
      });
      req.end();
    });
  }

  /**
   * Acknowledge received data at once, with an unsolicited Pong frame (RFC 6455 5.5.3: a
   * unidirectional heartbeat, no reply expected) that carries the TCP ACK.
   *
   * Why: a server that writes several small messages in a row with Nagle's algorithm on
   * (Firefox's remote agent does: an event then a response, or two responses) holds the second
   * one until the first is acknowledged, and Linux delays a pure ACK by up to 40 ms. Every
   * WebDriver BiDi command that overlapped another one, or followed an event, cost ~40 ms.
   * Sending data makes the kernel acknowledge immediately. One pong per batch of incoming data
   * (coalesced per event-loop turn).
   */
  eagerAck(on = true): void {
    this.eagerAck_ = on;
  }

  private scheduleAck(): void {
    if (this.ackScheduled || this.closed) return;
    this.ackScheduled = true;
    setImmediate(() => {
      this.ackScheduled = false;
      if (this.closed) return;
      try {
        this.socket.write(SimpleWebSocket.frame(0xa, Buffer.alloc(0)));
      } catch {
        /* closing */
      }
    });
  }

  /** Send a text message. */
  send(text: string): void {
    if (this.closed) return;
    this.socket.write(SimpleWebSocket.frame(0x1, Buffer.from(text, 'utf8')));
  }

  /** Start the closing handshake (and drop the connection shortly after). */
  close(): void {
    if (this.closed) return;
    try {
      this.socket.write(SimpleWebSocket.frame(0x8, Buffer.from([0x03, 0xe8])));
    } catch {
      /* already gone */
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish('closed by client');
  }

  /** A client frame: FIN set, masked with a fresh random key. */
  static frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    const headerLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const out = Buffer.allocUnsafe(headerLen + 4 + len);
    out[0] = 0x80 | opcode;
    if (len < 126) out[1] = 0x80 | len;
    else if (len < 65536) {
      out[1] = 0x80 | 126;
      out.writeUInt16BE(len, 2);
    } else {
      out[1] = 0x80 | 127;
      out.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    mask.copy(out, headerLen);
    const body = headerLen + 4;
    for (let i = 0; i < len; i++) out[body + i] = payload[i] ^ mask[i & 3];
    return out;
  }

  private receive(data: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (masked) {
        const m = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + len);
      this.onFrame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
      if (this.closed) return;
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      try {
        this.socket.write(SimpleWebSocket.frame(0x8, payload.subarray(0, 2)));
      } catch {
        /* ignore */
      }
      this.socket.end();
      this.finish(`websocket closed (code ${code}${payload.length > 2 ? `: ${payload.subarray(2).toString('utf8')}` : ''})`);
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(SimpleWebSocket.frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) this.fragments = [Buffer.from(payload)];
    else if (opcode === 0x0) this.fragments.push(Buffer.from(payload));
    else return;
    if (!fin) return;
    const text = (this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments)).toString('utf8');
    this.fragments = [];
    try {
      this.onmessage?.(text);
    } catch (e) {
      process.nextTick(() => {
        throw e;
      });
    }
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
  }
}
