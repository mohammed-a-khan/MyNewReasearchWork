/**
 * The AMQP 1.0 type system (OASIS AMQP 1.0, Part 1: Types), written from the
 * specification: every fixed-width, variable-width, compound and array
 * encoding, and described types. Values that JavaScript cannot tell apart
 * (uint vs int, string vs symbol, list vs array) are wrapped in typed
 * values on the way out; decoding returns plain JavaScript values (64-bit
 * integers as numbers when they are safe, else bigint) and described values
 * as { descriptor, value }.
 */

export type AmqpValue =
  | null | undefined | boolean | number | bigint | string | Buffer | Date | AmqpValue[]
  | Typed | Described | { [k: string]: AmqpValue };

export class Typed {
  constructor(readonly type: TypeName, readonly value: unknown, readonly elementType?: TypeName) {}
}

export class Described {
  constructor(readonly descriptor: AmqpValue, readonly value: AmqpValue) {}
}

export type TypeName =
  | 'null' | 'boolean' | 'ubyte' | 'ushort' | 'uint' | 'ulong' | 'byte' | 'short' | 'int' | 'long' | 'float' | 'double'
  | 'char' | 'timestamp' | 'uuid' | 'binary' | 'string' | 'symbol' | 'list' | 'map' | 'array';

// Typed constructors (encoding hints).
export const ubyte = (n: number) => new Typed('ubyte', n);
export const ushort = (n: number) => new Typed('ushort', n);
export const uint = (n: number) => new Typed('uint', n);
export const ulong = (n: number | bigint) => new Typed('ulong', n);
export const byte = (n: number) => new Typed('byte', n);
export const short = (n: number) => new Typed('short', n);
export const int = (n: number) => new Typed('int', n);
export const long = (n: number | bigint) => new Typed('long', n);
export const float = (n: number) => new Typed('float', n);
export const double = (n: number) => new Typed('double', n);
export const char = (c: string) => new Typed('char', c);
export const timestamp = (d: Date | number) => new Typed('timestamp', d instanceof Date ? d.getTime() : d);
export const uuid = (u: string | Buffer) => new Typed('uuid', u);
export const binary = (b: Buffer | Uint8Array) => new Typed('binary', Buffer.from(b));
export const sym = (s: string) => new Typed('symbol', s);
export const list = (items: AmqpValue[]) => new Typed('list', items);
/** A map with explicit key/value pairs (keys may be typed, e.g. symbols). */
export const map = (pairs: Array<[AmqpValue, AmqpValue]>) => new Typed('map', pairs);
/** A map with symbol keys. */
export const symMap = (o: Record<string, AmqpValue>) => map(Object.entries(o).map(([k, v]) => [sym(k), v]));
export const array = (elementType: TypeName, items: unknown[]) => new Typed('array', items, elementType);
export const described = (code: number | bigint, value: AmqpValue) => new Described(ulong(code), value);

export class AmqpCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmqpCodecError';
  }
}

// ------------------------------------------------------------------ encoding

class Writer {
  private chunks: Buffer[] = [];
  length = 0;
  push(b: Buffer) {
    this.chunks.push(b);
    this.length += b.length;
  }
  byte(n: number) {
    this.push(Buffer.from([n & 0xff]));
  }
  done(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function uuidBytes(u: string | Buffer): Buffer {
  if (Buffer.isBuffer(u)) return u;
  const hex = u.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new AmqpCodecError(`Not a UUID: ${u}`);
  return Buffer.from(hex, 'hex');
}

/** Encode one value (constructor + data). */
export function encode(v: AmqpValue): Buffer {
  const w = new Writer();
  write(w, v);
  return w.done();
}

function write(w: Writer, v: AmqpValue): void {
  if (v === null || v === undefined) return w.byte(0x40);
  if (v instanceof Described) {
    w.byte(0x00);
    write(w, v.descriptor);
    write(w, v.value);
    return;
  }
  if (v instanceof Typed) return writeTyped(w, v.type, v.value, v.elementType);
  if (typeof v === 'boolean') return w.byte(v ? 0x41 : 0x42);
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) return writeTyped(w, 'int', v);
    if (Number.isInteger(v) && Number.isSafeInteger(v)) return writeTyped(w, 'long', v);
    return writeTyped(w, 'double', v);
  }
  if (typeof v === 'bigint') return writeTyped(w, 'long', v);
  if (typeof v === 'string') return writeTyped(w, 'string', v);
  if (Buffer.isBuffer(v)) return writeTyped(w, 'binary', v);
  if (v instanceof Date) return writeTyped(w, 'timestamp', v.getTime());
  if (Array.isArray(v)) return writeTyped(w, 'list', v);
  // Plain object: a map with string keys.
  return writeTyped(w, 'map', Object.entries(v).map(([k, x]) => [k, x]));
}

function writeTyped(w: Writer, type: TypeName, value: unknown, elementType?: TypeName): void {
  switch (type) {
    case 'null': return w.byte(0x40);
    case 'boolean': return w.byte(value ? 0x41 : 0x42);
    case 'ubyte': {
      w.byte(0x50);
      return w.byte(Number(value));
    }
    case 'ushort': {
      const b = Buffer.alloc(3);
      b[0] = 0x60;
      b.writeUInt16BE(Number(value), 1);
      return w.push(b);
    }
    case 'uint': {
      const n = Number(value);
      if (n === 0) return w.byte(0x43);
      if (n < 256) return w.push(Buffer.from([0x52, n]));
      return w.push(Buffer.concat([Buffer.from([0x70]), u32(n)]));
    }
    case 'ulong': {
      const n = BigInt(value as number | bigint);
      if (n === 0n) return w.byte(0x44);
      if (n < 256n) return w.push(Buffer.from([0x53, Number(n)]));
      const b = Buffer.alloc(9);
      b[0] = 0x80;
      b.writeBigUInt64BE(n, 1);
      return w.push(b);
    }
    case 'byte': {
      const b = Buffer.alloc(2);
      b[0] = 0x51;
      b.writeInt8(Number(value), 1);
      return w.push(b);
    }
    case 'short': {
      const b = Buffer.alloc(3);
      b[0] = 0x61;
      b.writeInt16BE(Number(value), 1);
      return w.push(b);
    }
    case 'int': {
      const n = Number(value);
      if (n >= -128 && n <= 127) {
        const b = Buffer.alloc(2);
        b[0] = 0x54;
        b.writeInt8(n, 1);
        return w.push(b);
      }
      const b = Buffer.alloc(5);
      b[0] = 0x71;
      b.writeInt32BE(n, 1);
      return w.push(b);
    }
    case 'long': {
      const n = BigInt(value as number | bigint);
      if (n >= -128n && n <= 127n) {
        const b = Buffer.alloc(2);
        b[0] = 0x55;
        b.writeInt8(Number(n), 1);
        return w.push(b);
      }
      const b = Buffer.alloc(9);
      b[0] = 0x81;
      b.writeBigInt64BE(n, 1);
      return w.push(b);
    }
    case 'float': {
      const b = Buffer.alloc(5);
      b[0] = 0x72;
      b.writeFloatBE(Number(value), 1);
      return w.push(b);
    }
    case 'double': {
      const b = Buffer.alloc(9);
      b[0] = 0x82;
      b.writeDoubleBE(Number(value), 1);
      return w.push(b);
    }
    case 'char': {
      const b = Buffer.alloc(5);
      b[0] = 0x73;
      b.writeUInt32BE(String(value).codePointAt(0) ?? 0, 1);
      return w.push(b);
    }
    case 'timestamp': {
      const b = Buffer.alloc(9);
      b[0] = 0x83;
      b.writeBigInt64BE(BigInt(Math.round(Number(value))), 1);
      return w.push(b);
    }
    case 'uuid': return w.push(Buffer.concat([Buffer.from([0x98]), uuidBytes(value as string)]));
    case 'binary': {
      const data = Buffer.from(value as Buffer);
      return w.push(data.length < 256 ? Buffer.concat([Buffer.from([0xa0, data.length]), data]) : Buffer.concat([Buffer.from([0xb0]), u32(data.length), data]));
    }
    case 'string':
    case 'symbol': {
      const data = Buffer.from(String(value), type === 'string' ? 'utf8' : 'ascii');
      const small = type === 'string' ? 0xa1 : 0xa3;
      const large = type === 'string' ? 0xb1 : 0xb3;
      return w.push(data.length < 256 ? Buffer.concat([Buffer.from([small, data.length]), data]) : Buffer.concat([Buffer.from([large]), u32(data.length), data]));
    }
    case 'list': {
      const items = value as AmqpValue[];
      if (!items.length) return w.byte(0x45);
      const body = Buffer.concat(items.map((i) => encode(i)));
      if (body.length + 1 < 256 && items.length < 256) return w.push(Buffer.concat([Buffer.from([0xc0, body.length + 1, items.length]), body]));
      return w.push(Buffer.concat([Buffer.from([0xd0]), u32(body.length + 4), u32(items.length), body]));
    }
    case 'map': {
      const pairs = value as Array<[AmqpValue, AmqpValue]>;
      const body = Buffer.concat(pairs.flatMap(([k, x]) => [encode(k), encode(x)]));
      const count = pairs.length * 2;
      if (body.length + 1 < 256 && count < 256) return w.push(Buffer.concat([Buffer.from([0xc1, body.length + 1, count]), body]));
      return w.push(Buffer.concat([Buffer.from([0xd1]), u32(body.length + 4), u32(count), body]));
    }
    case 'array': {
      const items = value as unknown[];
      const et = elementType ?? 'symbol';
      // Elements share one constructor: encode each with the wide form of the element type.
      const ctor = ARRAY_CTOR[et];
      if (ctor === undefined) throw new AmqpCodecError(`Arrays of ${et} are not supported`);
      const body = Buffer.concat(items.map((i) => arrayElement(et, i)));
      const head = Buffer.from([ctor]);
      if (body.length + 2 < 256 && items.length < 256) return w.push(Buffer.concat([Buffer.from([0xe0, body.length + 2, items.length]), head, body]));
      return w.push(Buffer.concat([Buffer.from([0xf0]), u32(body.length + 5), u32(items.length), head, body]));
    }
  }
}

const ARRAY_CTOR: Partial<Record<TypeName, number>> = { symbol: 0xb3, string: 0xb1, uint: 0x70, ulong: 0x80, int: 0x71, long: 0x81, ubyte: 0x50, boolean: 0x56, binary: 0xb0, timestamp: 0x83, uuid: 0x98, double: 0x82 };

function arrayElement(t: TypeName, v: unknown): Buffer {
  switch (t) {
    case 'symbol':
    case 'string': {
      const d = Buffer.from(String(v), t === 'string' ? 'utf8' : 'ascii');
      return Buffer.concat([u32(d.length), d]);
    }
    case 'binary': {
      const d = Buffer.from(v as Buffer);
      return Buffer.concat([u32(d.length), d]);
    }
    case 'uint': return u32(Number(v));
    case 'int': {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Number(v));
      return b;
    }
    case 'ulong': {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(v as number));
      return b;
    }
    case 'long':
    case 'timestamp': {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(BigInt(Math.round(Number(v))));
      return b;
    }
    case 'ubyte': return Buffer.from([Number(v)]);
    case 'boolean': return Buffer.from([v ? 1 : 0]);
    case 'uuid': return uuidBytes(v as string);
    case 'double': {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(Number(v));
      return b;
    }
    default: throw new AmqpCodecError(`Arrays of ${t} are not supported`);
  }
}

// ------------------------------------------------------------------ decoding

/** Decoded symbol: a string that remembers it was a symbol (equal to its text when compared loosely). */
export interface DecodedDescribed {
  descriptor: AmqpValue;
  value: AmqpValue;
}

export class Reader {
  constructor(readonly buf: Buffer, public pos = 0) {}

  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new AmqpCodecError(`Truncated AMQP value (need ${n} bytes at ${this.pos} of ${this.buf.length})`);
  }

  read(): AmqpValue {
    this.need(1);
    const code = this.buf[this.pos++];
    if (code === 0x00) {
      const descriptor = this.read();
      const value = this.read();
      return new Described(descriptor, value);
    }
    return this.readWith(code);
  }

  /** Read a value whose constructor is `code` (already consumed). */
  readWith(code: number): AmqpValue {
    const b = this.buf;
    const take = (n: number) => {
      this.need(n);
      const s = b.subarray(this.pos, this.pos + n);
      this.pos += n;
      return s;
    };
    const big = (n: bigint) => (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
    switch (code) {
      case 0x40: return null;
      case 0x41: return true;
      case 0x42: return false;
      case 0x56: return take(1)[0] !== 0;
      case 0x50: return take(1)[0];
      case 0x60: return take(2).readUInt16BE(0);
      case 0x70: return take(4).readUInt32BE(0);
      case 0x52: return take(1)[0];
      case 0x43: return 0;
      case 0x80: return big(take(8).readBigUInt64BE(0));
      case 0x53: return take(1)[0];
      case 0x44: return 0;
      case 0x51: return take(1).readInt8(0);
      case 0x61: return take(2).readInt16BE(0);
      case 0x71: return take(4).readInt32BE(0);
      case 0x54: return take(1).readInt8(0);
      case 0x81: return big(take(8).readBigInt64BE(0));
      case 0x55: return take(1).readInt8(0);
      case 0x72: return take(4).readFloatBE(0);
      case 0x82: return take(8).readDoubleBE(0);
      case 0x74: return Buffer.from(take(4));
      case 0x84: return Buffer.from(take(8));
      case 0x94: return Buffer.from(take(16));
      case 0x73: return String.fromCodePoint(take(4).readUInt32BE(0));
      case 0x83: return new Date(Number(take(8).readBigInt64BE(0)));
      case 0x98: {
        const h = take(16).toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
      case 0xa0: return Buffer.from(take(take(1)[0]));
      case 0xb0: return Buffer.from(take(take(4).readUInt32BE(0)));
      case 0xa1: return take(take(1)[0]).toString('utf8');
      case 0xb1: return take(take(4).readUInt32BE(0)).toString('utf8');
      case 0xa3: return take(take(1)[0]).toString('ascii');
      case 0xb3: return take(take(4).readUInt32BE(0)).toString('ascii');
      case 0x45: return [];
      case 0xc0:
      case 0xd0: {
        const wide = code === 0xd0;
        const size = wide ? take(4).readUInt32BE(0) : take(1)[0];
        const end = this.pos + size;
        const count = wide ? take(4).readUInt32BE(0) : take(1)[0];
        const items: AmqpValue[] = [];
        for (let i = 0; i < count; i++) items.push(this.read());
        if (this.pos !== end) throw new AmqpCodecError(`List size mismatch (${this.pos} != ${end})`);
        return items;
      }
      case 0xc1:
      case 0xd1: {
        const wide = code === 0xd1;
        const size = wide ? take(4).readUInt32BE(0) : take(1)[0];
        const end = this.pos + size;
        const count = wide ? take(4).readUInt32BE(0) : take(1)[0];
        const out: Record<string, AmqpValue> = {};
        for (let i = 0; i < count; i += 2) {
          const k = this.read();
          out[typeof k === 'object' && k !== null && !Buffer.isBuffer(k) ? JSON.stringify(k) : String(k)] = this.read();
        }
        if (this.pos !== end) throw new AmqpCodecError(`Map size mismatch (${this.pos} != ${end})`);
        return out;
      }
      case 0xe0:
      case 0xf0: {
        const wide = code === 0xf0;
        const size = wide ? take(4).readUInt32BE(0) : take(1)[0];
        const end = this.pos + size;
        const count = wide ? take(4).readUInt32BE(0) : take(1)[0];
        this.need(1);
        let ctor = b[this.pos++];
        let descriptor: AmqpValue | undefined;
        if (ctor === 0x00) {
          descriptor = this.read();
          this.need(1);
          ctor = b[this.pos++];
        }
        const items: AmqpValue[] = [];
        for (let i = 0; i < count; i++) {
          const v = this.readWith(ctor);
          items.push(descriptor !== undefined ? new Described(descriptor, v) : v);
        }
        if (this.pos !== end) throw new AmqpCodecError(`Array size mismatch (${this.pos} != ${end})`);
        return items;
      }
      default:
        throw new AmqpCodecError(`Unknown AMQP type constructor 0x${code.toString(16)} at ${this.pos - 1}`);
    }
  }
}

/** Decode one value from a buffer (returns the value and the bytes used). */
export function decode(buf: Buffer, pos = 0): { value: AmqpValue; end: number } {
  const r = new Reader(buf, pos);
  const value = r.read();
  return { value, end: r.pos };
}

/** A decoded described value. */
export function isDescribed(v: unknown): v is Described {
  return v instanceof Described;
}

/** The numeric descriptor of a decoded described value (symbolic descriptors return their name). */
export function descriptorOf(v: Described): number | string {
  const d = v.descriptor;
  return typeof d === 'bigint' ? Number(d) : (d as number | string);
}
