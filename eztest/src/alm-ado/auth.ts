/**
 * Azure DevOps credentials, without secrets in pipelines where possible:
 *
 *  - PAT (Basic auth), from a `secret://` reference or an `ENC()` value;
 *  - the pipeline's `System.AccessToken` (Bearer; map it with
 *    `env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`);
 *  - a Microsoft Entra ID service principal with a client secret
 *    (client credentials grant);
 *  - workload identity federation: the same grant with a federated client
 *    assertion instead of a secret. The assertion is an OIDC token from the
 *    Azure Pipelines service connection (System.OidcRequestUri), from GitHub
 *    Actions (ACTIONS_ID_TOKEN_REQUEST_URL) or a projected token file
 *    (AZURE_FEDERATED_TOKEN_FILE, e.g. AKS workload identity);
 *  - a managed identity (Azure VM / scale set agents through IMDS, App
 *    Service / Functions / Container Apps through IDENTITY_ENDPOINT).
 *
 * Tokens are cached until five minutes before they expire, never logged, and
 * registered with the client so every error message is redacted.
 */
import { readFile } from 'node:fs/promises';
import { EzTestError } from '../core/index.js';
import type { AccessTokenProvider, AdoAuth } from './client.js';

/** The Azure DevOps resource (application) id in Microsoft Entra ID. */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';
export const ADO_SCOPE = `${ADO_RESOURCE_ID}/.default`;
export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';

export class AdoTokenError extends EzTestError {
  constructor(message: string, readonly status?: number) {
    super(message, 'ADO_TOKEN', { status });
    this.name = 'AdoTokenError';
  }
}

type Fetch = typeof fetch;

function assertSecureUrl(u: string, what: string): URL {
  const url = new URL(u);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) throw new AdoTokenError(`${what}: refusing to send credentials over plain HTTP to ${url.host}`);
  return url;
}

/** Read a token endpoint's error without echoing anything that could hold a credential. */
async function tokenError(what: string, res: Response): Promise<AdoTokenError> {
  let detail = '';
  try {
    const j = (await res.json()) as { error?: string; error_description?: string; error_codes?: number[] };
    // AADSTS codes explain the cause (wrong subject, expired assertion, consent) without secrets.
    detail = [j.error, (j.error_description ?? '').split(/\r?\n/)[0].replace(/Trace ID.*$/, '').slice(0, 300)].filter(Boolean).join(': ');
  } catch {
    detail = `HTTP ${res.status}`;
  }
  return new AdoTokenError(`${what} failed (HTTP ${res.status}): ${detail}`, res.status);
}

export interface EntraOptions {
  tenantId: string;
  clientId: string;
  /** Client secret (service principal with a secret). */
  clientSecret?: string;
  /** Federated credential: returns a fresh OIDC token (workload identity federation). */
  clientAssertion?: () => Promise<string>;
  authorityHost?: string;
  scope?: string;
  fetchImpl?: Fetch;
}

/** Client credentials grant against Microsoft Entra ID (v2.0 endpoint), with a secret or a federated assertion. */
export function entraTokenProvider(o: EntraOptions): AccessTokenProvider {
  if (!/^[\w.-]+$/.test(o.tenantId)) throw new AdoTokenError('Entra ID: tenantId must be a tenant GUID or domain');
  if (!o.clientId) throw new AdoTokenError('Entra ID: clientId is required');
  if (!o.clientSecret && !o.clientAssertion) throw new AdoTokenError('Entra ID: a client secret or a federated client assertion is required');
  const f = o.fetchImpl ?? fetch;
  const authority = assertSecureUrl(o.authorityHost ?? DEFAULT_AUTHORITY, 'Entra ID authority').origin;
  const kind = o.clientAssertion ? 'workload-identity' : 'service-principal';
  return {
    kind,
    async getToken() {
      const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: o.clientId, scope: o.scope ?? ADO_SCOPE });
      if (o.clientAssertion) {
        form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        form.set('client_assertion', await o.clientAssertion());
      } else form.set('client_secret', o.clientSecret!);
      const res = await f(`${authority}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        redirect: 'manual',
      });
      if (!res.ok) throw await tokenError(`Entra ID ${kind} token`, res);
      const j = (await res.json()) as { access_token?: string; expires_in?: number | string };
      if (!j.access_token) throw new AdoTokenError(`Entra ID ${kind} token: no access_token in the response`);
      return { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    },
  };
}

export interface PipelineOidcOptions {
  /** The Azure Resource Manager service connection id (workload identity federation) configured for the pipeline. */
  serviceConnectionId: string;
  /** System.OidcRequestUri (env SYSTEM_OIDCREQUESTURI). */
  requestUri: string;
  /** System.AccessToken (env SYSTEM_ACCESSTOKEN), used only to request the OIDC token. */
  accessToken: string;
  fetchImpl?: Fetch;
}

/** OIDC token from an Azure Pipelines service connection (the federated assertion for Entra ID). */
export function pipelineOidcAssertion(o: PipelineOidcOptions): () => Promise<string> {
  const f = o.fetchImpl ?? fetch;
  return async () => {
    const u = assertSecureUrl(o.requestUri, 'System.OidcRequestUri');
    u.searchParams.set('api-version', '7.1');
    u.searchParams.set('serviceConnectionId', o.serviceConnectionId);
    const res = await f(u, { method: 'POST', headers: { authorization: `Bearer ${o.accessToken}`, 'content-type': 'application/json', accept: 'application/json' }, body: '{}', redirect: 'manual' });
    if (!res.ok) throw await tokenError('Azure Pipelines OIDC token request', res);
    const j = (await res.json()) as { oidcToken?: string };
    if (!j.oidcToken) throw new AdoTokenError('Azure Pipelines OIDC token request: no oidcToken in the response');
    return j.oidcToken;
  };
}

/** OIDC token from GitHub Actions (permissions: id-token: write). */
export function githubOidcAssertion(o: { requestUrl: string; requestToken: string; audience?: string; fetchImpl?: Fetch }): () => Promise<string> {
  const f = o.fetchImpl ?? fetch;
  return async () => {
    const u = assertSecureUrl(o.requestUrl, 'ACTIONS_ID_TOKEN_REQUEST_URL');
    u.searchParams.set('audience', o.audience ?? 'api://AzureADTokenExchange');
    const res = await f(u, { headers: { authorization: `Bearer ${o.requestToken}`, accept: 'application/json' }, redirect: 'manual' });
    if (!res.ok) throw await tokenError('GitHub Actions OIDC token request', res);
    const j = (await res.json()) as { value?: string };
    if (!j.value) throw new AdoTokenError('GitHub Actions OIDC token request: no value in the response');
    return j.value;
  };
}

/** A projected federated token file (re-read on every refresh: the platform rotates it). */
export function fileAssertion(path: string): () => Promise<string> {
  return async () => (await readFile(path, 'utf8')).trim();
}

export interface ManagedIdentityOptions {
  /** User-assigned identity's client id (omit for the system-assigned identity). */
  clientId?: string;
  env?: Record<string, string | undefined>;
  /** IMDS base (default http://169.254.169.254; overridable for tests). */
  imdsUrl?: string;
  fetchImpl?: Fetch;
}

/**
 * Managed identity: App Service style IDENTITY_ENDPOINT + IDENTITY_HEADER when
 * present, otherwise the Azure Instance Metadata Service (VM / scale set agents).
 * IMDS is link-local plain HTTP by design and is the one non-HTTPS endpoint allowed.
 */
export function managedIdentityProvider(o: ManagedIdentityOptions = {}): AccessTokenProvider {
  const env = o.env ?? process.env;
  const f = o.fetchImpl ?? fetch;
  return {
    kind: 'managed-identity',
    async getToken() {
      let res: Response;
      if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
        const u = new URL(env.IDENTITY_ENDPOINT);
        u.searchParams.set('api-version', '2019-08-01');
        u.searchParams.set('resource', ADO_RESOURCE_ID);
        if (o.clientId) u.searchParams.set('client_id', o.clientId);
        res = await f(u, { headers: { 'x-identity-header': env.IDENTITY_HEADER, accept: 'application/json' }, redirect: 'manual' });
      } else {
        const base = o.imdsUrl ?? 'http://169.254.169.254';
        const u = new URL('/metadata/identity/oauth2/token', base);
        if (!['169.254.169.254', '127.0.0.1', 'localhost'].includes(u.hostname)) throw new AdoTokenError('managed identity: IMDS must be 169.254.169.254');
        u.searchParams.set('api-version', '2018-02-01');
        u.searchParams.set('resource', ADO_RESOURCE_ID);
        if (o.clientId) u.searchParams.set('client_id', o.clientId);
        res = await f(u, { headers: { metadata: 'true', accept: 'application/json' }, redirect: 'manual' });
      }
      if (!res.ok) throw await tokenError('managed identity token', res);
      const j = (await res.json()) as { access_token?: string; expires_on?: string | number; expires_in?: string | number };
      if (!j.access_token) throw new AdoTokenError('managed identity token: no access_token in the response');
      const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.now() + Number(j.expires_in ?? 3600) * 1000;
      return { token: j.access_token, expiresAt };
    },
  };
}

export type AdoAuthType = 'auto' | 'pat' | 'system-access-token' | 'service-principal' | 'workload-identity' | 'managed-identity';

export interface AdoAuthConfig {
  type?: AdoAuthType;
  /** PAT or a secret reference to one. */
  pat?: string;
  tenantId?: string;
  clientId?: string;
  /** Client secret or a secret reference. */
  clientSecret?: string;
  /** Azure Pipelines service connection id for workload identity federation. */
  serviceConnectionId?: string;
  /** Where the federated assertion comes from (default: detected from the environment). */
  oidc?: 'azure-pipelines' | 'github-actions' | 'file';
  federatedTokenFile?: string;
  authorityHost?: string;
  /** Managed identity: user-assigned client id. */
  managedIdentityClientId?: string;
  imdsUrl?: string;
}

export interface ResolveAuthOptions {
  env?: Record<string, string | undefined>;
  /** Resolves `secret://` references (Identity Vault); ENC() values are already decrypted by the config loader. */
  resolveSecret?: (ref: string) => Promise<string>;
  fetchImpl?: Fetch;
}

/** Turn configuration and the environment into ADO credentials. "auto" picks: PAT, System.AccessToken, workload identity, service principal, then fails. */
export async function resolveAdoAuth(c: AdoAuthConfig, o: ResolveAuthOptions = {}): Promise<AdoAuth> {
  const env = o.env ?? process.env;
  const secret = async (v: string | undefined): Promise<string | undefined> => {
    if (!v || !v.startsWith('secret://')) return v;
    if (!o.resolveSecret) throw new AdoTokenError(`cannot resolve ${v} without an Identity Vault`);
    return o.resolveSecret(v);
  };
  const tenantId = c.tenantId ?? env.AZURE_TENANT_ID;
  const clientId = c.clientId ?? env.AZURE_CLIENT_ID;
  let type = c.type ?? 'auto';
  if (type === 'auto') {
    if (c.pat) type = 'pat';
    else if (tenantId && clientId && (c.serviceConnectionId || env.AZURE_FEDERATED_TOKEN_FILE || c.federatedTokenFile || env.ACTIONS_ID_TOKEN_REQUEST_URL)) type = 'workload-identity';
    else if (tenantId && clientId && (c.clientSecret || env.AZURE_CLIENT_SECRET)) type = 'service-principal';
    else if (env.SYSTEM_ACCESSTOKEN) type = 'system-access-token';
    else if (env.EZTEST_ADO_PAT || env.AZURE_DEVOPS_EXT_PAT) return { type: 'pat', token: (env.EZTEST_ADO_PAT ?? env.AZURE_DEVOPS_EXT_PAT)! };
    else throw new AdoTokenError('Azure DevOps credentials not found: set ado.pat (secret://...), map System.AccessToken to SYSTEM_ACCESSTOKEN, or configure ado.auth (service principal, workload identity or managed identity)');
  }
  switch (type) {
    case 'pat': {
      const t = (await secret(c.pat)) ?? env.EZTEST_ADO_PAT;
      if (!t) throw new AdoTokenError('ado.auth.type is pat but ado.pat is not set');
      return { type: 'pat', token: t };
    }
    case 'system-access-token': {
      if (!env.SYSTEM_ACCESSTOKEN) throw new AdoTokenError('SYSTEM_ACCESSTOKEN is not set; add `env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }` to the step');
      return { type: 'bearer', token: env.SYSTEM_ACCESSTOKEN };
    }
    case 'service-principal': {
      if (!tenantId || !clientId) throw new AdoTokenError('service principal: ado.auth.tenantId and clientId are required');
      const s = (await secret(c.clientSecret)) ?? env.AZURE_CLIENT_SECRET;
      if (!s) throw new AdoTokenError('service principal: ado.auth.clientSecret (secret://...) is required');
      return { type: 'provider', provider: entraTokenProvider({ tenantId, clientId, clientSecret: s, authorityHost: c.authorityHost, fetchImpl: o.fetchImpl }) };
    }
    case 'workload-identity': {
      if (!tenantId || !clientId) throw new AdoTokenError('workload identity: ado.auth.tenantId and clientId are required');
      const src = c.oidc ?? (c.serviceConnectionId && env.SYSTEM_OIDCREQUESTURI ? 'azure-pipelines' : env.ACTIONS_ID_TOKEN_REQUEST_URL ? 'github-actions' : 'file');
      let assertion: () => Promise<string>;
      if (src === 'azure-pipelines') {
        if (!c.serviceConnectionId) throw new AdoTokenError('workload identity: ado.auth.serviceConnectionId is required in Azure Pipelines');
        if (!env.SYSTEM_OIDCREQUESTURI || !env.SYSTEM_ACCESSTOKEN) throw new AdoTokenError('workload identity: SYSTEM_OIDCREQUESTURI and SYSTEM_ACCESSTOKEN must be mapped into the step environment');
        assertion = pipelineOidcAssertion({ serviceConnectionId: c.serviceConnectionId, requestUri: env.SYSTEM_OIDCREQUESTURI, accessToken: env.SYSTEM_ACCESSTOKEN, fetchImpl: o.fetchImpl });
      } else if (src === 'github-actions') {
        if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new AdoTokenError('workload identity: the GitHub job needs `permissions: id-token: write`');
        assertion = githubOidcAssertion({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, fetchImpl: o.fetchImpl });
      } else {
        const file = c.federatedTokenFile ?? env.AZURE_FEDERATED_TOKEN_FILE;
        if (!file) throw new AdoTokenError('workload identity: no assertion source (service connection, GitHub OIDC or AZURE_FEDERATED_TOKEN_FILE)');
        assertion = fileAssertion(file);
      }
      return { type: 'provider', provider: entraTokenProvider({ tenantId, clientId, clientAssertion: assertion, authorityHost: c.authorityHost ?? env.AZURE_AUTHORITY_HOST, fetchImpl: o.fetchImpl }) };
    }
    case 'managed-identity':
      return { type: 'provider', provider: managedIdentityProvider({ clientId: c.managedIdentityClientId ?? clientId, env, imdsUrl: c.imdsUrl, fetchImpl: o.fetchImpl }) };
  }
}
