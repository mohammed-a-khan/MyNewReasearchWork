/**
 * AMQP 0-9-1 (RabbitMQ) driver on amqplib (MIT, optional peer). Publishing
 * uses a confirm channel, so a step only passes once the broker accepted the
 * message. Listening on an exchange binds a private, auto-deleted queue;
 * listening on a queue consumes from it, acknowledges only the messages a
 * step matched, and returns the rest to the queue when the subscription closes.
 */
import { randomUUID } from 'node:crypto';
import { BusError, BusSubscription, decodePayload, loadClient, payloadText, type BusDestination, type BusDriver, type BusMessage, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export interface AmqpOptions {
  /** amqp://user:pass@host:5672/vhost */
  url: string;
  /** Exchange type asserted when publishing to an exchange that does not exist (default: do not assert). */
  exchangeType?: 'topic' | 'direct' | 'fanout' | 'headers';
  /** Declare queues that do not exist yet (durable) before using them (default true). */
  assertQueues?: boolean;
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
      this.conn = await amqp.connect(this.opts.url);
    } catch (e) {
      throw new BusError(`Cannot connect to AMQP broker "${this.name}": ${(e as Error).message}`, 'BUS_CONNECT');
    }
    this.conn.on('error', () => undefined);
    return this.conn;
  }

  private async confirmChannel(): Promise<Any> {
    if (this.confirm) return this.confirm;
    this.confirm = await (await this.connection()).createConfirmChannel();
    this.confirm.on('error', () => {
      this.confirm = undefined;
    });
    return this.confirm;
  }

  private readonly knownQueues = new Set<string>();

  /** Declare a queue that does not exist yet (durable); an existing queue is used as it is. */
  private async ensureQueue(name: string): Promise<void> {
    if (this.knownQueues.has(name) || this.opts.assertQueues === false) return;
    const conn = await this.connection();
    const probe = await conn.createChannel();
    probe.on('error', () => undefined);
    try {
      await probe.checkQueue(name);
      await probe.close().catch(() => undefined);
    } catch {
      // checkQueue closes the channel on 404: declare the queue on a fresh one.
      const ch = await conn.createChannel();
      await ch.assertQueue(name, { durable: true });
      await ch.close().catch(() => undefined);
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
    if (dest.type === 'exchange') {
      if (this.opts.exchangeType) await ch.assertExchange(dest.name, this.opts.exchangeType, { durable: true });
      ch.publish(dest.name, dest.routingKey ?? msg.key ?? '', body, props);
    } else {
      ch.sendToQueue(dest.name, body, props);
    }
    await ch.waitForConfirms();
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
    const { consumerTag } = await ch.consume(queue, (m: Any) => {
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
