/**
 * Deployment test records: after `eztest run --pipeline <deploy-x>`, what was
 * tested in which environment for which version: the selection, the
 * results, the readiness verdict and the evidence links. Kept in the run
 * directory (`deployment.json`) and on the results server, and reported to
 * Azure DevOps: a summary on the build, build tags, comments and links on
 * the build's work items, and the test plan.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResult } from '../core/index.js';
import type { PipelineEntry } from '../config/index.js';
import type { AdoClient } from '../alm-ado/client.js';
import { getWorkItems, patchWorkItem, upsertWorkItemComment } from '../alm-ado/workitems.js';
import type { ResultsClient } from '../server/client.js';
import type { CiContext } from './detect.js';
import type { DeploymentRecord } from './types.js';

export interface ReadinessLike {
  decision: string;
  score?: number;
  gates?: Array<{ gate: string; status: string; summary?: string }>;
}

export interface BuildRecordInput {
  pipeline: string;
  entry: PipelineEntry;
  ci: CiContext;
  run: RunResult;
  version: string;
  environment: string;
  app?: string;
  readiness?: ReadinessLike;
  selection?: { tags?: string; reasons?: string[]; shards?: number; browsers?: string[] };
  evidence?: DeploymentRecord['evidence'];
}

export function buildDeploymentRecord(i: BuildRecordInput): Omit<DeploymentRecord, 'recordedAt' | 'recordedBy'> {
  const tests = i.run.journeys.filter((j) => !j.tags.includes('hook'));
  const count = (s: string) => tests.filter((j) => j.status === s).length;
  return {
    id: `${i.environment}:${i.version}:${i.run.runId}`,
    ...(i.app ? { app: i.app } : {}),
    version: i.version,
    environment: i.environment,
    pipeline: i.pipeline,
    ci: {
      system: i.ci.system, ...(i.ci.stage ? { stage: i.ci.stage } : {}), ...(i.ci.buildId ? { buildId: i.ci.buildId } : {}), ...(i.ci.buildNumber ? { buildNumber: i.ci.buildNumber } : {}),
      ...(i.ci.url ? { url: i.ci.url } : {}), ...(i.ci.commit ? { commit: i.ci.commit } : {}), ...(i.ci.branch ? { branch: i.ci.branch } : {}), ...(i.ci.releaseId ? { releaseId: i.ci.releaseId } : {}),
    },
    selection: { journeys: tests.map((j) => j.journeyId), total: tests.length, ...(i.selection?.tags ? { tags: i.selection.tags } : {}), ...(i.selection?.reasons?.length ? { reasons: i.selection.reasons } : {}), ...(i.selection?.shards ? { shards: i.selection.shards } : {}), ...(i.selection?.browsers ? { browsers: i.selection.browsers } : {}) },
    results: { total: tests.length, passed: count('passed'), passedHealed: count('passed-healed'), failed: count('failed'), skipped: count('skipped'), errors: count('error') },
    ...(i.readiness ? { readiness: { decision: i.readiness.decision, ...(i.readiness.score !== undefined ? { score: i.readiness.score } : {}), failingGates: (i.readiness.gates ?? []).filter((g) => g.status === 'fail').map((g) => g.gate) } } : {}),
    runId: i.run.runId,
    evidence: { ...(i.ci.url ? { buildUrl: i.ci.url } : {}), ...(i.run.evidenceHead ? { evidenceHead: i.run.evidenceHead } : {}), ...(i.evidence ?? {}) },
  };
}

/** Did a recorded deployment test pass (no NO_GO, nothing failed)? */
export function deploymentPassed(d: Pick<DeploymentRecord, 'readiness' | 'results'>): boolean {
  if (d.readiness) return d.readiness.decision !== 'NO_GO';
  return d.results.failed + d.results.errors === 0;
}

/** `requires:` of an entry: each named pipeline must have a passing record for this version. Returns the problems. */
export async function checkRequires(entry: PipelineEntry, version: string, client: ResultsClient | undefined): Promise<{ problems: string[]; checked: string[]; skipped?: string }> {
  if (!entry.requires.length) return { problems: [], checked: [] };
  if (!client) return { problems: [], checked: [], skipped: `requires ${entry.requires.join(', ')}: not checked, no results server is configured (server.url) to hold deployment records` };
  const problems: string[] = [];
  for (const req of entry.requires) {
    const recs = await client.deployments({ pipeline: req, version });
    if (!recs.length) problems.push(`"${req}" has no deployment test record for version ${version}`);
    else if (!recs.some(deploymentPassed)) {
      const r = recs[0];
      problems.push(`"${req}" did not pass for version ${version}: ${r.readiness?.decision ?? `${r.results.failed} failed`} (run ${r.runId ?? '?'})`);
    }
  }
  return { problems, checked: entry.requires };
}

export function deploymentMarkdown(d: Omit<DeploymentRecord, 'recordedAt' | 'recordedBy'>): string {
  const r = d.results;
  const verdict = d.readiness?.decision ?? (r.failed + r.errors ? 'FAILED' : 'PASSED');
  const lines = [
    `## EZTest: ${d.environment} ${d.version}: ${verdict}`,
    '',
    `Pipeline **${d.pipeline}**${d.selection.tags ? ` (tags \`${d.selection.tags}\`)` : ''}: ${d.selection.total} journeys.`,
    '',
    '| Passed | Healed | Failed | Errors | Skipped |',
    '|---|---|---|---|---|',
    `| ${r.passed} | ${r.passedHealed} | ${r.failed} | ${r.errors} | ${r.skipped} |`,
    '',
  ];
  if (d.readiness) lines.push(`Readiness: **${d.readiness.decision}**${d.readiness.score !== undefined ? ` (score ${d.readiness.score})` : ''}${d.readiness.failingGates?.length ? `; failing gates: ${d.readiness.failingGates.join(', ')}` : ''}.`, '');
  const ev = d.evidence ?? {};
  const links = [ev.reportUrl && `[report](${ev.reportUrl})`, ev.runUrl && `[run on the results server](${ev.runUrl})`, ev.testRunUrl && `[test run](${ev.testRunUrl})`].filter(Boolean);
  if (links.length) lines.push(`Evidence: ${links.join(' · ')}`, '');
  if (ev.evidenceHead) lines.push(`Evidence chain head: \`${ev.evidenceHead}\``, '');
  return lines.join('\n');
}

export async function writeDeploymentFiles(runDir: string, d: Omit<DeploymentRecord, 'recordedAt' | 'recordedBy'>): Promise<{ json: string; markdown: string }> {
  const json = join(runDir, 'deployment.json');
  const markdown = join(runDir, 'eztest-deployment.md');
  await writeFile(json, JSON.stringify({ ...d, recordedAt: new Date().toISOString() }, null, 2));
  await writeFile(markdown, deploymentMarkdown(d));
  return { json, markdown };
}

export interface AdoDeploymentOptions {
  buildId?: number;
  summaryFile?: string;
  tags?: boolean;
  commentWorkItems?: boolean;
  linkWorkItems?: boolean;
  /** Pipeline logging commands (summary upload) go here; only used inside Azure Pipelines. */
  out?: (line: string) => void;
  inPipeline?: boolean;
}

export interface AdoDeploymentReport {
  summary?: string;
  tags: string[];
  workItems: Array<{ id: number; comment?: 'created' | 'updated' | 'unchanged'; linked?: boolean }>;
  warnings: string[];
}

const COMMENT_MARKER = (env: string) => `<p><small>eztest:deployment:${env.replace(/[^\w.-]/g, '_')}</small></p>`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Report a deployment test record to Azure DevOps: summary, build tags, work item comments and links. */
export async function reportDeploymentToAdo(c: AdoClient, d: Omit<DeploymentRecord, 'recordedAt' | 'recordedBy'>, o: AdoDeploymentOptions): Promise<AdoDeploymentReport> {
  const out: AdoDeploymentReport = { tags: [], workItems: [], warnings: [] };
  const verdict = d.readiness?.decision ?? (d.results.failed + d.results.errors ? 'FAILED' : 'PASSED');
  if (o.summaryFile && o.inPipeline) {
    o.out?.(`##vso[task.uploadsummary]${o.summaryFile}`);
    out.summary = o.summaryFile;
  }
  if (!o.buildId) {
    if (o.tags || o.commentWorkItems || o.linkWorkItems) out.warnings.push('no build id (BUILD_BUILDID): build tags and work item updates skipped');
    return out;
  }
  if (o.tags !== false) {
    for (const tag of [`eztest-${d.environment}`, `eztest-${d.environment}-${verdict}`]) {
      try {
        await c.request('PUT', `/_apis/build/builds/${o.buildId}/tags/${encodeURIComponent(tag)}`, { idempotent: true });
        out.tags.push(tag);
      } catch (e) {
        out.warnings.push(`build tag ${tag}: ${(e as Error).message}`);
      }
    }
  }
  if (o.commentWorkItems || o.linkWorkItems) {
    let ids: number[] = [];
    try {
      const r = await c.request<{ value?: Array<{ id: string | number }> }>('GET', `/_apis/build/builds/${o.buildId}/workitems`, { query: { $top: 100 } });
      ids = (r.data.value ?? []).map((w) => Number(w.id)).filter((n) => Number.isInteger(n) && n > 0);
    } catch (e) {
      out.warnings.push(`work items of build ${o.buildId}: ${(e as Error).message}`);
    }
    const link = d.evidence?.reportUrl ?? d.evidence?.runUrl ?? d.evidence?.buildUrl;
    const items = ids.length && o.linkWorkItems && link ? await getWorkItems(c, ids, { relations: true }).catch(() => []) : [];
    for (const id of ids) {
      const row: AdoDeploymentReport['workItems'][number] = { id };
      if (o.commentWorkItems) {
        const r = d.results;
        const html = `<p><b>EZTest ${esc(d.environment)} ${esc(d.version)}: ${esc(verdict)}</b> (pipeline ${esc(d.pipeline)})</p><p>${r.total} journeys: ${r.passed} passed, ${r.passedHealed} healed, ${r.failed} failed, ${r.errors} errors, ${r.skipped} skipped.</p>${link ? `<p><a href="${esc(link)}">Evidence</a></p>` : ''}`;
        try {
          row.comment = (await upsertWorkItemComment(c, id, COMMENT_MARKER(d.environment), html)).action;
        } catch (e) {
          out.warnings.push(`comment on #${id}: ${(e as Error).message}`);
        }
      }
      if (o.linkWorkItems && link) {
        const wi = items.find((w) => w.id === id);
        if (wi && (wi.relations ?? []).some((rel) => rel.rel === 'Hyperlink' && rel.url === link)) row.linked = false;
        else {
          try {
            await patchWorkItem(c, id, [{ op: 'add', path: '/relations/-', value: { rel: 'Hyperlink', url: link, attributes: { comment: `EZTest ${d.environment} ${d.version}: ${verdict}` } } }]);
            row.linked = true;
          } catch (e) {
            out.warnings.push(`link on #${id}: ${(e as Error).message}`);
          }
        }
      }
      out.workItems.push(row);
    }
  }
  return out;
}
