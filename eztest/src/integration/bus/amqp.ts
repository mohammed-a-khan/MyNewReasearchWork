/**
 * AMQP 0-9-1 (RabbitMQ) driver on amqplib (MIT, optional peer). Publishing
 * uses a confirm channel, so a step only passes once the broker accepted the
 * message. Listening on an exchange binds a private, auto-deleted queue;
 * listening on a queue consumes from it, acknowledges only the messages a
 * step matched, and returns the rest to the queue when the subscription closes.
 *
 * Queues belong to the application: a missing queue is an error
 * (AMQP_QUEUE_MISSING) unless the broker config says `declare: true`, and a
 * permission refusal from the broker is reported as such (BUS_AUTH), never
 * taken for a missing queue.
 */
import { randomUUID } from 'node:crypto';
import type { TlsOptions } from '../tls.js';
import { BusError, BusSubscription, decodePayload, loadClient, payloadText, type BusDestination, type BusDriver, type BusMessage, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export interface AmqpOptions {
  /** amqp://user:pass@host:5672/vhost */
  url: string;
  /** Exchange type asserted when publishing to an exchange that does not exist (default: do not assert). */
  exchangeType?: 'topic' | 'direct' | 'fanout' | 'headers';
  /** Declare queues that do not exist yet (durable) before using them (default false: a missing queue is an error). */
  declare?: boolean;
  /** Older name of `declare`. */
  assertQueues?: boolean;
  /** TLS for amqps://: extra CA, client certificate and key, servername (verification stays on). */
  tls?: TlsOptions;
  client?: unknown;
}

type Any = any;

export class AmqpBusDriver implements BusDriver {
  readonly kind = 'amqp' as const;
  private conn?: Any;
  private confirm?: Any;
  private readonly channels = new Set<Any>();

  constructor(readonly name: string, readonly opts: AmqpOptions) {
    if (!opts.url) throw new BusError(`messaging.brokers.${name}: amqp needs "url"`, 'CONFIG');
  }

  private async connection(): Promise<Any> {
    if (this.conn) return this.conn;
    const amqp = (this.opts.client ?? (await loadClient('amqplib', 'AMQP (RabbitMQ)'))) as Any;
    try {
      this.conn = await amqp.connect(this.opts.url, this.opts.tls ? { ...this.opts.tls, rejectUnauthorized: true } : undefined);
    } catch (e) {
      throw new BusError(`Cannot connect to AMQP broker "${this.name}": ${(e as Error).message}`, 'BUS_CONNECT');
    }
    this.conn.on('error', () => undefined);
    return this.conn;
  }

  private async confirmChannel(): Promise<Any> {
    if (this.confirm) return this.confirm;
    const ch = await (await this.connection()).createConfirmChannel();
    ch.on('error', (e: Error) => {
      // The broker closes the channel on a refusal: keep why, the publish reports it.
      this.confirmError = e;
      if (this.confirm === ch) this.confirm = undefined;
    });
    ch.on('close', () => {
      if (this.confirm === ch) this.confirm = undefined;
    });
    this.confirm = ch;
    return ch;
  }

  private confirmError?: Error;

  private readonly knownQueues = new Set<string>();

  /** A broker error as EZTest reports it: a refusal is a permission problem, a 404 a missing queue. */
  private brokerError(e: unknown, what: string, queue?: string): BusError {
    const err = e as { code?: number; message?: string };
    const msg = err.message ?? String(e);
    if (err.code === 403 || /ACCESS[_-]REFUSED/i.test(msg)) {
      return new BusError(`RabbitMQ broker "${this.name}" refused ${what}: ${msg}. The user of messaging.brokers.${this.name} needs permission for it (rabbitmqctl set_permissions).`, 'BUS_AUTH', queue ? { queue } : undefined);
    }
    if (queue && (err.code === 404 || /NOT[_-]FOUND/i.test(msg))) {
      return new BusError(`RabbitMQ queue "${queue}" does not exist on broker "${this.name}". Create it (the application normally declares it), or set declare: true on messaging.brokers.${this.name} to let EZTest declare it.`, 'AMQP_QUEUE_MISSING', { queue });
    }
    return new BusError(`RabbitMQ broker "${this.name}": ${what} failed: ${msg}`, 'BUS_ERROR');
  }

  private get declares(): boolean {
    return this.opts.declare ?? this.opts.assertQueues ?? false;
  }

  /**
   * The queue must exist: checked (passively) once per driver. With `declare: true` a missing
   * queue is declared (durable); otherwise it is an error.
   */
  private async ensureQueue(name: string): Promise<void> {
    if (this.knownQueues.has(name)) return;
    const conn = await this.connection();
    const probe = await conn.createChannel();
    probe.on('error', () => undefined);
    try {
      await probe.checkQueue(name);
      await probe.close().catch(() => undefined);
    } catch (e) {
      const err = this.brokerError(e, `access to queue "${name}"`, name);
      if (err.code !== 'AMQP_QUEUE_MISSING' || !this.declares) throw err;
      // checkQueue closes the channel on 404: declare the queue on a fresh one.
      const ch = await conn.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.assertQueue(name, { durable: true });
      } catch (e2) {
        throw this.brokerError(e2, `declaring queue "${name}"`);
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
    this.knownQueues.add(name);
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    if (dest.type === 'queue') await this.ensureQueue(dest.name);
    const ch = await this.confirmChannel();
    const messageId = randomUUID();
    const props = {
      messageId, persistent: true, timestamp: Math.floor(Date.now() / 1000), headers: msg.headers ?? {},
      ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
      contentType: msg.contentType ?? (looksJson(msg.payload) ? 'application/json' : 'text/plain'),
    };
    const body = Buffer.from(typeof msg.payload === 'string' ? msg.payload : msg.payload);
    this.confirmError = undefined;
    try {
      if (dest.type === 'exchange') {
        if (this.opts.exchangeType) await ch.assertExchange(dest.name, this.opts.exchangeType, { durable: true });
        ch.publish(dest.name, dest.routingKey ?? msg.key ?? '', body, props);
      } else {
        ch.sendToQueue(dest.name, body, props);
      }
      await ch.waitForConfirms();
    } catch (e) {
      // Let the channel's own close reason (ACCESS_REFUSED, NOT_FOUND) arrive before reporting.
      await new Promise((r) => setTimeout(r, 20));
      throw this.brokerError(this.confirmError ?? e, `publishing to ${dest.type} "${dest.name}"`, dest.type === 'queue' ? dest.name : undefined);
    }
    return { messageId };
  }

  async subscribe(dest: BusDestination, opts: SubscribeOptions = {}): Promise<BusSubscription> {
    if (dest.type === 'queue') await this.ensureQueue(dest.name);
    const conn = await this.connection();
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    this.channels.add(ch);
    const sub = new BusSubscription(dest);
    let queue = dest.name;
    if (dest.type === 'exchange') {
      const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      queue = q.queue;
      await ch.bindQueue(queue, dest.name, dest.routingKey ?? '#');
    } else if (dest.type === 'topic') {
      throw new BusError('AMQP has queues and exchanges; say "queue" or "exchange"', 'BUS_DESTINATION');
    }
    const ownQueue = dest.type === 'exchange';
    await ch.prefetch(500);
    const deliveries = new Map<BusMessage, Any>();
    const consuming = ch.consume(queue, (m: Any) => {
      if (!m) return;
      const p = m.properties ?? {};
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((p.headers ?? {}) as Record<string, unknown>)) headers[k] = v instanceof Uint8Array ? payloadText(v) : String(v);
      const bm: BusMessage = {
        destination: dest.name, ...decodePayload(m.content), headers, routingKey: m.fields?.routingKey,
        ...(p.correlationId ? { correlationId: String(p.correlationId) } : {}), ...(p.messageId ? { messageId: String(p.messageId) } : {}),
        timestamp: p.timestamp ? Number(p.timestamp) * 1000 : Date.now(),
      };
      if (ownQueue) ch.ack(m);
      else deliveries.set(bm, m);
      sub.push(bm);
    }, { noAck: false });
    let consumerTag: string;
    try {
      ({ consumerTag } = await consuming);
    } catch (e) {
      this.channels.delete(ch);
      throw this.brokerError(e, `consuming from queue "${queue}"`, ownQueue ? undefined : queue);
    }
    if (!ownQueue) {
      sub.onTake = (bm) => {
        const d = deliveries.get(bm);
        if (d && opts.consumeMatched !== false) {
          ch.ack(d);
          deliveries.delete(bm);
        }
      };
    }
    sub.onClose = async () => {
      await ch.cancel(consumerTag).catch(() => undefined);
      // Messages nobody matched go back to the queue for the application (or the next step).
      for (const d of deliveries.values()) {
        try {
          ch.nack(d, false, true);
        } catch {
          // channel already closed
        }
      }
      deliveries.clear();
      this.channels.delete(ch);
      await ch.close().catch(() => undefined);
    };
    return sub;
  }

  async purge(dest: BusDestination): Promise<number | undefined> {
    const ch = await (await this.connection()).createChannel();
    try {
      const r = await ch.purgeQueue(dest.name);
      return r?.messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const ch of this.channels) await ch.close().catch(() => undefined);
    this.channels.clear();
    await this.confirm?.close().catch(() => undefined);
    await this.conn?.close().catch(() => undefined);
    this.conn = undefined;
    this.confirm = undefined;
  }
}

function looksJson(p: string | Uint8Array): boolean {
  return /^\s*[{[]/.test(typeof p === 'string' ? p : Buffer.from(p.subarray(0, 16)).toString('utf8'));
}
