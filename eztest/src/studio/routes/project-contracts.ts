/**
 * Project › API contracts and Project › Messages: the configured OpenAPI
 * specs (lint), the API coverage of a run (computed from its evidence when
 * the run did not record it), its contract verification / can-release
 * results, the EZTest contract files in the project, the contracts,
 * verifications and releases on the EZTest results server (when `server:` is
 * configured), and the messages a run published and
 * received (masked, as stored in evidence).
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeRunApiCoverage, isContractFile, isMessageExpectation, lintSpec, loadApiCoverage, loadApiSpec, readContractFile, CONTRACT_RESULTS_FILE } from '../../contracts/index.js';
import { identityVaultFromConfig } from '../../identity/index.js';
import { readEvidenceManifest } from '../../insights/index.js';
import { ResultsClient } from '../../server/client.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { assertRunId, listRuns } from '../runs.js';
import { relPosix } from '../security.js';
import { masker, projectPath } from './assurance-shared.js';
import type { StudioRoute } from './route.js';

async function specFiles(app: StudioApp): Promise<string[]> {
  try {
    const s = (await app.config()).config.api.spec;
    return (Array.isArray(s) ? s : s ? [s] : []).map((f) => resolve(app.cwd, f));
  } catch {
    return [];
  }
}

async function runDir(app: StudioApp, runId: unknown): Promise<string> {
  const out = await app.outputDir();
  let id = typeof runId === 'string' && runId ? runId : undefined;
  if (!id) id = (await listRuns(out)).find((r) => r.summary)?.runId;
  if (!id) throw new HttpError(404, 'No runs yet');
  assertRunId(id);
  const dir = join(out, id);
  if (!existsSync(join(dir, 'run.json'))) throw new HttpError(404, `Run ${id} not found`);
  return dir;
}

/** The results server's contracts, verification results and releases for this project (undefined without `server:`). */
async function serverContracts(app: StudioApp): Promise<Record<string, unknown> | undefined> {
  let loaded;
  try {
    loaded = await app.config();
  } catch {
    return undefined;
  }
  const s = loaded.config.server;
  if (!s?.url) return undefined;
  const project = s.project ?? loaded.config.project ?? 'default';
  try {
    const ref = s.token ?? (app.env.EZTEST_SERVER_TOKEN ? 'secret://env/EZTEST_SERVER_TOKEN' : undefined);
    let token: string | undefined;
    if (ref) {
      token = ref.startsWith('secret://') ? await identityVaultFromConfig(loaded.config, { cwd: app.cwd, masker: loaded.masker, env: { ...app.env, ...loaded.variables } }).registry.resolve(ref) : ref;
      loaded.masker.add(token);
    }
    const client = new ResultsClient({ url: s.url, token, project, timeoutMs: Math.min(s.timeoutMs, 10_000) });
    const [contracts, verifications, releases] = await Promise.all([client.contracts({ contracts: 'false' }), client.verifications(), client.releases()]);
    return { url: s.url, project, contracts, verifications: verifications.slice(0, 200), releases };
  } catch (e) {
    return { url: s.url, project, error: loaded.masker.mask((e as Error).message) };
  }
}

export const contractRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/project/contracts',
    summary: 'Specs, contract files, and the API coverage and contract results of a run',
    async handler({ res, app, query }) {
      const files = await specFiles(app);
      const specs = files.map((f) => {
        try {
          const s = loadApiSpec(f);
          const lint = lintSpec(s);
          return { file: relPosix(app.cwd, f), title: s.title, version: s.apiVersion, openapi: s.version, operations: s.operations.length, lint: lint.counts, findings: lint.findings.slice(0, 50) };
        } catch (e) {
          return { file: relPosix(app.cwd, f), error: (e as Error).message };
        }
      });
      let contractsDir = 'contracts';
      try {
        contractsDir = (await app.config()).config.contracts?.dir ?? 'contracts';
      } catch {
        // defaults
      }
      const dirAbs = resolve(app.cwd, contractsDir);
      const contracts = [];
      if (existsSync(dirAbs)) {
        for (const f of (await readdir(dirAbs)).filter(isContractFile).sort()) {
          try {
            const c = await readContractFile(join(dirAbs, f));
            contracts.push({ file: relPosix(app.cwd, join(dirAbs, f)), consumer: c.consumer, provider: c.provider, expectations: c.expectations.map((e) => ({ description: e.description, kind: e.kind ?? 'http', request: isMessageExpectation(e) ? `${e.channel.transport} ${e.channel.destType} ${e.channel.dest}` : `${e.request.method} ${e.request.path}`, status: isMessageExpectation(e) ? undefined : e.response.status, states: e.given.map((s) => s.name) })) });
          } catch (e) {
            contracts.push({ file: relPosix(app.cwd, join(dirAbs, f)), error: (e as Error).message });
          }
        }
      }
      let run: unknown;
      try {
        const dir = await runDir(app, query.get('run') ?? undefined);
        const recorded = await loadApiCoverage(dir);
        const coverage = recorded ?? (files.length ? await computeRunApiCoverage(dir, files) : []);
        const resultsFile = join(dir, CONTRACT_RESULTS_FILE);
        const results = existsSync(resultsFile) ? (JSON.parse(await readFile(resultsFile, 'utf8')) as unknown) : undefined;
        run = { runId: dir.split(/[\\/]/).pop(), recorded: !!recorded, coverage, ...(results ? { results } : {}) };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
      // Operation coverage over recent runs (only runs that recorded it).
      const trend: Array<{ runId: string; startedAt?: string; ratio: number }> = [];
      for (const r of (await listRuns(await app.outputDir())).filter((x) => x.summary).slice(0, 20)) {
        const cov = await loadApiCoverage(join(await app.outputDir(), r.runId));
        if (cov?.length) trend.push({ runId: r.runId, startedAt: r.startedAt, ratio: cov[0].totals.operationRatio });
      }
      const server = await serverContracts(app);
      sendJson(res, 200, { specs, contracts, run, trend: trend.reverse(), ...(server ? { server } : {}) });
    },
  },
  {
    method: 'POST',
    path: '/api/project/contracts/lint',
    summary: 'Lint an OpenAPI/Swagger file of the project',
    async handler({ res, app, body }) {
      const abs = projectPath(app, body.path, { exts: ['.yaml', '.yml', '.json'] });
      try {
        sendJson(res, 200, lintSpec(loadApiSpec(abs)));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/project/messages',
    summary: 'Messages a run published and received (from its evidence)',
    async handler({ res, app, query }) {
      const dir = await runDir(app, query.get('run') ?? undefined);
      const m = await masker(app);
      const out: unknown[] = [];
      for (const e of await readEvidenceManifest(dir)) {
        if (e.kind !== 'data' || !e.path.startsWith('messages/')) continue;
        try {
          const rec = JSON.parse(await readFile(join(dir, e.path), 'utf8')) as Record<string, unknown>;
          out.push({ evidenceId: e.id, journeyId: e.journeyId, stepId: e.stepId, at: e.createdAt, description: e.description, ...m.maskDeep(rec) });
        } catch {
          // unreadable evidence is reported by `eztest evidence verify`
        }
      }
      sendJson(res, 200, { runId: dir.split(/[\\/]/).pop(), messages: out });
    },
  },
];
