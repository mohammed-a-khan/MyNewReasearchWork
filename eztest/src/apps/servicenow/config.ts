/**
 * `servicenow:` configuration and one-call wiring.
 *
 *   servicenow:
 *     instanceUrl: https://acme.service-now.com
 *     auth: { type: basic, username: eztest.integration, password: secret://vault/sn-int }
 *     users:
 *       itil: { username: beth.anglin, password: secret://vault/sn-itil }
 *       employee: { username: abel.tuter, password: secret://vault/sn-emp }
 *     tables: [incident, change_request, sc_req_item]
 */
import { z } from 'zod';
import { EzTestError } from '../../core/index.js';
import { SecretRegistry } from '../../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../../intent/index.js';
import type { Journey } from '../../core/index.js';
import type { CustomStepHandler } from '../../runner/types.js';
import { AuthSchema, RoleUserSchema, createAuthHeader, passwordHandle, roleAuthHeader, usernameOf } from '../common/http.js';
import { diffSnapshots, impactReport, type AppChange, type AppSnapshot, type ImpactReport } from '../common/impact.js';
import type { MatrixReport } from '../common/permissions.js';
import { ServiceNowClient } from './client.js';
import { serviceNowScoper, skippedUpgradeChanges, snapshotServiceNow, updateSetChanges } from './impact.js';
import { createServiceNowIntentRules } from './intents.js';
import { serviceNowPermissionMatrix, type ServiceNowPermissionCheck, type ServiceNowPermissionUi } from './permissions.js';
import { createServiceNowSteps, type ServiceNowStepsOptions } from './steps.js';

export const ServiceNowConfigSchema = z.object({
  instanceUrl: z.string().url(),
  /** Integration user for the Table API (basic or OAuth via /oauth_token.do). */
  auth: AuthSchema,
  users: z.record(z.string().regex(/^[\w.-]+$/), RoleUserSchema).default({}),
  /** Tables to snapshot and to map update-set changes onto (child tables inherit parent changes). */
  tables: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)).min(1),
  portal: z.string().regex(/^[a-z0-9_]+$/).default('sp'),
  timeoutMs: z.number().int().positive().optional(),
});
export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
export type ServiceNowConfigInput = z.input<typeof ServiceNowConfigSchema>;

export function parseServiceNowConfig(input: unknown): ServiceNowConfig {
  const r = ServiceNowConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid servicenow config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'SN_CONFIG');
  return r.data;
}

export interface ServiceNowIntegration {
  config: ServiceNowConfig;
  client: ServiceNowClient;
  clientFor(role: string): ServiceNowClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  registerIntents(): () => void;
  snapshot(o?: { release?: string }): Promise<AppSnapshot>;
  /** Changes from update sets (by name) and/or the last upgrade's skipped records. */
  changes(o: { updateSets?: string[]; skipped?: boolean; upgrade?: string; before?: AppSnapshot; after?: AppSnapshot }): Promise<AppChange[]>;
  impact(changes: AppChange[], journeys: Journey[]): ImpactReport;
  permissionMatrix(checks: ServiceNowPermissionCheck[], ui?: Omit<ServiceNowPermissionUi, 'instanceUrl'>): Promise<MatrixReport>;
}

export function createServiceNowIntegration(input: ServiceNowConfigInput | ServiceNowConfig, o: { secrets?: SecretRegistry; fetch?: typeof fetch; steps?: Partial<ServiceNowStepsOptions> } = {}): ServiceNowIntegration {
  const cfg = parseServiceNowConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const client = new ServiceNowClient({ instanceUrl: cfg.instanceUrl, auth: createAuthHeader(cfg.auth, registry, 'servicenow.auth', o), timeoutMs: cfg.timeoutMs, fetch: o.fetch });
  const perRole = new Map<string, ServiceNowClient>();
  const user = (r: string) => {
    const u = cfg.users[r];
    if (!u) throw new EzTestError(`Unknown ServiceNow role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'SN_UNKNOWN_ROLE');
    return u;
  };
  const clientFor = (r: string) => {
    let c = perRole.get(r);
    if (!c) perRole.set(r, (c = new ServiceNowClient({ instanceUrl: cfg.instanceUrl, auth: roleAuthHeader(user(r), registry, `servicenow.users.${r}`), timeoutMs: cfg.timeoutMs, fetch: o.fetch })));
    return c;
  };
  const intentRules = createServiceNowIntentRules();
  const customSteps = createServiceNowSteps({
    client, portal: cfg.portal, timeoutMs: cfg.timeoutMs,
    credentials: async (r) => ({ username: await usernameOf(user(r), registry), password: passwordHandle(user(r), registry, `servicenow.users.${r}.password`) }),
    ...o.steps,
  });
  return {
    config: cfg,
    client,
    clientFor,
    intentRules,
    customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s = {}) => snapshotServiceNow(client, cfg.tables, s),
    async changes(c) {
      const out: AppChange[] = [];
      for (const us of c.updateSets ?? []) out.push(...(await updateSetChanges(client, us, { tables: cfg.tables })));
      if (c.skipped) out.push(...(await skippedUpgradeChanges(client, { tables: cfg.tables, upgrade: c.upgrade })));
      if (c.before && c.after) out.push(...diffSnapshots(c.before, c.after));
      return out;
    },
    impact: (changes, journeys) => impactReport('servicenow', changes, journeys, serviceNowScoper),
    permissionMatrix: (checks, ui) =>
      serviceNowPermissionMatrix({ users: Object.fromEntries(Object.keys(cfg.users).map((r) => [r, clientFor(r)])), admin: client, checks, ui: ui ? { ...ui, instanceUrl: cfg.instanceUrl } : undefined }),
  };
}
