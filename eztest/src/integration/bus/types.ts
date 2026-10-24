/**
 * Message-bus drivers share one small contract: publish, subscribe (with a
 * start time so an event emitted just before the step is not missed), purge
 * and close. Every driver turns broker messages into BusMessage.
 */
import { EzTestError } from '../../core/index.js';

export type BusKind = 'kafka' | 'amqp' | 'amqp10' | 'mqtt' | 'ibmmq' | 'memory';

/** Where a message goes or comes from. */
export interface BusDestination {
  /** topic (Kafka, MQTT, IBM MQ topic strings), queue (AMQP, IBM MQ) or exchange (AMQP). */
  type: 'topic' | 'queue' | 'exchange';
  name: string;
  /** AMQP: routing key to publish with, or binding key to listen with (default "#"). */
  routingKey?: string;
}

export interface OutgoingMessage {
  payload: string | Uint8Array;
  key?: string;
  headers?: Record<string, string>;
  correlationId?: string;
  contentType?: string;
  /** MQTT */
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export interface BusMessage {
  destination: string;
  /** Payload as text (UTF-8). Binary payloads are base64 with `binary: true`. */
  payload: string;
  binary?: boolean;
  key?: string;
  headers: Record<string, string>;
  correlationId?: string;
  messageId?: string;
  /** Epoch ms (broker timestamp when the broker has one). */
  timestamp: number;
  partition?: number;
  offset?: string;
  /** AMQP routing key / MQTT topic of the delivery. */
  routingKey?: string;
}

export interface PublishReceipt {
  messageId?: string;
  partition?: number;
  offset?: string;
}

export interface SubscribeOptions {
  /** Deliver messages with a broker timestamp at or after this (Kafka seeks by time; others start now). */
  fromTimestamp?: number;
  /** AMQP queue consumption: settle (ack) messages the step matched; others are returned to the queue on close. */
  consumeMatched?: boolean;
}

/** Buffered messages of one subscription, with waiters for the next match. */
export class BusSubscription {
  readonly messages: BusMessage[] = [];
  private waiters: Array<{ pred: (m: BusMessage) => boolean; resolve: (m: BusMessage | undefined) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  /** Indexes of messages already handed out by `next` (each message matches one wait at most). */
  private readonly taken = new Set<number>();
  closed = false;
  onClose?: () => Promise<void>;
  /**
   * Called when a wait takes a message (AMQP acks it, IBM MQ consumes exactly that message). A
   * returned promise is awaited before the wait resolves, so the next step sees it consumed; a
   * rejection fails the wait.
   */
  onTake?: (m: BusMessage) => void | Promise<void>;
  error?: Error;

  constructor(readonly destination: BusDestination) {}

  push(m: BusMessage): void {
    this.messages.push(m);
    const idx = this.messages.length - 1;
    for (const w of [...this.waiters]) {
      if (this.taken.has(idx)) break;
      if (w.pred(m)) {
        this.taken.add(idx);
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        this.take(m).then(() => w.resolve(m), (e: Error) => w.reject(e));
      }
    }
  }

  private async take(m: BusMessage): Promise<void> {
    await this.onTake?.(m);
  }

  fail(e: Error): void {
    this.error = e;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(undefined);
    }
    this.waiters = [];
  }

  /** The first buffered or future message matching `pred`, or undefined after `timeoutMs`. */
  next(pred: (m: BusMessage) => boolean, timeoutMs: number): Promise<BusMessage | undefined> {
    for (let i = 0; i < this.messages.length; i++) {
      if (this.taken.has(i)) continue;
      if (pred(this.messages[i])) {
        this.taken.add(i);
        const m = this.messages[i];
        return this.take(m).then(() => m);
      }
    }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(undefined);
      }, Math.max(0, timeoutMs)) };
      this.waiters.push(w);
    });
  }

  /** Messages matching `pred` that arrived (all of them, including taken ones). */
  matching(pred: (m: BusMessage) => boolean): BusMessage[] {
    return this.messages.filter(pred);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new EzTestError('subscription closed', 'BUS_CLOSED'));
    await this.onClose?.();
  }
}

export interface BusDriver {
  readonly kind: BusKind;
  readonly name: string;
  publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt>;
  subscribe(dest: BusDestination, opts?: SubscribeOptions): Promise<BusSubscription>;
  /** Remove waiting messages from a queue; returns how many (when the broker says). */
  purge?(dest: BusDestination): Promise<number | undefined>;
  close(): Promise<void>;
}

export class BusError extends EzTestError {
  constructor(message: string, code = 'BUS_ERROR', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'BusError';
  }
}

export function payloadText(p: string | Uint8Array): string {
  return typeof p === 'string' ? p : Buffer.from(p).toString('utf8');
}

/** Turn bytes into BusMessage payload fields (text when valid UTF-8, else base64). */
export function decodePayload(bytes: Uint8Array | string | null | undefined): { payload: string; binary?: boolean } {
  if (bytes === null || bytes === undefined) return { payload: '' };
  if (typeof bytes === 'string') return { payload: bytes };
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buf) && !/[\u0000-\u0008\u000E-\u001F]/.test(text)) return { payload: text };
  return { payload: buf.toString('base64'), binary: true };
}

/** Load an optional client library with an install hint (same convention as the database drivers). */
export async function loadClient(pkg: string, what: string): Promise<any> {
  const spec: string = pkg;
  try {
    const mod = await import(spec);
    return mod.default ?? mod;
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = (e as Error).message ?? '';
    const missing = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /cannot find (package|module)|could not resolve|failed to (load url|resolve import)/i.test(msg);
    if (missing && msg.includes(pkg)) {
      throw new BusError(`${what} support needs the "${pkg}" package, which is not installed. Run: npm install ${pkg}`, 'CLIENT_MISSING', { package: pkg });
    }
    throw new BusError(`Loading "${pkg}" failed: ${msg}`, 'CLIENT_LOAD');
  }
}
