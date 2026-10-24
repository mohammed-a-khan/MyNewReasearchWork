/**
 * Kafka driver on kafkajs (MIT, optional peer).
 *
 * - Topics are never created behind the user's back: publishing to or
 *   waiting on a missing topic fails with KAFKA_TOPIC_MISSING, unless the
 *   broker config says `createTopics: true` (then EZTest creates it and a
 *   failure to do so is an error, not ignored).
 * - Consumers use one consumer group per driver (one per run: never shared
 *   with another run or the application, so nothing is stolen), with a
 *   numbered sibling only when two subscriptions read the same topic at once.
 *   Offsets are never committed, and the groups are deleted when the run
 *   ends (where the broker allows it).
 * - Every subscription seeks each partition to its start time, so an event
 *   emitted between the UI action and the wait is found. A consumer that does
 *   not join its group in time fails the wait instead of reading nothing.
 */
import { randomUUID } from 'node:crypto';
import type { AwsCredentials } from '../../identity/aws-sigv4.js';
import type { SchemaRegistrySerde } from '../schema-registry.js';
import type { TlsOptions } from '../tls.js';
import { MSK_IAM_MECHANISM, mskIamAuthenticationProvider } from './msk-iam.js';
import { BusError, BusSubscription, decodePayload, loadClient, payloadText, type BusDestination, type BusDriver, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export type KafkaSasl =
  | { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string }
  /** SASL/OAUTHBEARER: a token from the provider (EZTest's OAuth client: client credentials, cached and refreshed). */
  | { mechanism: 'oauthbearer'; tokenProvider: { getToken(): Promise<string> }; extensions?: Record<string, string> }
  /** Amazon MSK IAM (AWS_MSK_IAM), signed with EZTest's SigV4. */
  | { mechanism: 'aws-msk-iam'; region: string; credentials: () => Promise<AwsCredentials> | AwsCredentials };

/** The kafkajs `sasl` option for EZTest's SASL settings. */
export function kafkajsSasl(s: KafkaSasl): Record<string, unknown> {
  switch (s.mechanism) {
    case 'oauthbearer':
      return { mechanism: 'oauthbearer', oauthBearerProvider: async () => ({ value: await s.tokenProvider.getToken(), ...(s.extensions ? { extensions: s.extensions } : {}) }) };
    case 'aws-msk-iam':
      return { mechanism: MSK_IAM_MECHANISM, authenticationProvider: mskIamAuthenticationProvider({ region: s.region, credentials: s.credentials }) };
    default:
      return { mechanism: s.mechanism, username: s.username, password: s.password };
  }
}

export interface KafkaOptions {
  brokers: string[];
  clientId?: string;
  /** true: TLS with the system roots; or tls options (ca, client cert + key, servername). */
  ssl?: boolean | TlsOptions;
  sasl?: KafkaSasl;
  /** Decode Confluent-framed values (Avro, Protobuf, JSON Schema) and encode "as Avro" publishes. */
  serde?: SchemaRegistrySerde;
  /** Group id prefix for test consumers (default "eztest"). */
  groupPrefix?: string;
  /** Create missing topics (default false: a missing topic is an error). */
  createTopics?: boolean;
  /** How long a consumer may take to join its group (default 15000 ms). */
  joinTimeoutMs?: number;
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
  /** This run's consumer group, and the topics each of its (numbered) groups is reading right now. */
  readonly groupId: string;
  private readonly groupsInUse = new Map<string, Set<string>>();
  private readonly groupsUsed = new Set<string>();
  private readonly knownTopics = new Set<string>();
  /** Problems met while cleaning up (e.g. a group the broker would not delete). */
  readonly closeWarnings: string[] = [];

  constructor(readonly name: string, readonly opts: KafkaOptions) {
    if (!opts.brokers?.length) throw new BusError(`messaging.brokers.${name}: kafka needs "brokers"`, 'CONFIG');
    this.groupId = `${opts.groupPrefix ?? 'eztest'}-${randomUUID()}`;
  }

  /** Make sure the topic exists: an error when it does not (or, with createTopics, create it). */
  private async ensureTopic(topic: string): Promise<void> {
    if (this.knownTopics.has(topic)) return;
    const admin = await this.adm();
    let topics: string[];
    try {
      topics = (await admin.listTopics()) as string[];
    } catch (e) {
      throw this.connectError(e);
    }
    if (!topics.includes(topic)) {
      if (!this.opts.createTopics) {
        throw new BusError(`Kafka topic "${topic}" does not exist on broker "${this.name}" (${this.opts.brokers.join(', ')}). Create it, or set createTopics: true on messaging.brokers.${this.name} to let EZTest create it.`, 'KAFKA_TOPIC_MISSING', { topic });
      }
      try {
        await admin.createTopics({ topics: [{ topic }], waitForLeaders: true });
      } catch (e) {
        throw new BusError(`Creating Kafka topic "${topic}" on broker "${this.name}" failed: ${(e as Error).message}`, 'KAFKA_TOPIC_CREATE', { topic });
      }
    }
    this.knownTopics.add(topic);
  }

  /** The run's group for a new subscription on `topic` (a numbered sibling when the run's group already reads it). */
  private takeGroup(topic: string): string {
    for (let n = 0; ; n++) {
      const g = n === 0 ? this.groupId : `${this.groupId}-${n + 1}`;
      const topics = this.groupsInUse.get(g) ?? new Set<string>();
      if (topics.has(topic)) continue;
      topics.add(topic);
      this.groupsInUse.set(g, topics);
      this.groupsUsed.add(g);
      return g;
    }
  }

  private releaseGroup(g: string, topic: string): void {
    this.groupsInUse.get(g)?.delete(topic);
  }

  private async lib(): Promise<Any> {
    if (this.kafka) return this.kafka;
    const k = (this.opts.client ?? (await loadClient('kafkajs', 'Kafka'))) as Any;
    this.kafka = new k.Kafka({
      clientId: this.opts.clientId ?? 'eztest',
      brokers: this.opts.brokers,
      ...(this.opts.ssl ? { ssl: this.opts.ssl === true ? true : { ...this.opts.ssl } } : {}),
      ...(this.opts.sasl ? { sasl: kafkajsSasl(this.opts.sasl) } : {}),
      connectionTimeout: this.opts.connectionTimeoutMs ?? 10_000,
      logLevel: k.logLevel?.NOTHING ?? 0,
      retry: { retries: 5, initialRetryTime: 200 },
    });
    return this.kafka;
  }

  /** A connection failure as EZTest reports it: authentication, TLS, or the broker not reachable. */
  private connectError(e: unknown): BusError {
    if (e instanceof BusError) return e;
    const m = (e as Error).message ?? String(e);
    const mech = this.opts.sasl?.mechanism;
    if (/SASL|authentication failed/i.test(m)) return new BusError(`Kafka broker "${this.name}" refused the ${mech ? mech.toUpperCase() : 'SASL'} credentials: ${m}`, 'BUS_AUTH');
    if (/certificate|self[- ]signed|unable to verify|handshake|ssl|tls|alert/i.test(m)) return new BusError(`TLS to Kafka broker "${this.name}" failed: ${m}`, 'BUS_TLS');
    // On a rejected token the broker closes the connection; kafkajs then only sees a broker it cannot reach.
    if (mech === 'oauthbearer' && /No brokers in the broker pool|Connection error|closed|ECONNRESET/i.test(m)) {
      return new BusError(`Kafka broker "${this.name}" closed the connection during SASL OAUTHBEARER authentication: the token was most likely rejected (check its audience, issuer, scope and signing key) (${m})`, 'BUS_AUTH');
    }
    return new BusError(`Cannot connect to Kafka broker "${this.name}" (${this.opts.brokers.join(', ')}): ${m}`, 'BUS_CONNECT');
  }

  private async prod(): Promise<Any> {
    if (this.producer) return this.producer;
    const p = (await this.lib()).producer({ allowAutoTopicCreation: !!this.opts.createTopics });
    try {
      await p.connect();
    } catch (e) {
      throw this.connectError(e);
    }
    this.producer = p;
    return p;
  }

  private async adm(): Promise<Any> {
    if (this.admin) return this.admin;
    const a = (await this.lib()).admin();
    try {
      await a.connect();
    } catch (e) {
      throw this.connectError(e);
    }
    this.admin = a;
    return a;
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    const headers: Record<string, string> = { ...(msg.headers ?? {}) };
    if (msg.correlationId) headers['correlation-id'] = msg.correlationId;
    if (msg.contentType) headers['content-type'] = msg.contentType;
    await this.ensureTopic(dest.name);
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
    await this.ensureTopic(dest.name);
    const admin = await this.adm();
    const offsets = (await admin.fetchTopicOffsetsByTimestamp(dest.name, from)) as Array<{ partition: number; offset: string }>;
    const groupId = this.takeGroup(dest.name);
    // Short fetch waits: the seek to the start time (below) applies once the fetch in flight returns.
    const consumer = kafka.consumer({ groupId, sessionTimeout: 10_000, heartbeatInterval: 1000, maxWaitTimeInMs: 250, retry: { retries: 3 } });
    this.consumers.add(consumer);
    const drop = async () => {
      this.consumers.delete(consumer);
      this.releaseGroup(groupId, dest.name);
      await consumer.disconnect().catch(() => undefined);
    };
    let seeked = false;
    const joined = new Promise<void>((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: dest.name, fromBeginning: false });
    } catch (e) {
      await drop();
      throw new BusError(`Kafka consumer for topic "${dest.name}" on broker "${this.name}" could not start: ${(e as Error).message}`, 'BUS_CONNECT');
    }
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: Any) => {
        if (!seeked) return;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((message.headers ?? {}) as Record<string, Any>)) headers[k] = Array.isArray(v) ? v.map((x) => payloadText(x)).join(',') : v === undefined || v === null ? '' : payloadText(v);
        const ts = Number(message.timestamp);
        if (ts < from) return;
        // Schema-registry framed values (magic byte 0 + schema id) are decoded to JSON for filters and captures.
        let body: { payload: string; binary?: boolean; format?: string; schemaId?: number; decodeError?: string } = decodePayload(message.value);
        if (this.opts.serde && message.value && message.value.length >= 5 && message.value[0] === 0) {
          try {
            const d = await this.opts.serde.decode(message.value);
            if (d) body = { payload: JSON.stringify(d.value), format: d.format, schemaId: d.schemaId };
          } catch (e) {
            body = { ...body, decodeError: (e as Error).message };
          }
        }
        sub.push({
          destination: topic, ...body, ...(message.key ? { key: payloadText(message.key) } : {}), headers,
          ...(headers['correlation-id'] ? { correlationId: headers['correlation-id'] } : {}),
          timestamp: ts, partition, offset: String(message.offset),
        });
      },
    });
    const joinMs = this.opts.joinTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([joined.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), joinMs); })]);
    clearTimeout(timer);
    if (!ok) {
      await drop();
      throw new BusError(`Kafka consumer for topic "${dest.name}" did not join consumer group "${groupId}" within ${joinMs} ms (is the group coordinator of broker "${this.name}" reachable?); no message could be read`, 'KAFKA_JOIN_TIMEOUT', { topic: dest.name, groupId });
    }
    for (const o of offsets) consumer.seek({ topic: dest.name, partition: o.partition, offset: o.offset });
    seeked = true;
    sub.onClose = drop;
    return sub;
  }

  /** The consumer groups this driver created (deleted on close). */
  consumerGroups(): string[] {
    return [...this.groupsUsed];
  }

  async close(): Promise<void> {
    for (const c of this.consumers) await c.disconnect().catch(() => undefined);
    this.consumers.clear();
    // The run's consumer groups go with it (they never committed offsets, but the broker keeps them listed).
    if (this.groupsUsed.size) {
      try {
        await (await this.adm()).deleteGroups([...this.groupsUsed]);
        this.groupsUsed.clear();
      } catch (e) {
        const groups = ((e as { groups?: Array<{ groupId: string; errorCode?: number; error?: { message?: string } }> }).groups ?? []);
        const left = groups.filter((g) => g.errorCode && g.errorCode !== 69 /* GROUP_ID_NOT_FOUND */);
        if (left.length || !groups.length) this.closeWarnings.push(`Kafka broker "${this.name}" did not delete consumer group(s) ${[...this.groupsUsed].join(', ')}: ${(e as Error).message}`);
      }
    }
    await this.producer?.disconnect().catch(() => undefined);
    await this.admin?.disconnect().catch(() => undefined);
    this.producer = undefined;
    this.admin = undefined;
  }
}
