/**
 * The Assurance, Workbench and Project route modules, mounted together by
 * `coreRoutes()` (routes/index.ts).
 */
import { documentRoutes } from './assurance-documents.js';
import { lensRoutes } from './assurance-lenses.js';
import { pdfjsRoutes } from './assurance-pdfjs.js';
import { complianceRoutes } from './project-compliance.js';
import { dataRoutes } from './project-data.js';
import { environmentRoutes } from './project-environments.js';
import { identityRoutes } from './project-identity.js';
import { mockRoutes } from './project-mocks.js';
import { contractRoutes } from './project-contracts.js';
import { monitorRoutes } from './project-monitors.js';
import { elementRoutes } from './project-elements.js';
import { perfRoutes } from './project-perf.js';
import { loadRoutes } from './load.js';
import type { StudioRoute } from './route.js';
import { workbenchRoutes } from './workbench.js';

export function assuranceRoutes(): StudioRoute[] {
  return [
    ...pdfjsRoutes,
    ...documentRoutes,
    ...lensRoutes,
    ...workbenchRoutes,
    ...environmentRoutes,
    ...identityRoutes,
    ...dataRoutes,
    ...mockRoutes,
    ...contractRoutes,
    ...monitorRoutes,
    ...elementRoutes,
    ...perfRoutes,
    // Performance workspace (EZTest Load).
    ...loadRoutes,
    ...complianceRoutes,
  ];
}
