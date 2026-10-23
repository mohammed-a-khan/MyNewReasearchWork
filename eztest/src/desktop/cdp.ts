/**
 * TEMPORARY minimal Chrome DevTools Protocol client for the Electron rung.
 *
 * EZTest's own CDP browser driver is being built in src/browser/ (it will
 * include an Electron launcher). When it lands, replace this file with an
 * adapter from that driver's page object to `CdpPageSeam` (electron.ts) and
 * delete this client; nothing outside src/desktop/electron.ts imports it.
 *
 * Uses Node's built-in WebSocket (Node 22+); no third-party dependency.
 */

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

/** One CDP WebSocket connection (a page target). */
export class CdpConnection {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {});
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new CdpError(`${p.method}: the DevTools connection closed`));
      this.pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new CdpError('this Node.js has no built-in WebSocket (Node 22+ is needed for the Electron rung)');
    const ws = new WS(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError(`DevTools connection to ${url} timed out`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new CdpError(`cannot connect to DevTools at ${url}`));
      });
    });
    return new CdpConnection(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: the DevTools connection is closed`));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, cb: (params: Record<string, unknown>) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}

/** DevTools HTTP endpoint helpers (/json/list). */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function listTargets(httpBase: string): Promise<CdpTarget[]> {
  const res = await fetch(`${httpBase}/json/list`);
  if (!res.ok) throw new CdpError(`${httpBase}/json/list: HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}
