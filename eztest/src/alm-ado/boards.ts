/**
 * Azure Boards: requirements pulled by WIQL into traceability, and a result
 * summary comment on the user stories / requirements a run's journeys trace
 * to (one comment per requirement, updated in place on later runs).
 */
import type { JourneyResult, RunResult } from '../core/index.js';
import type { RequirementInfo } from '../insights/traceability.js';
import { escapeHtml } from '../report/escape.js';
import type { AdoClient } from './client.js';
import type { PublishSummary } from './publish.js';
import { parseAdoTags } from './tags.js';
import { getWorkItems, upsertWorkItemComment, wiqlIds, workItemWebUrl } from './workitems.js';

export interface AdoRequirement extends RequirementInfo {
  iteration?: string;
  type?: string;
  url?: string;
}

/** Requirements a WIQL query (or saved query) returns, with title, state, type, area and iteration. */
export async function queryRequirements(c: AdoClient, q: { wiql?: string; savedQuery?: string; max?: number }): Promise<AdoRequirement[]> {
  const ids = (await wiqlIds(c, { wiql: q.wiql, savedQuery: q.savedQuery })).slice(0, q.max ?? 20000);
  const items = await getWorkItems(c, ids, { fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'System.IterationPath', 'System.WorkItemType'] });
  return items.map((w) => ({
    id: String(w.id),
    title: String(w.fields['System.Title'] ?? ''),
    ...(w.fields['System.State'] ? { state: String(w.fields['System.State']) } : {}),
    ...(w.fields['System.AreaPath'] ? { area: String(w.fields['System.AreaPath']) } : {}),
    ...(w.fields['System.IterationPath'] ? { iteration: String(w.fields['System.IterationPath']) } : {}),
    ...(w.fields['System.WorkItemType'] ? { type: String(w.fields['System.WorkItemType']) } : {}),
    url: workItemWebUrl(c, w.id),
    source: 'ado',
  }));
}

/** WIQL for the requirements of an area / iteration (User Story, Product Backlog Item, Requirement, Feature). */
export function requirementsWiql(o: { area?: string; iteration?: string; types?: string[] } = {}): string {
  const types = (o.types ?? ['User Story', 'Product Backlog Item', 'Requirement']).map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const where = ['[System.TeamProject] = @project', `[System.WorkItemType] IN (${types})`, "[System.State] <> 'Removed'"];
  if (o.area) where.push(`[System.AreaPath] UNDER '${o.area.replace(/'/g, "''")}'`);
  if (o.iteration) where.push(`[System.IterationPath] UNDER '${o.iteration.replace(/'/g, "''")}'`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.Id]`;
}

export const REQUIREMENT_COMMENT_MARKER = '<p><small>eztest:requirement-summary</small></p>';

const ICON: Record<string, string> = { passed: 'Passed', 'passed-healed': 'Passed (healed)', failed: 'Failed', error: 'Error', skipped: 'Not run' };

/** The comment for one requirement: each covering journey with its status, test case and the run. */
export function requirementCommentHtml(req: string, journeys: JourneyResult[], run: RunResult, o: { runUrl?: string; testCaseUrl?: (id: number) => string } = {}): string {
  const pass = journeys.every((j) => j.status === 'passed' || j.status === 'passed-healed');
  const rows = journeys
    .map((j) => {
      const tcs = parseAdoTags(j.tags).testCaseIds.map((id) => (o.testCaseUrl ? `<a href="${escapeHtml(o.testCaseUrl(id))}">#${id}</a>` : `#${id}`)).join(', ');
      return `<tr><td>${escapeHtml(j.name)}</td><td>${escapeHtml(ICON[j.status] ?? j.status)}</td><td>${tcs || '-'}</td></tr>`;
    })
    .join('');
  const where = run.environment?.gitBranch ? ` on <code>${escapeHtml(run.environment.gitBranch)}</code>${run.environment.gitCommit ? ` (${escapeHtml(run.environment.gitCommit.slice(0, 10))})` : ''}` : '';
  return `<p><b>EZTest: ${pass ? 'all journeys for this requirement passed' : 'journeys for this requirement are failing'}</b>${where}, run ${o.runUrl ? `<a href="${escapeHtml(o.runUrl)}">${escapeHtml(run.runId)}</a>` : escapeHtml(run.runId)} at ${escapeHtml(run.finishedAt)}.</p><table><tr><th>Journey</th><th>Result</th><th>Test case</th></tr>${rows}</table>`;
}

/**
 * Post (or update in place) a summary comment on every numeric requirement the
 * run's journeys trace to (`Requirements: 123`).
 */
export async function commentOnRequirements(c: AdoClient, run: RunResult, o: { published?: PublishSummary; runUrl?: string; only?: number[] } = {}): Promise<Array<{ requirement: number; commentId: number; action: 'created' | 'updated' | 'unchanged' }>> {
  const byReq = new Map<number, JourneyResult[]>();
  for (const j of run.journeys) {
    if (j.tags.includes('hook')) continue;
    for (const r of j.requirements) {
      if (!/^\d+$/.test(r.trim())) continue;
      const id = Number(r.trim());
      if (o.only && !o.only.includes(id)) continue;
      byReq.set(id, [...(byReq.get(id) ?? []), j]);
    }
  }
  const runUrl = o.runUrl ?? (o.published ? `${c.projectUrl}/_testManagement/runs?runId=${o.published.runId}&_a=runCharts` : undefined);
  const out: Array<{ requirement: number; commentId: number; action: 'created' | 'updated' | 'unchanged' }> = [];
  for (const [id, js] of byReq) {
    const html = requirementCommentHtml(String(id), js, run, { runUrl, testCaseUrl: (tc) => workItemWebUrl(c, tc) });
    const r = await upsertWorkItemComment(c, id, REQUIREMENT_COMMENT_MARKER, html);
    out.push({ requirement: id, commentId: r.id, action: r.action });
  }
  return out;
}
