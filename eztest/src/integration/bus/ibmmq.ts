/**
 * IBM MQ through the MQ REST messaging API (mqweb), not the native client:
 * the `ibmmq` npm package needs the MQ C client libraries installed on every
 * machine, while the REST API needs nothing but HTTPS. Queues only (the REST
 * API's put and destructive get); correlation ids are carried as the MQMD
 * CorrelId (24 bytes, hex on the wire).
 *
 * Waiting with a JSONPath filter reads messages destructively; messages that
 * do not match are put back on the queue when the subscription closes (their
 * order and message ids change). A correlation id filter is pushed down to MQ
 * as a selector, so nothing else is touched.
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BusError, BusSubscription, decodePayload, payloadText, type BusDestination, type BusDriver, type BusMessage, type OutgoingMessage, type PublishReceipt, type SubscribeOptions } from './types.js';

export interface IbmMqOptions {
  /** mqweb base URL, e.g. https://mq.example.com:9443/ibmmq/rest/v2 (a URL without /ibmmq/rest gets /ibmmq/rest/v2 appended). */
  url: string;
  queueManager: string;
  username?: string;
  password?: string;
  /** PEM CA bundle for the mqweb certificate. */
  ca?: string;
  /** Accept a self-signed mqweb certificate (development images only). */
  insecure?: boolean;
  /** Poll wait per REST get (default 1000 ms). */
  waitMs?: number;
}

interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** CorrelId as hex: text is UTF-8 padded with zeros to 24 bytes; 48 hex digits are kept as they are. */
export function toCorrelId(id: string): string {
  if (/^[0-9a-f]{48}$/i.test(id)) return id.toLowerCase();
  const b = Buffer.alloc(24);
  const src = Buffer.from(id, 'utf8');
  if (src.length > 24) throw new BusError(`IBM MQ correlation ids are at most 24 bytes ("${id}" is ${src.length})`, 'BUS_CORRELATION');
  src.copy(b);
  return b.toString('hex');
}

export function fromCorrelId(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  const t = b.subarray(0, end).toString('utf8');
  return end > 0 && /^[\x20-\x7e]+$/.test(t) ? t : hex;
}

export class IbmMqBusDriver implements BusDriver {
  readonly kind = 'ibmmq' as const;
  private readonly base: string;
  private readonly ca?: Buffer;
  private readonly polls = new Set<BusSubscription>();

  constructor(readonly name: string, readonly opts: IbmMqOptions) {
    if (!opts.url || !opts.queueManager) throw new BusError(`messaging.brokers.${name}: ibmmq needs "url" and "queueManager"`, 'CONFIG');
    this.base = /\/ibmmq\/rest\/v\d/.test(opts.url) ? opts.url.replace(/\/$/, '') : `${opts.url.replace(/\/$/, '')}/ibmmq/rest/v2`;
    if (opts.ca) this.ca = readFileSync(opts.ca);
  }

  private call(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<HttpResult> {
    const url = new URL(`${this.base}${path}`);
    const auth = this.opts.username ? { authorization: `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password ?? ''}`).toString('base64')}` } : {};
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = fn(url, {
        method,
        headers: { 'ibm-mq-rest-csrf-token': 'eztest', ...auth, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        ...(url.protocol === 'https:' ? { ...(this.ca ? { ca: this.ca } : {}), ...(this.opts.insecure ? { rejectUnauthorized: false } : {}) } : {}),
        timeout: (this.opts.waitMs ?? 1000) + 15_000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v ?? '')])), body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('IBM MQ REST request timed out')));
      req.on('error', (e) => reject(new BusError(`IBM MQ REST call to ${url.host} failed: ${e.message}`, 'BUS_CONNECT')));
      if (body) req.write(body);
      req.end();
    });
  }

  private queuePath(dest: BusDestination): string {
    if (dest.type !== 'queue') throw new BusError('IBM MQ through the REST messaging API supports queues; say "IBM MQ queue"', 'BUS_DESTINATION');
    return `/messaging/qmgr/${encodeURIComponent(this.opts.queueManager)}/queue/${encodeURIComponent(dest.name)}/message`;
  }

  private explain(r: HttpResult, what: string): BusError {
    let detail = r.body.toString('utf8').slice(0, 300);
    try {
      const j = JSON.parse(detail) as { error?: Array<{ message?: string; explanation?: string }> };
      detail = j.error?.map((e) => e.message ?? e.explanation).join('; ') ?? detail;
    } catch {
      // plain text
    }
    return new BusError(`IBM MQ ${what} failed with HTTP ${r.status}: ${detail}`, r.status === 401 || r.status === 403 ? 'BUS_AUTH' : 'BUS_ERROR');
  }

  async publish(dest: BusDestination, msg: OutgoingMessage): Promise<PublishReceipt> {
    const headers: Record<string, string> = { 'content-type': `${msg.contentType ?? 'text/plain'};charset=utf-8`, 'ibm-mq-md-persistence': 'persistent' };
    if (msg.correlationId) headers['ibm-mq-md-correlationId'] = toCorrelId(msg.correlationId);
    for (const [k, v] of Object.entries(msg.headers ?? {})) headers[`ibm-mq-usr-${k}`] = v;
    const r = await this.call('POST', this.queuePath(dest), headers, Buffer.from(typeof msg.payload === 'string' ? msg.payload : msg.payload));
    if (r.status !== 201) throw this.explain(r, `put to ${dest.name}`);
    return { messageId: r.headers['ibm-mq-md-messageid'] };
  }

  /** One destructive get; undefined when the queue stayed empty for `waitMs`. */
  async get(dest: BusDestination, opts: { waitMs?: number; correlationId?: string } = {}): Promise<BusMessage | undefined> {
    const q = new URLSearchParams({ wait: String(opts.waitMs ?? this.opts.waitMs ?? 1000) });
    if (opts.correlationId) q.set('correlationId', toCorrelId(opts.correlationId));
    const r = await this.call('DELETE', `${this.queuePath(dest)}?${q}`);
    if (r.status === 204) return undefined;
    if (r.status !== 200) throw this.explain(r, `get from ${dest.name}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) if (k.startsWith('ibm-mq-usr-')) headers[k.slice('ibm-mq-usr-'.length)] = v;
    const corr = r.headers['ibm-mq-md-correlationid'];
    return {
      destination: dest.name, ...decodePayload(r.body), headers, timestamp: Date.now(),
      ...(r.headers['ibm-mq-md-messageid'] ? { messageId: r.headers['ibm-mq-md-messageid'] } : {}),
      ...(corr ? { correlationId: fromCorrelId(corr) } : {}),
    };
  }

  async subscribe(dest: BusDestination, opts: SubscribeOptions & { correlationId?: string } = {}): Promise<BusSubscription> {
    this.queuePath(dest);
    const sub = new BusSubscription(dest);
    const taken = new Set<BusMessage>();
    this.polls.add(sub);
    sub.onTake = (m) => taken.add(m);
    const loop = async () => {
      while (!sub.closed) {
        try {
          const m = await this.get(dest, { waitMs: this.opts.waitMs ?? 1000, ...(opts.correlationId ? { correlationId: opts.correlationId } : {}) });
          if (m && !sub.closed) sub.push(m);
          else if (m) await this.restore(dest, m);
        } catch (e) {
          if (!sub.closed) sub.fail(e as Error);
          return;
        }
      }
    };
    void loop();
    sub.onClose = async () => {
      this.polls.delete(sub);
      for (const m of sub.messages) if (!taken.has(m)) await this.restore(dest, m).catch(() => undefined);
    };
    return sub;
  }

  /** Put a message back (unmatched messages read by a filtered wait). */
  private async restore(dest: BusDestination, m: BusMessage): Promise<void> {
    await this.publish(dest, { payload: m.binary ? Buffer.from(m.payload, 'base64') : m.payload, headers: m.headers, ...(m.correlationId ? { correlationId: m.correlationId } : {}) });
  }

  async purge(dest: BusDestination): Promise<number> {
    let n = 0;
    while (await this.get(dest, { waitMs: 0 })) n++;
    return n;
  }

  async close(): Promise<void> {
    for (const s of [...this.polls]) await s.close();
  }
}

export { payloadText };
