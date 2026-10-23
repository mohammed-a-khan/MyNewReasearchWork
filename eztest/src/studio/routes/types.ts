/**
 * Framework-agnostic Studio route definitions: `{ method, path, handler }`
 * where the handler takes parsed input and returns JSON, a body, or an SSE
 * stream. The server (or any host) matches the route, authenticates exactly as
 * for every other `/api/` call, parses the JSON body and writes the response.
 * Handlers throw `HttpError` (from runs.ts) for client errors.
 */
import { EzTestError } from '../../core/index.js';
import { HttpError } from '../runs.js';

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteContext {
  method: string;
  /** URL path, e.g. `/api/debug/session`. */
  path: string;
  /** Capture groups of a RegExp path, URI-decoded. */
  params: string[];
  query: URLSearchParams;
  /** Parsed JSON body (empty object for GET). */
  body: Record<string, unknown>;
}

/** One server-sent event. `data` is JSON-encoded by the host. */
export interface SseMessage {
  id?: number;
  event?: string;
  data: unknown;
}

export interface SseSink {
  /** Write one event; returns false when the client is slow (the host's buffer is full). */
  send(message: SseMessage): boolean;
  close(): void;
}

export type RouteResponse =
  | { status?: number; json: unknown }
  | { status?: number; body: Buffer | string; contentType: string; headers?: Record<string, string> }
  /** Stream server-sent events; return a function that unsubscribes when the client goes away. */
  | { sse: (sink: SseSink) => () => void };

export interface RouteDef {
  method: RouteMethod;
  path: string | RegExp;
  handler(ctx: RouteContext): Promise<RouteResponse> | RouteResponse;
}

/** Find the route for a method + path; RegExp captures become `params`. */
export function matchRoute(routes: RouteDef[], method: string, path: string): { route: RouteDef; params: string[] } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === path) return { route, params: [] };
      continue;
    }
    const m = route.path.exec(path);
    if (m && m[0] === path) {
      try {
        return { route, params: m.slice(1).map((p) => decodeURIComponent(p ?? '')) };
      } catch {
        throw new HttpError(400, 'Bad path encoding');
      }
    }
  }
  return undefined;
}

/** Map engine errors to HTTP errors (409 for state, 400 for bad input, 404 for missing). */
export function toHttpError(e: unknown): Error {
  if (e instanceof HttpError) return e;
  const err = e as Error & { code?: string; status?: number };
  if (err instanceof EzTestError) {
    if (err.code === 'DEBUG_STATE') return new HttpError(409, err.message);
    if (err.code === 'NOT_FOUND') return new HttpError(404, err.message);
    if (/^BAD_|INTENT|UNKNOWN_VARIABLE/.test(err.code)) return new HttpError(400, err.message);
    return new HttpError(422, err.message);
  }
  if (err?.code === 'ENOENT') return new HttpError(404, 'Not found');
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) return new HttpError(err.status, err.message);
  if (err?.name === 'ZodError') return new HttpError(400, err.message);
  return err instanceof Error ? err : new Error(String(e));
}

/** Wrap a handler so engine errors surface as HTTP errors. */
export function guarded(handler: RouteDef['handler']): RouteDef['handler'] {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (e) {
      throw toHttpError(e);
    }
  };
}

export function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `"${name}" must be a non-empty string`);
  return v;
}

export function optInt(v: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `"${name}" must be an integer between ${min} and ${max}`);
  return n;
}

export function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${name}" must be a number`);
  return v;
}
