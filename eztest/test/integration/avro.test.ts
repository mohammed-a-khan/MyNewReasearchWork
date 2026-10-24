/**
 * EZTest's own Avro codec against the Apache Avro specification: the
 * specification's binary examples (zig-zag ints, strings, arrays, unions,
 * the "test" record), every type and logical type round-tripped, schema
 * resolution and registry compatibility, Parsing Canonical Form, the
 * CRC-64-AVRO fingerprint and the Confluent wire format.
 */
import { describe, expect, it } from '../support/testkit.js';
import { AvroSchema, avroCompatibility, canonicalForm, frameConfluent, rabinFingerprint, unframeConfluent } from '../../src/integration/avro.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('Avro: the specification\'s binary examples', () => {
  it('zig-zag varints for int and long', () => {
    const long = new AvroSchema('"long"');
    const int = new AvroSchema('"int"');
    const table: Array<[number, string]> = [[0, '00'], [-1, '01'], [1, '02'], [-2, '03'], [2, '04'], [-64, '7f'], [64, '8001']];
    for (const [n, h] of table) {
      expect(hex(long.encode(n)), String(n)).toBe(h);
      expect(hex(int.encode(n)), String(n)).toBe(h);
      expect(long.decode(Buffer.from(h, 'hex'))).toBe(n);
    }
    // Extremes of int and long
    expect(hex(int.encode(2147483647))).toBe('feffffff0f');
    expect(hex(int.encode(-2147483648))).toBe('ffffffff0f');
    expect(long.decode(long.encode('9223372036854775807'))).toBe('9223372036854775807');
    expect(long.decode(long.encode(-9223372036854775808n))).toBe('-9223372036854775808');
    expect(() => int.encode(2147483648)).toThrow(/does not fit an Avro int/);
  });

  it('string "foo", array of longs {3, 27}, union {null, string}, and the "test" record', () => {
    expect(hex(new AvroSchema('"string"').encode('foo'))).toBe('06666f6f');
    expect(hex(new AvroSchema({ type: 'array', items: 'long' }).encode([3, 27]))).toBe('04063600');
    const u = new AvroSchema(['null', 'string']);
    expect(hex(u.encode('a'))).toBe('020261');
    expect(hex(u.encode(null))).toBe('00');
    const rec = new AvroSchema({ type: 'record', name: 'test', fields: [{ name: 'a', type: 'long' }, { name: 'b', type: 'string' }] });
    expect(hex(rec.encode({ a: 27, b: 'foo' }))).toBe('3606666f6f');
    expect(rec.decode(Buffer.from('3606666f6f', 'hex'))).toEqual({ a: 27, b: 'foo' });
  });

  it('reads arrays and maps written in blocks with byte sizes (negative counts)', () => {
    // two blocks: [-2 items, 2 bytes][3, 27] then [1 item][5] then end
    const arr = new AvroSchema({ type: 'array', items: 'long' });
    expect(arr.decode(Buffer.from('03' + '04' + '0636' + '02' + '0a' + '00', 'hex'))).toEqual([3, 27, 5]);
    const map = new AvroSchema({ type: 'map', values: 'int' });
    expect(map.decode(map.encode({ a: 1, b: -1 }))).toEqual({ a: 1, b: -1 });
    expect(hex(map.encode({}))).toBe('00');
  });
});

describe('Avro: every type and logical type', () => {
  const schema = new AvroSchema({
    type: 'record', name: 'Order', namespace: 'shop.events', fields: [
      { name: 'id', type: 'long' },
      { name: 'ok', type: 'boolean' },
      { name: 'ratio', type: 'float' },
      { name: 'total', type: 'double' },
      { name: 'raw', type: 'bytes' },
      { name: 'status', type: { type: 'enum', name: 'Status', symbols: ['NEW', 'PAID', 'SHIPPED'], default: 'NEW' } },
      { name: 'tags', type: { type: 'array', items: 'string' } },
      { name: 'attrs', type: { type: 'map', values: 'string' } },
      { name: 'note', type: ['null', 'string'], default: null },
      { name: 'md5', type: { type: 'fixed', name: 'MD5', size: 4 } },
      { name: 'amount', type: { type: 'bytes', logicalType: 'decimal', precision: 9, scale: 2 } },
      { name: 'amountFixed', type: { type: 'fixed', name: 'Dec8', size: 8, logicalType: 'decimal', precision: 18, scale: 3 } },
      { name: 'ref', type: { type: 'string', logicalType: 'uuid' } },
      { name: 'day', type: { type: 'int', logicalType: 'date' } },
      { name: 'at', type: { type: 'int', logicalType: 'time-millis' } },
      { name: 'atMicros', type: { type: 'long', logicalType: 'time-micros' } },
      { name: 'created', type: { type: 'long', logicalType: 'timestamp-millis' } },
      { name: 'createdMicros', type: { type: 'long', logicalType: 'timestamp-micros' } },
      { name: 'localAt', type: { type: 'long', logicalType: 'local-timestamp-millis' } },
      { name: 'wait', type: { type: 'fixed', name: 'Duration', size: 12, logicalType: 'duration' } },
      { name: 'next', type: ['null', 'Order'], default: null },
    ],
  });
  const value = {
    id: 9007199254740993n, ok: true, ratio: 0.5, total: 99.95, raw: new Uint8Array([0, 255, 7]), status: 'PAID', tags: ['a', 'b'], attrs: { channel: 'web' }, note: 'gift',
    md5: new Uint8Array([1, 2, 3, 4]), amount: '-1234.50', amountFixed: 42.125, ref: '123e4567-e89b-12d3-a456-426614174000', day: '2026-03-01', at: '14:05:30.250',
    atMicros: '14:05:30.000250', created: '2026-03-01T14:05:00.123Z', createdMicros: '2026-03-01T14:05:00.123456Z', localAt: '2026-03-01T14:05:00.000', wait: { months: 1, days: 2, milliseconds: 3000 },
    next: { id: 2, ok: false, ratio: 0, total: 0, raw: new Uint8Array(), status: 'NEW', tags: [], attrs: {}, md5: new Uint8Array(4), amount: 0, amountFixed: '0', ref: '00000000-0000-0000-0000-000000000000', day: 0, at: 0, atMicros: 0, created: 0, createdMicros: 0, localAt: 0, wait: [0, 0, 0], next: null },
  };

  it('round-trips with readable logical values', () => {
    const out = schema.decode(schema.encode(value)) as Record<string, unknown>;
    expect(out).toMatchObject({
      id: '9007199254740993', ok: true, ratio: 0.5, total: 99.95, status: 'PAID', tags: ['a', 'b'], attrs: { channel: 'web' }, note: 'gift',
      amount: '-1234.50', amountFixed: '42.125', ref: '123e4567-e89b-12d3-a456-426614174000', day: '2026-03-01', at: '14:05:30.250', atMicros: '14:05:30.000250',
      created: '2026-03-01T14:05:00.123Z', createdMicros: '2026-03-01T14:05:00.123456Z', localAt: '2026-03-01T14:05:00.000', wait: { months: 1, days: 2, milliseconds: 3000 },
    });
    expect(Array.from(out.raw as Uint8Array)).toEqual([0, 255, 7]);
    expect((out.next as Record<string, unknown>).day).toBe('1970-01-01');
    expect((out.next as Record<string, unknown>).next).toBeNull();
    // raw: logical types as their underlying values
    const raw = schema.decode(schema.encode(value), { raw: true }) as Record<string, unknown>;
    expect(raw.day).toBe(20513);
    expect(raw.created).toBe(Date.UTC(2026, 2, 1, 14, 5, 0, 123));
  });

  it('decimal bytes are big-endian two\'s complement of the unscaled value', () => {
    const d = new AvroSchema({ type: 'bytes', logicalType: 'decimal', precision: 5, scale: 2 });
    expect(hex(d.encode('1.00'))).toBe('0264'); // length 1, unscaled 100 = 0x64
    expect(hex(d.encode('-1.00'))).toBe('029c');
    expect(hex(d.encode('1.28'))).toBe('040080');
    expect(() => d.encode('1.005')).toThrow(/more than 2 decimal places/);
  });

  it('missing fields with defaults, the Avro JSON union form, and clear errors', () => {
    const s = new AvroSchema({ type: 'record', name: 'R', fields: [{ name: 'a', type: 'int' }, { name: 'b', type: ['null', 'string'], default: null }, { name: 'c', type: 'string', default: 'x' }, { name: 'u', type: ['int', 'string'] }] });
    expect(s.decode(s.encode({ a: 1, u: { string: 'seven' } }))).toEqual({ a: 1, b: null, c: 'x', u: 'seven' });
    expect(s.decode(s.encode({ a: 1, u: 7 }))).toEqual({ a: 1, b: null, c: 'x', u: 7 });
    expect(() => s.encode({ u: 1 })).toThrow(/needs field "a"/);
    expect(() => s.encode({ a: 1, u: 1, zzz: 2 })).toThrow(/zzz are not in record R/);
    expect(() => s.encode({ a: 'one', u: 1 })).toThrow(/\$\.a: expected an integer/);
    expect(() => s.encode({ a: 1, u: true })).toThrow(/matches no branch of the union \[int, string\]/);
    expect(() => new AvroSchema({ type: 'record', name: 'R', fields: [{ name: 'a', type: 'int', default: 'x' }] })).toThrow(/default of field "a" does not match/);
    expect(() => new AvroSchema(['null', 'null'])).toThrow(/may not contain "null" twice/);
    expect(() => new AvroSchema({ type: 'enum', name: 'E', symbols: ['A', 'A'] })).toThrow(/unique symbols/);
    expect(() => new AvroSchema('"Nope"')).toThrow(/Unknown Avro type "Nope"/);
    expect(() => s.decode(Buffer.from('02', 'hex'))).toThrow(/ends early/);
  });
});

describe('Avro: schema resolution and compatibility', () => {
  const v1 = new AvroSchema({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'int' }, { name: 'status', type: { type: 'enum', name: 'S', symbols: ['NEW', 'PAID'] } }] });
  const v2 = new AvroSchema({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'long' }, { name: 'status', type: { type: 'enum', name: 'S', symbols: ['NEW', 'PAID', 'VOID'], default: 'NEW' } }, { name: 'channel', type: 'string', default: 'web' }] });
  const bad = new AvroSchema({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'int' }, { name: 'customer', type: 'string' }] });

  it('reads old data with a new schema: promotion, defaults, enums', () => {
    expect(v1.decode(v1.encode({ id: 7, status: 'PAID' }), { reader: v2 })).toEqual({ id: 7, status: 'PAID', channel: 'web' });
    // A symbol the old reader does not know, and it has no enum default:
    const v3 = new AvroSchema({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'int' }, { name: 'status', type: { type: 'enum', name: 'S', symbols: ['NEW', 'PAID', 'VOID'] } }] });
    expect(() => v3.decode(v3.encode({ id: 7, status: 'VOID' }), { reader: v1 })).toThrow(/VOID is not in the reader's enum S/);
    expect(v3.decode(v3.encode({ id: 7, status: 'PAID' }), { reader: v1 })).toEqual({ id: 7, status: 'PAID' });
    // ...and a reader with an enum default maps unknown symbols to it
    expect(v3.decode(v3.encode({ id: 7, status: 'VOID' }), { reader: new AvroSchema({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'long' }, { name: 'status', type: { type: 'enum', name: 'S', symbols: ['NEW', 'PAID'], default: 'NEW' } }] }) })).toEqual({ id: 7, status: 'NEW' });
    // a long written cannot be read as int
    expect(() => v2.decode(v2.encode({ id: 7, status: 'NEW', channel: 'app' }), { reader: v1 })).toThrow(/writer's long cannot be read as int/);
  });

  it('BACKWARD / FORWARD / FULL compatibility as a registry checks it', () => {
    expect(avroCompatibility(v2, v1, 'BACKWARD')).toEqual([]);
    expect(avroCompatibility(bad, v1, 'BACKWARD')).toEqual(['$.customer: the reader\'s field has no default and the writer does not write it']);
    expect(avroCompatibility(v2, v1, 'FORWARD')).toEqual(['$.id: the writer\'s long cannot be read as int', '$.status: the reader\'s enum S lacks symbol(s) VOID and has no default']);
    expect(avroCompatibility(v2, v1, 'FULL').length).toBe(2);
    expect(avroCompatibility(bad, v1, 'NONE')).toEqual([]);
  });
});

describe('Avro: canonical form, fingerprint and Confluent framing', () => {
  it('Parsing Canonical Form strips docs and defaults and uses full names', () => {
    expect(canonicalForm({ type: 'record', name: 'R', namespace: 'x.y', doc: 'd', fields: [{ name: 'f', doc: 'z', type: { type: 'fixed', name: 'F', size: 2 }, default: 'ab' }, { name: 'g', type: 'F' }] }))
      .toBe('{"name":"x.y.R","type":"record","fields":[{"name":"f","type":{"name":"x.y.F","type":"fixed","size":2}},{"name":"g","type":"x.y.F"}]}');
    expect(canonicalForm({ type: 'int' })).toBe('"int"');
    expect(canonicalForm(' "string" ')).toBe('"string"');
  });

  it('CRC-64-AVRO fingerprint', () => {
    expect(BigInt.asIntN(64, rabinFingerprint('"null"')).toString()).toBe('7195948357588979594');
    expect(new AvroSchema('"null"').fingerprint()).toBe('63dd24e7cc258f8a');
  });

  it('frames and unframes the Confluent wire format', () => {
    const f = frameConfluent(258, Uint8Array.from([1, 2]));
    expect(hex(f)).toBe('00000001020102');
    expect(unframeConfluent(f)).toEqual({ schemaId: 258, payload: Uint8Array.from([1, 2]) });
    expect(unframeConfluent(Buffer.from('{"a":1}'))).toBeUndefined();
  });
});
