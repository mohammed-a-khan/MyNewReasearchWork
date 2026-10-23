/**
 * Quality Center: deployments. What was tested in each environment for each
 * version: deployment test records from the results server (when `server:`
 * is configured), else from the `deployment.json` of local runs.
 */
import { listDeployments } from '../../cli/pipelines.js';
import type { DeploymentRecord } from '../../pipelines/index.js';
import { sendJson } from '../http.js';
import type { StudioRoute } from './route.js';

export interface DeploymentsView {
  source: string;
  error?: string;
  environments: string[];
  versions: string[];
  /** The latest record per version and environment. */
  matrix: Record<string, Record<string, Pick<DeploymentRecord, 'id' | 'recordedAt' | 'pipeline' | 'runId' | 'results' | 'readiness'>>>;
  records: DeploymentRecord[];
}

export const qualityDeploymentRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/quality/deployments',
    summary: 'Deployment test records: per environment and version (?environment=&version=)',
    async handler({ res, app, query }) {
      let out: DeploymentsView;
      try {
        const loaded = await app.config();
        const q = { environment: query.get('environment') || undefined, version: query.get('version') || undefined };
        const { source, records } = await listDeployments(loaded, app.cwd, q);
        const order = loaded.config.pipelines;
        const envOrder = [...new Set(Object.values(order).map((p) => p.environment).filter((e): e is string => !!e))];
        const environments = [...new Set([...envOrder, ...records.map((r) => r.environment)])];
        const versions: string[] = [];
        const matrix: DeploymentsView['matrix'] = {};
        for (const r of records) {
          if (!versions.includes(r.version)) versions.push(r.version);
          const row = (matrix[r.version] ??= {});
          const prev = row[r.environment];
          if (!prev || (prev.recordedAt ?? '') < (r.recordedAt ?? '')) row[r.environment] = { id: r.id, recordedAt: r.recordedAt, pipeline: r.pipeline, runId: r.runId, results: r.results, readiness: r.readiness };
        }
        out = { source, environments, versions, matrix, records: records.slice(0, 500) };
      } catch (e) {
        out = { source: '', error: (e as Error).message, environments: [], versions: [], matrix: {}, records: [] };
      }
      sendJson(res, 200, out);
    },
  },
];
