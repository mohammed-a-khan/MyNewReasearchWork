/**
 * Route types bound to the Studio's services, plus the adapter that mounts
 * framework-agnostic `RouteDef`s (routes/types.ts: debug, trace, ...) in the
 * same registry, so they get the same authentication, body parsing and errors.
 */
import type { Route, RouteContext } from '../router.js';
import type { StudioApp } from '../app.js';
import type { RouteDef, SseSink } from './types.js';

export type StudioRoute = Route<StudioApp>;
export type StudioRouteContext = RouteContext<StudioApp>;

/** Mount `RouteDef`s (handler returns `{json}`, `{body,contentType}` or `{sse}`) as Studio routes. */
export function fromRouteDefs(defs: RouteDef[]): StudioRoute[] {
  return defs.map((def) => ({
    method: def.method,
    path: def.path,
    async handler({ req, res, url, method, params, query, body }) {
      const out = await def.handler({ method, path: url.pathname, params, query, body });
      if ('sse' in out) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        let ended = false;
        let off: () => void = () => undefined;
        const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
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
        return;
      }
      if ('json' in out) {
        const text = JSON.stringify(out.json);
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
        return;
      }
      const data = typeof out.body === 'string' ? Buffer.from(out.body, 'utf8') : out.body;
      res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType, 'Content-Length': data.length, ...(out.headers ?? {}) });
      res.end(method === 'HEAD' ? undefined : data);
    },
  }));
}
