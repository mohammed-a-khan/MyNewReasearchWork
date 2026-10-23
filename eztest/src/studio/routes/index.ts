/**
 * Every built-in route module. A new feature adds `routes/<feature>.ts`
 * exporting `StudioRoute[]` and lists it here (see docs/studio.md).
 */
import { assetRoutes } from './assets.js';
import { assuranceRoutes } from './assurance-index.js';
import { eventRoutes } from './events.js';
import { importRoutes } from './import.js';
import { insightRoutes } from './insights.js';
import { journeyRoutes } from './journeys.js';
import { recordRoutes } from './record.js';
import { runRoutes } from './runs.js';
import { sessionRoutes } from './session.js';
import { settingsRoutes } from './settings.js';
import { staticRoutes } from './static.js';
import { qualityCompareRoutes } from './quality-compare.js';
import { qualityFlakyRoutes } from './quality-flaky.js';
import { qualityHealRoutes } from './quality-heals.js';
import { qualityReadinessRoutes } from './quality-readiness.js';
import { qualityTraceabilityRoutes } from './quality-traceability.js';
import { qualityTriageRoutes } from './quality-triage.js';
import { qualityTrendRoutes } from './quality-trends.js';
import { qualityCoverageRoutes } from './quality-coverage.js';
import { manualRoutes } from './manual.js';
import { scmRoutes } from './scm.js';
import { pluginRoutes } from './plugins.js';
import type { StudioRoute } from './route.js';

export type { StudioRoute, StudioRouteContext } from './route.js';

export function coreRoutes(token: string): StudioRoute[] {
  return [
    ...staticRoutes(token),
    ...sessionRoutes,
    ...eventRoutes,
    ...journeyRoutes,
    ...runRoutes,
    ...insightRoutes,
    ...recordRoutes,
    ...importRoutes,
    ...settingsRoutes,
    ...assetRoutes,
    // Quality Center (heal review, triage, flaky/quarantine, readiness, traceability, compare, trends).
    ...qualityHealRoutes,
    ...qualityTriageRoutes,
    ...qualityFlakyRoutes,
    ...qualityReadinessRoutes,
    ...qualityTraceabilityRoutes,
    ...qualityCompareRoutes,
    ...qualityTrendRoutes,
    // Coverage analytics (UI coverage map, combined coverage, trends) and test management (manual / hybrid).
    ...qualityCoverageRoutes,
    ...manualRoutes,
    ...assuranceRoutes(),
    // Source Control (git status, diffs, commits, branches, blame, conflicts, PR proposals).
    ...scmRoutes,
    // Pages contributed by plugins (an empty list without plugins).
    ...pluginRoutes,
  ];
}
