/**
 * EZ Shop lab pages for targeting, time and the shared element repository:
 *
 *   /lab/relative   repeated labels and buttons: relative and scoped targets
 *                   ("the field below Email inside the Billing section",
 *                   "the Edit button in the row containing Bob", "the 2nd Delete button")
 *   /lab/clock      a clock, a New Year banner, a session timer, performance.now and
 *                   requestAnimationFrame counters: the controllable browser clock
 *   /lab/checkout   a "Place order" button (?v=b renames it to "Submit order" with new
 *                   ids): one repository element used by several journeys
 *   /lab/summary    an "Order summary" region for aria snapshot assertions (?v=b renames a button)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:1rem;max-width:60rem}
.grid{display:grid;grid-template-columns:7rem 14rem 7rem 14rem;gap:.4rem 1rem;align-items:center}
section{border:1px solid #ccc;padding:.5rem;margin:.5rem 0}td,th{border:1px solid #999;padding:.2rem .5rem}
#banner{display:none;background:#ffd;padding:.5rem}.far{margin-left:30rem}</style></head><body>${body}</body></html>`;
}

const fields = (prefix: string) => `<div class="grid">
  <span>Email</span><span></span><span>Phone</span><span></span>
  <input id="${prefix}-email"><span></span><input id="${prefix}-phone"><span></span>
  <span>Qty</span><input id="${prefix}-qty" type="number"><span>Ref</span><input id="${prefix}-ref">
</div>`;

const ROWS = ['Alice', 'Bob', 'Acme'];

/** ?v=b renames the Customers table to Clients (a container anchor that heals). */
const relative = (v: string) => page('Relative targets', `<h1>Relative targets</h1>
<section id="billing"><h2>Billing</h2>${fields('billing')}</section>
<section id="shipping"><h2>Shipping</h2>${fields('shipping')}</section>
<table aria-label="${v === 'b' ? 'Clients' : 'Customers'}"><thead><tr><th>Customer</th><th>Actions</th></tr></thead><tbody>
${ROWS.map((n) => `<tr><td>${n}</td><td><button onclick="act('Editing ${n}')">Edit</button> <button onclick="act('Deleted ${n}')">Delete</button></td></tr>`).join('\n')}
</tbody></table>
<p><span>Total</span> <button onclick="act('Recalculated near total')">Recalculate</button> <button class="far" onclick="act('Recalculated far away')">Recalculate</button></p>
<p id="result" role="status">Nothing yet</p>
<script>function act(t) { document.getElementById('result').textContent = t; }</script>`);

const CLOCK = page('Clock lab', `<h1>Clock lab</h1>
<p>Now: <span id="now"></span></p>
<p>Date: <span id="date"></span></p>
<p id="banner" role="status">Happy new year <span id="year"></span></p>
<p><button id="start" onclick="startSession()">Start session</button> <span id="session" role="status">No session</span></p>
<p><button id="measure" onclick="measure()">Measure</button> <span id="elapsed">-</span></p>
<p>Frames: <span id="frames">0</span></p>
<script>
var startYear = new Date().getFullYear();
function pad(n) { return String(n).padStart(2, '0'); }
function tick() {
  var d = new Date();
  document.getElementById('now').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  document.getElementById('date').textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  if (d.getFullYear() > startYear) { document.getElementById('banner').style.display = 'block'; document.getElementById('year').textContent = d.getFullYear(); }
}
tick();
setInterval(tick, 1000);
function startSession() {
  document.getElementById('session').textContent = 'Session active';
  setTimeout(function () { document.getElementById('session').textContent = 'Session expired'; }, 2 * 60 * 60 * 1000);
}
var t0 = performance.now();
function measure() { document.getElementById('elapsed').textContent = Math.round((performance.now() - t0) / 1000) + ' s'; }
var frames = 0;
function frame() { frames++; document.getElementById('frames').textContent = String(frames); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
</script>`);

function checkout(variant: string): string {
  const b = variant === 'b';
  return page('Checkout', `<h1>Checkout</h1>
<p>Basket: 2 items, total 39.98</p>
<p><button id="${b ? 'submit-order-v2' : 'place-order'}" class="btn-primary" onclick="document.getElementById('msg').textContent = 'Order placed'">${b ? 'Submit order' : 'Place order'}</button></p>
<p><button onclick="document.getElementById('msg').textContent = 'Basket emptied'">Empty basket</button></p>
<p id="msg" role="status"></p>`);
}

function summary(variant: string): string {
  const b = variant === 'b';
  return page('Order summary', `<h1>Your order</h1>
<section aria-label="Order summary"><h2>Order summary</h2>
<ul aria-label="Lines"><li>Widget x 2</li><li>Gadget x 1</li></ul>
<p>Total: 89.48</p>
<button>${b ? 'Pay now' : 'Confirm order'}</button> <a href="/lab/relative">Change</a>
</section>`);
}

/** Handle a targeting lab request; false when the path is not one of these pages. */
export function handleTargeting(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET') return false;
  const v = url.searchParams.get('v') ?? 'a';
  let html: string | undefined;
  switch (url.pathname) {
    case '/lab/relative': html = relative(v); break;
    case '/lab/clock': html = CLOCK; break;
    case '/lab/checkout': html = checkout(v); break;
    case '/lab/summary': html = summary(v); break;
    default: return false;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}
