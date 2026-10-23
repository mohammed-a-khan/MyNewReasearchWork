/**
 * Minimal ZIP writer/reader (PKWARE APPNOTE 6.3, no ZIP64, no encryption):
 * stored or deflated entries, CRC-32, UTF-8 names, central directory.
 * The reader handles what the writer produces and validates every CRC and size.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { EzTestError } from '../core/index.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
  name: string;
  data: Uint8Array;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  method: number;
  crc: number;
}

const LIMIT = 0xffffffff;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function validateEntryName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name) || name.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new EzTestError(`Unsafe ZIP entry name: ${JSON.stringify(name)}`, 'ZIP_UNSAFE_NAME');
  }
}

/** Build a ZIP archive. `mtime` sets every entry's timestamp (deterministic output). */
export function writeZip(files: ZipInput[], opts: { mtime?: Date; level?: number } = {}): Buffer {
  const { time, date } = dosDateTime(opts.mtime ?? new Date(Date.UTC(1980, 0, 1)));
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    validateEntryName(f.name);
    if (seen.has(f.name)) throw new EzTestError(`Duplicate ZIP entry: ${f.name}`, 'ZIP_DUPLICATE');
    seen.add(f.name);
    const raw = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    const deflated = deflateRawSync(raw, { level: opts.level ?? 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const name = Buffer.from(f.name, 'utf8');
    if (raw.length >= LIMIT || payload.length >= LIMIT || offset >= LIMIT) throw new EzTestError('ZIP64 is not supported (entry or archive too large)', 'ZIP_TOO_LARGE');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 0644
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  if (files.length > 0xffff) throw new EzTestError('ZIP64 is not supported (too many entries)', 'ZIP_TOO_LARGE');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Read a ZIP archive into memory. Throws on structural problems, unsafe names,
 * unsupported features, CRC or size mismatches, or more than `maxBytes` of
 * uncompressed data (zip-bomb guard).
 */
export function readZip(buf: Buffer, opts: { maxBytes?: number } = {}): ZipEntry[] {
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
  const fail = (msg: string): never => {
    throw new EzTestError(`Invalid ZIP: ${msg}`, 'ZIP_INVALID');
  };
  if (buf.length < 22) fail('file too small');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) fail('central directory out of bounds');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail(`central directory entry ${i} corrupt`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) fail(`entry ${name} is encrypted`);
    if (method !== 0 && method !== 8) fail(`entry ${name} uses unsupported compression method ${method}`);
    if (name.endsWith('/')) continue; // directory entry
    validateEntryName(name);
    if (names.has(name)) fail(`duplicate entry ${name}`);
    names.add(name);
    total += size;
    if (total > maxBytes) fail(`uncompressed size exceeds ${maxBytes} bytes`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) fail(`local header for ${name} corrupt`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const lName = buf.subarray(localOff + 30, localOff + 30 + lNameLen).toString('utf8');
    if (lName !== name) fail(`local/central name mismatch for ${name}`);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + compSize > cdOffset) fail(`data for ${name} out of bounds`);
    const comp = buf.subarray(start, start + compSize);
    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(comp, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(comp);
    } catch (e) {
      return fail(`entry ${name} cannot be decompressed (${(e as Error).message})`);
    }
    if (data.length !== size) fail(`entry ${name} size mismatch`);
    if (crc32(data) !== crc) fail(`entry ${name} CRC mismatch`);
    entries.push({ name, data, method, crc });
  }
  return entries;
}
