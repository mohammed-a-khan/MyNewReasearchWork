/**
 * `workday:` configuration and wiring.
 *
 *   workday:
 *     url: https://wd2-impl-services1.workday.com      # API host
 *     uiUrl: https://wd2-impl.workday.com/ezcorp        # UI root (default <url>/<tenant>)
 *     tenant: ezcorp
 *     auth: { type: oauth2, grant: refresh_token, tokenUrl: https://.../ccx/oauth2/ezcorp/token, clientId: ..., clientSecret: secret://vault/wd-cs, refreshToken: secret://vault/wd-rt }
 *     isu: { username: ISU_EZTest@ezcorp, password: secret://vault/wd-isu }
 *     users: { hr: { username: bliu, password: secret://vault/wd-hr } }
 *     dataSources: [allWorkers]
 *     tasks: [Hire Employee, Change Job]
 *     whatsNewReport: { owner: ISU_EZTest, name: Whats_New_in_Workday }
 */
import { z } from 'zod';
import type { Page } from '../../browser/index.js';
import { EzTestError, type Journey } from '../../core/index.js';
import { SecretRegistry, isSecretRef } from '../../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../../intent/index.js';
import type { CustomStepHandler } from '../../runner/types.js';
import { AppApiError, AuthSchema, RoleUserSchema, createAuthHeader, passwordHandle, roleAuthHeader, usernameOf } from '../common/http.js';
import { diffSnapshots, impactReport, type AppChange, type AppSnapshot, type ImpactReport } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import { runMatrix, type MatrixReport, type PermissionCheckBase } from '../common/permissions.js';
import { WorkdayClient } from './client.js';
import { snapshotWorkday, whatsNewChanges, workdayScoper } from './impact.js';
import { createWorkdayIntentRules } from './intents.js';
import { createWorkdaySteps, workdayLogin, workdaySearch, type WorkdayStepsOptions } from './steps.js';

export const WorkdayConfigSchema = z.object({
  url: z.string().url(),
  uiUrl: z.string().url().optional(),
  tenant: z.string().regex(/^[\w-]+$/),
  auth: AuthSchema,
  isu: z.object({ username: z.string().min(1), password: z.string().min(1) }).optional(),
  users: z.record(z.string().regex(/^[\w.-]+$/), RoleUserSchema).default({}),
  dataSources: z.array(z.string().regex(/^[A-Za-z]\w*$/)).default(['allWorkers']),
  tasks: z.array(z.string().min(1)).default([]),
  whatsNewReport: z.object({ owner: z.string().min(1), name: z.string().min(1) }).optional(),
  soapVersion: z.string().regex(/^v\d+\.\d+$/).default('v42.0'),
  timeoutMs: z.number().int().positive().optional(),
});
export type WorkdayConfig = z.infer<typeof WorkdayConfigSchema>;
export type WorkdayConfigInput = z.input<typeof WorkdayConfigSchema>;

export function parseWorkdayConfig(input: unknown): WorkdayConfig {
  const r = WorkdayConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid workday config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'WD_CONFIG');
  return r.data;
}

export interface WorkdayPermissionCheck extends PermissionCheckBase {
  /** Task name: expect available | unavailable (global search, as the user). */
  task?: string;
  /** WQL data source: expect read | none (WQL as the user). */
  dataSource?: string;
}

export interface WorkdayIntegration {
  config: WorkdayConfig;
  client: WorkdayClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  registerIntents(): () => void;
  /** Data-source fields, plus the configured task forms when a signed-in page is given. */
  snapshot(o?: { release?: string; page?: Page }): Promise<AppSnapshot>;
  changes(o: { before?: AppSnapshot; after?: AppSnapshot; whatsNew?: boolean | Array<Record<string, string>>; release?: string }): Promise<AppChange[]>;
  impact(changes: AppChange[], journeys: Journey[]): ImpactReport;
  permissionMatrix(checks: WorkdayPermissionCheck[], ui?: { pages: Record<string, Page> }): Promise<MatrixReport>;
}

export function createWorkdayIntegration(input: WorkdayConfigInput | WorkdayConfig, o: { secrets?: SecretRegistry; fetch?: typeof fetch; steps?: Partial<WorkdayStepsOptions> } = {}): WorkdayIntegration {
  const cfg = parseWorkdayConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const isuName = cfg.isu ? (isSecretRef(cfg.isu.username) ? undefined : cfg.isu.username) : undefined;
  if (cfg.isu && !isuName) throw new EzTestError('workday.isu.username must be a plain name (the password may be a secret://)', 'WD_CONFIG');
  const mk = (auth: ReturnType<typeof createAuthHeader>) => new WorkdayClient({
    baseUrl: cfg.url, tenant: cfg.tenant, auth, soapVersion: cfg.soapVersion, timeoutMs: cfg.timeoutMs, fetch: o.fetch,
    ...(cfg.isu ? { isu: { username: isuName!, password: registry.from(cfg.isu.password, 'workday.isu.password') } } : {}),
  });
  const client = mk(createAuthHeader(cfg.auth, registry, 'workday.auth', o));
  const user = (r: string) => {
    const u = cfg.users[r];
    if (!u) throw new EzTestError(`Unknown Workday role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'WD_UNKNOWN_ROLE');
    return u;
  };
  const perRole = new Map<string, WorkdayClient>();
  const clientFor = (r: string) => {
    let c = perRole.get(r);
    if (!c) {
      const u = user(r);
      perRole.set(r, (c = mk(roleAuthHeader({ username: isSecretRef(u.username) ? u.username : `${u.username}@${cfg.tenant}`, password: u.password }, registry, `workday.users.${r}`))));
    }
    return c;
  };
  const uiUrl = cfg.uiUrl ?? `${cfg.url.replace(/\/+$/, '')}/${cfg.tenant}`;
  const intentRules = createWorkdayIntentRules();
  const customSteps = createWorkdaySteps({
    client, uiUrl, timeoutMs: cfg.timeoutMs, workerDataSource: cfg.dataSources[0],
    credentials: async (r) => ({ username: await usernameOf(user(r), registry), password: passwordHandle(user(r), registry, `workday.users.${r}.password`) }),
    ...o.steps,
  });
  return {
    config: cfg, client, intentRules, customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s = {}) => snapshotWorkday(client, { dataSources: cfg.dataSources, tasks: cfg.tasks, page: s.page, release: s.release }),
    async changes(c) {
      const out: AppChange[] = [];
      if (c.before && c.after) out.push(...diffSnapshots(c.before, c.after, { source: `Workday ${c.before.release ?? 'production'} -> ${c.after.release ?? 'preview'} tenant comparison` }));
      if (c.whatsNew) {
        const rows = Array.isArray(c.whatsNew) ? c.whatsNew : cfg.whatsNewReport ? await client.report(cfg.whatsNewReport.owner, cfg.whatsNewReport.name) : [];
        if (c.whatsNew === true && !cfg.whatsNewReport) throw new EzTestError('workday.whatsNewReport is not configured', 'WD_CONFIG');
        out.push(...whatsNewChanges(rows, c.release ?? c.after?.release ?? 'next release'));
      }
      return out;
    },
    impact: (changes, journeys) => impactReport('workday', changes, journeys, workdayScoper),
    permissionMatrix: (checks, ui) => runMatrix<WorkdayPermissionCheck>({
      pack: 'workday', users: Object.keys(cfg.users), checks, order: ['none', 'read', 'unavailable', 'available'],
      subject: (c) => (c.task ? `task:${c.task}` : `dataSource:${c.dataSource}`),
      probe: async (u, c) => {
        if (c.dataSource) {
          try {
            await clientFor(u).fields(c.dataSource);
            return { api: 'read' };
          } catch (e) {
            if (e instanceof AppApiError && e.status === 403) return { api: 'none' };
            throw e;
          }
        }
        const page = ui?.pages[u];
        if (!page) return { detail: 'task availability is checked in the UI only (pass signed-in pages)' };
        if ((await page.locator('[data-automation-id="globalSearchInput"]').count()) !== 1) {
          const cred = user(u);
          const r = await workdayLogin(page, uiUrl, await usernameOf(cred, registry), await passwordHandle(cred, registry, `workday.users.${u}.password`).resolve(), 10_000);
          if (!r.ok) throw new EzTestError(`Workday sign-in as ${u} failed: ${r.error}`, 'WD_LOGIN_FAILED');
        }
        const tasks = (await workdaySearch(page, c.task!, cfg.timeoutMs ?? 10_000)).filter((x) => x.category === 'tasks').map((x) => x.label);
        return { ui: tasks.some((x) => normalizeLabel(x) === normalizeLabel(c.task!)) ? 'available' : 'unavailable' };
      },
    }),
  };
}
