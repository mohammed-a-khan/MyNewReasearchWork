/**
 * Apache Avro binary encoding, written from the Avro 1.11 specification:
 *
 * - schemas: primitives, records, enums, arrays, maps, unions, fixed, named
 *   types with namespaces and aliases, recursive types;
 * - logical types: decimal (bytes and fixed), uuid, date, time-millis,
 *   time-micros, timestamp-millis/-micros, local-timestamp-millis/-micros,
 *   duration;
 * - binary encoding and decoding (zig-zag varints, blocks, unions by index);
 * - schema resolution (reading data written with one schema through another:
 *   promotions, field defaults, enum defaults, unions) and the compatibility
 *   check a schema registry runs;
 * - Parsing Canonical Form and the CRC-64-AVRO (Rabin) fingerprint;
 * - the Confluent wire format: magic byte 0, a 4-byte schema id, the payload.
 *
 * Values are JSON-friendly both ways: a long that fits a double is a number
 * (else a string of digits), bytes and fixed are Uint8Array (strings are read
 * as ISO-8859-1, the Avro JSON convention), logical types decode to readable
 * text (dates "2026-03-01", timestamps ISO-8601, decimals "12.50").
 */
import { EzTestError } from '../core/index.js';

export class AvroError extends EzTestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AVRO_ERROR', details);
    this.name = 'AvroError';
  }
}

// ------------------------------------------------------------------ schema model

type Logical =
  | { name: 'decimal'; precision: number; scale: number }
  | { name: 'uuid' | 'date' | 'time-millis' | 'time-micros' | 'timestamp-millis' | 'timestamp-micros' | 'local-timestamp-millis' | 'local-timestamp-micros' | 'duration' };

export type AvroType =
  | { kind: 'null' | 'boolean' | 'float' | 'double' }
  | { kind: 'int' | 'long'; logical?: Logical }
  | { kind: 'bytes' | 'string'; logical?: Logical }
  | { kind: 'record'; name: string; aliases: string[]; fields: AvroField[]; error?: boolean }
  | { kind: 'enum'; name: string; aliases: string[]; symbols: string[]; default?: string }
  | { kind: 'array'; items: AvroType }
  | { kind: 'map'; values: AvroType }
  | { kind: 'union'; types: AvroType[] }
  | { kind: 'fixed'; name: string; aliases: string[]; size: number; logical?: Logical };

export interface AvroField {
  name: string;
  aliases: string[];
  type: AvroType;
  /** Default in Avro JSON form (present when the field has one). */
  default?: unknown;
  hasDefault: boolean;
}

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fullName(name: string, namespace: string | undefined): string {
  if (name.includes('.')) return name;
  return namespace ? `${namespace}.${name}` : name;
}

function nsOf(full: string): string | undefined {
  const i = full.lastIndexOf('.');
  return i < 0 ? undefined : full.slice(0, i);
}

function checkName(full: string): void {
  for (const part of full.split('.')) if (!NAME_RE.test(part)) throw new AvroError(`Invalid Avro name "${full}"`);
}

/** Logical type of a JSON schema node, when it is valid for the underlying type (an invalid one is ignored, as the spec says). */
function logicalOf(o: Record<string, unknown>, kind: string, size?: number): Logical | undefined {
  const lt = o.logicalType;
  if (typeof lt !== 'string') return undefined;
  switch (lt) {
    case 'decimal': {
      const precision = Number(o.precision);
      const scale = o.scale === undefined ? 0 : Number(o.scale);
      if (kind !== 'bytes' && kind !== 'fixed') return undefined;
      if (!Number.isInteger(precision) || precision < 1 || !Number.isInteger(scale) || scale < 0 || scale > precision) return undefined;
      if (kind === 'fixed' && size !== undefined && precision > Math.floor(Math.log10(2) * (8 * size - 1))) return undefined;
      return { name: 'decimal', precision, scale };
    }
    case 'uuid': return kind === 'string' || (kind === 'fixed' && size === 16) ? { name: 'uuid' } : undefined;
    case 'date': case 'time-millis': return kind === 'int' ? { name: lt } : undefined;
    case 'time-micros': case 'timestamp-millis': case 'timestamp-micros': case 'local-timestamp-millis': case 'local-timestamp-micros':
      return kind === 'long' ? { name: lt } : undefined;
    case 'duration': return kind === 'fixed' && size === 12 ? { name: 'duration' } : undefined;
    default: return undefined;
  }
}

/** A parsed schema: the root type plus its named types. */
export class AvroSchema {
  readonly named = new Map<string, AvroType>();
  readonly root: AvroType;
  readonly json: unknown;

  constructor(schema: unknown) {
    const json = typeof schema === 'string' && /^\s*[[{"]/.test(schema) ? (() => {
      try {
        return JSON.parse(schema) as unknown;
      } catch (e) {
        throw new AvroError(`Avro schema is not valid JSON: ${(e as Error).message}`);
      }
    })() : schema;
    this.json = json;
    this.root = this.parse(json, undefined);
  }

  private parse(s: unknown, ns: string | undefined): AvroType {
    if (typeof s === 'string') {
      if (PRIMITIVES.has(s)) return { kind: s } as AvroType;
      const hit = this.named.get(fullName(s, ns)) ?? this.named.get(s);
      if (!hit) throw new AvroError(`Unknown Avro type "${s}"`);
      return hit;
    }
    if (Array.isArray(s)) {
      const types = s.map((x) => this.parse(x, ns));
      const seen = new Set<string>();
      for (const t of types) {
        if (t.kind === 'union') throw new AvroError('An Avro union may not contain a union');
        const key = 'name' in t ? t.name : t.kind;
        if (seen.has(key)) throw new AvroError(`An Avro union may not contain "${key}" twice`);
        seen.add(key);
      }
      return { kind: 'union', types };
    }
    if (!s || typeof s !== 'object') throw new AvroError(`Invalid Avro schema: ${JSON.stringify(s)}`);
    const o = s as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== 'string') return this.parse(type, ns);
    const named = (): { name: string; aliases: string[]; ns?: string } => {
      if (typeof o.name !== 'string') throw new AvroError(`Avro ${type} needs a name`);
      const full = fullName(o.name, typeof o.namespace === 'string' && o.namespace ? o.namespace : ns);
      checkName(full);
      if (this.named.has(full)) throw new AvroError(`Avro type "${full}" is defined twice`);
      const space = nsOf(full);
      return { name: full, aliases: Array.isArray(o.aliases) ? (o.aliases as string[]).map((a) => fullName(a, space)) : [], ns: space };
    };
    switch (type) {
      case 'record': case 'error': {
        const n = named();
        const t: AvroType = { kind: 'record', name: n.name, aliases: n.aliases, fields: [], ...(type === 'error' ? { error: true } : {}) };
        this.named.set(n.name, t); // registered before its fields: recursive types
        if (!Array.isArray(o.fields)) throw new AvroError(`Avro record ${n.name} needs fields`);
        const names = new Set<string>();
        for (const f of o.fields as Array<Record<string, unknown>>) {
          if (typeof f?.name !== 'string' || !NAME_RE.test(f.name)) throw new AvroError(`Avro record ${n.name}: invalid field name ${JSON.stringify(f?.name)}`);
          if (names.has(f.name)) throw new AvroError(`Avro record ${n.name}: field "${f.name}" is defined twice`);
          names.add(f.name);
          const ft = this.parse(f.type, n.ns);
          const field: AvroField = { name: f.name, aliases: Array.isArray(f.aliases) ? (f.aliases as string[]) : [], type: ft, hasDefault: 'default' in f, ...('default' in f ? { default: f.default } : {}) };
          if (field.hasDefault) {
            try {
              fromAvroJson(ft, f.default, true);
            } catch (e) {
              throw new AvroError(`Avro record ${n.name}: the default of field "${f.name}" does not match its type (${(e as Error).message})`);
            }
          }
          t.fields.push(field);
        }
        return t;
      }
      case 'enum': {
        const n = named();
        const symbols = o.symbols;
        if (!Array.isArray(symbols) || symbols.some((x) => typeof x !== 'string' || !NAME_RE.test(x)) || new Set(symbols).size !== symbols.length) throw new AvroError(`Avro enum ${n.name} needs unique symbols`);
        if (o.default !== undefined && !symbols.includes(o.default)) throw new AvroError(`Avro enum ${n.name}: default "${String(o.default)}" is not a symbol`);
        const t: AvroType = { kind: 'enum', name: n.name, aliases: n.aliases, symbols: symbols as string[], ...(typeof o.default === 'string' ? { default: o.default } : {}) };
        this.named.set(n.name, t);
        return t;
      }
      case 'fixed': {
        const n = named();
        const size = Number(o.size);
        if (!Number.isInteger(size) || size < 0) throw new AvroError(`Avro fixed ${n.name} needs a size`);
        const logical = logicalOf(o, 'fixed', size);
        const t: AvroType = { kind: 'fixed', name: n.name, aliases: n.aliases, size, ...(logical ? { logical } : {}) };
        this.named.set(n.name, t);
        return t;
      }
      case 'array': return { kind: 'array', items: this.parse(o.items, ns) };
      case 'map': return { kind: 'map', values: this.parse(o.values, ns) };
      default: {
        if (!PRIMITIVES.has(type)) return this.parse(type, ns);
        const logical = logicalOf(o, type);
        return { kind: type, ...(logical ? { logical } : {}) } as AvroType;
      }
    }
  }

  encode(value: unknown): Uint8Array {
    const w = new Writer();
    write(w, this.root, value, '$');
    return w.bytes();
  }

  /** Decode one datum. With `reader`, the data (written with this schema) is resolved to the reader's schema. */
  decode(bytes: Uint8Array, o: { reader?: AvroSchema; raw?: boolean; partial?: boolean } = {}): unknown {
    const r = new Reader(bytes);
    let v = read(r, this.root, !!o.raw);
    if (!o.partial && r.pos !== bytes.length) throw new AvroError(`${bytes.length - r.pos} byte(s) left after the Avro datum (wrong schema?)`);
    if (o.reader) v = resolveValue(v, this.root, o.reader.root, '$', !!o.raw);
    return v;
  }

  /** Parsing Canonical Form (Avro specification). */
  canonical(): string {
    return canonicalForm(this.json);
  }

  /** CRC-64-AVRO fingerprint of the canonical form, as 16 hex digits. */
  fingerprint(): string {
    return rabinFingerprint(this.canonical()).toString(16).padStart(16, '0');
  }
}

// ------------------------------------------------------------------ binary primitives

class Writer {
  private buf = Buffer.alloc(256);
  private len = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  raw(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  /** Zig-zag varint of a 64-bit signed value. */
  long(v: bigint): void {
    let z = BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
    while (z >= 0x80n) {
      this.byte(Number(z & 0x7fn) | 0x80);
      z >>= 7n;
    }
    this.byte(Number(z));
  }
  int(v: number): void {
    // 32-bit zig-zag fast path
    let z = ((v << 1) ^ (v >> 31)) >>> 0;
    while (z >= 0x80) {
      this.byte((z & 0x7f) | 0x80);
      z >>>= 7;
    }
    this.byte(z);
  }
  float(v: number): void {
    this.ensure(4);
    this.buf.writeFloatLE(v, this.len);
    this.len += 4;
  }
  double(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.len);
    this.len += 8;
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.buf.subarray(0, this.len));
  }
}

class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new AvroError('Avro data ends early (truncated, or not written with this schema)');
  }
  byte(): number {
    this.need(1);
    return this.b[this.pos++];
  }
  long(): bigint {
    let shift = 0n;
    let z = 0n;
    for (let i = 0; ; i++) {
      if (i > 9) throw new AvroError('Avro varint is longer than 10 bytes');
      const b = this.byte();
      z |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return BigInt.asIntN(64, (z >> 1n) ^ -(z & 1n));
  }
  int(): number {
    const v = this.long();
    if (v > 2147483647n || v < -2147483648n) throw new AvroError(`Avro int out of range: ${v}`);
    return Number(v);
  }
  float(): number {
    this.need(4);
    const v = Buffer.from(this.b.buffer, this.b.byteOffset + this.pos, 4).readFloatLE(0);
    this.pos += 4;
    return v;
  }
  double(): number {
    this.need(8);
    const v = Buffer.from(this.b.buffer, this.b.byteOffset + this.pos, 8).readDoubleLE(0);
    this.pos += 8;
    return v;
  }
  raw(n: number): Uint8Array {
    this.need(n);
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  sized(): Uint8Array {
    const n = this.long();
    if (n < 0n) throw new AvroError('Avro negative length');
    return this.raw(Number(n));
  }
}

// ------------------------------------------------------------------ value conversion

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

function toBigInt(v: unknown, path: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new AvroError(`${path}: expected an integer, got ${JSON.stringify(typeof v === 'bigint' ? String(v) : v)}`);
}

function longOut(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
}

function bytesIn(v: unknown, path: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return Buffer.from(v, 'latin1');
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Uint8Array.from(v as number[]);
  throw new AvroError(`${path}: expected bytes (Uint8Array or an ISO-8859-1 string)`);
}

const DAY_MS = 86_400_000;

function epochMs(v: unknown, path: string, local: boolean): bigint {
  if (v instanceof Date) return BigInt(v.getTime());
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) {
    const s = v.trim();
    const iso = local && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? `${s}Z` : s;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new AvroError(`${path}: "${v}" is not a timestamp`);
    return BigInt(t);
  }
  return toBigInt(v, path);
}

/** Microseconds since the epoch from an ISO string keeps the sub-millisecond digits. */
function epochMicros(v: unknown, path: string, local: boolean): bigint {
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) {
    const m = /\.(\d+)/.exec(v);
    const frac = m ? m[1].padEnd(6, '0').slice(0, 6) : '000000';
    const ms = epochMs(v.replace(/\.(\d+)/, ''), path, local);
    return ms * 1000n + BigInt(frac);
  }
  if (v instanceof Date) return BigInt(v.getTime()) * 1000n;
  return toBigInt(v, path);
}

function isoFromMicros(us: bigint, local: boolean): string {
  const ms = us / 1000n - (us % 1000n < 0n ? 1n : 0n);
  const rest = ((us % 1000n) + 1000n) % 1000n;
  const base = new Date(Number(ms)).toISOString();
  const out = base.replace(/Z$/, `${String(rest).padStart(3, '0')}Z`);
  return local ? out.replace(/Z$/, '') : out;
}

function timeOfDay(v: unknown, path: string, unit: 1000 | 1_000_000): number | bigint {
  if (typeof v === 'string' && /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v.trim())) {
    const [h, m, s = '0'] = v.trim().split(':');
    const [sec, frac = ''] = s.split('.');
    const sub = unit === 1000 ? Number(frac.padEnd(3, '0').slice(0, 3)) : Number(frac.padEnd(6, '0').slice(0, 6));
    const whole = (Number(h) * 3600 + Number(m) * 60 + Number(sec));
    return unit === 1000 ? whole * 1000 + sub : BigInt(whole) * 1_000_000n + BigInt(sub);
  }
  return unit === 1000 ? Number(toBigInt(v, path)) : toBigInt(v, path);
}

function timeText(units: bigint, perSecond: bigint): string {
  const totalSec = units / perSecond;
  const sub = units % perSecond;
  const h = totalSec / 3600n;
  const m = (totalSec % 3600n) / 60n;
  const s = totalSec % 60n;
  const pad = (x: bigint, n = 2) => String(x).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(sub, perSecond === 1000n ? 3 : 6)}`;
}

function decimalUnscaled(v: unknown, scale: number, path: string): bigint {
  let s: string;
  if (typeof v === 'bigint') return v * 10n ** BigInt(scale);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new AvroError(`${path}: decimal must be finite`);
    s = v.toFixed(scale);
  } else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) s = v.trim();
  else throw new AvroError(`${path}: expected a decimal number, got ${JSON.stringify(v)}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^-/, '').split('.');
  if (f.length > scale && /[1-9]/.test(f.slice(scale))) throw new AvroError(`${path}: ${s} has more than ${scale} decimal places`);
  const digits = BigInt(i + f.padEnd(scale, '0').slice(0, scale));
  return neg ? -digits : digits;
}

function twosComplement(v: bigint, size?: number): Uint8Array {
  const out: number[] = [];
  let x = v;
  do {
    out.unshift(Number(BigInt.asUintN(8, x)));
    x >>= 8n;
  } while (!((x === 0n && (out[0] & 0x80) === 0) || (x === -1n && (out[0] & 0x80) !== 0)));
  if (size !== undefined) {
    if (out.length > size) throw new AvroError(`decimal does not fit in ${size} bytes`);
    while (out.length < size) out.unshift(v < 0n ? 0xff : 0);
  }
  return Uint8Array.from(out);
}

function fromTwosComplement(b: Uint8Array): bigint {
  if (!b.length) return 0n;
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return b[0] & 0x80 ? x - (1n << BigInt(b.length * 8)) : x;
}

function decimalText(unscaled: bigint, scale: number): string {
  const neg = unscaled < 0n;
  const digits = (neg ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return neg ? `-${text}` : text;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeName(t: AvroType): string {
  return 'name' in t ? t.name : t.kind;
}

/** Does a plain (unwrapped) value fit this branch of a union? Used to pick the branch. */
function fits(t: AvroType, v: unknown): boolean {
  switch (t.kind) {
    case 'null': return v === null || v === undefined;
    case 'boolean': return typeof v === 'boolean';
    case 'int':
      if (t.logical?.name === 'date') return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) || v instanceof Date || (typeof v === 'number' && Number.isInteger(v));
      if (t.logical?.name === 'time-millis') return (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v)) || (typeof v === 'number' && Number.isInteger(v));
      return typeof v === 'number' && Number.isInteger(v) && v >= INT_MIN && v <= INT_MAX;
    case 'long':
      if (t.logical && /timestamp/.test(t.logical.name) && (v instanceof Date || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)))) return true;
      if (t.logical?.name === 'time-micros' && typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v)) return true;
      return (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';
    case 'float': case 'double': return typeof v === 'number';
    case 'string':
      if (t.logical?.name === 'uuid') return typeof v === 'string' && UUID_RE.test(v);
      return typeof v === 'string';
    case 'bytes':
      if (t.logical?.name === 'decimal') return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
      return v instanceof Uint8Array;
    case 'fixed':
      if (t.logical?.name === 'decimal') return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
      if (t.logical?.name === 'duration') return !!v && typeof v === 'object' && !(v instanceof Uint8Array) && 'months' in (v as object);
      return v instanceof Uint8Array && v.length === t.size;
    case 'enum': return typeof v === 'string' && t.symbols.includes(v);
    case 'array': return Array.isArray(v);
    case 'map': return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date);
    case 'record': {
      if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Uint8Array || v instanceof Date) return false;
      const keys = Object.keys(v as object);
      const names = new Set(t.fields.map((f) => f.name));
      return keys.every((k) => names.has(k)) && t.fields.every((f) => f.hasDefault || f.name in (v as object) || f.type.kind === 'null' || (f.type.kind === 'union' && f.type.types.some((x) => x.kind === 'null')));
    }
    case 'union': return false;
  }
}

function unionBranch(t: Extract<AvroType, { kind: 'union' }>, v: unknown, path: string): { index: number; value: unknown } {
  // Avro JSON encoding: {"type name": value}
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof Date)) {
    const keys = Object.keys(v as object);
    if (keys.length === 1) {
      const i = t.types.findIndex((b) => typeName(b) === keys[0] || ('name' in b && b.name.split('.').pop() === keys[0]));
      // A record branch whose only field has that name takes the object as it is.
      const direct = t.types.some((b) => b.kind === 'record' && fits(b, v));
      if (i >= 0 && !direct) return { index: i, value: (v as Record<string, unknown>)[keys[0]] };
    }
  }
  const exact = t.types.findIndex((b) => fits(b, v));
  if (exact >= 0) return { index: exact, value: v };
  // A number written as text, or a long for a union of long/double, etc.
  const loose = t.types.findIndex((b) => {
    try {
      write(new Writer(), b, v, path);
      return true;
    } catch {
      return false;
    }
  });
  if (loose >= 0) return { index: loose, value: v };
  throw new AvroError(`${path}: ${JSON.stringify(v)} matches no branch of the union [${t.types.map(typeName).join(', ')}]`);
}

function write(w: Writer, t: AvroType, v: unknown, path: string): void {
  switch (t.kind) {
    case 'null':
      if (v !== null && v !== undefined) throw new AvroError(`${path}: expected null, got ${JSON.stringify(v)}`);
      return;
    case 'boolean':
      if (typeof v !== 'boolean') throw new AvroError(`${path}: expected a boolean, got ${JSON.stringify(v)}`);
      w.byte(v ? 1 : 0);
      return;
    case 'int': {
      let n: number;
      if (t.logical?.name === 'date' && (typeof v === 'string' || v instanceof Date) && !(typeof v === 'string' && /^-?\d+$/.test(v))) {
        const ms = v instanceof Date ? v.getTime() : Date.parse(`${v}T00:00:00Z`);
        if (Number.isNaN(ms)) throw new AvroError(`${path}: "${String(v)}" is not a date (YYYY-MM-DD)`);
        n = Math.floor(ms / DAY_MS);
      } else if (t.logical?.name === 'time-millis') n = Number(timeOfDay(v, path, 1000));
      else n = Number(toBigInt(v, path));
      if (n < INT_MIN || n > INT_MAX) throw new AvroError(`${path}: ${n} does not fit an Avro int`);
      w.int(n);
      return;
    }
    case 'long': {
      let n: bigint;
      const lt = t.logical?.name;
      if (lt === 'timestamp-millis' || lt === 'local-timestamp-millis') n = epochMs(v, path, lt.startsWith('local'));
      else if (lt === 'timestamp-micros' || lt === 'local-timestamp-micros') n = epochMicros(v, path, lt.startsWith('local'));
      else if (lt === 'time-micros') n = BigInt(timeOfDay(v, path, 1_000_000));
      else n = toBigInt(v, path);
      if (n < LONG_MIN || n > LONG_MAX) throw new AvroError(`${path}: ${n} does not fit an Avro long`);
      w.long(n);
      return;
    }
    case 'float': case 'double': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : typeof v === 'bigint' ? Number(v) : NaN;
      if (Number.isNaN(n) && v !== 'NaN' && !(typeof v === 'number')) throw new AvroError(`${path}: expected a number, got ${JSON.stringify(v)}`);
      if (t.kind === 'float') w.float(n);
      else w.double(n);
      return;
    }
    case 'bytes': {
      const b = t.logical?.name === 'decimal' && !(v instanceof Uint8Array) ? twosComplement(decimalUnscaled(v, t.logical.scale, path)) : bytesIn(v, path);
      w.long(BigInt(b.length));
      w.raw(b);
      return;
    }
    case 'string': {
      if (typeof v !== 'string') throw new AvroError(`${path}: expected a string, got ${JSON.stringify(v)}`);
      if (t.logical?.name === 'uuid' && !UUID_RE.test(v)) throw new AvroError(`${path}: "${v}" is not a UUID`);
      const b = Buffer.from(v, 'utf8');
      w.long(BigInt(b.length));
      w.raw(b);
      return;
    }
    case 'fixed': {
      let b: Uint8Array;
      if (t.logical?.name === 'decimal' && !(v instanceof Uint8Array)) b = twosComplement(decimalUnscaled(v, t.logical.scale, path), t.size);
      else if (t.logical?.name === 'duration' && v && typeof v === 'object' && !(v instanceof Uint8Array)) {
        const d = Array.isArray(v) ? { months: v[0], days: v[1], milliseconds: v[2] } : (v as { months: number; days: number; milliseconds: number });
        const buf = Buffer.alloc(12);
        buf.writeUInt32LE(Number(d.months ?? 0), 0);
        buf.writeUInt32LE(Number(d.days ?? 0), 4);
        buf.writeUInt32LE(Number(d.milliseconds ?? 0), 8);
        b = new Uint8Array(buf);
      } else if (t.logical?.name === 'uuid' && typeof v === 'string') {
        if (!UUID_RE.test(v)) throw new AvroError(`${path}: "${v}" is not a UUID`);
        b = Buffer.from(v.replace(/-/g, ''), 'hex');
      } else b = bytesIn(v, path);
      if (b.length !== t.size) throw new AvroError(`${path}: fixed ${t.name} needs ${t.size} bytes, got ${b.length}`);
      w.raw(b);
      return;
    }
    case 'enum': {
      const i = typeof v === 'string' ? t.symbols.indexOf(v) : -1;
      if (i < 0) throw new AvroError(`${path}: ${JSON.stringify(v)} is not a symbol of enum ${t.name} (${t.symbols.join(', ')})`);
      w.int(i);
      return;
    }
    case 'array': {
      if (!Array.isArray(v)) throw new AvroError(`${path}: expected an array, got ${JSON.stringify(v)}`);
      if (v.length) {
        w.long(BigInt(v.length));
        v.forEach((x, i) => write(w, t.items, x, `${path}[${i}]`));
      }
      w.long(0n);
      return;
    }
    case 'map': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AvroError(`${path}: expected a map (object), got ${JSON.stringify(v)}`);
      const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
      if (entries.length) {
        w.long(BigInt(entries.length));
        for (const [k, x] of entries) {
          const kb = Buffer.from(String(k), 'utf8');
          w.long(BigInt(kb.length));
          w.raw(kb);
          write(w, t.values, x, `${path}.${String(k)}`);
        }
      }
      w.long(0n);
      return;
    }
    case 'record': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AvroError(`${path}: expected a ${t.name} record (object), got ${JSON.stringify(v)}`);
      const o = v as Record<string, unknown>;
      const known = new Set(t.fields.map((f) => f.name));
      const extra = Object.keys(o).filter((k) => !known.has(k));
      if (extra.length) throw new AvroError(`${path}: field(s) ${extra.join(', ')} are not in record ${t.name}`);
      for (const f of t.fields) {
        let fv = o[f.name];
        if (fv === undefined && f.hasDefault) fv = fromAvroJson(f.type, f.default, false);
        if (fv === undefined && !(f.type.kind === 'null' || (f.type.kind === 'union' && f.type.types.some((x) => x.kind === 'null')))) throw new AvroError(`${path}: record ${t.name} needs field "${f.name}"`);
        write(w, f.type, fv === undefined ? null : fv, `${path}.${f.name}`);
      }
      return;
    }
    case 'union': {
      const { index, value } = unionBranch(t, v, path);
      w.long(BigInt(index));
      write(w, t.types[index], value, path);
      return;
    }
  }
}

function read(r: Reader, t: AvroType, raw: boolean): unknown {
  switch (t.kind) {
    case 'null': return null;
    case 'boolean': {
      const b = r.byte();
      if (b > 1) throw new AvroError(`Invalid Avro boolean byte ${b}`);
      return b === 1;
    }
    case 'int': {
      const n = r.int();
      if (raw || !t.logical) return n;
      if (t.logical.name === 'date') return new Date(n * DAY_MS).toISOString().slice(0, 10);
      if (t.logical.name === 'time-millis') return timeText(BigInt(n), 1000n);
      return n;
    }
    case 'long': {
      const n = r.long();
      const lt = raw ? undefined : t.logical?.name;
      if (lt === 'timestamp-millis') return new Date(Number(n)).toISOString();
      if (lt === 'local-timestamp-millis') return new Date(Number(n)).toISOString().replace(/Z$/, '');
      if (lt === 'timestamp-micros' || lt === 'local-timestamp-micros') return isoFromMicros(n, lt.startsWith('local'));
      if (lt === 'time-micros') return timeText(n, 1_000_000n);
      return longOut(n);
    }
    case 'float': return r.float();
    case 'double': return r.double();
    case 'bytes': {
      const b = r.sized();
      if (!raw && t.logical?.name === 'decimal') return decimalText(fromTwosComplement(b), t.logical.scale);
      return b;
    }
    case 'string': return Buffer.from(r.sized()).toString('utf8');
    case 'fixed': {
      const b = r.raw(t.size);
      if (!raw && t.logical?.name === 'decimal') return decimalText(fromTwosComplement(b), t.logical.scale);
      if (!raw && t.logical?.name === 'duration') {
        const buf = Buffer.from(b);
        return { months: buf.readUInt32LE(0), days: buf.readUInt32LE(4), milliseconds: buf.readUInt32LE(8) };
      }
      if (!raw && t.logical?.name === 'uuid') {
        const h = Buffer.from(b).toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      return b;
    }
    case 'enum': {
      const i = r.int();
      if (i < 0 || i >= t.symbols.length) throw new AvroError(`Avro enum ${t.name}: index ${i} out of range`);
      return t.symbols[i];
    }
    case 'array': {
      const out: unknown[] = [];
      for (;;) {
        let n = r.long();
        if (n === 0n) return out;
        if (n < 0n) {
          n = -n;
          r.long(); // block size in bytes
        }
        for (let i = 0n; i < n; i++) out.push(read(r, t.items, raw));
      }
    }
    case 'map': {
      const out: Record<string, unknown> = {};
      for (;;) {
        let n = r.long();
        if (n === 0n) return out;
        if (n < 0n) {
          n = -n;
          r.long();
        }
        for (let i = 0n; i < n; i++) {
          const k = Buffer.from(r.sized()).toString('utf8');
          out[k] = read(r, t.values, raw);
        }
      }
    }
    case 'record': {
      const out: Record<string, unknown> = {};
      for (const f of t.fields) out[f.name] = read(r, f.type, raw);
      return out;
    }
    case 'union': {
      const i = Number(r.long());
      if (i < 0 || i >= t.types.length) throw new AvroError(`Avro union index ${i} out of range (${t.types.length} branches)`);
      return read(r, t.types[i], raw);
    }
  }
}

/** A value in Avro JSON form (defaults, the JSON encoding of unions) as an encodable value. */
export function fromAvroJson(t: AvroType, v: unknown, strict: boolean): unknown {
  switch (t.kind) {
    case 'union': {
      // A field default is for the first branch of the union.
      if (strict) return fromAvroJson(t.types[0], v, strict);
      return v;
    }
    case 'bytes': case 'fixed':
      if (typeof v === 'string' && !t.logical) {
        const b = Buffer.from(v, 'latin1');
        if (t.kind === 'fixed' && b.length !== t.size) throw new AvroError(`default for fixed ${t.name} needs ${t.size} bytes`);
        return new Uint8Array(b);
      }
      break;
    case 'record': {
      if (!v || typeof v !== 'object') throw new AvroError(`expected an object for record ${t.name}`);
      const out: Record<string, unknown> = {};
      for (const f of t.fields) {
        const x = (v as Record<string, unknown>)[f.name];
        out[f.name] = x === undefined ? (f.hasDefault ? fromAvroJson(f.type, f.default, strict) : (() => {
          throw new AvroError(`record ${t.name} default lacks field "${f.name}"`);
        })()) : fromAvroJson(f.type, x, strict);
      }
      return out;
    }
    case 'array':
      if (!Array.isArray(v)) throw new AvroError('expected an array');
      return v.map((x) => fromAvroJson(t.items, x, strict));
    case 'map':
      if (!v || typeof v !== 'object') throw new AvroError('expected an object');
      return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, fromAvroJson(t.values, x, strict)]));
    default:
      break;
  }
  if (strict) write(new Writer(), t, v, 'default');
  return v;
}

// ------------------------------------------------------------------ schema resolution

function namesMatch(w: AvroType, r: AvroType): boolean {
  if (!('name' in w) || !('name' in r)) return false;
  const short = (n: string) => n.split('.').pop();
  return w.name === r.name || r.aliases.includes(w.name) || short(w.name) === short(r.name) || r.aliases.some((a) => short(a) === short(w.name));
}

/** Can data written with `w` be read as `r` (types only; for records, field by field)? */
function matches(w: AvroType, r: AvroType): boolean {
  if (w.kind === r.kind) {
    if (w.kind === 'record' || w.kind === 'enum' || w.kind === 'fixed') return namesMatch(w, r) && (w.kind !== 'fixed' || w.size === (r as { size: number }).size);
    return true;
  }
  const promo: Record<string, string[]> = { int: ['long', 'float', 'double'], long: ['float', 'double'], float: ['double'], string: ['bytes'], bytes: ['string'] };
  return (promo[w.kind] ?? []).includes(r.kind);
}

/** Problems reading data written with `writer` through `reader` (empty = compatible). */
export function resolutionProblems(writer: AvroType, reader: AvroType, path = '$', seen = new Set<string>()): string[] {
  if (writer.kind === 'union') {
    return writer.types.flatMap((b) => resolutionProblems(b, reader, path, seen));
  }
  if (reader.kind === 'union') {
    const b = reader.types.find((x) => matches(writer, x) && x.kind === writer.kind) ?? reader.types.find((x) => matches(writer, x));
    return b ? resolutionProblems(writer, b, path, seen) : [`${path}: the reader's union [${reader.types.map(typeName).join(', ')}] has no branch for the writer's ${typeName(writer)}`];
  }
  if (!matches(writer, reader)) return [`${path}: the writer's ${typeName(writer)} cannot be read as ${typeName(reader)}`];
  switch (writer.kind) {
    case 'record': {
      const key = `${writer.name}>${(reader as { name: string }).name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const rr = reader as Extract<AvroType, { kind: 'record' }>;
      const out: string[] = [];
      for (const rf of rr.fields) {
        const wf = writer.fields.find((f) => f.name === rf.name || rf.aliases.includes(f.name));
        if (wf) out.push(...resolutionProblems(wf.type, rf.type, `${path}.${rf.name}`, seen));
        else if (!rf.hasDefault) out.push(`${path}.${rf.name}: the reader's field has no default and the writer does not write it`);
      }
      return out;
    }
    case 'enum': {
      const re = reader as Extract<AvroType, { kind: 'enum' }>;
      const missing = writer.symbols.filter((s) => !re.symbols.includes(s));
      return missing.length && re.default === undefined ? [`${path}: the reader's enum ${re.name} lacks symbol(s) ${missing.join(', ')} and has no default`] : [];
    }
    case 'array': return resolutionProblems(writer.items, (reader as Extract<AvroType, { kind: 'array' }>).items, `${path}[]`, seen);
    case 'map': return resolutionProblems(writer.values, (reader as Extract<AvroType, { kind: 'map' }>).values, `${path}{}`, seen);
    default: return [];
  }
}

function resolveValue(v: unknown, w: AvroType, r: AvroType, path: string, raw: boolean): unknown {
  if (w.kind === 'union') {
    const branch = w.types.find((b) => fits(b, v) || (b.kind === 'null' && v === null)) ?? w.types[0];
    return resolveValue(v, branch, r, path, raw);
  }
  if (r.kind === 'union') {
    const b = r.types.find((x) => matches(w, x) && x.kind === w.kind) ?? r.types.find((x) => matches(w, x));
    if (!b) throw new AvroError(`${path}: the reader's union has no branch for ${typeName(w)}`);
    return resolveValue(v, w, b, path, raw);
  }
  if (!matches(w, r)) throw new AvroError(`${path}: the writer's ${typeName(w)} cannot be read as ${typeName(r)}`);
  switch (w.kind) {
    case 'int': case 'long':
      if (r.kind === 'float' || r.kind === 'double') return Number(v);
      if (r.kind === 'long' && typeof v === 'number') return v;
      return v;
    case 'float': return v;
    case 'string': return r.kind === 'bytes' ? new Uint8Array(Buffer.from(String(v), 'utf8')) : v;
    case 'bytes': return r.kind === 'string' && v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : v;
    case 'enum': {
      const re = r as Extract<AvroType, { kind: 'enum' }>;
      if (re.symbols.includes(String(v))) return v;
      if (re.default !== undefined) return re.default;
      throw new AvroError(`${path}: symbol ${String(v)} is not in the reader's enum ${re.name}`);
    }
    case 'array': return (v as unknown[]).map((x, i) => resolveValue(x, w.items, (r as Extract<AvroType, { kind: 'array' }>).items, `${path}[${i}]`, raw));
    case 'map': return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, resolveValue(x, w.values, (r as Extract<AvroType, { kind: 'map' }>).values, `${path}.${k}`, raw)]));
    case 'record': {
      const rr = r as Extract<AvroType, { kind: 'record' }>;
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const rf of rr.fields) {
        const wf = w.fields.find((f) => f.name === rf.name || rf.aliases.includes(f.name));
        if (wf) out[rf.name] = resolveValue(src[wf.name], wf.type, rf.type, `${path}.${rf.name}`, raw);
        else if (rf.hasDefault) {
          // A default is in Avro JSON form: encode then decode it to get the reader's representation.
          const tmp = new Writer();
          write(tmp, rf.type, fromAvroJson(rf.type, rf.default, false), path);
          out[rf.name] = read(new Reader(tmp.bytes()), rf.type, raw);
        } else throw new AvroError(`${path}.${rf.name}: no value written and no default`);
      }
      return out;
    }
    default: return v;
  }
}

/** Compatibility as a schema registry checks it: BACKWARD (new reads old), FORWARD (old reads new), FULL (both). */
export function avroCompatibility(newer: AvroSchema, older: AvroSchema, mode: 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE' = 'BACKWARD'): string[] {
  if (mode === 'NONE') return [];
  const back = mode === 'BACKWARD' || mode === 'FULL' ? resolutionProblems(older.root, newer.root) : [];
  const fwd = mode === 'FORWARD' || mode === 'FULL' ? resolutionProblems(newer.root, older.root) : [];
  return [...back, ...fwd];
}

// ------------------------------------------------------------------ canonical form and fingerprint

/** Parsing Canonical Form: full names, only the attributes that matter, fixed key order, no whitespace. */
export function canonicalForm(schema: unknown): string {
  const done = new Set<string>();
  const walk = (s: unknown, ns: string | undefined): string => {
    if (typeof s === 'string') {
      if (PRIMITIVES.has(s)) return JSON.stringify(s);
      return JSON.stringify(fullName(s, ns));
    }
    if (Array.isArray(s)) return `[${s.map((x) => walk(x, ns)).join(',')}]`;
    const o = s as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== 'string') return walk(type, ns);
    if (PRIMITIVES.has(type)) return JSON.stringify(type);
    if (type === 'array') return `{"type":"array","items":${walk(o.items, ns)}}`;
    if (type === 'map') return `{"type":"map","values":${walk(o.values, ns)}}`;
    if (type === 'record' || type === 'error' || type === 'enum' || type === 'fixed') {
      const name = fullName(String(o.name), typeof o.namespace === 'string' && o.namespace ? o.namespace : ns);
      if (done.has(name)) return JSON.stringify(name);
      done.add(name);
      const space = nsOf(name);
      if (type === 'enum') return `{"name":${JSON.stringify(name)},"type":"enum","symbols":${JSON.stringify(o.symbols)}}`;
      if (type === 'fixed') return `{"name":${JSON.stringify(name)},"type":"fixed","size":${Number(o.size)}}`;
      const fields = (o.fields as Array<Record<string, unknown>>).map((f) => `{"name":${JSON.stringify(f.name)},"type":${walk(f.type, space)}}`);
      return `{"name":${JSON.stringify(name)},"type":"record","fields":[${fields.join(',')}]}`;
    }
    return JSON.stringify(fullName(type, ns));
  };
  const json = typeof schema === 'string' && /^\s*[[{"]/.test(schema) ? JSON.parse(schema) : schema;
  return walk(json, undefined);
}

const EMPTY64 = 0xc15d213aa4d7a795n;
let FP_TABLE: bigint[] | undefined;

/** CRC-64-AVRO (Rabin) fingerprint, as the specification defines it. */
export function rabinFingerprint(text: string): bigint {
  if (!FP_TABLE) {
    FP_TABLE = [];
    for (let i = 0; i < 256; i++) {
      let fp = BigInt(i);
      for (let j = 0; j < 8; j++) fp = (fp >> 1n) ^ (EMPTY64 & -(fp & 1n));
      FP_TABLE.push(BigInt.asUintN(64, fp));
    }
  }
  let fp = EMPTY64;
  for (const b of Buffer.from(text, 'utf8')) fp = BigInt.asUintN(64, (fp >> 8n) ^ FP_TABLE[Number((fp ^ BigInt(b)) & 0xffn)]);
  return fp;
}

// ------------------------------------------------------------------ Confluent wire format

/** Magic byte 0 + 4-byte big-endian schema id + payload. */
export function frameConfluent(schemaId: number, payload: Uint8Array, prefix: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = Buffer.alloc(5 + prefix.length + payload.length);
  out[0] = 0;
  out.writeUInt32BE(schemaId >>> 0, 1);
  out.set(prefix, 5);
  out.set(payload, 5 + prefix.length);
  return new Uint8Array(out);
}

/** The schema id and payload of a Confluent-framed message, or undefined when it is not framed. */
export function unframeConfluent(bytes: Uint8Array): { schemaId: number; payload: Uint8Array } | undefined {
  if (bytes.length < 5 || bytes[0] !== 0) return undefined;
  return { schemaId: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).readUInt32BE(1), payload: bytes.subarray(5) };
}

/** A decoded value as plain JSON (Uint8Array as an ISO-8859-1 string, the Avro JSON convention). */
export function avroToJson(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('latin1');
  if (Array.isArray(v)) return v.map(avroToJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, avroToJson(x)]));
  return v;
}
