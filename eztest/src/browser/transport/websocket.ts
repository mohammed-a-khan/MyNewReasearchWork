/**
 * A small RFC 6455 WebSocket client on node:http / node:https. It serves the
 * driver's protocol connections (CDP over ws://, WebDriver BiDi) and EZTest's
 * WebSocket steps (src/surfaces/ws.ts).
 *
 * Why not Node's global WebSocket: in the Node 22 line we test on, a
 * process stops being able to talk to the browser after its WebSockets have
 * sent about 4096 messages in total (the connection is dropped, code 1006,
 * and every later connection of the process fails the same way) - fatal for
 * a long test run. The global one also cannot send custom handshake headers
 * (Authorization, cookies) or a client certificate.
 *
 * Supported: text and binary messages, fragmentation, ping / pong (answering
 * the server's pings, sending our own and reporting pongs), the closing
 * handshake with code and reason, handshake headers, subprotocols (the
 * server's choice is checked), TLS options (client certificate, extra CA,
 * servername) and an HTTP proxy (CONNECT tunnel). No extensions
 * (permessage-deflate is never offered).
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

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

export interface WebSocketOpenOptions {
  timeoutMs?: number;
  /** Extra handshake headers (Authorization, Cookie, Origin, ...); the handshake's own headers cannot be overridden. */
  headers?: Record<string, string>;
  /** Subprotocols offered (Sec-WebSocket-Protocol); the server must pick one of them when any are offered. */
  protocols?: string[];
  /** TLS for wss:// (client certificate, extra CA, servername). Server certificates are always verified. */
  tls?: Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'pfx' | 'passphrase' | 'servername'>;
  /**
   * An already-open socket to the server (e.g. a tunnel through a proxy); the handshake (and, for
   * wss://, TLS) runs over it.
   */
  tunnel?: () => Promise<Socket>;
  /** Largest message accepted (default 64 MiB); a larger one closes the connection with 1009. */
  maxMessageBytes?: number;
}

export class SimpleWebSocket {
  private onmessage_?: (text: string) => void;
  private onbinary_?: (data: Buffer) => void;
  /** Messages that arrived before any handler was set (e.g. sent by the server with its 101 response). */
  private early: Array<{ binary: boolean; data: Buffer }> = [];

  /** Text messages (and, when onbinary is not set, binary ones decoded as UTF-8). */
  get onmessage(): ((text: string) => void) | undefined {
    return this.onmessage_;
  }
  set onmessage(f: ((text: string) => void) | undefined) {
    this.onmessage_ = f;
    this.flushEarly();
  }
  /** Binary messages, when set. */
  get onbinary(): ((data: Buffer) => void) | undefined {
    return this.onbinary_;
  }
  set onbinary(f: ((data: Buffer) => void) | undefined) {
    this.onbinary_ = f;
    this.flushEarly();
  }

  /** Deliver early messages once the caller had the chance to set both handlers. */
  private flushEarly(): void {
    if (!this.early.length) return;
    queueMicrotask(() => {
      for (const m of this.early.splice(0)) this.deliver(m.binary, m.data);
    });
  }

  private deliver(binary: boolean, data: Buffer): void {
    if (!this.onmessage_ && !this.onbinary_) {
      this.early.push({ binary, data });
      return;
    }
    try {
      if (binary && this.onbinary_) this.onbinary_(data);
      else this.onmessage_?.(data.toString('utf8'));
    } catch (e) {
      process.nextTick(() => {
        throw e;
      });
    }
  }
  /** Pong frames (the payload of the ping they answer). */
  onpong?: (payload: Buffer) => void;
  onclose?: (reason: string) => void;
  /** The subprotocol the server chose ('' when none). */
  protocol = '';
  /** The server's handshake response headers. */
  responseHeaders: Record<string, string | string[] | undefined> = {};
  /** Close code and reason (from the server's close frame, or 1006 when the connection just dropped). */
  closeCode?: number;
  closeReason = '';
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0x1;
  private fragmentBytes = 0;
  private closed = false;
  private maxMessageBytes = 64 * 1024 * 1024;

  /** See eagerAck(). */
  private ackScheduled = false;
  private eagerAck_ = false;

  private constructor(private readonly socket: Duplex, head: Buffer) {
    socket.on('data', (d: Buffer) => {
      this.receive(d);
      if (this.eagerAck_) this.scheduleAck();
    });
    socket.on('close', () => {
      this.closeCode ??= 1006;
      this.finish('websocket closed');
    });
    socket.on('error', (e: Error) => {
      this.closeCode ??= 1006;
      this.finish(`websocket error: ${e.message}`);
    });
    // Frames the server sent with its 101 response; messages among them wait for a handler.
    if (head.length) this.receive(head);
  }

  /**
   * Open a connection to a ws:// or wss:// URL. `headers` go on the handshake request (e.g. an
   * Authorization header for a remote browser endpoint); the handshake's own headers cannot be overridden.
   */
  static connect(url: string, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<SimpleWebSocket> {
    return SimpleWebSocket.open(url, { timeoutMs, headers });
  }

  /** Open a connection with handshake headers, subprotocols, TLS options or a tunnel. */
  static open(url: string, o: WebSocketOpenOptions = {}): Promise<SimpleWebSocket> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new Error(`Not a WebSocket URL: ${url}`));
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return Promise.reject(new Error(`Not a WebSocket URL: ${url}`));
    const secure = u.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const headers = o.headers ?? {};
    const timeoutMs = o.timeoutMs ?? 30_000;
    const protocols = (o.protocols ?? []).map((p) => p.trim()).filter(Boolean);
    for (const p of protocols) if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p)) return Promise.reject(new Error(`Invalid WebSocket subprotocol "${p}"`));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port || (secure ? 443 : 80));
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined;
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req?.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${redactUrl(url)}`)), timeoutMs);
      const start = (conn?: Duplex) => {
        const reqHeaders: Record<string, string> = {
          ...Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(?:connection|upgrade|sec-websocket-(?:version|key|extensions)|host)$/i.test(k) && !(protocols.length && /^sec-websocket-protocol$/i.test(k)))),
          // Credentials in the URL (wss://user:pass@host) become HTTP basic authentication.
          ...(u.username && !Object.keys(headers).some((k) => /^authorization$/i.test(k)) ? { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` } : {}),
          ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
          Host: u.host, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        };
        const request = secure ? httpsRequest : httpRequest;
        req = request({
          host, port, path: `${u.pathname || '/'}${u.search}`, headers: reqHeaders, agent: false,
          ...(secure ? { servername: o.tls?.servername ?? (isIP(host) ? undefined : host), ...(o.tls ?? {}) } : {}),
          ...(conn ? { createConnection: () => conn as Socket } : {}),
        });
        req.on('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (done) {
            socket.destroy();
            return;
          }
          const expected = createHash('sha1').update(key + GUID).digest('base64');
          if (res.headers['sec-websocket-accept'] !== expected) {
            socket.destroy();
            fail(new Error(`WebSocket handshake with ${redactUrl(url)} failed (bad Sec-WebSocket-Accept)`));
            return;
          }
          const chosen = String(res.headers['sec-websocket-protocol'] ?? '');
          if (chosen && !protocols.includes(chosen)) {
            socket.destroy();
            fail(new Error(`WebSocket server ${redactUrl(url)} chose subprotocol "${chosen}", which was not offered`));
            return;
          }
          if (protocols.length && !chosen) {
            socket.destroy();
            fail(new Error(`WebSocket server ${redactUrl(url)} accepted none of the subprotocols ${protocols.join(', ')}`));
            return;
          }
          if (res.headers['sec-websocket-extensions']) {
            socket.destroy();
            fail(new Error(`WebSocket server ${redactUrl(url)} enabled extensions that were not offered (${String(res.headers['sec-websocket-extensions'])})`));
            return;
          }
          done = true;
          clearTimeout(timer);
          (socket as Duplex & { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true);
          const ws = new SimpleWebSocket(socket, head);
          ws.protocol = chosen;
          ws.responseHeaders = res.headers;
          if (o.maxMessageBytes) ws.maxMessageBytes = o.maxMessageBytes;
          resolve(ws);
        });
        req.on('response', (res: IncomingMessage) => {
          res.resume();
          const reason = res.statusCode === 401 || res.statusCode === 403 ? ' (the server refused the credentials: check the Authorization header or cookie)' : '';
          fail(Object.assign(new Error(`Could not connect to ${redactUrl(url)}: HTTP ${res.statusCode}${reason}`), { status: res.statusCode }));
        });
        req.on('error', (e) => fail(new Error(`Could not connect to ${redactUrl(url)}: ${e.message}`)));
        req.end();
      };
      if (!o.tunnel) {
        start();
        return;
      }
      o.tunnel().then((raw) => {
        if (!secure) return start(raw);
        // TLS to the server inside the tunnel; the server certificate is verified as usual.
        const t = tlsConnect({ socket: raw, servername: o.tls?.servername ?? (isIP(host) ? undefined : host), ALPNProtocols: ['http/1.1'], ...(o.tls ?? {}) });
        t.once('secureConnect', () => start(t));
        t.once('error', (e) => fail(new Error(`TLS to ${u.host} through the proxy failed: ${e.message}`)));
      }, (e: Error) => fail(e));
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

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Send a text message. */
  send(text: string): void {
    if (this.closed) return;
    this.socket.write(SimpleWebSocket.frame(0x1, Buffer.from(text, 'utf8')));
  }

  /** Send a binary message. */
  sendBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.write(SimpleWebSocket.frame(0x2, Buffer.from(data)));
  }

  /** Send a ping (control frames carry at most 125 bytes). */
  ping(payload: Uint8Array = Buffer.alloc(0)): void {
    if (this.closed) return;
    if (payload.length > 125) throw new Error('A WebSocket ping payload is at most 125 bytes');
    this.socket.write(SimpleWebSocket.frame(0x9, Buffer.from(payload)));
  }

  /** Start the closing handshake (and drop the connection shortly after). */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 123);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    try {
      this.socket.write(SimpleWebSocket.frame(0x8, body));
    } catch {
      /* already gone */
    }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.closeCode ??= code;
    this.closeReason ||= reason;
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
      if (len > this.maxMessageBytes) {
        this.protocolError(1009, 'message too big');
        return;
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

  private protocolError(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.close(code, reason);
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.closeCode = code;
      this.closeReason = reason;
      try {
        this.socket.write(SimpleWebSocket.frame(0x8, payload.subarray(0, 2)));
      } catch {
        /* ignore */
      }
      this.socket.end();
      this.finish(`websocket closed (code ${code}${reason ? `: ${reason}` : ''})`);
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(SimpleWebSocket.frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) {
      this.onpong?.(Buffer.from(payload));
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [Buffer.from(payload)];
      this.fragmentOpcode = opcode;
      this.fragmentBytes = payload.length;
    } else if (opcode === 0x0) {
      this.fragments.push(Buffer.from(payload));
      this.fragmentBytes += payload.length;
    } else return;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.protocolError(1009, 'message too big');
      return;
    }
    if (!fin) return;
    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.deliver(this.fragmentOpcode === 0x2, data);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
  }
}
