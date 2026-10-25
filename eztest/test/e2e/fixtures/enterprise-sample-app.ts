/**
 * The small application the samples of `eztest init --template enterprise` are written for (their
 * README describes it): a sign-in page, an order form, an order page, POST /api/orders, a health
 * endpoint and an `orders` table in a SQLite file. Node core only (node:sqlite needs Node 22.13+).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SampleApp {
  url: string;
  orders(): Array<{ order_number: string; customer: string; quantity: number; total: string }>;
  close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><header><nav aria-label="Main"><a href="/orders">Orders</a></nav></header><main><h1>${title}</h1>${body}</main></body></html>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const c of req) s += c;
  return s;
}

export async function startSampleApp(o: { dbFile: string; username: string; password: string }): Promise<SampleApp> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(o.dbFile);
  db.exec('CREATE TABLE IF NOT EXISTS orders (order_number TEXT PRIMARY KEY, customer TEXT, quantity INTEGER, total TEXT, reference TEXT)');
  const sessions = new Set<string>();
  let next = 1000;
  const create = (customer: string, quantity: number, reference: string) => {
    const number = `ORD-${++next}`;
    const total = (quantity * 12.5).toFixed(2);
    db.prepare('INSERT INTO orders (order_number, customer, quantity, total, reference) VALUES (?, ?, ?, ?, ?)').run(number, customer, quantity, total, reference);
    return { number, total };
  };
  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const signedIn = (req.headers.cookie ?? '').split(/;\s*/).some((c) => sessions.has(c.replace(/^sid=/, '')));
    try {
      if (url.pathname === '/api/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"UP"}');
      if (url.pathname === '/api/orders' && req.method === 'POST') {
        const b = JSON.parse(await body(req)) as { customer?: string; quantity?: number; reference?: string };
        if (!b.customer || !(Number(b.quantity) > 0)) return void res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"customer and quantity are required"}');
        return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(create(b.customer, Number(b.quantity), b.reference ?? '')));
      }
      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          const f = new URLSearchParams(await body(req));
          if (f.get('username') === o.username && f.get('password') === o.password) {
            const sid = randomUUID();
            sessions.add(sid);
            return send(res, 302, '', { location: '/orders', 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
          }
          return send(res, 401, page('Sign in', '<p role="alert">Invalid username or password.</p>'));
        }
        return send(res, 200, page('Sign in', `<form method="post" action="/login">
<p><label for="u">Username</label> <input id="u" name="username" autocomplete="username"></p>
<p><label for="p">Password</label> <input id="p" name="password" type="password" autocomplete="current-password"></p>
<p><button type="submit">Sign in</button></p></form>`));
      }
      if (!signedIn) return send(res, 302, '', { location: '/login' });
      if (url.pathname === '/orders' && req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        const { number } = create(f.get('customer') ?? '', Number(f.get('quantity') ?? 0), f.get('reference') ?? '');
        return send(res, 303, '', { location: `/orders/${number}` });
      }
      if (url.pathname === '/orders') return send(res, 200, page('Orders', '<p><a href="/orders/new">New order</a></p>'));
      if (url.pathname === '/orders/new') {
        return send(res, 200, page('New order', `<form method="post" action="/orders">
<p><label for="c">Customer</label> <input id="c" name="customer" required></p>
<p><label for="r">Your reference</label> <input id="r" name="reference"></p>
<p><label for="q">Quantity</label> <input id="q" name="quantity" type="number" min="1" required></p>
<p><button type="submit" data-testid="place-order">Place order</button></p></form>`));
      }
      const m = /^\/orders\/(ORD-\d+)$/.exec(url.pathname);
      if (m) {
        const row = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(m[1]) as { customer: string; total: string } | undefined;
        if (!row) return send(res, 404, page('Not found', '<p>No such order.</p>'));
        return send(res, 200, page(`Order ${m[1]}`, `<p>Order <span data-testid="order-number">${m[1]}</span> created for ${esc(row.customer)}.</p>
<p>Total: <span data-testid="order-total">${row.total}</span></p>`));
      }
      return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
    } catch (e) {
      send(res, 500, page('Error', `<p>${esc((e as Error).message)}</p>`));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    orders: () => db.prepare('SELECT order_number, customer, quantity, total FROM orders ORDER BY order_number').all() as Array<{ order_number: string; customer: string; quantity: number; total: string }>,
    close: () => new Promise<void>((r) => server.close(() => { db.close(); r(); })),
  };
}
