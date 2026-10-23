/** WebSocket client wrapper on the global WebSocket (Node 22+). */
import { EzTestError } from '../core/index.js';

export interface WsMessage {
  data: string | Uint8Array;
  text: string;
  receivedAt: number;
  /** Parsed JSON, or undefined if the message is not JSON. */
  json(): unknown;
}

export interface WsConnectOptions {
  protocols?: string | string[];
  timeoutMs?: number;
  /** Injectable for tests or other runtimes. */
  WebSocketImpl?: typeof WebSocket;
}

type Waiter = { pred: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class WsClient {
  /** Every message received, in order. */
  readonly messages: WsMessage[] = [];
  private consumed = new Set<WsMessage>();
  private waiters: Waiter[] = [];
  private closed = false;
  closeInfo?: { code: number; reason: string };

  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data));
    ws.addEventListener('close', (ev: CloseEvent) => {
      this.closed = true;
      this.closeInfo = { code: ev.code, reason: ev.reason };
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new EzTestError(`WebSocket closed (code ${ev.code}) before a matching message arrived`, 'WS_CLOSED'));
      }
    });
  }

  static connect(url: string, o: WsConnectOptions = {}): Promise<WsClient> {
    const Impl = o.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) throw new EzTestError('No WebSocket implementation available (Node 22+ required)', 'WS_UNAVAILABLE');
    const ws = new Impl(url, o.protocols);
    const client = new WsClient(ws);
    const timeoutMs = o.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* closing a half-open socket can throw; the timeout error below is what matters */
        }
        reject(new EzTestError(`WebSocket connect to ${url} timed out after ${timeoutMs}ms`, 'WS_TIMEOUT'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(client);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new EzTestError(`WebSocket connect to ${url} failed`, 'WS_CONNECT'));
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === 1;
  }

  send(data: string | Uint8Array | object): void {
    if (!this.isOpen) throw new EzTestError('WebSocket is not open', 'WS_NOT_OPEN');
    if (typeof data === 'string') this.ws.send(data);
    else if (data instanceof Uint8Array) this.ws.send(data);
    else this.ws.send(JSON.stringify(data));
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
      this.ws.addEventListener('close', () => resolve());
      this.ws.close(code, reason);
    });
  }

  private onMessage(raw: unknown): void {
    const data = typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBufferLike);
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const msg: WsMessage = {
      data,
      text,
      receivedAt: Date.now(),
      json() {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      },
    };
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
}

function safePred(p: (m: WsMessage) => boolean, m: WsMessage): boolean {
  try {
    return Boolean(p(m));
  } catch {
    return false;
  }
}
