/**
 * Packaged-app packs (WP14): SAP Fiori/UI5, ServiceNow, Workday, Oracle
 * (Fusion Cloud + EBS) and Power Apps canvas apps. Each pack has
 * metadata-aware plain-English steps, platform API cross-checks, metadata
 * snapshots with release/transport/update-set impact ("which journeys does
 * this change break"), and a role/permission matrix. All packs are tested
 * against emulations in examples/<pack>-mock, not against real tenants.
 *
 * enableAppPacks() builds the integrations for the config blocks that are
 * present (`sap:`, `servicenow:`, `workday:`, `oracle:`, `powerapps:`) and
 * registers their phrasings; the engine calls it from enableAddons().
 */
import { SecretRegistry } from '../identity/handle.js';
import type { CustomStepHandler } from '../runner/types.js';
import { createOracleIntegration, type OracleIntegration } from './oracle/index.js';
import { createPowerAppsIntegration, type PowerAppsIntegration } from './powerapps/index.js';
import { createSapIntegration, type SapIntegration } from './sap/index.js';
import { createServiceNowIntegration, type ServiceNowIntegration } from './servicenow/index.js';
import { createWorkdayIntegration, type WorkdayIntegration } from './workday/index.js';

export * as servicenow from './servicenow/index.js';
export * as sap from './sap/index.js';
export * as workday from './workday/index.js';
export * as oracle from './oracle/index.js';
export * as powerapps from './powerapps/index.js';
export {
  AppPackError, looseEquals, normalizeLabel, type PackId,
} from './common/kit.js';
export { AuthSchema, RoleUserSchema, createAuthHeader, AppHttp, AppApiError, type AuthConfig, type AuthHeader } from './common/http.js';
export { impactedJourneys, impactReport, diffSnapshots, makeSnapshot, type AppChange, type AppChangeKind, type AppSnapshot, type ImpactReport, type ImpactedJourney, type ImpactReason, type StepScoper } from './common/impact.js';
export { releaseNoteChanges, parseCsvRows } from './common/release-notes.js';
export { runMatrix, type MatrixReport, type MatrixResult, type PermissionCheckBase } from './common/permissions.js';

export const APP_PACKS = ['sap', 'servicenow', 'workday', 'oracle', 'powerapps'] as const;
export type AppPackName = (typeof APP_PACKS)[number];

export interface AppPacks {
  sap?: SapIntegration;
  servicenow?: ServiceNowIntegration;
  workday?: WorkdayIntegration;
  oracle?: OracleIntegration;
  powerapps?: PowerAppsIntegration;
  /** Every enabled pack's custom steps. */
  customSteps: Record<string, CustomStepHandler>;
  off(): void;
}

/** True when the config has at least one app-pack block. */
export function hasAppPacks(cfg: Partial<Record<AppPackName, unknown>>): boolean {
  return APP_PACKS.some((p) => cfg[p] !== undefined);
}

/**
 * Build the enabled packs and register their phrasings (before journeys are
 * parsed). `provideDataverseVerify`: let the Power Apps pack contribute the
 * D365 add-on's "Verify in Dataverse" step (when no `d365:` block does).
 */
export function enableAppPacks(cfg: Partial<Record<AppPackName, unknown>>, o: { secrets?: SecretRegistry; fetch?: typeof fetch; provideDataverseVerify?: boolean } = {}): AppPacks | undefined {
  if (!hasAppPacks(cfg)) return undefined;
  const secrets = o.secrets ?? new SecretRegistry();
  const packs: AppPacks = { customSteps: {}, off: () => {} };
  const offs: Array<() => void> = [];
  const add = <T extends { customSteps: Record<string, CustomStepHandler>; registerIntents(): () => void }>(i: T): T => {
    packs.customSteps = { ...packs.customSteps, ...i.customSteps };
    offs.push(i.registerIntents());
    return i;
  };
  try {
    if (cfg.sap) packs.sap = add(createSapIntegration(cfg.sap as never, { secrets, fetch: o.fetch }));
    if (cfg.servicenow) packs.servicenow = add(createServiceNowIntegration(cfg.servicenow as never, { secrets, fetch: o.fetch }));
    if (cfg.workday) packs.workday = add(createWorkdayIntegration(cfg.workday as never, { secrets, fetch: o.fetch }));
    if (cfg.oracle) packs.oracle = add(createOracleIntegration(cfg.oracle as never, { secrets, fetch: o.fetch }));
    if (cfg.powerapps) packs.powerapps = add(createPowerAppsIntegration(cfg.powerapps as never, { secrets, fetch: o.fetch, provideDataverseVerify: o.provideDataverseVerify }));
  } catch (e) {
    for (const off of offs.reverse()) off();
    throw e;
  }
  packs.off = () => {
    for (const off of offs.reverse()) off();
  };
  return packs;
}
