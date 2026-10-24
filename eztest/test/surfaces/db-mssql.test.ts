/**
 * SQL Server connection strings and authentication.
 *
 * - Parsing (mssql:// URLs and ADO.NET strings), the mapping of every
 *   authentication mode onto the mssql / tedious `authentication` option, and
 *   EZTest's own Entra token credential (tokenSource: eztest) against local
 *   fake token servers: always run.
 * - The mapped settings are handed to the REAL tedious driver (its config
 *   validation) and, with EZTEST_MSSQL_URL, used against a REAL SQL Server:
 *   a SQL login from an ADO.NET string with a secret:// password, and an NTLM
 *   login that the server answers as a Windows (integrated) login. The
 *   container SQL Server is not joined to a domain, so it refuses NTLM with
 *   "untrusted domain"; that answer proves the NTLM exchange reached it, and
 *   is all a domain-less server can prove (docs/databases.md).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MssqlDbClient, DbError, DbRegistry, entraTokenCredential, mergeMssqlSettings, mssqlDriverConfig, parseMssqlConnectionString, resolveSpecSecrets, splitAdoConnectionString } from '../../src/surfaces/index.js';
import { DbConnectionSchema } from '../../src/config/schema.js';
import { MSSQL_SKIP, announceSkip, loadMssql, mssqlEnv } from './db-env.js';

const ms = mssqlEnv();
const mssqlDriver = await loadMssql(ms?.driverPath ?? process.env.EZTEST_MSSQL_DRIVER);

describe('SQL Server connection strings', () => {
  it('splits ADO.NET strings with quoted and braced values', () => {
    expect(splitAdoConnectionString(`Server=tcp:sql.test,1433; Database = crm ;Password={a;b}}c};User ID="x y";App='it''s'`)).toEqual([
      ['Server', 'tcp:sql.test,1433'], ['Database', 'crm'], ['Password', 'a;b}c'], ['User ID', 'x y'], ['App', "it's"],
    ]);
    expect(() => splitAdoConnectionString('Server=x;Password={open')).toThrow(/unterminated \{/);
  });

  it('parses mssql:// URLs, with DOMAIN\\user and query options', () => {
    expect(parseMssqlConnectionString('mssql://qa:p%40ss@sql.test:1444/crm?encrypt=true&trustServerCertificate=yes&appName=EZ')).toEqual({
      server: 'sql.test', port: 1444, database: 'crm', user: 'qa', password: 'p@ss', encrypt: true, trustServerCertificate: true, appName: 'EZ',
    });
    expect(parseMssqlConnectionString('sqlserver://CORP%5Cqa:pw@sql.test/SQLEXPRESS/crm')).toEqual({
      server: 'sql.test', instanceName: 'SQLEXPRESS', database: 'crm', user: 'qa', password: 'pw', domain: 'CORP', authentication: { type: 'ntlm', domain: 'CORP' },
    });
    expect(parseMssqlConnectionString('mssql://app-id:sec@db.database.windows.net/sales?authentication=ActiveDirectoryServicePrincipal&tenantId=t-1')).toMatchObject({
      authentication: { type: 'entra-service-principal', clientId: 'app-id', clientSecret: 'sec', tenantId: 't-1' },
    });
  });

  it('parses ADO.NET strings: server forms, integrated security and every Authentication keyword', () => {
    expect(parseMssqlConnectionString('Data Source=tcp:sql.test,1433;Initial Catalog=crm;User ID=qa;Password=pw;Encrypt=True;TrustServerCertificate=False;Connect Timeout=30')).toEqual({
      server: 'sql.test', port: 1433, database: 'crm', user: 'qa', password: 'pw', encrypt: true, trustServerCertificate: false, connectTimeoutMs: 30_000,
    });
    expect(parseMssqlConnectionString('Server=(local)\\SQLEXPRESS;Database=x;Integrated Security=SSPI')).toEqual({ server: 'localhost', instanceName: 'SQLEXPRESS', database: 'x', authentication: { type: 'kerberos' } });
    expect(parseMssqlConnectionString('Server=sql.test;User ID=CORP\\qa;Password=pw;Integrated Security=true')).toMatchObject({ user: 'qa', domain: 'CORP', authentication: { type: 'ntlm', domain: 'CORP' } });
    const auth = (a: string, extra = '') => parseMssqlConnectionString(`Server=db.database.windows.net;Database=d;Authentication=${a};${extra}`).authentication;
    expect(auth('Sql Password')).toEqual({ type: 'sql' });
    expect(auth('Active Directory Password', 'User ID=u@corp.test;Password=pw;ClientId=c-1;TenantId=t-1')).toEqual({ type: 'entra-password', clientId: 'c-1', tenantId: 't-1' });
    expect(auth('ActiveDirectoryServicePrincipal', 'User ID=app;Password=sec;TenantId=t-1')).toEqual({ type: 'entra-service-principal', clientId: 'app', clientSecret: 'sec', tenantId: 't-1' });
    expect(auth('Active Directory Managed Identity', 'User ID=mi-client')).toEqual({ type: 'entra-managed-identity', clientId: 'mi-client' });
    expect(auth('Active Directory MSI')).toEqual({ type: 'entra-managed-identity' });
    expect(auth('Active Directory Access Token', 'AccessToken=eyJ.x.y')).toEqual({ type: 'entra-access-token', token: 'eyJ.x.y' });
    expect(auth('Active Directory Default')).toEqual({ type: 'entra-default' });
    expect(auth('Windows', 'Domain=CORP')).toEqual({ type: 'ntlm', domain: 'CORP' });
    expect(() => auth('Active Directory Service Principal', 'User ID=app;Password=sec')).toThrow(/needs User ID \(client id\), Password \(client secret\) and TenantId/);
    expect(() => auth('Magic')).toThrow(/unknown Authentication "Magic"/);
  });

  it('separate fields win over the connection string; a server is required', () => {
    expect(mergeMssqlSettings({ connectionString: 'Server=a;Database=x;User ID=u;Password=p', database: 'y', password: 'q' })).toMatchObject({ server: 'a', database: 'y', user: 'u', password: 'q' });
    expect(mergeMssqlSettings({ server: 'a', user: 'CORP\\qa', password: 'p' })).toMatchObject({ user: 'qa', domain: 'CORP', authentication: { type: 'ntlm' } });
    expect(() => mergeMssqlSettings({ connectionString: 'Database=x' })).toThrow(/needs a server/);
  });

  it('config accepts connection strings, authentication blocks and ports from ${ENV} text', () => {
    const c = DbConnectionSchema.parse({ type: 'sqlserver', connectionString: 'Server=x;Database=y', port: '1444', authentication: { type: 'entra-service-principal', clientId: 'c', clientSecret: 'secret://vault/SP', tenantId: 't' } });
    expect(c).toMatchObject({ driver: 'mssql', port: 1444, authentication: { type: 'entra-service-principal' } });
    expect(() => DbConnectionSchema.parse({ type: 'mssql', database: 'x' })).toThrow(/need server or connectionString/);
  });

  it('resolves secret:// references inside connection strings and authentication blocks', async () => {
    const secrets: Record<string, string> = { 'secret://vault/PW': 'p;w"d', 'secret://vault/SP': 's3cret', 'secret://vault/URLPW': 'a/b@c' };
    const r = (ref: string) => Promise.resolve(secrets[ref]);
    const ado = await resolveSpecSecrets({ driver: 'mssql', connectionString: 'Server=x;User ID=qa;Password=secret://vault/PW;Database=y', authentication: { type: 'entra-service-principal', clientId: 'c', clientSecret: 'secret://vault/SP', tenantId: 't' } } as never, r) as Record<string, unknown>;
    expect(ado.connectionString).toBe('Server=x;User ID=qa;Password={p;w"d};Database=y');
    expect(parseMssqlConnectionString(String(ado.connectionString)).password).toBe('p;w"d');
    expect(ado.authentication).toMatchObject({ clientSecret: 's3cret' });
    const url = await resolveSpecSecrets({ driver: 'mssql', connectionString: 'mssql://qa@x/db?accessToken=secret://vault/URLPW&authentication=ActiveDirectoryAccessToken' } as never, r) as Record<string, unknown>;
    expect(parseMssqlConnectionString(String(url.connectionString)).authentication).toEqual({ type: 'entra-access-token', token: 'a/b@c' });
    await expect(resolveSpecSecrets({ driver: 'mssql', connectionString: 'Server=x;Password=secret://vault/PW' } as never)).rejects.toThrow(/no secret store is configured/);
  });
});

describe('SQL Server authentication mapping', () => {
  const base = { server: 'sql.test', database: 'crm', user: 'qa', password: 'pw' };
  const authOf = (s: Parameters<typeof mssqlDriverConfig>[0]) => mssqlDriverConfig(s).config.authentication as { type: string; options: Record<string, unknown> } | undefined;

  it('maps each mode onto the driver option', () => {
    expect(mssqlDriverConfig(base).config).toMatchObject({ server: 'sql.test', database: 'crm', user: 'qa', password: 'pw', options: { encrypt: true, trustServerCertificate: false } });
    expect(authOf({ ...base, authentication: { type: 'ntlm', domain: 'CORP' } })).toEqual({ type: 'ntlm', options: { domain: 'CORP', userName: 'qa', password: 'pw' } });
    expect(authOf({ ...base, user: 'u@corp.test', authentication: { type: 'entra-password', clientId: 'c-1', tenantId: 't-1' } })).toEqual({ type: 'azure-active-directory-password', options: { userName: 'u@corp.test', password: 'pw', clientId: 'c-1', tenantId: 't-1' } });
    expect(authOf({ ...base, authentication: { type: 'entra-service-principal', clientId: 'c', clientSecret: 's', tenantId: 't' } })).toEqual({ type: 'azure-active-directory-service-principal-secret', options: { clientId: 'c', clientSecret: 's', tenantId: 't' } });
    expect(mssqlDriverConfig({ ...base, authentication: { type: 'entra-managed-identity', clientId: 'mi' } }, { env: {} }).config.authentication).toEqual({ type: 'azure-active-directory-msi-vm', options: { clientId: 'mi' } });
    expect(mssqlDriverConfig({ ...base, authentication: { type: 'entra-managed-identity' } }, { env: { IDENTITY_ENDPOINT: 'http://x' } }).config.authentication).toEqual({ type: 'azure-active-directory-msi-app-service', options: {} });
    expect(authOf({ ...base, authentication: { type: 'entra-access-token', token: 'tok' } })).toEqual({ type: 'azure-active-directory-access-token', options: { token: 'tok' } });
    expect(authOf({ ...base, authentication: { type: 'entra-default', clientId: 'c' } })).toEqual({ type: 'azure-active-directory-default', options: { clientId: 'c' } });
    expect(() => mssqlDriverConfig({ server: 'x', authentication: { type: 'ntlm', domain: 'CORP' } })).toThrow(/ntlm authentication needs a user/);
    const k = mssqlDriverConfig({ server: 'sql.test', instanceName: 'INST', database: 'crm', authentication: { type: 'kerberos' } });
    expect(k.module).toBe('mssql/msnodesqlv8');
    expect(k.config.connectionString).toBe('Driver={ODBC Driver 18 for SQL Server};Server=sql.test\\INST;Database=crm;Trusted_Connection=Yes;Encrypt=Yes;TrustServerCertificate=No');
    const tc = authOf({ ...base, authentication: { type: 'entra-service-principal', clientId: 'c', clientSecret: 's', tenantId: 't', tokenSource: 'eztest' } });
    expect(tc?.type).toBe('token-credential');
    expect(typeof (tc?.options.credential as { getToken: unknown }).getToken).toBe('function');
  });

  it.skipIf(!mssqlDriver)('the real tedious driver accepts every mapped authentication (config validation, no connection)', async () => {
    const tediousPath = `${(ms?.driverPath ?? process.env.EZTEST_MSSQL_DRIVER ?? '').replace(/\/mssql\/?$/, '')}/tedious/lib/tedious.js`;
    const tedious = (await import(tediousPath).catch(() => import('tedious' as string))) as { Connection: new (c: unknown) => { close(): void } };
    const Pool = (mssqlDriver as { ConnectionPool: new (c: unknown) => { _config(): Record<string, unknown> } }).ConnectionPool;
    const modes = [
      { type: 'sql' }, { type: 'ntlm', domain: 'CORP' }, { type: 'entra-password', clientId: 'c-1', tenantId: 't-1' },
      { type: 'entra-service-principal', clientId: 'c', clientSecret: 's', tenantId: 't' }, { type: 'entra-managed-identity', clientId: 'mi' },
      { type: 'entra-access-token', token: 'tok' }, { type: 'entra-default' }, { type: 'entra-service-principal', clientId: 'c', clientSecret: 's', tenantId: 't', tokenSource: 'eztest' },
    ] as const;
    for (const authentication of modes) {
      const cfg = new Pool(mssqlDriverConfig({ ...base, authentication } as never, { env: {} }).config)._config();
      const conn = new tedious.Connection(cfg); // throws TypeError on a shape tedious does not accept
      conn.close();
    }
    expect(() => new tedious.Connection({ server: 'x', authentication: { type: 'ntlm', options: { userName: 'u', password: 'p' } } })).toThrow(/domain/);
  });
});

describe('Entra tokens from EZTest (tokenSource: eztest)', () => {
  let server: Server;
  let url: string;
  const seen: Array<{ path: string; form: Record<string, string>; headers: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const form = Object.fromEntries(new URLSearchParams(u.search.length > 1 ? u.search : body));
        seen.push({ path: u.pathname, form, headers: req.headers });
        const json = (s: number, b: unknown) => {
          res.writeHead(s, { 'content-type': 'application/json' });
          res.end(JSON.stringify(b));
        };
        if (u.pathname === '/tenant-1/oauth2/v2.0/token') {
          if (form.grant_type === 'client_credentials' && form.client_id === 'app' && form.client_secret === 'sp-secret') return json(200, { access_token: `sp-token:${form.scope}`, expires_in: 3600 });
          if (form.grant_type === 'password' && form.username === 'qa@corp.test' && form.password === 'Fictional#1') return json(200, { access_token: `user-token:${form.scope}`, expires_in: 3600 });
          return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        }
        if (u.pathname === '/metadata/identity/oauth2/token') {
          if (req.headers.metadata !== 'true') return json(400, { error: 'invalid_request', error_description: 'Required metadata header not specified' });
          return json(200, { access_token: `mi-token:${form.resource}:${form.client_id ?? 'system'}`, expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('service principal: client credentials for the scope the server asks for, cached', async () => {
    const c = entraTokenCredential({ type: 'entra-service-principal', clientId: 'app', clientSecret: 'sp-secret', tenantId: 'tenant-1' }, {}, { authorityUrl: url });
    const t = await c.getToken('https://database.windows.net/.default');
    expect(t?.token).toBe('sp-token:https://database.windows.net/.default');
    expect(t!.expiresOnTimestamp).toBeGreaterThan(Date.now() + 3000_000);
    const before = seen.length;
    await c.getToken(['https://database.windows.net/.default']);
    expect(seen.length).toBe(before);
    const bad = entraTokenCredential({ type: 'entra-service-principal', clientId: 'app', clientSecret: 'wrong', tenantId: 'tenant-1' }, {}, { authorityUrl: url });
    await expect(bad.getToken('https://database.windows.net/.default')).rejects.toThrow(/Entra service principal token failed \(invalid_client: AADSTS7000215/);
  });

  it('password: resource-owner password grant', async () => {
    const c = entraTokenCredential({ type: 'entra-password', clientId: 'app', tenantId: 'tenant-1' }, { user: 'qa@corp.test', password: 'Fictional#1' }, { authorityUrl: url });
    expect((await c.getToken('https://database.windows.net/.default'))?.token).toBe('user-token:https://database.windows.net/.default openid');
  });

  it('managed identity: IMDS with the Metadata header, user-assigned client id', async () => {
    const c = entraTokenCredential({ type: 'entra-managed-identity', clientId: 'mi-1', endpoint: `${url}/metadata/identity/oauth2/token` }, {});
    expect((await c.getToken('https://database.windows.net/.default'))?.token).toBe('mi-token:https://database.windows.net:mi-1');
    expect(seen.at(-1)!.form['api-version']).toBe('2018-02-01');
  });

  it('the token credential is what the driver calls (no Azure library involved)', async () => {
    const cfg = mssqlDriverConfig({ server: 'db.test', authentication: { type: 'entra-service-principal', clientId: 'app', clientSecret: 'sp-secret', tenantId: 'tenant-1', tokenSource: 'eztest' } }, { authorityUrl: url });
    const cred = (cfg.config.authentication as { options: { credential: { getToken(s: string): Promise<{ token: string }> } } }).options.credential;
    expect((await cred.getToken('https://database.windows.net/.default')).token).toMatch(/^sp-token:/);
  });
});

announceSkip(!!(ms && mssqlDriver), MSSQL_SKIP);
describe.skipIf(!(ms && mssqlDriver))(`SQL Server authentication (live)${ms && mssqlDriver ? '' : ` - ${MSSQL_SKIP}`}`, () => {
  it('SQL login from an ADO.NET connection string with a secret:// password', async () => {
    const reg = new DbRegistry({ crm: { driver: 'mssql', connectionString: `Server=tcp:${ms!.server},${ms!.port};Database=${ms!.database};User ID=${ms!.user};Password=secret://vault/SA_PW;Encrypt=True;TrustServerCertificate=True`, driverModule: mssqlDriver } as never }, { resolveSecret: async (ref) => (ref === 'secret://vault/SA_PW' ? ms!.password : '') });
    try {
      const c = await reg.get('crm');
      expect(await c.query("SELECT SUSER_NAME() AS who, DB_NAME() AS db, CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int) AS winonly")).toEqual([{ who: ms!.user, db: ms!.database, winonly: 0 }]);
    } finally {
      await reg.closeAll();
    }
  });

  it('SQL login from an mssql:// URL', async () => {
    const c = await MssqlDbClient.connect({ connectionString: `mssql://${encodeURIComponent(ms!.user)}:${encodeURIComponent(ms!.password)}@${ms!.server}:${ms!.port}/${ms!.database}?encrypt=true&trustServerCertificate=true`, driverModule: mssqlDriver });
    try {
      expect(await c.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await c.close();
    }
  });

  it('NTLM: the server receives a Windows (integrated) login; a server outside a domain refuses it as untrusted', async () => {
    const err = await MssqlDbClient.connect({ server: ms!.server, port: ms!.port, database: ms!.database, user: 'EZCORP\\qa', password: 'Fictional#1', trustServerCertificate: true, driverModule: mssqlDriver }).catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe('DB_CONNECT');
    expect(err.details).toMatchObject({ auth: 'ntlm', driverCode: 'ELOGIN' });
    expect(err.message).toMatch(/The login is from an untrusted domain and cannot be used with Integrated authentication/);
    // A wrong SQL password is a different answer: the SQL login path was used.
    const sqlErr = await MssqlDbClient.connect({ server: ms!.server, port: ms!.port, user: ms!.user, password: 'wrong', trustServerCertificate: true, driverModule: mssqlDriver }).catch((e) => e);
    expect(sqlErr.message).toMatch(/Login failed for user/);
  });
});
