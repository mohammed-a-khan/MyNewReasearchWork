/**
 * A Power Apps canvas emulation for EZTest's Power Apps pack, built from the
 * public conventions of the canvas player (an app iframe named
 * "fullscreen-app-host", controls rendered with data-control-name, gallery
 * items, notifications) and of Microsoft Entra sign-in pages. It is NOT Power
 * Apps: the pack is tested against this mock, not a real environment.
 *
 *  - Entra-style sign-in (#i0116 loginfmt, #i0118 passwd, #idSIButton9,
 *    "Stay signed in?" #idBtn_Back), then the player at /play/e/{env}/a/{app}.
 *  - The "Account Manager" app (examples/powerapps-mock/app.ts): gallery,
 *    text inputs, dropdown/combobox, toggle, buttons, two screens, Notify
 *    banners, an AppMagic-shaped object model for property reads.
 *  - Data lives in an embedded Dataverse mock (examples/d365-mock): the app
 *    reads and patches its `account` table, so Dataverse Web API cross-checks
 *    see what the app saved.
 *  - App sharing (Owner / CanView / not shared) and the app permissions API
 *    (/providers/Microsoft.PowerApps/apps/{app}/permissions), app source
 *    (.pa.yaml) per version for change impact.
 *
 * Run standalone: `npx tsx examples/powerapps-mock/server.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { startD365Mock, type D365MockServer } from '../d365-mock/server.js';
import { entities } from '../d365-mock/model.js';
import { appSourceYaml, runtimeJs, type AppVersion } from './app.js';

export interface PowerAppsMockServer {
  url: string;
  environmentId: string;
  appId: string;
  playUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  users: Record<'maker' | 'user' | 'guest', { username: string; password: string }>;
  dataverse: D365MockServer;
  appVersion: AppVersion;
  setAppVersion(v: AppVersion): void;
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie ?? '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const send = (res: ServerResponse, status: number, text: string, type = 'text/html; charset=utf-8', h: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': type, ...h });
  res.end(text);
};

export async function startPowerAppsMock(o: { port?: number; appVersion?: AppVersion } = {}): Promise<PowerAppsMockServer> {
  const dataverse = await startD365Mock({ saveDelayMs: 0 });
  let appVersion: AppVersion = o.appVersion ?? 1;
  const environmentId = 'Default-6f4b3e2a-6b1d-4c0e-9b8a-3f2d1c0b9a87';
  const appId = '3c8e9f2a-5b7d-4e1c-a0f9-8d6b5c4a3e21';
  const pw = (p: string) => `${p}-${randomBytes(6).toString('hex')}`;
  const users = { maker: { username: 'megan@contoso.example', password: pw('Mk') }, user: { username: 'alex@contoso.example', password: pw('Us') }, guest: { username: 'guest@fabrikam.example', password: pw('Gs') } };
  const shared: Record<string, 'Owner' | 'CanView'> = { maker: 'Owner', user: 'CanView' };
  const clientId = randomBytes(16).toString('hex');
  const clientSecret = pw('pacs');
  const roleOf = (u: string) => (Object.entries(users).find(([, x]) => x.username.toLowerCase() === u.toLowerCase())?.[0] ?? '') as keyof typeof users | '';
  const sessions = new Map<string, { role?: keyof typeof users; pending?: keyof typeof users; returnTo: string }>();
  const tokens = new Set<string>();
  const industryOptions = () => entities(false)[0].attributes.find((a) => a.logicalName === 'industrycode')!.options!;
  const table = () => dataverse.store.table('account');

  const entra = (step: 'user' | 'password' | 'kmsi', error = '', username = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to your account</title></head><body>
<form method="post" action="/common/login" id="i0281"><div id="loginHeader" role="heading">${step === 'user' ? 'Sign in' : step === 'password' ? 'Enter password' : 'Stay signed in?'}</div>
${error ? `<div id="usernameError" class="alert alert-error" role="alert">${esc(error)}</div>` : ''}<input type="hidden" name="step" value="${step}">
${step === 'user' ? '<input type="email" name="loginfmt" id="i0116" aria-label="Enter your email, phone, or Skype.">' : ''}
${step === 'password' ? `<div id="displayName">${esc(username)}</div><input type="password" name="passwd" id="i0118" aria-label="Enter the password">` : ''}
${step === 'kmsi' ? '<div id="KmsiDescription">Do this to reduce the number of times you are asked to sign in.</div><input type="submit" id="idBtn_Back" name="kmsi" value="No">' : ''}
<input type="submit" id="idSIButton9" name="next" value="${step === 'user' ? 'Next' : step === 'password' ? 'Sign in' : 'Yes'}"></form></body></html>`;

  const player = (role: string, inner: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Account Manager - Power Apps</title></head><body class="player">
<header id="playerHeader" role="banner"><span class="app-name">Account Manager</span><span class="user-name">${esc(users[role as keyof typeof users]?.username)}</span></header>${inner}</body></html>`;

  const appFrame = (role: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Account Manager</title>
<style>.appmagic-control-view{margin:4px}.appmagic-gallery-item{cursor:pointer;border-bottom:1px solid #ddd}.appmagic-button{display:inline-block;padding:4px 10px;background:#0078d4;color:#fff;cursor:pointer}.appmagic-disabled{opacity:.4;pointer-events:none}.appmagic-dropdown,.appmagic-combobox{display:inline-block;min-width:200px;border:1px solid #888;cursor:pointer;min-height:20px}</style></head>
<body class="appmagic-body"><div id="loading" class="appmagic-loading" role="progressbar">Loading...</div><div id="notifications" class="appmagic-notifications"></div><div id="app" class="appmagic-app" role="main"></div>
<script>${runtimeJs(appVersion, role === 'maker', industryOptions().map((x) => x.label))}</script></body></html>`;

  const bearer = (req: IncomingMessage) => tokens.has((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (async () => {
      const p = url.pathname;
      if (p === '/oauth2/v2.0/token' && req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        if (f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return send(res, 401, JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }), 'application/json');
        const t = randomBytes(24).toString('base64url');
        tokens.add(t);
        return send(res, 200, JSON.stringify({ token_type: 'Bearer', expires_in: 3599, access_token: t }), 'application/json');
      }
      if (p === `/providers/Microsoft.PowerApps/apps/${appId}/permissions`) {
        if (!bearer(req)) return send(res, 401, JSON.stringify({ error: { code: 'AuthenticationFailed', message: 'Authentication failed.' } }), 'application/json');
        return send(res, 200, JSON.stringify({
          value: Object.entries(shared).map(([r, roleName]) => ({ name: randomBytes(8).toString('hex'), properties: { roleName, principal: { id: randomBytes(8).toString('hex'), email: users[r as keyof typeof users].username, type: 'User' }, scope: `/providers/Microsoft.PowerApps/apps/${appId}` } })),
        }), 'application/json');
      }
      if (p === `/providers/Microsoft.PowerApps/apps/${appId}/source.pa.yaml`) {
        if (!bearer(req)) return send(res, 401, 'Unauthorized', 'text/plain');
        return send(res, 200, appSourceYaml(Number(url.searchParams.get('version') ?? appVersion) as AppVersion), 'application/x-yaml');
      }
      if (p === '/common/login' && req.method === 'POST') {
        const sid = cookies(req).ESTSAUTH ?? '';
        const s = sessions.get(sid);
        if (!s) return send(res, 302, '', 'text/plain', { location: '/' });
        const f = new URLSearchParams(await body(req));
        if (f.get('step') === 'user') {
          const r = roleOf(f.get('loginfmt') ?? '');
          if (!r) return send(res, 200, entra('user', "This username may be incorrect. Make sure you typed it correctly."));
          s.pending = r;
          return send(res, 200, entra('password', '', users[r].username));
        }
        if (f.get('step') === 'password') {
          if (!s.pending || f.get('passwd') !== users[s.pending].password) return send(res, 200, entra('password', 'Your account or password is incorrect.', s.pending ? users[s.pending].username : ''));
          return send(res, 200, entra('kmsi'));
        }
        s.role = s.pending;
        return send(res, 302, '', 'text/plain', { location: s.returnTo });
      }
      if (p === '/favicon.ico') return send(res, 404, '', 'text/plain');
      const sid = cookies(req).ESTSAUTH;
      const s = sid ? sessions.get(sid) : undefined;
      if (!s?.role) {
        const returnTo = p.startsWith('/play/') ? p + url.search : `/play/e/${environmentId}/a/${appId}`;
        if (s) {
          s.returnTo = returnTo;
          return send(res, 200, entra('user'));
        }
        const nsid = randomBytes(16).toString('hex');
        sessions.set(nsid, { returnTo });
        return send(res, 200, entra('user'), 'text/html; charset=utf-8', { 'set-cookie': `ESTSAUTH=${nsid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      const role = s.role;
      if (p === `/play/e/${environmentId}/a/${appId}`) {
        if (!shared[role]) return send(res, 403, player(role, '<div class="player-error" role="alert"><h2>Sorry, you don\'t have access to this app</h2><p>Ask the app owner to share it with you.</p></div>'));
        return send(res, 200, player(role, `<iframe id="fullscreen-app-host" name="fullscreen-app-host" title="Account Manager" src="/play/app-frame/${appId}" style="width:100%;height:700px;border:0"></iframe>`));
      }
      if (p === `/play/app-frame/${appId}`) return shared[role] ? send(res, 200, appFrame(role)) : send(res, 403, 'Forbidden', 'text/plain');
      if (p === '/play/data/accounts' && req.method === 'GET') {
        const ind = industryOptions();
        const value = [...table().values()].filter((a) => a.statecode === 0).map((a) => ({ accountid: a.accountid, name: a.name, telephone1: a.telephone1 ?? '', revenue: a.revenue ?? '', industry: ind.find((x) => x.value === a.industrycode)?.label ?? '', creditonhold: !!a.creditonhold }));
        value.sort((x, y) => String(x.name).localeCompare(String(y.name)));
        return send(res, 200, JSON.stringify({ value }), 'application/json');
      }
      if (p === '/play/data/accounts' && req.method === 'POST') {
        const b = JSON.parse(await body(req)) as { accountid?: string; name: string; telephone1?: string; industry?: string; creditonhold?: boolean };
        if (!b.name?.trim()) return send(res, 400, JSON.stringify({ error: 'Account Name: A value is required.' }), 'application/json');
        const code = industryOptions().find((x) => x.label === b.industry)?.value ?? null;
        const data = { name: b.name, telephone1: b.telephone1 || null, industrycode: code, ...(b.creditonhold !== undefined ? { creditonhold: b.creditonhold } : {}) };
        const id = b.accountid && table().get(b.accountid) ? (dataverse.store.update('account', b.accountid, data), b.accountid) : dataverse.store.insert('account', data);
        return send(res, 200, JSON.stringify({ accountid: id }), 'application/json');
      }
      const dm = /^\/play\/data\/accounts\/([0-9a-f-]{36})$/.exec(p);
      if (dm && req.method === 'DELETE') {
        if (role !== 'maker') return send(res, 403, JSON.stringify({ error: 'Permission denied' }), 'application/json');
        table().delete(dm[1]);
        res.writeHead(204).end();
        return;
      }
      if (p === '/') return send(res, 302, '', 'text/plain', { location: `/play/e/${environmentId}/a/${appId}` });
      send(res, 404, 'Not found', 'text/plain');
    })().catch((e: unknown) => send(res, 500, String((e as Error).message), 'text/plain'));
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url, environmentId, appId, playUrl: `${url}/play/e/${environmentId}/a/${appId}`, tokenUrl: `${url}/oauth2/v2.0/token`, clientId, clientSecret, users, dataverse,
    get appVersion() {
      return appVersion;
    },
    setAppVersion(v) {
      appVersion = v;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await dataverse.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startPowerAppsMock({ port: Number(process.env.PORT ?? 8099) });
  console.log(`Power Apps mock: ${s.playUrl} (Dataverse ${s.dataverse.url})`);
  for (const [r, u] of Object.entries(s.users)) console.log(`  ${r}: ${u.username} / ${u.password}`);
}
