/**
 * `sap:` configuration (Fiori/OData pack) and one-call wiring. The SAP GUI
 * rung stays configured under `desktop.sap` (docs/desktop-and-legacy.md);
 * transport impact covers journeys of both.
 *
 *   sap:
 *     url: https://s4qas.example.com:44300        # the system journeys run against (e.g. QAS)
 *     client: '100'
 *     auth: { type: basic, username: COMM_EZTEST, password: secret://vault/sap-comm }
 *     users: { clerk: { username: FIORI_CLERK, password: secret://vault/sap-clerk } }
 *     services:
 *       - { name: SD_SALESORDER_MANAGE_SRV, version: 2, path: /sap/opu/odata/sap/SD_SALESORDER_MANAGE_SRV }
 *       - { name: api_product, version: 4, path: /sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0001 }
 *     apps:
 *       - { title: Manage Sales Orders, intent: SalesOrder-manage, service: SD_SALESORDER_MANAGE_SRV, entitySet: C_SalesOrder, tcodes: [VA02, VA03], ui5App: ZSD_SO_MANAGE }
 *     source: { url: https://s4dev.example.com:44300, client: '100', auth: { type: basic, ... } }   # where transports are released (e.g. DEV)
 *     objectMap: { 'PROG ZSD_PRICING': [VA01, C_SalesOrder.TotalNetAmount] }
 */
import { z } from 'zod';
import { EzTestError, type Journey } from '../../core/index.js';
import { SecretRegistry } from '../../identity/handle.js';
import { registerIntentRules, type IntentRule } from '../../intent/index.js';
import type { CustomStepHandler } from '../../runner/types.js';
import type { Page } from '../../browser/index.js';
import { AuthSchema, RoleUserSchema, createAuthHeader, passwordHandle, roleAuthHeader, usernameOf } from '../common/http.js';
import { diffSnapshots, impactReport, type AppChange, type AppSnapshot, type ImpactReport } from '../common/impact.js';
import { AppApiError } from '../common/http.js';
import { normalizeLabel } from '../common/kit.js';
import { runMatrix, type MatrixReport, type PermissionCheckBase } from '../common/permissions.js';
import { sapScoper, snapshotSap, transportChanges } from './impact.js';
import { createFioriIntentRules } from './intents.js';
import { SapODataClient, parseTransport, type Transport } from './odata.js';
import { createFioriSteps, type FioriStepsOptions } from './steps.js';

const ServiceSchema = z.object({ name: z.string().min(1), version: z.union([z.literal(2), z.literal(4)]), path: z.string().regex(/^\/[\w/.-]+$/) });
const AppSchema = z.object({
  title: z.string().min(1), intent: z.string().regex(/^[\w]+-[\w]+$/).optional(), service: z.string().min(1), entitySet: z.string().regex(/^\w+$/),
  tcodes: z.array(z.string().regex(/^[A-Z0-9_/]+$/)).optional(), ui5App: z.string().optional(),
});
const SystemSchema = z.object({ url: z.string().url(), client: z.string().regex(/^\d{3}$/).optional(), auth: AuthSchema });

export const SapConfigSchema = z.object({
  url: z.string().url(),
  client: z.string().regex(/^\d{3}$/).default('100'),
  auth: AuthSchema,
  users: z.record(z.string().regex(/^[\w.-]+$/), RoleUserSchema).default({}),
  services: z.array(ServiceSchema).min(1),
  apps: z.array(AppSchema).default([]),
  launchpadPath: z.string().default('/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html'),
  /** The system transports are released from (compared with `url` for transport impact). */
  source: SystemSchema.optional(),
  objectMap: z.record(z.string().regex(/^[A-Z]{4} \S+$/), z.array(z.string().min(1))).default({}),
  timeoutMs: z.number().int().positive().optional(),
}).refine((c) => c.apps.every((a) => c.services.some((s) => s.name === a.service)), { message: 'every sap.apps[].service must be one of sap.services', path: ['apps'] });
export type SapConfig = z.infer<typeof SapConfigSchema>;
export type SapConfigInput = z.input<typeof SapConfigSchema>;

export function parseSapConfig(input: unknown): SapConfig {
  const r = SapConfigSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid sap config: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'SAP_CONFIG');
  return r.data;
}

export interface SapPermissionCheck extends PermissionCheckBase {
  /** Fiori app title: expect visible | hidden (tile on the launchpad; API: the app's OData service). */
  app?: string;
  /** OData service (and optionally entity set): expect read | none. */
  service?: string;
  entitySet?: string;
}

export interface SapIntegration {
  config: SapConfig;
  client: SapODataClient;
  /** The transport source system's client (when sap.source is set). */
  sourceClient?: SapODataClient;
  clientFor(role: string): SapODataClient;
  intentRules: IntentRule[];
  customSteps: Record<string, CustomStepHandler>;
  registerIntents(): () => void;
  snapshot(o?: { release?: string; system?: 'target' | 'source' }): Promise<AppSnapshot>;
  /** Transport impact: by number (read from the source system via ADT) or parsed transports. */
  changes(o: { transports?: Array<string | Transport>; before?: AppSnapshot; after?: AppSnapshot }): Promise<AppChange[]>;
  impact(changes: AppChange[], journeys: Journey[]): ImpactReport;
  permissionMatrix(checks: SapPermissionCheck[], ui?: { pages: Record<string, Page>; timeoutMs?: number }): Promise<MatrixReport>;
}

export function createSapIntegration(input: SapConfigInput | SapConfig, o: { secrets?: SecretRegistry; fetch?: typeof fetch; steps?: Partial<FioriStepsOptions> } = {}): SapIntegration {
  const cfg = parseSapConfig(input);
  const registry = o.secrets ?? new SecretRegistry();
  const mk = (url: string, client: string | undefined, auth: Parameters<typeof createAuthHeader>[0] | ReturnType<typeof roleAuthHeader>, label: string) =>
    new SapODataClient({ url, client, auth: 'header' in auth ? auth : createAuthHeader(auth, registry, label, o), services: cfg.services, timeoutMs: cfg.timeoutMs, fetch: o.fetch });
  const client = mk(cfg.url, cfg.client, cfg.auth, 'sap.auth');
  const sourceClient = cfg.source ? mk(cfg.source.url, cfg.source.client ?? cfg.client, cfg.source.auth, 'sap.source.auth') : undefined;
  const user = (r: string) => {
    const u = cfg.users[r];
    if (!u) throw new EzTestError(`Unknown SAP role "${r}". Configured roles: ${Object.keys(cfg.users).join(', ') || '(none)'}`, 'SAP_UNKNOWN_ROLE');
    return u;
  };
  const perRole = new Map<string, SapODataClient>();
  const clientFor = (r: string) => {
    let c = perRole.get(r);
    if (!c) perRole.set(r, (c = mk(cfg.url, cfg.client, roleAuthHeader(user(r), registry, `sap.users.${r}`), `sap.users.${r}`)));
    return c;
  };
  const launchpadUrl = `${cfg.url.replace(/\/+$/, '')}${cfg.launchpadPath}?sap-client=${cfg.client}`;
  const intentRules = createFioriIntentRules();
  const customSteps = createFioriSteps({
    client, apps: cfg.apps, launchpadUrl, timeoutMs: cfg.timeoutMs,
    credentials: async (r) => ({ username: await usernameOf(user(r), registry), password: passwordHandle(user(r), registry, `sap.users.${r}.password`) }),
    ...o.steps,
  });
  const ictx = { apps: cfg.apps, objectMap: cfg.objectMap };
  return {
    config: cfg, client, sourceClient, clientFor, intentRules, customSteps,
    registerIntents: () => registerIntentRules(intentRules),
    snapshot: (s = {}) => {
      const c = s.system === 'source' ? sourceClient : client;
      if (!c) throw new EzTestError('sap.source is not configured', 'SAP_CONFIG');
      return snapshotSap(c, ictx, { release: s.release });
    },
    async changes(c) {
      const src = sourceClient ?? client;
      const transports: Transport[] = [];
      for (const t of c.transports ?? []) transports.push(typeof t === 'string' ? (/^[A-Z0-9]{3}K\d{6}$/.test(t) ? await src.transport(t) : parseTransport(t)) : t);
      let before = c.before;
      let after = c.after;
      if (!before && !after && sourceClient && transports.length) {
        before = await snapshotSap(client, ictx, { release: 'target' });
        after = await snapshotSap(sourceClient, ictx, { release: 'source' });
      }
      const diff = before && after ? diffSnapshots(before, after) : [];
      if (!transports.length) return diff;
      const labels: Record<string, { before?: string[]; after?: string[] }> = {};
      for (const tr of transports) {
        for (const obj of tr.objects.filter((x) => x.type === 'DTEL')) {
          const a = sourceClient ? await sourceClient.dataElement(obj.name).catch(() => undefined) : undefined;
          const b = await client.dataElement(obj.name).catch(() => undefined);
          labels[obj.name] = { before: b ? [b.short, b.medium, b.long, b.heading] : undefined, after: a ? [a.short, a.medium, a.long, a.heading] : undefined };
        }
      }
      const entitySetsOf = (svc: string) => [...new Set(diff.filter((d) => d.objectNames.includes(svc)).map((d) => d.object).concat(cfg.apps.filter((a) => a.service === svc).map((a) => a.entitySet)))];
      const entitySets = [...new Set([...diff.map((d) => d.object), ...cfg.apps.map((a) => a.entitySet), ...(before ? Object.keys(before.objects) : [])])];
      const r = transportChanges(transports, { ...ictx, entitySets, services: cfg.services.map((s) => s.name), entitySetsOf }, { diff, labels });
      return [...r.changes, ...r.unattributed.map((u) => ({ ...u, source: `${u.source} (not caused by the analysed transports)` }))];
    },
    impact: (changes, journeys) => impactReport('sap', changes, journeys, sapScoper(cfg.apps)),
    async permissionMatrix(checks, ui) {
      const roles = Object.keys(cfg.users);
      return runMatrix<SapPermissionCheck>({
        pack: 'sap', users: roles, checks, order: ['none', 'read', 'hidden', 'visible'],
        subject: (c) => (c.app ? `app:${c.app}` : `service:${c.service}${c.entitySet ? `/${c.entitySet}` : ''}`),
        apiLevel: (e) => e,
        probe: async (u, c) => {
          const uc = clientFor(u);
          const app = c.app ? cfg.apps.find((a) => normalizeLabel(a.title) === normalizeLabel(c.app!)) : undefined;
          if (c.app && !app) throw new EzTestError(`Permission check names unknown Fiori app "${c.app}" (sap.apps)`, 'SAP_CONFIG');
          const svc = app?.service ?? c.service!;
          const set = app?.entitySet ?? c.entitySet;
          let reachable: boolean;
          try {
            if (set) await uc.query(svc, set, { top: 1 });
            else await uc.metadata(svc);
            reachable = true;
          } catch (e) {
            if (e instanceof AppApiError && e.status === 403) reachable = false;
            else throw e;
          }
          const r: { api?: string; ui?: string; detail?: string } = { api: c.app ? (reachable ? 'visible' : 'hidden') : reachable ? 'read' : 'none' };
          const page = ui?.pages[u];
          if (page && c.app) {
            await page.goto(`${launchpadUrl}#Shell-home`, { timeout: ui?.timeoutMs ?? 10_000 });
            const titles = await page.locator('.sapUshellTile').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
            r.ui = titles.some((t) => normalizeLabel(t) === normalizeLabel(c.app!)) ? 'visible' : 'hidden';
          }
          return r;
        },
      });
    },
  };
}
