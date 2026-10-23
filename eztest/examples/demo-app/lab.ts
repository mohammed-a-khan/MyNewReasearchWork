/**
 * EZ Shop "lab": public pages that exercise EZTest's advanced automation:
 * tabs and popups, nested iframes, dialogs, drag and drop (mouse and HTML5),
 * a context menu, keyboard shortcuts, shadow DOM, an infinite list, a
 * sortable table, DOM events, console errors, network calls, WebSockets,
 * browser state, uploads and downloads, touch gestures, GraphQL, SOAP, HTTP
 * basic auth and email sent into an SMTP sink.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { sendSmtpMail } from '../../src/messaging/providers.js';
import { handleTargeting } from './targeting.js';

export interface LabOptions {
  /** SMTP port the sign-up page sends mail to (an EZTest SmtpSink). */
  smtpPort?: number;
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:1rem;max-width:60rem}.col{display:inline-block;vertical-align:top;width:12rem;min-height:6rem;border:1px dashed #888;margin:.5rem;padding:.5rem}
.card{background:#eef;border:1px solid #99c;padding:.3rem;margin:.2rem;cursor:grab}.active{font-weight:bold}td,th{border:1px solid #999;padding:.2rem .5rem}
#menu{position:absolute;display:none;background:#fff;border:1px solid #333;list-style:none;padding:.2rem}#palette{display:none;border:2px solid #333;padding:.5rem}
#pad{width:300px;height:150px;background:#ddd}#swipe-area{width:300px;height:120px;background:#cdf}#knob{position:relative;left:0;width:30px;height:30px;background:#c33;cursor:pointer}
.red{color:rgb(200, 0, 0)}</style>${head}</head><body>${body}</body></html>`;
}

const PRODUCTS = [
  { name: 'Widget', price: 19.99 }, { name: 'Gadget', price: 49.5 }, { name: 'Doohickey', price: 5.25 }, { name: 'Thingamajig', price: 12 },
];
const ORDERS = [{ id: 1, customer: 'Contoso Ltd', status: 'Shipped' }, { id: 2, customer: 'Fabrikam Inc', status: 'Open' }, { id: 3, customer: 'Northwind Traders', status: 'Open' }];

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(body);
}
const json = (res: ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) => send(res, status, JSON.stringify(v), 'application/json', extra);

const PAGES: Record<string, () => string> = {
  '/lab': () => page('Lab', `<h1>EZ Shop lab</h1><ul>${['tabs', 'frames', 'dialogs', 'dnd', 'menu', 'keys', 'shadow', 'list', 'table', 'events', 'state', 'upload', 'form', 'touch', 'mail', 'relative', 'clock', 'checkout', 'summary']
    .map((p) => `<li><a href="/lab/${p}">${p}</a></li>`).join('')}</ul>`),

  // ------------------------------------------------------------------ tabs, windows, popups
  '/lab/tabs': () => page('Tabs lab', `<h1>Tabs lab</h1>
<p><a href="/lab/report" target="_blank" id="open-report">Open report</a></p>
<p><button id="open-popup" onclick="window.open('/lab/popup', 'helpPopup', 'width=420,height=320')">Open help popup</button></p>
<p><button onclick="setTimeout(function () { window.open('/lab/report?late=1', '_blank'); }, 300)">Open report later</button></p>
<p id="popup-result">No message yet</p>`),
  '/lab/report': () => page('Quarterly report', `<h1>Quarterly report</h1><p id="total">Total: 42</p><button onclick="window.close()">Close report</button>`),
  '/lab/popup': () => page('Help popup', `<h1>Help</h1><p>Need assistance?</p>
<button onclick="window.opener.document.getElementById('popup-result').textContent = 'Popup says hi'; window.close();">Send back</button>
<button onmousedown="window.opener.document.getElementById('popup-result').textContent = 'Closed early'; window.close();">Close now</button>`),

  // ------------------------------------------------------------------ frames
  '/lab/frames': () => page('Frames lab', `<h1>Checkout</h1>
<iframe name="payment" title="Payment form" src="/lab/frame/payment" width="520" height="320"></iframe>
<p id="status">Waiting for payment</p>
<script>window.addEventListener('message', function (e) { document.getElementById('status').textContent = String(e.data); });</script>`),
  '/lab/frame/payment': () => page('Payment', `<h2>Payment</h2><p><label for="card">Card number</label> <input id="card" autocomplete="off"></p>
<button onclick="parent.postMessage('Paid with card ending ' + document.getElementById('card').value.slice(-4), '*')">Pay now</button>
<iframe name="verify" id="verify-frame" title="Verification" src="/lab/frame/verify" width="400" height="150"></iframe>`),
  '/lab/frame/verify': () => page('Verify', `<h3>3-D Secure</h3><button onclick="document.getElementById('v').textContent = 'Verified'">Verify</button><p id="v"></p>`),

  // ------------------------------------------------------------------ dialogs
  '/lab/dialogs': () => page('Dialogs lab', `<h1>Dialogs lab</h1>
<button onclick="alert('Order saved')">Show alert</button>
<button onclick="document.getElementById('confirm-result').textContent = confirm('Delete the order?') ? 'Deleted' : 'Kept'">Delete order</button>
<button onclick="var n = prompt('Your name?', 'guest'); document.getElementById('prompt-result').textContent = n === null ? 'No name' : 'Hello ' + n">Enter name</button>
<p id="confirm-result">-</p><p id="prompt-result">-</p>
<p><label><input type="checkbox" id="guard" onchange="window.onbeforeunload = this.checked ? function (e) { e.preventDefault(); e.returnValue = ''; return ''; } : null"> Warn before leaving</label></p>`),

  // ------------------------------------------------------------------ drag and drop
  '/lab/dnd': () => page('Drag lab', `<h1>Drag and drop</h1>
<div class="col" id="todo" role="region" aria-label="To do column" ondragover="event.preventDefault()" ondrop="dropCard(event, 'To do')"><h3>To do</h3>
<div class="card" draggable="true" id="card-a" ondragstart="event.dataTransfer.setData('text/plain', this.id)">Task A</div>
<div class="card" draggable="true" id="card-b" ondragstart="event.dataTransfer.setData('text/plain', this.id)">Task B</div></div>
<div class="col" id="done" role="region" aria-label="Done column" ondragover="event.preventDefault()" ondrop="dropCard(event, 'Done')"><h3>Done</h3></div>
<p id="dnd-status">Nothing moved</p>
<h2>Sortable (mouse)</h2><ul id="sortable" aria-label="Priority list"><li data-v="Alpha">Alpha</li><li data-v="Bravo">Bravo</li><li data-v="Charlie">Charlie</li></ul>
<p id="order">Alpha, Bravo, Charlie</p>
<h2>Slider</h2><div id="track" style="width:400px;background:#eee"><div id="knob" aria-label="Volume knob" role="slider"></div></div><p id="slider-value">0</p>
<h2>Upload by dropping</h2><div id="dropzone" class="col" role="region" aria-label="Drop zone">Drop files here</div><p id="dropped">No files</p>
<script>
function dropCard(e, col) {
  e.preventDefault();
  var id = e.dataTransfer.getData('text/plain');
  var el = document.getElementById(id);
  e.currentTarget.appendChild(el);
  document.getElementById('dnd-status').textContent = el.textContent + ' moved to ' + col;
}
var dragging = null;
document.querySelectorAll('#sortable li').forEach(function (li) {
  li.addEventListener('mousedown', function (e) { dragging = li; e.preventDefault(); });
  li.addEventListener('mouseup', function () {
    if (dragging && dragging !== li) li.parentNode.insertBefore(dragging, li);
    dragging = null;
    document.getElementById('order').textContent = Array.from(document.querySelectorAll('#sortable li')).map(function (x) { return x.dataset.v; }).join(', ');
  });
});
var knob = document.getElementById('knob'), down = false, startX = 0, startLeft = 0;
knob.addEventListener('mousedown', function (e) { down = true; startX = e.clientX; startLeft = parseInt(knob.style.left || '0', 10); e.preventDefault(); });
document.addEventListener('mousemove', function (e) { if (!down) return; var v = Math.max(0, Math.min(370, startLeft + e.clientX - startX)); knob.style.left = v + 'px'; document.getElementById('slider-value').textContent = String(Math.round(v)); });
document.addEventListener('mouseup', function () { down = false; });
var dz = document.getElementById('dropzone');
dz.addEventListener('dragover', function (e) { e.preventDefault(); });
dz.addEventListener('drop', function (e) { e.preventDefault(); document.getElementById('dropped').textContent = Array.from(e.dataTransfer.files).map(function (f) { return f.name + ' (' + f.size + ' bytes)'; }).join(', '); });
</script>`),

  // ------------------------------------------------------------------ mouse: context menu, modifiers, offsets
  '/lab/menu': () => page('Mouse lab', `<h1>Mouse lab</h1>
<p><span id="file-item" class="card">Report.pdf</span></p>
<ul id="menu" role="menu" aria-label="File menu"><li role="menuitem" onclick="act('Renamed')">Rename</li><li role="menuitem" onclick="act('Deleted')">Delete</li></ul>
<p id="menu-status">-</p>
<p><a href="#docs" id="docs-link" onauxclick="if (event.button === 1) { event.preventDefault(); document.getElementById('aux').textContent = 'middle click'; }">Docs</a> <span id="aux">-</span></p>
<p><button id="mod-target" onclick="document.getElementById('mods').textContent = ['shift','ctrl','alt','meta'].filter(function (k) { return event[k + 'Key']; }).join('+') || 'none'">Modifier target</button> <span id="mods">-</span></p>
<div id="pad" role="region" aria-label="Drawing pad" onclick="document.getElementById('xy').textContent = 'x=' + event.offsetX + ' y=' + event.offsetY"></div><p id="xy">-</p>
<p><button id="multi" onclick="document.getElementById('clicks').textContent = 'clicks=' + event.detail">Multi click</button> <span id="clicks">-</span></p>
<p><span id="hover-me" onmouseenter="document.getElementById('tip').hidden = false">Hover me</span> <span id="tip" hidden>Tooltip text</span></p>
<p><span id="press-area" class="card" onmousedown="document.getElementById('mouse-state').textContent = 'down'" onmouseup="document.getElementById('mouse-state').textContent = 'up'">Press area</span> <span id="mouse-state">-</span></p>
<p><label for="focus-me">Focus me</label> <input id="focus-me" onfocus="document.getElementById('focus-state').textContent = 'focused'" onblur="document.getElementById('focus-state').textContent = 'blurred'"> <span id="focus-state">-</span></p>
<script>
var item = document.getElementById('file-item'), menu = document.getElementById('menu');
item.addEventListener('contextmenu', function (e) { e.preventDefault(); menu.style.display = 'block'; menu.style.left = e.pageX + 'px'; menu.style.top = e.pageY + 'px'; });
function act(t) { document.getElementById('menu-status').textContent = t; menu.style.display = 'none'; }
</script>`),

  // ------------------------------------------------------------------ keyboard
  '/lab/keys': () => page('Keyboard lab', `<h1>Keyboard lab</h1>
<div id="palette" role="dialog" aria-label="Command palette"><label for="cmd">Command</label> <input id="cmd"></div>
<p>Last key: <span id="last-key">-</span></p><p>Shift: <span id="shift">up</span></p>
<p><label for="search">Search</label> <input id="search" oninput="document.getElementById('input-count').textContent = String(Number(document.getElementById('input-count').textContent) + 1)"> inputs: <span id="input-count">0</span></p>
<p><label for="notes">Notes</label> <textarea id="notes"></textarea></p>
<script>
document.addEventListener('keydown', function (e) {
  var parts = [];
  if (e.ctrlKey) parts.push('Control'); if (e.metaKey) parts.push('Meta'); if (e.altKey) parts.push('Alt'); if (e.shiftKey && e.key !== 'Shift') parts.push('Shift');
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  document.getElementById('last-key').textContent = parts.join('+');
  if (e.key === 'Shift') document.getElementById('shift').textContent = 'down';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('palette').style.display = 'block'; document.getElementById('cmd').focus(); }
  if (e.key === 'Escape') document.getElementById('palette').style.display = 'none';
});
document.addEventListener('keyup', function (e) { if (e.key === 'Shift') document.getElementById('shift').textContent = 'up'; });
</script>`),

  // ------------------------------------------------------------------ shadow DOM
  '/lab/shadow': () => page('Shadow lab', `<h1>Shadow DOM</h1><ez-coupon></ez-coupon>
<script>
customElements.define('ez-coupon', class extends HTMLElement {
  connectedCallback() {
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="code">Coupon</label> <input id="code"> <button id="apply">Apply coupon</button> <p class="result" data-testid="coupon-result">No coupon</p>';
    root.getElementById('apply').addEventListener('click', function () { root.querySelector('.result').textContent = 'Applied ' + root.getElementById('code').value; });
  }
});
</script>`),

  // ------------------------------------------------------------------ infinite list
  '/lab/list': () => page('Infinite list', `<h1>Feed</h1><ul id="feed" aria-label="Feed"></ul><p id="loading">Loading more...</p>
<script>
var n = 0;
function more() { var ul = document.getElementById('feed'); for (var i = 0; i < 20 && n < 200; i++) { n++; var li = document.createElement('li'); li.textContent = 'Item ' + n; li.style.height = '40px'; ul.appendChild(li); } if (n >= 200) document.getElementById('loading').textContent = 'End of feed'; }
more();
window.addEventListener('scroll', function () { if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 100) setTimeout(more, 50); });
</script>`),

  // ------------------------------------------------------------------ sortable table
  '/lab/table': () => page('Table lab', `<h1>Products</h1>
<table aria-label="Products"><thead><tr><th><button id="sort-name">Name</button></th><th><button id="sort-price">Price</button></th></tr></thead><tbody>
${PRODUCTS.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.price.toFixed(2)}</td></tr>`).join('')}</tbody></table>
<script>
function sortBy(col, numeric) {
  var tb = document.querySelector('tbody'), rows = Array.from(tb.rows);
  var dir = tb.dataset.col === String(col) && tb.dataset.dir === 'asc' ? 'desc' : 'asc';
  rows.sort(function (a, b) { var x = a.cells[col].textContent, y = b.cells[col].textContent; var r = numeric ? Number(x) - Number(y) : x.localeCompare(y); return dir === 'asc' ? r : -r; });
  rows.forEach(function (r) { tb.appendChild(r); }); tb.dataset.col = String(col); tb.dataset.dir = dir;
}
document.getElementById('sort-name').onclick = function () { sortBy(0, false); };
document.getElementById('sort-price').onclick = function () { sortBy(1, true); };
</script>`),

  // ------------------------------------------------------------------ events, console, network, websocket
  '/lab/events': () => page('Events lab', `<h1>Events lab</h1>
<p><label for="qty">Quantity</label> <input id="qty" value="1"> <span id="changed">-</span></p>
<p><button onclick="setTimeout(function () { window.dispatchEvent(new CustomEvent('cart-updated', { detail: { count: 3 } })); }, 300)">Update cart later</button> <span id="cart">-</span></p>
<p><button onclick="console.error('Boom: something failed')">Log error</button> <button onclick="setTimeout(function () { throw new Error('Unhandled kaboom'); })">Throw</button> <button onclick="console.warn('Careful')">Warn</button></p>
<p><button onclick="fetch('/lab/api/orders').then(function (r) { return r.json(); }).then(function (d) { document.getElementById('orders').textContent = d.length + ' orders'; }).catch(function () { document.getElementById('orders').textContent = 'Failed to load'; })">Load orders</button> <span id="orders">-</span></p>
<p><button onclick="fetch('/lab/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace': 'abc123' }, body: JSON.stringify({ qty: 2, product: 'Gadget' }) }).then(function (r) { return r.json(); }).then(function (d) { document.getElementById('saved').textContent = 'Saved #' + d.id; })">Save order</button> <span id="saved">-</span></p>
<p><button onclick="fetch('/lab/api/slow?ms=800').then(function (r) { return r.json(); }).then(function (d) { document.getElementById('slow').textContent = d.message; })">Load slowly</button> <span id="slow">-</span></p>
<p><img id="logo" alt="Logo" src="/lab/logo.svg" width="20"></p>
<p><button onclick="var ws = new WebSocket(location.origin.replace('http', 'ws') + '/lab/ws'); ws.onopen = function () { ws.send('ping'); }; ws.onmessage = function (e) { document.getElementById('chat').textContent = e.data; }">Connect chat</button> <span id="chat">-</span></p>
<p>Ticker: <span id="ticker">waiting</span> <button onclick="setTimeout(function () { document.getElementById('ticker').textContent = 'updated at ' + Date.now(); }, 400)">Tick</button></p>
<p><button id="late" disabled>Ready soon</button> <span id="spinner" role="status">Loading</span></p>
<script>
document.getElementById('qty').addEventListener('change', function () { document.getElementById('changed').textContent = 'Changed to ' + this.value; });
document.getElementById('qty').addEventListener('custom-ping', function (e) { document.getElementById('changed').textContent = 'Pinged ' + JSON.stringify(e.detail); });
window.addEventListener('cart-updated', function (e) { document.getElementById('cart').textContent = 'Cart has ' + e.detail.count; });
setTimeout(function () { document.getElementById('late').disabled = false; }, 700);
setTimeout(function () { document.getElementById('spinner').remove(); }, 600);
</script>`),

  // ------------------------------------------------------------------ browser state
  '/lab/state': () => page('State lab', `<h1>Browser state</h1>
<p>Cookies: <span id="cookies"></span></p><p>Cart: <span id="cart"></span></p>
<p>Timezone: <span id="tz"></span></p><p>Locale: <span id="locale"></span></p><p>Scheme: <span id="scheme"></span></p><p>Motion: <span id="motion"></span></p>
<p>UA: <span id="ua"></span></p><p>Viewport: <span id="vp"></span></p><p>Online: <span id="online"></span></p>
<p><button onclick="navigator.geolocation.getCurrentPosition(function (p) { document.getElementById('geo').textContent = p.coords.latitude.toFixed(2) + ',' + p.coords.longitude.toFixed(2); }, function (e) { document.getElementById('geo').textContent = 'denied'; })">Locate me</button> <span id="geo">-</span></p>
<p><button onclick="navigator.clipboard.readText().then(function (t) { document.getElementById('pasted').textContent = t; })">Paste from clipboard</button> <span id="pasted">-</span></p>
<p><button onclick="navigator.clipboard.writeText('COPIED-123')">Copy code</button></p>
<p><button onclick="document.cookie = 'consent=yes; path=/'; localStorage.setItem('seen', 'true'); render()">Accept cookies</button></p>
<script>
function render() {
  document.getElementById('cookies').textContent = document.cookie || '(none)';
  document.getElementById('cart').textContent = localStorage.getItem('cart') || '(empty)';
  document.getElementById('tz').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('locale').textContent = Intl.DateTimeFormat().resolvedOptions().locale;
  document.getElementById('scheme').textContent = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.getElementById('motion').textContent = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full';
  document.getElementById('ua').textContent = navigator.userAgent;
  document.getElementById('vp').textContent = innerWidth + 'x' + innerHeight;
  document.getElementById('online').textContent = String(navigator.onLine);
}
render();
</script>`),

  // ------------------------------------------------------------------ uploads and downloads
  '/lab/upload': () => page('Upload lab', `<h1>Files</h1>
<p><label for="files">Attachments</label> <input id="files" type="file" multiple onchange="document.getElementById('names').textContent = Array.from(this.files).map(function (f) { return f.name; }).join(', ')"></p>
<p id="names">No files</p>
<p><a href="/lab/files/report.csv" download>Download CSV report</a> <a href="/lab/files/data.json" download>Download JSON data</a></p>`),

  // ------------------------------------------------------------------ element states, attributes, CSS
  '/lab/form': () => page('Form lab', `<h1>Form lab</h1>
<p><label for="name">Name</label> <input id="name" name="name" placeholder="Your name" data-kind="person"></p>
<p><label for="locked">Locked</label> <input id="locked" disabled value="fixed"></p>
<p><label for="ro">Reference</label> <input id="ro" readonly value="REF-1"></p>
<p><label><input type="checkbox" id="terms"> Accept terms</label></p>
<p><span id="badge" class="badge active red">Premium</span></p>
<p><a id="help" href="/lab/help" title="Get help" aria-expanded="false">Help</a></p>
<p><button id="save" disabled>Save</button></p>
<p id="empty-box"></p>
<div style="height:3000px"></div><p id="footer">Footer text</p>
<script>document.getElementById('name').addEventListener('input', function () { document.getElementById('save').disabled = !this.value; });</script>`),

  // ------------------------------------------------------------------ touch
  '/lab/touch': () => page('Touch lab', `<h1>Touch lab</h1>
<button id="tap-target" ontouchend="document.getElementById('touch-state').textContent = 'Tapped'">Menu</button> <span id="touch-state">-</span>
<div id="swipe-area" role="region" aria-label="Carousel">Swipe me</div><p id="swipe-state">-</p>
<script>
var sx = 0, sy = 0, area = document.getElementById('swipe-area');
area.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; });
area.addEventListener('touchend', function (e) {
  var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
  document.getElementById('swipe-state').textContent = 'Swiped ' + (Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'));
});
</script>`),

  // ------------------------------------------------------------------ email
  '/lab/mail': () => page('Sign up', `<h1>Sign up</h1><form method="post" action="/lab/mail"><p><label for="email">Email</label> <input id="email" name="email"></p>
<p><button type="submit">Sign up</button></p></form>`),
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#36c"/></svg>';

/** Handle a lab request. Returns false when the path is not a lab path. */
export async function handleLab(req: IncomingMessage, res: ServerResponse, url: URL, base: string, opts: LabOptions, state: LabState): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/lab') && path !== '/graphql' && path !== '/soap') return false;
  if (handleTargeting(req, res, url)) return true;
  if (req.method === 'GET' && PAGES[path]) {
    send(res, 200, PAGES[path]());
    return true;
  }
  if (path === '/lab/logo.svg') return send(res, 200, SVG, 'image/svg+xml'), true;
  if (path === '/lab/help') return send(res, 200, page('Help', '<h1>Help</h1>')), true;
  if (path === '/lab/files/report.csv') return send(res, 200, 'id,name\n1,Widget\n2,Gadget\n', 'text/csv', { 'content-disposition': 'attachment; filename="report.csv"' }), true;
  if (path === '/lab/files/data.json') return send(res, 200, JSON.stringify({ ok: true, items: [1, 2, 3] }), 'application/json', { 'content-disposition': 'attachment; filename="data.json"' }), true;

  // ---------------- JSON APIs used by the lab pages and API steps
  if (path === '/lab/api/orders' && req.method === 'GET') return json(res, 200, ORDERS), true;
  if (path === '/lab/api/orders' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    return json(res, 201, { id: 100 + ++state.created, ...body }, { 'x-request-id': `req-${state.created}` }), true;
  }
  if (path === '/lab/api/slow') {
    const ms = Math.min(5000, Number(url.searchParams.get('ms') ?? 1000));
    await new Promise((r) => setTimeout(r, ms));
    return json(res, 200, { message: `Done after ${ms} ms` }), true;
  }
  const job = /^\/lab\/api\/jobs\/(\w+)$/.exec(path);
  if (job) {
    const n = (state.jobs.get(job[1]) ?? 0) + 1;
    state.jobs.set(job[1], n);
    return json(res, 200, { id: job[1], status: n >= 3 ? 'done' : 'pending', polls: n }), true;
  }
  if (path === '/lab/api/echo') {
    const raw = await readBody(req);
    const ct = req.headers['content-type'] ?? '';
    let body: unknown = raw.toString('utf8');
    if (ct.includes('json') && raw.length) body = JSON.parse(raw.toString('utf8'));
    else if (ct.includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    else if (ct.includes('multipart/form-data')) {
      const text = raw.toString('latin1');
      const fields: Record<string, string> = {};
      for (const m of text.matchAll(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) {
        fields[m[1]] = m[2] ? `file:${m[2]}:${Buffer.byteLength(m[3], 'latin1')}` : m[3];
      }
      body = fields;
    }
    return json(res, 200, { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body }), true;
  }
  if (path === '/lab/api/error') return json(res, 500, { error: 'boom' }), true;

  // ---------------- GraphQL (tiny, for tests)
  if (path === '/graphql' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)).toString('utf8')) as { query: string; variables?: Record<string, unknown> };
    if (/boom/.test(b.query)) return json(res, 200, { data: null, errors: [{ message: 'Boom field failed', path: ['boom'] }] }), true;
    if (/mutation/.test(b.query) && /createNote/.test(b.query)) return json(res, 200, { data: { createNote: { id: 7, title: b.variables?.title ?? null } } }), true;
    if (/orders/.test(b.query)) return json(res, 200, { data: { orders: ORDERS.map((o) => ({ id: o.id, status: o.status })) } }), true;
    return json(res, 200, { data: null, errors: [{ message: 'Unknown query' }] }), true;
  }
  // ---------------- SOAP (tiny, for tests)
  if (path === '/soap' && req.method === 'POST') {
    const xml = (await readBody(req)).toString('utf8');
    const env = (inner: string) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
    if (/Fail/.test(xml)) return send(res, 500, env('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Order service unavailable</faultstring></soap:Fault>'), 'text/xml'), true;
    const id = /<Id>(\d+)<\/Id>/.exec(xml)?.[1] ?? '0';
    const o = ORDERS.find((x) => String(x.id) === id);
    return send(res, 200, env(`<GetOrderResponse><Id>${id}</Id><Status>${o?.status ?? 'Unknown'}</Status><Customer>${o?.customer ?? ''}</Customer></GetOrderResponse>`), 'text/xml'), true;
  }

  // ---------------- basic auth
  if (path === '/lab/basic') {
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const [u, p] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
    if (u !== 'admin' || p !== 's3cret') return send(res, 401, 'Unauthorized', 'text/plain', { 'www-authenticate': 'Basic realm="lab"' }), true;
    return send(res, 200, page('Admin area', '<h1>Admin area</h1><p>Welcome, admin</p>')), true;
  }

  // ---------------- email sign-up into the SMTP sink
  if (path === '/lab/mail' && req.method === 'POST') {
    const email = new URLSearchParams((await readBody(req)).toString('utf8')).get('email') ?? '';
    const code = String(100000 + (state.created++ * 7919) % 900000);
    const link = `${base}/lab/verify?token=tok${code}`;
    if (!opts.smtpPort) return send(res, 503, page('Error', '<p role="alert">Mail is not configured</p>')), true;
    await sendSmtpMail({
      port: opts.smtpPort, from: 'noreply@ezshop.test', to: email, subject: 'Welcome to EZ Shop',
      text: `Hello!\nYour verification code is ${code}.\nConfirm your address: ${link}\n`,
      html: `<p>Hello!</p><p>Your verification code is <b>${code}</b>.</p><p><a href="${link}">Confirm your address</a></p>`,
    });
    state.codes.set(`tok${code}`, email);
    return send(res, 200, page('Check your inbox', `<h1>Check your inbox</h1><p>We sent a link to ${esc(email)}</p>`)), true;
  }
  if (path === '/lab/verify') {
    const who = state.codes.get(url.searchParams.get('token') ?? '');
    return send(res, who ? 200 : 400, page('Verify', who ? `<h1>Email verified</h1><p>${esc(who)} is confirmed</p>` : '<h1>Invalid link</h1>')), true;
  }
  send(res, 404, page('Not found', '<h1>Lab page not found</h1>'));
  return true;
}

export interface LabState {
  created: number;
  jobs: Map<string, number>;
  codes: Map<string, string>;
}

export function newLabState(): LabState {
  return { created: 0, jobs: new Map(), codes: new Map() };
}

// ------------------------------------------------------------------ minimal WebSocket server (RFC 6455, text frames)

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x81;
    b[1] = 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    return b;
  })();
  return Buffer.concat([head, payload]);
}

/** Echo WebSocket at /lab/ws: "welcome" on connect, "pong" for "ping", "echo: <text>" otherwise. */
export function attachLabWebSocket(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (!(req.url ?? '').startsWith('/lab/ws')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wsFrame('welcome'));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1] & 0x80) !== 0;
        const total = off + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        const mask = masked ? buf.subarray(off, off + 4) : undefined;
        const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), total));
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(total);
        if (op === 0x8) {
          socket.write(Buffer.from([0x88, 0]));
          socket.end();
          return;
        }
        if (op === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
          continue;
        }
        if (op === 0x1) {
          const text = data.toString('utf8');
          socket.write(wsFrame(text === 'ping' ? 'pong' : `echo: ${text}`));
        }
      }
    });
    socket.on('error', () => undefined);
  });
}
