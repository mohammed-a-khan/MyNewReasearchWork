/** Azure DevOps credentials against the mock: PAT, System.AccessToken, Entra ID (secret and workload identity), managed identity, Azure DevOps Server. */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../src/core/index.js';
import { AdoAuthError, AdoClient, AdoTokenError, adoClientFromConfig, resolveAdoAuth } from '../../src/alm-ado/index.js';
import { SecretMasker } from '../../src/config/index.js';
import { EzTestConfigSchema } from '../../src/config/index.js';
import { fakeJwt, startMockAdoServer, type MockAdoServer } from './mock-ado-server.js';

let ado: MockAdoServer | undefined;
afterEach(async () => {
  await ado?.close();
  ado = undefined;
});

const SYS = 'systemAccessTOKEN-abcdef-123456';
const SECRET = 'sp-client-SECRET-value-9876';
const entra = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: SECRET, subject: 'sc://org/proj/eztest-conn' };

function logs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const f = (m: string, d?: unknown) => void lines.push(m + JSON.stringify(d ?? {}));
  return { logger: { debug: f, info: f, warn: f, error: f }, lines };
}

const who = async (c: AdoClient) => (await c.request<{ authenticatedUser: { providerDisplayName: string } }>('GET', c.collection('/_apis/connectionData'))).data.authenticatedUser.providerDisplayName;

describe('ADO authentication', () => {
  it('PAT: works, a bad PAT is the 203 sign-in page, the token never appears in errors or logs', async () => {
    ado = await startMockAdoServer();
    const { logger, lines } = logs();
    expect(await who(new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat }, logger }))).toBe('EZTest Bot');
    const bad = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: 'wrongPATwrongPAT1234' }, logger });
    const e = await bad.request('GET', '/_apis/testplan/configurations').catch((x) => x);
    expect(e).toBeInstanceOf(AdoAuthError);
    expect(e.status).toBe(203);
    expect(String(e.message) + lines.join('')).not.toContain('wrongPAT');
  });

  it('System.AccessToken (Bearer) is picked automatically in a pipeline', async () => {
    ado = await startMockAdoServer({ bearer: [SYS] });
    const auth = await resolveAdoAuth({ type: 'auto' }, { env: { SYSTEM_ACCESSTOKEN: SYS } });
    expect(auth).toEqual({ type: 'bearer', token: SYS });
    const c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth });
    expect(await who(c)).toBe('EZTest Bot');
    expect(ado.requests.at(-1)!.auth).toBe(`Bearer ${SYS}`);
    await expect(resolveAdoAuth({ type: 'system-access-token' }, { env: {} })).rejects.toThrow(/SYSTEM_ACCESSTOKEN/);
  });

  it('service principal with a client secret: client credentials grant, cached token, secret never echoed', async () => {
    ado = await startMockAdoServer({ entra });
    const auth = await resolveAdoAuth(
      { type: 'service-principal', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret://env/SP_SECRET', authorityHost: ado.url },
      { env: {}, resolveSecret: async (r) => (r === 'secret://env/SP_SECRET' ? SECRET : '') },
    );
    expect(auth.type).toBe('provider');
    const masker = new SecretMasker();
    const c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth, onSecret: (t) => masker.add(t) });
    expect(c.authKind).toBe('service-principal');
    await who(c);
    await who(c);
    const tokenCalls = ado.requests.filter((r) => r.path === '/tenant-1/oauth2/v2.0/token');
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toMatchObject({ grant_type: 'client_credentials', client_id: 'client-1', scope: '499b84ac-1321-427f-aa17-267ca6975798/.default', client_secret: SECRET });
    expect(ado.requests.at(-1)!.auth).toBe(`Bearer ${ado.state.entraTokens[0]}`);
    expect(masker.mask(`token ${ado.state.entraTokens[0]}`)).toBe('token ****');

    const wrong = await resolveAdoAuth({ type: 'service-principal', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'nope-not-the-secret', authorityHost: ado.url }, { env: {} });
    const e = await new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: wrong }).request('GET', '/_apis/testplan/configurations').catch((x) => x);
    expect(e).toBeInstanceOf(AdoTokenError);
    expect(e.message).toMatch(/AADSTS7000215/);
    expect(e.message).not.toContain('nope-not-the-secret');
  });

  it('workload identity federation from an Azure Pipelines service connection: no secret anywhere', async () => {
    ado = await startMockAdoServer({ entra: { ...entra, clientSecret: undefined }, bearer: [SYS], serviceConnectionId: 'conn-1' });
    const env = { SYSTEM_ACCESSTOKEN: SYS, SYSTEM_OIDCREQUESTURI: `${ado.url}/oidc` };
    const cfg = { type: 'auto' as const, tenantId: 'tenant-1', clientId: 'client-1', serviceConnectionId: 'conn-1', authorityHost: ado.url };
    const auth = await resolveAdoAuth(cfg, { env });
    expect(auth.type === 'provider' && auth.provider.kind).toBe('workload-identity');
    const c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth });
    expect(await who(c)).toBe('EZTest Bot');
    const oidc = ado.requests.find((r) => r.path === '/oidc')!;
    expect(oidc.query).toMatchObject({ serviceConnectionId: 'conn-1', 'api-version': '7.1' });
    expect(oidc.auth).toBe(`Bearer ${SYS}`);
    const tok = ado.requests.find((r) => r.path === '/tenant-1/oauth2/v2.0/token')!.body as Record<string, string>;
    expect(tok.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(tok.client_secret).toBeUndefined();

    // A federated credential for another subject is refused with Entra's explanation.
    const other = await startMockAdoServer({ entra: { ...entra, clientSecret: undefined, subject: 'sc://org/other/conn' }, bearer: [SYS], serviceConnectionId: 'conn-1' });
    try {
      const a2 = await resolveAdoAuth({ ...cfg, authorityHost: other.url }, { env: { ...env, SYSTEM_OIDCREQUESTURI: `${other.url}/oidc` } });
      const e = await new AdoClient({ baseUrl: other.collectionUrl, project: 'proj', auth: a2 }).request('GET', '/_apis/testplan/configurations').catch((x) => x);
      expect(e.message).toMatch(/AADSTS700213/);
    } finally {
      await other.close();
    }
  });

  it('workload identity from a projected token file (AKS) and from config through adoClientFromConfig', async () => {
    ado = await startMockAdoServer({ entra: { ...entra, clientSecret: undefined } });
    const dir = await mkdtemp(join(tmpdir(), 'eztest-wif-'));
    const file = join(dir, 'token');
    await writeFile(file, fakeJwt({ sub: 'sc://org/proj/eztest-conn', aud: 'api://AzureADTokenExchange', exp: Math.floor(Date.now() / 1000) + 300 }));
    const config = EzTestConfigSchema.parse({ ado: { organizationUrl: ado.collectionUrl, project: 'proj', auth: { type: 'workload-identity', tenantId: 'tenant-1', clientId: 'client-1', federatedTokenFile: file, authorityHost: ado.url } } });
    const c = await adoClientFromConfig(config, { env: {} });
    expect(c.authKind).toBe('workload-identity');
    expect(await who(c)).toBe('EZTest Bot');
  });

  it('managed identity through IMDS', async () => {
    ado = await startMockAdoServer();
    const auth = await resolveAdoAuth({ type: 'managed-identity', imdsUrl: ado.url }, { env: {} });
    const c = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth });
    expect(c.authKind).toBe('managed-identity');
    expect(await who(c)).toBe('EZTest Bot');
    expect(ado.requests.find((r) => r.path === '/metadata/identity/oauth2/token')!.query.resource).toBe('499b84ac-1321-427f-aa17-267ca6975798');
  });

  it('Azure DevOps Server: collection URL, an older api-version, and a clear error when the version is too new', async () => {
    ado = await startMockAdoServer({ collectionPath: '/tfs/DefaultCollection', maxApiVersion: '6.0' });
    const { planId, rootSuiteId } = ado.plan('Release 1');
    const cfgId = ado.configuration('Windows + Chrome');
    const tcs = [1, 2, 3, 4, 5].map((n) => ado!.workItem('Test Case', { 'System.Title': `TC ${n}` }).id);
    const suite = ado.suite(planId, rootSuiteId, 'Regression', tcs, [cfgId]);
    const onPrem = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat }, apiVersion: '6.0' });
    const points = await onPrem.getAll<{ id: number }>(`/_apis/testplan/Plans/${planId}/Suites/${suite}/TestPoint`);
    expect(points).toHaveLength(5);
    // paged 2 per page: three requests with continuation tokens
    expect(ado.requests.filter((r) => r.path.endsWith('/TestPoint')).map((r) => r.query.continuationToken ?? null)).toEqual([null, '2', '4']);
    expect(ado.requests.filter((r) => r.path.endsWith('/TestPoint')).every((r) => r.query['api-version'] === '6.0')).toBe(true);
    const tooNew = new AdoClient({ baseUrl: ado.collectionUrl, project: 'proj', auth: { type: 'pat', token: ado.pat } });
    await expect(tooNew.getAll(`/_apis/testplan/Plans/${planId}/Suites/${suite}/TestPoint`)).rejects.toThrow(/out of range for this server.*6\.0/);
    expect(onPrem.projectUrl).toBe(`${ado.collectionUrl}/proj`);
    expect(onPrem.identityUrl).toBe(ado.collectionUrl);
    // dev.azure.com organisations send identity calls to vssps
    expect(new AdoClient({ org: 'contoso', project: 'p', auth: { type: 'pat', token: 'x1234' } }).identityUrl).toBe('https://vssps.dev.azure.com/contoso');
  });
});
