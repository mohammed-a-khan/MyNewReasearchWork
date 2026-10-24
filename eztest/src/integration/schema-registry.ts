/**
 * A client for the Confluent-compatible schema registry REST API (also served
 * by Apicurio's ccompat API, Karapace and Redpanda): subjects, versions,
 * schemas by id, registration, compatibility checks and settings. Plus the
 * serializer the Kafka steps use: Avro (EZTest's own codec), Protobuf (on
 * protobufjs, an optional peer, when installed) and JSON Schema payloads in
 * the Confluent wire format (magic byte 0, 4-byte schema id, payload).
 */
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { EzTestError } from '../core/index.js';
import { envProxyFetch } from '../surfaces/proxy.js';
import { AvroSchema, avroToJson, frameConfluent, unframeConfluent } from './avro.js';
import type { TlsOptions } from './tls.js';
import { loadClient } from './bus/types.js';

export type SchemaType = 'AVRO' | 'PROTOBUF' | 'JSON';

export interface RegisteredSchema {
  subject?: string;
  id: number;
  version?: number;
  schema: string;
  schemaType: SchemaType;
  references?: Array<{ name: string; subject: string; version: number }>;
}

export interface SchemaRegistryOptions {
  url: string;
  username?: string;
  password?: string;
  token?: string;
  tls?: TlsOptions;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SchemaRegistryError extends EzTestError {
  constructor(message: string, readonly status: number, readonly errorCode?: number) {
    super(message, 'SCHEMA_REGISTRY', { status, ...(errorCode ? { errorCode } : {}) });
    this.name = 'SchemaRegistryError';
  }
}

const CT = 'application/vnd.schemaregistry.v1+json';

/** fetch() over node:https with extra TLS options (a private CA, a client certificate). */
function tlsFetch(tls: TlsOptions): typeof fetch {
  const agent = new Agent({ keepAlive: false, ...tls });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const body = init?.body === undefined || init.body === null ? undefined : Buffer.from(String(init.body));
    return new Promise<Response>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>), ...(body ? { 'content-length': String(body.length) } : {}) }, ...(u.protocol === 'https:' ? { agent } : {}) }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]))) })));
      });
      req.on('error', reject);
      req.end(body);
    });
  }) as typeof fetch;
}

export class SchemaRegistryClient {
  private readonly base: string;
  private readonly byId = new Map<number, Promise<RegisteredSchema>>();
  private readonly f: typeof fetch;

  constructor(private readonly o: SchemaRegistryOptions) {
    this.base = o.url.replace(/\/+$/, '');
    this.f = o.fetch ?? (o.tls ? tlsFetch(o.tls) : envProxyFetch);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: `${CT}, application/json` };
    if (body !== undefined) headers['content-type'] = CT;
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    else if (this.o.username) headers.authorization = `Basic ${Buffer.from(`${this.o.username}:${this.o.password ?? ''}`).toString('base64')}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 15_000);
    let res: Response;
    let text: string;
    try {
      res = await this.f(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      throw new SchemaRegistryError(`Schema registry ${this.base} could not be reached: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error_code?: number; message?: string };
      const why = res.status === 401 || res.status === 403 ? ' (check the registry credentials)' : '';
      throw new SchemaRegistryError(`Schema registry: ${method} ${path} failed: HTTP ${res.status}${e.error_code ? ` ${e.error_code}` : ''}${e.message ? ` ${e.message}` : ''}${why}`, res.status, e.error_code);
    }
    return json as T;
  }

  private static subj(s: string): string {
    if (!s) throw new EzTestError('Schema registry subject is empty', 'SCHEMA_REGISTRY');
    return encodeURIComponent(s);
  }

  subjects(): Promise<string[]> {
    return this.call('GET', '/subjects');
  }

  versions(subject: string): Promise<number[]> {
    return this.call('GET', `/subjects/${SchemaRegistryClient.subj(subject)}/versions`);
  }

  async version(subject: string, version: number | 'latest' = 'latest'): Promise<RegisteredSchema> {
    const r = await this.call<RegisteredSchema & { schemaType?: SchemaType }>('GET', `/subjects/${SchemaRegistryClient.subj(subject)}/versions/${version}`);
    const out = { ...r, schemaType: r.schemaType ?? 'AVRO' };
    this.byId.set(out.id, Promise.resolve(out));
    return out;
  }

  /** The schema with this id (cached: ids never change). */
  schemaById(id: number): Promise<RegisteredSchema> {
    let p = this.byId.get(id);
    if (!p) {
      p = this.call<{ schema: string; schemaType?: SchemaType; references?: RegisteredSchema['references'] }>('GET', `/schemas/ids/${id}`).then((r) => ({ id, schema: r.schema, schemaType: r.schemaType ?? 'AVRO', ...(r.references ? { references: r.references } : {}) }));
      this.byId.set(id, p);
      p.catch(() => this.byId.delete(id));
    }
    return p;
  }

  /** Register a schema under a subject (idempotent); returns its id. */
  async register(subject: string, schema: string | object, schemaType: SchemaType = 'AVRO', references?: RegisteredSchema['references']): Promise<number> {
    const text = typeof schema === 'string' ? schema : JSON.stringify(schema);
    const r = await this.call<{ id: number }>('POST', `/subjects/${SchemaRegistryClient.subj(subject)}/versions`, { schema: text, ...(schemaType !== 'AVRO' ? { schemaType } : {}), ...(references ? { references } : {}) });
    return r.id;
  }

  /** The registered version of exactly this schema under a subject, or undefined. */
  async lookup(subject: string, schema: string | object, schemaType: SchemaType = 'AVRO'): Promise<RegisteredSchema | undefined> {
    try {
      const r = await this.call<RegisteredSchema>('POST', `/subjects/${SchemaRegistryClient.subj(subject)}`, { schema: typeof schema === 'string' ? schema : JSON.stringify(schema), ...(schemaType !== 'AVRO' ? { schemaType } : {}) });
      return { ...r, schemaType: r.schemaType ?? 'AVRO' };
    } catch (e) {
      if (e instanceof SchemaRegistryError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Would this schema be accepted as a new version of the subject? (with the registry's reasons when it says no) */
  async checkCompatibility(subject: string, schema: string | object, o: { version?: number | 'latest'; schemaType?: SchemaType } = {}): Promise<{ compatible: boolean; messages: string[] }> {
    const r = await this.call<{ is_compatible: boolean; messages?: string[] }>('POST', `/compatibility/subjects/${SchemaRegistryClient.subj(subject)}/versions/${o.version ?? 'latest'}?verbose=true`, { schema: typeof schema === 'string' ? schema : JSON.stringify(schema), ...(o.schemaType && o.schemaType !== 'AVRO' ? { schemaType: o.schemaType } : {}) });
    return { compatible: !!r.is_compatible, messages: r.messages ?? [] };
  }

  /** Compatibility level of a subject (falling back to the global one), or the global level. */
  async compatibility(subject?: string): Promise<string> {
    const path = subject ? `/config/${SchemaRegistryClient.subj(subject)}?defaultToGlobal=true` : '/config';
    const r = await this.call<{ compatibilityLevel?: string; compatibility?: string }>('GET', path);
    return r.compatibilityLevel ?? r.compatibility ?? 'BACKWARD';
  }

  async setCompatibility(level: 'NONE' | 'BACKWARD' | 'BACKWARD_TRANSITIVE' | 'FORWARD' | 'FORWARD_TRANSITIVE' | 'FULL' | 'FULL_TRANSITIVE', subject?: string): Promise<void> {
    await this.call('PUT', subject ? `/config/${SchemaRegistryClient.subj(subject)}` : '/config', { compatibility: level });
  }

  deleteSubject(subject: string, permanent = false): Promise<number[]> {
    return this.call('DELETE', `/subjects/${SchemaRegistryClient.subj(subject)}${permanent ? '?permanent=true' : ''}`);
  }
}

// ------------------------------------------------------------------ serializer

export interface DecodedMessage {
  format: 'avro' | 'protobuf' | 'json';
  schemaId: number;
  value: unknown;
  /** Protobuf: the full name of the message type. Avro: the record's full name. */
  type?: string;
}

type Proto = any; // protobufjs (optional peer)

/** Zig-zag varint (as Confluent writes Protobuf message indexes). */
function writeVarint(n: number): number[] {
  let z = ((n << 1) ^ (n >> 31)) >>> 0;
  const out: number[] = [];
  while (z >= 0x80) {
    out.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  out.push(z);
  return out;
}

function readVarint(b: Uint8Array, at: number): { value: number; next: number } {
  let z = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= b.length) throw new EzTestError('Protobuf message index is truncated', 'SCHEMA_REGISTRY');
    const x = b[i++];
    z |= (x & 0x7f) << shift;
    if (!(x & 0x80)) break;
    shift += 7;
  }
  return { value: (z >>> 1) ^ -(z & 1), next: i };
}

/** Encodes and decodes framed payloads with schemas from a registry. */
export class SchemaRegistrySerde {
  private readonly avro = new Map<number, AvroSchema>();
  private readonly protos = new Map<number, Promise<Proto>>();
  private protobufLib?: Promise<Proto>;

  constructor(readonly registry: SchemaRegistryClient, private readonly o: { protobuf?: unknown } = {}) {}

  private async protobuf(): Promise<Proto> {
    this.protobufLib ??= this.o.protobuf ? Promise.resolve(this.o.protobuf) : loadClient('protobufjs', 'Protobuf payloads');
    return this.protobufLib;
  }

  private avroSchema(s: RegisteredSchema): AvroSchema {
    let a = this.avro.get(s.id);
    if (!a) {
      a = new AvroSchema(s.schema);
      this.avro.set(s.id, a);
    }
    return a;
  }

  /** The protobufjs root of a registered .proto, and its top-level message types in file order. */
  private protoRoot(s: RegisteredSchema): Promise<Proto> {
    let p = this.protos.get(s.id);
    if (!p) {
      p = (async () => {
        const pb = await this.protobuf();
        const parsed = pb.parse(s.schema, { keepCase: true });
        const ns = parsed.package ? parsed.root.lookup(parsed.package) : parsed.root;
        const types = (ns?.nestedArray ?? []).filter((t: Proto) => t instanceof pb.Type);
        return { root: parsed.root, types };
      })();
      this.protos.set(s.id, p);
    }
    return p;
  }

  /** Encode a value with the latest (or a given) version of a subject. */
  async encode(subject: string, value: unknown, o: { version?: number | 'latest'; message?: string } = {}): Promise<{ bytes: Uint8Array; schemaId: number; format: DecodedMessage['format'] }> {
    const s = await this.registry.version(subject, o.version ?? 'latest');
    switch (s.schemaType) {
      case 'AVRO':
        return { bytes: frameConfluent(s.id, this.avroSchema(s).encode(value)), schemaId: s.id, format: 'avro' };
      case 'JSON':
        return { bytes: frameConfluent(s.id, Buffer.from(JSON.stringify(value), 'utf8')), schemaId: s.id, format: 'json' };
      case 'PROTOBUF': {
        const { types, root } = await this.protoRoot(s);
        let index = 0;
        let type = types[0];
        if (o.message) {
          type = root.lookupType(o.message);
          index = types.indexOf(type);
          if (index < 0) throw new EzTestError(`Protobuf message ${o.message} is not a top-level message of subject "${subject}"`, 'SCHEMA_REGISTRY');
        }
        if (!type) throw new EzTestError(`Subject "${subject}" has no Protobuf message type`, 'SCHEMA_REGISTRY');
        const problem = type.verify(value);
        if (problem) throw new EzTestError(`The value does not fit Protobuf ${type.fullName.replace(/^\./, '')}: ${problem}`, 'SCHEMA_REGISTRY');
        const payload = type.encode(type.fromObject(value as object)).finish() as Uint8Array;
        // Message indexes: [0] is written as a single 0; otherwise count + indexes.
        const indexes = index === 0 ? [0] : [...writeVarint(1), ...writeVarint(index)];
        return { bytes: frameConfluent(s.id, payload, Uint8Array.from(indexes)), schemaId: s.id, format: 'protobuf' };
      }
    }
  }

  /** Decode a Confluent-framed payload, or undefined when the bytes are not framed. */
  async decode(bytes: Uint8Array): Promise<DecodedMessage | undefined> {
    const f = unframeConfluent(bytes);
    if (!f) return undefined;
    const s = await this.registry.schemaById(f.schemaId);
    switch (s.schemaType) {
      case 'AVRO': {
        const a = this.avroSchema(s);
        return { format: 'avro', schemaId: f.schemaId, value: avroToJson(a.decode(f.payload)), ...('name' in a.root ? { type: a.root.name } : {}) };
      }
      case 'JSON':
        return { format: 'json', schemaId: f.schemaId, value: JSON.parse(Buffer.from(f.payload).toString('utf8')) };
      case 'PROTOBUF': {
        const { types } = await this.protoRoot(s);
        const first = readVarint(f.payload, 0);
        let at = first.next;
        const path: number[] = [];
        if (first.value === 0) path.push(0);
        else for (let i = 0; i < first.value; i++) {
          const x = readVarint(f.payload, at);
          path.push(x.value);
          at = x.next;
        }
        let type = types[path[0]];
        for (const i of path.slice(1)) type = type?.nestedArray?.filter((t: Proto) => t.fields !== undefined)[i];
        if (!type) throw new EzTestError(`Protobuf message index [${path.join(', ')}] is not in schema ${f.schemaId}`, 'SCHEMA_REGISTRY');
        const msg = type.decode(f.payload.subarray(at));
        return { format: 'protobuf', schemaId: f.schemaId, type: type.fullName.replace(/^\./, ''), value: type.toObject(msg, { longs: String, enums: String, bytes: String, defaults: true, arrays: true }) };
      }
    }
  }
}
