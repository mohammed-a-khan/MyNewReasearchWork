/**
 * Enterprise secret stores against local fake servers that check what a
 * real service checks:
 *
 *   HashiCorp Vault       X-Vault-Token, namespace header, AppRole login (role_id /
 *                         secret_id), KV v2 paths, token expiry and revocation
 *   AWS Secrets Manager   the SigV4 signature recomputed here from the secret key
 *                         (independently of src/), X-Amz-Target, the JSON protocol
 *   GCP Secret Manager    the service-account JWT verified with the public key (iss,
 *                         scope, aud), the bearer token, CRC32C of the payload
 *   CyberArk CCP          mutual TLS (client certificate required), AppID / Safe / Object
 *
 * Each also resolves through config (identity.secretStores) and secret://.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsSecretsManagerStore, CyberArkCcpStore, GcpSecretManagerStore, HashiCorpVaultSecretStore, crc32c } from '../../src/identity/stores-cloud.js';
import { createSecretRegistry } from '../../src/identity/from-config.js';
import { IdentitySchema } from '../../src/config/schema.js';
import { SecretMasker } from '../../src/config/index.js';
import { hasOpenssl, makeTestPki } from '../support/ws-server.js';

function body(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d: Buffer) => (b += d));
    req.on('end', () => r(b));
  });
}

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('HashiCorp Vault (KV v2): token and AppRole', () => {
  let server: Server;
  let url: string;
  const seen: Array<{ path: string; token?: string; ns?: string }> = [];
  let issued = 0;
  let valid = new Set<string>(['root-token']);
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const b = await body(req);
      const send = (s: number, x: unknown) => {
        res.writeHead(s, { 'content-type': 'application/json' });
        res.end(JSON.stringify(x));
      };
      const path = (req.url ?? '').replace(/\?.*$/, '');
      seen.push({ path, token: req.headers['x-vault-token'] as string | undefined, ns: req.headers['x-vault-namespace'] as string | undefined });
      if (path === '/v1/auth/approle/login' && req.method === 'POST') {
        const { role_id, secret_id } = JSON.parse(b) as { role_id: string; secret_id: string };
        if (role_id !== 'ci-role' || secret_id !== 'ci-secret-id') return send(400, { errors: ['invalid role or secret ID'] });
        const t = `s.approle-${++issued}`;
        valid.add(t);
        return send(200, { auth: { client_token: t, lease_duration: 3600, renewable: true } });
      }
      if (!valid.has(String(req.headers['x-vault-token']))) return send(403, { errors: ['permission denied'] });
      if (req.headers['x-vault-namespace'] !== 'qa') return send(404, { errors: [] });
      if (path === '/v1/secret/data/apps/shop/db') return send(200, { data: { data: { password: 'Shop#Db1', user: 'shop' }, metadata: { version: 3 } } });
      if (path === '/v1/kv2/data/team/api') return send(200, { data: { data: { value: 'api-key-7' } } });
      if (path === '/v1/secret/data/apps/deleted') return send(200, { data: { data: null, metadata: { deleted_time: '2026-01-01T00:00:00Z' } } });
      return send(404, { errors: [] });
    });
    url = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reads KV v2 fields with a token and a namespace; missing and deleted secrets are undefined', async () => {
    const s = new HashiCorpVaultSecretStore({ address: url, namespace: 'qa', auth: { method: 'token', token: 'root-token' }, cacheTtlMs: 0 });
    expect(await s.get('apps/shop/db#password')).toBe('Shop#Db1');
    expect(await s.get('apps/shop/db#user')).toBe('shop');
    expect(await s.get('apps/shop/db#nope')).toBeUndefined();
    expect(await s.get('apps/missing#x')).toBeUndefined();
    expect(await s.get('apps/deleted#x')).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ token: 'root-token', ns: 'qa' });
    await expect(s.get('../sys/raw#x')).rejects.toThrow(/Invalid Vault secret path/);
    const denied = new HashiCorpVaultSecretStore({ address: url, namespace: 'qa', auth: { method: 'token', token: 'wrong' } });
    await expect(denied.get('apps/shop/db#password')).rejects.toMatchObject({ code: 'VAULT_FORBIDDEN', message: expect.stringMatching(/HTTP 403 for "apps\/shop\/db" \(permission denied\): the token lacks read access/) });
  });

  it('AppRole: logs in once, reuses the token, and logs in again when it is revoked', async () => {
    const s = new HashiCorpVaultSecretStore({ address: url, namespace: 'qa', mount: 'kv2', auth: { method: 'approle', roleId: 'ci-role', secretId: async () => 'ci-secret-id' }, cacheTtlMs: 0 });
    expect(await s.get('team/api')).toBe('api-key-7');
    expect(await s.get('team/api')).toBe('api-key-7');
    expect(s.logins).toBe(1);
    valid = new Set(); // every token revoked
    expect(await s.get('team/api')).toBe('api-key-7');
    expect(s.logins).toBe(2);
    const bad = new HashiCorpVaultSecretStore({ address: url, auth: { method: 'approle', roleId: 'ci-role', secretId: 'wrong' } });
    await expect(bad.get('team/api')).rejects.toThrow(/Vault AppRole login failed: HTTP 400 \(invalid role or secret ID\)/);
  });

  it('from config: the AppRole secret id is itself a secret:// reference to the env store', async () => {
    const identity = IdentitySchema.parse({ secretStores: [{ type: 'hashicorp-vault', name: 'vault', address: url, namespace: 'qa', mount: 'kv2', auth: { method: 'approle', roleId: 'ci-role', secretId: 'secret://env/VAULT_SECRET_ID' } }] });
    const reg = createSecretRegistry(identity.secretStores, { env: { VAULT_SECRET_ID: 'ci-secret-id' }, masker: new SecretMasker() });
    expect(await reg.resolve('secret://vault/team/api')).toBe('api-key-7');
  });
});

describe('AWS Secrets Manager (SigV4 checked by the fake service)', () => {
  let server: Server;
  let url: string;
  const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const calls: string[] = [];
  /** Recompute the Authorization header's signature like AWS does (independent of src/). */
  function verify(req: IncomingMessage, payload: string): boolean {
    const auth = String(req.headers.authorization ?? '');
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m || m[1] !== 'AKIDEXAMPLE') return false;
    const [, , day, region, service, signed, sig] = m;
    const canonicalHeaders = signed.split(';').map((h) => `${h}:${String(req.headers[h]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonical = ['POST', '/', '', canonicalHeaders, signed, createHash('sha256').update(payload).digest('hex')].join('\n');
    const sts = ['AWS4-HMAC-SHA256', String(req.headers['x-amz-date']), `${day}/${region}/${service}/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
    let k: Buffer = createHmac('sha256', `AWS4${SECRET}`).update(day).digest();
    for (const p of [region, service, 'aws4_request']) k = createHmac('sha256', k).update(p).digest();
    return createHmac('sha256', k).update(sts).digest('hex') === sig && signed.includes('x-amz-target') && signed.includes('host') && service === 'secretsmanager' && region === 'eu-west-1';
  }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const b = await body(req);
      const send = (s: number, x: unknown) => {
        res.writeHead(s, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify(x));
      };
      if (!verify(req, b)) return send(403, { __type: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' });
      if (req.headers['x-amz-target'] !== 'secretsmanager.GetSecretValue' || req.headers['content-type'] !== 'application/x-amz-json-1.1') return send(400, { __type: 'InvalidRequestException' });
      if (req.headers['x-amz-security-token'] !== 'sess-1') return send(403, { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' });
      const { SecretId } = JSON.parse(b) as { SecretId: string };
      calls.push(SecretId);
      if (SecretId === 'prod/shop/db') return send(200, { ARN: 'arn:aws:secretsmanager:eu-west-1:1:secret:prod/shop/db', SecretString: '{"username":"shop","password":"Aws#Db1"}' });
      if (SecretId === 'prod/shop/cert') return send(200, { SecretBinary: Buffer.from('binary-pem').toString('base64') });
      if (SecretId === 'locked') return send(400, { __type: 'com.amazonaws.secretsmanager#AccessDeniedException', message: 'not allowed' });
      return send(400, { __type: 'com.amazonaws.secretsmanager#ResourceNotFoundException', message: "Secrets Manager can't find the specified secret." });
    });
    url = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('GetSecretValue signed with SigV4; JSON fields, binary secrets, not found and access denied', async () => {
    const s = new AwsSecretsManagerStore({ region: 'eu-west-1', endpoint: `${url}/`, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, sessionToken: 'sess-1' }, cacheTtlMs: 0 });
    expect(await s.get('prod/shop/db#password')).toBe('Aws#Db1');
    expect(await s.get('prod/shop/db')).toBe('{"username":"shop","password":"Aws#Db1"}');
    expect(await s.get('prod/shop/cert')).toBe('binary-pem');
    expect(await s.get('prod/none')).toBeUndefined();
    await expect(s.get('locked')).rejects.toMatchObject({ code: 'AWS_FORBIDDEN' });
    const wrongKey = new AwsSecretsManagerStore({ region: 'eu-west-1', endpoint: `${url}/`, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-the-key', sessionToken: 'sess-1' } });
    await expect(wrongKey.get('prod/shop/db')).rejects.toThrow(/HTTP 403 InvalidSignatureException: The request signature we calculated does not match/);
  });

  it('from config: keys from the environment (AWS_* variables) or secret:// references', async () => {
    const identity = IdentitySchema.parse({ secretStores: [{ type: 'aws-secrets-manager', name: 'aws', region: 'eu-west-1', endpoint: `${url}/` }] });
    const reg = createSecretRegistry(identity.secretStores, { env: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: 'sess-1' }, masker: new SecretMasker() });
    expect(await reg.resolve('secret://aws/prod/shop/db#username')).toBe('shop');
  });
});

describe('GCP Secret Manager (service-account JWT, CRC32C)', () => {
  let server: Server;
  let url: string;
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let corrupt = false;
  let tokenReqs = 0;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const b = await body(req);
      const send = (s: number, x: unknown) => {
        res.writeHead(s, { 'content-type': 'application/json' });
        res.end(JSON.stringify(x));
      };
      if (req.url === '/token') {
        tokenReqs++;
        const f = Object.fromEntries(new URLSearchParams(b));
        const [h, p, sig] = String(f.assertion).split('.');
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
        const ok = f.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(sa.publicKey, Buffer.from(sig, 'base64url'))
          && claims.iss === 'ez-tests@demo-proj.iam.gserviceaccount.com' && claims.aud === `${url}/token` && claims.scope === 'https://www.googleapis.com/auth/cloud-platform' && JSON.parse(Buffer.from(h, 'base64url').toString()).kid === 'key-1';
        return ok ? send(200, { access_token: 'ya29.test-token', expires_in: 3599, token_type: 'Bearer' }) : send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      }
      if (req.headers.authorization !== 'Bearer ya29.test-token') return send(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
      const m = /^\/v1\/projects\/demo-proj\/secrets\/([\w-]+)\/versions\/(\w+):access$/.exec(req.url ?? '');
      if (!m) return send(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Secret not found' } });
      if (m[1] !== 'shop-db-password') return send(404, { error: { code: 404, status: 'NOT_FOUND' } });
      const data = Buffer.from(m[2] === '2' ? 'Gcp#Old' : 'Gcp#Db1');
      return send(200, { name: `projects/demo-proj/secrets/${m[1]}/versions/3`, payload: { data: data.toString('base64'), dataCrc32c: String(corrupt ? 1 : crc32c(data)) } });
    });
    url = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const key = () => JSON.stringify({ type: 'service_account', project_id: 'demo-proj', private_key_id: 'key-1', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'ez-tests@demo-proj.iam.gserviceaccount.com', token_uri: `${url}/token` });

  it('CRC32C matches the published check value', () => {
    expect(crc32c(Buffer.from('123456789')).toString(16)).toBe('e3069283');
  });

  it('gets an access token with a signed JWT, reads versions, checks the payload CRC32C', async () => {
    const s = new GcpSecretManagerStore({ endpoint: url, credentials: key(), cacheTtlMs: 0 });
    expect(await s.get('shop-db-password')).toBe('Gcp#Db1');
    expect(await s.get('shop-db-password@2')).toBe('Gcp#Old');
    expect(await s.get('unknown-secret')).toBeUndefined();
    expect(s.tokenRequests).toBe(1); // token reused
    corrupt = true;
    try {
      await expect(s.get('shop-db-password')).rejects.toMatchObject({ code: 'GCP_INTEGRITY' });
    } finally {
      corrupt = false;
    }
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = new GcpSecretManagerStore({ endpoint: url, credentials: key().replace(JSON.stringify(sa.privateKey.export({ type: 'pkcs8', format: 'pem' })).slice(1, -1), JSON.stringify(other.privateKey.export({ type: 'pkcs8', format: 'pem' })).slice(1, -1)) });
    await expect(forged.get('shop-db-password')).rejects.toThrow(/GCP token request failed: HTTP 400 invalid_grant: Invalid JWT Signature/);
    expect(tokenReqs).toBeGreaterThanOrEqual(2);
  });

  it('from config: the service-account key file relative to the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-gcp-'));
    await writeFile(join(dir, 'sa.json'), key());
    const identity = IdentitySchema.parse({ secretStores: [{ type: 'gcp-secret-manager', name: 'gcp', endpoint: url, credentialsFile: 'sa.json' }] });
    const reg = createSecretRegistry(identity.secretStores, { cwd: dir, env: {}, masker: new SecretMasker() });
    expect(await reg.resolve('secret://gcp/shop-db-password@2')).toBe('Gcp#Old');
  });
});

describe.skipIf(!hasOpenssl())('CyberArk CCP (mutual TLS)', () => {
  let server: Server;
  let url: string;
  const pki = hasOpenssl() ? makeTestPki() : undefined;
  beforeAll(async () => {
    server = createHttpsServer({ key: pki!.serverKey, cert: pki!.serverCert, ca: pki!.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const send = (s: number, x: unknown) => {
        res.writeHead(s, { 'content-type': 'application/json' });
        res.end(JSON.stringify(x));
      };
      const u = new URL(req.url ?? '/', 'https://x');
      if (u.pathname !== '/AIMWebService/api/Accounts') return send(404, {});
      const q = Object.fromEntries(u.searchParams);
      if (q.AppID !== 'EZTest_QA') return send(403, { ErrorCode: 'APPAP306E', ErrorMsg: 'Application is not authorised' });
      if (q.Safe === 'QA-Safe' && q.Object === 'shop-db') return send(200, { Content: 'Cyber#Db1', UserName: 'shop', Address: 'db.qa', Safe: 'QA-Safe', Folder: 'Root' });
      if (q.Safe === 'QA-Safe' && q.UserName === 'svc-batch') return send(200, { Content: 'Cyber#Batch', UserName: 'svc-batch' });
      return send(404, { ErrorCode: 'APPAP004E', ErrorMsg: 'Password object matching query not found' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('presents the client certificate; Safe/Object, a query, not found, an unauthorised AppID', async () => {
    const tls = { cert: pki!.clientCert, key: pki!.clientKey, ca: pki!.ca };
    const s = new CyberArkCcpStore({ url, appId: 'EZTest_QA', tls, cacheTtlMs: 0 });
    expect(await s.get('QA-Safe/shop-db')).toBe('Cyber#Db1');
    expect(await s.get('Safe=QA-Safe;UserName=svc-batch')).toBe('Cyber#Batch');
    expect(await s.get('QA-Safe/nothing')).toBeUndefined();
    const withSafe = new CyberArkCcpStore({ url, appId: 'EZTest_QA', safe: 'QA-Safe', tls });
    expect(await withSafe.get('shop-db')).toBe('Cyber#Db1');
    await expect(new CyberArkCcpStore({ url, appId: 'Other', tls }).get('QA-Safe/shop-db')).rejects.toThrow(/HTTP 403 APPAP306E: Application is not authorised/);
    await expect(new CyberArkCcpStore({ url, appId: 'EZTest_QA', tls: { ca: pki!.ca } }).get('QA-Safe/shop-db')).rejects.toThrow(/could not be reached/);
    await expect(s.get('Safe=QA;Bogus=1')).rejects.toThrow(/Unknown CyberArk CCP parameter "Bogus"/);
  });

  it('every store resolves through config and secret:// (credentials themselves from the env store)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-stores-'));
    await writeFile(join(dir, 'client.pem'), pki!.clientCert);
    await writeFile(join(dir, 'client.key'), pki!.clientKey);
    await writeFile(join(dir, 'ca.pem'), pki!.ca);
    const identity = IdentitySchema.parse({
      secretStores: [
        { type: 'env', prefix: 'EZ_' },
        { type: 'cyberark-ccp', name: 'cyberark', url, appId: 'EZTest_QA', clientCert: 'client.pem', clientKey: 'client.key', ca: 'ca.pem' },
      ],
    });
    const masker = new SecretMasker();
    const reg = createSecretRegistry(identity.secretStores, { cwd: dir, masker, env: {} });
    expect(await reg.resolve('secret://cyberark/QA-Safe/shop-db')).toBe('Cyber#Db1');
    expect(masker.mask('pw is Cyber#Db1')).not.toContain('Cyber#Db1');
  });
});

describe('secret stores from config (schema)', () => {
  it('validates each store type', () => {
    const ok = IdentitySchema.parse({ secretStores: [
      { type: 'hashicorp-vault', address: 'https://vault.qa:8200', namespace: 'qa', auth: { method: 'approle', roleId: 'r', secretId: 'secret://env/VAULT_SECRET_ID' } },
      { type: 'aws-secrets-manager', region: 'eu-west-1', accessKeyId: 'secret://env/AWS_KEY', secretAccessKey: 'secret://env/AWS_SECRET' },
      { type: 'gcp-secret-manager', project: 'p', credentialsFile: 'sa.json' },
      { type: 'cyberark-ccp', url: 'https://ccp.qa', appId: 'EZ', safe: 'S' },
    ] });
    expect(ok.secretStores.map((s) => s.type)).toEqual(['hashicorp-vault', 'aws-secrets-manager', 'gcp-secret-manager', 'cyberark-ccp']);
    expect(() => IdentitySchema.parse({ secretStores: [{ type: 'gcp-secret-manager', project: 'p' }] })).toThrow(/exactly one of credentialsFile or credentials/);
    expect(() => IdentitySchema.parse({ secretStores: [{ type: 'hashicorp-vault', address: 'https://v', auth: { method: 'kerberos' } }] })).toThrow();
  });
});
