/**
 * Minimal ZIP reader/extractor (stored and deflated entries, ZIP64 sizes),
 * enough for Chrome-for-Testing archives and HAR zips. Unix permission bits
 * and symbolic links are restored on extraction.
 */
import { mkdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  externalAttrs: number;
  versionMadeBy: number;
}

function findEOCD(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a zip archive (no end of central directory)');
}

function centralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEOCD(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 end of central directory locator.
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(z64) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const out: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // ZIP64 extra field.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    out.push({ name, method, compressedSize, size, localOffset, externalAttrs, versionMadeBy });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryData(buf: Buffer, e: CentralEntry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`Corrupt zip entry ${e.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${e.method} for ${e.name}`);
}

/** All file entries of an archive in memory. */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of centralDirectory(buf)) if (!e.name.endsWith('/')) out.set(e.name, entryData(buf, e));
  return out;
}

/** Extract an archive under `dest` (paths escaping dest are rejected). */
export async function extractZip(buf: Buffer, dest: string): Promise<number> {
  const root = normalize(dest);
  let n = 0;
  for (const e of centralDirectory(buf)) {
    const target = normalize(join(root, e.name));
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`Refusing to extract ${e.name} outside ${dest}`);
    const unixMode = (e.versionMadeBy >> 8) === 3 ? (e.externalAttrs >>> 16) & 0xffff : 0;
    const isDir = e.name.endsWith('/') || (unixMode & 0o170000) === 0o040000;
    if (isDir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const data = entryData(buf, e);
    if ((unixMode & 0o170000) === 0o120000) {
      await symlink(data.toString('utf8'), target).catch(() => undefined);
      n++;
      continue;
    }
    await writeFile(target, data);
    if (unixMode & 0o777 && process.platform !== 'win32') await chmod(target, unixMode & 0o777);
    n++;
  }
  return n;
}
