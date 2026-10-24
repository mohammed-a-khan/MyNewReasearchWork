/**
 * SQL Server connection settings: connection strings and authentication.
 *
 * Connection strings, in either form (fields given separately win over them):
 *   mssql://user:password@host:1433/database?encrypt=true&trustServerCertificate=false&authentication=ntlm&domain=CORP
 *   Server=tcp:sql.test,1433;Database=crm;User ID=qa;Password=secret://vault/CRM_PW;Encrypt=True;Authentication=Active Directory Service Principal
 *
 * Authentication is mapped onto the `authentication` option of the mssql /
 * tedious driver:
 *
 *   sql                      -> default (SQL Server login)
 *   ntlm                     -> ntlm (domain, user, password; any platform)
 *   kerberos                 -> the msnodesqlv8 driver (ODBC) with Trusted_Connection=Yes
 *   entra-password           -> azure-active-directory-password
 *   entra-service-principal  -> azure-active-directory-service-principal-secret
 *   entra-managed-identity   -> azure-active-directory-msi-vm (or -msi-app-service)
 *   entra-access-token       -> azure-active-directory-access-token
 *   entra-default            -> azure-active-directory-default
 *
 * With `tokenSource: eztest`, the Entra modes get their tokens from EZTest's own
 * OAuth client (client credentials, resource-owner password, the managed
 * identity endpoint) and hand them to the driver as a token credential, so
 * the driver's Azure libraries are not used at all.
 */
import { EzTestError } from '../core/index.js';
import { envProxyFetch } from './proxy.js';

export type MssqlAuthentication =
  | { type: 'sql' }
  | { type: 'ntlm'; domain?: string }
  | { type: 'kerberos'; odbcDriver?: string }
  | { type: 'entra-password'; clientId: string; tenantId?: string; tokenSource?: 'driver' | 'eztest'; authorityUrl?: string }
  | { type: 'entra-service-principal'; clientId: string; clientSecret: string; tenantId: string; tokenSource?: 'driver' | 'eztest'; authorityUrl?: string }
  | { type: 'entra-managed-identity'; clientId?: string; tokenSource?: 'driver' | 'eztest'; endpoint?: string }
  | { type: 'entra-access-token'; token: string }
  | { type: 'entra-default'; clientId?: string };

export interface MssqlSettings {
  connectionString?: string;
  server?: string;
  port?: number;
  instanceName?: string;
  database?: string;
  user?: string;
  password?: string;
  domain?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  appName?: string;
  connectTimeoutMs?: number;
  authentication?: MssqlAuthentication;
}

function bool(v: string, key: string): boolean {
  const s = v.trim().toLowerCase();
  if (['true', 'yes', '1', 'mandatory', 'strict', 'sspi'].includes(s)) return true;
  if (['false', 'no', '0', 'optional'].includes(s)) return false;
  throw new EzTestError(`SQL Server connection string: "${key}" must be true or false (got "${v}")`, 'DB_CONFIG');
}

/** Split an ADO.NET-style "key=value;key2=value2" string. Values may be quoted ("..", '..') or braced ({..}, "}}" escapes "}"). */
export function splitAdoConnectionString(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) break;
    const eq = s.indexOf('=', i);
    if (eq < 0) throw new EzTestError(`SQL Server connection string: expected key=value near "${s.slice(i, i + 20)}"`, 'DB_CONFIG');
    const key = s.slice(i, eq).trim();
    i = eq + 1;
    while (i < s.length && s[i] === ' ') i++;
    let value = '';
    const open = s[i];
    if (open === '"' || open === "'" || open === '{') {
      const close = open === '{' ? '}' : open;
      i++;
      for (;;) {
        if (i >= s.length) throw new EzTestError(`SQL Server connection string: unterminated ${open} in the value of "${key}"`, 'DB_CONFIG');
        if (s[i] === close) {
          if (s[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += s[i++];
      }
      while (i < s.length && s[i] !== ';') i++;
    } else {
      const end = s.indexOf(';', i);
      value = (end < 0 ? s.slice(i) : s.slice(i, end)).trim();
      i = end < 0 ? s.length : end;
    }
    out.push([key, value]);
  }
  return out;
}

const AUTH_WORDS: Record<string, MssqlAuthentication['type']> = {
  sqlpassword: 'sql', sql: 'sql', default: 'sql',
  windows: 'ntlm', ntlm: 'ntlm',
  kerberos: 'kerberos', integrated: 'kerberos', activedirectoryintegrated: 'kerberos',
  activedirectorypassword: 'entra-password', entrapassword: 'entra-password',
  activedirectoryserviceprincipal: 'entra-service-principal', entraserviceprincipal: 'entra-service-principal',
  activedirectorymanagedidentity: 'entra-managed-identity', activedirectorymsi: 'entra-managed-identity', entramanagedidentity: 'entra-managed-identity',
  activedirectoryaccesstoken: 'entra-access-token', entraaccesstoken: 'entra-access-token',
  activedirectorydefault: 'entra-default', entradefault: 'entra-default',
};

function authType(word: string): MssqlAuthentication['type'] {
  const t = AUTH_WORDS[word.toLowerCase().replace(/[\s_-]+/g, '')];
  if (!t) throw new EzTestError(`SQL Server connection string: unknown Authentication "${word}" (use SqlPassword, Windows, Kerberos, Active Directory Password, Active Directory Service Principal, Active Directory Managed Identity, Active Directory Access Token or Active Directory Default)`, 'DB_CONFIG');
  return t;
}

/** "tcp:host,1433", "host\\INSTANCE", "host:1433" -> parts. */
function serverParts(v: string): Pick<MssqlSettings, 'server' | 'port' | 'instanceName'> {
  let s = v.trim().replace(/^(?:tcp|np|lpc):/i, '');
  const out: Pick<MssqlSettings, 'server' | 'port' | 'instanceName'> = {};
  const comma = /,(\d+)$/.exec(s);
  if (comma) {
    out.port = Number(comma[1]);
    s = s.slice(0, comma.index);
  }
  const slash = s.indexOf('\\');
  if (slash >= 0) {
    out.instanceName = s.slice(slash + 1);
    s = s.slice(0, slash);
  }
  out.server = s === '.' || s.toLowerCase() === '(local)' ? 'localhost' : s;
  return out;
}

/** Build an authentication from loose fields (connection-string keys or URL query). */
function authFrom(type: MssqlAuthentication['type'], f: Record<string, string | undefined>, user: string | undefined, password: string | undefined): MssqlAuthentication {
  const clientId = f.clientid ?? f.applicationid;
  const tenantId = f.tenantid;
  switch (type) {
    case 'sql': return { type: 'sql' };
    case 'ntlm': return { type: 'ntlm', ...(f.domain ? { domain: f.domain } : {}) };
    case 'kerberos': return { type: 'kerberos', ...(f.odbcdriver ? { odbcDriver: f.odbcdriver } : {}) };
    case 'entra-password': {
      if (!clientId) throw new EzTestError('SQL Server connection string: Active Directory Password needs ClientId (the app registration EZTest signs in through)', 'DB_CONFIG');
      return { type: 'entra-password', clientId, ...(tenantId ? { tenantId } : {}) };
    }
    case 'entra-service-principal': {
      // ADO.NET convention: User ID is the application (client) id and Password the client secret.
      const id = clientId ?? user;
      const secret = f.clientsecret ?? password;
      if (!id || !secret || !tenantId) throw new EzTestError('SQL Server connection string: Active Directory Service Principal needs User ID (client id), Password (client secret) and TenantId', 'DB_CONFIG');
      return { type: 'entra-service-principal', clientId: id, clientSecret: secret, tenantId };
    }
    case 'entra-managed-identity': {
      const id = clientId ?? user;
      return { type: 'entra-managed-identity', ...(id ? { clientId: id } : {}) };
    }
    case 'entra-access-token': {
      const token = f.accesstoken ?? password;
      if (!token) throw new EzTestError('SQL Server connection string: Active Directory Access Token needs AccessToken', 'DB_CONFIG');
      return { type: 'entra-access-token', token };
    }
    case 'entra-default': return { type: 'entra-default', ...(clientId ? { clientId } : {}) };
  }
}

/** Parse an mssql:// (or sqlserver://) URL or an ADO.NET-style connection string. */
export function parseMssqlConnectionString(text: string): MssqlSettings {
  const s = text.trim();
  if (/^(?:mssql|sqlserver):\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s.replace(/^sqlserver:/i, 'mssql:'));
    } catch {
      throw new EzTestError('SQL Server connection string: not a valid mssql:// URL', 'DB_CONFIG');
    }
    const q: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (q[k.toLowerCase().replace(/[\s_-]+/g, '')] = v));
    let user = u.username ? decodeURIComponent(u.username) : undefined;
    let domain = q.domain;
    const dm = user ? /^([^\\]+)\\(.+)$/.exec(user) : null;
    if (dm) {
      domain ??= dm[1];
      user = dm[2];
    }
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    const path = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const [first, second] = path.split('/');
    const out: MssqlSettings = {
      server: u.hostname.replace(/^\[|\]$/g, ''),
      ...(u.port ? { port: Number(u.port) } : {}),
      ...(second !== undefined ? { instanceName: first, database: second } : first ? { database: first } : {}),
      ...(q.instancename ? { instanceName: q.instancename } : {}),
      ...(q.database ? { database: q.database } : {}),
      ...(user !== undefined ? { user } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(domain ? { domain } : {}),
      ...(q.encrypt !== undefined ? { encrypt: bool(q.encrypt, 'encrypt') } : {}),
      ...(q.trustservercertificate !== undefined ? { trustServerCertificate: bool(q.trustservercertificate, 'trustServerCertificate') } : {}),
      ...(q.appname ?? q.applicationname ? { appName: q.appname ?? q.applicationname } : {}),
      ...(q.connecttimeout ? { connectTimeoutMs: Number(q.connecttimeout) * 1000 } : {}),
    };
    const type = q.authentication ? authType(q.authentication) : domain ? 'ntlm' : undefined;
    if (type) out.authentication = authFrom(type, { ...q, domain }, user, password);
    return out;
  }
  const f: Record<string, string> = {};
  for (const [k, v] of splitAdoConnectionString(s)) f[k.toLowerCase().replace(/[\s_-]+/g, '')] = v;
  const out: MssqlSettings = {};
  const server = f.server ?? f.datasource ?? f.address ?? f.addr ?? f.networkaddress;
  if (server) Object.assign(out, serverParts(server));
  if (f.port) out.port = Number(f.port);
  const database = f.database ?? f.initialcatalog;
  if (database) out.database = database;
  let user = f.userid ?? f.uid ?? f.user ?? f.username;
  let domain = f.domain;
  const dm = user ? /^([^\\]+)\\(.+)$/.exec(user) : null;
  if (dm) {
    domain ??= dm[1];
    user = dm[2];
  }
  if (user !== undefined) out.user = user;
  const password = f.password ?? f.pwd;
  if (password !== undefined) out.password = password;
  if (domain) out.domain = domain;
  if (f.encrypt !== undefined) out.encrypt = bool(f.encrypt, 'Encrypt');
  if (f.trustservercertificate !== undefined) out.trustServerCertificate = bool(f.trustservercertificate, 'TrustServerCertificate');
  if (f.applicationname ?? f.app) out.appName = f.applicationname ?? f.app;
  const timeout = f.connecttimeout ?? f.connectiontimeout ?? f.timeout;
  if (timeout) out.connectTimeoutMs = Number(timeout) * 1000;
  const integrated = f.integratedsecurity ?? f.trustedconnection;
  let type: MssqlAuthentication['type'] | undefined = f.authentication ? authType(f.authentication) : undefined;
  if (!type && integrated !== undefined && bool(integrated, 'Integrated Security')) type = domain && password !== undefined ? 'ntlm' : 'kerberos';
  if (!type && domain) type = 'ntlm';
  if (type) out.authentication = authFrom(type, { ...f, domain }, user, password);
  return out;
}

/** Connection-string settings with the separately given fields on top. */
export function mergeMssqlSettings(o: MssqlSettings): MssqlSettings {
  const base = o.connectionString ? parseMssqlConnectionString(o.connectionString) : {};
  const out: MssqlSettings = { ...base };
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'connectionString') (out as Record<string, unknown>)[k] = v;
  // DOMAIN\user in the user field.
  const dm = out.user ? /^([^\\]+)\\(.+)$/.exec(out.user) : null;
  if (dm) {
    out.domain ??= dm[1];
    out.user = dm[2];
  }
  if (!out.authentication && out.domain) out.authentication = { type: 'ntlm' };
  if (!out.server) throw new EzTestError('SQL Server connection needs a server (server: or Server= in the connection string)', 'DB_CONFIG');
  return out;
}

// ----------------------------------------------------------------- Entra ID tokens (tokenSource: eztest)

/** What tedious calls for a token: { getToken(scope) } (the @azure/core-auth TokenCredential shape). */
export interface MssqlTokenCredential {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

export interface EntraTokenDeps {
  fetch?: typeof fetch;
  /** Default https://login.microsoftonline.com */
  authorityUrl?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

interface CachedToken { token: string; expiresOnTimestamp: number }

async function tokenRequest(url: string, init: RequestInit, f: typeof fetch, what: string, now: () => number): Promise<CachedToken> {
  let res: Response;
  let text: string;
  try {
    res = await f(url, init);
    text = await res.text();
  } catch (e) {
    throw new EzTestError(`${what}: ${url} could not be reached: ${(e as Error).message}`, 'MSSQL_ENTRA_TOKEN');
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const token = body.access_token;
  if (!res.ok || typeof token !== 'string' || !token) {
    const why = typeof body.error === 'string' ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description}` : ''}` : `HTTP ${res.status}`;
    throw new EzTestError(`${what} failed (${why})`, 'MSSQL_ENTRA_TOKEN', { status: res.status });
  }
  const expiresIn = Number(body.expires_in ?? NaN);
  const expiresOn = Number(body.expires_on ?? NaN);
  const exp = Number.isFinite(expiresOn) && expiresOn > 1e9 ? expiresOn * 1000 : now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
  return { token, expiresOnTimestamp: exp };
}

/**
 * A token credential for the Entra modes, on EZTest's own HTTP client: client
 * credentials (service principal), resource-owner password (user), the managed
 * identity endpoint (IMDS on VMs; IDENTITY_ENDPOINT on App Service and
 * Functions) or a fixed token. Tokens are cached per scope until 5 minutes
 * before they expire.
 */
export function entraTokenCredential(auth: MssqlAuthentication, creds: { user?: string; password?: string }, deps: EntraTokenDeps = {}): MssqlTokenCredential {
  const f = deps.fetch ?? envProxyFetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const authority = (deps.authorityUrl ?? ('authorityUrl' in auth ? auth.authorityUrl : undefined) ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const cache = new Map<string, CachedToken>();
  const fetchFor = async (scope: string): Promise<CachedToken> => {
    switch (auth.type) {
      case 'entra-service-principal': {
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: auth.clientId, client_secret: auth.clientSecret, scope });
        return tokenRequest(`${authority}/${encodeURIComponent(auth.tenantId)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, f, 'Entra service principal token', now);
      }
      case 'entra-password': {
        if (!creds.user || !creds.password) throw new EzTestError('Entra password authentication needs user and password', 'DB_CONFIG');
        const body = new URLSearchParams({ grant_type: 'password', client_id: auth.clientId, username: creds.user, password: creds.password, scope: `${scope} openid` });
        return tokenRequest(`${authority}/${encodeURIComponent(auth.tenantId ?? 'organizations')}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, f, 'Entra password token', now);
      }
      case 'entra-managed-identity': {
        const resource = scope.replace(/\/\.default$/, '');
        const appService = auth.endpoint ? undefined : env.IDENTITY_ENDPOINT;
        if (appService && env.IDENTITY_HEADER) {
          const u = new URL(appService);
          u.searchParams.set('api-version', '2019-08-01');
          u.searchParams.set('resource', resource);
          if (auth.clientId) u.searchParams.set('client_id', auth.clientId);
          return tokenRequest(u.toString(), { headers: { 'x-identity-header': env.IDENTITY_HEADER } }, f, 'Managed identity token (App Service)', now);
        }
        const u = new URL(auth.endpoint ?? 'http://169.254.169.254/metadata/identity/oauth2/token');
        u.searchParams.set('api-version', '2018-02-01');
        u.searchParams.set('resource', resource);
        if (auth.clientId) u.searchParams.set('client_id', auth.clientId);
        return tokenRequest(u.toString(), { headers: { metadata: 'true' } }, f, 'Managed identity token (IMDS)', now);
      }
      case 'entra-access-token':
        return { token: auth.token, expiresOnTimestamp: now() + 3600_000 };
      default:
        throw new EzTestError(`tokenSource: eztest is not available for SQL Server authentication "${auth.type}"`, 'DB_CONFIG');
    }
  };
  return {
    async getToken(scopes: string | string[]) {
      const scope = (Array.isArray(scopes) ? scopes[0] : scopes) || 'https://database.windows.net/.default';
      const hit = cache.get(scope);
      if (hit && hit.expiresOnTimestamp - 300_000 > now()) return hit;
      const t = await fetchFor(scope);
      cache.set(scope, t);
      return t;
    },
  };
}

// ----------------------------------------------------------------- driver config

export interface MssqlDriverConfig {
  /** The module to load: "mssql" (tedious), or "mssql/msnodesqlv8" for Kerberos / integrated. */
  module: 'mssql' | 'mssql/msnodesqlv8';
  config: Record<string, unknown>;
}

/** The mssql ConnectionPool config for merged settings. */
export function mssqlDriverConfig(s: MssqlSettings, deps: EntraTokenDeps = {}): MssqlDriverConfig {
  const auth = s.authentication ?? { type: 'sql' as const };
  const options: Record<string, unknown> = {
    encrypt: s.encrypt ?? true,
    trustServerCertificate: s.trustServerCertificate ?? false,
    ...(s.instanceName ? { instanceName: s.instanceName } : {}),
    ...(s.appName ? { appName: s.appName } : {}),
  };
  const base: Record<string, unknown> = {
    server: s.server,
    ...(s.port ? { port: s.port } : {}),
    ...(s.database ? { database: s.database } : {}),
    ...(s.connectTimeoutMs ? { connectionTimeout: s.connectTimeoutMs } : {}),
    options,
  };
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new EzTestError(`SQL Server ${auth.type} authentication needs ${what}`, 'DB_CONFIG');
    return v;
  };
  const eztest = 'tokenSource' in auth && auth.tokenSource === 'eztest';
  if (eztest) return { module: 'mssql', config: { ...base, authentication: { type: 'token-credential', options: { credential: entraTokenCredential(auth, { user: s.user, password: s.password }, deps) } } } };
  switch (auth.type) {
    case 'sql':
      return { module: 'mssql', config: { ...base, user: s.user, password: s.password } };
    case 'ntlm':
      return { module: 'mssql', config: { ...base, authentication: { type: 'ntlm', options: { domain: need(auth.domain ?? s.domain, 'a domain (domain: or DOMAIN\\user)'), userName: need(s.user, 'a user'), password: need(s.password, 'a password') } } } };
    case 'kerberos': {
      // msnodesqlv8 talks ODBC; the Microsoft ODBC driver uses the Kerberos ticket of the process (kinit on Linux/macOS, the logged-on user on Windows).
      const server = `${s.server}${s.instanceName ? `\\${s.instanceName}` : ''}${s.port ? `,${s.port}` : ''}`;
      const conn = [`Driver={${auth.odbcDriver ?? 'ODBC Driver 18 for SQL Server'}}`, `Server=${server}`, ...(s.database ? [`Database=${s.database}`] : []), 'Trusted_Connection=Yes', `Encrypt=${options.encrypt ? 'Yes' : 'No'}`, `TrustServerCertificate=${options.trustServerCertificate ? 'Yes' : 'No'}`].join(';');
      return { module: 'mssql/msnodesqlv8', config: { ...base, driver: 'msnodesqlv8', connectionString: conn, options: { ...options, trustedConnection: true } } };
    }
    case 'entra-password':
      return { module: 'mssql', config: { ...base, authentication: { type: 'azure-active-directory-password', options: { userName: need(s.user, 'a user'), password: need(s.password, 'a password'), clientId: auth.clientId, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) } } } };
    case 'entra-service-principal':
      return { module: 'mssql', config: { ...base, authentication: { type: 'azure-active-directory-service-principal-secret', options: { clientId: auth.clientId, clientSecret: auth.clientSecret, tenantId: auth.tenantId } } } };
    case 'entra-managed-identity': {
      const appService = !!(deps.env ?? process.env).IDENTITY_ENDPOINT;
      return { module: 'mssql', config: { ...base, authentication: { type: appService ? 'azure-active-directory-msi-app-service' : 'azure-active-directory-msi-vm', options: { ...(auth.clientId ? { clientId: auth.clientId } : {}) } } } };
    }
    case 'entra-access-token':
      return { module: 'mssql', config: { ...base, authentication: { type: 'azure-active-directory-access-token', options: { token: auth.token } } } };
    case 'entra-default':
      return { module: 'mssql', config: { ...base, authentication: { type: 'azure-active-directory-default', options: { ...(auth.clientId ? { clientId: auth.clientId } : {}) } } } };
  }
}
