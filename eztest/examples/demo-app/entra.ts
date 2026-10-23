/**
 * A small mock of a Microsoft Entra ID (Azure AD) sign-in, for testing EZTest's
 * `login: { type: entra }` recipe. It mimics the screens and element ids of the real
 * pages (identifier "loginfmt" + Next, password "passwd" + Sign in, one-time code
 * "otc", "Stay signed in?" with Yes/No, and the "Pick an account" picker shown when a
 * remembered account exists and prompt=login was not asked for).
 *
 *   GET /entra/oauth2/v2.0/authorize?redirect_uri=/entra/callback&prompt=...
 *   GET /entra/app       app entry: redirects to the authorize URL
 *
 * Users are `<demo user>@ezshop.test` with the demo passwords; a user with MFA
 * (alice) gets the one-time code screen.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface EntraDeps {
  users: Record<string, { password: string; mfa: boolean }>;
  totpValid(code: string): boolean;
  /** Create an app session for `user` and return the Set-Cookie header value. */
  createSession(user: string): string;
}

interface Flow {
  user?: string;
  redirect: string;
  passwordOk?: boolean;
  mfaOk?: boolean;
  prompt?: string;
  domainHint?: string;
}

export interface EntraState {
  flows: Map<string, Flow>;
  /** Remembered accounts (the "KMSI" cookie) -> user. */
  remembered: Map<string, string>;
  /** Observed authorize requests (for tests): prompt and domain_hint values. */
  authorizeLog: Array<{ prompt: string | null; domainHint: string | null }>;
}

export function newEntraState(): EntraState {
  return { flows: new Map(), remembered: new Map(), authorizeLog: [] };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#f2f2f2}.box{background:#fff;width:380px;margin:60px auto;padding:36px;box-shadow:0 2px 6px rgba(0,0,0,.2)}
input[type=text],input[type=email],input[type=password],input[type=tel]{width:100%;padding:6px;margin:8px 0}.err{color:#e81123}.tile{display:block;padding:8px;border:1px solid #ccc;margin:6px 0;cursor:pointer}</style></head>
<body><div class="box"><div class="logo">Microsoft</div>${body}</div></body></html>`;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9]+)`).exec(req.headers.cookie ?? '')?.[1];
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}

const identifierPage = (err?: string) => page('Sign in to your account', `<div role="heading" id="loginHeader">Sign in</div>
<form method="post" action="/entra/login"><input type="email" name="loginfmt" id="i0116" placeholder="Email, phone, or Skype" autocomplete="username">
${err ? `<div id="usernameError" class="err">${esc(err)}</div>` : ''}<input type="submit" id="idSIButton9" value="Next"></form>`);

const passwordPage = (user: string, err?: string) => page('Enter password', `<div id="displayName">${esc(user)}</div><div role="heading">Enter password</div>
<form method="post" action="/entra/password"><input type="hidden" name="loginfmt" value="${esc(user)}"><input type="password" name="passwd" id="i0118" placeholder="Password" autocomplete="current-password">
${err ? `<div id="passwordError" class="err">${esc(err)}</div>` : ''}<input type="submit" id="idSIButton9" value="Sign in"></form>`);

const otcPage = (err?: string) => page('Enter code', `<div role="heading">Enter code</div><p>Enter the code displayed in your authenticator app.</p>
<form method="post" action="/entra/otc"><input type="tel" name="otc" id="idTxtBx_SAOTCC_OTC" autocomplete="one-time-code" inputmode="numeric">
${err ? `<div id="idSpan_SAOTCC_Error_OTC" class="err">${esc(err)}</div>` : ''}<input type="submit" id="idSubmit_SAOTCC_Continue" value="Verify"></form>`);

const kmsiPage = () => page('Stay signed in?', `<div role="heading">Stay signed in?</div><div id="KmsiDescription">Do this to reduce the number of times you are asked to sign in.</div>
<form method="post" action="/entra/kmsi"><label><input type="checkbox" name="DontShowAgain" id="KmsiCheckboxField"> Don't show this again</label>
<button type="submit" name="answer" value="no" id="idBtn_Back">No</button> <button type="submit" name="answer" value="yes" id="idSIButton9">Yes</button></form>`);

const pickerPage = (user: string) => page('Pick an account', `<div role="heading">Pick an account</div><div id="tilesHolder">
<form method="post" action="/entra/pick"><button class="tile" type="submit" name="account" value="${esc(user)}" data-test-id="${esc(user)}">${esc(user)}<br><small>Signed in</small></button>
<button class="tile" type="submit" name="account" value="" id="otherTile" data-test-id="otherTile">Use another account</button></form></div>`);

/** Handle /entra/* requests; returns false for other paths. */
export async function handleEntra(req: IncomingMessage, res: ServerResponse, url: URL, deps: EntraDeps, st: EntraState): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/entra/')) return false;
  const flowId = cookie(req, 'entra_flow');
  const flow = flowId ? st.flows.get(flowId) : undefined;
  const userOf = (login: string) => {
    const m = /^([a-z]+)@ezshop\.test$/i.exec(login.trim());
    return m && deps.users[m[1].toLowerCase()] ? m[1].toLowerCase() : undefined;
  };

  if (path === '/entra/app') {
    redirect(res, '/entra/oauth2/v2.0/authorize?client_id=ez-shop&response_type=code&redirect_uri=%2Fentra%2Fcallback');
    return true;
  }
  if (path === '/entra/oauth2/v2.0/authorize') {
    st.authorizeLog.push({ prompt: url.searchParams.get('prompt'), domainHint: url.searchParams.get('domain_hint') });
    const id = randomBytes(8).toString('hex');
    const f: Flow = { redirect: url.searchParams.get('redirect_uri') ?? '/entra/callback', prompt: url.searchParams.get('prompt') ?? undefined, domainHint: url.searchParams.get('domain_hint') ?? undefined };
    st.flows.set(id, f);
    const known = st.remembered.get(cookie(req, 'entra_kmsi') ?? '');
    const headers = { 'set-cookie': `entra_flow=${id}; Path=/entra; HttpOnly; SameSite=Lax` };
    if (known && f.prompt !== 'login') send(res, 200, pickerPage(`${known}@ezshop.test`), headers);
    else send(res, 200, identifierPage(), headers);
    return true;
  }
  if (path === '/entra/callback') {
    redirect(res, '/dashboard');
    return true;
  }
  if (!flow) {
    send(res, 400, page('Error', '<div id="idTD_Error" class="err">Your session has expired. Start again.</div>'));
    return true;
  }
  if (path === '/entra/pick' && req.method === 'POST') {
    const acct = (await form(req)).get('account') ?? '';
    const u = acct ? userOf(acct) : undefined;
    if (!u) send(res, 200, identifierPage());
    else {
      flow.user = u;
      send(res, 200, passwordPage(acct));
    }
    return true;
  }
  if (path === '/entra/login' && req.method === 'POST') {
    const login = (await form(req)).get('loginfmt') ?? '';
    const u = userOf(login);
    if (!u) send(res, 200, identifierPage("We couldn't find an account with that username."));
    else {
      flow.user = u;
      send(res, 200, passwordPage(login.trim()));
    }
    return true;
  }
  if (path === '/entra/password' && req.method === 'POST') {
    const b = await form(req);
    if (!flow.user || deps.users[flow.user].password !== b.get('passwd')) {
      send(res, 200, passwordPage(b.get('loginfmt') ?? '', 'Your account or password is incorrect.'));
      return true;
    }
    flow.passwordOk = true;
    send(res, 200, deps.users[flow.user].mfa ? otcPage() : kmsiPage());
    return true;
  }
  if (path === '/entra/otc' && req.method === 'POST') {
    if (!flow.passwordOk) return send(res, 400, page('Error', '<div id="idTD_Error" class="err">Sign in first.</div>')), true;
    if (!deps.totpValid((await form(req)).get('otc') ?? '')) {
      send(res, 200, otcPage("That code didn't work. Check the code and try again."));
      return true;
    }
    flow.mfaOk = true;
    send(res, 200, kmsiPage());
    return true;
  }
  if (path === '/entra/kmsi' && req.method === 'POST') {
    const user = flow.user;
    if (!user || !flow.passwordOk || (deps.users[user].mfa && !flow.mfaOk)) return send(res, 400, page('Error', '<div id="idTD_Error" class="err">Sign in first.</div>')), true;
    const yes = (await form(req)).get('answer') === 'yes';
    const cookies = [deps.createSession(user), 'entra_flow=; Max-Age=0; Path=/entra'];
    if (yes) {
      const k = randomBytes(8).toString('hex');
      st.remembered.set(k, user);
      cookies.push(`entra_kmsi=${k}; Path=/entra; HttpOnly; SameSite=Lax`);
    }
    if (flowId) st.flows.delete(flowId);
    redirect(res, `${flow.redirect}?code=${randomBytes(6).toString('hex')}&kmsi=${yes ? 1 : 0}`, { 'set-cookie': cookies });
    return true;
  }
  send(res, 404, page('Not found', '<div class="err">Not found</div>'));
  return true;
}
