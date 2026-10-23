/**
 * `oracle:` configuration (Fusion Cloud + E-Business Suite) and wiring.
 *
 *   oracle:
 *     url: https://acme.fa.us2.oraclecloud.com          # Fusion UI and REST host
 *     ebsUrl: https://ebs.example.com                    # optional, OA Framework pages
 *     auth: { type: basic, username: EZTEST.INTEGRATION, password: secret://vault/ora-int }   # or oauth2 (IAM/IDCS client credentials)
 *     users: { buyer: { username: CASEY.BROWN, password: secret://vault/ora-buyer } }
 *     resources:
 *       - { name: purchaseOrders, path: /fscmRestApi/resources/11.13.18.05/purchaseOrders, key: OrderNumber, label: purchase order, pages: [Create Purchase Order, Purchase Orders] }
 *     testPod: { url: https://acme-test.fa.us2.oraclecloud.com, auth: { ... } }   # a pod that already has the next quarterly update
 */
import { z } from 'zod';
import type { Page } from '../../browser/index.js';
import { EzTestError, type Journey } from '../../core/index.js';
import { SecretRegistry } from '../../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../../intent/index.js';
import type { CustomStepHandler } from '../../runner/types.js';
import { AppApiError, AuthSchema, RoleUserSchema, createAuthHeader, passwordHandle, roleAuthHeader, usernameOf } from '../common/http.js';
import { diffSnapshots, impactReport, type AppChange, type AppSnapshot, type ImpactReport } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import { runMatrix, type MatrixReport, type PermissionCheckBase } from '../common/permissions.js';
import { OracleRestClient } from './client.js';
import { featureListChanges, oracleScoper, snapshotOracle } from './impact.js';
import { createOracleIntentRules } from './intents.js';
import { createOracleSteps, oracleLogin, type OracleStepsOptions } from './steps.js';

const ResourceSchema = z.object({ name: z.string().regex(/^[A-Za-z]\w*$/), path: z.string().regex(/^\/[\w/.-]+$/), key: z.string().regex(/^[A-Za-z]\w*$/), label: z.string().optional(), pages: z.array(z.string()).optional() });

export const OracleConfigSchema = z.object({
  url: z.string().url(),
  ebsUrl: z.string().url().optional(),
  auth: AuthSchema,
  users: z.record(z.string().regex(/^[\w.-]+$/), RoleUserSchema).default({}),
  resources: z.array(ResourceSchema).min(1),
  testPod: z.object({ url: z.string().url(), auth: AuthSchema }).optional(),
  userAccountsPath: z.string().default('/hcmRestApi/resources/11.13.18.05/userAccounts'),
  timeoutMs: z.number().int().positive().optional(),
});
export type OracleConfig = z.infer<typeof OracleConfigSchema>;
export type OracleConfigInput = z.input<typeof OracleConfigSchema>;

export function parseOracleConfig(input: unknown): OracleConfig {
  const r = OracleConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid oracle config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'ORA_CONFIG');
  return r.data;
}

export interface OraclePermissionCheck extends PermissionCheckBase {
  /** Job role common name: expect assigned | not-assigned (userAccounts). */
  role?: string;
  /** REST resource: expect read | none (as the user). */
  resource?: string;
  /** Fusion page in the Navigator: expect available | unavailable (UI). */
  page?: string;
}

export interface OracleIntegration {
  config: OracleConfig;
  client: OracleRestClient;
  testPodClient?: OracleRestClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  registerIntents(): () => void;
  snapshot(o?: { release?: string; pod?: 'current' | 'test' }): Promise<AppSnapshot>;
  changes(o: { before?: AppSnapshot; after?: AppSnapshot; features?: Array<Record<string, string>>; update?: string }): Promise<AppChange[]>;
  impact(changes: AppChange[], journeys: Journey[]): ImpactReport;
  permissionMatrix(checks: OraclePermissionCheck[], ui?: { pages: Record<string, Page> }): Promise<MatrixReport>;
}

export function createOracleIntegration(input: OracleConfigInput | OracleConfig, o: { secrets?: SecretRegistry; fetch?: typeof fetch; steps?: Partial<OracleStepsOptions> } = {}): OracleIntegration {
  const cfg = parseOracleConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const mk = (url: string, auth: ReturnType<typeof createAuthHeader>) => new OracleRestClient({ url, auth, resources: cfg.resources, timeoutMs: cfg.timeoutMs, fetch: o.fetch });
  const client = mk(cfg.url, createAuthHeader(cfg.auth, registry, 'oracle.auth', o));
  const testPodClient = cfg.testPod ? mk(cfg.testPod.url, createAuthHeader(cfg.testPod.auth, registry, 'oracle.testPod.auth', o)) : undefined;
  const user = (r: string) => {
    const u = cfg.users[r];
    if (!u) throw new EzTestError(`Unknown Oracle role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'ORA_UNKNOWN_ROLE');
    return u;
  };
  const perRole = new Map<string, OracleRestClient>();
  const clientFor = (r: string) => {
    let c = perRole.get(r);
    if (!c) perRole.set(r, (c = mk(cfg.url, roleAuthHeader(user(r), registry, `oracle.users.${r}`))));
    return c;
  };
  const intentRules = createOracleIntentRules();
  const customSteps = createOracleSteps({
    client, fusionUrl: cfg.url, ebsUrl: cfg.ebsUrl, timeoutMs: cfg.timeoutMs,
    credentials: async (r) => ({ username: await usernameOf(user(r), registry), password: passwordHandle(user(r), registry, `oracle.users.${r}.password`) }),
    ...o.steps,
  });
  return {
    config: cfg, client, testPodClient, intentRules, customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s = {}) => {
      const c = s.pod === 'test' ? testPodClient : client;
      if (!c) throw new EzTestError('oracle.testPod is not configured', 'ORA_CONFIG');
      return snapshotOracle(c, { release: s.release });
    },
    async changes(c) {
      const out: AppChange[] = [];
      let before = c.before;
      let after = c.after;
      if (!before && !after && testPodClient) {
        before = await snapshotOracle(client, { release: 'current' });
        after = await snapshotOracle(testPodClient, { release: c.update ?? 'test pod' });
      }
      if (before && after) out.push(...diffSnapshots(before, after, { source: `Oracle quarterly update ${c.update ?? after.release ?? ''} (pod comparison)`.replace(/\s+\(/, ' (') }));
      if (c.features) out.push(...featureListChanges(c.features, c.update ?? after?.release ?? 'next update'));
      return out;
    },
    impact: (changes, journeys) => impactReport('oracle', changes, journeys, oracleScoper(cfg.resources)),
    permissionMatrix: (checks, ui) => runMatrix<OraclePermissionCheck>({
      pack: 'oracle', users: Object.keys(cfg.users), checks, order: ['none', 'read', 'not-assigned', 'assigned', 'unavailable', 'available'],
      subject: (c) => (c.role ? `role:${c.role}` : c.resource ? `resource:${c.resource}` : `page:${c.page}`),
      probe: async (u, c) => {
        if (c.role) {
          const roles = await client.userRoles(await usernameOf(user(u), registry), cfg.userAccountsPath);
          if (!roles) return { api: 'not-assigned', detail: 'no such user account' };
          return { api: roles.some((r) => normalizeLabel(r) === normalizeLabel(c.role!)) ? 'assigned' : 'not-assigned' };
        }
        if (c.resource) {
          try {
            await clientFor(u).query(c.resource, { limit: 1 });
            return { api: 'read' };
          } catch (e) {
            if (e instanceof AppApiError && (e.status === 403 || e.status === 401)) return { api: 'none' };
            throw e;
          }
        }
        const page = ui?.pages[u];
        if (!page) return { detail: 'page availability is checked in the UI only (pass signed-in pages)' };
        if ((await page.locator('#navigator').count()) !== 1) {
          const r = await oracleLogin(page, 'fusion', cfg.url, await usernameOf(user(u), registry), await passwordHandle(user(u), registry, `oracle.users.${u}.password`).resolve(), 10_000);
          if (!r.ok) throw new EzTestError(`Oracle sign-in as ${u} failed: ${r.error}`, 'ORA_LOGIN_FAILED');
        }
        const names = await page.locator('#navMenu a.oj-navigationlist-item-label').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
        return { ui: names.some((x) => normalizeLabel(x) === normalizeLabel(c.page!)) ? 'available' : 'unavailable' };
      },
    }),
  };
}
