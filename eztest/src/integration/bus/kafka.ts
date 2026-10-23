/**
 * Kafka driver on kafkajs (MIT, optional peer). Each subscription is its own
 * consumer group (unique per run and subscription, so runs never steal each
 * other's messages) and seeks every partition to the subscription's start
 * time, so an event emitted between the UI action and the wait is found.
 */
import { randomUUID } from 'node:crypto';
import { BusError, BusSubscription, decodePayload, loadClient, payloadText, type BusDestination, type BusDriver, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export interface KafkaOptions {
  brokers: string[];
  clientId?: string;
  ssl?: boolean;
  sasl?: { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string };
  /** Group id prefix for test consumers (default "eztest"). */
  groupPrefix?: string;
  connectionTimeoutMs?: number;
  /** Library to use instead of importing "kafkajs" (tests, bundlers). */
  client?: unknown;
}

type Any = any; // kafkajs types are optional (peer dependency)

export class KafkaBusDriver implements BusDriver {
  readonly kind = 'kafka' as const;
  private kafka?: Any;
  private producer?: Any;
  private admin?: Any;
  private readonly consumers = new Set<Any>();

  constructor(readonly name: string, readonly opts: KafkaOptions) {
    if (!opts.brokers?.length) throw new BusError(`messaging.brokers.${name}: kafka needs "brokers"`, 'CONFIG');
  }

  private async lib(): Promise<Any> {
    if (this.kafka) return this.kafka;
    const k = (this.opts.client ?? (await loadClient('kafkajs', 'Kafka'))) as Any;
    this.kafka = new k.Kafka({
      clientId: this.opts.clientId ?? 'eztest',
      brokers: this.opts.brokers,
      ...(this.opts.ssl ? { ssl: true } : {}),
      ...(this.opts.sasl ? { sasl: this.opts.sasl } : {}),
      connectionTimeout: this.opts.connectionTimeoutMs ?? 10_000,
      logLevel: k.logLevel?.NOTHING ?? 0,
      retry: { retries: 5, initialRetryTime: 200 },
    });
    return this.kafka;
  }

  private async prod(): Promise<Any> {
    if (this.producer) return this.producer;
    const p = (await this.lib()).producer({ allowAutoTopicCreation: true });
    await p.connect();
    this.producer = p;
    return p;
  }

  private async adm(): Promise<Any> {
    if (this.admin) return this.admin;
    const a = (await this.lib()).admin();
    await a.connect();
    this.admin = a;
    return a;
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}) };
    if (msg.correlationId) headers['correlation-id'] = msg.correlationId;
    if (msg.contentType) headers['content-type'] = msg.contentType;
    const [r] = (await (await this.prod()).send({
      topic: dest.name,
      messages: [{ ...(msg.key !== undefined ? { key: msg.key } : {}), value: typeof msg.payload === 'string' ? msg.payload : Buffer.from(msg.payload), headers }],
    })) as Array<{ partition: number; baseOffset?: string; offset?: string }>;
    return { partition: r?.partition, offset: r?.baseOffset ?? r?.offset };
  }

  async subscribe(dest: BusDestination, opts: SubscribeOptions = {}): Promise<BusSubscription> {
    const kafka = await this.lib();
    const sub = new BusSubscription(dest);
    const from = opts.fromTimestamp ?? Date.now();
    // Make sure the topic exists so offsets-by-time can be looked up (auto-created topics may lag).
    const admin = await this.adm();
    const topics = (await admin.listTopics()) as string[];
    if (!topics.includes(dest.name)) await admin.createTopics({ topics: [{ topic: dest.name }], waitForLeaders: true }).catch(() => undefined);
    const offsets = (await admin.fetchTopicOffsetsByTimestamp(dest.name, from)) as Array<{ partition: number; offset: string }>;
    const consumer = kafka.consumer({ groupId: `${this.opts.groupPrefix ?? 'eztest'}-${randomUUID()}`, sessionTimeout: 10_000, heartbeatInterval: 1000, retry: { retries: 3 } });
    this.consumers.add(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: dest.name, fromBeginning: false });
    let seeked = false;
    const joined = new Promise<void>((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: Any) => {
        if (!seeked) return;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((message.headers ?? {}) as Record<string, Any>)) headers[k] = Array.isArray(v) ? v.map((x) => payloadText(x)).join(',') : v === undefined || v === null ? '' : payloadText(v);
        const ts = Number(message.timestamp);
        if (ts < from) return;
        sub.push({
          destination: topic, ...decodePayload(message.value), ...(message.key ? { key: payloadText(message.key) } : {}), headers,
          ...(headers['correlation-id'] ? { correlationId: headers['correlation-id'] } : {}),
          timestamp: ts, partition, offset: String(message.offset),
        });
      },
    });
    await Promise.race([joined, new Promise((r) => setTimeout(r, 15_000))]);
    for (const o of offsets) consumer.seek({ topic: dest.name, partition: o.partition, offset: o.offset });
    seeked = true;
    sub.onClose = async () => {
      this.consumers.delete(consumer);
      await consumer.disconnect().catch(() => undefined);
    };
    return sub;
  }

  async close(): Promise<void> {
    for (const c of this.consumers) await c.disconnect().catch(() => undefined);
    this.consumers.clear();
    await this.producer?.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
    this.producer = undefined;
    this.admin = undefined;
  }
}
