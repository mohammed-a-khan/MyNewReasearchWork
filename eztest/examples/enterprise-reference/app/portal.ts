/**
 * "MyCover", the Larkspur customer portal: server-rendered sign-in with TOTP
 * MFA, then a single-page app (public/portal.js) over a small JSON backend
 * (/bff). Also serves the declaration iframe and the coverage-guide popup.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { claimJson } from './api.ts';
import { hashPassword, type Row } from './db.ts';
import { cookie, esc, HttpError, json, parseMultipart, readBody, readForm, readJson, redirect, send, setCookie } from './http.ts';
import type { Services, Upload } from './services.ts';
import { ROOT, settings } from './settings.ts';
import { statementPdf } from './statement.ts';
import { totpValid } from './totp.ts';

interface Session {
  customerId: string;
  mfa: 'pending' | 'done';
  csrf: string;
  expires: number;
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'",
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Larkspur MyCover</title><link rel="stylesheet" href="/static/portal.css"></head>
<body><header class="brand"><span class="logo" aria-hidden="true">L</span><span>Larkspur Mutual</span><span class="product">MyCover</span></header>
<main id="main">${body}</main></body></html>`;

export function startPortal(svc: Services, port: number, host: string): Server {
  const sessions = new Map<string, Session>();
  const asset = (name: string) => readFileSync(join(ROOT, 'app', 'public', name));

  const sessionOf = (req: IncomingMessage): Session | undefined => {
    const id = cookie(req, 'lk_portal');
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.expires < Date.now()) return undefined;
    s.expires = Date.now() + 30 * 60_000;
    return s;
  };
  const customerOf = (req: IncomingMessage): Row => {
    const s = sessionOf(req);
    if (!s || s.mfa !== 'done') throw new HttpError(401, 'sign in first', 'unauthorized');
    return svc.customer(s.customerId)!;
  };
  const csrfCheck = (req: IncomingMessage) => {
    const s = sessionOf(req)!;
    if (req.headers['x-csrf-token'] !== s.csrf) throw new HttpError(403, 'missing or wrong CSRF token', 'csrf');
  };

  const loginPage = (error?: string, next = '') =>
    layout(
      'Sign in',
      `<section class="card narrow"><h1>Sign in to MyCover</h1>
${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/login" novalidate>
<input type="hidden" name="next" value="${esc(next)}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit" class="primary">Sign in</button>
</form><p class="hint">Test system. Data on this site is invented.</p></section>`,
    );

  const verifyPage = (error?: string) =>
    layout(
      'Verify sign-in',
      `<section class="card narrow"><h1>Two-step verification</h1>
<p>Enter the 6-digit code from your authenticator app.</p>
${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/login/verify" novalidate>
<label for="otp">Authentication code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
<button type="submit" class="primary">Verify</button>
</form></section>`,
    );

  const coveragePage = (product: string) => {
    const rows =
      product === 'MOTOR'
        ? [['Collision', 'Market value of the vehicle', '750.00'], ['Glass', 'Repair or replacement', '0.00'], ['Theft', 'Market value of the vehicle', '750.00']]
        : [['Water damage', 'Up to the sum insured', '500.00'], ['Fire', 'Up to the sum insured', '500.00'], ['Theft', 'Up to 50,000.00', '500.00'], ['Storm', 'Up to the sum insured', '500.00'], ['Glass', 'Up to 5,000.00', '0.00']];
    return layout(
      'Coverage guide',
      `<section class="card"><h1>Coverage guide: ${product === 'MOTOR' ? 'Motor' : 'Home'} insurance</h1>
<table aria-label="Coverage limits"><thead><tr><th>Cover</th><th>Limit</th><th>Standard excess</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>
<p>Claims must be reported within 30 days of the incident.</p>
<button type="button" id="close-guide">Close guide</button></section><script src="/static/popup.js"></script>`,
    );
  };

  const declarationPage = () =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Declaration</title><link rel="stylesheet" href="/static/portal.css"></head>
<body class="frame"><h2>Declaration</h2>
<p>I declare that the information in this claim is true and complete to the best of my knowledge. I understand that a false or exaggerated claim may be refused and reported.</p>
<label class="inline"><input type="checkbox" id="declare"> I agree to the declaration</label>
<button type="button" id="confirm-declaration" disabled>Confirm declaration</button>
<p id="declaration-state" role="status"></p>
<script src="/static/declaration.js"></script></body></html>`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const html = (status: number, body: string, headers: Record<string, string> = {}) => send(res, status, body, 'text/html; charset=utf-8', { ...SECURITY_HEADERS, ...headers });

    if (path.startsWith('/static/')) {
      const name = path.slice('/static/'.length);
      if (!/^[\w.-]+\.(js|css)$/.test(name)) throw new HttpError(404, 'not found');
      return send(res, 200, asset(name), name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', { 'cache-control': 'no-cache' });
    }
    if (path === '/health') return json(res, 200, { status: 'UP', app: 'portal', variant: settings.variant });
    if (path === '/') return redirect(res, '/app/home');
    if (path === '/help/coverage') return html(200, coveragePage(String(url.searchParams.get('product') ?? 'HOME').toUpperCase()));
    if (path === '/frames/declaration') return html(200, declarationPage());

    // ---------------------------------------------------------------- sign-in
    if (path === '/login' && method === 'GET') return html(200, loginPage(undefined, url.searchParams.get('next') ?? ''));
    if (path === '/login' && method === 'POST') {
      const f = await readForm(req);
      const c = svc.db.prepare('SELECT * FROM customers WHERE username = ?').get(String(f.get('username') ?? '').trim()) as Row | undefined;
      if (!c || c.password_hash !== hashPassword(String(f.get('password') ?? ''))) return html(401, loginPage('Incorrect username or password.', f.get('next') ?? ''));
      const id = randomBytes(18).toString('hex');
      sessions.set(id, { customerId: String(c.id), mfa: c.totp_secret ? 'pending' : 'done', csrf: randomBytes(12).toString('hex'), expires: Date.now() + 30 * 60_000 });
      const next = /^\/app\//.test(f.get('next') ?? '') ? f.get('next')! : '/app/home';
      return redirect(res, c.totp_secret ? `/login/verify?next=${encodeURIComponent(next)}` : next, { 'set-cookie': setCookie('lk_portal', id) });
    }
    if (path === '/login/verify') {
      const id = cookie(req, 'lk_portal');
      const s = id ? sessions.get(id) : undefined;
      if (!s) return redirect(res, '/login');
      if (method === 'GET') return html(200, verifyPage());
      const f = await readForm(req);
      const c = svc.customer(s.customerId)!;
      const secret = (svc.db.prepare('SELECT totp_secret FROM customers WHERE id = ?').get(c.id as string) as Row).totp_secret as string;
      if (!totpValid(secret, String(f.get('otp') ?? ''))) return html(401, verifyPage('That code is not valid. Try the current code from your app.'));
      s.mfa = 'done';
      const next = url.searchParams.get('next');
      return redirect(res, next && /^\/app\//.test(next) ? next : '/app/home');
    }
    if (path === '/logout') {
      const id = cookie(req, 'lk_portal');
      if (id) sessions.delete(id);
      return redirect(res, '/login', { 'set-cookie': setCookie('lk_portal', '', { maxAge: 0 }) });
    }

    // ---------------------------------------------------------------- the SPA shell
    if (path === '/app' || path.startsWith('/app/')) {
      const s = sessionOf(req);
      if (!s || s.mfa !== 'done') return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`);
      return html(
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyCover - Larkspur Mutual</title><link rel="stylesheet" href="/static/portal.css"><meta name="csrf-token" content="${s.csrf}"><meta name="ui-variant" content="${settings.variant}"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="brand"><span class="logo" aria-hidden="true">L</span><span>Larkspur Mutual</span><span class="product">MyCover</span>
<nav aria-label="Main"><a href="/app/home" data-link>Home</a><a href="/app/quote" data-link>Get a quote</a><a href="/app/claims/new" data-link>Make a claim</a><a href="/app/claims" data-link>My claims</a><a href="/logout">Sign out</a></nav></header>
<div id="toast" role="status" aria-live="polite"></div>
<main id="main" tabindex="-1"><p class="loading" aria-busy="true">Loading...</p></main>
<script src="/static/portal.js"></script></body></html>`,
      );
    }

    // ---------------------------------------------------------------- the JSON backend
    if (path === '/bff/me') {
      const c = customerOf(req);
      return json(res, 200, { customerId: c.id, fullName: c.full_name, email: c.email, region: c.region, policies: svc.policies(String(c.id)) });
    }
    if (path === '/bff/quotes' && method === 'POST') {
      const c = customerOf(req);
      csrfCheck(req);
      const q = svc.quote(await readJson(req), 'PORTAL', String(c.id));
      return json(res, 201, { quoteId: q.id, ...q.input, premium: q.premium });
    }
    if (path === '/bff/claims' && method === 'GET') {
      const c = customerOf(req);
      return json(res, 200, svc.claimsOf(String(c.id)).map((r) => claimJson(svc, r, false)));
    }
    if (path === '/bff/claims' && method === 'POST') {
      const c = customerOf(req);
      csrfCheck(req);
      const parts = parseMultipart(await readBody(req), String(req.headers['content-type'] ?? ''));
      const field = (n: string) => parts.find((p) => p.name === n && p.filename === undefined)?.data.toString('utf8') ?? '';
      if (field('declaration') !== 'accepted') throw new HttpError(422, 'the declaration must be confirmed', 'declaration_missing');
      const uploads: Upload[] = parts.filter((p) => p.name === 'evidence' && p.filename).map((p) => ({ filename: p.filename!, contentType: p.contentType, data: p.data }));
      const claim = svc.createClaim(
        { policyId: field('policyId'), customerId: String(c.id), type: field('type'), incidentDate: field('incidentDate'), amountClaimed: Number(field('amountClaimed')), description: field('description') },
        'PORTAL',
        uploads,
      );
      return json(res, 201, claimJson(svc, claim));
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/bff\/claims\/([\w-]+)$/.exec(path)) && method === 'GET') {
      const c = customerOf(req);
      const claim = svc.claim(m[1]);
      if (!claim || claim.customer_id !== c.id) throw new HttpError(404, `claim ${m[1]} not found`);
      const events = svc.db.prepare('SELECT type, created_at FROM claim_events WHERE claim_id = ? ORDER BY id').all(m[1]) as Row[];
      const policy = svc.policy(String(claim.policy_id))!;
      return json(res, 200, { ...claimJson(svc, claim), deductible: policy.deductible, product: policy.product, timeline: events.map((e) => ({ type: e.type, at: e.created_at })) });
    }
    if ((m = /^\/bff\/claims\/([\w-]+)\/settlement$/.exec(path)) && method === 'POST') {
      const c = customerOf(req);
      csrfCheck(req);
      const b = await readJson(req);
      const r = svc.acceptSettlement(m[1], String(c.id), String(b.token ?? ''), String(b.code ?? ''), String(b.iban ?? ''));
      return json(res, 200, claimJson(svc, r, false));
    }
    if ((m = /^\/bff\/claims\/([\w-]+)\/statement\.pdf$/.exec(path)) && method === 'GET') {
      const c = customerOf(req);
      const claim = svc.claim(m[1]);
      if (!claim || claim.customer_id !== c.id) throw new HttpError(404, `claim ${m[1]} not found`);
      return send(res, 200, statementPdf(svc, m[1]), 'application/pdf', { 'content-disposition': `attachment; filename="statement-${m[1]}.pdf"` });
    }
    throw new HttpError(404, 'not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal error', 'internal');
      if (!(e instanceof HttpError)) svc.log(`[portal] ${(e as Error).stack}`);
      if ((req.url ?? '').startsWith('/bff/')) json(res, err.status, { error: err.code, message: err.message });
      else send(res, err.status, layout('Error', `<section class="card"><h1>${err.status === 404 ? 'Page not found' : 'Something went wrong'}</h1><p>${esc(err.message)}</p></section>`), 'text/html; charset=utf-8', SECURITY_HEADERS);
    });
  });
  server.listen(port, host);
  return server;
}
