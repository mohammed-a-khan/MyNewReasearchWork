/** Small HTTP helpers on node:http: bodies, cookies, multipart parsing, responses. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = (await readBody(req)).toString('utf8');
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req)).toString('utf8'));
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

export function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'cache-control': 'no-store', ...headers });
}

export function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(303, { location: to, ...headers });
  res.end();
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setCookie(name: string, value: string, opts: { maxAge?: number; path?: string } = {}): string {
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path ?? '/'}; HttpOnly; SameSite=Lax${opts.maxAge !== undefined ? `; Max-Age=${opts.maxAge}` : ''}`;
}

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Parse a multipart/form-data body (RFC 7578). */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'multipart body without boundary');
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts: MultipartPart[] = [];
  let pos = body.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = body.subarray(start + 2, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const data = body.subarray(headerEnd + 4, next - 2); // strip the CRLF before the boundary
    const disp = /content-disposition:[^\r\n]*?name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headers);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (disp) parts.push({ name: disp[1], filename: disp[2], contentType: ct?.[1]?.trim(), data: Buffer.from(data) });
    pos = next;
  }
  return parts;
}

export const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
