/**
 * EZTest configuration schema. Every layer (defaults, files, .env, EZTEST_*
 * variables, CLI overrides) is merged and then validated against this schema.
 */
import { z } from 'zod';
import { ApiSpecOptionsSchema, ContractsSchema } from '../contracts/config.js';
import { BatchSchema, FilesSchema, GrpcSchema, MessagingSchema } from '../integration/config.js';
import { SoapConfigSchema } from '../surfaces/soap-config.js';

const positiveMs = z.number().int().positive();

export const TimeoutsSchema = z.object({
  /** Per-step action timeout. */
  step: positiveMs.default(15_000),
  navigation: positiveMs.default(30_000),
  journey: positiveMs.default(300_000),
  api: positiveMs.default(30_000),
  db: positiveMs.default(30_000),
});

export const HealingSchema = z.object({
  enabled: z.boolean().default(true),
  /** Highest tier the healer may use. */
  maxTier: z.enum(['T0-cache', 'T1-fingerprint', 'T2-semantic']).default('T2-semantic'),
  /** A heal only counts when the step's post-conditions still hold. */
  requireVerification: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.7),
  /** Write healed locators back into journey files automatically. */
  autoApply: z.boolean().default(false),
});

/** EZTest time-travel trace (per-step DOM snapshots, network, console, action metadata). Off by default. */
export const TimeTravelSchema = z.object({
  enabled: z.boolean().default(false),
  dom: z.boolean().default(true),
  network: z.boolean().default(true),
  console: z.boolean().default(true),
  screenshots: z.boolean().default(true),
  /** Text/JSON bodies are kept up to this many bytes (0: no bodies). */
  maxBodyBytes: z.number().int().min(0).max(10 * 1024 * 1024).default(65536),
});

export const TraceSchema = z.object({
  timeTravel: TimeTravelSchema.prefault({}),
  /**
   * Browser trace zip (written by the EZTest driver) per journey attempt: off, on (always kept), on-failure /
   * retain-on-failure (recorded always, kept only when the attempt did not pass).
   */
  browser: z.enum(['off', 'on', 'on-failure', 'retain-on-failure']).default('off'),
});

export const RoleFieldsSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  totp: z.string().min(1).optional(),
  submit: z.string().min(1).optional(),
  totpSubmit: z.string().min(1).optional(),
});

export const RoleApiSchema = z.object({
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  /** Secret reference; not needed with clientAuth private_key_jwt or none. */
  clientSecret: z.string().min(1).optional(),
  scope: z.string().optional(),
  audience: z.string().optional(),
  /** OAuth grant (docs/api-contracts.md, "OAuth for API steps"); default client_credentials. */
  grant: z.enum(['client_credentials', 'password', 'authorization_code', 'device_code', 'jwt_bearer', 'refresh_token']).optional(),
  clientAuth: z.enum(['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none']).optional(),
  /** private_key_jwt client authentication: a PEM key (secret reference). */
  clientKey: z.object({ privateKey: z.string().min(1), alg: z.enum(['RS256', 'PS256', 'ES256']).optional(), kid: z.string().optional() }).optional(),
  /** jwt_bearer grant: the assertion's key and claims. */
  assertion: z.object({ privateKey: z.string().min(1), subject: z.string().min(1), issuer: z.string().optional(), audience: z.string().optional(), alg: z.enum(['RS256', 'PS256', 'ES256']).optional(), kid: z.string().optional() }).optional(),
  /** authorization_code grant (PKCE): EZTest's browser signs in as the role at authorizeUrl; the redirect is intercepted. */
  authorizeUrl: z.string().min(1).optional(),
  redirectUri: z.string().url().optional(),
  /** device_code grant: approved in EZTest's browser as the role. */
  deviceAuthorizationUrl: z.string().min(1).optional(),
  /** refresh_token grant: a stored refresh token (secret reference). */
  refreshToken: z.string().min(1).optional(),
  /** Refresh tokens this many seconds before they expire (default 60). */
  skewSeconds: z.number().int().min(0).optional(),
}).superRefine((a, ctx) => {
  const grant = a.grant ?? 'client_credentials';
  if (grant === 'authorization_code' && (!a.authorizeUrl || !a.redirectUri)) ctx.addIssue({ code: 'custom', message: 'the authorization_code grant needs authorizeUrl and redirectUri' });
  if (grant === 'device_code' && !a.deviceAuthorizationUrl) ctx.addIssue({ code: 'custom', message: 'the device_code grant needs deviceAuthorizationUrl' });
  if (grant === 'jwt_bearer' && !a.assertion) ctx.addIssue({ code: 'custom', message: 'the jwt_bearer grant needs assertion: { privateKey, subject }' });
  if (grant === 'refresh_token' && !a.refreshToken) ctx.addIssue({ code: 'custom', message: 'the refresh_token grant needs refreshToken' });
  if (a.clientAuth === 'private_key_jwt' && !a.clientKey) ctx.addIssue({ code: 'custom', message: 'clientAuth private_key_jwt needs clientKey: { privateKey }' });
  if (grant === 'client_credentials' && !a.clientSecret && a.clientAuth !== 'private_key_jwt') ctx.addIssue({ code: 'custom', message: 'client credentials need clientSecret (or clientAuth: private_key_jwt with clientKey)' });
});

/** Which login recipe the vault uses for a role. */
export const RoleLoginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('form') }),
  z.object({
    /** Microsoft Entra ID (Azure AD): identifier-first, password, optional TOTP, "Stay signed in?", account picker. */
    type: z.literal('entra'),
    /** Tenant domain or id, used as domain_hint on the authorize URL (optional). */
    tenantHint: z.string().optional(),
    /** Answer "Stay signed in?" with Yes (default) or No. */
    staySignedIn: z.boolean().default(true),
    /** Add prompt=login to an /authorize URL so cached Kerberos/SSO sign-in cannot skip the credentials (default true). */
    promptLogin: z.boolean().default(true),
  }),
]);

/**
 * A password derived from a rule instead of stored (a migration aid for shared test
 * accounts whose password rotates on a schedule). Prefer a vault.
 */
export const PasswordRotationSchema = z.object({
  type: z.string().min(1),
}).catchall(z.unknown());

export const RoleSchema = z
  .object({
    /** Plain username or a secret reference. Not needed for an API-only role (just `api:`). */
    username: z.string().min(1).optional(),
    /** Secret reference (secret://store/key) or ENC(...) value. Optional when `passwordRotation` is set. */
    password: z.string().min(1).optional(),
    /** Derive the password from a rotation provider (see docs/configuration.md). */
    passwordRotation: PasswordRotationSchema.optional(),
    totp: z.string().min(1).optional(),
    /** Where the browser signs in. Not needed for an API-only role. */
    loginUrl: z.string().min(1).optional(),
    flow: z.literal('form').default('form'),
    /** Login recipe; default the generic form login. */
    login: RoleLoginSchema.optional(),
    fields: RoleFieldsSchema.optional(),
    successUrl: z.string().optional(),
    verifyUrl: z.string().optional(),
    api: RoleApiSchema.optional(),
  })
  .superRefine((r, ctx) => {
    // A role either signs in to a browser (username, password, loginUrl) or is an API-only machine
    // identity (OAuth2 client credentials under `api:`), or both.
    const browser = r.username !== undefined || r.loginUrl !== undefined || r.password !== undefined || r.passwordRotation !== undefined || r.totp !== undefined;
    if (!browser && r.api) return;
    if (!browser) {
      ctx.addIssue({ code: 'custom', path: ['username'], message: 'a role needs a browser sign-in (username, password, loginUrl) or API credentials (api: tokenUrl, clientId, clientSecret)' });
      return;
    }
    if (r.username === undefined) ctx.addIssue({ code: 'custom', path: ['username'], message: 'a role that signs in to a browser needs "username"' });
    const idpSignIn = ['password', 'authorization_code', 'device_code'].includes(r.api?.grant ?? '');
    if (r.loginUrl === undefined && !idpSignIn) ctx.addIssue({ code: 'custom', path: ['loginUrl'], message: 'a role that signs in to a browser needs "loginUrl"' });
    if (r.password === undefined && r.passwordRotation === undefined) ctx.addIssue({ code: 'custom', path: ['password'], message: 'a role needs "password" or "passwordRotation"' });
  });

export const SecretStoreConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('env'), name: z.string().optional(), prefix: z.string().default('') }),
  z.object({ type: z.literal('file'), name: z.string().optional(), path: z.string().min(1) }),
  z.object({
    type: z.literal('azure-keyvault'),
    name: z.string().optional(),
    vaultUrl: z.string().url(),
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    authorityUrl: z.string().url().optional(),
  }),
  /** HashiCorp Vault KV v2: secret://<name>/path/to/secret#field. Credentials may be secret:// references to earlier stores. */
  z.object({
    type: z.literal('hashicorp-vault'),
    name: z.string().optional(),
    address: z.string().url(),
    mount: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    auth: z.discriminatedUnion('method', [
      z.object({ method: z.literal('token'), token: z.string().min(1) }),
      z.object({ method: z.literal('approle'), roleId: z.string().min(1), secretId: z.string().min(1), mount: z.string().min(1).optional() }),
    ]),
    /** Extra CA (PEM file) for a Vault with a private certificate. */
    ca: z.string().min(1).optional(),
  }),
  /** AWS Secrets Manager: secret://<name>/secret-id[#jsonField]. Default credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN. */
  z.object({
    type: z.literal('aws-secrets-manager'),
    name: z.string().optional(),
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    sessionToken: z.string().min(1).optional(),
    versionStage: z.string().min(1).optional(),
  }),
  /** GCP Secret Manager: secret://<name>/secret-name[@version]. The service-account key from a file or a secret reference. */
  z.object({
    type: z.literal('gcp-secret-manager'),
    name: z.string().optional(),
    project: z.string().min(1).optional(),
    credentialsFile: z.string().min(1).optional(),
    credentials: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
  }).refine((s) => !!s.credentialsFile !== !!s.credentials, { message: 'gcp-secret-manager needs exactly one of credentialsFile or credentials' }),
  /** CyberArk Central Credential Provider: secret://<name>/Safe/Object (or a query Safe=..;Object=..). */
  z.object({
    type: z.literal('cyberark-ccp'),
    name: z.string().optional(),
    url: z.string().url(),
    appId: z.string().min(1),
    safe: z.string().min(1).optional(),
    folder: z.string().min(1).optional(),
    /** Client certificate and key (PEM files) for the CCP's mutual TLS; extra CA. */
    clientCert: z.string().min(1).optional(),
    clientKey: z.string().min(1).optional(),
    passphrase: z.string().min(1).optional(),
    ca: z.string().min(1).optional(),
  }),
]);

/** One pooled account of a role: username plus a secret reference (or ENC(...)) for its password. */
export const PoolAccountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totp: z.string().min(1).optional(),
});

export const IdentitySchema = z.object({
  sessionDir: z.string().default('.eztest/sessions'),
  sessionMaxAgeMinutes: z.number().positive().default(30),
  /** Refresh a cached session this many minutes before it reaches sessionMaxAgeMinutes (so it cannot expire mid-journey). */
  sessionRefreshMarginMinutes: z.number().min(0).default(5),
  secretStores: z.array(SecretStoreConfigSchema).default([]),
  roles: z.record(z.string(), RoleSchema).default({}),
  /**
   * Account pools: N accounts per role, leased per journey (data lease registry), so parallel workers never
   * share one user. A role with a pool signs in as whichever account it leased.
   */
  pools: z.record(z.string(), z.object({
    accounts: z.array(PoolAccountSchema).min(1),
    /** How long to wait for a free account before failing (default 60 s). */
    waitSeconds: z.number().int().min(0).default(60),
  })).default({}),
  /** Lockout protection: stop logging in as an account after repeated failures instead of locking it. */
  lockout: z.object({
    maxFailures: z.number().int().min(1).default(3),
    windowMinutes: z.number().positive().default(30),
    /** Back-off between attempts after a failure (doubles each time). */
    backoffMs: z.number().int().min(0).default(2000),
  }).prefault({}),
});

/** A port: a number, or digits (a port from ${ENV} interpolation is text). */
const dbPort = z.preprocess((v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v), z.number().int().positive()).optional();

/** Where EZTest gets Entra ID tokens for SQL Server: the driver's own Azure libraries, or EZTest's OAuth client. */
const entraTokenSource = z.enum(['driver', 'eztest']).optional();

/** SQL Server authentication (docs/databases.md, "SQL Server authentication"). Secrets may be secret:// references. */
export const MssqlAuthSchema = z.discriminatedUnion('type', [
  /** SQL Server login: user + password. */
  z.object({ type: z.literal('sql') }),
  /** Windows / NTLM: domain\user + password (tedious, any platform). */
  z.object({ type: z.literal('ntlm'), domain: z.string().min(1).optional() }),
  /** Windows integrated (Kerberos): the msnodesqlv8 driver with the Microsoft ODBC driver and a Kerberos ticket (kinit on Linux). */
  z.object({ type: z.literal('kerberos'), odbcDriver: z.string().min(1).optional() }),
  /** Microsoft Entra ID user + password. */
  z.object({ type: z.literal('entra-password'), clientId: z.string().min(1), tenantId: z.string().min(1).optional(), tokenSource: entraTokenSource, authorityUrl: z.string().url().optional() }),
  /** Microsoft Entra ID service principal with a client secret. */
  z.object({ type: z.literal('entra-service-principal'), clientId: z.string().min(1), clientSecret: z.string().min(1), tenantId: z.string().min(1), tokenSource: entraTokenSource, authorityUrl: z.string().url().optional() }),
  /** Microsoft Entra ID managed identity (system-assigned, or user-assigned with clientId). */
  z.object({ type: z.literal('entra-managed-identity'), clientId: z.string().min(1).optional(), tokenSource: entraTokenSource, endpoint: z.string().url().optional() }),
  /** A ready Microsoft Entra ID access token (e.g. secret://vault/SQL_TOKEN). */
  z.object({ type: z.literal('entra-access-token'), token: z.string().min(1) }),
  /** The Azure libraries' default credential chain (environment, managed identity, Azure CLI). */
  z.object({ type: z.literal('entra-default'), clientId: z.string().min(1).optional() }),
]);

const DbConnectionUnion = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), file: z.string().min(1) }),
  z.object({
    driver: z.literal('postgres'),
    connectionString: z.string().min(1).optional(),
    host: z.string().optional(),
    port: dbPort,
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    ssl: z.union([z.boolean(), z.object({ rejectUnauthorized: z.boolean().default(true), ca: z.string().optional() })]).optional(),
  }),
  z.object({
    driver: z.literal('mssql'),
    /** mssql://user:pass@host:1433/db?encrypt=true or an ADO.NET string (Server=...;Database=...;Authentication=...); the fields below win over it. */
    connectionString: z.string().min(1).optional(),
    server: z.string().min(1).optional(),
    port: dbPort,
    instanceName: z.string().min(1).optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    /** Windows domain for NTLM (also "DOMAIN\\user" in user). */
    domain: z.string().optional(),
    /** TLS on (default true) and the certificate verified (trustServerCertificate default false). */
    encrypt: z.boolean().optional(),
    trustServerCertificate: z.boolean().optional(),
    authentication: MssqlAuthSchema.optional(),
  }),
  z.object({
    driver: z.literal('oracle'),
    host: z.string().min(1).optional(),
    port: dbPort,
    serviceName: z.string().min(1).optional(),
    sid: z.string().min(1).optional(),
    /** Easy Connect string ("host:1521/SERVICE") or a full descriptor; wins over host/serviceName/sid. */
    connectString: z.string().min(1).optional(),
    user: z.string().optional(),
    /** Secret reference (secret://store/key) or ENC(...) value. */
    password: z.string().optional(),
    pool: z.object({ min: z.number().int().min(0).default(0), max: z.number().int().min(1).max(100).default(4), increment: z.number().int().min(1).optional() }).optional(),
    /** Wallet directory (mTLS, Autonomous Database); Thin mode reads ewallet.pem. */
    walletLocation: z.string().min(1).optional(),
    walletPassword: z.string().optional(),
    /** Directory holding tnsnames.ora when connectString is a TNS alias. */
    configDir: z.string().min(1).optional(),
    /** Return these Oracle types as strings instead of numbers / Dates / objects. */
    fetchAsString: z.array(z.enum(['NUMBER', 'DATE', 'TIMESTAMP', 'CLOB', 'NCLOB', 'JSON', 'RAW'])).optional(),
    callTimeoutMs: z.number().int().positive().optional(),
  }),
]);

const DRIVER_ALIASES: Record<string, string> = { postgresql: 'postgres', pg: 'postgres', sqlserver: 'mssql', 'sql-server': 'mssql', oracledb: 'oracle' };

/** A database connection. `type:` is accepted as an alias of `driver:` (and postgresql/sqlserver as driver aliases). */
export const DbConnectionSchema = z.preprocess((v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  if (o.driver === undefined && typeof o.type === 'string') {
    o.driver = o.type;
    delete o.type;
  }
  if (typeof o.driver === 'string') o.driver = DRIVER_ALIASES[o.driver.toLowerCase()] ?? o.driver.toLowerCase();
  return o;
}, DbConnectionUnion.superRefine((c, ctx) => {
  if (c.driver === 'oracle' && !c.connectString && !(c.host && (c.serviceName || c.sid))) {
    ctx.addIssue({ code: 'custom', message: 'oracle connections need connectString, or host with serviceName or sid' });
  }
  if (c.driver === 'oracle' && c.serviceName && c.sid) ctx.addIssue({ code: 'custom', message: 'oracle: use serviceName or sid, not both' });
  if (c.driver === 'mssql' && !c.server && !c.connectionString) ctx.addIssue({ code: 'custom', message: 'mssql connections need server or connectionString' });
}));

/**
 * The named-query catalogue: one NAME.sql file per query under `dir` (or the
 * listed `files`), plus `inline` queries. SQL is bind-parameter only (:name or ?);
 * `{{> name}}` includes another catalogue entry as text.
 */
export const DbQueriesSchema = z.object({
  dir: z.string().min(1).default('queries'),
  files: z.array(z.string().min(1)).optional(),
  inline: z.record(z.string().regex(/^[A-Za-z_][\w.-]*$/, 'query names: letters, digits, _ . -'), z.string().min(1)).default({}),
});


export const DataEntitySchema = z.object({
  provider: z.enum(['sql', 'api', 'synthetic']),
  /** sql: connection name; api: base URL key. */
  connection: z.string().optional(),
  table: z.string().optional(),
  key: z.string().default('id'),
  columns: z.record(z.string(), z.string()).optional(),
  /**
   * sql: values for records the fabric creates when none matches (field -> value, or "gen:<generator>"
   * such as "gen:fullName" or "gen:email"); the constraints of the need are applied on top.
   */
  defaults: z.record(z.string(), z.unknown()).optional(),
  createPath: z.string().optional(),
  findPath: z.string().optional(),
  deletePath: z.string().optional(),
});

export const DataSchema = z.object({
  seed: z.union([z.number().int(), z.string()]).default(42),
  leaseDir: z.string().default('.eztest/leases'),
  leaseTtlSeconds: z.number().int().positive().default(900),
  /** Named external data connections (API bases etc.). */
  connections: z.record(z.string(), z.object({ baseUrl: z.string().url(), auth: z.string().optional() })).default({}),
  entities: z.record(z.string(), DataEntitySchema).default({}),
});

export const AdoSchema = z.object({
  enabled: z.boolean().default(false),
  organizationUrl: z.string().url().optional(),
  project: z.string().optional(),
  /** Secret reference for the personal access token. */
  pat: z.string().optional(),
  testPlanId: z.number().int().positive().optional(),
  testSuiteId: z.number().int().positive().optional(),
  publishResults: z.boolean().default(false),
  createBugs: z.boolean().default(false),
  /** REST api-version (Azure DevOps Server: e.g. "6.0" for 2020, "7.0" for 2022). Default 7.1. */
  apiVersion: z.string().regex(/^\d+\.\d+$/).optional(),
  /** How EZTest authenticates (see docs/azure-devops.md). Default "auto". */
  auth: z
    .object({
      type: z.enum(['auto', 'pat', 'system-access-token', 'service-principal', 'workload-identity', 'managed-identity']).default('auto'),
      tenantId: z.string().optional(),
      clientId: z.string().optional(),
      /** Secret reference for a service principal's client secret. */
      clientSecret: z.string().optional(),
      serviceConnectionId: z.string().optional(),
      oidc: z.enum(['azure-pipelines', 'github-actions', 'file']).optional(),
      federatedTokenFile: z.string().optional(),
      authorityHost: z.string().url().optional(),
      managedIdentityClientId: z.string().optional(),
    })
    .prefault({}),
  /** Azure Repos repository name (PR status and comment, heal PRs). Default: from the git remote. */
  repository: z.string().optional(),
  /** Browser or environment name -> test configuration id or name (results go to that configuration's test points). */
  configurations: z.record(z.string(), z.union([z.number().int().positive(), z.string().min(1)])).default({}),
  /** Default area and iteration paths for bugs and created test cases. */
  areaPath: z.string().optional(),
  iterationPath: z.string().optional(),
  /** Area/iteration by journey tag or journey file glob (first match wins). */
  paths: z
    .array(z.object({ tag: z.string().optional(), journeys: z.string().optional(), areaPath: z.string().optional(), iterationPath: z.string().optional() }))
    .default([]),
  /** Post a result summary comment on the requirements (user stories) journeys trace to. */
  commentOnRequirements: z.boolean().default(false),
  /** Mark retried-then-passed and history-flaky results as flaky through the flaky-test API. */
  markFlaky: z.boolean().default(false),
});

/** Git and hosting-provider integration (docs/git.md). */
export const VcsSchema = z.object({
  /** Force the hosting provider (default: detected from the remote URL and CI variables). */
  provider: z.enum(['azure-devops', 'github', 'gitlab', 'bitbucket']).optional(),
  /** Self-hosted domains -> provider, e.g. { "git.corp.example": "gitlab" }. */
  hosts: z.record(z.string(), z.enum(['azure-devops', 'github', 'gitlab', 'bitbucket'])).default({}),
  /** API base override (GitHub Enterprise, self-managed GitLab). */
  apiUrl: z.string().url().optional(),
  /** Secret reference for the host's token (GitHub, GitLab, Bitbucket). CI tokens are read from the environment otherwise. */
  token: z.string().optional(),
  /** Per-branch history (flaky scores), visual baselines and Quality Center filters. */
  branchScope: z
    .object({ history: z.boolean().default(false), baselines: z.boolean().default(false), defaultBranch: z.string().default('main') })
    .prefault({}),
  /** Open a branch + commit + pull request when these Studio actions write files. */
  pullRequests: z
    .object({
      onHealAccept: z.boolean().default(false),
      onBaselineApprove: z.boolean().default(false),
      onQuarantine: z.boolean().default(false),
      target: z.string().optional(),
      draft: z.boolean().default(false),
    })
    .prefault({}),
  /** CODEOWNERS owner -> e-mail for work item assignment, e.g. { "@alice": "alice@contoso.com" }. */
  owners: z.record(z.string(), z.string()).default({}),
});

/** A TLS client certificate (mTLS) for API calls and the browser. */
export const ClientCertificateSchema = z
  .object({
    /** Name used by "with client certificate \"name\"" on API steps. */
    name: z.string().min(1).optional(),
    /** Origin the certificate is presented to, e.g. https://api.example.com (or https://api.example.com:8443). */
    origin: z.string().url(),
    /** PKCS#12 file (.pfx/.p12), relative to the project. */
    pfx: z.string().min(1).optional(),
    /** PEM certificate and key files (instead of pfx). */
    cert: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    /** Passphrase: secret://store/key or ENC(...). */
    passphrase: z.string().optional(),
    /** Extra CA bundle (PEM) to trust for this origin. */
    ca: z.string().min(1).optional(),
    /** Also present it from the browser (the browser context option clientCertificates). Default true. */
    browser: z.boolean().default(true),
  })
  .refine((c) => !!c.pfx || (!!c.cert && !!c.key), { message: 'a client certificate needs "pfx" or both "cert" and "key"' });

export const ApiConfigSchema = z.object({
  clientCertificates: z.array(ClientCertificateSchema).default([]),
  ...ApiSpecOptionsSchema,
});

/** Global loader/spinner wait before every action and post-condition. */
export const WaitsSchema = z.object({
  /** CSS/XPath selectors of loaders; while any is visible, steps wait (up to loaderTimeoutMs). */
  loaders: z.array(z.string().min(1)).default([]),
  loaderTimeoutMs: z.number().int().positive().default(30_000),
});

/** Body template syntax: `${expr}` (default) or additionally `{{expr}}` (mustache, for migrated payload files). */
export const TemplatesSchema = z.object({
  syntax: z.enum(['dollar', 'mustache']).default('dollar'),
});

/** Date helpers used by addBusinessDays / isBusinessDay / nextBusinessDay. */
export const DatesSchema = z.object({
  /** Holiday calendar: a file (YAML/JSON list, or one YYYY-MM-DD per line) or an inline list of dates. */
  holidays: z.union([z.string().min(1), z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))]).optional(),
  /** Weekend days (0=Sunday..6=Saturday). Default [0, 6]. */
  weekend: z.array(z.number().int().min(0).max(6)).default([0, 6]),
});

/** A project overlay: any top-level key (except projects/project) plus per-project environments. */
export const ProjectOverlaySchema = z.record(z.string(), z.unknown());

/** Built-in formats (console, html, json, junit) or the name of a reporter a plugin registers. */
export const ReportersSchema = z.array(z.string().min(1)).default(['console', 'html']);

/** A ref into a UI/PDF/DB source; `pattern` extracts a sub-value (first group or named group "value"). */
const SourceRefSchema = z.union([z.string().min(1), z.object({ key: z.string().min(1), pattern: z.string().optional() })]);
const ValueTypeSchema = z.enum(['text', 'number', 'currency', 'date', 'percent']);
const ToleranceSchema = z.object({ abs: z.number().min(0).optional(), rel: z.number().min(0).optional() });

/**
 * A document check used by the "Compare document <download> to <...> using <name>" step:
 * extract the downloaded PDF with `template`, then reconcile its fields three ways against
 * values captured in the UI (journey ledger keys) and a DB row (`db.query`), plus line items.
 */
export const DocumentCheckSchema = z.object({
  /** Path to a YAML/JSON extraction template, relative to the project. */
  template: z.string().min(1),
  db: z
    .object({
      connection: z.string().min(1),
      /** Returns the single header row compared field by field. Use ? params. */
      query: z.string().min(1),
      /** Returns line-item rows compared to `lines.pdfTable`. */
      linesQuery: z.string().min(1).optional(),
      /** Parameter values; ${var} is interpolated from the journey ledger/variables. */
      params: z.array(z.union([z.string(), z.number()])).default([]),
    })
    .optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        ui: SourceRefSchema.optional(),
        pdf: SourceRefSchema.optional(),
        db: SourceRefSchema.optional(),
        type: ValueTypeSchema.optional(),
        tolerance: ToleranceSchema.optional(),
      }),
    )
    .min(1),
  lines: z
    .object({
      pdfTable: z.string().min(1),
      key: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      fieldMap: z.record(z.string(), z.string()),
    })
    .optional(),
  footing: z.object({ pdfTable: z.string().min(1), column: z.string().min(1), tolerance: z.number().min(0).optional() }).optional(),
});

/** Security switches. */
export const SecuritySchema = z.object({
  /**
   * Allow "Run script" / "Run JavaScript" steps. They run in the browser page
   * (never in Node), but execute code from journey files, so they are opt-in.
   */
  allowPageScripts: z.boolean().default(false),
  /** API security scan pack (eztest api-scan). Safe by default: only the listed non-production hosts, with opt-in. */
  api: z.object({
    /** Hosts the scanner may send probe requests to (exact or *.example.com). A scan of any other host is refused. */
    allowedHosts: z.array(z.string().min(1)).default([]),
    /** Let the scanner run mutating probes (mass assignment, injection on POST/PUT/PATCH). Default false. */
    allowMutating: z.boolean().default(false),
    /** Readiness gate threshold: findings at or above this severity fail the apiSecurity gate. */
    failOn: z.enum(['info', 'low', 'medium', 'high']).default('medium'),
  }).prefault({}),
});

/** Default handling of JavaScript dialogs nobody armed for. */
export const DialogsSchema = z.object({
  default: z.enum(['accept', 'dismiss']).default('dismiss'),
  beforeunload: z.enum(['accept', 'dismiss']).default('accept'),
});

/** Hook journeys (ids, names or files under the project). */
export const HooksSchema = z.object({
  beforeAll: z.array(z.string().min(1)).default([]),
  afterAll: z.array(z.string().min(1)).default([]),
  beforeEach: z.array(z.string().min(1)).default([]),
  afterEach: z.array(z.string().min(1)).default([]),
});

/** Mailbox for email steps: EZTest's built-in SMTP sink (the app under test sends mail to it). */
export const EmailSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('sink'), port: z.number().int().min(0).default(2525), host: z.string().default('127.0.0.1') }),
]);

/** SMS inbox for SMS steps. Credentials are secret references (secret://store/key). */
export const SmsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('twilio'), accountSid: z.string().min(1), authToken: z.string().min(1), baseUrl: z.string().url().optional() }),
]);

/**
 * Phone calls for voice steps. Credentials are secret references. Outbound
 * calls dial real phones, so only numbers on allowedNumbers (exact, or a
 * prefix ending in *) can be called. Transcripts come from the provider's own
 * transcription, or from a local fixtures file (recording id / audio sha256 -> text).
 */
export const VoiceSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('twilio'), accountSid: z.string().min(1), authToken: z.string().min(1), baseUrl: z.string().url().optional(),
    from: z.string().optional(), allowedNumbers: z.array(z.string().min(2)).default([]),
    transcripts: z.string().optional(),
  }),
]);

/** Results server (`eztest server`): publishing, shared team state and cross-machine locks. */
export const ServerClientSchema = z.object({
  url: z.string().url(),
  /** API token: a literal or a secret reference (secret://env/NAME reads the env store). Default: the EZTEST_SERVER_TOKEN environment variable. */
  token: z.string().min(1).optional(),
  /** Project on the server (default: the selected config project, else "default"). */
  project: z.string().min(1).optional(),
  /** Read heal decisions, quarantine and triage overrides from the server (local files are the fallback). Default true. */
  sharedState: z.boolean().default(true),
  /** Publish every `eztest run` to the server. Default false (use --publish). */
  publish: z.boolean().default(false),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().default(15_000),
});

/** Resource locks (`Locks:` on journeys). */
export const LocksSchema = z.object({
  /** auto: the results server when `server` is configured, else lock files. */
  backend: z.enum(['auto', 'file', 'server', 'off']).default('auto'),
  /** Lock-file directory; put it on a shared file system to lock across machines. */
  dir: z.string().min(1).default('.eztest/locks'),
  ttlSeconds: z.number().int().min(5).default(120),
  /** A journey whose locks stay busy this long is recorded as an error. */
  timeoutMinutes: z.number().min(0.01).default(30),
});

/** A result publisher (first-party: slack, teams, jira; or one a plugin registers). Other keys are the publisher's options. */
export const PublisherConfigSchema = z
  .object({
    use: z.string().min(1),
    /** When to publish: always (default), or only when the run failed / passed. */
    when: z.enum(['always', 'failed', 'passed']).default('always'),
  })
  .catchall(z.unknown());

/** OpenTelemetry trace export of runs (OTLP/HTTP JSON). */
export const TelemetrySchema = z.object({
  otlp: z
    .object({
      /** Collector base URL (http://host:4318) or the full /v1/traces URL. Default: OTEL_EXPORTER_OTLP_ENDPOINT. */
      endpoint: z.string().url().optional(),
      headers: z.record(z.string(), z.string()).default({}),
      serviceName: z.string().min(1).default('eztest'),
    })
    .optional(),
});

/** A plugin: an npm package name or a local path, optionally with options. */
export const PluginRefSchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), options: z.record(z.string(), z.unknown()).default({}) }),
]);

/** Current configuration schema version (see `eztest upgrade-config` and docs/versioning.md). */
export const CONFIG_VERSION = 1;

export const BrowserChannelSchema = z.enum(['chromium', 'chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'msedge-beta', 'msedge-dev']);

/**
 * Attach to a running browser over the browser's own protocol (docs/browser-driver.md, "Remote browsers"):
 * a Chrome/Edge DevTools endpoint or a Firefox WebDriver BiDi WebSocket. Header values and auth fields
 * may be secret:// references. EZTest does not speak other test tools' grid protocols.
 */
export const BrowserConnectSchema = z.object({
  /** ws(s)://host:port/devtools/browser/<id>, or http(s)://host:port (resolved via /json/version). */
  cdpEndpoint: z.string().min(1).optional(),
  /** Firefox: ws(s)://host:port (the /session path is added when missing). */
  bidiEndpoint: z.string().min(1).optional(),
  /** Headers on the discovery request and the WebSocket handshake; values may be secret:// references. */
  headers: z.record(z.string(), z.string()).default({}),
  /** Credentials: username + password (HTTP basic), or a token (Authorization: Bearer, or the `queryParam` of the URL). */
  auth: z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
    /** Send the token as this URL query parameter instead of an Authorization header. */
    queryParam: z.string().regex(/^[\w.-]+$/).optional(),
  }).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).refine((c) => !!c.cdpEndpoint !== !!c.bidiEndpoint, { message: 'give exactly one of cdpEndpoint (Chrome/Edge) or bidiEndpoint (Firefox)' });
export type BrowserConnectConfig = z.infer<typeof BrowserConnectSchema>;

/** One entry of `browsers:`: a name, or { name, connect } for a remote browser of the matrix. */
export const BrowserEntrySchema = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), executablePath: z.string().min(1).optional(), connect: BrowserConnectSchema.optional() }),
]);

/** Reliability (docs/reliability.md): actionability, app idle, re-render safety, environment and session handling. */
export const ReliabilitySchema = z.object({
  actionability: z.boolean().default(true),
  appIdle: z.union([z.boolean(), z.object({
    timeoutMs: z.number().int().positive().optional(),
    quietMs: z.number().int().min(0).optional(),
    ignoreUrls: z.array(z.string().min(1)).optional(),
  })]).default(false),
  verifyFill: z.boolean().default(true),
  reresolve: z.boolean().default(true),
  /** Pause before every action, for debugging only. */
  slowMo: z.number().int().min(0).default(0),
  circuitBreaker: z.object({ enabled: z.boolean().default(true), threshold: z.number().int().min(1).default(3) }).prefault({}),
  /** Detect "session expired" mid-journey and re-login once (off unless configured). */
  sessionExpiry: z.object({
    urls: z.array(z.string().min(1)).default([]),
    text: z.array(z.string().min(1)).default([]),
    statuses: z.array(z.number().int()).default([401, 440]),
    relogin: z.boolean().default(true),
  }).optional(),
  /** Reuse one browser context per worker, reset between journeys (opt-in, for speed). */
  reuseContext: z.boolean().default(false),
  /** Start a fresh browser after this many journeys (0: never). Default: 15 on Firefox, never on Chromium. */
  recycleBrowserAfter: z.number().int().min(0).optional(),
  /** Propose verified, more robust locators in the heal inbox. */
  suggestLocators: z.boolean().default(true),
  /** Remove orphaned test data left by crashed runs at the start of a run. */
  orphanSweep: z.boolean().default(true),
});

/** A pre-flight environment check (url, api or db). */
export const HealthCheckSchema = z.union([
  z.object({ name: z.string().optional(), url: z.string().min(1), status: z.union([z.number().int(), z.array(z.number().int())]).optional(), contains: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ name: z.string().optional(), api: z.string().min(1), method: z.enum(['GET', 'HEAD', 'POST']).optional(), status: z.union([z.number().int(), z.array(z.number().int())]).optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ name: z.string().optional(), db: z.string().min(1), sql: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
]);

export const LintConfigSchema = z.object({
  /** The UI is translated: report locators that rely only on visible text. */
  translatedUi: z.boolean().default(false),
  /** Severity per rule: error, warning, info or off. */
  rules: z.record(z.string(), z.enum(['error', 'warning', 'info', 'off'])).default({}),
  maxWarnings: z.number().int().min(0).optional(),
});

export const BddSchema = z.object({
  /** Folders (or files) of `.feature` files; `eztest run` with no paths runs them after journeysDir. Default ["features"] when that folder exists. */
  features: z.array(z.string().min(1)).optional(),
  /**
   * Step definition files (globs relative to the project). Default: `**\/*.steps.{ts,mts,js,mjs}` and every
   * file under `step_definitions/` or `step-definitions/` folders.
   */
  steps: z.array(z.string().min(1)).optional(),
  /** Steps without a definition run as EZTest plain-English steps when they are EZTest phrasings (default true). */
  fallback: z.boolean().default(true),
  /** Language of feature files without a `# language:` header (default en). */
  language: z.string().min(2).default('en'),
  /** Passed to every World as `parameters`. */
  worldParameters: z.record(z.string(), z.unknown()).default({}),
});

const DURATION = /^\s*\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)?\s*$/i;

/** Shared test data: the store and data pools (docs/shared-data.md). */
export const StoreConfigSchema = z.object({
  /** auto: the results server when `server.url` is set, else local files. */
  backend: z.enum(['auto', 'file', 'server']).default('auto'),
  /** The file backend's directory (put it on a shared file system to share across machines). */
  dir: z.string().min(1).default('.eztest/store'),
  /** Default namespace (default: the environment name, e.g. sit). */
  namespace: z.string().regex(/^[A-Za-z0-9_][\w.-]*$/).optional(),
  /** Key for secret values (secret://..., ENC(...) or text); default EZTEST_STORE_KEY, then EZTEST_MASTER_KEY. */
  key: z.string().min(1).optional(),
  /** Expiry of values saved without "for <duration>", e.g. 7d (default: none). */
  defaultTtl: z.string().regex(DURATION).optional(),
  /** How long a pool claim lasts before a crashed run's item is free again. */
  claimTtl: z.string().regex(DURATION).default('30m'),
  /** Release a claimed pool item when its journey fails (false: the item is consumed anyway). */
  releaseOnFailure: z.boolean().default(true),
  /** Hand values saved "for the pipeline" to the CI system (Azure Pipelines output variables, $GITHUB_OUTPUT). */
  pipelineOutputs: z.boolean().default(true),
  pools: z
    .record(
      z.string().regex(/^[A-Za-z0-9_][\w.:@/-]*$/),
      z.object({
        /** Seed the pool from a data file (csv, xlsx, json) the first time it is used: one item per row. */
        from: z.string().min(1).optional(),
        sheet: z.string().min(1).optional(),
        /** Take this column's value as the item instead of the whole row. */
        column: z.string().min(1).optional(),
        namespace: z.string().regex(/^[A-Za-z0-9_][\w.-]*$/).optional(),
        releaseOnFailure: z.boolean().optional(),
        claimTtl: z.string().regex(DURATION).optional(),
      }),
    )
    .default({}),
});

/** One entry of `pipelines:`: which journeys a CI trigger or deployment stage runs, and how (docs/pipelines.md). */
export const PipelineEntrySchema = z.object({
  description: z.string().optional(),
  /** Tag expression: "@smoke", "@regression and not @quarantined", "(@sit or @smoke) and not @slow". */
  tags: z.string().min(1).optional(),
  /** Journey files or folders (default: journeysDir). */
  journeys: z.array(z.string().min(1)).optional(),
  /** Only journeys impacted by the change (true: since EZTEST_BASE_REF or origin/main; or a git ref). */
  impact: z.union([z.boolean(), z.string().min(1)]).optional(),
  /** Highest risk-per-minute journeys that fit this time, e.g. 10m. */
  budget: z.string().regex(/^\s*\d+(?:\.\d+)?\s*(?:ms|s|m|min|h)?\s*$/i).optional(),
  /** Minimum risk (e.g. 4 or ">=4"). */
  risk: z.union([z.number().int().min(1).max(5), z.string().min(1)]).optional(),
  /** Parallel shards in CI (a number, or auto from historical durations). */
  shards: z.union([z.number().int().min(1).max(256), z.literal('auto')]).optional(),
  browsers: z.array(z.string().min(1)).optional(),
  /** Environment the journeys run against (config/<env>.yaml); a deployment record is kept per environment and version. */
  environment: z.string().min(1).optional(),
  /** Azure Test Plans plan (and suite) updated with the results. */
  testPlan: z.number().int().positive().optional(),
  testSuite: z.number().int().positive().optional(),
  /** readiness: NO_GO fails the pipeline; none: only failures do. */
  gate: z.enum(['readiness', 'none']).default('readiness'),
  /** Pipelines (by name) that must have passed for the same version before this one runs (deployment order). */
  requires: z.array(z.string().min(1)).default([]),
  retries: z.number().int().min(0).max(10).optional(),
  workers: z.number().int().min(1).max(64).optional(),
  /** CI stage, job or environment names that select this entry when `--pipeline auto` (default: the entry name). */
  stages: z.array(z.string().min(1)).default([]),
  /** When the CI templates run it: on pull requests, on a schedule (cron, UTC), after a deployment, or by hand. */
  trigger: z.enum(['pr', 'schedule', 'deploy', 'manual']).optional(),
  schedule: z.string().min(1).optional(),
  /** Record a deployment test record on the results server (default: when `environment` is set). */
  record: z.boolean().optional(),
  /** The deployed version or build (text with ${ENV}; default from the CI: build number, tag or commit). */
  version: z.string().min(1).optional(),
  app: z.string().min(1).optional(),
  /** Azure DevOps: build tags, a summary on the build, comments on the build's work items, the test plan. */
  ado: z
    .object({
      summary: z.boolean().default(true),
      tags: z.boolean().default(true),
      commentWorkItems: z.boolean().default(false),
      linkWorkItems: z.boolean().default(false),
      publishTestPlan: z.boolean().default(true),
    })
    .prefault({}),
});

export const EzTestConfigSchema = z.object({
  /** Configuration schema version. Absent means 1; older versions are migrated by `eztest upgrade-config`. */
  configVersion: z.number().int().min(1).max(CONFIG_VERSION).default(CONFIG_VERSION),
  environment: z.string().min(1).default('default'),
  /** The selected project (set by --project / EZTEST_PROJECT; see `projects`). */
  project: z.string().min(1).optional(),
  /** Named project overlays: base < project < environment < .env/EZTEST_* < CLI. */
  projects: z.record(z.string(), ProjectOverlaySchema).default({}),
  /** Plain configuration variables: usable as ${NAME} in config values and as journey variables. */
  vars: z.record(z.string(), z.string()).default({}),
  baseUrl: z.string().url().optional(),
  /** Also accepts `browser: { name: chromium, channel: msedge }` (normalised on load). */
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  /** Browser channel for chromium: msedge, chrome, ... (installed browsers). */
  channel: BrowserChannelSchema.optional(),
  /**
   * Cross-browser runs: every journey runs on each of these (chromium, chrome, msedge, firefox, channels),
   * as journey x browser units. Overrides browser/channel. CLI: --browsers chromium,firefox.
   */
  browsers: z.array(BrowserEntrySchema).optional(),
  /** Attach to a running browser instead of launching one (written `browser: { name, connect: {...} }`). */
  browserConnect: BrowserConnectSchema.optional(),
  headless: z.boolean().default(true),
  /** Video per journey attempt: off, on, or retain-on-failure (kept only when the attempt did not pass). */
  video: z.enum(['off', 'on', 'retain-on-failure']).default('off'),
  /** Screenshot policy; before-assertions also captures the page before every assertion. Default: the CLI/runner default. */
  screenshots: z.enum(['every-step', 'on-failure', 'off', 'before-assertions']).optional(),
  concurrency: z.number().int().min(1).max(64).default(1),
  /**
   * Where parallel journeys run: process (one worker process with its own browser per concurrency slot; the
   * default of `eztest run` when concurrency > 1) or inline (async tasks of one process). docs/scale.md.
   */
  workers: z.enum(['process', 'inline']).optional(),
  retries: z.number().int().min(0).max(10).default(0),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  timeouts: TimeoutsSchema.prefault({}),
  outputDir: z.string().min(1).default('eztest-results'),
  journeysDir: z.string().min(1).default('journeys'),
  /** Folder of Gherkin `.feature` files run by `eztest run` next to journeysDir (shorthand for bdd.features; see docs/bdd.md). */
  bddDir: z.string().min(1).optional(),
  /** Native BDD: `.feature` files with TypeScript step definitions (eztest/bdd), see docs/bdd.md. */
  bdd: BddSchema.prefault({}),
  /** Shared element repository (docs/elements.md): elements/*.yaml, optionally TypeScript screens read statically. */
  elements: z.object({
    dir: z.string().min(1).default('elements'),
    /** Directories of SDK screen modules (hand-written or imported) whose literal entries join the repository (e.g. ["screens"]). */
    screens: z.array(z.string().min(1)).default([]),
    /** Use an element when a journey's description equals its description or an alias (default true). */
    matchDescriptions: z.boolean().default(true),
  }).prefault({}),
  reporters: ReportersSchema,
  healing: HealingSchema.prefault({}),
  identity: IdentitySchema.prefault({}),
  data: DataSchema.prefault({}),
  db: z.object({ connections: z.record(z.string(), DbConnectionSchema).default({}), queries: DbQueriesSchema.prefault({}) }).prefault({}),
  ado: AdoSchema.prefault({}),
  vcs: VcsSchema.prefault({}),
  lenses: z.array(z.string().min(1)).default([]),
  trace: TraceSchema.prefault({}),
  documents: z.record(z.string(), DocumentCheckSchema).default({}),
  /** Dynamics 365 / Power Apps add-on (validated by the d365 module). */
  d365: z.record(z.string(), z.unknown()).optional(),
  security: SecuritySchema.prefault({}),
  dialogs: DialogsSchema.prefault({}),
  hooks: HooksSchema.prefault({}),
  email: EmailSchema.optional(),
  sms: SmsSchema.optional(),
  voice: VoiceSchema.optional(),
  /** Salesforce Lightning add-on (validated by the salesforce module). */
  salesforce: z.record(z.string(), z.unknown()).optional(),
  /** Packaged-app packs (validated by src/apps/<pack>; docs/apps/<pack>.md): SAP Fiori/OData, ServiceNow, Workday, Oracle Fusion/EBS, Power Apps canvas. */
  sap: z.record(z.string(), z.unknown()).optional(),
  servicenow: z.record(z.string(), z.unknown()).optional(),
  workday: z.record(z.string(), z.unknown()).optional(),
  oracle: z.record(z.string(), z.unknown()).optional(),
  powerapps: z.record(z.string(), z.unknown()).optional(),
  /** Desktop apps: windows / java agents, sap bridge, electron (validated by the desktop module; docs/desktop-and-legacy.md). */
  desktop: z.record(z.string(), z.unknown()).optional(),
  /** Mainframe TN3270 hosts (validated by the desktop module). */
  mainframe: z.record(z.string(), z.unknown()).optional(),
  /** Citrix/VDI sessions over VNC, image templates and OCR (validated by the desktop module). */
  citrix: z.record(z.string(), z.unknown()).optional(),
  /** Native mobile with EZTest's own Android (ADB + agent) and iOS (XCTest agent) drivers (validated by the mobile module; docs/mobile.md). */
  mobile: z.record(z.string(), z.unknown()).optional(),
  api: ApiConfigSchema.prefault({}),
  /** Message brokers for messaging steps (docs/messaging.md). */
  messaging: MessagingSchema.optional(),
  /** SOAP services from WSDLs: endpoint, validation, WS-Security, MTOM (docs/soap.md). */
  soap: SoapConfigSchema.optional(),
  /** gRPC services (proto files and addresses). */
  grpc: GrpcSchema.optional(),
  /** SFTP servers, SSH hosts (allow-listed commands) and local drop folders. */
  files: FilesSchema.optional(),
  /** Batch jobs started by "Run batch job ...". */
  batch: BatchSchema.optional(),
  /** EZTest contracts: contract files, provider verification, publishing and can-release through the results server (docs/api-contracts.md). */
  contracts: ContractsSchema.optional(),
  waits: WaitsSchema.prefault({}),
  templates: TemplatesSchema.prefault({}),
  dates: DatesSchema.prefault({}),
  reliability: ReliabilitySchema.prefault({}),
  /** Pre-flight environment checks: a failure stops the run as an environment problem. */
  healthChecks: z.array(HealthCheckSchema).default([]),
  /** IANA time zone pinned for the browser and the expression date functions, e.g. Europe/Berlin. */
  timezone: z.string().min(1).optional(),
  /** Locale for the browser and locale-aware assertions, e.g. de-DE. */
  locale: z.string().min(1).optional(),
  lint: LintConfigSchema.prefault({}),
  /** Coverage analytics (docs/coverage.md): UI coverage map from trace snapshots. */
  coverage: z
    .object({
      ui: z
        .object({
          /** Route patterns matched before the automatic template, e.g. /orders/:id. */
          routes: z.array(z.string().min(1)).default([]),
          /** Elements left out: role or role:name (wildcard *), e.g. "link:Skip to content". */
          ignore: z.array(z.string().min(1)).default([]),
          /** Routes left out (patterns, wildcard *). */
          ignoreRoutes: z.array(z.string().min(1)).default([]),
          /** Group names that differ only in numbers (ORD-12, ORD-13). */
          normalizeNumbers: z.boolean().default(true),
          testIdAttribute: z.string().min(1).default('data-testid'),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Accessibility lens configuration and per-component scopes (docs/coverage.md#accessibility-trends). */
  accessibility: z
    .object({
      tags: z.array(z.string().min(1)).optional(),
      include: z.array(z.string().min(1)).optional(),
      exclude: z.array(z.string().min(1)).optional(),
      disableRules: z.array(z.string().min(1)).optional(),
      failOn: z.enum(['minor', 'moderate', 'serious', 'critical']).optional(),
      scopes: z
        .array(z.object({ name: z.string().min(1), include: z.array(z.string().min(1)).min(1), exclude: z.array(z.string().min(1)).optional(), rules: z.record(z.string(), z.enum(['off', 'warn', 'error'])).optional() }))
        .default([]),
    })
    .prefault({}),
  /** Manual and hybrid test management (docs/manual-testing.md). */
  manual: z
    .object({
      /** Test suites, cycles and assignments (project file, commit it). */
      plansFile: z.string().min(1).default('test-plans.json'),
      /** Testers offered for assignment. */
      testers: z.array(z.string().min(1)).default([]),
      /** Where the Studio case editor writes new manual cases (inside journeysDir). */
      casesDir: z.string().min(1).default('manual'),
    })
    .prefault({}),
  readiness: z
    .object({
      policyPath: z.string().optional(),
      minPassRate: z.number().min(0).max(1).optional(),
    })
    .prefault({}),
  /** The HTML report (docs/reports.md): branding, the trend window, the comparison baseline and the Studio link. */
  report: z
    .object({
      /** Report title (default "<name> test report"). */
      title: z.string().min(1).optional(),
      /** Project or product name in the report header (default "EZTest"). */
      name: z.string().min(1).optional(),
      /** Logo file (.svg, .png, .jpg, .gif, .webp; < 512 KiB), embedded into the report. */
      logo: z.string().min(1).optional(),
      /** Runs in the pass-rate and duration trends. */
      trendRuns: z.number().int().min(2).max(200).default(20),
      /** Comparison baseline: the previous run in the output directory, none, or a run directory. */
      baseline: z.string().min(1).default('previous'),
      /** EZTest Studio URL for "open trace in Studio" links. */
      studioUrl: z.string().url().optional(),
      /** Brand colour (#rrggbb) for the report header mark and accents. */
      brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour').optional(),
    })
    .prefault({}),
  /** Results server for publishing runs, shared team state and cross-machine locks. */
  server: ServerClientSchema.optional(),
  locks: LocksSchema.prefault({}),
  /** Shared test data across journeys, suites, runs and pipeline stages (docs/shared-data.md). */
  store: StoreConfigSchema.prefault({}),
  /** CI triggers and deployment stages mapped to journey selections (docs/pipelines.md). */
  pipelines: z.record(z.string().regex(/^[A-Za-z0-9_][\w.-]*$/, 'pipeline names: letters, digits, _ . -'), PipelineEntrySchema).default({}),
  /** Test selection (`--changed-since`): the impact mapping file. */
  selection: z.object({ impactMapping: z.string().min(1).default('impact-mapping.yaml') }).prefault({}),
  /** Plugins: npm package names or local paths (see docs/plugins.md). */
  plugins: z.array(PluginRefSchema).default([]),
  /** Test importers: plugins that add source formats to `eztest import --from` and Studio's import page (docs/plugins.md). */
  importers: z
    .object({
      plugins: z.array(PluginRefSchema).default([]),
      /** Options per importer name, passed to it as ctx.options (CLI --importer-option values win). */
      options: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.boolean(), z.number()]))).default({}),
    })
    .prefault({}),
  /** Result publishers run after `eztest run` and by `eztest publish`. */
  publishers: z.array(PublisherConfigSchema).default([]),
  telemetry: TelemetrySchema.prefault({}),
  /** Start the app under test before `eztest run` and stop it after (spawned without a shell). */
  webServer: z
    .object({
      command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      url: z.string().url().optional(),
      waitFor: z.string().min(1).optional(),
      timeoutSeconds: z.number().positive().default(60),
      reuseExisting: z.boolean().default(false),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
});
export type ServerClientConfig = z.infer<typeof ServerClientSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type PipelineEntry = z.infer<typeof PipelineEntrySchema>;
export type PublisherConfig = z.infer<typeof PublisherConfigSchema>;
export type PluginRef = z.infer<typeof PluginRefSchema>;

export type EzTestConfig = z.infer<typeof EzTestConfigSchema>;
export type EzTestConfigInput = z.input<typeof EzTestConfigSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type DbConnectionConfig = z.infer<typeof DbConnectionSchema>;
export type DbQueriesConfig = z.infer<typeof DbQueriesSchema>;
export type DocumentCheckConfig = z.infer<typeof DocumentCheckSchema>;
export type SecretStoreConfig = z.infer<typeof SecretStoreConfigSchema>;
export type ClientCertificateConfig = z.infer<typeof ClientCertificateSchema>;
export type PasswordRotationConfig = z.infer<typeof PasswordRotationSchema>;
