/**
 * EZ Shop: a small app under test used by EZTest's own integration tests and demos.
 *
 * Covers: login with TOTP MFA, session cookies, a dashboard grid, an order
 * form, an order confirmation page, a PDF invoice download, a JSON API with
 * OAuth client-credentials, and a SQLite database.
 *
 * Modes (env or query string) let tests exercise EZTest features:
 *   DEMO_VARIANT=b  -> renamed ids/classes/text (drives self-healing)
 *   DEMO_BUG=invoice-total -> the PDF invoice total is wrong (drives triage and three-way reconciliation)
 *   DEMO_BUG=save-silently-fails -> the order form shows no confirmation (a real regression healing must not hide)
 *   DEMO_BUG=api-contract -> GET /api/orders/{id} drops the required "created_by" field (drives OpenAPI conformance checks)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachLabWebSocket, handleLab, newLabState } from './lab.js';
import { handleEntra, newEntraState, type EntraState } from './entra.js';
import { handleReliability, newRelState, type RelState } from './reliability.js';
import { handleChat, newChatState, type ChatState } from './chat.js';

export interface DemoOptions {
  port?: number;
  variant?: 'a' | 'b';
  bug?: 'none' | 'invoice-total' | 'save-silently-fails' | 'api-contract';
  totpSecretBase32?: string;
  /** SQLite file path (default in-memory). A file lets external tools (EZTest db steps) see the same data. */
  dbFile?: string;
  /** SMTP port for the lab sign-up email (e.g. an EZTest SmtpSink). */
  smtpPort?: number;
  /** Called with domain events (topic "orders": order.created), e.g. to publish them to a message broker. */
  onEvent?: (topic: string, event: Record<string, unknown>) => void | Promise<void>;
}

export const DEMO_USERS = {
  alice: { password: 'Wonderland#1', role: 'sales-rep', mfa: true },
  bob: { password: 'Builder#2', role: 'manager', mfa: false },
};
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
export const DEMO_CLIENT = { id: 'ez-client', secret: 'ez-client-secret' };

// ------------------------------------------------------------------ TOTP (RFC 6238)
function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
function totpValid(secret: string, code: string): boolean {
  const c = Math.floor(Date.now() / 30000);
  return [c - 1, c, c + 1].some((x) => totpAt(secret, x) === code);
}

// ------------------------------------------------------------------ data
export const PRODUCTS = [
  { sku: 'SKU-100', name: 'Widget', price: 19.99 },
  { sku: 'SKU-200', name: 'Gadget', price: 49.5 },
  { sku: 'SKU-300', name: 'Doohickey', price: 5.25 },
];

function seed(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, credit_limit REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, created_by TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_lines (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL);
  `);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO customers (name, region, credit_limit) VALUES (?, ?, ?)');
    ins.run('Contoso Ltd', 'EU', 25000);
    ins.run('Fabrikam Inc', 'US', 5000);
    ins.run('Northwind Traders', 'EU', 12000);
  }
}

// ------------------------------------------------------------------ html helpers
const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - EZ Shop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:56rem}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.3rem .6rem}
.toast{background:#e6ffed;border:1px solid #2da44e;padding:.5rem;margin:.5rem 0}.err{background:#ffebe9;border:1px solid #cf222e;padding:.5rem}</style>
</head><body><header><nav aria-label="Main"><a href="/dashboard">Dashboard</a> | <a href="/orders/new">New order</a> | <a href="/logout">Sign out</a></nav></header>
<main>${body}</main></body></html>`;
}

// ------------------------------------------------------------------ server
export interface DemoServer {
  url: string;
  db: DatabaseSync;
  /** Mock Microsoft Entra sign-in state (/entra/...). */
  entra: EntraState;
  /** State of the misbehaving /rel pages (environment switch, sessions, hit counts). */
  rel: RelState;
  /** The /chat room (multi-actor journeys). */
  chat: ChatState;
  close(): Promise<void>;
  options: Required<Omit<DemoOptions, 'onEvent'>> & Pick<DemoOptions, 'onEvent'>;
  /** Show a notification on an order's page (e.g. a reply consumed from a message broker). */
  notify(orderNumber: string, text: string): void;
}

export async function startDemoApp(opts: DemoOptions = {}): Promise<DemoServer> {
  const options: DemoServer['options'] = {
    port: opts.port ?? 0,
    variant: opts.variant ?? ((process.env.DEMO_VARIANT as 'a' | 'b') || 'a'),
    bug: opts.bug ?? ((process.env.DEMO_BUG as DemoOptions['bug']) || 'none'),
    totpSecretBase32: opts.totpSecretBase32 ?? DEMO_TOTP_SECRET,
    dbFile: opts.dbFile ?? ':memory:',
    smtpPort: opts.smtpPort ?? (Number(process.env.DEMO_SMTP_PORT) || 0),
    onEvent: opts.onEvent,
  };
  const notifications = new Map<string, string[]>();
  const db = new DatabaseSync(options.dbFile);
  seed(db);
  const sessions = new Map<string, { user: string; mfaPending: boolean }>();
  const lab = newLabState();
  const entra = newEntraState();
  const rel = newRelState();
  const chat = newChatState();
  let boundPort = 0;
  const baseUrl = () => `http://127.0.0.1:${boundPort}`;
  const apiTokens = new Map<string, number>();

  const V = options.variant === 'b'
    ? { loginBtnId: 'signin-button', loginText: 'Log in', userLabel: 'Email or username', submitOrderText: 'Place order', submitOrderId: 'place-order', gridClass: 'orders-table-v2' }
    : { loginBtnId: 'login-btn', loginText: 'Sign in', userLabel: 'Username', submitOrderText: 'Submit order', submitOrderId: 'submit-order', gridClass: 'orders-table' };

  function sessionOf(req: IncomingMessage) {
    const m = /(?:^|;\s*)ezsid=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
    return m ? { id: m[1], s: sessions.get(m[1]) } : undefined;
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(body);
  }
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string> = {}) => {
    res.writeHead(302, { location: to, ...extra });
    res.end();
  };

  function orderWithLines(id: number) {
    const order = db.prepare('SELECT o.*, c.name AS customer FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(id) as
      | { id: number; customer: string; total: number; status: string; created_by: string; created_at: string }
      | undefined;
    if (!order) return undefined;
    const lines = db.prepare('SELECT sku, name, qty, unit_price, line_total FROM order_lines WHERE order_id = ? ORDER BY id').all(id) as Array<{
      sku: string; name: string; qty: number; unit_price: number; line_total: number;
    }>;
    return { order, lines };
  }

  async function invoicePdf(id: number): Promise<Uint8Array | undefined> {
    const data = orderWithLines(id);
    if (!data) return undefined;
    const { order, lines } = data;
    const pdf = await PDFDocument.create();
    pdf.setTitle(`Invoice INV-${order.id}`);
    pdf.setAuthor('EZ Shop');
    const p = pdf.addPage([595, 842]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let y = 790;
    const t = (s: string, x: number, f = font, size = 11) => p.drawText(s, { x, y, size, font: f });
    t('EZ Shop - Invoice', 50, bold, 18); y -= 30;
    t('Invoice No:', 50); t(`INV-${order.id}`, 160); y -= 18;
    t('Customer:', 50); t(order.customer, 160); y -= 18;
    t('Date:', 50); t(order.created_at.slice(0, 10), 160); y -= 30;
    t('SKU', 50, bold); t('Item', 140, bold); t('Qty', 300, bold); t('Unit Price', 360, bold); t('Line Total', 460, bold); y -= 18;
    for (const l of lines) {
      t(l.sku, 50); t(l.name, 140); t(String(l.qty), 300); t(l.unit_price.toFixed(2), 360); t(l.line_total.toFixed(2), 460); y -= 16;
    }
    y -= 10;
    const total = options.bug === 'invoice-total' ? order.total + 10 : order.total;
    t('Total:', 360, bold); t(total.toFixed(2), 460, bold);
    return pdf.save();
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const sess = sessionOf(req);

      // ---------------- public lab pages (advanced automation: tabs, frames, dialogs, events, ...)
      if (await handleLab(req, res, url, baseUrl(), { smtpPort: options.smtpPort || undefined }, lab)) return;
      // ---------------- misbehaving pages for reliability tests (/rel/...)
      if (await handleReliability(req, res, url, rel, db)) return;
      // ---------------- a two-user chat for multi-actor journeys (/chat/...)
      if (await handleChat(req, res, url, chat)) return;

      // ---------------- JSON API
      if (path === '/api/token' && req.method === 'POST') {
        const body = new URLSearchParams(await readBody(req));
        if (body.get('grant_type') !== 'client_credentials' || body.get('client_id') !== DEMO_CLIENT.id || body.get('client_secret') !== DEMO_CLIENT.secret) {
          return send(res, 401, JSON.stringify({ error: 'invalid_client' }), 'application/json');
        }
        const tok = randomBytes(16).toString('hex');
        apiTokens.set(tok, Date.now() + 3600_000);
        return send(res, 200, JSON.stringify({ access_token: tok, token_type: 'Bearer', expires_in: 3600 }), 'application/json');
      }
      // Public price quote (JSON in, JSON out; no auth): used by the API importer tests.
      if (path === '/api/public/quote' && req.method === 'POST') {
        let q: { sku?: unknown; qty?: unknown };
        try {
          q = JSON.parse(await readBody(req)) as typeof q;
        } catch {
          return send(res, 400, JSON.stringify({ error: 'invalid_json' }), 'application/json');
        }
        const product = PRODUCTS.find((p) => p.sku === q.sku);
        const qty = Number(q.qty);
        if (!product || !Number.isInteger(qty) || qty < 1) return send(res, 400, JSON.stringify({ error: 'invalid_quote', warnings: ['unknown sku or quantity'] }), 'application/json');
        const total = Math.round(product.price * qty * 100) / 100;
        return send(res, 200, JSON.stringify({ sku: product.sku, name: product.name, qty, total: total.toFixed(2), currency: 'USD', warnings: null }), 'application/json');
      }
      if (path.startsWith('/api/')) {
        const auth = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '');
        if (!auth || (apiTokens.get(auth[1]) ?? 0) < Date.now()) return send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
        if (path === '/api/orders' && req.method === 'GET') {
          const rows = db.prepare('SELECT o.id, c.name AS customer, o.status, o.total FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id').all();
          return send(res, 200, JSON.stringify(rows), 'application/json');
        }
        const m = /^\/api\/orders\/(\d+)$/.exec(path);
        if (m && req.method === 'GET') {
          const d = orderWithLines(Number(m[1]));
          if (d && options.bug === 'api-contract') {
            const { created_by: _dropped, ...rest } = d.order;
            return send(res, 200, JSON.stringify({ ...rest, lines: d.lines }), 'application/json');
          }
          return d ? send(res, 200, JSON.stringify({ ...d.order, lines: d.lines }), 'application/json') : send(res, 404, JSON.stringify({ error: 'not_found' }), 'application/json');
        }
        if (path === '/api/customers' && req.method === 'GET') {
          return send(res, 200, JSON.stringify(db.prepare('SELECT * FROM customers ORDER BY id').all()), 'application/json');
        }
        return send(res, 404, JSON.stringify({ error: 'not_found' }), 'application/json');
      }

      // ---------------- mock Microsoft Entra sign-in (/entra/...)
      if (await handleEntra(req, res, url, {
        users: DEMO_USERS,
        totpValid: (code) => totpValid(options.totpSecretBase32, code),
        createSession: (user) => {
          const sid = randomBytes(16).toString('hex');
          sessions.set(sid, { user, mfaPending: false });
          return `ezsid=${sid}; HttpOnly; Path=/; SameSite=Lax`;
        },
      }, entra)) return;

      // ---------------- auth pages
      if (path === '/') return redirect(res, '/login');
      if (path === '/login' && req.method === 'GET') {
        const err = url.searchParams.get('error');
        return send(res, 200, page('Sign in', `<h1>Sign in to EZ Shop</h1>${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
<form method="post" action="/login" id="login-form">
<p><label for="username">${V.userLabel}</label> <input id="username" name="username" autocomplete="username" data-testid="username"></p>
<p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password" data-testid="password"></p>
<p><button id="${V.loginBtnId}" class="btn primary" type="submit">${V.loginText}</button></p></form>`));
      }
      if (path === '/login' && req.method === 'POST') {
        const b = new URLSearchParams(await readBody(req));
        const user = b.get('username') ?? '';
        const u = DEMO_USERS[user as keyof typeof DEMO_USERS];
        if (!u || u.password !== b.get('password')) return redirect(res, '/login?error=' + encodeURIComponent('Invalid username or password'));
        const sid = randomBytes(16).toString('hex');
        sessions.set(sid, { user, mfaPending: u.mfa });
        return redirect(res, u.mfa ? '/mfa' : '/dashboard', { 'set-cookie': `ezsid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
      }
      if (path === '/mfa' && req.method === 'GET') {
        if (!sess?.s) return redirect(res, '/login');
        return send(res, 200, page('Verify', `<h1>Two-step verification</h1>${url.searchParams.get('error') ? '<div class="err" role="alert">Invalid code</div>' : ''}
<form method="post" action="/mfa"><p><label for="otp">Authenticator code</label> <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code"></p>
<p><button type="submit">Verify</button></p></form>`));
      }
      if (path === '/mfa' && req.method === 'POST') {
        if (!sess?.s) return redirect(res, '/login');
        const b = new URLSearchParams(await readBody(req));
        if (!totpValid(options.totpSecretBase32, b.get('otp') ?? '')) return redirect(res, '/mfa?error=1');
        sess.s.mfaPending = false;
        return redirect(res, '/dashboard');
      }
      if (path === '/logout') {
        if (sess) sessions.delete(sess.id);
        return redirect(res, '/login', { 'set-cookie': 'ezsid=; Max-Age=0; Path=/' });
      }

      // ---------------- authenticated pages
      if (!sess?.s || sess.s.mfaPending) return redirect(res, '/login');
      const user = sess.s.user;

      if (path === '/dashboard') {
        const rows = db.prepare('SELECT o.id, c.name AS customer, o.status, o.total FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC').all() as Array<{ id: number; customer: string; status: string; total: number }>;
        const body = `<h1>Dashboard</h1><p>Welcome, <strong data-testid="welcome-user">${esc(user)}</strong></p>
<p><a href="/orders/new" class="btn">New order</a></p>
<h2>Recent orders</h2>
<table class="${V.gridClass}" aria-label="Recent orders"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/orders/${r.id}">ORD-${r.id}</a></td><td>${esc(r.customer)}</td><td>${esc(r.status)}</td><td>${r.total.toFixed(2)}</td></tr>`).join('')}
</tbody></table>${rows.length === 0 ? '<p>No orders yet.</p>' : ''}`;
        return send(res, 200, page('Dashboard', body));
      }
      if (path === '/orders/new' && req.method === 'GET') {
        const customers = db.prepare('SELECT id, name FROM customers ORDER BY id').all() as Array<{ id: number; name: string }>;
        return send(res, 200, page('New order', `<h1>New order</h1>
<form method="post" action="/orders/new" id="order-form">
<p><label for="customer">Customer</label> <select id="customer" name="customer">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></p>
<p><label for="product">Product</label> <select id="product" name="product">${PRODUCTS.map((p) => `<option value="${p.sku}">${esc(p.name)} (${p.price.toFixed(2)})</option>`).join('')}</select></p>
<p><label for="qty">Quantity</label> <input id="qty" name="qty" type="number" min="1" value="1"></p>
<p><button id="${V.submitOrderId}" type="submit">${V.submitOrderText}</button></p></form>`));
      }
      if (path === '/orders/new' && req.method === 'POST') {
        const b = new URLSearchParams(await readBody(req));
        const product = PRODUCTS.find((p) => p.sku === b.get('product'));
        const qty = Math.max(1, Number(b.get('qty') ?? 1) || 1);
        const customerId = Number(b.get('customer'));
        if (!product || !customerId) return send(res, 400, page('Error', '<div class="err" role="alert">Invalid order</div>'));
        if (options.bug === 'save-silently-fails') return redirect(res, '/orders/new');
        const lineTotal = Math.round(product.price * qty * 100) / 100;
        const info = db.prepare('INSERT INTO orders (customer_id, created_by, status, total, created_at) VALUES (?, ?, ?, ?, ?)').run(customerId, user, 'Submitted', lineTotal, new Date().toISOString());
        const orderId = Number(info.lastInsertRowid);
        db.prepare('INSERT INTO order_lines (order_id, sku, name, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)').run(orderId, product.sku, product.name, qty, product.price, lineTotal);
        await options.onEvent?.('orders', { type: 'order.created', orderId, orderNumber: `ORD-${orderId}`, customerId, sku: product.sku, qty, total: lineTotal, createdBy: user, createdAt: new Date().toISOString() });
        return redirect(res, `/orders/${orderId}?created=1`);
      }
      const om = /^\/orders\/(\d+)$/.exec(path);
      if (om) {
        const d = orderWithLines(Number(om[1]));
        if (!d) return send(res, 404, page('Not found', '<h1>Order not found</h1>'));
        const { order, lines } = d;
        return send(res, 200, page(`Order ORD-${order.id}`, `${url.searchParams.get('created') ? `<div class="toast" role="status">Order ORD-${order.id} created</div>` : ''}${url.searchParams.get('cancelled') ? `<div class="toast" role="status">Order ORD-${order.id} cancelled</div>` : ''}
<h1>Order <span data-testid="order-number">ORD-${order.id}</span></h1>
<dl><dt>Customer</dt><dd data-testid="order-customer">${esc(order.customer)}</dd><dt>Status</dt><dd data-testid="order-status">${esc(order.status)}</dd>
<dt>Total</dt><dd data-testid="order-total">${order.total.toFixed(2)}</dd></dl>
<table aria-label="Order lines"><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr></thead><tbody>
${lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td>${l.qty}</td><td>${l.unit_price.toFixed(2)}</td><td>${l.line_total.toFixed(2)}</td></tr>`).join('')}</tbody></table>
<p><a id="download-invoice" href="/orders/${order.id}/invoice.pdf" download="INV-${order.id}.pdf">Download invoice</a></p>
${order.status !== 'Cancelled' ? `<form method="post" action="/orders/${order.id}/cancel"><button type="submit" id="cancel-order">Cancel order</button></form>` : ''}
${(notifications.get(`ORD-${order.id}`) ?? []).length ? `<ul aria-label="Notifications">${(notifications.get(`ORD-${order.id}`) ?? []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`));
      }
      const cm = /^\/orders\/(\d+)\/cancel$/.exec(path);
      if (cm && req.method === 'POST') {
        db.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ?").run(Number(cm[1]));
        return redirect(res, `/orders/${cm[1]}?cancelled=1`);
      }
      const im = /^\/orders\/(\d+)\/invoice\.pdf$/.exec(path);
      if (im) {
        const bytes = await invoicePdf(Number(im[1]));
        if (!bytes) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, bytes, 'application/pdf', { 'content-disposition': `attachment; filename="INV-${im[1]}.pdf"` });
      }
      return send(res, 404, page('Not found', '<h1>Page not found</h1>'));
    } catch (e) {
      send(res, 500, page('Error', `<div class="err">Internal error</div>`));
      console.error(e);
    }
  });

  attachLabWebSocket(server);
  await new Promise<void>((r) => server.listen(options.port, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : options.port;
  boundPort = port;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    entra,
    rel,
    chat,
    options,
    notify: (orderNumber, text) => notifications.set(orderNumber, [...(notifications.get(orderNumber) ?? []), text]),
    close: () => new Promise<void>((r) => server.close(() => { db.close(); r(); })),
  };
}

/**
 * The database file the standalone demo app uses (`npm run demo`): DEMO_DB, else examples/demo-app/shop.db.
 * The example projects (examples/shop-project, examples/bdd-project) default SHOP_DB to the same file, so their
 * database steps read the data the app writes. (startDemoApp() without dbFile, as the tests use it, is in memory.)
 */
export function demoDbFile(env: Record<string, string | undefined> = process.env): string {
  return env.DEMO_DB || fileURLToPath(new URL('./shop.db', import.meta.url));
}

// Allow `tsx examples/demo-app/server.ts` to run it standalone.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const port = Number(process.env.PORT ?? 4600);
  const dbFile = demoDbFile();
  startDemoApp({ port, dbFile }).then((s) => console.log(`EZ Shop running at ${s.url} (variant=${s.options.variant}, bug=${s.options.bug}, database ${dbFile})`));
}
