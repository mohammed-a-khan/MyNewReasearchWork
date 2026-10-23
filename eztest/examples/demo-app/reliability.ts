/**
 * EZ Shop "misbehaving" pages under /rel: the failure modes automation
 * engineers fight every day, on purpose, so EZTest's reliability features can
 * be tested and measured.
 *
 *   /rel/overlay?ms=N        a cookie banner covers the Save button for N ms (N=never: stays)
 *   /rel/hydrate?ms=N        the Apply button works only after the app "hydrates" (an N ms XHR)
 *   /rel/rerender?ms=N       the form is re-rendered after an N ms XHR, wiping what was typed
 *   /rel/slow?ms=N           the total reads "Loading..." until an N ms XHR returns
 *   /rel/animate             the Confirm button slides in with a CSS transition
 *   /rel/flaky?max=N         all of the above with random delays up to N ms (timing-sensitive)
 *   /rel/session/*           a login whose session expires after ?ttl= ms (/rel/session/area)
 *   /rel/env/*               an environment that can be switched down (503) and up
 *   /rel/customers?region=   a data-dependent page (rows from the demo database)
 *   /rel/locale?lang=        amounts and dates formatted for a locale; /rel/rtl right-to-left
 *   /rel/weak                elements with generated ids next to good test ids (locator scoring)
 *
 * Random delays use ?max= (and an optional ?seed= for a repeatable sequence).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

export interface RelState {
  /** Environment switch for /rel/env/*: false = every page answers 503. */
  envUp: boolean;
  /** Session id -> expiry (ms epoch). */
  sessions: Map<string, number>;
  /** Requests served per path (tests assert retries and probes). */
  hits: Map<string, number>;
  seq: number;
  /** Keys of ?once= pages already served: the misbehaviour happens on the first visit only. */
  once: Set<string>;
}

export function newRelState(): RelState {
  return { envUp: true, sessions: new Map(), hits: new Map(), seq: 0, once: new Set() };
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, opts: { lang?: string; dir?: string; head?: string } = {}): string {
  return `<!doctype html><html lang="${esc(opts.lang ?? 'en')}"${opts.dir ? ` dir="${esc(opts.dir)}"` : ''}><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:1rem;max-width:50rem}button{padding:.4rem 1rem;margin:.3rem}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:50}
.overlay .box{background:#fff;padding:1rem;border-radius:.4rem}#panel{transition:transform .6s ease-out;transform:translateX(-120vw)}#panel.in{transform:none}</style>
${opts.head ?? ''}</head><body>${body}</body></html>`;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

/** A delay from ?ms= (fixed) or ?max= (random 0..max, optionally seeded). */
function delayOf(url: URL, name = 'ms', fallback = 0): number | 'never' {
  const v = url.searchParams.get(name);
  if (v === 'never') return 'never';
  if (v !== null) return Math.max(0, Math.min(20_000, Number(v) || 0));
  const max = Number(url.searchParams.get('max') ?? 0);
  if (max > 0) return Math.floor(Math.random() * max);
  return fallback;
}

/** In-page script: an XHR that takes `ms`, then `then` runs (static source, values are numbers). */
const after = (ms: number, then: string) => `(function(){var x=new XMLHttpRequest();x.open('GET','/rel/api/wait?ms=${ms}');x.onloadend=function(){${then}};x.send();})();`;

function overlayPage(ms: number | 'never'): string {
  const remove = ms === 'never' ? '' : `setTimeout(function(){var o=document.getElementById('cookie-banner');if(o)o.remove();}, ${ms});`;
  return page('Overlay', `<h1>Settings</h1>
<label>Display name <input id="name" value="Bob"></label>
<button id="save" data-testid="save-settings">Save</button><p id="status" role="status"></p>
<div id="cookie-banner" class="overlay cookie-consent" role="dialog" aria-label="Cookie consent"><div class="box">We use cookies to improve your experience.</div></div>
<script>document.getElementById('save').addEventListener('click',function(){document.getElementById('status').textContent='Saved';});${remove}</script>`);
}

function hydratePage(ms: number): string {
  // The button is in the HTML at once, but its handler is attached only when the app's data arrives (hydration).
  return page('Hydration', `<h1>Discounts</h1><button id="apply" data-testid="apply-discount">Apply discount</button><p id="result" role="status"></p>
<script>${after(ms, "document.getElementById('apply').addEventListener('click',function(){document.getElementById('result').textContent='Discount applied';});")}</script>`);
}

function rerenderPage(ms: number, onInput: boolean): string {
  // An SPA that renders the form twice: once at once, again (replacing the nodes) when the profile XHR returns.
  // on=input: the second render is triggered by the first keystroke (a typeahead / validation call), right after typing.
  const second = onInput
    ? `var fired=false;document.getElementById('app').addEventListener('input',function(){if(fired)return;fired=true;${after(ms, 'render();')}});`
    : after(ms, 'render();');
  return page('Re-render', `<h1>Profile</h1><div id="app"></div><p id="greeting" role="status"></p>
<script>
function render(){document.getElementById('app').innerHTML='<form onsubmit="return false"><label>Full name <input id="fullname" name="fullname"></label> <button id="greet" type="button">Greet</button></form>';
document.getElementById('greet').addEventListener('click',function(){document.getElementById('greeting').textContent='Hello, '+document.getElementById('fullname').value;});}
render();${second}
</script>`);
}

function slowPage(ms: number): string {
  return page('Slow data', `<h1>Basket</h1><p>Total: <span id="total" data-testid="basket-total">Loading...</span></p>
<script>${after(ms, "document.getElementById('total').textContent='42.50';")}</script>`);
}

function animatePage(ms: number): string {
  return page('Animation', `<h1>Checkout</h1><div id="panel" style="transition-duration:${ms}ms"><button id="confirm">Confirm</button></div><p id="done" role="status"></p>
<script>requestAnimationFrame(function(){requestAnimationFrame(function(){document.getElementById('panel').classList.add('in');});});
document.getElementById('confirm').addEventListener('click',function(){document.getElementById('done').textContent='Confirmed';});</script>`);
}

/** Everything at once with random delays: the timing-sensitive page of the flake measurement. */
function flakyPage(max: number): string {
  const r = () => Math.floor(Math.random() * max);
  const overlayMs = r();
  const hydrateMs = r();
  const rerenderMs = r();
  const totalMs = r();
  return page('Flaky checkout', `<h1>Checkout</h1>
<div id="app"></div>
<p>Total: <span id="total" data-testid="total">Loading...</span></p>
<button id="pay" data-testid="pay">Pay now</button><p id="result" role="status"></p>
<div id="busy" class="overlay spinner-overlay" aria-busy="true"><div class="box">Please wait...</div></div>
<script>
function render(){document.getElementById('app').innerHTML='<label>Card holder <input id="holder" name="holder"></label>';}
render();
${after(rerenderMs, 'render();')}
${after(totalMs, "document.getElementById('total').textContent='99.00';")}
${after(hydrateMs, "document.getElementById('pay').addEventListener('click',function(){var h=document.getElementById('holder').value;document.getElementById('result').textContent=h?('Paid by '+h):'Card holder missing';});")}
setTimeout(function(){document.getElementById('busy').remove();}, ${overlayMs});
</script>`);
}

function weakPage(): string {
  const gen = Math.random().toString(16).slice(2, 10);
  return page('Weak locators', `<h1>Order</h1>
<div class="row"><div class="col"><button id="btn-${gen}" class="css-1x2y3z" data-testid="place-order">Place order</button></div></div>
<p id="placed" role="status"></p>
<button id="deal">Bob&#39;s &quot;best&quot; deal</button>
<script>document.querySelector('[data-testid=place-order]').addEventListener('click',function(){document.getElementById('placed').textContent='Order placed';});
document.getElementById('deal').addEventListener('click',function(){document.getElementById('placed').textContent='Deal chosen';});</script>`);
}

function localePage(lang: string): string {
  return page('Locale', `<h1>Invoice</h1>
<p>Amount: <span id="amount" data-testid="amount"></span></p>
<p>Units: <span id="units" data-testid="units"></span></p>
<p>Due: <span id="due" data-testid="due"></span></p>
<p>Now: <span id="clock" data-testid="clock"></span></p>
<script>var L=${JSON.stringify(lang)}||navigator.language;
document.getElementById('amount').textContent=new Intl.NumberFormat(L,{style:'currency',currency:'EUR'}).format(1234.5);
document.getElementById('units').textContent=new Intl.NumberFormat(L).format(1234567.891);
document.getElementById('due').textContent=new Intl.DateTimeFormat(L,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(Date.UTC(2026,2,1)));
document.getElementById('clock').textContent=Intl.DateTimeFormat().resolvedOptions().timeZone+' '+new Date().getTimezoneOffset();</script>`, { lang: lang || 'en' });
}

function rtlPage(): string {
  return page('RTL', `<h1>الفاتورة</h1><p>المبلغ: <span id="amount" data-testid="amount"></span></p><button id="pay">ادفع</button>
<script>document.getElementById('amount').textContent=new Intl.NumberFormat('ar-EG',{style:'currency',currency:'EGP'}).format(1234.5);</script>`, { lang: 'ar', dir: 'rtl' });
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Handle a /rel request. Returns false when the path is not a /rel path. */
export async function handleReliability(req: IncomingMessage, res: ServerResponse, url: URL, state: RelState, db: DatabaseSync): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/rel')) return false;
  state.hits.set(path, (state.hits.get(path) ?? 0) + 1);
  // ?once=KEY: misbehave on the first visit only (a deterministic "fails, then passes on retry").
  const onceKey = url.searchParams.get('once');
  if (onceKey !== null) {
    if (state.once.has(onceKey)) {
      url.searchParams.set('ms', '0');
      url.searchParams.delete('fail');
    } else state.once.add(onceKey);
  }

  if (path === '/rel/api/wait') {
    const ms = Math.min(10_000, Number(url.searchParams.get('ms') ?? 0) || 0);
    await new Promise((r) => setTimeout(r, ms));
    send(res, 200, JSON.stringify({ waited: ms }), 'application/json');
    return true;
  }
  if (path === '/rel/overlay') return send(res, 200, overlayPage(delayOf(url, 'ms', 800))), true;
  if (path === '/rel/hydrate') return send(res, 200, hydratePage(Number(delayOf(url, 'ms', 500)))), true;
  if (path === '/rel/rerender') return send(res, 200, rerenderPage(Number(delayOf(url, 'ms', 400)), url.searchParams.get('on') === 'input')), true;
  if (path === '/rel/slow') return send(res, 200, slowPage(Number(delayOf(url, 'ms', 600)))), true;
  if (path === '/rel/animate') return send(res, 200, animatePage(Number(delayOf(url, 'ms', 600)))), true;
  if (path === '/rel/flaky') return send(res, 200, flakyPage(Math.max(1, Number(url.searchParams.get('max') ?? 800)))), true;
  if (path === '/rel/weak') return send(res, 200, weakPage()), true;
  if (path === '/rel/locale') return send(res, 200, localePage(url.searchParams.get('lang') ?? '')), true;
  if (path === '/rel/rtl') return send(res, 200, rtlPage()), true;

  // ---------------- data-dependent page
  if (path === '/rel/customers') {
    const region = url.searchParams.get('region') ?? 'EU';
    const rows = db.prepare('SELECT id, name, credit_limit FROM customers WHERE region = ? ORDER BY id').all(region) as Array<{ id: number; name: string; credit_limit: number }>;
    const body = rows.length
      ? `<table data-testid="customers"><tr><th>Name</th><th>Limit</th></tr>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.credit_limit}</td></tr>`).join('')}</table>`
      : '<p data-testid="empty">No customers</p>';
    send(res, 200, page('Customers', `<h1>Customers in ${esc(region)}</h1>${body}`));
    return true;
  }

  // ---------------- session expiry
  if (path === '/rel/session/login' && req.method === 'GET') {
    const expired = url.searchParams.get('expired') === '1';
    send(res, 200, page('Sign in', `<h1>Sign in</h1>${expired ? '<p class="err" role="alert">Your session has expired. Please sign in again.</p>' : ''}
<form method="post" action="/rel/session/login"><label>Username <input name="username"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`));
    return true;
  }
  if (path === '/rel/session/login' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    if (form.get('username') !== 'bob' || form.get('password') !== 'Builder#2') {
      send(res, 401, page('Sign in', '<p role="alert">Invalid username or password</p>'));
      return true;
    }
    const id = `s${++state.seq}${Math.random().toString(16).slice(2, 8)}`;
    const ttl = Number(url.searchParams.get('ttl') ?? cookie(req, 'relttl') ?? 600_000);
    state.sessions.set(id, Date.now() + ttl);
    res.writeHead(302, { location: '/rel/session/area', 'set-cookie': `relsid=${id}; Path=/; HttpOnly` });
    res.end();
    return true;
  }
  if (path.startsWith('/rel/session/area')) {
    const sid = cookie(req, 'relsid');
    const exp = sid ? state.sessions.get(sid) : undefined;
    if (!exp || exp < Date.now()) {
      res.writeHead(302, { location: '/rel/session/login?expired=1' });
      res.end();
      return true;
    }
    const sub = path.slice('/rel/session/area'.length) || '/';
    send(res, 200, page('Area', `<h1>Members area</h1><p data-testid="where">Section ${esc(sub)}</p><a href="/rel/session/area/reports">Reports</a> <a href="/rel/session/area/settings">Settings</a>`));
    return true;
  }
  if (path === '/rel/session/expire-all') {
    for (const k of state.sessions.keys()) state.sessions.set(k, 0);
    send(res, 200, JSON.stringify({ expired: state.sessions.size }), 'application/json');
    return true;
  }

  // ---------------- environment that can go down
  if (path === '/rel/env/switch') {
    state.envUp = url.searchParams.get('state') !== 'down';
    send(res, 200, JSON.stringify({ up: state.envUp }), 'application/json');
    return true;
  }
  if (path === '/rel/env/health') {
    send(res, state.envUp ? 200 : 503, JSON.stringify({ status: state.envUp ? 'UP' : 'DOWN' }), 'application/json');
    return true;
  }
  if (path.startsWith('/rel/env/')) {
    if (!state.envUp || url.searchParams.get('fail') === '503') {
      send(res, 503, page('Service Unavailable', '<h1>503 Service Unavailable</h1><p>The server is temporarily unable to handle the request.</p>'));
      return true;
    }
    // Downs the environment after this page (simulates an outage mid-run).
    if (url.searchParams.get('then') === 'down') state.envUp = false;
    send(res, 200, page('Env', `<h1>Environment page ${esc(path.slice('/rel/env/'.length))}</h1><button id="go">Go</button><p id="out" role="status"></p>
<script>document.getElementById('go').addEventListener('click',function(){document.getElementById('out').textContent='Went';});</script>`));
    return true;
  }
  if (path === '/rel/api/broken') {
    send(res, 503, JSON.stringify({ error: 'upstream unavailable' }), 'application/json');
    return true;
  }
  if (path === '/rel/error-page') {
    send(res, 200, page('Errors', `<h1>Report</h1><button id="run">Run report</button><p id="out"></p>
<script>document.getElementById('run').addEventListener('click',function(){console.error('ReportService failed: TypeError: cannot read total');fetch('/rel/api/broken').then(function(){document.getElementById('out').textContent='Report failed';});});</script>`));
    return true;
  }
  return false;
}
