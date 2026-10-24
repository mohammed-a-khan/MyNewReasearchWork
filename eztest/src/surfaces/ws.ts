/**
 * WebSocket client for steps, the SDK and load tests, on EZTest's own RFC 6455
 * client (src/browser/transport/websocket.ts): handshake headers
 * (Authorization, cookies, Origin), subprotocols, client certificates and an
 * extra CA for wss://, the HTTP proxy of the environment (HTTPS_PROXY /
 * NO_PROXY) or an explicit one, binary messages and ping / pong (a keep-alive
 * that also notices a dead connection).
 */
import { EzTestError } from '../core/index.js';
import { SimpleWebSocket } from '../browser/transport/websocket.js';
import { envProxyFor, openProxyTunnel, type ProxySettings, type TargetTls } from './proxy.js';

export interface WsMessage {
  data: string | Uint8Array;
  text: string;
  /** True for a binary message. */
  binary: boolean;
  receivedAt: number;
  /** Parsed JSON, or undefined if the message is not JSON. */
  json(): unknown;
}

export interface WsConnectOptions {
  protocols?: string | string[];
  timeoutMs?: number;
  /** Handshake headers: Authorization, Cookie, Origin, custom ones. */
  headers?: Record<string, string>;
  /** Client certificate / extra CA / servername for wss:// (verification stays on). */
  tls?: TargetTls & { servername?: string };
  /** An HTTP proxy; default: HTTPS_PROXY / HTTP_PROXY / NO_PROXY of the environment; false for none. */
  proxy?: ProxySettings | false;
  /** Send a ping this often and close the connection (code 1006) when no pong comes back within two intervals. */
  pingIntervalMs?: number;
}

type Waiter = { pred: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

function message(data: string | Uint8Array): WsMessage {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  return {
    data,
    text,
    binary: typeof data !== 'string',
    receivedAt: Date.now(),
    json() {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
  };
}

export class WsClient {
  /** Every message received, in order. */
  readonly messages: WsMessage[] = [];
  /** Round-trip times of answered pings (ms). */
  readonly pingRoundTrips: number[] = [];
  private consumed = new Set<WsMessage>();
  private waiters: Waiter[] = [];
  private closed = false;
  private closeWaiters: Array<() => void> = [];
  private pingTimer?: ReturnType<typeof setInterval>;
  private pendingPings = new Map<string, number>();
  closeInfo?: { code: number; reason: string };

  private constructor(private readonly ws: SimpleWebSocket, private readonly url: string, pingIntervalMs?: number) {
    ws.onmessage = (text) => this.onMessage(text);
    ws.onbinary = (data) => this.onMessage(new Uint8Array(data));
    ws.onpong = (payload) => {
      const sent = this.pendingPings.get(payload.toString('hex'));
      if (sent !== undefined) {
        this.pendingPings.delete(payload.toString('hex'));
        this.pingRoundTrips.push(Date.now() - sent);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.closeInfo = { code: ws.closeCode ?? 1006, reason: ws.closeReason };
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new EzTestError(`WebSocket closed (code ${this.closeInfo.code}${this.closeInfo.reason ? `: ${this.closeInfo.reason}` : ''}) before a matching message arrived`, 'WS_CLOSED'));
      }
      for (const r of this.closeWaiters.splice(0)) r();
    };
    if (pingIntervalMs && pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        const now = Date.now();
        // Two unanswered intervals: the connection is dead.
        if ([...this.pendingPings.values()].some((t) => now - t > pingIntervalMs * 2)) {
          this.ws.close(1006, 'no pong from the server');
          return;
        }
        this.ping();
      }, pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }

  static async connect(url: string, o: WsConnectOptions = {}): Promise<WsClient> {
    const timeoutMs = o.timeoutMs ?? 10_000;
    const u = new URL(url);
    const httpish = new URL(url.replace(/^ws/i, 'http'));
    let proxy: ProxySettings | undefined;
    if (o.proxy === false) proxy = undefined;
    else if (o.proxy) proxy = o.proxy;
    else {
      try {
        proxy = envProxyFor(httpish);
      } catch {
        proxy = undefined;
      }
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    try {
      const ws = await SimpleWebSocket.open(url, {
        timeoutMs,
        headers: o.headers,
        protocols: typeof o.protocols === 'string' ? [o.protocols] : o.protocols,
        tls: o.tls,
        ...(proxy ? { tunnel: () => openProxyTunnel(proxy!, host, port) } : {}),
      });
      return new WsClient(ws, url, o.pingIntervalMs);
    } catch (e) {
      const msg = (e as Error).message;
      throw new EzTestError(/Timed out/.test(msg) ? `WebSocket connect to ${url.replace(/\?.*$/, '')} timed out after ${timeoutMs}ms` : `WebSocket connect failed: ${msg}`, /Timed out/.test(msg) ? 'WS_TIMEOUT' : 'WS_CONNECT', (e as { status?: number }).status ? { status: (e as { status?: number }).status } : undefined);
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.isOpen;
  }

  /** The subprotocol the server chose ('' when none). */
  get protocol(): string {
    return this.ws.protocol;
  }

  /** The handshake response headers. */
  get responseHeaders(): Record<string, string | string[] | undefined> {
    return this.ws.responseHeaders;
  }

  send(data: string | Uint8Array | object): void {
    if (!this.isOpen) throw new EzTestError('WebSocket is not open', 'WS_NOT_OPEN');
    if (typeof data === 'string') this.ws.send(data);
    else if (data instanceof Uint8Array) this.ws.sendBinary(data);
    else this.ws.send(JSON.stringify(data));
  }

  /** Send a ping; its round trip is recorded in pingRoundTrips when the pong comes back. */
  ping(): void {
    if (!this.isOpen) return;
    const id = Buffer.from(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.pendingPings.set(id.toString('hex'), Date.now());
    this.ws.ping(id);
  }

  /**
   * Resolve with the first not-yet-consumed message (already received or future) that matches.
   * A matched message is consumed so successive waits see successive messages.
   */
  waitForMessage(predicate: (m: WsMessage) => boolean = () => true, timeoutMs = 5000): Promise<WsMessage> {
    for (const m of this.messages) {
      if (!this.consumed.has(m) && safePred(predicate, m)) {
        this.consumed.add(m);
        return Promise.resolve(m);
      }
    }
    if (this.closed) return Promise.reject(new EzTestError('WebSocket is closed', 'WS_CLOSED'));
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        pred: predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new EzTestError(`No matching WebSocket message within ${timeoutMs}ms (${this.messages.length} received)`, 'WS_TIMEOUT'));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  close(code = 1000, reason = ''): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.closeWaiters.push(resolve);
      this.ws.close(code, reason);
    });
  }

  private onMessage(data: string | Uint8Array): void {
    const msg = message(data);
    this.messages.push(msg);
    for (const w of this.waiters) {
      if (safePred(w.pred, msg)) {
        this.consumed.add(msg);
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(msg);
        return;
      }
    }
  }

  toString(): string {
    return `WsClient(${this.url.replace(/\?.*$/, '')})`;
  }
}

function safePred(p: (m: WsMessage) => boolean, m: WsMessage): boolean {
  try {
    return Boolean(p(m));
  } catch {
    return false;
  }
}
