// "Expenses": a small internal app that trusts the gateway in front of it (oauth2-proxy), the way apps behind a
// NetScaler / F5 / corporate SSO front door read the signed-in user from the headers the gateway adds. It has no
// login of its own. Runs in a node:22 container on the gateway's private network (env/sso.sh); fictional data.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const LOGOUT = process.env.LOGOUT_URL || '/oauth2/sign_out';
const expenses = new Map(); // user -> [{ id, description, amount, category, date }]
let next = 1;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(user, title, body, flash = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Expenses</title>
<style>body{font-family:sans-serif;margin:0}header{background:#123;color:#fff;padding:12px 20px;display:flex;gap:20px;align-items:center}
header a{color:#fff}main{padding:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}
.flash{background:#dfd;padding:8px 12px;margin-bottom:12px}label{display:block;margin:8px 0 2px}</style></head>
<body><header><strong>Expenses</strong><nav aria-label="Main"><a href="/">Home</a> <a href="/expenses">My expenses</a> <a href="/expenses/new">New expense</a></nav>
<span id="user">Signed in as ${esc(user.email)}</span><a href="${esc(LOGOUT)}">Sign out</a></header>
<main>${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}<h1>${esc(title)}</h1>${body}</main></body></html>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(new URLSearchParams(b)));
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return res.end('ok');
  // Only the gateway's headers say who is signed in. A request without them did not come through the gateway.
  const email = req.headers['x-forwarded-email'];
  const name = req.headers['x-forwarded-preferred-username'] || req.headers['x-forwarded-user'];
  if (!email) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('not signed in through the gateway');
  }
  const user = { email: String(email), name: String(name || email) };
  const mine = expenses.get(user.email) ?? [];
  expenses.set(user.email, mine);
  const send = (html, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  };
  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...user, expenses: mine.length }));
  }
  if (url.pathname === '/') return send(page(user, 'Home', `<p>Welcome, ${esc(user.name)}.</p><p>You have ${mine.length} expense(s).</p>`));
  if (url.pathname === '/expenses' && req.method === 'GET') {
    const rows = mine.map((e) => `<tr><td>${e.id}</td><td>${esc(e.description)}</td><td>${esc(e.category)}</td><td>${esc(e.date)}</td><td>${e.amount.toFixed(2)}</td></tr>`).join('');
    return send(page(user, 'My expenses', `<table aria-label="Expenses"><thead><tr><th>Id</th><th>Description</th><th>Category</th><th>Date</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`, url.searchParams.get('saved') ? `Expense "${url.searchParams.get('saved')}" submitted` : ''));
  }
  if (url.pathname === '/expenses/new') {
    return send(page(user, 'New expense', `<form method="post" action="/expenses">
<label for="description">Description</label><input id="description" name="description" required>
<label for="amount">Amount</label><input id="amount" name="amount" inputmode="decimal" required>
<label for="category">Category</label><select id="category" name="category"><option>Travel</option><option>Meals</option><option>Hardware</option></select>
<label for="date">Date</label><input id="date" name="date" type="date" required>
<p><button type="submit">Submit expense</button></p></form>`));
  }
  if (url.pathname === '/expenses' && req.method === 'POST') {
    const f = await readBody(req);
    const e = { id: next++, description: f.get('description') ?? '', amount: Number(f.get('amount') ?? 0), category: f.get('category') ?? '', date: f.get('date') ?? '' };
    mine.push(e);
    res.writeHead(303, { location: `/expenses?saved=${encodeURIComponent(e.description)}` });
    return res.end();
  }
  send(page(user, 'Not found', '<p>No such page.</p>'), 404);
}).listen(PORT, () => console.log(`expenses on :${PORT}`));
