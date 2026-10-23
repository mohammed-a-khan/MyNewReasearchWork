/**
 * Shared HTTP plumbing for the Studio server: errors, JSON responses, body
 * parsing, argument coercion, security headers and content types. Every route
 * module uses these so parsing and error shapes are identical everywhere.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JourneyFormat } from './authoring.js';

/** An error with an HTTP status; the dispatcher turns it into `{ error }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_BODY = 5 * 1024 * 1024;

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.har': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.ez': 'text/plain; charset=utf-8',
};

/** The Studio page: only our own script and stylesheet, no inline script or style elements. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** Generated HTML reports carry their own inline script/style and may not talk to the network. */
export const REPORT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
/** Any other run artifact is sandboxed. */
export const ASSET_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'";

export function baseHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: message, ...extra });
}

export function sendText(res: ServerResponse, status: number, type: string, body: string | Buffer, head = false): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

/** Read a JSON object body (max 5 MiB). An empty body is `{}`. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new HttpError(400, `"${name}" must be a string`);
  return v;
}

export function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function strList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, 'Expected a list of strings');
  return v.map((x) => String(x));
}

export function fmt(v: unknown, name: string): JourneyFormat {
  if (v === 'ez' || v === 'yaml' || v === 'json' || v === 'ts') return v;
  throw new HttpError(400, `"${name}" must be ez, yaml, json or ts`);
}
