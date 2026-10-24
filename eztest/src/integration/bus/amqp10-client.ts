/**
 * An AMQP 1.0 client written from the OASIS AMQP 1.0 specification:
 *  - Part 2 (Transport): protocol header exchange, framing, open, begin,
 *    attach, flow, transfer (multi-frame), disposition, detach, end, close,
 *    session windows and link credit, idle-timeout heartbeats;
 *  - Part 3 (Messaging): message sections (header, delivery and message
 *    annotations, properties, application properties, data, amqp-sequence,
 *    amqp-value, footer), source/target terminus, delivery states (accepted,
 *    rejected, released, modified);
 *  - Part 5 (Security): SASL PLAIN, ANONYMOUS and EXTERNAL, and TLS (amqps);
 *  - the AMQP Claims-Based Security draft (CBS put-token), as used by Azure
 *    Service Bus and Event Hubs with SAS tokens.
 * No third-party AMQP library is used.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import {
  binary, Described, decode, descriptorOf, described, isDescribed, list, map, Reader, sym, symMap, timestamp, ubyte, uint, ulong, ushort, encode, array,
  type AmqpValue,
} from './amqp10-codec.js';

// Performative and section descriptor codes (Part 2.7, 2.8, 3.2, 3.4, 5.3).
export const CODES = {
  open: 0x10, begin: 0x11, attach: 0x12, flow: 0x13, transfer: 0x14, disposition: 0x15, detach: 0x16, end: 0x17, close: 0x18,
  error: 0x1d, received: 0x23, accepted: 0x24, rejected: 0x25, released: 0x26, modified: 0x27, source: 0x28, target: 0x29,
  header: 0x70, deliveryAnnotations: 0x71, messageAnnotations: 0x72, properties: 0x73, applicationProperties: 0x74, data: 0x75, amqpSequence: 0x76, amqpValue: 0x77, footer: 0x78,
  saslMechanisms: 0x40, saslInit: 0x41, saslChallenge: 0x42, saslResponse: 0x43, saslOutcome: 0x44,
} as const;

const AMQP_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0x00, 0x01, 0x00, 0x00]);
const SASL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0x03, 0x01, 0x00, 0x00]);

export class Amqp10Error extends Error {
  constructor(message: string, readonly condition?: string, readonly description?: string) {
    super(message);
    this.name = 'Amqp10Error';
  }
}

// ------------------------------------------------------------------ messages

export interface Amqp10Message {
  header?: { durable?: boolean; priority?: number; ttl?: number; firstAcquirer?: boolean; deliveryCount?: number };
  deliveryAnnotations?: Record<string, AmqpValue>;
  messageAnnotations?: Record<string, AmqpValue>;
  properties?: {
    messageId?: string | number | Buffer;
    userId?: Buffer;
    to?: string;
    subject?: string;
    replyTo?: string;
    correlationId?: string | number | Buffer;
    contentType?: string;
    contentEncoding?: string;
    absoluteExpiryTime?: Date;
    creationTime?: Date;
    groupId?: string;
    groupSequence?: number;
    replyToGroupId?: string;
  };
  applicationProperties?: Record<string, AmqpValue>;
  /** data: opaque bytes; value: one AMQP value; sequence: a list of AMQP values. */
  body?: { type: 'data'; data: Buffer } | { type: 'value'; value: AmqpValue } | { type: 'sequence'; items: AmqpValue[] };
  footer?: Record<string, AmqpValue>;
}

function trimNulls(items: AmqpValue[]): AmqpValue[] {
  let n = items.length;
  while (n > 0 && (items[n - 1] === null || items[n - 1] === undefined)) n--;
  return items.slice(0, n);
}

const msgId = (v: string | number | Buffer | undefined): AmqpValue => (v === undefined ? null : typeof v === 'number' ? ulong(v) : Buffer.isBuffer(v) ? binary(v) : v);

/** Encode a message as its sections (the payload of a transfer). */
export function encodeMessage(m: Amqp10Message): Buffer {
  const parts: Buffer[] = [];
  if (m.header) {
    const h = m.header;
    parts.push(encode(described(CODES.header, list(trimNulls([h.durable ?? null, h.priority !== undefined ? ubyte(h.priority) : null, h.ttl !== undefined ? uint(h.ttl) : null, h.firstAcquirer ?? null, h.deliveryCount !== undefined ? uint(h.deliveryCount) : null])))));
  }
  if (m.deliveryAnnotations) parts.push(encode(described(CODES.deliveryAnnotations, symMap(m.deliveryAnnotations))));
  if (m.messageAnnotations) parts.push(encode(described(CODES.messageAnnotations, symMap(m.messageAnnotations))));
  if (m.properties) {
    const p = m.properties;
    parts.push(encode(described(CODES.properties, list(trimNulls([
      msgId(p.messageId), p.userId ? binary(p.userId) : null, p.to ?? null, p.subject ?? null, p.replyTo ?? null, msgId(p.correlationId),
      p.contentType ? sym(p.contentType) : null, p.contentEncoding ? sym(p.contentEncoding) : null,
      p.absoluteExpiryTime ? timestamp(p.absoluteExpiryTime) : null, p.creationTime ? timestamp(p.creationTime) : null,
      p.groupId ?? null, p.groupSequence !== undefined ? uint(p.groupSequence) : null, p.replyToGroupId ?? null,
    ])))));
  }
  if (m.applicationProperties) parts.push(encode(described(CODES.applicationProperties, map(Object.entries(m.applicationProperties).map(([k, v]) => [k, v])))));
  const body = m.body ?? { type: 'value' as const, value: null };
  if (body.type === 'data') parts.push(encode(described(CODES.data, binary(body.data))));
  else if (body.type === 'sequence') parts.push(encode(described(CODES.amqpSequence, list(body.items))));
  else parts.push(encode(described(CODES.amqpValue, body.value)));
  if (m.footer) parts.push(encode(described(CODES.footer, symMap(m.footer))));
  return Buffer.concat(parts);
}

/** Decode the sections of a received message. */
export function decodeMessage(payload: Buffer): Amqp10Message {
  const m: Amqp10Message = {};
  const r = new Reader(payload);
  const datas: Buffer[] = [];
  const seqs: AmqpValue[] = [];
  while (r.pos < payload.length) {
    const v = r.read();
    if (!isDescribed(v)) throw new Amqp10Error('Message section is not a described type');
    const code = descriptorOf(v);
    const body = v.value as AmqpValue;
    switch (code) {
      case CODES.header: {
        const [durable, priority, ttl, firstAcquirer, deliveryCount] = (body as AmqpValue[]) ?? [];
        m.header = { ...(durable != null ? { durable: Boolean(durable) } : {}), ...(priority != null ? { priority: Number(priority) } : {}), ...(ttl != null ? { ttl: Number(ttl) } : {}), ...(firstAcquirer != null ? { firstAcquirer: Boolean(firstAcquirer) } : {}), ...(deliveryCount != null ? { deliveryCount: Number(deliveryCount) } : {}) };
        break;
      }
      case CODES.deliveryAnnotations: m.deliveryAnnotations = (body ?? {}) as Record<string, AmqpValue>; break;
      case CODES.messageAnnotations: m.messageAnnotations = (body ?? {}) as Record<string, AmqpValue>; break;
      case CODES.properties: {
        const f = ((body as AmqpValue[]) ?? []) as unknown[];
        const s = (x: unknown) => (x === null || x === undefined ? undefined : x);
        const props: NonNullable<Amqp10Message['properties']> = {};
        const set = <K extends keyof typeof props>(k: K, val: unknown) => {
          if (s(val) !== undefined) props[k] = val as (typeof props)[K];
        };
        set('messageId', f[0]);
        set('userId', f[1]);
        set('to', f[2]);
        set('subject', f[3]);
        set('replyTo', f[4]);
        set('correlationId', f[5]);
        set('contentType', f[6]);
        set('contentEncoding', f[7]);
        set('absoluteExpiryTime', f[8]);
        set('creationTime', f[9]);
        set('groupId', f[10]);
        set('groupSequence', f[11]);
        set('replyToGroupId', f[12]);
        m.properties = props;
        break;
      }
      case CODES.applicationProperties: m.applicationProperties = (body ?? {}) as Record<string, AmqpValue>; break;
      case CODES.data: datas.push(body as Buffer); break;
      case CODES.amqpSequence: seqs.push(...((body as AmqpValue[]) ?? [])); break;
      case CODES.amqpValue: m.body = { type: 'value', value: body }; break;
      case CODES.footer: m.footer = (body ?? {}) as Record<string, AmqpValue>; break;
      default: throw new Amqp10Error(`Unknown message section 0x${Number(code).toString(16)}`);
    }
  }
  if (datas.length) m.body = { type: 'data', data: Buffer.concat(datas) };
  else if (seqs.length) m.body = { type: 'sequence', items: seqs };
  return m;
}

// ------------------------------------------------------------------ frames

export interface Frame {
  type: number;
  channel: number;
  /** Performative code (undefined for an empty heartbeat frame). */
  code?: number;
  fields: AmqpValue[];
  payload: Buffer;
}

export function encodeFrame(type: number, channel: number, performative?: Described, payload?: Buffer): Buffer {
  const body = performative ? encode(performative) : Buffer.alloc(0);
  const size = 8 + body.length + (payload?.length ?? 0);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head[4] = 2; // DOFF: 2 x 4 bytes, no extended header
  head[5] = type;
  head.writeUInt16BE(channel, 6);
  return Buffer.concat(payload ? [head, body, payload] : [head, body]);
}

/** Incremental frame reader: protocol headers and frames from a byte stream. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  expectHeader = true;
  maxFrameSize = 4 * 1024 * 1024;

  push(chunk: Buffer, onHeader: (h: Buffer) => void, onFrame: (f: Frame) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.expectHeader) {
        if (this.buf.length < 8) return;
        const h = this.buf.subarray(0, 8);
        this.buf = this.buf.subarray(8);
        this.expectHeader = false;
        onHeader(Buffer.from(h));
        continue;
      }
      if (this.buf.length < 8) return;
      const size = this.buf.readUInt32BE(0);
      if (size < 8 || size > this.maxFrameSize) throw new Amqp10Error(`Invalid frame size ${size}`, 'amqp:connection:framing-error');
      if (this.buf.length < size) return;
      const doff = this.buf[4] * 4;
      const type = this.buf[5];
      const channel = this.buf.readUInt16BE(6);
      const body = this.buf.subarray(doff, size);
      this.buf = this.buf.subarray(size);
      if (!body.length) {
        onFrame({ type, channel, fields: [], payload: Buffer.alloc(0) });
        continue;
      }
      const { value, end } = decode(Buffer.from(body));
      if (!isDescribed(value)) throw new Amqp10Error('Frame body is not a performative', 'amqp:connection:framing-error');
      onFrame({ type, channel, code: Number(descriptorOf(value)), fields: (value.value as AmqpValue[]) ?? [], payload: Buffer.from(body.subarray(end)) });
    }
  }
}

// ------------------------------------------------------------------ connection

export interface SaslOptions {
  mechanism?: 'PLAIN' | 'ANONYMOUS' | 'EXTERNAL';
  username?: string;
  password?: string;
}

export interface Amqp10ConnectOptions {
  host: string;
  port?: number;
  /** TLS (amqps): true or node:tls options (ca, servername, rejectUnauthorized, cert/key for EXTERNAL). */
  tls?: boolean | ConnectionOptions;
  /** SASL; false for a broker that accepts plain AMQP without SASL. Default: PLAIN with credentials, else ANONYMOUS. */
  sasl?: SaslOptions | false;
  /** open.hostname (and SASL hostname): the virtual host, e.g. "vhost:/" for RabbitMQ. Default: host. */
  hostname?: string;
  containerId?: string;
  maxFrameSize?: number;
  /** Idle timeout we announce (ms); the peer sends heartbeats within it. Default 60000. */
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

type Waiter = { resolve: (f: Frame) => void; reject: (e: Error) => void };

export class Amqp10Connection extends EventEmitter {
  private socket!: Socket;
  private readonly reader = new FrameReader();
  private remoteMaxFrame = 512;
  private heartbeat?: NodeJS.Timeout;
  private readonly sessions = new Map<number, Amqp10Session>();
  private closing = false;
  closed = false;
  error?: Error;
  remoteOpen: AmqpValue[] = [];
  private frameWaiters: Array<{ match: (f: Frame) => boolean } & Waiter> = [];
  private readonly backlog: Frame[] = [];
  private headerWaiter?: Waiter & { resolve: (h: never) => void };
  readonly containerId: string;
  readonly maxFrameSize: number;

  private constructor(readonly opts: Amqp10ConnectOptions) {
    super();
    this.containerId = opts.containerId ?? `eztest-${randomUUID()}`;
    this.maxFrameSize = opts.maxFrameSize ?? 256 * 1024;
  }

  /** Connect, authenticate (SASL), open the connection. */
  static async connect(opts: Amqp10ConnectOptions): Promise<Amqp10Connection> {
    const c = new Amqp10Connection(opts);
    try {
      await c.start();
    } catch (e) {
      c.closing = true;
      c.closed = true;
      clearInterval(c.heartbeat);
      c.socket?.destroy();
      throw e;
    }
    return c;
  }

  get frameLimit(): number {
    return Math.min(this.maxFrameSize, this.remoteMaxFrame);
  }

  private async start(): Promise<void> {
    const o = this.opts;
    const port = o.port ?? (o.tls ? 5671 : 5672);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy();
        reject(new Amqp10Error(`Connection to ${o.host}:${port} timed out`));
      }, o.connectTimeoutMs ?? 10_000);
      const done = (e?: Error) => {
        clearTimeout(timer);
        if (e) reject(e);
        else resolve();
      };
      if (o.tls) {
        const t = typeof o.tls === 'object' ? o.tls : {};
        this.socket = tlsConnect({ host: o.host, port, servername: /^\d+\.\d+\.\d+\.\d+$/.test(o.host) ? undefined : o.host, ...t }, () => done());
      } else this.socket = netConnect({ host: o.host, port }, () => done());
      this.socket.once('error', (e) => done(e));
    });
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: Buffer) => {
      try {
        this.reader.push(chunk, (h) => this.onHeader(h), (f) => this.onFrame(f));
      } catch (e) {
        this.fail(e as Error);
      }
    });
    this.socket.on('error', (e) => this.fail(e));
    this.socket.on('close', () => {
      if (!this.closed) this.fail(new Amqp10Error('Connection closed by the peer'));
    });
    if (o.sasl !== false) await this.saslHandshake(o.sasl ?? {});
    this.write(AMQP_HEADER);
    const h = await this.nextHeader();
    if (!h.equals(AMQP_HEADER)) throw new Amqp10Error(`Peer answered with protocol header ${h.toString('hex')} (not AMQP 1.0)`);
    this.send(0, described(CODES.open, list(trimNulls([
      this.containerId, o.hostname ?? o.host, uint(this.maxFrameSize), ushort(255), uint(o.idleTimeoutMs ?? 60_000),
    ]))));
    const open = await this.waitFrame((f) => f.code === CODES.open || f.code === CODES.close);
    if (open.code === CODES.close) throw errorFrom(open.fields[0], 'The broker refused the connection');
    this.remoteOpen = open.fields;
    this.remoteMaxFrame = open.fields[2] != null ? Number(open.fields[2]) : 4294967295;
    this.reader.maxFrameSize = this.maxFrameSize;
    const idle = open.fields[4] != null ? Number(open.fields[4]) : 0;
    if (idle > 0) {
      // Send an empty frame well within the peer's idle timeout (Part 2.4.5).
      this.heartbeat = setInterval(() => this.write(encodeFrame(0, 0)), Math.max(500, Math.floor(idle / 2)));
      this.heartbeat.unref();
    }
  }

  private async saslHandshake(s: SaslOptions): Promise<void> {
    this.write(SASL_HEADER);
    const h = await this.nextHeader();
    if (!h.equals(SASL_HEADER)) throw new Amqp10Error(`Peer does not offer SASL (header ${h.toString('hex')})`);
    const mechs = await this.waitFrame((f) => f.type === 1 && f.code === CODES.saslMechanisms);
    const offered = ([] as unknown[]).concat(mechs.fields[0] ?? []).map(String);
    const mechanism = s.mechanism ?? (s.username !== undefined ? 'PLAIN' : 'ANONYMOUS');
    if (!offered.includes(mechanism)) throw new Amqp10Error(`The broker does not offer SASL ${mechanism} (offers: ${offered.join(', ') || 'none'})`, 'amqp:unauthorized-access');
    const initial = mechanism === 'PLAIN' ? Buffer.from(`\0${s.username ?? ''}\0${s.password ?? ''}`, 'utf8') : mechanism === 'ANONYMOUS' ? Buffer.from('anonymous') : Buffer.alloc(0);
    this.write(encodeFrame(1, 0, described(CODES.saslInit, list([sym(mechanism), binary(initial), this.opts.hostname ?? this.opts.host]))));
    const outcome = await this.waitFrame((f) => f.type === 1 && (f.code === CODES.saslOutcome || f.code === CODES.saslChallenge));
    if (outcome.code === CODES.saslChallenge) throw new Amqp10Error(`SASL ${mechanism}: unexpected challenge`);
    const code = Number(outcome.fields[0]);
    if (code !== 0) {
      const why = ['ok', 'authentication failed (wrong user name or password)', 'system error', 'permanent system error', 'temporary system error'][code] ?? `code ${code}`;
      throw new Amqp10Error(`SASL ${mechanism} ${why}`, 'amqp:unauthorized-access');
    }
  }

  private earlyHeader?: Buffer;
  private nextHeader(): Promise<Buffer> {
    if (this.earlyHeader) {
      const h = this.earlyHeader;
      this.earlyHeader = undefined;
      return Promise.resolve(h);
    }
    return new Promise((resolve, reject) => {
      this.headerWaiter = { resolve: resolve as never, reject };
    });
  }

  private onHeader(h: Buffer) {
    const w = this.headerWaiter;
    this.headerWaiter = undefined;
    if (w) w.resolve(h as never);
    else this.earlyHeader = h;
  }

  waitFrame(match: (f: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    if (this.error) return Promise.reject(this.error);
    const early = this.backlog.findIndex(match);
    if (early >= 0) return Promise.resolve(this.backlog.splice(early, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve: (f: Frame) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((x) => x !== w);
        reject(new Amqp10Error('Timed out waiting for the broker'));
      }, timeoutMs);
      timer.unref();
      this.frameWaiters.push(w);
    });
  }

  private onFrame(f: Frame) {
    if (f.code === undefined) return; // heartbeat
    // After a successful SASL outcome the next bytes are the AMQP protocol header (possibly in this packet).
    if (f.type === 1 && f.code === CODES.saslOutcome && Number(f.fields[0]) === 0) this.reader.expectHeader = true;
    const w = this.frameWaiters.find((x) => x.match(f));
    if (w) {
      this.frameWaiters = this.frameWaiters.filter((x) => x !== w);
      w.resolve(f);
      if (f.code === CODES.open || f.type === 1) return;
    }
    // Handshake frames that arrive before anyone waits for them (same packet as the header) are kept.
    if (f.type === 1 || f.code === CODES.open) {
      if (!w) this.backlog.push(f);
      return;
    }
    if (f.code === CODES.close) {
      const err = f.fields[0] ? errorFrom(f.fields[0], 'The broker closed the connection') : undefined;
      if (!this.closing) this.send(0, described(CODES.close, list([])));
      this.closed = true;
      this.fail(err ?? new Amqp10Error('The broker closed the connection'), true);
      this.socket.end();
      return;
    }
    if (f.code === CODES.begin) {
      const local = f.fields[0];
      const s = local != null ? this.sessions.get(Number(local)) : undefined;
      s?.onBegin(f);
      return;
    }
    for (const s of this.sessions.values()) if (s.remoteChannel === f.channel) s.onFrame(f);
  }

  private fail(e: Error, closedByPeer = false) {
    if (this.error && !closedByPeer) return;
    this.error ??= e;
    clearInterval(this.heartbeat);
    for (const w of this.frameWaiters) w.reject(e);
    this.frameWaiters = [];
    this.headerWaiter?.reject(e);
    this.headerWaiter = undefined;
    for (const s of this.sessions.values()) s.onConnectionError(e);
    if (!this.closing && this.listenerCount('error')) this.emit('error', e);
  }

  write(b: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(b);
  }

  send(channel: number, performative: Described, payload?: Buffer): void {
    this.write(encodeFrame(0, channel, performative, payload));
  }

  /** Begin a session. */
  async createSession(o: { incomingWindow?: number; outgoingWindow?: number } = {}): Promise<Amqp10Session> {
    if (this.error) throw this.error;
    let ch = 0;
    while (this.sessions.has(ch)) ch++;
    const s = new Amqp10Session(this, ch, o.incomingWindow ?? 2048, o.outgoingWindow ?? 2048);
    this.sessions.set(ch, s);
    await s.begin();
    return s;
  }

  removeSession(ch: number): void {
    this.sessions.delete(ch);
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    clearInterval(this.heartbeat);
    if (!this.error) {
      this.send(0, described(CODES.close, list([])));
      await this.waitFrame((f) => f.code === CODES.close, 3000).catch(() => undefined);
    }
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

function errorFrom(v: AmqpValue | undefined, fallback: string): Amqp10Error {
  if (!isDescribed(v)) return new Amqp10Error(fallback);
  const [condition, description] = (v.value as AmqpValue[]) ?? [];
  const c = condition != null ? String(condition) : undefined;
  const d = description != null ? String(description) : undefined;
  return new Amqp10Error(`${fallback}: ${c ?? 'error'}${d ? ` (${d})` : ''}`, c, d);
}

// ------------------------------------------------------------------ sessions and links

export type DeliveryOutcome = { state: 'accepted' } | { state: 'rejected'; error?: Amqp10Error } | { state: 'released' } | { state: 'modified'; deliveryFailed?: boolean; undeliverableHere?: boolean };

export class Amqp10Session {
  remoteChannel = -1;
  private nextOutgoingId = 0;
  private nextIncomingId = 0;
  private remoteIncomingWindow = 0;
  private incomingLeft: number;
  private readonly links = new Map<number, Amqp10Link>();
  private beginWaiter?: Waiter;
  private windowWaiters: Array<() => void> = [];
  ended = false;

  constructor(readonly conn: Amqp10Connection, readonly channel: number, private readonly incomingWindow: number, private readonly outgoingWindow: number) {
    this.incomingLeft = incomingWindow;
  }

  async begin(): Promise<void> {
    const done = new Promise<Frame>((resolve, reject) => (this.beginWaiter = { resolve, reject }));
    this.conn.send(this.channel, described(CODES.begin, list([null, uint(this.nextOutgoingId), uint(this.incomingWindow), uint(this.outgoingWindow), uint(4294967295)])));
    const f = await done;
    this.remoteChannel = f.channel;
    this.nextIncomingId = Number(f.fields[1] ?? 0);
    this.remoteIncomingWindow = Number(f.fields[2] ?? 0);
  }

  onBegin(f: Frame) {
    const w = this.beginWaiter;
    this.beginWaiter = undefined;
    w?.resolve(f);
  }

  onConnectionError(e: Error) {
    this.beginWaiter?.reject(e);
    for (const l of this.links.values()) l.onError(e);
  }

  onFrame(f: Frame) {
    switch (f.code) {
      case CODES.attach: {
        const name = String(f.fields[0]);
        for (const l of this.links.values()) if (l.name === name) l.onAttach(f);
        return;
      }
      case CODES.flow: {
        // Session window (Part 2.5.6): what the peer can still take from us.
        const nextIn = f.fields[0] != null ? Number(f.fields[0]) : 0;
        this.remoteIncomingWindow = nextIn + Number(f.fields[1] ?? 0) - this.nextOutgoingId;
        const ws = this.windowWaiters;
        this.windowWaiters = [];
        ws.forEach((w) => w());
        if (f.fields[4] != null) this.byRemoteHandle(Number(f.fields[4]))?.onFlow(f);
        else if (f.fields[9] === true) this.sendFlow();
        return;
      }
      case CODES.transfer: {
        this.nextIncomingId++;
        this.incomingLeft--;
        if (this.incomingLeft < this.incomingWindow / 2) {
          this.incomingLeft = this.incomingWindow;
          this.sendFlow();
        }
        this.byRemoteHandle(Number(f.fields[0]))?.onTransfer(f);
        return;
      }
      case CODES.disposition: {
        for (const l of this.links.values()) l.onDisposition(f);
        return;
      }
      case CODES.detach: {
        this.byRemoteHandle(Number(f.fields[0]))?.onDetach(f);
        return;
      }
      case CODES.end: {
        this.ended = true;
        const err = f.fields[0] ? errorFrom(f.fields[0], 'The broker ended the session') : new Amqp10Error('The broker ended the session');
        for (const l of this.links.values()) l.onError(err);
        if (!this.ending) this.conn.send(this.channel, described(CODES.end, list([])));
        this.endWaiter?.();
        this.conn.removeSession(this.channel);
        return;
      }
    }
  }

  private byRemoteHandle(h: number): Amqp10Link | undefined {
    for (const l of this.links.values()) if (l.remoteHandle === h) return l;
    return undefined;
  }

  /** Session-level flow, optionally with a link's state. */
  sendFlow(link?: { handle: number; deliveryCount: number; credit: number; drain?: boolean }): void {
    this.conn.send(this.channel, described(CODES.flow, list(trimNulls([
      uint(this.nextIncomingId), uint(this.incomingLeft), uint(this.nextOutgoingId), uint(this.outgoingWindow),
      ...(link ? [uint(link.handle), uint(link.deliveryCount), uint(link.credit), null, link.drain ?? false] : []),
    ]))));
  }

  /** Transfer ids and the peer's window for one outgoing transfer frame. */
  async takeTransferId(): Promise<number> {
    while (this.remoteIncomingWindow <= 0) await new Promise<void>((r) => this.windowWaiters.push(r));
    this.remoteIncomingWindow--;
    return this.nextOutgoingId++;
  }

  private nextHandle = 0;
  attachLink(l: Amqp10Link): number {
    const h = this.nextHandle++;
    this.links.set(h, l);
    return h;
  }

  removeLink(h: number): void {
    this.links.delete(h);
  }

  async createSender(address: string, o: LinkOptions = {}): Promise<Amqp10Sender> {
    const s = new Amqp10Sender(this, address, o);
    await s.attach();
    return s;
  }

  async createReceiver(address: string, o: ReceiverOptions = {}): Promise<Amqp10Receiver> {
    const r = new Amqp10Receiver(this, address, o);
    await r.attach();
    return r;
  }

  private ending = false;
  private endWaiter?: () => void;
  async end(): Promise<void> {
    if (this.ended || this.conn.closed || this.conn.error) return;
    this.ending = true;
    const done = new Promise<void>((r) => (this.endWaiter = r));
    this.conn.send(this.channel, described(CODES.end, list([])));
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000).unref())]);
    this.ended = true;
    this.conn.removeSession(this.channel);
  }
}

export interface LinkOptions {
  name?: string;
  /** Terminus capabilities (e.g. ["queue"] or ["topic"] for ActiveMQ Artemis and Solace). */
  capabilities?: string[];
  /** Sender settle mode: unsettled (default, at-least-once with outcomes) or settled (fire and forget). */
  settle?: 'unsettled' | 'settled';
  /** Terminus durability (0 none, 1 configuration, 2 unsettled-state). */
  durable?: number;
  properties?: Record<string, AmqpValue>;
}

export interface ReceiverOptions extends LinkOptions {
  /** Link credit kept topped up. Default 100. */
  credit?: number;
  /** Source filter set (e.g. a JMS selector for Artemis/Service Bus): name -> described filter. */
  filter?: Record<string, AmqpValue>;
  /** Target address of the receiving terminus (for request/reply like CBS). */
  targetAddress?: string;
}

abstract class Amqp10Link extends EventEmitter {
  readonly handle: number;
  remoteHandle = -1;
  readonly name: string;
  error?: Error;
  detached = false;
  protected attachWaiter?: Waiter;
  protected detachWaiter?: () => void;
  remoteAttach: AmqpValue[] = [];

  constructor(readonly session: Amqp10Session, readonly address: string, readonly role: 'sender' | 'receiver', readonly o: LinkOptions) {
    super();
    this.name = o.name ?? `${session.conn.containerId}-${role}-${address}-${randomUUID().slice(0, 8)}`;
    this.handle = session.attachLink(this);
  }

  protected terminus(code: number, address: string | null, extra: AmqpValue[] = []): Described {
    const caps = this.o.capabilities?.length ? array('symbol', this.o.capabilities) : null;
    // source: address, durable, expiry-policy, timeout, dynamic, dynamic-node-properties, distribution-mode, filter, default-outcome, outcomes, capabilities
    // target: address, durable, expiry-policy, timeout, dynamic, dynamic-node-properties, capabilities
    if (code === CODES.source) {
      const [filter] = extra;
      return described(code, list(trimNulls([address, uint(this.o.durable ?? 0), null, null, null, null, null, filter ?? null, null, null, caps])));
    }
    return described(code, list(trimNulls([address, uint(this.o.durable ?? 0), null, null, null, null, caps])));
  }

  protected async doAttach(source: Described | null, target: Described | null, extra: AmqpValue[] = []): Promise<void> {
    const done = new Promise<Frame>((resolve, reject) => (this.attachWaiter = { resolve, reject }));
    const settle = this.o.settle === 'settled' ? 1 : 0;
    this.session.conn.send(this.session.channel, described(CODES.attach, list(trimNulls([
      this.name, uint(this.handle), this.role === 'receiver', ubyte(settle), ubyte(0), source, target, null, null,
      ...extra,
      ...(this.o.properties ? [null, null, null, symMap(this.o.properties)] : []),
    ]))));
    const f = await done;
    this.remoteHandle = Number(f.fields[1]);
    this.remoteAttach = f.fields;
    // A refused link is answered with a null terminus, then a detach carrying the reason (Part 2.6.3).
    const remoteTerminus = this.role === 'sender' ? f.fields[6] : f.fields[5];
    if (remoteTerminus === null || remoteTerminus === undefined) {
      const detach = await new Promise<Error>((resolve) => {
        const t = setTimeout(() => resolve(new Amqp10Error(`The broker refused the link to "${this.address}"`)), 3000);
        t.unref();
        this.once('detached', (e: Error) => {
          clearTimeout(t);
          resolve(e);
        });
      });
      this.session.removeLink(this.handle);
      throw detach;
    }
  }

  onAttach(f: Frame) {
    // Set synchronously: the peer's flow often follows in the same packet.
    this.remoteHandle = Number(f.fields[1]);
    this.remoteAttach = f.fields;
    const w = this.attachWaiter;
    this.attachWaiter = undefined;
    w?.resolve(f);
  }

  onDetach(f: Frame) {
    this.detached = true;
    const err = f.fields[2] ? errorFrom(f.fields[2], `The broker detached the link to "${this.address}"`) : new Amqp10Error(`The broker detached the link to "${this.address}"`);
    if (this.detachWaiter) {
      const w = this.detachWaiter;
      this.detachWaiter = undefined;
      w();
    } else {
      // Unsolicited detach: answer it and fail what is pending.
      this.session.conn.send(this.session.channel, described(CODES.detach, list([uint(this.handle), true])));
      this.onError(err);
    }
    this.emit('detached', err);
    this.session.removeLink(this.handle);
  }

  onError(e: Error) {
    this.error ??= e;
    this.attachWaiter?.reject(e);
    this.attachWaiter = undefined;
    this.failPending(e);
    if (this.listenerCount('error')) this.emit('error', e);
  }

  protected abstract failPending(e: Error): void;
  abstract onFlow(f: Frame): void;
  abstract onTransfer(f: Frame): void;
  abstract onDisposition(f: Frame): void;

  async close(): Promise<void> {
    if (this.detached || this.session.conn.closed || this.session.conn.error) return;
    const done = new Promise<void>((r) => (this.detachWaiter = r));
    this.session.conn.send(this.session.channel, described(CODES.detach, list([uint(this.handle), true])));
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000).unref())]);
    this.detached = true;
    this.session.removeLink(this.handle);
  }
}

function outcomeOf(state: AmqpValue | undefined): DeliveryOutcome | undefined {
  if (!isDescribed(state)) return undefined;
  const code = Number(descriptorOf(state));
  const f = (state.value as AmqpValue[]) ?? [];
  if (code === CODES.accepted) return { state: 'accepted' };
  if (code === CODES.rejected) return { state: 'rejected', ...(f[0] ? { error: errorFrom(f[0], 'rejected') } : {}) };
  if (code === CODES.released) return { state: 'released' };
  if (code === CODES.modified) return { state: 'modified', deliveryFailed: f[0] === true, undeliverableHere: f[1] === true };
  return undefined;
}

export class Amqp10Sender extends Amqp10Link {
  private deliveryCount = 0;
  private credit = 0;
  private creditWaiters: Array<() => void> = [];
  private readonly pending = new Map<number, { resolve: (o: DeliveryOutcome) => void; reject: (e: Error) => void }>();
  private tag = 0;

  constructor(session: Amqp10Session, address: string, o: LinkOptions) {
    super(session, address, 'sender', o);
  }

  async attach(): Promise<void> {
    await this.doAttach(this.terminus(CODES.source, null), this.terminus(CODES.target, this.address), [uint(0)]);
  }

  onFlow(f: Frame) {
    // credit = delivery-count(rcv) + link-credit(rcv) - delivery-count(snd) (Part 2.6.7)
    const rcvCount = f.fields[5] != null ? Number(f.fields[5]) : this.deliveryCount;
    const linkCredit = Number(f.fields[6] ?? 0);
    this.credit = rcvCount + linkCredit - this.deliveryCount;
    if (f.fields[8] === true && this.credit > 0) {
      // Drain with nothing to send: use up the credit and tell the receiver.
      this.deliveryCount += this.credit;
      this.credit = 0;
      this.session.sendFlow({ handle: this.handle, deliveryCount: this.deliveryCount, credit: 0, drain: true });
    }
    const ws = this.creditWaiters;
    this.creditWaiters = [];
    ws.forEach((w) => w());
  }

  onTransfer(): void {
    // A sender link does not receive transfers.
  }

  onDisposition(f: Frame) {
    if (f.fields[0] !== true) return; // only the receiver's dispositions concern our deliveries
    const first = Number(f.fields[1]);
    const last = f.fields[2] != null ? Number(f.fields[2]) : first;
    const outcome = outcomeOf(f.fields[4]) ?? { state: 'accepted' as const };
    for (let id = first; id <= last; id++) {
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      // Settle our side when the receiver did not (rcv-settle-mode second).
      if (f.fields[3] !== true) this.session.conn.send(this.session.channel, described(CODES.disposition, list([false, uint(id), uint(id), true, f.fields[4] ?? null])));
      p.resolve(outcome);
    }
  }

  protected failPending(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    const ws = this.creditWaiters;
    this.creditWaiters = [];
    ws.forEach((w) => w());
  }

  /** Send a message; resolves with the receiver's outcome (immediately "accepted" for pre-settled sends). */
  async send(m: Amqp10Message, o: { timeoutMs?: number } = {}): Promise<DeliveryOutcome> {
    const deadline = Date.now() + (o.timeoutMs ?? 30_000);
    while (this.credit <= 0) {
      if (this.error) throw this.error;
      if (Date.now() > deadline) throw new Amqp10Error(`No link credit from the broker for "${this.address}" (it is not accepting messages)`);
      await new Promise<void>((r) => {
        this.creditWaiters.push(r);
        setTimeout(r, 250).unref();
      });
    }
    if (this.error) throw this.error;
    this.credit--;
    this.deliveryCount++;
    const payload = encodeMessage(m);
    const presettled = this.o.settle === 'settled';
    const tag = Buffer.alloc(8);
    tag.writeBigUInt64BE(BigInt(++this.tag));
    const deliveryId = await this.session.takeTransferId();
    const outcome = presettled ? undefined : new Promise<DeliveryOutcome>((resolve, reject) => this.pending.set(deliveryId, { resolve, reject }));
    // Split into frames that fit the negotiated maximum frame size.
    const firstPerf = (more: boolean) => described(CODES.transfer, list([uint(this.handle), uint(deliveryId), binary(tag), uint(0), presettled, more]));
    const contPerf = (more: boolean) => described(CODES.transfer, list([uint(this.handle), null, null, null, presettled, more]));
    const room = this.session.conn.frameLimit - 8 - encode(firstPerf(true)).length - 8;
    let at = 0;
    let firstFrame = true;
    do {
      const chunk = payload.subarray(at, at + Math.max(64, room));
      at += chunk.length;
      const more = at < payload.length;
      if (!firstFrame) await this.session.takeTransferId();
      this.session.conn.send(this.session.channel, firstFrame ? firstPerf(more) : contPerf(more), chunk);
      firstFrame = false;
    } while (at < payload.length);
    if (!outcome) return { state: 'accepted' };
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([outcome, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Amqp10Error(`The broker did not settle the message sent to "${this.address}" in time`)), Math.max(1000, deadline - Date.now()));
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface Amqp10Delivery {
  id: number;
  tag: Buffer;
  message: Amqp10Message;
  /** The sender settled it already (no outcome needed). */
  settled: boolean;
}

export class Amqp10Receiver extends Amqp10Link {
  private deliveryCount = 0;
  private credit = 0;
  private readonly wanted: number;
  private partial?: { id: number; tag: Buffer; settled: boolean; chunks: Buffer[] };

  constructor(session: Amqp10Session, address: string, readonly ro: ReceiverOptions) {
    super(session, address, 'receiver', ro);
    this.wanted = ro.credit ?? 100;
  }

  async attach(): Promise<void> {
    const filter = this.ro.filter ? symMap(this.ro.filter) : null;
    await this.doAttach(this.terminus(CODES.source, this.address, [filter]), this.terminus(CODES.target, this.ro.targetAddress ?? null));
    this.deliveryCount = this.remoteAttach[9] != null ? Number(this.remoteAttach[9]) : 0;
    this.grant();
  }

  /** Top the link credit up to the wanted level. */
  private grant(): void {
    if (this.detached) return;
    this.credit = this.wanted;
    this.session.sendFlow({ handle: this.handle, deliveryCount: this.deliveryCount, credit: this.credit });
  }

  onFlow(f: Frame) {
    if (f.fields[9] === true) this.session.sendFlow({ handle: this.handle, deliveryCount: this.deliveryCount, credit: this.credit });
  }

  onTransfer(f: Frame) {
    const more = f.fields[5] === true;
    if (!this.partial) {
      this.partial = { id: Number(f.fields[1]), tag: Buffer.from((f.fields[2] as Buffer) ?? Buffer.alloc(0)), settled: f.fields[4] === true, chunks: [] };
    } else if (f.fields[4] === true) this.partial.settled = true;
    if (f.fields[10] === true) {
      // aborted: drop what was received
      this.partial = undefined;
      return;
    }
    this.partial.chunks.push(f.payload);
    if (more) return;
    const p = this.partial;
    this.partial = undefined;
    this.deliveryCount++;
    this.credit--;
    if (this.credit < this.wanted / 2) this.grant();
    let message: Amqp10Message;
    try {
      message = decodeMessage(Buffer.concat(p.chunks));
    } catch (e) {
      this.emit('error', e);
      if (!p.settled) this.settle(p.id, 'rejected');
      return;
    }
    this.emit('message', { id: p.id, tag: p.tag, message, settled: p.settled } satisfies Amqp10Delivery);
  }

  onDisposition(): void {
    // Dispositions from the sender side (settling after our outcome): nothing left to do.
  }

  protected failPending(): void {
    // Nothing is awaited on a receiver.
  }

  /** Settle a delivery with an outcome (Part 3.4). */
  settle(id: number, outcome: 'accepted' | 'released' | 'rejected' | 'modified', o: { error?: string; deliveryFailed?: boolean } = {}): void {
    if (this.detached || this.session.conn.closed) return;
    const state = outcome === 'accepted' ? described(CODES.accepted, list([]))
      : outcome === 'released' ? described(CODES.released, list([]))
        : outcome === 'rejected' ? described(CODES.rejected, list(o.error ? [described(CODES.error, list([sym('amqp:internal-error'), o.error]))] : []))
          : described(CODES.modified, list([o.deliveryFailed ?? true, false]));
    this.session.conn.send(this.session.channel, described(CODES.disposition, list([true, uint(id), uint(id), true, state])));
  }
}

// ------------------------------------------------------------------ claims-based security (Azure)

/** A Shared Access Signature token for an Azure Service Bus / Event Hubs resource URI. */
export function createSasToken(resourceUri: string, keyName: string, key: string, ttlSeconds = 3600, now = Date.now()): string {
  const sr = encodeURIComponent(resourceUri.toLowerCase());
  const se = Math.round(now / 1000) + ttlSeconds;
  const sig = createHmac('sha256', key).update(`${sr}\n${se}`).digest('base64');
  return `SharedAccessSignature sr=${sr}&sig=${encodeURIComponent(sig)}&se=${se}&skn=${encodeURIComponent(keyName)}`;
}

/**
 * CBS put-token (AMQP Claims-Based Security, working draft): send a token for an audience over the
 * $cbs node and wait for its status. Azure Service Bus expects this after SASL ANONYMOUS, before
 * links to the entity are attached.
 */
export async function putToken(session: Amqp10Session, audience: string, token: string, o: { type?: string; timeoutMs?: number; expiresAt?: Date } = {}): Promise<{ status: number; description?: string }> {
  const replyTo = `cbs-${randomUUID()}`;
  const receiver = await session.createReceiver('$cbs', { targetAddress: replyTo, credit: 10, name: `${replyTo}-r` });
  const sender = await session.createSender('$cbs', { name: `${replyTo}-s` });
  try {
    const messageId = randomUUID();
    const reply = new Promise<Amqp10Delivery>((resolve, reject) => {
      const t = setTimeout(() => reject(new Amqp10Error('No answer to the CBS put-token request')), o.timeoutMs ?? 15_000);
      t.unref();
      receiver.on('message', (d: Amqp10Delivery) => {
        if (String(d.message.properties?.correlationId ?? '') !== messageId) return;
        clearTimeout(t);
        if (!d.settled) receiver.settle(d.id, 'accepted');
        resolve(d);
      });
    });
    await sender.send({
      properties: { messageId, replyTo },
      applicationProperties: { operation: 'put-token', type: o.type ?? 'servicebus.windows.net:sastoken', name: audience, ...(o.expiresAt ? { expiration: timestamp(o.expiresAt) } : {}) },
      body: { type: 'value', value: token },
    });
    const d = await reply;
    const status = Number(d.message.applicationProperties?.['status-code'] ?? d.message.applicationProperties?.statusCode ?? 0);
    const description = d.message.applicationProperties?.['status-description'];
    if (status !== 200 && status !== 202) throw new Amqp10Error(`CBS put-token for ${audience} was refused: ${status}${description ? ` ${String(description)}` : ''}`, 'amqp:unauthorized-access');
    return { status, ...(description != null ? { description: String(description) } : {}) };
  } finally {
    await sender.close().catch(() => undefined);
    await receiver.close().catch(() => undefined);
  }
}
