/**
 * `powerapps:` configuration (canvas apps) and wiring. Dataverse access
 * reuses the Dynamics 365 add-on's DataverseClient, metadata snapshots and
 * its "Verify in Dataverse that ..." step.
 *
 *   powerapps:
 *     apps:
 *       - { name: Account Manager, url: https://apps.powerapps.com/play/e/<env>/a/<app-id>, appId: <app-id> }
 *     users: { maker: { username: megan@contoso.com, password: secret://vault/pa-maker } }
 *     dataverse: { url: https://contoso.crm.dynamics.com, tenantId: <tenant>, clientId: ..., clientSecret: secret://vault/dv, entities: [account] }
 *     api: { url: https://api.powerapps.com, tokenUrl: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token, clientId: ..., clientSecret: secret://vault/pa-api }
 */
import { z } from 'zod';
import type { Page } from '../../browser/index.js';
import { EzTestError, type Journey } from '../../core/index.js';
import { DataverseClient, createD365Steps, diffMetadata, snapshotMetadata, type MetadataSnapshot } from '../../d365/index.js';
import { SecretRegistry } from '../../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../../intent/index.js';
import type { CustomStepHandler } from '../../runner/types.js';
import { AppHttp, RoleUserSchema, createAuthHeader, passwordHandle, usernameOf } from '../common/http.js';
import { impactReport, type AppChange, type AppSnapshot, type ImpactReport } from '../common/impact.js';
import { normalizeLabel } from '../common/kit.js';
import { runMatrix, type MatrixReport, type PermissionCheckBase } from '../common/permissions.js';
import { canvasAppChanges, dataverseChangesForApp, parseCanvasSource, powerAppsScoper, snapshotCanvasApp, type CanvasSource } from './impact.js';
import { createPowerAppsIntentRules } from './intents.js';
import { APP_FRAME, canvasSnapshot, createPowerAppsSteps, powerAppsLogin, type PowerAppsStepsOptions } from './steps.js';

const Oauth = z.object({ tokenUrl: z.string().url().optional(), tenantId: z.string().regex(/^[A-Za-z0-9.-]+$/).optional(), clientId: z.string().min(1), clientSecret: z.string().min(1), scope: z.string().optional() })
  .refine((c) => !!c.tokenUrl || !!c.tenantId, { message: 'needs tokenUrl or tenantId' });

export const PowerAppsConfigSchema = z.object({
  apps: z.array(z.object({ name: z.string().min(1), url: z.string().url(), appId: z.string().regex(/^[\w-]+$/).optional() })).min(1),
  users: z.record(z.string().regex(/^[\w.-]+$/), RoleUserSchema).default({}),
  dataverse: Oauth.and(z.object({ url: z.string().url(), entities: z.array(z.string().min(1)).default([]) })).optional(),
  api: Oauth.and(z.object({ url: z.string().url() })).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type PowerAppsConfig = z.infer<typeof PowerAppsConfigSchema>;
export type PowerAppsConfigInput = z.input<typeof PowerAppsConfigSchema>;

export function parsePowerAppsConfig(input: unknown): PowerAppsConfig {
  const r = PowerAppsConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid powerapps config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'PA_CONFIG');
  return r.data;
}

export interface PowerAppsPermissionCheck extends PermissionCheckBase {
  /** App sharing: expect owner | can-edit | can-view | none (permissions API; the player opens or denies). */
  app?: string;
  /** A control as the user sees it: expect visible | hidden | disabled. */
  control?: string;
}

export interface PowerAppsIntegration {
  config: PowerAppsConfig;
  dataverse?: DataverseClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  registerIntents(): () => void;
  /** Snapshot an app version from its source YAML (pac canvas unpack / source control). */
  snapshot(o: { source: string; release?: string }): AppSnapshot;
  dataverseSnapshot(): Promise<MetadataSnapshot>;
  changes(o: { beforeSource?: string; afterSource?: string; dataverseBefore?: MetadataSnapshot; dataverseAfter?: MetadataSnapshot }): AppChange[];
  impact(changes: AppChange[], journeys: Journey[]): ImpactReport;
  permissionMatrix(checks: PowerAppsPermissionCheck[], ui?: { pages: Record<string, Page> }): Promise<MatrixReport>;
}

const tokenUrlOf = (c: { tokenUrl?: string; tenantId?: string }) => c.tokenUrl ?? `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`;

export function createPowerAppsIntegration(input: PowerAppsConfigInput | PowerAppsConfig, o: { secrets?: SecretRegistry; fetch?: typeof fetch; steps?: Partial<PowerAppsStepsOptions>; provideDataverseVerify?: boolean } = {}): PowerAppsIntegration {
  const cfg = parsePowerAppsConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const user = (r: string) => {
    const u = cfg.users[r];
    if (!u) throw new EzTestError(`Unknown Power Apps role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'PA_UNKNOWN_ROLE');
    return u;
  };
  const dv = cfg.dataverse;
  const dataverse = dv
    ? new DataverseClient({
      url: dv.url, timeoutMs: cfg.timeoutMs, fetch: o.fetch,
      tokenProvider: (() => {
        const h = createAuthHeader({ type: 'oauth2', grant: 'client_credentials', authMethod: 'body', tokenUrl: tokenUrlOf(dv), clientId: dv.clientId, clientSecret: dv.clientSecret, scope: dv.scope ?? `${dv.url.replace(/\/+$/, '')}/.default` }, registry, 'powerapps.dataverse', o);
        return { getToken: async () => (await h.header()).replace(/^Bearer /, ''), invalidate: () => h.invalidate() };
      })(),
    })
    : undefined;
  const api = cfg.api
    ? new AppHttp({ baseUrl: cfg.api.url, product: 'Power Apps', fetch: o.fetch, timeoutMs: cfg.timeoutMs, auth: createAuthHeader({ type: 'oauth2', grant: 'client_credentials', authMethod: 'body', tokenUrl: tokenUrlOf(cfg.api), clientId: cfg.api.clientId, clientSecret: cfg.api.clientSecret, scope: cfg.api.scope ?? 'https://service.powerapps.com//.default' }, registry, 'powerapps.api', o) })
    : undefined;
  const provideDv = (o.provideDataverseVerify ?? true) && !!dataverse;
  const intentRules = createPowerAppsIntentRules({ dataverse: provideDv });
  const customSteps: Record<string, CustomStepHandler> = {
    ...createPowerAppsSteps({
      apps: cfg.apps, timeoutMs: cfg.timeoutMs,
      credentials: async (r) => ({ username: await usernameOf(user(r), registry), password: passwordHandle(user(r), registry, `powerapps.users.${r}.password`) }),
      ...o.steps,
    }),
    ...(provideDv ? { 'd365.verifyDataverse': createD365Steps({ metadata: dataverse!, client: dataverse!, timeoutMs: cfg.timeoutMs })['d365.verifyDataverse'] } : {}),
  };
  const appNames = cfg.apps.map((a) => a.name);
  const parse = (s: string): CanvasSource => parseCanvasSource(s);
  return {
    config: cfg, dataverse, intentRules, customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s) => snapshotCanvasApp(parse(s.source), { release: s.release }),
    dataverseSnapshot: () => {
      if (!dataverse || !dv?.entities.length) throw new EzTestError('powerapps.dataverse.entities is not configured', 'PA_CONFIG');
      return snapshotMetadata(dataverse, dv.entities, { source: dv.url });
    },
    changes(c) {
      const out: AppChange[] = [];
      const before = c.beforeSource ? parse(c.beforeSource) : undefined;
      const after = c.afterSource ? parse(c.afterSource) : undefined;
      if (before && after) out.push(...canvasAppChanges(before, after));
      if (c.dataverseBefore && c.dataverseAfter) {
        const app = after ?? before;
        if (!app) throw new EzTestError('Mapping Dataverse changes onto a canvas app needs its source (beforeSource or afterSource)', 'PA_BAD_INPUT');
        const diff = diffMetadata(c.dataverseBefore, c.dataverseAfter);
        out.push(...dataverseChangesForApp(diff, app));
        // Plain column changes too, for "Verify in Dataverse" steps.
        for (const d of diff.changes) {
          const names = [d.logicalName, d.before?.displayName, d.after?.displayName].filter((x): x is string => !!x);
          const kind = d.change === 'removed' ? 'field-removed' : d.change === 'relabeled' ? 'field-relabeled' : d.change === 'type-changed' ? 'field-type-changed' : d.change === 'options-changed' ? 'values-removed' : d.change === 'added' ? 'field-added' : 'field-required';
          out.push({ pack: 'powerapps', kind, object: d.entity, objectNames: diff.entityNames[d.entity] ?? [d.entity], field: d.logicalName, fieldNames: names, ...(kind === 'field-relabeled' && d.before?.displayName ? { breakingNames: [d.before.displayName] } : {}), severity: kind === 'field-added' || kind === 'values-removed' ? 'review' : 'breaking', source: 'Dataverse metadata', detail: d.detail });
        }
      }
      return out;
    },
    impact: (changes, journeys) => impactReport('powerapps', changes, journeys, powerAppsScoper(appNames)),
    permissionMatrix: (checks, ui) => runMatrix<PowerAppsPermissionCheck>({
      pack: 'powerapps', users: Object.keys(cfg.users), checks, order: ['none', 'can-view', 'can-edit', 'owner', 'opens', 'hidden', 'disabled', 'visible'],
      subject: (c) => (c.app ? `app:${c.app}` : `control:${c.control}`),
      uiLevel: (e, c) => (c.app ? (e === 'none' ? 'none' : 'opens') : e),
      probe: async (u, c) => {
        const app = cfg.apps.find((a) => normalizeLabel(a.name) === normalizeLabel(c.app ?? cfg.apps[0].name));
        if (!app) throw new EzTestError(`Unknown canvas app "${c.app}"`, 'PA_CONFIG');
        const r: { api?: string; ui?: string; detail?: string } = {};
        const username = await usernameOf(user(u), registry);
        if (c.app && api && app.appId) {
          const b = await api.json<{ value: Array<{ properties: { roleName: string; principal: { email?: string } } }> }>('GET', `providers/Microsoft.PowerApps/apps/${app.appId}/permissions`, { query: { 'api-version': '2016-11-01' } });
          const hit = b.value.find((p) => (p.properties.principal.email ?? '').toLowerCase() === username.toLowerCase());
          r.api = hit ? hit.properties.roleName.replace(/^Can/, 'can-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() : 'none';
        }
        const page = ui?.pages[u];
        if (page) {
          const signedIn = await powerAppsLogin(page, app.url, username, await passwordHandle(user(u), registry, `powerapps.users.${u}.password`).resolve(), cfg.timeoutMs ?? 10_000);
          const opened = signedIn.ok && (await page.locator(APP_FRAME).count()) === 1;
          if (c.app) r.ui = opened ? 'opens' : 'none';
          else if (!opened) r.ui = 'hidden';
          else {
            const f = page.frameLocator(APP_FRAME);
            await f.locator('[data-control-type="Screen"]').first().waitFor({ timeout: cfg.timeoutMs ?? 10_000 });
            const snap = await canvasSnapshot(f);
            const ctl = snap.controls[c.control!];
            r.ui = !ctl || ctl.props.Visible === false ? 'hidden' : ctl.props.DisplayMode === 'Disabled' ? 'disabled' : 'visible';
          }
        }
        return r;
      },
    }),
  };
}
