import { request } from 'node:http';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLE = fileURLToPath(new URL('../../examples/shop-project', import.meta.url));

export async function copyShopProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-studio-'));
  await cp(EXAMPLE, dir, { recursive: true });
  return dir;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any;
}

/** Low-level HTTP request (lets tests forge Host/Origin headers). */
export function raw(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: {
          host: `127.0.0.1:${port}`,
          ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function client(port: number, token: string) {
  const call = (method: string, path: string, body?: unknown) =>
    raw(port, path, {
      method,
      headers: { 'x-eztest-token': token, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    });
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string, b?: unknown) => call('DELETE', p, b),
  };
}

export interface SseEvent {
  type: string;
  [k: string]: any;
}

/** Read an SSE stream until an event satisfies `until` (or the stream ends). */
export function readSse(port: number, path: string, token: string, until: (e: SseEvent) => boolean, timeoutMs = 120_000): Promise<SseEvent[]> {
  return new Promise((resolvePromise, reject) => {
    const events: SseEvent[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE timeout; got ${events.map((e) => e.type).join(',')}`));
    }, timeoutMs);
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`SSE status ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          const e = JSON.parse(data) as SseEvent;
          events.push(e);
          if (until(e)) {
            clearTimeout(timer);
            req.destroy();
            resolvePromise(events);
            return;
          }
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolvePromise(events);
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

export const SHOP_ENV_KEYS = ['SHOP_URL', 'SHOP_DB', 'SHOP_ALICE_PASSWORD', 'SHOP_ALICE_TOTP', 'SHOP_BOB_PASSWORD', 'SHOP_API_CLIENT_SECRET'];
