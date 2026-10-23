/**
 * `salesforce:` configuration and one-call wiring: an integration
 * SalesforceClient (OAuth client-credentials, or password flow as `apiUser`),
 * per-role clients (describe-as-user), the credentials provider for UI login,
 * the intent rules and the custom step handlers. Secret values may be
 * `secret://store/key` references or ENC(...) values; they are resolved
 * through a SecretRegistry only when used, and registered with the masker.
 */
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { SecretRegistry, isSecretRef, type SecretHandle } from '../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../intent/index.js';
import type { CustomStepHandler } from '../runner/types.js';
import type { TokenProvider } from '../surfaces/index.js';
import { SalesforceTokenProvider } from './auth.js';
import { SalesforceClient } from './client.js';
import { snapshotDescribe } from './impact.js';
import { createSalesforceIntentRules } from './intents.js';
import type { DescribeSnapshot } from './metadata.js';
import { runPermissionMatrix, type PermissionCheck, type PermissionReport, type PermissionUiOptions } from './permissions.js';
import { createSalesforceSteps, type SalesforceCredentialsProvider, type SalesforceStepsOptions } from './steps.js';

const RoleUser = z.object({
  /** Plain username or secret://ref. */
  username: z.string().min(1),
  /** secret://store/key (recommended), ENC(...), or a literal (tests only). */
  password: z.string().min(1),
});

export const SalesforceConfigSchema = z
  .object({
    /** My Domain / instance URL, e.g. https://acme.my.salesforce.com (REST API host). */
    instanceUrl: z.string().url(),
    /** Lightning Experience root if different, e.g. https://acme.lightning.force.com. */
    lightningUrl: z.string().url().optional(),
    /** Login page host for UI login and OAuth (default instanceUrl; or https://login.salesforce.com / https://test.salesforce.com). */
    loginUrl: z.string().url().optional(),
    /** OAuth token endpoint; default <loginUrl>/services/oauth2/token. */
    tokenUrl: z.string().url().optional(),
    /** Connected app consumer key and secret (secret://ref allowed for the secret). */
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    apiVersion: z.string().regex(/^\d{2,3}\.0$/).default('61.0'),
    /** Roles used by "Log in to Salesforce as <role>" and the permission matrix. */
    users: z.record(z.string().regex(/^[\w.-]+$/), RoleUser).default({}),
    /** Role whose password-flow token the integration client uses; default: client_credentials. */
    apiUser: z.string().optional(),
    /** sObject API names to snapshot for release impact (and to recognise in phrasings). */
    objects: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).min(1),
    dateFormat: z.enum(['M/d/yyyy', 'd/M/yyyy', 'yyyy-MM-dd']).default('M/d/yyyy'),
    timeoutMs: z.number().int().positive().optional(),
    /** Assumed OAuth session lifetime in seconds (Salesforce sends no expires_in). */
    sessionSeconds: z.number().int().positive().optional(),
  })
  .refine((c) => !c.apiUser || !!c.users[c.apiUser], { message: 'salesforce.apiUser must name one of salesforce.users', path: ['apiUser'] });

export type SalesforceConfig = z.infer<typeof SalesforceConfigSchema>;
export type SalesforceConfigInput = z.input<typeof SalesforceConfigSchema>;

export function parseSalesforceConfig(input: unknown): SalesforceConfig {
  const r = SalesforceConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid salesforce config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'SF_CONFIG');
  return r.data;
}

export interface SalesforceIntegration {
  config: SalesforceConfig;
  /** Integration client (metadata, SOQL cross-checks). */
  client: SalesforceClient;
  /** A REST client authenticated as `role` (password flow); cached per role. */
  clientFor(role: string): SalesforceClient;
  /** Credentials for UI login per role (password as a secret handle). */
  credentials: SalesforceCredentialsProvider;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  /** Register the intent rules with the grammar; returns the unregister function. */
  registerIntents(): () => void;
  /** Snapshot the configured objects' describe (for `eztest salesforce snapshot`). */
  snapshot(o?: { release?: string }): Promise<DescribeSnapshot>;
  /** Run a permission matrix across the configured users (for `eztest salesforce permissions`). */
  permissionMatrix(checks: PermissionCheck[], ui?: PermissionUiOptions): Promise<PermissionReport>;
}

export interface SalesforceIntegrationOptions {
  fetch?: typeof fetch;
  /** Token provider for the integration client (overrides the config's OAuth flow). */
  tokenProvider?: TokenProvider;
  /** Resolves secret://refs and ENC(...) values (e.g. the Identity Vault's registry). */
  secrets?: SecretRegistry;
  steps?: Partial<SalesforceStepsOptions>;
  /** Extra object labels (custom objects) for the generic phrasings. */
  objectLabels?: string[];
}

/** Build everything the engine needs from a `salesforce:` config block. */
export function createSalesforceIntegration(input: SalesforceConfigInput | SalesforceConfig, o: SalesforceIntegrationOptions = {}): SalesforceIntegration {
  const cfg = parseSalesforceConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const loginHost = (cfg.loginUrl ?? cfg.instanceUrl).replace(/\/+$/, '');
  const tokenUrl = cfg.tokenUrl ?? `${loginHost}/services/oauth2/token`;
  const clientSecret = registry.from(cfg.clientSecret, 'salesforce.clientSecret');

  const userHandles = new Map<string, { username: string | SecretHandle; password: SecretHandle }>();
  const role = (r: string) => {
    let h = userHandles.get(r);
    if (!h) {
      const u = cfg.users[r];
      if (!u) throw new EzTestError(`Unknown Salesforce role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'SF_UNKNOWN_ROLE');
      h = { username: isSecretRef(u.username) ? registry.handle(u.username) : u.username, password: registry.from(u.password, `salesforce.users.${r}.password`) };
      userHandles.set(r, h);
    }
    return h;
  };
  const usernameOf = async (r: string) => {
    const u = role(r).username;
    return typeof u === 'string' ? u : u.resolve();
  };

  const passwordProvider = (r: string, username: string) =>
    new SalesforceTokenProvider({
      tokenUrl, clientId: cfg.clientId, clientSecret, grant: 'password', username, password: role(r).password,
      sessionSeconds: cfg.sessionSeconds, timeoutMs: cfg.timeoutMs, fetch: o.fetch, masker: registry.masker,
    });

  /** A token provider whose username may itself be a secret: resolved lazily on first use. */
  const lazyPasswordProvider = (r: string): TokenProvider => {
    let p: SalesforceTokenProvider | undefined;
    const get = async () => (p ??= passwordProvider(r, await usernameOf(r)));
    return { getToken: async () => (await get()).getToken(), invalidate: () => p?.invalidate() };
  };

  const makeClient = (tp: TokenProvider) =>
    new SalesforceClient({ instanceUrl: cfg.instanceUrl, apiVersion: cfg.apiVersion, tokenProvider: tp, fetch: o.fetch, timeoutMs: cfg.timeoutMs });

  const integrationTp: TokenProvider =
    o.tokenProvider ??
    (cfg.apiUser
      ? lazyPasswordProvider(cfg.apiUser)
      : new SalesforceTokenProvider({ tokenUrl, clientId: cfg.clientId, clientSecret, grant: 'client_credentials', sessionSeconds: cfg.sessionSeconds, timeoutMs: cfg.timeoutMs, fetch: o.fetch, masker: registry.masker }));
  const client = makeClient(integrationTp);

  const perRole = new Map<string, SalesforceClient>();
  const clientFor = (r: string): SalesforceClient => {
    role(r);
    let c = perRole.get(r);
    if (!c) perRole.set(r, (c = makeClient(lazyPasswordProvider(r))));
    return c;
  };

  const credentials: SalesforceCredentialsProvider = async (r) => ({ username: await usernameOf(r), password: role(r).password });

  const intentRules = createSalesforceIntentRules({ objects: [...cfg.objects.filter((n) => !n.includes('__')), ...(o.objectLabels ?? [])] });
  const appUrl = cfg.lightningUrl ?? cfg.instanceUrl;
  const customSteps = createSalesforceSteps({
    metadata: client,
    client,
    appUrl,
    loginUrl: cfg.loginUrl ?? appUrl,
    credentials,
    userClient: (r) => (cfg.users[r] ? clientFor(r) : undefined),
    dateFormat: cfg.dateFormat,
    timeoutMs: cfg.timeoutMs,
    ...o.steps,
  });

  return {
    config: cfg,
    client,
    clientFor,
    credentials,
    intentRules,
    customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s = {}) => snapshotDescribe(client, cfg.objects, { source: cfg.instanceUrl, ...s }),
    permissionMatrix: (checks, ui) => {
      const roles = Object.keys(cfg.users);
      if (!roles.length) throw new EzTestError('The permission matrix needs salesforce.users (one entry per role)', 'SF_CONFIG');
      return runPermissionMatrix({ users: Object.fromEntries(roles.map((r) => [r, clientFor(r)])), checks, ui });
    },
  };
}
