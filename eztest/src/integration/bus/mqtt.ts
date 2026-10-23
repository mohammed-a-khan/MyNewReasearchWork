/**
 * MQTT 3.1.1 / 5 driver on mqtt.js (MIT, optional peer). One client per
 * broker; each subscription filters deliveries by its topic filter (+ and #
 * wildcards). MQTT 5 user properties, correlation data and content type are
 * mapped to headers and correlation ids.
 */
import { randomUUID } from 'node:crypto';
import { topicMatches } from './memory.js';
import { BusError, BusSubscription, decodePayload, loadClient, payloadText, type BusDestination, type BusDriver, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export interface MqttOptions {
  /** mqtt://host:1883, mqtts://..., ws://... */
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  /** 4 (3.1.1) or 5 (default 5). */
  protocolVersion?: 4 | 5;
  qos?: 0 | 1 | 2;
  client?: unknown;
}

type Any = any;

export class MqttBusDriver implements BusDriver {
  readonly kind = 'mqtt' as const;
  private client?: Any;
  private readonly subs = new Set<BusSubscription>();

  constructor(readonly name: string, readonly opts: MqttOptions) {
    if (!opts.url) throw new BusError(`messaging.brokers.${name}: mqtt needs "url"`, 'CONFIG');
  }

  private async conn(): Promise<Any> {
    if (this.client) return this.client;
    const mqtt = (this.opts.client ?? (await loadClient('mqtt', 'MQTT'))) as Any;
    try {
      this.client = await mqtt.connectAsync(this.opts.url, {
        clientId: this.opts.clientId ?? `eztest-${randomUUID().slice(0, 8)}`,
        protocolVersion: this.opts.protocolVersion ?? 5,
        ...(this.opts.username ? { username: this.opts.username } : {}),
        ...(this.opts.password ? { password: this.opts.password } : {}),
        connectTimeout: 10_000,
        reconnectPeriod: 0,
        clean: true,
      });
    } catch (e) {
      throw new BusError(`Cannot connect to MQTT broker "${this.name}": ${(e as Error).message}`, 'BUS_CONNECT');
    }
    this.client.on('error', () => undefined);
    this.client.on('message', (topic: string, payload: Buffer, packet: Any) => {
      const p = packet?.properties ?? {};
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((p.userProperties ?? {}) as Record<string, unknown>)) headers[k] = Array.isArray(v) ? v.join(',') : String(v);
      if (p.contentType) headers['content-type'] = String(p.contentType);
      const m = {
        destination: topic, ...decodePayload(payload), headers, routingKey: topic,
        ...(p.correlationData ? { correlationId: payloadText(p.correlationData) } : headers['correlation-id'] ? { correlationId: headers['correlation-id'] } : {}),
        timestamp: Date.now(),
        ...(packet?.retain ? { messageId: 'retained' } : {}),
      };
      for (const s of this.subs) if (topicMatches(s.destination.name, topic)) s.push(m);
    });
    return this.client;
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    const c = await this.conn();
    const v5 = (this.opts.protocolVersion ?? 5) === 5;
    const headers = { ...(msg.headers ?? {}) };
    if (!v5 && msg.correlationId) headers['correlation-id'] = msg.correlationId;
    await c.publishAsync(dest.name, typeof msg.payload === 'string' ? msg.payload : Buffer.from(msg.payload), {
      qos: msg.qos ?? this.opts.qos ?? 1,
      retain: msg.retain ?? false,
      ...(v5 ? { properties: {
        ...(Object.keys(headers).length ? { userProperties: headers } : {}),
        ...(msg.correlationId ? { correlationData: Buffer.from(msg.correlationId) } : {}),
        ...(msg.contentType ? { contentType: msg.contentType } : {}),
      } } : {}),
    });
    return {};
  }

  async subscribe(dest: BusDestination, _opts: SubscribeOptions = {}): Promise<BusSubscription> {
    if (dest.type !== 'topic') throw new BusError('MQTT has topics only; say "MQTT topic"', 'BUS_DESTINATION');
    const c = await this.conn();
    const sub = new BusSubscription(dest);
    this.subs.add(sub);
    await c.subscribeAsync(dest.name, { qos: this.opts.qos ?? 1 });
    sub.onClose = async () => {
      this.subs.delete(sub);
      if (![...this.subs].some((s) => s.destination.name === dest.name)) await c.unsubscribeAsync(dest.name).catch(() => undefined);
    };
    return sub;
  }

  async close(): Promise<void> {
    for (const s of [...this.subs]) await s.close();
    await this.client?.endAsync().catch(() => undefined);
    this.client = undefined;
  }
}
