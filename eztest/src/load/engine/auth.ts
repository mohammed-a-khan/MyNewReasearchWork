/**
 * HTTP authentication for virtual users, written for EZTest Load:
 *
 * - Basic (RFC 7617) and Bearer.
 * - Digest (RFC 7616): MD5, MD5-sess, SHA-256, SHA-256-sess with qop=auth,
 *   nonce counting per VU.
 * - NTLM (MS-NLMP) with NTLMv2 responses: Type 1/2/3 messages and MD4 for
 *   the NT hash are implemented here (OpenSSL 3 no longer offers MD4).
 * - Negotiate (SPNEGO/Kerberos): EZTest does not implement Kerberos; a VU
 *   gets its token from `tokenCommand` (e.g. a helper using the OS GSS-API
 *   or `kinit` credentials) or a fixed `token`.
 * - OAuth 2.0 client-credentials / password grants with token caching.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EzTestError } from '../../core/index.js';

const run = promisify(execFile);

// ------------------------------------------------------------------ basic

export function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

// ------------------------------------------------------------------ digest

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
  stale?: boolean;
}

/** Parse `Digest realm="x", nonce="y", ...` (also from a list of WWW-Authenticate values). */
export function parseChallenge(header: string | string[] | undefined, scheme: string): Record<string, string> | undefined {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  for (const v of values) {
    const idx = v.toLowerCase().indexOf(scheme.toLowerCase());
    if (idx < 0) continue;
    const rest = v.slice(idx + scheme.length).trim();
    if (!rest || !/=/.test(rest)) return { token: rest };
    const out: Record<string, string> = {};
    const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    return out;
  }
  return undefined;
}

const hashOf = (alg: string) => (/sha-?256/i.test(alg) ? 'sha256' : 'md5');

export class DigestAuth {
  private nc = 0;
  private challenge?: Record<string, string>;
  constructor(private readonly username: string, private readonly password: string) {}

  get ready(): boolean {
    return !!this.challenge;
  }

  accept(wwwAuthenticate: string | string[] | undefined): boolean {
    const c = parseChallenge(wwwAuthenticate, 'Digest');
    if (!c?.nonce || c.realm === undefined) return false;
    if (this.challenge?.nonce !== c.nonce) this.nc = 0;
    this.challenge = c;
    return true;
  }

  header(method: string, uri: string): string {
    const c = this.challenge;
    if (!c) throw new EzTestError('Digest: no challenge yet', 'LOAD_AUTH');
    const alg = c.algorithm ?? 'MD5';
    const h = (s: string) => createHash(hashOf(alg)).update(s).digest('hex');
    const cnonce = randomBytes(8).toString('hex');
    const nc = (++this.nc).toString(16).padStart(8, '0');
    let ha1 = h(`${this.username}:${c.realm}:${this.password}`);
    if (/-sess$/i.test(alg)) ha1 = h(`${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = h(`${method}:${uri}`);
    const qop = c.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
    const response = qop ? h(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${c.nonce}:${ha2}`);
    const parts = [`username="${this.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `algorithm=${alg}`, `response="${response}"`];
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
  }
}

// ------------------------------------------------------------------ MD4 (RFC 1320)

export function md4(input: Buffer): Buffer {
  const msgLen = input.length;
  const padLen = ((msgLen + 8) >> 6 << 6) + 64;
  const buf = Buffer.alloc(padLen);
  input.copy(buf);
  buf[msgLen] = 0x80;
  buf.writeUInt32LE((msgLen * 8) >>> 0, padLen - 8);
  buf.writeUInt32LE(Math.floor((msgLen * 8) / 0x1_0000_0000), padLen - 4);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rotl = (x: number, s: number) => (x << s) | (x >>> (32 - s));
  const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
  const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
  const H = (x: number, y: number, z: number) => x ^ y ^ z;
  const X = new Array<number>(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = buf.readUInt32LE(off + i * 4);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const r1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i++) {
      const k = i;
      const s = r1[i % 4];
      if (i % 4 === 0) a = rotl((a + F(b, c, d) + X[k]) | 0, s);
      else if (i % 4 === 1) d = rotl((d + F(a, b, c) + X[k]) | 0, s);
      else if (i % 4 === 2) c = rotl((c + F(d, a, b) + X[k]) | 0, s);
      else b = rotl((b + F(c, d, a) + X[k]) | 0, s);
    }
    const r2 = [3, 5, 9, 13];
    const o2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (let i = 0; i < 16; i++) {
      const k = o2[i];
      const s = r2[i % 4];
      if (i % 4 === 0) a = rotl((a + G(b, c, d) + X[k] + 0x5a827999) | 0, s);
      else if (i % 4 === 1) d = rotl((d + G(a, b, c) + X[k] + 0x5a827999) | 0, s);
      else if (i % 4 === 2) c = rotl((c + G(d, a, b) + X[k] + 0x5a827999) | 0, s);
      else b = rotl((b + G(c, d, a) + X[k] + 0x5a827999) | 0, s);
    }
    const r3 = [3, 9, 11, 15];
    const o3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i++) {
      const k = o3[i];
      const s = r3[i % 4];
      if (i % 4 === 0) a = rotl((a + H(b, c, d) + X[k] + 0x6ed9eba1) | 0, s);
      else if (i % 4 === 1) d = rotl((d + H(a, b, c) + X[k] + 0x6ed9eba1) | 0, s);
      else if (i % 4 === 2) c = rotl((c + H(d, a, b) + X[k] + 0x6ed9eba1) | 0, s);
      else b = rotl((b + H(c, d, a) + X[k] + 0x6ed9eba1) | 0, s);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0);
  out.writeInt32LE(b, 4);
  out.writeInt32LE(c, 8);
  out.writeInt32LE(d, 12);
  return out;
}

// ------------------------------------------------------------------ NTLM (MS-NLMP)

const NTLMSSP = Buffer.from('NTLMSSP\0', 'latin1');
const FLAGS = 0x00000001 /* UNICODE */ | 0x00000200 /* NTLM */ | 0x00008000 /* ALWAYS_SIGN */ | 0x00080000 /* EXTENDED_SESSIONSECURITY */ | 0x00800000 /* TARGET_INFO */ | 0x00000004 /* REQUEST_TARGET */ | 0x20000000 /* 128 */ | 0x80000000; /* 56 */

export function ntowfv1(password: string): Buffer {
  return md4(Buffer.from(password, 'utf16le'));
}

export function ntowfv2(password: string, user: string, domain: string): Buffer {
  return createHmac('md5', ntowfv1(password)).update(Buffer.from(user.toUpperCase() + domain, 'utf16le')).digest();
}

/** Type 1 (negotiate) message, base64. */
export function ntlmType1(): string {
  const b = Buffer.alloc(32);
  NTLMSSP.copy(b, 0);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(FLAGS >>> 0, 12);
  // empty domain and workstation security buffers (offset 32)
  b.writeUInt32LE(32, 20);
  b.writeUInt32LE(32, 28);
  return b.toString('base64');
}

export interface NtlmType2 {
  challenge: Buffer;
  flags: number;
  targetInfo: Buffer;
}

export function parseNtlmType2(b64: string): NtlmType2 {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 32 || !b.subarray(0, 8).equals(NTLMSSP) || b.readUInt32LE(8) !== 2) throw new EzTestError('NTLM: not a Type 2 (challenge) message', 'LOAD_AUTH');
  const flags = b.readUInt32LE(20);
  const challenge = Buffer.from(b.subarray(24, 32));
  let targetInfo = Buffer.alloc(0);
  if (b.length >= 48) {
    const len = b.readUInt16LE(40);
    const off = b.readUInt32LE(44);
    if (off + len <= b.length) targetInfo = Buffer.from(b.subarray(off, off + len));
  }
  return { challenge, flags, targetInfo };
}

/** NTLMv2 response and the LMv2 response for a challenge. */
export function ntlmv2Responses(o: { password: string; user: string; domain: string; serverChallenge: Buffer; targetInfo: Buffer; clientChallenge?: Buffer; timestamp?: bigint }): { nt: Buffer; lm: Buffer; ntProofStr: Buffer } {
  const key = ntowfv2(o.password, o.user, o.domain);
  const cc = o.clientChallenge ?? randomBytes(8);
  const ts = o.timestamp ?? (BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n;
  const temp = Buffer.alloc(28 + o.targetInfo.length + 4);
  temp.writeUInt8(1, 0);
  temp.writeUInt8(1, 1);
  temp.writeBigUInt64LE(ts, 8);
  cc.copy(temp, 16);
  o.targetInfo.copy(temp, 28);
  const ntProofStr = createHmac('md5', key).update(Buffer.concat([o.serverChallenge, temp])).digest();
  const lm = Buffer.concat([createHmac('md5', key).update(Buffer.concat([o.serverChallenge, cc])).digest(), cc]);
  return { nt: Buffer.concat([ntProofStr, temp]), lm, ntProofStr };
}

/** Type 3 (authenticate) message, base64. */
export function ntlmType3(o: { user: string; password: string; domain: string; workstation: string; type2: NtlmType2 }): string {
  const { nt, lm } = ntlmv2Responses({ password: o.password, user: o.user, domain: o.domain, serverChallenge: o.type2.challenge, targetInfo: o.type2.targetInfo });
  const dom = Buffer.from(o.domain, 'utf16le');
  const usr = Buffer.from(o.user, 'utf16le');
  const ws = Buffer.from(o.workstation, 'utf16le');
  const header = 64;
  const fields = [lm, nt, dom, usr, ws, Buffer.alloc(0)];
  const b = Buffer.alloc(header + fields.reduce((a, f) => a + f.length, 0));
  NTLMSSP.copy(b, 0);
  b.writeUInt32LE(3, 8);
  let off = header;
  const positions = [12, 20, 28, 36, 44, 52];
  fields.forEach((f, i) => {
    b.writeUInt16LE(f.length, positions[i]);
    b.writeUInt16LE(f.length, positions[i] + 2);
    b.writeUInt32LE(off, positions[i] + 4);
    f.copy(b, off);
    off += f.length;
  });
  b.writeUInt32LE((o.type2.flags & FLAGS) >>> 0 || FLAGS >>> 0, 60);
  return b.toString('base64');
}

/** Parse a Type 3 message (used by EZTest's own NTLM test server). */
export function parseNtlmType3(b64: string): { lm: Buffer; nt: Buffer; domain: string; user: string; workstation: string } {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 64 || !b.subarray(0, 8).equals(NTLMSSP) || b.readUInt32LE(8) !== 3) throw new EzTestError('NTLM: not a Type 3 message', 'LOAD_AUTH');
  const field = (pos: number) => b.subarray(b.readUInt32LE(pos + 4), b.readUInt32LE(pos + 4) + b.readUInt16LE(pos));
  return { lm: Buffer.from(field(12)), nt: Buffer.from(field(20)), domain: field(28).toString('utf16le'), user: field(36).toString('utf16le'), workstation: field(44).toString('utf16le') };
}

/** Build a Type 2 message (test servers). */
export function ntlmType2(challenge: Buffer, targetInfo: Buffer = Buffer.alloc(0)): string {
  const b = Buffer.alloc(48 + targetInfo.length);
  NTLMSSP.copy(b, 0);
  b.writeUInt32LE(2, 8);
  b.writeUInt32LE(48, 16);
  b.writeUInt32LE(FLAGS >>> 0, 20);
  challenge.copy(b, 24);
  b.writeUInt16LE(targetInfo.length, 40);
  b.writeUInt16LE(targetInfo.length, 42);
  b.writeUInt32LE(48, 44);
  targetInfo.copy(b, 48);
  return b.toString('base64');
}

// ------------------------------------------------------------------ Negotiate

export async function negotiateToken(o: { tokenCommand?: string; token?: string }, host: string): Promise<string> {
  if (o.token) return o.token;
  if (!o.tokenCommand) throw new EzTestError('negotiate auth needs token or tokenCommand', 'LOAD_AUTH');
  const [cmd, ...args] = o.tokenCommand.split(/\s+/).map((a) => a.replace(/\{host\}/g, host));
  const { stdout } = await run(cmd, args, { timeout: 15_000 });
  const t = stdout.trim().replace(/^Negotiate\s+/i, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(t)) throw new EzTestError('negotiate tokenCommand did not print a base64 token', 'LOAD_AUTH');
  return t;
}
