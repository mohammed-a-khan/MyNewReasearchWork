/**
 * Minimal node:http adapter for route definitions: writes JSON, bodies and
 * SSE streams. The host must authenticate the request and parse the JSON body
 * first (the Studio server already does both for every `/api/` call).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../runs.js';
import { matchRoute, type RouteDef, type SseSink } from './types.js';

/** Handle the request if a route matches; returns false when none does. */
export async function serveRoute(routes: RouteDef[], req: IncomingMessage, res: ServerResponse, url: URL, body: Record<string, unknown>): Promise<boolean> {
  const method = req.method ?? 'GET';
  const hit = matchRoute(routes, method, url.pathname);
  if (!hit) return false;
  let out;
  try {
    out = await hit.route.handler({ method, path: url.pathname, params: hit.params, query: url.searchParams, body });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const text = JSON.stringify({ error: (e as Error).message });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  }
  if ('sse' in out) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    let ended = false;
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    let off: () => void = () => undefined;
    const sink: SseSink = {
      send(m) {
        if (ended) return false;
        return res.write(`${m.id !== undefined ? `id: ${m.id}\n` : ''}${m.event ? `event: ${m.event}\n` : ''}data: ${JSON.stringify(m.data)}\n\n`);
      },
      close() {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        off();
        res.end();
      },
    };
    off = out.sse(sink);
    if (ended) off();
    req.on('close', () => sink.close());
    return true;
  }
  if ('json' in out) {
    const text = JSON.stringify(out.json);
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
    return true;
  }
  const data = typeof out.body === 'string' ? Buffer.from(out.body, 'utf8') : out.body;
  res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType, 'Content-Length': data.length, ...(out.headers ?? {}) });
  res.end(method === 'HEAD' ? undefined : data);
  return true;
}
