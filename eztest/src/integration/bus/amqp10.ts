/**
 * AMQP 1.0 bus driver (`type: amqp10`) on EZTest's own AMQP 1.0 client
 * (src/integration/bus/amqp10-client.ts): RabbitMQ 4 (native AMQP 1.0),
 * ActiveMQ Artemis, Azure Service Bus (SAS tokens over CBS) and Solace.
 * Publishing waits for the broker's outcome (accepted, or the rejection
 * reason). Waiting on a queue consumes from it and settles only the messages
 * a step matched; the others are released back to the queue when the
 * listener closes. Broker address conventions are applied per `addressing`.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Amqp10Connection, Amqp10Error, createSasToken, putToken, type Amqp10Delivery, type Amqp10Message, type Amqp10Receiver, type Amqp10Sender, type Amqp10Session } from './amqp10-client.js';
import type { AmqpValue } from './amqp10-codec.js';
import { BusError, BusSubscription, decodePayload, type BusDestination, type BusDriver, type BusMessage, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export type Amqp10Addressing = 'plain' | 'rabbitmq' | 'artemis' | 'servicebus' | 'solace';

export interface Amqp10Options {
  /** amqp://user:pass@host:5672 or amqps://... (TLS). */
  url: string;
  /** How queue/topic/exchange names become AMQP addresses (default "plain": the name as given). */
  addressing?: Amqp10Addressing;
  /** open.hostname: the virtual host (RabbitMQ "vhost:/"); default the URL host (RabbitMQ: vhost:/ unless a path names one). */
  hostname?: string;
  /** SASL mechanism (default PLAIN with credentials, ANONYMOUS without; SAS uses ANONYMOUS + CBS). */
  sasl?: 'PLAIN' | 'ANONYMOUS' | 'EXTERNAL';
  username?: string;
  password?: string;
  /** TLS: CA bundle (PEM file), client certificate and key (PEM files, for EXTERNAL), certificate checks. */
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  /** Azure Service Bus / Event Hubs: Shared Access Signature key (a CBS put-token is sent for each entity). */
  sas?: { keyName: string; sharedAccessKey: string; ttlSeconds?: number };
  /** Message body section: "data" (bytes, default) or "value" (an AMQP string: JMS TextMessage on Artemis). */
  body?: 'data' | 'value';
  /** Link credit for listeners (default 100). */
  credit?: number;
  /** Pre-settled publishing (no outcome). Default false. */
  presettled?: boolean;
}

const enc = encodeURIComponent;

export class Amqp10BusDriver implements BusDriver {
  readonly kind = 'amqp10' as const;
  private conn?: Promise<Amqp10Connection>;
  private pubSession?: Promise<Amqp10Session>;
  private readonly senders = new Map<string, Promise<Amqp10Sender>>();
  private readonly subs = new Set<BusSubscription>();
  private readonly authorised = new Set<string>();
  readonly url: URL;

  constructor(readonly name: string, readonly opts: Amqp10Options) {
    if (!opts.url) throw new BusError(`messaging.brokers.${name}: amqp10 needs "url"`, 'CONFIG');
    try {
      this.url = new URL(opts.url);
    } catch {
      throw new BusError(`messaging.brokers.${name}: "${opts.url}" is not a URL (amqp://host:5672 or amqps://host:5671)`, 'CONFIG');
    }
    if (!/^amqps?:$/.test(this.url.protocol)) throw new BusError(`messaging.brokers.${name}: use an amqp:// or amqps:// URL`, 'CONFIG');
  }

  private get addressing(): Amqp10Addressing {
    return this.opts.addressing ?? 'plain';
  }

  /** The AMQP address (and terminus capabilities) of a destination. */
  address(dest: BusDestination): { address: string; capabilities?: string[] } {
    const n = dest.name;
    switch (this.addressing) {
      case 'rabbitmq':
        // RabbitMQ 4 address format v2.
        if (dest.type === 'queue') return { address: `/queues/${enc(n)}` };
        if (dest.type === 'exchange') return { address: dest.routingKey !== undefined ? `/exchanges/${enc(n)}/${enc(dest.routingKey)}` : `/exchanges/${enc(n)}` };
        return { address: `/exchanges/amq.topic/${enc(n)}` };
      case 'artemis':
      case 'solace':
        return { address: n, capabilities: [dest.type === 'queue' ? 'queue' : 'topic'] };
      default:
        return { address: n };
    }
  }

  private connection(): Promise<Amqp10Connection> {
    if (!this.conn) {
      this.conn = this.open().catch((e) => {
        this.conn = undefined;
        throw e;
      });
    }
    return this.conn;
  }

  private async open(): Promise<Amqp10Connection> {
    const u = this.url;
    const tls = u.protocol === 'amqps:';
    const username = this.opts.username ?? (u.username ? decodeURIComponent(u.username) : undefined);
    const password = this.opts.password ?? (u.password ? decodeURIComponent(u.password) : undefined);
    const vhostPath = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const hostname = this.opts.hostname ?? (this.addressing === 'rabbitmq' ? `vhost:${vhostPath || '/'}` : u.hostname);
    const mechanism = this.opts.sasl ?? (this.opts.sas ? 'ANONYMOUS' : username !== undefined ? 'PLAIN' : 'ANONYMOUS');
    try {
      const conn = await Amqp10Connection.connect({
        host: u.hostname, port: u.port ? Number(u.port) : tls ? 5671 : 5672, hostname,
        sasl: { mechanism, ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) },
        ...(tls ? { tls: {
          ...(this.opts.ca ? { ca: readFileSync(this.opts.ca) } : {}), ...(this.opts.cert ? { cert: readFileSync(this.opts.cert) } : {}), ...(this.opts.key ? { key: readFileSync(this.opts.key) } : {}),
          ...(this.opts.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
        } } : {}),
      });
      conn.on('error', (e: Error) => {
        this.conn = undefined;
        this.pubSession = undefined;
        this.senders.clear();
        this.authorised.clear();
        for (const s of this.subs) s.fail(this.brokerError(e, 'the connection'));
      });
      return conn;
    } catch (e) {
      throw this.brokerError(e, 'connecting', undefined, true);
    }
  }

  /** EZTest's message for a broker error: refused credentials, a missing address, or what the broker said. */
  private brokerError(e: unknown, what: string, address?: string, connecting = false): BusError {
    const err = e as Amqp10Error;
    const cond = err.condition ?? '';
    const msg = err.message ?? String(e);
    if (cond === 'amqp:unauthorized-access' || /unauthori[sz]ed|authentication|access.refused|forbidden/i.test(msg)) {
      return new BusError(`AMQP 1.0 broker "${this.name}" refused ${what}: ${msg}. Check the credentials and permissions of messaging.brokers.${this.name}.`, 'BUS_AUTH', address ? { address } : undefined);
    }
    if (cond === 'amqp:not-found' || /not.found|no (?:queue|exchange|such)/i.test(msg)) {
      return new BusError(`Address "${address ?? '?'}" does not exist on AMQP 1.0 broker "${this.name}" (${msg}). Create the queue or topic first (the application normally does), or check messaging.brokers.${this.name}.addressing.`, 'AMQP10_NOT_FOUND', address ? { address } : undefined);
    }
    if (connecting) return new BusError(`Cannot connect to AMQP 1.0 broker "${this.name}" (${this.url.host}): ${msg}`, 'BUS_CONNECT');
    return new BusError(`AMQP 1.0 broker "${this.name}": ${what} failed: ${msg}`, 'BUS_ERROR', address ? { address } : undefined);
  }

  private async session(): Promise<Amqp10Session> {
    const existing = this.pubSession ? await this.pubSession.catch(() => undefined) : undefined;
    if (existing && !existing.ended) return existing;
    this.senders.clear();
    this.pubSession = (async () => (await this.connection()).createSession())();
    this.pubSession.catch(() => (this.pubSession = undefined));
    return this.pubSession;
  }

  /** Azure: a CBS put-token for the entity before links to it are attached. */
  private async authorise(session: Amqp10Session, address: string): Promise<void> {
    const sas = this.opts.sas;
    if (!sas) return;
    const entity = address.replace(/^\/+/, '');
    const audience = `sb://${this.url.hostname}/${entity}`;
    if (this.authorised.has(audience)) return;
    const token = createSasToken(audience, sas.keyName, sas.sharedAccessKey, sas.ttlSeconds ?? 3600);
    await putToken(session, audience, token, { expiresAt: new Date(Date.now() + (sas.ttlSeconds ?? 3600) * 1000) });
    this.authorised.add(audience);
  }

  private async sender(address: string, capabilities?: string[]): Promise<Amqp10Sender> {
    let s = this.senders.get(address);
    if (s) {
      const ready = await s.catch(() => undefined);
      if (ready && !ready.detached && !ready.error && !ready.session.ended) return ready;
      this.senders.delete(address);
    }
    s = (async () => {
      const session = await this.session();
      await this.authorise(session, address);
      return session.createSender(address, { ...(capabilities ? { capabilities } : {}), ...(this.opts.presettled ? { settle: 'settled' } : {}) });
    })();
    this.senders.set(address, s);
    s.catch(() => this.senders.delete(address));
    return s;
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    const { address, capabilities } = this.address(dest);
    const messageId = randomUUID();
    const bytes = Buffer.from(typeof msg.payload === 'string' ? Buffer.from(msg.payload, 'utf8') : msg.payload);
    const text = typeof msg.payload === 'string' ? msg.payload : undefined;
    const message: Amqp10Message = {
      header: { durable: true },
      properties: {
        messageId, creationTime: new Date(), ...(msg.correlationId ? { correlationId: msg.correlationId } : {}), ...(msg.key ? { subject: msg.key } : {}),
        contentType: msg.contentType ?? (/^\s*[{[]/.test(text ?? '') ? 'application/json' : 'text/plain'),
      },
      ...(msg.headers && Object.keys(msg.headers).length ? { applicationProperties: msg.headers as Record<string, AmqpValue> } : {}),
      body: this.opts.body === 'value' && text !== undefined ? { type: 'value', value: text } : { type: 'data', data: bytes },
    };
    let sender: Amqp10Sender;
    try {
      sender = await this.sender(address, capabilities);
    } catch (e) {
      throw this.brokerError(e, `opening a link to "${address}"`, address);
    }
    let outcome;
    try {
      outcome = await sender.send(message);
    } catch (e) {
      this.senders.delete(address);
      throw this.brokerError(e, `publishing to "${address}"`, address);
    }
    if (outcome.state === 'rejected') throw new BusError(`AMQP 1.0 broker "${this.name}" rejected the message for "${address}": ${outcome.error?.message ?? 'no reason given'}`, 'AMQP10_REJECTED', { address });
    if (outcome.state !== 'accepted') throw new BusError(`AMQP 1.0 broker "${this.name}" did not take the message for "${address}" (${outcome.state}): nothing routes it there, or the destination is full`, 'AMQP10_NOT_DELIVERED', { address });
    return { messageId };
  }

  async subscribe(dest: BusDestination, opts: SubscribeOptions = {}): Promise<BusSubscription> {
    if (this.addressing === 'rabbitmq' && dest.type !== 'queue') {
      throw new BusError('RabbitMQ receives AMQP 1.0 messages from queues: bind a queue to the exchange and wait on "queue ..."', 'BUS_DESTINATION');
    }
    const { address, capabilities } = this.address(dest);
    const conn = await this.connection();
    let session: Amqp10Session;
    let receiver: Amqp10Receiver;
    try {
      session = await conn.createSession();
      await this.authorise(session, address);
      receiver = await session.createReceiver(address, { credit: this.opts.credit ?? 100, ...(capabilities ? { capabilities } : {}) });
    } catch (e) {
      throw this.brokerError(e, `listening on "${address}"`, address);
    }
    const sub = new BusSubscription(dest);
    this.subs.add(sub);
    // Messages on a queue are only taken when a step matched them; topic subscriptions are private.
    const shared = dest.type === 'queue';
    const deliveries = new Map<BusMessage, Amqp10Delivery>();
    receiver.on('message', (d: Amqp10Delivery) => {
      const m = d.message;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.applicationProperties ?? {})) headers[k] = Buffer.isBuffer(v) ? v.toString('utf8') : v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      const body = m.body;
      const payload = !body ? decodePayload('') : body.type === 'data' ? decodePayload(body.data) : body.type === 'value'
        ? (Buffer.isBuffer(body.value) ? decodePayload(body.value) : typeof body.value === 'string' ? { payload: body.value } : { payload: JSON.stringify(body.value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) })
        : { payload: JSON.stringify(body.items) };
      const p = m.properties ?? {};
      const routingKey = m.messageAnnotations?.['x-routing-key'];
      const bm: BusMessage = {
        destination: dest.name, ...payload, headers,
        ...(p.correlationId !== undefined ? { correlationId: String(p.correlationId) } : {}), ...(p.messageId !== undefined ? { messageId: String(p.messageId) } : {}),
        ...(p.subject ? { key: p.subject } : {}), ...(routingKey != null ? { routingKey: String(routingKey) } : {}),
        timestamp: p.creationTime instanceof Date ? p.creationTime.getTime() : Date.now(),
      };
      if (d.settled) {
        // nothing to settle
      } else if (!shared || opts.consumeMatched === false) receiver.settle(d.id, 'accepted');
      else deliveries.set(bm, d);
      sub.push(bm);
    });
    receiver.on('error', (e: Error) => sub.fail(this.brokerError(e, `listening on "${address}"`, address)));
    receiver.on('detached', (e: Error) => {
      if (!sub.closed) sub.fail(this.brokerError(e, `listening on "${address}"`, address));
    });
    sub.onTake = (bm) => {
      const d = deliveries.get(bm);
      if (d) {
        receiver.settle(d.id, 'accepted');
        deliveries.delete(bm);
      }
    };
    sub.onClose = async () => {
      this.subs.delete(sub);
      // Messages nobody matched go back to the queue for the application (or the next step).
      for (const d of deliveries.values()) receiver.settle(d.id, 'released');
      deliveries.clear();
      await receiver.close().catch(() => undefined);
      await session.end().catch(() => undefined);
    };
    return sub;
  }

  /** Remove waiting messages: receive and accept until the queue stays quiet for 300 ms. */
  async purge(dest: BusDestination): Promise<number | undefined> {
    const sub = await this.subscribe(dest, { consumeMatched: false });
    try {
      let last = -1;
      while (last !== sub.messages.length) {
        last = sub.messages.length;
        await new Promise((r) => setTimeout(r, 300));
      }
      return sub.messages.length;
    } finally {
      await sub.close();
    }
  }

  async close(): Promise<void> {
    for (const s of [...this.subs]) await s.close().catch(() => undefined);
    for (const s of this.senders.values()) await (await s.catch(() => undefined))?.close().catch(() => undefined);
    this.senders.clear();
    const c = this.conn ? await this.conn.catch(() => undefined) : undefined;
    this.conn = undefined;
    this.pubSession = undefined;
    await c?.close().catch(() => undefined);
  }
}
