/**
 * AWS Signature Version 4, written from the AWS documentation ("Create a
 * signed AWS API request"): canonical request, string to sign, the derived
 * signing key, and both forms of a signature - the Authorization header and
 * a presigned query string. Used for AWS Secrets Manager and for Amazon MSK
 * IAM authentication on Kafka; no AWS SDK is involved.
 */
import { createHash, createHmac } from 'node:crypto';
import { EzTestError } from '../core/index.js';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Signing time (default now). */
  date?: Date;
  /** Hex SHA-256 of the payload, or "UNSIGNED-PAYLOAD" (default: hashed from `body`). */
  payloadHash?: string;
  /** Encode each path segment twice (true for every service except S3; default true unless service is s3). */
  doubleEncodePath?: boolean;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as SigV4 needs it: everything but A-Z a-z 0-9 - _ . ~ is %XX (upper case). */
export function awsUriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 20150830T123600Z */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The SigV4 signing key: HMAC chain over date, region, service and "aws4_request". */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
}

function canonicalPath(u: URL, double: boolean): string {
  const segments = (u.pathname || '/').split('/').map((seg) => {
    const raw = (() => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })();
    const once = awsUriEncode(raw);
    return double ? awsUriEncode(once) : once;
  });
  const p = segments.join('/');
  return p.startsWith('/') ? p : `/${p}`;
}

function canonicalQuery(u: URL): string {
  const pairs: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => pairs.push([awsUriEncode(k), awsUriEncode(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(headers: Record<string, string>): { text: string; signed: string } {
  const map = new Map<string, string[]>();
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase().trim();
    const list = map.get(name) ?? [];
    list.push(String(v).trim().replace(/\s+/g, ' '));
    map.set(name, list);
  }
  const names = [...map.keys()].sort();
  return { text: names.map((n) => `${n}:${map.get(n)!.join(',')}\n`).join(''), signed: names.join(';') };
}

export interface SigV4Parts {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  scope: string;
  signedHeaders: string;
  amzDate: string;
}

function sign(r: SigV4Request, u: URL, headers: Record<string, string>, payloadHash: string): SigV4Parts {
  const d = r.date ?? new Date();
  const when = amzDate(d);
  const day = when.slice(0, 8);
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const h = canonicalHeaders(headers);
  const canonicalRequest = [r.method.toUpperCase(), canonicalPath(u, r.doubleEncodePath ?? r.service !== 's3'), canonicalQuery(u), h.text, h.signed, payloadHash].join('\n');
  const stringToSign = [ALGORITHM, when, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(r.credentials.secretAccessKey, day, r.region, r.service)).update(stringToSign, 'utf8').digest('hex');
  return { canonicalRequest, stringToSign, signature, scope, signedHeaders: h.signed, amzDate: when };
}

function check(r: SigV4Request): void {
  if (!r.credentials?.accessKeyId || !r.credentials.secretAccessKey) throw new EzTestError('AWS signing needs an access key id and a secret access key', 'AWS_CREDENTIALS');
  if (!/^[a-z0-9-]+$/.test(r.region)) throw new EzTestError(`Invalid AWS region "${r.region}"`, 'AWS_CONFIG');
}

/**
 * Sign a request with an Authorization header. Returns the headers to send
 * (the given ones plus host, x-amz-date, x-amz-security-token and Authorization).
 */
export function signRequest(r: SigV4Request): { headers: Record<string, string>; parts: SigV4Parts } {
  check(r);
  const u = new URL(String(r.url));
  const d = r.date ?? new Date();
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers.host = u.host;
  headers['x-amz-date'] = amzDate(d);
  if (r.credentials.sessionToken) headers['x-amz-security-token'] = r.credentials.sessionToken;
  const payloadHash = r.payloadHash ?? sha256Hex(r.body ?? '');
  const parts = sign({ ...r, date: d }, u, headers, payloadHash);
  headers.authorization = `${ALGORITHM} Credential=${r.credentials.accessKeyId}/${parts.scope}, SignedHeaders=${parts.signedHeaders}, Signature=${parts.signature}`;
  return { headers, parts };
}

/**
 * A presigned URL (signature in the query string, X-Amz-*), signing only the host header.
 * `extraQuery` values are part of the signed query.
 */
export function presignUrl(r: SigV4Request & { expiresSeconds?: number }): { url: URL; parts: SigV4Parts } {
  check(r);
  const u = new URL(String(r.url));
  const d = r.date ?? new Date();
  const when = amzDate(d);
  u.searchParams.set('X-Amz-Algorithm', ALGORITHM);
  u.searchParams.set('X-Amz-Credential', `${r.credentials.accessKeyId}/${when.slice(0, 8)}/${r.region}/${r.service}/aws4_request`);
  u.searchParams.set('X-Amz-Date', when);
  u.searchParams.set('X-Amz-Expires', String(r.expiresSeconds ?? 900));
  if (r.credentials.sessionToken) u.searchParams.set('X-Amz-Security-Token', r.credentials.sessionToken);
  u.searchParams.set('X-Amz-SignedHeaders', 'host');
  const parts = sign({ ...r, date: d }, u, { host: u.host }, r.payloadHash ?? sha256Hex(r.body ?? ''));
  u.searchParams.set('X-Amz-Signature', parts.signature);
  return { url: u, parts };
}

/** Credentials from explicit values, else the standard environment variables. */
export function awsCredentials(o: Partial<AwsCredentials> = {}, env: Record<string, string | undefined> = process.env): AwsCredentials {
  const accessKeyId = o.accessKeyId ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = o.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = o.sessionToken ?? env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) throw new EzTestError('AWS credentials are not set: give accessKeyId and secretAccessKey (secret:// references), or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY', 'AWS_CREDENTIALS');
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}
