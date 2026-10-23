/**
 * Load Shop: a small app with every dynamic value a load script must
 * correlate, used by EZTest Load's tests and docs (examples/load-shop).
 *
 * - GET  /login            form with a per-session CSRF token (hidden input) and a session cookie
 * - POST /login            username/password + csrf -> 302 /orders/new (403 on a wrong token)
 * - GET  /orders/new       form with a fresh CSRF token and an ASP.NET-style __VIEWSTATE
 * - POST /orders/new       csrf + __VIEWSTATE + sku/qty -> 302 /orders/<id>
 * - GET  /orders/<id>      "Order ORD-<id> created" (only for the order's owner)
 * - POST /api/token        OAuth client credentials -> access_token
 * - GET  /api/orders/<id>  bearer token -> JSON
 * - GET  /slow?ms=N        answers after N ms (latency fixtures)
 *
 * Users: user1..user500 with password "pw-<n>".
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

export interface LoadShop {
  url: string;
  stats: { logins: number; orders: number; rejectedCsrf: number; rejectedViewState: number; requests: number };
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Load Shop</title></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export async function startLoadShop(o: { port?: number } = {}): Promise<LoadShop> {
  const secret = randomBytes(16);
  const sessions = new Map<string, { user?: string; csrf: string }>();
  const orders = new Map<number, { user: string; sku: string; qty: number }>();
  const tokens = new Set<string>();
  let seq = 1000;
  const stats = { logins: 0, orders: 0, rejectedCsrf: 0, rejectedViewState: 0, requests: 0 };
  const viewState = (sid: string) => createHmac('sha256', secret).update(`vs|${sid}`).digest('base64');

  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };
  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  };
  const session = (req: IncomingMessage) => {
    const m = /(?:^|;\s*)shopsid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
    return m ? { id: m[1], s: sessions.get(m[1]) } : undefined;
  };
  const newSession = () => {
    const id = randomBytes(12).toString('hex');
    const s = { csrf: randomBytes(18).toString('base64url') };
    sessions.set(id, s);
    return { id, s };
  };

  const server = createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (p === '/slow') {
        const ms = Math.max(0, Math.min(60_000, Number(url.searchParams.get('ms') ?? 0)));
        setTimeout(() => send(res, 200, JSON.stringify({ ms }), 'application/json'), ms);
        return;
      }
      if (p === '/api/token' && req.method === 'POST') {
        const b = await read(req);
        if (b.get('client_id') !== 'shop-client' || b.get('client_secret') !== 'shop-secret') return send(res, 401, '{"error":"invalid_client"}', 'application/json');
        const t = randomBytes(16).toString('hex');
        tokens.add(t);
        return send(res, 200, JSON.stringify({ access_token: t, token_type: 'Bearer', expires_in: 600 }), 'application/json');
      }
      const am = /^\/api\/orders\/(\d+)$/.exec(p);
      if (am) {
        const t = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!t || !tokens.has(t)) return send(res, 401, '{"error":"unauthorized"}', 'application/json');
        const ord = orders.get(Number(am[1]));
        return ord ? send(res, 200, JSON.stringify({ id: Number(am[1]), ...ord }), 'application/json') : send(res, 404, '{"error":"not_found"}', 'application/json');
      }
      if (p === '/favicon.ico') return send(res, 404, '', 'text/plain');
      if (p === '/' || (p === '/login' && req.method === 'GET')) {
        const existing = session(req);
        const { id, s } = existing?.s && !existing.s.user ? { id: existing.id, s: existing.s } : newSession();
        return send(res, 200, page('Sign in', `<form method="post" action="/login"><input type="hidden" name="csrf_token" value="${s.csrf}">
<label for="u">Username</label> <input id="u" name="username"> <label for="pw">Password</label> <input id="pw" name="password" type="password"> <button type="submit">Sign in</button></form>`), 'text/html; charset=utf-8', { 'set-cookie': `shopsid=${id}; Path=/; HttpOnly` });
      }
      if (p === '/login' && req.method === 'POST') {
        const sess = session(req);
        const b = await read(req);
        if (!sess?.s || b.get('csrf_token') !== sess.s.csrf) {
          stats.rejectedCsrf++;
          return send(res, 403, page('Forbidden', '<p>Invalid CSRF token</p>'));
        }
        const user = b.get('username') ?? '';
        const n = /^user(\d+)$/.exec(user)?.[1];
        if (!n || b.get('password') !== `pw-${n}`) return send(res, 401, page('Sign in failed', '<p>Wrong username or password</p>'));
        sess.s.user = user;
        sess.s.csrf = randomBytes(18).toString('base64url');
        stats.logins++;
        res.writeHead(302, { location: '/orders/new' });
        return res.end();
      }
      const sess = session(req);
      if (!sess?.s?.user) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      if (p === '/orders/new' && req.method === 'GET') {
        sess.s.csrf = randomBytes(18).toString('base64url');
        return send(res, 200, page('New order', `<form method="post" action="/orders/new" id="order">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${viewState(sess.id)}" />
<input type="hidden" name="csrf_token" value="${sess.s.csrf}">
<label for="sku">Product</label> <select id="sku" name="sku"><option value="SKU-1">Widget</option><option value="SKU-2">Gadget</option></select>
<label for="qty">Quantity</label> <input id="qty" name="qty" value="1"> <button type="submit">Place order</button></form>`));
      }
      if (p === '/orders/new' && req.method === 'POST') {
        const b = await read(req);
        if (b.get('csrf_token') !== sess.s.csrf) {
          stats.rejectedCsrf++;
          return send(res, 403, page('Forbidden', '<p>Invalid CSRF token</p>'));
        }
        if (b.get('__VIEWSTATE') !== viewState(sess.id)) {
          stats.rejectedViewState++;
          return send(res, 400, page('Error', '<p>Invalid view state</p>'));
        }
        const id = ++seq;
        orders.set(id, { user: sess.s.user!, sku: b.get('sku') ?? 'SKU-1', qty: Number(b.get('qty') ?? 1) || 1 });
        sess.s.csrf = randomBytes(18).toString('base64url');
        stats.orders++;
        res.writeHead(302, { location: `/orders/${id}` });
        return res.end();
      }
      const om = /^\/orders\/(\d+)$/.exec(p);
      if (om) {
        const ord = orders.get(Number(om[1]));
        if (!ord || ord.user !== sess.s.user) return send(res, 404, page('Not found', '<p>No such order</p>'));
        return send(res, 200, page(`Order ORD-${om[1]}`, `<p role="status">Order ORD-${om[1]} created</p><p>${esc(ord.sku)} x ${ord.qty}</p>`));
      }
      if (p === '/logout') {
        sessions.delete(sess.id);
        res.writeHead(302, { location: '/login', 'set-cookie': 'shopsid=; Max-Age=0; Path=/' });
        return res.end();
      }
      return send(res, 404, page('Not found', ''));
    } catch {
      send(res, 500, page('Error', ''));
    }
  });
  server.keepAliveTimeout = 30_000;
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('load-shop/server.ts')) {
  startLoadShop({ port: Number(process.env.PORT ?? 4700) }).then((s) => console.log(`Load Shop running at ${s.url}`));
}
