/**
 * GraphQL over WebSocket, the graphql-transport-ws protocol (the
 * "GraphQL over WebSocket" protocol of the GraphQL over HTTP working group),
 * on EZTest's own WebSocket client:
 *
 *   client -> connection_init { payload }      server -> connection_ack
 *   client -> subscribe { id, payload }        server -> next { id, payload } ... complete { id }
 *                                              server -> error { id, payload: [errors] }
 *   either -> ping / pong                      client -> complete { id } (unsubscribe)
 *
 * Several subscriptions share one connection; each buffers its events so a
 * wait sees events that arrived before it started.
 */
import { randomUUID } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { WsClient, type WsConnectOptions } from './ws.js';
import type { GraphQLErrorItem } from './graphql.js';

export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

export interface GraphQLEvent<T = Record<string, unknown>> {
  data?: T | null;
  errors?: GraphQLErrorItem[];
  extensions?: Record<string, unknown>;
  receivedAt: number;
}

export interface GraphQLWsOptions extends Omit<WsConnectOptions, 'protocols'> {
  /** connection_init payload (e.g. { authorization: "Bearer ..." } for servers that read it there). */
  connectionParams?: Record<string, unknown>;
  /** How long to wait for connection_ack (default 10 s). */
  ackTimeoutMs?: number;
}

type Waiter = { pred: (e: GraphQLEvent) => boolean; resolve: (e: GraphQLEvent | undefined) => void; timer: ReturnType<typeof setTimeout> };

export class GraphQLSubscription<T = Record<string, unknown>> {
  readonly events: Array<GraphQLEvent<T>> = [];
  completed = false;
  /** Set when the server answered the subscribe with an error message. */
  error?: GraphQLErrorItem[];
  private taken = new Set<number>();
  private waiters: Waiter[] = [];

  constructor(readonly id: string, readonly query: string, private readonly conn: GraphQLWsClient) {}

  /** @internal */
  push(e: GraphQLEvent<T>): void {
    this.events.push(e);
    const idx = this.events.length - 1;
    for (const w of [...this.waiters]) {
      if (this.taken.has(idx)) break;
      if (safe(w.pred, e as GraphQLEvent)) {
        this.taken.add(idx);
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(e as GraphQLEvent);
      }
    }
  }

  /** @internal */
  end(error?: GraphQLErrorItem[]): void {
    this.completed = true;
    if (error) this.error = error;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(undefined);
    }
  }

  /** The first not-yet-taken event (received or future) matching `pred`, or undefined after `timeoutMs` or when the stream ends. */
  next(pred: (e: GraphQLEvent<T>) => boolean = () => true, timeoutMs = 10_000): Promise<GraphQLEvent<T> | undefined> {
    for (let i = 0; i < this.events.length; i++) {
      if (!this.taken.has(i) && safe(pred as (e: GraphQLEvent) => boolean, this.events[i] as GraphQLEvent)) {
        this.taken.add(i);
        return Promise.resolve(this.events[i]);
      }
    }
    if (this.completed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const w: Waiter = { pred: pred as (e: GraphQLEvent) => boolean, resolve: resolve as (e: GraphQLEvent | undefined) => void, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(undefined);
      }, Math.max(0, timeoutMs)) };
      this.waiters.push(w);
    });
  }

  /** Stop the subscription (sends complete). */
  unsubscribe(): void {
    if (this.completed) return;
    this.conn.complete(this.id);
    this.end();
  }
}

function safe(p: (e: GraphQLEvent) => boolean, e: GraphQLEvent): boolean {
  try {
    return Boolean(p(e));
  } catch {
    return false;
  }
}

export class GraphQLWsClient {
  private readonly subs = new Map<string, GraphQLSubscription>();
  closeInfo?: { code: number; reason: string };

  private constructor(readonly ws: WsClient) {}

  /** Connect, send connection_init and wait for connection_ack. */
  static async connect(url: string, o: GraphQLWsOptions = {}): Promise<GraphQLWsClient> {
    const ws = await WsClient.connect(url, { ...o, protocols: [GRAPHQL_TRANSPORT_WS] });
    const client = new GraphQLWsClient(ws);
    ws.send({ type: 'connection_init', ...(o.connectionParams ? { payload: o.connectionParams } : {}) });
    const ack = await ws.waitForMessage((m) => {
      const t = (m.json() as { type?: string } | undefined)?.type;
      return t === 'connection_ack';
    }, o.ackTimeoutMs ?? 10_000).catch((e: Error) => e);
    if (ack instanceof Error) {
      const info = ws.closeInfo;
      await ws.close().catch(() => undefined);
      // 4403 Forbidden, 4400 bad init, 4408 init timeout, 4429 too many inits (the protocol's close codes)
      const why = info ? `the server closed the connection (code ${info.code}${info.reason ? `: ${info.reason}` : ''})` : ack.message;
      throw new EzTestError(`GraphQL WebSocket ${url.replace(/\?.*$/, '')}: no connection_ack - ${why}`, info?.code === 4403 ? 'GRAPHQL_WS_FORBIDDEN' : 'GRAPHQL_WS_INIT');
    }
    client.listen();
    return client;
  }

  private listen(): void {
    // Messages after the ack: dispatch by id; answer pings.
    const ws = this.ws;
    const handled = new Set<unknown>();
    const pump = async () => {
      for (;;) {
        const m = await ws.waitForMessage((x) => !handled.has(x), 3_600_000).catch(() => undefined);
        if (!m) break;
        handled.add(m);
        const msg = m.json() as { type?: string; id?: string; payload?: unknown } | undefined;
        if (!msg || typeof msg.type !== 'string') continue;
        if (msg.type === 'ping') {
          if (ws.isOpen) ws.send({ type: 'pong' });
          continue;
        }
        const sub = msg.id ? this.subs.get(msg.id) : undefined;
        if (!sub) continue;
        if (msg.type === 'next') {
          const p = (msg.payload ?? {}) as { data?: Record<string, unknown> | null; errors?: GraphQLErrorItem[]; extensions?: Record<string, unknown> };
          sub.push({ ...p, receivedAt: m.receivedAt });
        } else if (msg.type === 'error') {
          sub.end(Array.isArray(msg.payload) ? (msg.payload as GraphQLErrorItem[]) : [{ message: String((msg.payload as { message?: string })?.message ?? 'subscription error') }]);
          this.subs.delete(msg.id!);
        } else if (msg.type === 'complete') {
          sub.end();
          this.subs.delete(msg.id!);
        }
      }
      this.closeInfo = ws.closeInfo;
      for (const s of this.subs.values()) s.end();
      this.subs.clear();
    };
    void pump();
  }

  get isOpen(): boolean {
    return this.ws.isOpen;
  }

  /** Start a subscription (or a query/mutation streamed over the socket). */
  subscribe<T = Record<string, unknown>>(query: string, variables?: Record<string, unknown>, operationName?: string): GraphQLSubscription<T> {
    if (!this.ws.isOpen) throw new EzTestError('GraphQL WebSocket is closed', 'GRAPHQL_WS_CLOSED');
    const id = randomUUID();
    const sub = new GraphQLSubscription<T>(id, query, this);
    this.subs.set(id, sub as unknown as GraphQLSubscription);
    this.ws.send({ type: 'subscribe', id, payload: { query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) } });
    return sub;
  }

  /** @internal */
  complete(id: string): void {
    this.subs.delete(id);
    if (this.ws.isOpen) this.ws.send({ type: 'complete', id });
  }

  async close(): Promise<void> {
    for (const s of this.subs.values()) s.unsubscribe();
    await this.ws.close(1000, 'Normal Closure');
  }
}
