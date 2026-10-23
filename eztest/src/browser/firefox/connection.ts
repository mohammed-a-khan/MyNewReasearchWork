/**
 * WebDriver BiDi connection (W3C WebDriver BiDi, "Transport" and "Protocol"):
 * commands are `{id, method, params}`; the remote end answers with
 * `{type: 'success', id, result}` or `{type: 'error', id, error, message}`
 * and sends `{type: 'event', method, params}` for subscribed events.
 *
 * One connection carries one session (session.new) for the whole browser.
 */
import { EventEmitter } from 'node:events';
import { debugEnabled, debugLog } from '../debug.js';
import { ProtocolError, TargetClosedError } from '../errors.js';
import type { Transport } from '../transport/transport.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type BidiParams = Record<string, any>;
export type BidiResult = Record<string, any>;

interface Pending {
  resolve: (v: BidiResult) => void;
  reject: (e: Error) => void;
  method: string;
}

/** A BiDi error response: `error` is the WebDriver error code ("no such frame", "unknown command" ...). */
export class BidiError extends ProtocolError {
  constructor(method: string, readonly error: string, message: string) {
    super(method, `${error}: ${message}`);
    this.name = 'ProtocolError';
  }
}

export class BidiConnection extends EventEmitter {
  private readonly pending = new Map<number, Pending>();
  private lastId = 0;
  private closedReason?: string;
  private readonly tracing = debugEnabled('protocol');

  constructor(private readonly transport: Transport) {
    super();
    this.setMaxListeners(0);
    transport.onmessage = (m) => this.onMessage(m);
    transport.onclose = (reason) => this.onClose(reason ?? 'transport closed');
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  send<T extends BidiResult = BidiResult>(method: string, params: BidiParams = {}): Promise<T> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new TargetClosedError(`Protocol error (${method}): Browser has been closed (${this.closedReason})`));
    }
    const id = ++this.lastId;
    const text = JSON.stringify({ id, method, params });
    if (this.tracing) debugLog('protocol', `▶ ${text}`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: BidiResult) => void, reject, method });
      this.transport.send(text);
    });
  }

  private onMessage(text: string): void {
    if (this.tracing) debugLog('protocol', `◀ ${text}`);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'event') {
      this.emit(msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.id !== 'number') {
      // An error without a command id (e.g. a malformed message): nothing to settle.
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new BidiError(p.method, String(msg.error), String(msg.message ?? '')));
    else p.resolve(msg.result ?? {});
  }

  private onClose(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new TargetClosedError(`Protocol error (${p.method}): Browser has been closed (${reason})`));
    this.pending.clear();
    this.emit('disconnected', reason);
  }

  close(): void {
    this.transport.close();
  }
}

/** WebDriver error codes that mean "the thing you addressed is gone". */
export function isGoneBidiError(e: unknown): boolean {
  const err = e as BidiError;
  if (err?.error && /^(no such frame|no such node|no such handle|no such user context|no such script)$/.test(err.error)) return true;
  return /no such frame|Realm with id .* not found|context was discarded|has been discarded|BrowsingContext .* does not exist|Browsing context with id .* not found/i.test(err?.message ?? '');
}
