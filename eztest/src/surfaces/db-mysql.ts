/**
 * MySQL and MariaDB client: EZTest's own implementation of the MySQL client/server protocol (no driver package).
 *
 * - Handshake v10 with TLS (SSLRequest, then the handshake response over TLS; the server certificate is verified
 *   unless `ssl.rejectUnauthorized` is false).
 * - Authentication: `mysql_native_password`, `caching_sha2_password` (fast path, and full authentication over TLS
 *   or with the server's RSA public key, given as `serverPublicKey` or fetched when `allowPublicKeyRetrieval` is on),
 *   `sha256_password`, `mysql_clear_password` (over TLS only) and auth-switch requests.
 * - Statements: without values, COM_QUERY (text protocol, several statements and result sets in one call); with
 *   values, COM_STMT_PREPARE / COM_STMT_EXECUTE (binary protocol). Values are always bound, never spliced into SQL.
 *   Prepared statements are cached per connection.
 * - Types: integers -> number (BIGINT beyond 2^53 -> its exact digits as a string), DECIMAL -> number when a double
 *   holds it exactly, else the exact text, FLOAT/DOUBLE -> number, DATETIME/TIMESTAMP -> Date (in `timezone`,
 *   default the machine's local time), DATE -> 'YYYY-MM-DD' (a calendar date is not an instant), TIME -> text,
 *   BLOB/BINARY -> Buffer, BIT -> number, text (utf8mb4) -> string, NULL -> null. Zero dates ('0000-00-00') stay text.
 * - A pool of connections per alias (`pool.max`, default 4), like the other dialects.
 */
import { createHash, publicEncrypt, constants as cryptoConstants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { NotSupportedError } from '../core/index.js';
import { DbError, type DbClient, type ExecResult, type Row, type SqlParams } from './db.js';
import { caseInsensitiveRow } from './db-rows.js';
import { namedToPositional } from './db-sql.js';

// ----------------------------------------------------------------- options

export interface MysqlTlsOptions {
  /** Verify the server certificate against `ca` (or the system roots) and its host name (default true). */
  rejectUnauthorized?: boolean;
  /** CA certificate(s): PEM text or a file path. */
  ca?: string;
  /** Client certificate and key (PEM text or file paths) for servers that require X.509 users. */
  cert?: string;
  key?: string;
  /** Host name to verify the certificate against (default: the connection host). */
  servername?: string;
  /** Use TLS when the server offers it, else go on without (ssl-mode=PREFERRED). Default false: TLS is required. */
  optional?: boolean;
}

export interface MysqlOptions {
  name?: string;
  /** mysql://user:password@host:3306/database?ssl=true (mariadb:// is the same). Fields given next to it win. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** TLS: true (verified), false/absent (none), or the TLS settings. */
  ssl?: boolean | MysqlTlsOptions;
  /** caching_sha2_password / sha256_password without TLS: the server's RSA public key (PEM text or file path). */
  serverPublicKey?: string;
  /** Without TLS or serverPublicKey, ask the server for its RSA public key (a man in the middle could swap it; off by default). */
  allowPublicKeyRetrieval?: boolean;
  /** Connections in the pool (default 4). */
  pool?: { max?: number };
  /** Time zone of DATETIME/TIMESTAMP values: 'local' (default), 'Z' or '+02:00'. */
  timezone?: string;
  /** Return DATETIME/TIMESTAMP as text ('2026-03-01 14:05:00') instead of Date. */
  dateStrings?: boolean;
  connectTimeoutMs?: number;
  /** Per statement; on timeout the connection is dropped (the server ends the statement when it notices). */
  queryTimeoutMs?: number;
}

/** A column of a result set. */
export interface MysqlColumn {
  name: string;
  table: string;
  schema: string;
  /** MySQL protocol type code (MYSQL_TYPE_*). */
  type: number;
  typeName: string;
  flags: number;
  charset: number;
  length: number;
  decimals: number;
}

/** One result of a statement: a result set (columns + rows) or an OK (rows affected). */
export interface MysqlResult {
  columns: MysqlColumn[];
  rows: Row[];
  rowsAffected: number;
  lastInsertId?: number | string;
  warnings: number;
  info?: string;
}

/** Server facts from the handshake. */
export interface MysqlServerInfo {
  version: string;
  flavor: 'mysql' | 'mariadb';
  connectionId: number;
  tls: boolean;
  authPlugin: string;
}

/** Connection settings from a mysql:// or mariadb:// URL, the fields beside it winning. */
export function mysqlSettings(o: MysqlOptions): MysqlOptions & { host: string; port: number } {
  let fromUrl: MysqlOptions = {};
  if (o.connectionString) {
    let u: URL;
    try {
      u = new URL(o.connectionString);
    } catch {
      throw new DbError('MySQL connectionString is not a mysql:// URL', 'DB_CONFIG');
    }
    if (!/^(mysql|mariadb|mysqlx?):$/i.test(u.protocol)) throw new DbError(`MySQL connectionString must start with mysql:// or mariadb:// (got ${u.protocol}//)`, 'DB_CONFIG');
    const q = u.searchParams;
    const flag = (k: string) => (q.has(k) ? /^(1|true|yes|on|required|verify[-_](ca|identity))$/i.test(q.get(k)!) : undefined);
    const sslMode = q.get('ssl-mode') ?? q.get('sslMode') ?? q.get('sslmode');
    let ssl: MysqlOptions['ssl'] = flag('ssl');
    if (sslMode) {
      ssl = /^disabled$/i.test(sslMode) ? false
        : /^preferred$/i.test(sslMode) ? { rejectUnauthorized: false, optional: true }
          : /^required$/i.test(sslMode) ? { rejectUnauthorized: false }
            : true; // VERIFY_CA, VERIFY_IDENTITY
    }
    const ca = q.get('ssl-ca') ?? q.get('sslca') ?? q.get('sslrootcert');
    if (ca) ssl = { ...(typeof ssl === 'object' ? ssl : {}), ca };
    fromUrl = {
      host: u.hostname.replace(/^\[|\]$/g, '') || undefined,
      port: u.port ? Number(u.port) : undefined,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      ...(ssl !== undefined ? { ssl } : {}),
      ...(flag('allowPublicKeyRetrieval') !== undefined ? { allowPublicKeyRetrieval: flag('allowPublicKeyRetrieval') } : {}),
      ...(q.get('timezone') ? { timezone: q.get('timezone')! } : {}),
    };
  }
  const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as MysqlOptions;
  const merged = { ...fromUrl, ...defined };
  return { ...merged, host: merged.host ?? 'localhost', port: merged.port ?? 3306 };
}

// ----------------------------------------------------------------- protocol constants

const CLIENT = {
  LONG_PASSWORD: 1,
  FOUND_ROWS: 2,
  LONG_FLAG: 4,
  CONNECT_WITH_DB: 8,
  PROTOCOL_41: 512,
  SSL: 2048,
  TRANSACTIONS: 8192,
  SECURE_CONNECTION: 32768,
  MULTI_STATEMENTS: 1 << 16,
  MULTI_RESULTS: 1 << 17,
  PS_MULTI_RESULTS: 1 << 18,
  PLUGIN_AUTH: 1 << 19,
  CONNECT_ATTRS: 1 << 20,
  PLUGIN_AUTH_LENENC_CLIENT_DATA: 1 << 21,
} as const;

const SERVER_MORE_RESULTS_EXISTS = 0x0008;
const COM = { QUIT: 0x01, QUERY: 0x03, PING: 0x0e, STMT_PREPARE: 0x16, STMT_EXECUTE: 0x17, STMT_CLOSE: 0x19 } as const;
/** utf8mb4_general_ci: known to every MySQL 5.5.3+ and MariaDB server. */
const UTF8MB4 = 45;
const BINARY_CHARSET = 63;
const MAX_PACKET = 0xffffff;
const UNSIGNED_FLAG = 32;

export const MYSQL_TYPES: Record<number, string> = {
  0: 'DECIMAL', 1: 'TINY', 2: 'SHORT', 3: 'LONG', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP', 8: 'LONGLONG', 9: 'INT24',
  10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 14: 'NEWDATE', 15: 'VARCHAR', 16: 'BIT', 17: 'TIMESTAMP2', 18: 'DATETIME2', 19: 'TIME2',
  245: 'JSON', 246: 'NEWDECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINY_BLOB', 250: 'MEDIUM_BLOB', 251: 'LONG_BLOB', 252: 'BLOB',
  253: 'VAR_STRING', 254: 'STRING', 255: 'GEOMETRY',
};
const T = { DECIMAL: 0, TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6, TIMESTAMP: 7, LONGLONG: 8, INT24: 9, DATE: 10, TIME: 11, DATETIME: 12, YEAR: 13, NEWDATE: 14, BIT: 16, NEWDECIMAL: 246, BLOB: 252, VAR_STRING: 253 } as const;

// ----------------------------------------------------------------- byte helpers

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    return this.buf[this.pos++];
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u24(): number {
    const v = this.buf.readUIntLE(this.pos, 3);
    this.pos += 3;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  /** A length-encoded integer; null for the NULL marker (0xfb). Large values come back as bigint. */
  lenenc(): number | bigint | null {
    const b = this.u8();
    if (b < 0xfb) return b;
    if (b === 0xfb) return null;
    if (b === 0xfc) return this.u16();
    if (b === 0xfd) return this.u24();
    const v = this.u64();
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  lenencNumber(): number {
    const v = this.lenenc();
    if (v === null) return 0;
    if (typeof v === 'bigint') throw new DbError('MySQL protocol: length too large', 'DB_PROTOCOL');
    return v;
  }
  lenencBytes(): Buffer | null {
    const n = this.lenenc();
    if (n === null) return null;
    return this.bytes(Number(n));
  }
  lenencStr(): string {
    return (this.lenencBytes() ?? Buffer.alloc(0)).toString('utf8');
  }
  nulStr(): string {
    let end = this.buf.indexOf(0, this.pos);
    if (end < 0) end = this.buf.length;
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = Math.min(end + 1, this.buf.length);
    return s;
  }
  rest(): Buffer {
    const v = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return v;
  }
}

function lenencInt(n: number | bigint): Buffer {
  const v = BigInt(n);
  if (v < 251n) return Buffer.from([Number(v)]);
  if (v < 0x10000n) {
    const b = Buffer.alloc(3);
    b[0] = 0xfc;
    b.writeUInt16LE(Number(v), 1);
    return b;
  }
  if (v < 0x1000000n) {
    const b = Buffer.alloc(4);
    b[0] = 0xfd;
    b.writeUIntLE(Number(v), 1, 3);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xfe;
  b.writeBigUInt64LE(v, 1);
  return b;
}
const lenencBuf = (b: Buffer): Buffer => Buffer.concat([lenencInt(b.length), b]);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
  return out;
}
const sha1 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};
const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** mysql_native_password: SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password))). */
export function nativePasswordToken(password: string, scramble: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const p1 = sha1(Buffer.from(password, 'utf8'));
  return xor(p1, sha1(scramble, sha1(p1)));
}

/** caching_sha2_password fast path: SHA256(password) XOR SHA256(SHA256(SHA256(password)) + scramble). */
export function cachingSha2Token(password: string, scramble: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const p1 = sha256(Buffer.from(password, 'utf8'));
  return xor(p1, sha256(sha256(p1), scramble));
}

/** The password for RSA full authentication: (password + NUL) XOR scramble, encrypted with RSA-OAEP. */
export function rsaPasswordToken(password: string, scramble: Buffer, publicKeyPem: string): Buffer {
  const plain = xor(Buffer.from(`${password}\0`, 'utf8'), scramble);
  return publicEncrypt({ key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING }, plain);
}

const pemOrFile = (v: string): string => (/-----BEGIN /.test(v) ? v : readFileSync(v, 'utf8'));

// ----------------------------------------------------------------- value decoding

/** DECIMAL text -> number when a double holds every digit, else the exact text. */
export function mysqlDecimal(s: string): number | string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (/^-?\d+$/.test(s)) return Number.isSafeInteger(n) ? n : s;
  const digits = s.replace(/^[-+]/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? n : s;
}

function intText(s: string): number | string {
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}

/** Minutes east of UTC for a timezone option ('local' -> undefined: use the machine's local time). */
function tzOffsetMinutes(tz: string | undefined): number | undefined {
  if (!tz || tz === 'local') return undefined;
  if (tz === 'Z' || /^utc$/i.test(tz)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  if (!m) throw new DbError(`MySQL timezone must be 'local', 'Z' or like '+02:00' (got "${tz}")`, 'DB_CONFIG');
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

interface DecodeOptions {
  tzOffset?: number;
  dateStrings: boolean;
}

function makeDate(y: number, mo: number, d: number, h: number, mi: number, s: number, us: number, o: DecodeOptions): Date | string {
  if (o.dateStrings || y === 0 || mo === 0 || d === 0) {
    const frac = us ? `.${pad(us, 6)}` : '';
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}${frac}`;
  }
  const ms = Math.floor(us / 1000);
  if (o.tzOffset === undefined) return new Date(y, mo - 1, d, h, mi, s, ms);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - o.tzOffset * 60_000);
}

function dateTimeText(text: string, o: DecodeOptions): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/.exec(text);
  if (!m) return text;
  const us = m[7] ? Number(m[7].padEnd(6, '0')) : 0;
  return makeDate(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), us, o);
}

function bitValue(b: Buffer): number | Buffer {
  if (b.length > 6) return b;
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** A value of the text protocol (or a length-encoded value of the binary protocol) as its JS value. */
function decodeBytes(col: MysqlColumn, raw: Buffer, o: DecodeOptions): unknown {
  switch (col.type) {
    case T.TINY: case T.SHORT: case T.LONG: case T.INT24: case T.YEAR:
      return Number(raw.toString('latin1'));
    case T.LONGLONG:
      return intText(raw.toString('latin1'));
    case T.FLOAT: case T.DOUBLE:
      return Number(raw.toString('latin1'));
    case T.DECIMAL: case T.NEWDECIMAL:
      return mysqlDecimal(raw.toString('latin1'));
    case T.DATE: case T.NEWDATE:
      return raw.toString('latin1');
    case T.DATETIME: case T.TIMESTAMP:
      return dateTimeText(raw.toString('latin1'), o);
    case T.TIME:
      return raw.toString('latin1');
    case T.BIT:
      return bitValue(raw);
    case 255: // GEOMETRY
      return Buffer.from(raw);
    default:
      // Strings, BLOBs, ENUM, SET, JSON: binary collation -> bytes, anything else -> utf8 text.
      return col.charset === BINARY_CHARSET && col.type !== 245 ? Buffer.from(raw) : raw.toString('utf8');
  }
}

function decodeBinaryValue(col: MysqlColumn, r: Reader, o: DecodeOptions): unknown {
  const unsigned = (col.flags & UNSIGNED_FLAG) !== 0;
  switch (col.type) {
    case T.TINY: {
      const v = r.u8();
      return unsigned ? v : (v << 24) >> 24;
    }
    case T.SHORT: case T.YEAR: {
      const v = r.u16();
      return unsigned || col.type === T.YEAR ? v : (v << 16) >> 16;
    }
    case T.INT24: case T.LONG: {
      const v = r.u32();
      return unsigned ? v : v | 0;
    }
    case T.LONGLONG: {
      const v = unsigned ? r.buf.readBigUInt64LE(r.pos) : r.buf.readBigInt64LE(r.pos);
      r.skip(8);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    case T.FLOAT: {
      const v = r.buf.readFloatLE(r.pos);
      r.skip(4);
      // A FLOAT holds about 7 significant digits; the text protocol shows the same value without the binary noise.
      return Number.isFinite(v) ? Number(v.toPrecision(7)) : v;
    }
    case T.DOUBLE: {
      const v = r.buf.readDoubleLE(r.pos);
      r.skip(8);
      return v;
    }
    case T.DATE: case T.NEWDATE: case T.DATETIME: case T.TIMESTAMP: {
      const n = r.u8();
      let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, us = 0;
      if (n >= 4) {
        y = r.u16();
        mo = r.u8();
        d = r.u8();
      }
      if (n >= 7) {
        h = r.u8();
        mi = r.u8();
        s = r.u8();
      }
      if (n >= 11) us = r.u32();
      if (col.type === T.DATE || col.type === T.NEWDATE) return `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
      return makeDate(y, mo, d, h, mi, s, us, o);
    }
    case T.TIME: {
      const n = r.u8();
      if (n === 0) return '00:00:00';
      const neg = r.u8() === 1;
      const days = r.u32();
      const h = r.u8();
      const mi = r.u8();
      const s = r.u8();
      const us = n >= 12 ? r.u32() : 0;
      return `${neg ? '-' : ''}${pad(days * 24 + h)}:${pad(mi)}:${pad(s)}${us ? `.${pad(us, 6)}` : ''}`;
    }
    default: {
      const b = r.lenencBytes();
      return b === null ? null : decodeBytes(col, b, o);
    }
  }
}

// ----------------------------------------------------------------- value encoding (binary protocol)

function encodeParam(v: unknown, tzOffset: number | undefined): { type: number; unsigned?: boolean; value?: Buffer } {
  if (v === null || v === undefined) return { type: T.NULL };
  if (typeof v === 'boolean') return { type: T.TINY, value: Buffer.from([v ? 1 : 0]) };
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v));
      return { type: T.LONGLONG, value: b };
    }
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return { type: T.DOUBLE, value: b };
  }
  if (typeof v === 'bigint') {
    const b = Buffer.alloc(8);
    if (v >= -(2n ** 63n) && v < 2n ** 63n) {
      b.writeBigInt64LE(v);
      return { type: T.LONGLONG, value: b };
    }
    if (v >= 0n && v < 2n ** 64n) {
      b.writeBigUInt64LE(v);
      return { type: T.LONGLONG, unsigned: true, value: b };
    }
    return { type: T.VAR_STRING, value: lenencBuf(Buffer.from(v.toString(), 'utf8')) };
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new DbError('Cannot bind an invalid Date', 'DB_BIND');
    const d = tzOffset === undefined ? v : new Date(v.getTime() + tzOffset * 60_000);
    const get = tzOffset === undefined
      ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]
      : [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()];
    const b = Buffer.alloc(12);
    b[0] = 11;
    b.writeUInt16LE(get[0], 1);
    b[3] = get[1];
    b[4] = get[2];
    b[5] = get[3];
    b[6] = get[4];
    b[7] = get[5];
    b.writeUInt32LE(get[6] * 1000, 8);
    return { type: T.DATETIME, value: b };
  }
  if (v instanceof Uint8Array) return { type: T.BLOB, value: lenencBuf(Buffer.from(v.buffer, v.byteOffset, v.byteLength)) };
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return { type: T.VAR_STRING, value: lenencBuf(Buffer.from(s, 'utf8')) };
}

// ----------------------------------------------------------------- one connection

interface PreparedStatement {
  id: number;
  params: number;
  columns: MysqlColumn[];
}

interface ServerError {
  errno: number;
  sqlState: string;
  message: string;
}

function parseError(p: Buffer): ServerError {
  const r = new Reader(p);
  r.skip(1);
  const errno = r.u16();
  let sqlState = 'HY000';
  if (r.buf[r.pos] === 0x23) {
    r.skip(1);
    sqlState = r.bytes(5).toString('latin1');
  }
  return { errno, sqlState, message: r.rest().toString('utf8') };
}

function parseOk(p: Buffer): { rowsAffected: number; lastInsertId: number | string; status: number; warnings: number; info: string } {
  const r = new Reader(p);
  r.skip(1);
  const affected = r.lenenc();
  const insertId = r.lenenc();
  const status = r.remaining >= 2 ? r.u16() : 0;
  const warnings = r.remaining >= 2 ? r.u16() : 0;
  const info = r.remaining ? r.rest().toString('utf8') : '';
  const num = (v: number | bigint | null): number | string => (v === null ? 0 : typeof v === 'bigint' ? v.toString() : v);
  return { rowsAffected: Number(num(affected)), lastInsertId: num(insertId), status, warnings, info };
}

function parseColumn(p: Buffer): MysqlColumn {
  const r = new Reader(p);
  r.lenencStr(); // catalog
  const schema = r.lenencStr();
  const table = r.lenencStr();
  r.lenencStr(); // org_table
  const name = r.lenencStr();
  r.lenencStr(); // org_name
  r.lenenc(); // length of the fixed fields (0x0c)
  const charset = r.u16();
  const length = r.u32();
  const type = r.u8();
  const flags = r.u16();
  const decimals = r.u8();
  return { name, table, schema, type, typeName: MYSQL_TYPES[type] ?? `TYPE_${type}`, flags, charset, length, decimals };
}

const isEof = (p: Buffer): boolean => p[0] === 0xfe && p.length < 9;

/**
 * One MySQL protocol connection. Commands run one at a time (an internal queue), so a connection is never
 * interleaved even when shared.
 */
export class MysqlConnection {
  server!: MysqlServerInfo;
  /** False once the socket failed or a protocol error left it in an unknown state. */
  usable = true;
  lastUsed = Date.now();
  private socket!: Socket | TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  private payloads: Buffer[] = [];
  private partial: Buffer[] = [];
  private waiter?: { resolve: (b: Buffer) => void; reject: (e: Error) => void };
  private failure?: Error;
  private seq = 0;
  private capabilities = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly statements = new Map<string, PreparedStatement>();
  private readonly decode: DecodeOptions;
  private readonly onData = (d: Buffer) => this.received(d);
  private readonly onError = (e: Error) => this.fail(e);
  private readonly onClose = () => this.fail(new Error('the server closed the connection'));

  private constructor(private readonly o: MysqlOptions & { host: string; port: number }, private readonly label: string) {
    this.decode = { tzOffset: tzOffsetMinutes(o.timezone), dateStrings: !!o.dateStrings };
  }

  static async open(o: MysqlOptions & { host: string; port: number }, label = 'mysql'): Promise<MysqlConnection> {
    const c = new MysqlConnection(o, label);
    const timeout = o.connectTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        c.handshake(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DbError(`[${label}] connecting to MySQL ${o.host}:${o.port} timed out after ${timeout} ms`, 'DB_CONNECT')), timeout);
        }),
      ]);
    } catch (e) {
      c.destroy();
      if (e instanceof DbError) throw e;
      throw new DbError(`[${label}] cannot connect to MySQL ${o.host}:${o.port}: ${(e as Error).message}`, 'DB_CONNECT');
    } finally {
      clearTimeout(timer);
    }
    return c;
  }

  // ---- packet I/O

  private attach(s: Socket | TLSSocket): void {
    this.socket = s;
    s.on('data', this.onData);
    s.on('error', this.onError);
    s.on('close', this.onClose);
  }

  private detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  private received(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const len = this.buf.readUIntLE(0, 3);
      if (this.buf.length < 4 + len) break;
      this.seq = (this.buf[3] + 1) & 0xff;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.partial.push(body);
      if (len === MAX_PACKET) continue; // the payload goes on in the next packet
      const payload = this.partial.length === 1 ? Buffer.from(body) : Buffer.concat(this.partial);
      this.partial = [];
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w.resolve(payload);
      } else this.payloads.push(payload);
    }
  }

  private fail(e: Error): void {
    this.usable = false;
    this.failure ??= e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w.reject(e);
    }
  }

  private read(): Promise<Buffer> {
    const next = this.payloads.shift();
    if (next) return Promise.resolve(next);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.waiter = { resolve, reject }));
  }

  private write(payload: Buffer): void {
    let at = 0;
    for (;;) {
      const n = Math.min(MAX_PACKET, payload.length - at);
      const h = Buffer.alloc(4);
      h.writeUIntLE(n, 0, 3);
      h[3] = this.seq;
      this.seq = (this.seq + 1) & 0xff;
      this.socket.write(Buffer.concat([h, payload.subarray(at, at + n)]));
      at += n;
      if (n < MAX_PACKET) break;
    }
  }

  private command(payload: Buffer): void {
    this.seq = 0;
    this.write(payload);
  }

  // ---- handshake and authentication

  private async handshake(): Promise<void> {
    const o = this.o;
    const raw = netConnect({ host: o.host, port: o.port });
    raw.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', resolve);
      raw.once('error', reject);
    });
    this.attach(raw);
    const hello = await this.read();
    if (hello[0] === 0xff) {
      const e = parseError(hello);
      throw new DbError(`[${this.label}] MySQL ${o.host}:${o.port} refused the connection: ${e.message} (error ${e.errno})`, 'DB_CONNECT', { errno: e.errno });
    }
    const r = new Reader(hello);
    const protocol = r.u8();
    if (protocol !== 10) throw new DbError(`[${this.label}] unsupported MySQL handshake protocol ${protocol}`, 'DB_PROTOCOL');
    const version = r.nulStr();
    const connectionId = r.u32();
    const part1 = r.bytes(8);
    r.skip(1);
    let caps = r.u16();
    let authLen = 0;
    if (r.remaining) {
      r.u8(); // server default collation
      r.u16(); // status
      caps |= r.u16() << 16;
      authLen = r.u8();
      r.skip(10);
    }
    caps >>>= 0;
    let scramble = Buffer.from(part1);
    if (caps & CLIENT.SECURE_CONNECTION) {
      const n = Math.max(13, authLen - 8);
      const part2 = r.bytes(n);
      scramble = Buffer.concat([part1, part2.subarray(0, n - 1)]);
    }
    let plugin = caps & CLIENT.PLUGIN_AUTH ? r.nulStr() : 'mysql_native_password';
    if (!plugin) plugin = 'mysql_native_password';
    if (!(caps & CLIENT.PROTOCOL_41)) throw new DbError(`[${this.label}] the server (${version}) does not speak protocol 4.1`, 'DB_PROTOCOL');

    const ssl = o.ssl;
    let wantTls = ssl === true || (typeof ssl === 'object' && ssl !== null);
    if (wantTls && typeof ssl === 'object' && ssl.optional && !(caps & CLIENT.SSL)) wantTls = false;
    let flags = CLIENT.LONG_PASSWORD | CLIENT.FOUND_ROWS | CLIENT.LONG_FLAG | CLIENT.PROTOCOL_41 | CLIENT.TRANSACTIONS | CLIENT.SECURE_CONNECTION |
      CLIENT.MULTI_STATEMENTS | CLIENT.MULTI_RESULTS | CLIENT.PS_MULTI_RESULTS | CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA | CLIENT.CONNECT_ATTRS;
    if (o.database) flags |= CLIENT.CONNECT_WITH_DB;
    flags &= caps | CLIENT.PROTOCOL_41;
    if (wantTls) {
      if (!(caps & CLIENT.SSL)) throw new DbError(`[${this.label}] TLS was requested but MySQL ${o.host}:${o.port} (${version}) has TLS off`, 'DB_CONNECT');
      flags |= CLIENT.SSL;
    }
    this.capabilities = flags >>> 0;
    const head = Buffer.concat([u32(this.capabilities), u32(MAX_PACKET + 1), Buffer.from([UTF8MB4]), Buffer.alloc(23)]);
    let tls = false;
    if (wantTls) {
      this.write(head); // SSLRequest
      await this.startTls(typeof ssl === 'object' ? ssl : {});
      tls = true;
    }
    const password = o.password ?? '';
    const user = o.user ?? '';
    const token = this.firstToken(plugin, password, scramble, tls);
    const attrs = Buffer.concat(
      [['_client_name', 'eztest'], ['_os', process.platform], ['_pid', String(process.pid)]].flatMap(([k, v]) => [lenencBuf(Buffer.from(k)), lenencBuf(Buffer.from(v))]),
    );
    const parts: Buffer[] = [head, Buffer.from(`${user}\0`, 'utf8')];
    if (this.capabilities & CLIENT.PLUGIN_AUTH_LENENC_CLIENT_DATA) parts.push(lenencBuf(token));
    else parts.push(Buffer.from([token.length]), token);
    if (this.capabilities & CLIENT.CONNECT_WITH_DB) parts.push(Buffer.from(`${o.database}\0`, 'utf8'));
    if (this.capabilities & CLIENT.PLUGIN_AUTH) parts.push(Buffer.from(`${plugin}\0`));
    if (this.capabilities & CLIENT.CONNECT_ATTRS) parts.push(lenencBuf(attrs));
    this.write(Buffer.concat(parts));
    const used = await this.authenticate(plugin, scramble, password, tls);
    const flavor = /mariadb/i.test(version) ? 'mariadb' : 'mysql';
    this.server = { version: version.replace(/^5\.5\.5-/, ''), flavor, connectionId, tls, authPlugin: used };
  }

  private async startTls(t: MysqlTlsOptions): Promise<void> {
    const raw = this.socket as Socket;
    this.detach();
    const servername = t.servername ?? (isIP(this.o.host) ? undefined : this.o.host);
    const options: ConnectionOptions = {
      socket: raw,
      rejectUnauthorized: t.rejectUnauthorized ?? true,
      ...(servername ? { servername } : {}),
      ...(t.ca ? { ca: pemOrFile(t.ca) } : {}),
      ...(t.cert ? { cert: pemOrFile(t.cert) } : {}),
      ...(t.key ? { key: pemOrFile(t.key) } : {}),
    };
    // An IP address is checked against the certificate's IP SANs.
    if (!servername && (t.rejectUnauthorized ?? true)) options.checkServerIdentity = (_h, cert) => {
      const sans = (cert.subjectaltname ?? '').split(/,\s*/);
      return sans.includes(`IP Address:${this.o.host}`) ? undefined : new Error(`the certificate is not for ${this.o.host} (${cert.subjectaltname ?? cert.subject?.CN})`);
    };
    const secure = tlsConnect(options);
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', (e) => reject(new DbError(`[${this.label}] TLS with MySQL ${this.o.host}:${this.o.port} failed: ${e.message}`, 'DB_CONNECT')));
    });
    this.attach(secure);
  }

  private publicKey(): string | undefined {
    return this.o.serverPublicKey ? pemOrFile(this.o.serverPublicKey) : undefined;
  }

  private firstToken(plugin: string, password: string, scramble: Buffer, tls: boolean): Buffer {
    switch (plugin) {
      case 'mysql_native_password':
        return nativePasswordToken(password, scramble);
      case 'caching_sha2_password':
        return cachingSha2Token(password, scramble);
      case 'sha256_password': {
        if (!password) return Buffer.alloc(0);
        if (tls) return Buffer.from(`${password}\0`, 'utf8');
        const key = this.publicKey();
        return key ? rsaPasswordToken(password, scramble, key) : Buffer.from([1]); // 1: send me your public key
      }
      case 'mysql_clear_password':
        if (!tls) throw new DbError(`[${this.label}] the server asks for mysql_clear_password, which sends the password in clear text; use ssl`, 'DB_AUTH');
        return Buffer.from(`${password}\0`, 'utf8');
      default:
        throw new NotSupportedError(`MySQL authentication plugin "${plugin}"`);
    }
  }

  private noKeyError(plugin: string): DbError {
    return new DbError(
      `[${this.label}] ${plugin} needs the password sent securely: connect with ssl, give serverPublicKey (the server's RSA public key), or set allowPublicKeyRetrieval: true`,
      'DB_AUTH',
    );
  }

  private async rsaFull(plugin: string, password: string, scramble: Buffer, requestByte: number): Promise<void> {
    let key = this.publicKey();
    if (!key) {
      if (!this.o.allowPublicKeyRetrieval) throw this.noKeyError(plugin);
      this.write(Buffer.from([requestByte]));
      const p = await this.read();
      if (p[0] === 0xff) throw this.authError(parseError(p));
      key = p.subarray(1).toString('latin1');
    }
    this.write(rsaPasswordToken(password, scramble, key));
  }

  private authError(e: ServerError): DbError {
    return new DbError(`[${this.label}] MySQL sign-in as "${this.o.user ?? ''}" failed: ${e.message} (error ${e.errno}, SQLSTATE ${e.sqlState})`, 'DB_AUTH', { errno: e.errno, sqlState: e.sqlState });
  }

  private async authenticate(plugin: string, scramble: Buffer, password: string, tls: boolean): Promise<string> {
    for (;;) {
      const p = await this.read();
      if (p[0] === 0x00) return plugin;
      if (p[0] === 0xff) throw this.authError(parseError(p));
      if (p[0] === 0xfe) {
        // Auth switch: another plugin, with a fresh scramble.
        if (p.length === 1) throw new NotSupportedError('MySQL pre-4.1 password authentication');
        const r = new Reader(p);
        r.skip(1);
        plugin = r.nulStr();
        const data = r.rest();
        scramble = data[data.length - 1] === 0 ? data.subarray(0, data.length - 1) : data;
        this.write(this.firstToken(plugin, password, scramble, tls));
        continue;
      }
      if (p[0] === 0x01) {
        if (plugin === 'caching_sha2_password') {
          if (p[1] === 0x03) continue; // fast authentication worked; the OK follows
          if (p[1] === 0x04) {
            // Full authentication: the password itself, over TLS or RSA-encrypted.
            if (tls) this.write(Buffer.from(`${password}\0`, 'utf8'));
            else await this.rsaFull(plugin, password, scramble, 0x02);
            continue;
          }
        }
        if (plugin === 'sha256_password' && !tls) {
          // The server sent its public key (we asked with 0x01).
          this.write(rsaPasswordToken(password, scramble, p.subarray(1).toString('latin1')));
          continue;
        }
      }
      throw new DbError(`[${this.label}] unexpected MySQL authentication packet 0x${p[0]?.toString(16)} (${plugin})`, 'DB_PROTOCOL');
    }
  }

  // ---- commands

  /** Run fn with this connection to itself (commands are queued, never interleaved). */
  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private queryError(e: ServerError, sql: string): DbError {
    const head = sql.replace(/\s+/g, ' ').trim().slice(0, 120);
    return new DbError(`[${this.label}] ERROR ${e.errno} (${e.sqlState}): ${e.message} [in: ${head}]`, 'DB_QUERY', { errno: e.errno, sqlState: e.sqlState });
  }

  private async withTimeout<R>(p: Promise<R>): Promise<R> {
    const ms = this.o.queryTimeoutMs;
    if (!ms) return p;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.destroy();
            reject(new DbError(`[${this.label}] the statement did not finish within ${ms} ms; the connection was dropped`, 'DB_TIMEOUT'));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read column definitions (and the EOF after them). */
  private async columns(n: number): Promise<MysqlColumn[]> {
    const cols: MysqlColumn[] = [];
    for (let i = 0; i < n; i++) cols.push(parseColumn(await this.read()));
    if (n) {
      const eof = await this.read();
      if (!isEof(eof)) throw new DbError(`[${this.label}] MySQL protocol: expected EOF after column definitions`, 'DB_PROTOCOL');
    }
    return cols;
  }

  private textRow(cols: MysqlColumn[], p: Buffer): Row {
    const r = new Reader(p);
    const row: Row = {};
    for (const c of cols) {
      const b = r.lenencBytes();
      row[c.name] = b === null ? null : decodeBytes(c, b, this.decode);
    }
    return row;
  }

  private binaryRow(cols: MysqlColumn[], p: Buffer): Row {
    const r = new Reader(p);
    r.skip(1);
    const bitmap = r.bytes((cols.length + 7 + 2) >> 3);
    const row: Row = {};
    cols.forEach((c, i) => {
      const bit = i + 2;
      row[c.name] = bitmap[bit >> 3] & (1 << (bit & 7)) ? null : decodeBinaryValue(c, r, this.decode);
    });
    return row;
  }

  /** All results of a command: result sets and OKs, following SERVER_MORE_RESULTS_EXISTS. */
  private async results(binary: boolean, sql: string): Promise<MysqlResult[]> {
    const out: MysqlResult[] = [];
    let error: ServerError | undefined;
    for (;;) {
      const p = await this.read();
      if (p[0] === 0x00) {
        const ok = parseOk(p);
        out.push({ columns: [], rows: [], rowsAffected: ok.rowsAffected, lastInsertId: ok.lastInsertId, warnings: ok.warnings, ...(ok.info ? { info: ok.info } : {}) });
        if (ok.status & SERVER_MORE_RESULTS_EXISTS) continue;
        break;
      }
      if (p[0] === 0xff) {
        error = parseError(p);
        break;
      }
      if (p[0] === 0xfb) {
        // LOAD DATA LOCAL INFILE: never offered (no CLIENT_LOCAL_FILES), so refuse with an empty file.
        this.write(Buffer.alloc(0));
        continue;
      }
      const cols = await this.columns(new Reader(p).lenencNumber());
      const rows: Row[] = [];
      let status = 0;
      let warnings = 0;
      for (;;) {
        const rp = await this.read();
        if (isEof(rp)) {
          warnings = rp.readUInt16LE(1);
          status = rp.readUInt16LE(3);
          break;
        }
        if (rp[0] === 0xff) {
          error = parseError(rp);
          break;
        }
        rows.push(binary ? this.binaryRow(cols, rp) : this.textRow(cols, rp));
      }
      if (error) break;
      out.push({ columns: cols, rows, rowsAffected: 0, warnings });
      if (!(status & SERVER_MORE_RESULTS_EXISTS)) break;
    }
    if (error) throw this.queryError(error, sql);
    return out;
  }

  /** COM_QUERY: the text protocol. Several statements separated by ";" give several results. */
  query(sql: string): Promise<MysqlResult[]> {
    return this.serial(() =>
      this.guard(async () => {
        this.command(Buffer.concat([Buffer.from([COM.QUERY]), Buffer.from(sql, 'utf8')]));
        return this.withTimeout(this.results(false, sql));
      }),
    );
  }

  /** COM_STMT_PREPARE (cached per connection): parameter count and result columns, without running anything. */
  prepare(sql: string): Promise<PreparedStatement> {
    return this.serial(() => this.guard(() => this.prepareNow(sql)));
  }

  private async prepareNow(sql: string): Promise<PreparedStatement> {
    const hit = this.statements.get(sql);
    if (hit) {
      // Least recently used last.
      this.statements.delete(sql);
      this.statements.set(sql, hit);
      return hit;
    }
    this.command(Buffer.concat([Buffer.from([COM.STMT_PREPARE]), Buffer.from(sql, 'utf8')]));
    const p = await this.read();
    if (p[0] === 0xff) throw this.queryError(parseError(p), sql);
    const r = new Reader(p);
    r.skip(1);
    const id = r.u32();
    const ncols = r.u16();
    const nparams = r.u16();
    await this.columns(nparams);
    const columns = await this.columns(ncols);
    const stmt = { id, params: nparams, columns };
    this.statements.set(sql, stmt);
    if (this.statements.size > 128) {
      const [oldSql, old] = this.statements.entries().next().value as [string, PreparedStatement];
      this.statements.delete(oldSql);
      this.command(Buffer.concat([Buffer.from([COM.STMT_CLOSE]), u32(old.id)]));
    }
    return stmt;
  }

  /** COM_STMT_EXECUTE: the binary protocol with bound values. */
  execute(sql: string, values: unknown[]): Promise<MysqlResult[]> {
    return this.serial(() =>
      this.guard(async () => {
        const run = async (): Promise<MysqlResult[]> => {
          const stmt = await this.prepareNow(sql);
          if (stmt.params !== values.length) {
            throw new DbError(`[${this.label}] the statement has ${stmt.params} "?" marker(s) but ${values.length} value(s) were given`, 'DB_BIND');
          }
          const parts: Buffer[] = [Buffer.from([COM.STMT_EXECUTE]), u32(stmt.id), Buffer.from([0]), u32(1)];
          if (stmt.params) {
            const enc = values.map((v) => encodeParam(v, this.decode.tzOffset));
            const bitmap = Buffer.alloc((stmt.params + 7) >> 3);
            enc.forEach((e, i) => {
              if (e.type === T.NULL) bitmap[i >> 3] |= 1 << (i & 7);
            });
            parts.push(bitmap, Buffer.from([1]));
            for (const e of enc) parts.push(Buffer.from([e.type, e.unsigned ? 0x80 : 0]));
            for (const e of enc) if (e.value) parts.push(e.value);
          }
          this.command(Buffer.concat(parts));
          return this.withTimeout(this.results(true, sql));
        };
        try {
          return await run();
        } catch (e) {
          // 1615: "Prepared statement needs to be re-prepared" (a table it uses changed).
          if (e instanceof DbError && (e.details as { errno?: number } | undefined)?.errno === 1615) {
            this.statements.delete(sql);
            return run();
          }
          throw e;
        }
      }),
    );
  }

  ping(): Promise<void> {
    return this.serial(() =>
      this.guard(async () => {
        this.command(Buffer.from([COM.PING]));
        const p = await this.read();
        if (p[0] === 0xff) throw this.queryError(parseError(p), 'PING');
      }),
    );
  }

  /** Server errors leave the connection usable; anything else (socket, protocol, decoding) does not. */
  private async guard<R>(fn: () => Promise<R>): Promise<R> {
    if (!this.usable) throw new DbError(`[${this.label}] the MySQL connection is closed${this.failure ? `: ${this.failure.message}` : ''}`, 'DB_CONNECTION_LOST');
    try {
      return await fn();
    } catch (e) {
      const serverSide = e instanceof DbError && (e.code === 'DB_QUERY' || e.code === 'DB_BIND');
      if (!serverSide) this.usable = false;
      if (!(e instanceof DbError)) throw new DbError(`[${this.label}] MySQL connection failed: ${(e as Error).message}`, 'DB_CONNECTION_LOST');
      throw e;
    } finally {
      this.lastUsed = Date.now();
    }
  }

  async close(): Promise<void> {
    if (this.usable) {
      try {
        this.command(Buffer.from([COM.QUIT]));
      } catch {
        /* already gone */
      }
    }
    this.usable = false;
    await new Promise<void>((resolve) => {
      if (!this.socket || this.socket.destroyed) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.end();
      setTimeout(() => {
        this.socket.destroy();
        resolve();
      }, 1000).unref();
    });
  }

  destroy(): void {
    this.usable = false;
    this.socket?.destroy();
  }
}

// ----------------------------------------------------------------- pool

class MysqlPool {
  private readonly idle: MysqlConnection[] = [];
  private readonly all = new Set<MysqlConnection>();
  private readonly waiters: Array<{ resolve: (c: MysqlConnection) => void; reject: (e: Error) => void }> = [];
  private opening = 0;
  private ended = false;

  constructor(private readonly open: () => Promise<MysqlConnection>, readonly max: number) {}

  status(): { open: number; inUse: number; max: number } {
    return { open: this.all.size, inUse: this.all.size - this.idle.length, max: this.max };
  }

  /** A connection opened at once (so a bad address or password fails at connect time). */
  async prime(): Promise<MysqlConnection> {
    const c = await this.open();
    this.all.add(c);
    this.idle.push(c);
    return c;
  }

  async acquire(): Promise<MysqlConnection> {
    if (this.ended) throw new DbError('The MySQL pool is closed', 'DB_CLOSED');
    for (;;) {
      const c = this.idle.pop();
      if (!c) break;
      if (!c.usable) {
        this.drop(c);
        continue;
      }
      // A connection idle for minutes may have been closed by the server (wait_timeout) or a firewall.
      if (Date.now() - c.lastUsed > 120_000) {
        try {
          await c.ping();
        } catch {
          this.drop(c);
          continue;
        }
      }
      return c;
    }
    if (this.all.size + this.opening < this.max) {
      this.opening++;
      try {
        const c = await this.open();
        this.all.add(c);
        return c;
      } finally {
        this.opening--;
      }
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  release(c: MysqlConnection): void {
    if (!c.usable || this.ended) {
      this.drop(c);
      if (this.ended) void c.close();
      // A waiter gets a new connection in place of the dropped one.
      const w = this.waiters.shift();
      if (w && !this.ended) this.acquire().then(w.resolve, w.reject);
      return;
    }
    const w = this.waiters.shift();
    if (w) w.resolve(c);
    else this.idle.push(c);
  }

  private drop(c: MysqlConnection): void {
    this.all.delete(c);
    const i = this.idle.indexOf(c);
    if (i >= 0) this.idle.splice(i, 1);
    c.destroy();
  }

  async end(): Promise<void> {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.reject(new DbError('The MySQL pool was closed', 'DB_CLOSED'));
    const idle = this.idle.splice(0);
    for (const c of idle) this.all.delete(c);
    await Promise.all(idle.map((c) => c.close()));
  }
}

// ----------------------------------------------------------------- client

/** The first result set of a statement's results (a CALL also returns a final OK), else the first result. */
function primary(results: MysqlResult[]): MysqlResult {
  return results.find((r) => r.columns.length) ?? results[0] ?? { columns: [], rows: [], rowsAffected: 0, warnings: 0 };
}

export class MysqlDbClient implements DbClient {
  readonly dialect = 'mysql' as const;
  readonly name: string;

  private constructor(name: string, private readonly pool: MysqlPool, readonly server: MysqlServerInfo) {
    this.name = name;
  }

  static async connect(o: MysqlOptions): Promise<MysqlDbClient> {
    const settings = mysqlSettings(o);
    const name = o.name ?? 'mysql';
    const max = settings.pool?.max ?? 4;
    if (!Number.isInteger(max) || max < 1) throw new DbError('MySQL pool.max must be a whole number of 1 or more', 'DB_CONFIG');
    const pool = new MysqlPool(() => MysqlConnection.open(settings, name), max);
    const first = await pool.prime();
    return new MysqlDbClient(name, pool, first.server);
  }

  /**
   * The SQL and values sent: an array binds `?` markers as is; an object binds `:name` markers, rewritten to `?`
   * (string literals, backslash escapes, `backtick` identifiers and comments are left alone).
   */
  static bind(sql: string, p?: SqlParams): { text: string; values: unknown[] } {
    if (!p) return { text: sql, values: [] };
    if (Array.isArray(p)) return { text: sql, values: p };
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) values[k.replace(/^[:@$]/, '')] = v;
    try {
      const r = namedToPositional(sql, values, 'mysql');
      return { text: r.sql, values: r.params };
    } catch (e) {
      throw new DbError(`MySQL named binds: ${(e as Error).message} (binds given: ${Object.keys(values).join(', ') || 'none'})`, 'DB_BIND');
    }
  }

  private async withConn<R>(fn: (c: MysqlConnection) => Promise<R>): Promise<R> {
    const c = await this.pool.acquire();
    try {
      return await fn(c);
    } finally {
      this.pool.release(c);
    }
  }

  private static run(c: MysqlConnection, sql: string, p?: SqlParams): Promise<MysqlResult[]> {
    if (typeof sql !== 'string' || !sql.trim()) throw new DbError('SQL is empty', 'DB_EMPTY_SQL');
    const { text, values } = MysqlDbClient.bind(sql, p);
    return values.length ? c.execute(text, values) : c.query(text);
  }

  private static rows<T>(results: MysqlResult[]): T[] {
    return primary(results).rows.map((r) => caseInsensitiveRow(r)) as T[];
  }

  private static exec(results: MysqlResult[]): ExecResult {
    const oks = results.filter((r) => !r.columns.length);
    const last = oks[oks.length - 1];
    const id = last?.lastInsertId;
    return { rowsAffected: oks.reduce((a, r) => a + r.rowsAffected, 0), ...(id !== undefined && id !== 0 ? { lastInsertId: id } : {}) };
  }

  private txClient(c: MysqlConnection): DbClient {
    return {
      name: this.name,
      dialect: 'mysql',
      query: async <R extends Row = Row>(sql: string, p?: SqlParams) => MysqlDbClient.rows<R>(await MysqlDbClient.run(c, sql, p)),
      execute: async (sql: string, p?: SqlParams) => MysqlDbClient.exec(await MysqlDbClient.run(c, sql, p)),
      transaction: () => {
        throw new NotSupportedError('nested MySQL transactions (use SAVEPOINT explicitly)');
      },
      close: async () => {
        throw new DbError('Cannot close the connection inside a transaction', 'DB_TX_CLOSE');
      },
    };
  }

  async query<T extends Row = Row>(sql: string, p?: SqlParams): Promise<T[]> {
    return this.withConn(async (c) => MysqlDbClient.rows<T>(await MysqlDbClient.run(c, sql, p)));
  }

  async execute(sql: string, p?: SqlParams): Promise<ExecResult> {
    return this.withConn(async (c) => MysqlDbClient.exec(await MysqlDbClient.run(c, sql, p)));
  }

  /** Every result of a statement: one per result set and OK (several statements, or a CALL). */
  async results(sql: string, p?: SqlParams): Promise<MysqlResult[]> {
    return this.withConn(async (c) => {
      const out = await MysqlDbClient.run(c, sql, p);
      return out.map((r) => ({ ...r, rows: r.rows.map((x) => caseInsensitiveRow(x)) }));
    });
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.withConn(async (c) => {
      await c.query('START TRANSACTION');
      try {
        const out = await fn(this.txClient(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        if (c.usable) await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  }

  /** Runs fn inside START TRANSACTION READ ONLY and always rolls back: any write fails with error 1792. */
  async readOnly<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.withConn(async (c) => {
      await c.query('START TRANSACTION READ ONLY');
      try {
        return await fn(this.txClient(c));
      } finally {
        if (c.usable) await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  /** Prepares a statement without running it: the server checks the syntax, tables and columns. */
  async describe(sql: string): Promise<{ params: number; columns: string[] }> {
    return this.withConn(async (c) => {
      const s = await c.prepare(MysqlDbClient.bind(sql, undefined).text);
      return { params: s.params, columns: s.columns.map((x) => x.name) };
    });
  }

  async ping(): Promise<{ ok: true; version: string; latencyMs: number }> {
    const t = Date.now();
    return this.withConn(async (c) => {
      await c.ping();
      return { ok: true as const, version: `${this.server.flavor === 'mariadb' ? 'MariaDB' : 'MySQL'} ${this.server.version}${this.server.tls ? ' (TLS)' : ''}`, latencyMs: Date.now() - t };
    });
  }

  poolStatus(): { open: number; inUse: number; max: number } {
    return this.pool.status();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
