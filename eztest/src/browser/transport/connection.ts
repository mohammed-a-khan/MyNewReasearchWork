/**
 * Chrome DevTools Protocol connection: request/response correlation, event
 * dispatch, and flat-mode sessions (`Target.attachToTarget` /
 * `Target.setAutoAttach` with `flatten: true`), where every message for a
 * target carries its `sessionId` on the one shared transport.
 */
import { EventEmitter } from 'node:events';
import { debugEnabled, debugLog } from '../debug.js';
import { ProtocolError, TargetClosedError } from '../errors.js';
import type { KnownCommands } from './protocol-types.js';
import type { Transport } from './transport.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ProtocolParams = Record<string, any>;
export type ProtocolResult = Record<string, any>;

interface Pending {
  resolve: (v: ProtocolResult) => void;
  reject: (e: Error) => void;
  method: string;
  /** Stack of the caller, appended to protocol errors for debuggability. */
  stack?: string;
}

interface IncomingMessage {
  id?: number;
  method?: string;
  params?: ProtocolParams;
  result?: ProtocolResult;
  error?: { message: string; code?: number; data?: string };
  sessionId?: string;
}

/**
 * One protocol session: the browser (root, no session id) or one attached
 * target. Emits protocol events by method name ('Page.loadEventFired', ...)
 * with the params object, and 'disconnected' when the session ends.
 */
export class CDPSession extends EventEmitter {
  private closedReason?: string;

  constructor(
    readonly connection: CDPConnection,
    readonly sessionId: string | undefined,
    /** Target type when known ('page', 'iframe', 'worker', 'service_worker', 'browser'...). */
    readonly targetType: string,
    readonly targetId?: string,
  ) {
    super();
    this.setMaxListeners(0);
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Send a command and await its result. */
  send<M extends keyof KnownCommands>(method: M, params?: KnownCommands[M]['params']): Promise<KnownCommands[M]['result']>;
  send<T extends ProtocolResult = ProtocolResult>(method: string, params?: ProtocolParams): Promise<T>;
  send(method: string, params: ProtocolParams = {}): Promise<ProtocolResult> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new TargetClosedError(`Protocol error (${method}): Target closed (${this.closedReason})`));
    }
    return this.connection.rawSend(method, params, this.sessionId);
  }

  /** Send and ignore the result and any error (fire and forget). */
  sendMayFail(method: string, params: ProtocolParams = {}): Promise<ProtocolResult | undefined> {
    return this.send(method, params).catch(() => undefined);
  }

  /** Detach from the target (the target itself stays alive). */
  async detach(): Promise<void> {
    if (this.sessionId === undefined) throw new Error('The browser session cannot be detached');
    if (this.closed) return;
    await this.connection.root.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
    this.markClosed('detached');
  }

  /** Internal: dispatch an event. */
  dispatch(method: string, params: ProtocolParams): void {
    this.emit(method, params);
  }

  /** Internal: the session is gone; reject pending calls. */
  markClosed(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.connection.rejectPendingOf(this.sessionId, reason);
    if (this.sessionId !== undefined) this.connection.sessions.delete(this.sessionId);
    this.emit('disconnected', reason);
  }
}

/** The protocol connection over one transport. `root` is the browser session. */
export class CDPConnection extends EventEmitter {
  readonly root: CDPSession;
  readonly sessions = new Map<string, CDPSession>();
  private readonly pending = new Map<number, Pending & { sessionId?: string }>();
  private lastId = 0;
  private closedReason?: string;
  private readonly tracing = debugEnabled('protocol');

  constructor(private readonly transport: Transport) {
    super();
    this.setMaxListeners(0);
    this.root = new CDPSession(this, undefined, 'browser');
    transport.onmessage = (m) => this.onMessage(m);
    transport.onclose = (reason) => this.onClose(reason ?? 'transport closed');
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /** Session object for an id (created on attach). */
  session(sessionId: string): CDPSession | undefined {
    return this.sessions.get(sessionId);
  }

  rawSend(method: string, params: ProtocolParams, sessionId?: string): Promise<ProtocolResult> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new TargetClosedError(`Protocol error (${method}): Browser has been closed (${this.closedReason})`));
    }
    const id = ++this.lastId;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const text = JSON.stringify(msg);
    if (this.tracing) debugLog('protocol', `▶ ${text}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, sessionId });
      this.transport.send(text);
    });
  }

  private onMessage(text: string): void {
    if (this.tracing) debugLog('protocol', `◀ ${text}`);
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(text) as IncomingMessage;
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new ProtocolError(p.method, msg.error.message + (msg.error.data ? ` (${msg.error.data})` : ''), msg.error.code));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    const params = msg.params ?? {};
    // Flat-mode attach: the new session must exist before anyone sees the event,
    // so listeners can talk to it immediately.
    if (msg.method === 'Target.attachedToTarget') {
      const info = params.targetInfo as { type: string; targetId: string };
      const s = new CDPSession(this, params.sessionId as string, info.type, info.targetId);
      this.sessions.set(params.sessionId as string, s);
    }
    const target = msg.sessionId ? this.sessions.get(msg.sessionId) : this.root;
    if (msg.method === 'Target.detachedFromTarget') {
      const gone = this.sessions.get(params.sessionId as string);
      target?.dispatch(msg.method, params);
      gone?.markClosed('target detached');
      return;
    }
    target?.dispatch(msg.method, params);
  }

  /** Reject pending calls of one session. */
  rejectPendingOf(sessionId: string | undefined, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      p.reject(new TargetClosedError(`Protocol error (${p.method}): Target closed (${reason})`));
    }
  }

  private onClose(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new TargetClosedError(`Protocol error (${p.method}): Browser has been closed`));
    }
    for (const s of [...this.sessions.values()]) s.markClosed(reason);
    this.root.markClosed(reason);
    this.emit('disconnected', reason);
  }

  close(): void {
    this.transport.close();
    this.onClose('closed by client');
  }
}
