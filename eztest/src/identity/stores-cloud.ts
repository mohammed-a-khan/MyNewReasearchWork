/**
 * Enterprise secret stores, each on its own REST API with EZTest's HTTP
 * client (no vendor SDK):
 *
 *   HashiCorp Vault       KV version 2, token or AppRole authentication (re-login when
 *                         the token expires or is refused), namespaces
 *   AWS Secrets Manager   GetSecretValue signed with EZTest's SigV4
 *   GCP Secret Manager    a service-account key signs a JWT for an access token
 *                         (RFC 7523), secret versions read with their CRC32C checked
 *   CyberArk CCP          the Central Credential Provider's REST API (AppID, Safe,
 *                         Object or a query), usually with a client certificate
 *
 * Keys of secret://<store>/<key>:
 *   vault     path/to/secret#field      (field default "value")
 *   aws       secret-id or secret-id#jsonField
 *   gcp       secret-name or secret-name@version   (default latest)
 *   cyberark  Safe/Object, or Object (with a configured safe), or a query "Safe=S;Object=O"
 * Values are cached for a while (default 5 minutes) and added to the masker.
 */
import { readFileSync } from 'node:fs';
import { EzTestError, type SecretStore } from '../core/index.js';
import { defaultMasker, type SecretMasker } from '../config/index.js';
import { envProxyFetch } from '../surfaces/proxy.js';
import { createTlsFetch } from '../surfaces/api-tls.js';
import { signRequest, type AwsCredentials } from './aws-sigv4.js';
import { signJwt } from './oauth.js';

type Secretish = string | (() => Promise<string>);
const reveal = async (v: Secretish | undefined) => (v === undefined ? undefined : typeof v === 'string' ? v : v());

interface Common {
  name?: string;
  /** Cache resolved values this long (default 5 min; 0 disables). */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  masker?: SecretMasker;
  timeoutMs?: number;
}

abstract class HttpSecretStore implements SecretStore {
  abstract readonly name: string;
  private readonly cache = new Map<string, { value: string; at: number }>();
  protected readonly masker: SecretMasker;
  protected readonly f: typeof fetch;

  constructor(protected readonly common: Common) {
    this.masker = common.masker ?? defaultMasker;
    this.f = common.fetch ?? envProxyFetch;
  }

  protected abstract load(key: string): Promise<string | undefined>;

  async get(key: string): Promise<string | undefined> {
    const ttl = this.common.cacheTtlMs ?? 300_000;
    const hit = this.cache.get(key);
    if (hit && ttl > 0 && Date.now() - hit.at < ttl) return hit.value;
    const v = await this.load(key);
    if (v === undefined) return undefined;
    this.masker.add(v);
    if (ttl > 0) this.cache.set(key, { value: v, at: Date.now() });
    return v;
  }

  protected async http(url: string, init: RequestInit, what: string): Promise<{ status: number; body: unknown; text: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.common.timeoutMs ?? 30_000);
    try {
      const res = await this.f(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      return { status: res.status, body, text };
    } catch (e) {
      throw new EzTestError(this.masker.mask(`${what}: ${url.replace(/\?.*$/, '')} could not be reached: ${(e as Error).message}`), 'SECRET_NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }
}

function field(json: unknown, f: string, where: string): string | undefined {
  if (!json || typeof json !== 'object') throw new EzTestError(`${where} is not a JSON object, so it has no field "${f}"`, 'SECRET_FORMAT');
  const v = (json as Record<string, unknown>)[f];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ------------------------------------------------------------------ HashiCorp Vault

export interface HashiCorpVaultOptions extends Common {
  /** https://vault.example:8200 */
  address: string;
  /** KV v2 mount (default "secret"). */
  mount?: string;
  /** Vault Enterprise namespace (X-Vault-Namespace). */
  namespace?: string;
  auth: { method: 'token'; token: Secretish } | { method: 'approle'; roleId: Secretish; secretId: Secretish; mount?: string };
}

export class HashiCorpVaultSecretStore extends HttpSecretStore {
  readonly name: string;
  private token?: { value: string; expiresAt?: number };
  private login?: Promise<string>;
  /** AppRole logins made (diagnostics/tests). */
  logins = 0;

  constructor(private readonly o: HashiCorpVaultOptions) {
    super(o);
    const u = new URL(o.address);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new EzTestError('Vault address must use https', 'VAULT_CONFIG');
    this.name = o.name ?? 'vault';
  }

  private headers(token: string): Record<string, string> {
    return { 'x-vault-token': token, accept: 'application/json', ...(this.o.namespace ? { 'x-vault-namespace': this.o.namespace } : {}) };
  }

  private async currentToken(): Promise<string> {
    if (this.o.auth.method === 'token') {
      const t = await reveal(this.o.auth.token);
      if (!t) throw new EzTestError('Vault token is empty', 'VAULT_CONFIG');
      this.masker.add(t);
      return t;
    }
    if (this.token && (this.token.expiresAt === undefined || Date.now() < this.token.expiresAt - 30_000)) return this.token.value;
    this.login ??= this.appRoleLogin().finally(() => (this.login = undefined));
    return this.login;
  }

  private async appRoleLogin(): Promise<string> {
    const a = this.o.auth as Extract<HashiCorpVaultOptions['auth'], { method: 'approle' }>;
    const roleId = await reveal(a.roleId);
    const secretId = await reveal(a.secretId);
    if (secretId) this.masker.add(secretId);
    this.logins++;
    const base = this.o.address.replace(/\/+$/, '');
    const r = await this.http(`${base}/v1/auth/${a.mount ?? 'approle'}/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.o.namespace ? { 'x-vault-namespace': this.o.namespace } : {}) }, body: JSON.stringify({ role_id: roleId, secret_id: secretId }) }, 'Vault AppRole login');
    const auth = (r.body as { auth?: { client_token?: string; lease_duration?: number } } | undefined)?.auth;
    if (r.status !== 200 || !auth?.client_token) {
      const errs = ((r.body as { errors?: string[] } | undefined)?.errors ?? []).join('; ');
      throw new EzTestError(`Vault AppRole login failed: HTTP ${r.status}${errs ? ` (${errs})` : ''}`, 'VAULT_AUTH', { status: r.status });
    }
    this.masker.add(auth.client_token);
    this.token = { value: auth.client_token, ...(auth.lease_duration ? { expiresAt: Date.now() + auth.lease_duration * 1000 } : {}) };
    return auth.client_token;
  }

  protected async load(key: string): Promise<string | undefined> {
    const [path, fieldName = 'value'] = key.split('#');
    if (!path || path.split('/').some((p) => !p || p === '..' || p === '.')) throw new EzTestError(`Invalid Vault secret path "${key}"`, 'VAULT_NAME');
    const base = this.o.address.replace(/\/+$/, '');
    const url = `${base}/v1/${this.o.mount ?? 'secret'}/data/${path.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.currentToken();
      const r = await this.http(url, { headers: this.headers(token) }, 'Vault');
      if (r.status === 404) return undefined;
      // An expired or revoked AppRole token: log in again once.
      if (r.status === 403 && this.o.auth.method === 'approle' && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (r.status !== 200) {
        const errs = ((r.body as { errors?: string[] } | undefined)?.errors ?? []).join('; ');
        throw new EzTestError(`Vault returned HTTP ${r.status} for "${path}"${errs ? ` (${errs})` : ''}${r.status === 403 ? ': the token lacks read access to this path' : ''}`, r.status === 403 ? 'VAULT_FORBIDDEN' : 'VAULT_HTTP', { status: r.status });
      }
      const data = (r.body as { data?: { data?: unknown; metadata?: { deleted_time?: string; destroyed?: boolean } } } | undefined)?.data;
      if (!data?.data) return undefined; // deleted or destroyed version
      return field(data.data, fieldName, `Vault secret "${path}"`);
    }
  }
}

// ------------------------------------------------------------------ AWS Secrets Manager

export interface AwsSecretsManagerOptions extends Common {
  region: string;
  /** Default https://secretsmanager.<region>.amazonaws.com (a VPC endpoint or a test server otherwise). */
  endpoint?: string;
  credentials: AwsCredentials | (() => Promise<AwsCredentials> | AwsCredentials);
  /** Version stage (default AWSCURRENT). */
  versionStage?: string;
}

export class AwsSecretsManagerStore extends HttpSecretStore {
  readonly name: string;
  constructor(private readonly o: AwsSecretsManagerOptions) {
    super(o);
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new EzTestError(`Invalid AWS region "${o.region}"`, 'AWS_CONFIG');
    this.name = o.name ?? 'aws';
  }

  protected async load(key: string): Promise<string | undefined> {
    const hash = key.indexOf('#');
    const id = hash < 0 ? key : key.slice(0, hash);
    const fieldName = hash < 0 ? undefined : key.slice(hash + 1);
    if (!/^[\w/+=.@:-]{1,2048}$/.test(id)) throw new EzTestError(`Invalid AWS secret id "${id}"`, 'AWS_NAME');
    const url = this.o.endpoint ?? `https://secretsmanager.${this.o.region}.amazonaws.com/`;
    const body = JSON.stringify({ SecretId: id, ...(this.o.versionStage ? { VersionStage: this.o.versionStage } : {}) });
    const creds = typeof this.o.credentials === 'function' ? await this.o.credentials() : this.o.credentials;
    this.masker.add(creds.secretAccessKey);
    if (creds.sessionToken) this.masker.add(creds.sessionToken);
    const { headers } = signRequest({ method: 'POST', url, region: this.o.region, service: 'secretsmanager', credentials: creds, body, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' } });
    const r = await this.http(url, { method: 'POST', headers, body }, 'AWS Secrets Manager');
    if (r.status !== 200) {
      const type = String((r.body as { __type?: string } | undefined)?.__type ?? '').split('#').pop() ?? '';
      if (type === 'ResourceNotFoundException') return undefined;
      const msg = (r.body as { message?: string; Message?: string } | undefined)?.message ?? (r.body as { Message?: string } | undefined)?.Message ?? '';
      throw new EzTestError(`AWS Secrets Manager returned HTTP ${r.status}${type ? ` ${type}` : ''}${msg ? `: ${msg}` : ''} for "${id}"`, type === 'AccessDeniedException' || r.status === 403 ? 'AWS_FORBIDDEN' : 'AWS_HTTP', { status: r.status });
    }
    const out = r.body as { SecretString?: string; SecretBinary?: string };
    const value = out.SecretString ?? (out.SecretBinary !== undefined ? Buffer.from(out.SecretBinary, 'base64').toString('utf8') : undefined);
    if (value === undefined) return undefined;
    if (!fieldName) return value;
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      throw new EzTestError(`AWS secret "${id}" is not JSON, so it has no field "${fieldName}"`, 'SECRET_FORMAT');
    }
    return field(json, fieldName, `AWS secret "${id}"`);
  }
}

// ------------------------------------------------------------------ GCP Secret Manager

export interface GcpServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
}

export interface GcpSecretManagerOptions extends Common {
  /** Project id (default: the key's project_id). */
  project?: string;
  /** The service-account key (JSON text, or a function returning it). */
  credentials: Secretish;
  /** Default https://secretmanager.googleapis.com */
  endpoint?: string;
}

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32C (Castagnoli), as Secret Manager reports it for payload integrity. */
export function crc32c(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC32C_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class GcpSecretManagerStore extends HttpSecretStore {
  readonly name: string;
  private token?: { value: string; expiresAt: number };
  private key?: GcpServiceAccountKey;
  /** Token requests made (diagnostics/tests). */
  tokenRequests = 0;

  constructor(private readonly o: GcpSecretManagerOptions) {
    super(o);
    this.name = o.name ?? 'gcp';
  }

  private async sa(): Promise<GcpServiceAccountKey> {
    if (this.key) return this.key;
    const text = await reveal(this.o.credentials);
    let k: GcpServiceAccountKey;
    try {
      k = JSON.parse(text ?? '') as GcpServiceAccountKey;
    } catch {
      throw new EzTestError('GCP service-account key is not valid JSON', 'GCP_CONFIG');
    }
    if (!k.client_email || !k.private_key) throw new EzTestError('GCP service-account key needs client_email and private_key', 'GCP_CONFIG');
    this.masker.add(k.private_key);
    this.key = k;
    return k;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const k = await this.sa();
    const tokenUri = k.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt({ iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 }, k.private_key, { alg: 'RS256', ...(k.private_key_id ? { kid: k.private_key_id } : {}) });
    this.tokenRequests++;
    const r = await this.http(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, 'GCP token');
    const b = r.body as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | undefined;
    if (r.status !== 200 || !b?.access_token) throw new EzTestError(`GCP token request failed: HTTP ${r.status}${b?.error ? ` ${b.error}${b.error_description ? `: ${b.error_description}` : ''}` : ''}`, 'GCP_AUTH', { status: r.status });
    this.masker.add(b.access_token);
    this.token = { value: b.access_token, expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000 };
    return b.access_token;
  }

  protected async load(key: string): Promise<string | undefined> {
    const m = /^([A-Za-z0-9_-]{1,255})(?:@(\d+|latest))?$/.exec(key);
    if (!m) throw new EzTestError(`Invalid GCP secret name "${key}" (name or name@version)`, 'GCP_NAME');
    const project = this.o.project ?? (await this.sa()).project_id;
    if (!project) throw new EzTestError('GCP secret store needs a project', 'GCP_CONFIG');
    const base = (this.o.endpoint ?? 'https://secretmanager.googleapis.com').replace(/\/+$/, '');
    const url = `${base}/v1/projects/${encodeURIComponent(project)}/secrets/${m[1]}/versions/${m[2] ?? 'latest'}:access`;
    for (let attempt = 0; ; attempt++) {
      const r = await this.http(url, { headers: { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' } }, 'GCP Secret Manager');
      if (r.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (r.status === 404) return undefined;
      if (r.status !== 200) {
        const msg = (r.body as { error?: { message?: string; status?: string } } | undefined)?.error;
        throw new EzTestError(`GCP Secret Manager returned HTTP ${r.status}${msg?.status ? ` ${msg.status}` : ''}${msg?.message ? `: ${msg.message}` : ''} for "${key}"`, r.status === 403 ? 'GCP_FORBIDDEN' : 'GCP_HTTP', { status: r.status });
      }
      const payload = (r.body as { payload?: { data?: string; dataCrc32c?: string | number } } | undefined)?.payload;
      if (payload?.data === undefined) return undefined;
      const bytes = Buffer.from(payload.data, 'base64');
      if (payload.dataCrc32c !== undefined && Number(payload.dataCrc32c) !== crc32c(bytes)) throw new EzTestError(`GCP secret "${key}" failed its CRC32C check (corrupted in transit)`, 'GCP_INTEGRITY');
      return bytes.toString('utf8');
    }
  }
}

// ------------------------------------------------------------------ CyberArk Central Credential Provider

export interface CyberArkCcpOptions extends Common {
  /** https://ccp.example.com (the AIMWebService host) */
  url: string;
  appId: string;
  /** Default safe for keys that name only the object. */
  safe?: string;
  folder?: string;
  /** Client certificate (PEM) / key / extra CA for the CCP's mutual TLS. */
  tls?: { cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string; ca?: Buffer };
  /** Default "AIMWebService". */
  path?: string;
}

export class CyberArkCcpStore extends HttpSecretStore {
  readonly name: string;
  constructor(private readonly o: CyberArkCcpOptions) {
    super(o.tls ? { ...o, fetch: o.fetch ?? createTlsFetch({ origin: new URL(o.url).origin, ...o.tls }) } : o);
    const u = new URL(o.url);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new EzTestError('CyberArk CCP URL must use https', 'CYBERARK_CONFIG');
    this.name = o.name ?? 'cyberark';
  }

  protected async load(key: string): Promise<string | undefined> {
    const q = new URLSearchParams({ AppID: this.o.appId });
    if (key.includes('=')) {
      // A CCP query: "Safe=S;Object=O" or "Safe=S;UserName=u;Address=a"
      for (const part of key.split(';')) {
        const [k, ...v] = part.split('=');
        if (!/^(?:Safe|Folder|Object|UserName|Address|Database|PolicyID|Reason|Query|QueryFormat)$/.test(k.trim())) throw new EzTestError(`Unknown CyberArk CCP parameter "${k}"`, 'CYBERARK_NAME');
        q.set(k.trim(), v.join('=').trim());
      }
    } else {
      const slash = key.indexOf('/');
      const safe = slash < 0 ? this.o.safe : key.slice(0, slash);
      const object = slash < 0 ? key : key.slice(slash + 1);
      if (!safe || !object) throw new EzTestError(`CyberArk key "${key}": use Safe/Object (or configure a safe)`, 'CYBERARK_NAME');
      q.set('Safe', safe);
      q.set('Object', object);
    }
    if (this.o.folder && !q.has('Folder')) q.set('Folder', this.o.folder);
    const url = `${this.o.url.replace(/\/+$/, '')}/${this.o.path ?? 'AIMWebService'}/api/Accounts?${q.toString()}`;
    const r = await this.http(url, { headers: { accept: 'application/json' } }, 'CyberArk CCP');
    if (r.status === 404) return undefined;
    if (r.status !== 200) {
      const b = r.body as { ErrorCode?: string; ErrorMsg?: string } | undefined;
      // APPAP004E: password object not found; APPAP306E / APPAP282E: application not authorised
      if (b?.ErrorCode === 'APPAP004E') return undefined;
      throw new EzTestError(`CyberArk CCP returned HTTP ${r.status}${b?.ErrorCode ? ` ${b.ErrorCode}` : ''}${b?.ErrorMsg ? `: ${b.ErrorMsg}` : ''}`, r.status === 403 ? 'CYBERARK_FORBIDDEN' : 'CYBERARK_HTTP', { status: r.status });
    }
    const content = (r.body as { Content?: string } | undefined)?.Content;
    return typeof content === 'string' ? content : undefined;
  }
}

/** A service-account key from a file path (JSON). */
export function readGcpKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new EzTestError(`Cannot read the GCP service-account key ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, 'GCP_CONFIG');
  }
}
