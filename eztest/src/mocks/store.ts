/**
 * Mock store: recorded (or handwritten) request/response pairs as JSON.
 * Secrets are redacted before anything reaches disk.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { redactFormBody, redactHeaders, redactJsonValue } from './redact.js';

export const RecordedRequest = z.object({
  method: z.string().min(1),
  path: z.string().startsWith('/'),
  /** Normalized query string (sorted, without leading "?"). */
  query: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  bodyEncoding: z.enum(['utf8', 'base64']).optional(),
  /** sha256 of the canonical (redacted) request body. Computed on load when absent. */
  bodyHash: z.string().optional(),
});
export type RecordedRequest = z.infer<typeof RecordedRequest>;

export const RecordedResponse = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().default(''),
  bodyEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  /** Extra latency applied when replaying this response. */
  delayMs: z.number().int().min(0).optional(),
});
export type RecordedResponse = z.infer<typeof RecordedResponse>;

export const Recording = z.object({
  id: z.string().min(1),
  request: RecordedRequest,
  response: RecordedResponse,
  recordedAt: z.string().default(() => new Date().toISOString()),
});
export type Recording = z.infer<typeof Recording>;
export type RecordingInput = z.input<typeof Recording>;

export const MockStore = z.object({
  format: z.literal('eztest-mocks').default('eztest-mocks'),
  version: z.literal(1).default(1),
  target: z.string().optional(),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
  recordings: z.array(Recording).default([]),
});
export type MockStore = z.infer<typeof MockStore>;

export function emptyStore(target?: string): MockStore {
  const now = new Date().toISOString();
  return { format: 'eztest-mocks', version: 1, target, createdAt: now, updatedAt: now, recordings: [] };
}

export function parseStore(input: unknown): MockStore {
  const r = MockStore.safeParse(input);
  if (!r.success) {
    throw new EzTestError(`Invalid mock store: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'MOCK_STORE_INVALID');
  }
  for (const rec of r.data.recordings) {
    rec.request.method = rec.request.method.toUpperCase();
    rec.request.query = normalizeQuery(rec.request.query);
    if (rec.request.bodyHash === undefined) rec.request.bodyHash = bodyHash(rec.request.body, rec.request.headers['content-type']);
  }
  return r.data;
}

export async function loadStore(path: string): Promise<MockStore> {
  if (!existsSync(path)) throw new EzTestError(`Mock store not found: ${path}`, 'MOCK_STORE_MISSING');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new EzTestError(`Mock store is not valid JSON: ${path} (${(e as Error).message})`, 'MOCK_STORE_INVALID');
  }
  return parseStore(raw);
}

/** Atomic write: temp file + rename. */
export async function saveStore(path: string, store: MockStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2));
  await rename(tmp, path);
}

/** Sort query parameters so `?b=2&a=1` and `?a=1&b=2` match. */
export function normalizeQuery(search: string, ignore: string[] = []): string {
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return '';
  const params = [...new URLSearchParams(s)].filter(([k]) => !ignore.includes(k));
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return new URLSearchParams(params).toString();
}

export function isTextContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[\w.+-]+\+(json|xml)))/i.test(ct.trim());
}

export function isJsonContentType(ct: string | undefined): boolean {
  return !!ct && /^application\/([\w.+-]+\+)?json/i.test(ct.trim());
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Redact secrets from a body according to its content type. Non-text bodies are left as-is. */
export function redactBody(body: string, contentType: string | undefined, replacement: string): string {
  if (!body) return body;
  if (isJsonContentType(contentType)) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(body), replacement));
    } catch {
      return body;
    }
  }
  if (contentType && /^application\/x-www-form-urlencoded/i.test(contentType)) return redactFormBody(body, replacement);
  return body;
}

/** Hash of a request body for matching; JSON is canonicalized; secrets are redacted first so record and replay agree. */
export function bodyHash(body: string | undefined, contentType: string | undefined): string | undefined {
  if (body === undefined || body === '') return undefined;
  let canon = redactBody(body, contentType, '[REDACTED]');
  if (isJsonContentType(contentType)) {
    try {
      canon = canonicalJson(JSON.parse(canon));
    } catch {
      /* keep raw */
    }
  }
  return createHash('sha256').update(canon).digest('hex');
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'te', 'trailer', 'content-length', 'date']);

export function storableResponseHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const red = redactHeaders(h);
  for (const k of Object.keys(red)) if (HOP_BY_HOP.has(k)) delete red[k];
  return red;
}

/** Encode bytes for the store: utf8 for text, base64 otherwise. */
export function encodeBody(bytes: Buffer, contentType: string | undefined): { body: string; bodyEncoding: 'utf8' | 'base64' } {
  if (bytes.length === 0) return { body: '', bodyEncoding: 'utf8' };
  if (isTextContentType(contentType)) return { body: bytes.toString('utf8'), bodyEncoding: 'utf8' };
  const asText = bytes.toString('utf8');
  if (Buffer.from(asText, 'utf8').equals(bytes) && !/[\u0000-\u0008\u000E-\u001F]/.test(asText)) return { body: asText, bodyEncoding: 'utf8' };
  return { body: bytes.toString('base64'), bodyEncoding: 'base64' };
}

export function decodeBody(body: string, enc: 'utf8' | 'base64' | undefined): Buffer {
  return enc === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}
