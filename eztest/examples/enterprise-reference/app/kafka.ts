/**
 * A minimal Kafka producer on node:net (no client library): Metadata v1 to
 * auto-create topics and find the partition leader, Produce v3 with a
 * RecordBatch v2 (CRC-32C), acks=1. Enough for a single-broker development
 * cluster; this is the reference app's own code, not part of EZTest.
 */
import { connect, type Socket } from 'node:net';

// ---------------------------------------------------------------- CRC-32C (Castagnoli)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32c(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- encoding
function varint(n: number): Buffer {
  let z = (n << 1) ^ (n >> 31); // zigzag (fits our small values)
  z >>>= 0;
  const out: number[] = [];
  while (z > 0x7f) {
    out.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  out.push(z);
  return Buffer.from(out);
}
function varlong(n: bigint): Buffer {
  let z = (n << 1n) ^ (n >> 63n);
  if (z < 0n) z += 1n << 64n;
  const out: number[] = [];
  while (z > 0x7fn) {
    out.push(Number(z & 0x7fn) | 0x80);
    z >>= 7n;
  }
  out.push(Number(z));
  return Buffer.from(out);
}
const i8 = (n: number) => Buffer.from([n & 0xff]);
function i16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(n);
  return b;
}
const str16 = (s: string | null) => (s === null ? i16(-1) : Buffer.concat([i16(Buffer.byteLength(s)), Buffer.from(s)]));
const bytesVar = (b: Buffer | null) => (b === null ? varint(-1) : Buffer.concat([varint(b.length), b]));

export interface KafkaRecord {
  key?: string;
  value: string;
  headers?: Record<string, string>;
}

function recordBatch(records: KafkaRecord[], now: bigint): Buffer {
  const recs = records.map((r, i) => {
    const hdrs = Object.entries(r.headers ?? {});
    const body = Buffer.concat([
      i8(0), // attributes
      varlong(0n), // timestamp delta
      varint(i), // offset delta
      bytesVar(r.key === undefined ? null : Buffer.from(r.key)),
      bytesVar(Buffer.from(r.value)),
      varint(hdrs.length),
      ...hdrs.flatMap(([k, v]) => [bytesVar(Buffer.from(k)), bytesVar(Buffer.from(v))]),
    ]);
    return Buffer.concat([varint(body.length), body]);
  });
  const afterCrc = Buffer.concat([
    i16(0), // attributes: no compression, CreateTime
    i32(records.length - 1), // lastOffsetDelta
    i64(now), // firstTimestamp
    i64(now), // maxTimestamp
    i64(-1n), // producerId
    i16(-1), // producerEpoch
    i32(-1), // baseSequence
    i32(records.length),
    ...recs,
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32c(afterCrc));
  const afterLength = Buffer.concat([i32(-1) /* partitionLeaderEpoch */, i8(2) /* magic */, crc, afterCrc]);
  return Buffer.concat([i64(0n) /* baseOffset */, i32(afterLength.length), afterLength]);
}

// ---------------------------------------------------------------- connection
class Connection {
  private socket?: Socket;
  private buf = Buffer.alloc(0);
  private corr = 0;
  private readonly pending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();
  private readonly host: string;
  private readonly port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  private async open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const s = connect({ host: this.host, port: this.port });
    await new Promise<void>((resolve, reject) => {
      s.once('connect', resolve);
      s.once('error', reject);
      s.setTimeout(5000, () => s.destroy(new Error('kafka connect timeout')));
    });
    s.setTimeout(0);
    s.on('data', (d: Buffer) => this.onData(d));
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    s.on('error', fail);
    s.on('close', () => fail(new Error('kafka connection closed')));
    this.socket = s;
    this.buf = Buffer.alloc(0);
    return s;
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const size = this.buf.readInt32BE(0);
      if (this.buf.length < 4 + size) return;
      const frame = this.buf.subarray(4, 4 + size);
      this.buf = this.buf.subarray(4 + size);
      const id = frame.readInt32BE(0);
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.resolve(frame.subarray(4));
    }
  }

  async request(apiKey: number, apiVersion: number, body: Buffer, timeoutMs = 10_000): Promise<Buffer> {
    const s = await this.open();
    const id = ++this.corr;
    const msg = Buffer.concat([i16(apiKey), i16(apiVersion), i32(id), str16('larkspur-claims'), body]);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`kafka request ${apiKey} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      s.write(Buffer.concat([i32(msg.length), msg]));
    });
  }

  close() {
    this.socket?.destroy();
  }
}

/** Produces JSON events to one broker; retries while a new topic's leader is elected. */
export class KafkaProducer {
  private readonly conn: Connection;
  private readonly ready = new Set<string>();

  constructor(bootstrap: string) {
    const [host, port] = bootstrap.split(':');
    this.conn = new Connection(host, Number(port || 9092));
  }

  private async ensureTopic(topic: string): Promise<void> {
    if (this.ready.has(topic)) return;
    // Metadata v1 for one topic; with auto.create.topics.enable the broker creates it.
    await this.conn.request(3, 1, Buffer.concat([i32(1), str16(topic)]));
    this.ready.add(topic);
  }

  async send(topic: string, records: KafkaRecord[]): Promise<{ partition: number; offset: string }> {
    let lastError = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      await this.ensureTopic(topic);
      const body = Buffer.concat([
        str16(null), // transactional id
        i16(1), // acks
        i32(5000), // timeout
        i32(1),
        str16(topic),
        i32(1),
        i32(0), // partition 0
        (() => {
          const rb = recordBatch(records, BigInt(Date.now()));
          return Buffer.concat([i32(rb.length), rb]);
        })(),
      ]);
      const res = await this.conn.request(0, 3, body);
      // [responses] topic, [partitions] partition, error_code, base_offset, log_append_time; throttle
      let o = 4; // array length
      const tlen = res.readInt16BE(o);
      o += 2 + tlen + 4; // topic name + partitions array length
      const partition = res.readInt32BE(o);
      const err = res.readInt16BE(o + 4);
      const offset = res.readBigInt64BE(o + 6);
      if (err === 0) return { partition, offset: offset.toString() };
      lastError = err;
      // 3 UNKNOWN_TOPIC_OR_PARTITION, 5 LEADER_NOT_AVAILABLE, 6 NOT_LEADER: the topic is being created
      if (![3, 5, 6].includes(err)) break;
      this.ready.delete(topic);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`kafka produce to ${topic} failed with error code ${lastError}`);
  }

  close() {
    this.conn.close();
  }
}
