/**
 * Traceability matrix for the Studio: journeys on disk x their latest result
 * x quarantine, plus an optional requirements list (`.eztest/requirements.csv`
 * or Azure DevOps query results cached in `.eztest/requirements-ado.json`).
 * Exports: CSV, XLSX (exceljs) and a self-contained HTML page.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { JourneyStatus } from '../../core/index.js';
import {
  computeTraceability,
  loadQuarantine,
  parseRequirementsCsv,
  quarantineStatus,
  traceabilityToCsv,
  type RequirementInfo,
  type TraceabilityMatrix,
  type TraceLatest,
} from '../../insights/index.js';
import { escapeHtml } from '../../report/escape.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { completedRuns, isHookResult, journeyFiles, loadRun, nonTestJourneyIds, qualityPaths, readJsonFile } from './common.js';
import { adoClient } from './triage.js';

export interface RequirementSource {
  kind: 'csv' | 'ado';
  path: string;
  count: number;
  fetchedAt?: string;
  query?: string;
}

export async function loadRequirementList(app: StudioApp): Promise<{ list?: RequirementInfo[]; sources: RequirementSource[]; warnings: string[] }> {
  const paths = await qualityPaths(app);
  const sources: RequirementSource[] = [];
  const warnings: string[] = [];
  let list: RequirementInfo[] | undefined;
  if (existsSync(paths.requirementsCsv)) {
    try {
      const reqs = parseRequirementsCsv(await readFile(paths.requirementsCsv, 'utf8'), 'csv');
      list = [...(list ?? []), ...reqs];
      sources.push({ kind: 'csv', path: app.rel(paths.requirementsCsv), count: reqs.length });
    } catch (e) {
      warnings.push(`requirements.csv: ${(e as Error).message}`);
    }
  }
  const ado = await readJsonFile<{ fetchedAt: string; query: string; requirements: RequirementInfo[] }>(paths.requirementsAdo);
  if (ado?.requirements) {
    const seen = new Set((list ?? []).map((r) => r.id));
    list = [...(list ?? []), ...ado.requirements.filter((r) => !seen.has(r.id))];
    sources.push({ kind: 'ado', path: app.rel(paths.requirementsAdo), count: ado.requirements.length, fetchedAt: ado.fetchedAt, query: ado.query });
  }
  return { list, sources, warnings };
}

export async function traceability(app: StudioApp): Promise<TraceabilityMatrix & { sources: RequirementSource[]; warnings: string[]; latestRunId?: string }> {
  const all = await journeyFiles(app);
  // @library sub-journeys and hook journeys are not tests of a requirement.
  const skip = await nonTestJourneyIds(app, all);
  const files = all.filter((f) => !skip.has(f.id));
  const latest: Record<string, TraceLatest | undefined> = {};
  const runs = (await completedRuns(app)).slice(0, 60);
  const want = new Set(files.map((f) => f.id));
  for (const r of runs) {
    if (![...want].some((id) => !latest[id])) break;
    let lr;
    try {
      lr = await loadRun(app, r.runId);
    } catch {
      continue;
    }
    for (const j of lr.run.journeys) {
      if (want.has(j.journeyId) && !latest[j.journeyId] && j.status !== 'skipped' && !isHookResult(j)) latest[j.journeyId] = { status: j.status as JourneyStatus, runId: r.runId, startedAt: r.startedAt };
    }
  }
  const q = quarantineStatus(await loadQuarantine((await qualityPaths(app)).quarantine).catch(() => ({ version: 1 as const, entries: [] })));
  const reqs = await loadRequirementList(app);
  const m = computeTraceability({
    journeys: files.map((f) => ({ id: f.id, name: f.name, path: f.path, requirements: f.requirements, tags: f.tags, risk: f.risk, ...(f.kind ? { kind: f.kind } : {}) })),
    latest,
    quarantined: q.active.map((x) => x.journeyId),
    requirements: reqs.list,
  });
  return { ...m, sources: reqs.sources, warnings: reqs.warnings, latestRunId: runs[0]?.runId };
}

const COVERAGE_LABEL: Record<string, string> = {
  'covered-passing': 'Covered, passing',
  'covered-healed': 'Covered, passing with heals',
  'covered-failing': 'Covered, failing',
  'covered-quarantined': 'Only quarantined coverage',
  'not-run': 'Not run',
  uncovered: 'No journey',
};

export function coverageLabel(c: string): string {
  return COVERAGE_LABEL[c] ?? c;
}

export async function traceabilityXlsx(m: TraceabilityMatrix): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EZTest Studio';
  wb.created = new Date();
  const ws = wb.addWorksheet('Traceability', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Requirement', key: 'req', width: 16 },
    { header: 'Title', key: 'title', width: 40 },
    { header: 'Coverage', key: 'coverage', width: 26 },
    { header: 'Journey', key: 'journey', width: 34 },
    { header: 'Journey name', key: 'name', width: 40 },
    { header: 'Latest status', key: 'status', width: 16 },
    { header: 'Quarantined', key: 'q', width: 12 },
    { header: 'Run', key: 'run', width: 32 },
    { header: 'Gap', key: 'gap', width: 60 },
  ];
  ws.getRow(1).font = { bold: true };
  const names = new Map(m.journeys.map((j) => [j.id, j.name]));
  for (const r of m.rows) {
    const base = { req: r.requirement.id, title: r.requirement.title ?? '', coverage: coverageLabel(r.coverage), gap: r.gap ?? '' };
    if (!r.journeys.length) ws.addRow({ ...base });
    for (const c of r.journeys) ws.addRow({ ...base, journey: c.journeyId, name: names.get(c.journeyId) ?? '', status: c.status, q: c.quarantined ? 'yes' : 'no', run: c.runId ?? '' });
  }
  ws.autoFilter = { from: 'A1', to: 'I1' };
  const sum = wb.addWorksheet('Summary');
  sum.addRow(['Requirements', m.totals.requirements]);
  sum.addRow(['Coverage (passing, incl. healed)', m.totals.coveragePct]);
  sum.getCell('B2').numFmt = '0.0%';
  sum.addRow(['Gaps', m.totals.gaps]);
  for (const k of Object.keys(COVERAGE_LABEL)) sum.addRow([COVERAGE_LABEL[k], (m.totals as unknown as Record<string, number>)[k]]);
  sum.addRow([]);
  sum.addRow(['Journeys without requirements', m.untracedJourneys.join(', ')]);
  if (m.unknownRequirements.length) sum.addRow(['Requirements not in the list', m.unknownRequirements.join(', ')]);
  sum.getColumn(1).width = 36;
  sum.getColumn(2).width = 60;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function traceabilityHtml(m: TraceabilityMatrix, title = 'Requirements traceability'): string {
  const names = new Map(m.journeys.map((j) => [j.id, j.name]));
  const rows = m.rows
    .map((r) => {
      const cells = r.journeys.length
        ? r.journeys.map((c) => `<li><code>${escapeHtml(c.journeyId)}</code> ${escapeHtml(names.get(c.journeyId) ?? '')} &mdash; <strong>${escapeHtml(c.status)}</strong>${c.quarantined ? ' (quarantined)' : ''}</li>`).join('')
        : '<li><em>none</em></li>';
      return `<tr class="${escapeHtml(r.coverage)}"><th scope="row">${escapeHtml(r.requirement.id)}</th><td>${escapeHtml(r.requirement.title ?? '')}</td><td>${escapeHtml(coverageLabel(r.coverage))}</td><td><ul>${cells}</ul></td><td>${escapeHtml(r.gap ?? '')}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#15181c;background:#fff}
h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d7dce3;padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:#f2f4f7}ul{margin:0;padding-left:18px}
tr.uncovered td:nth-child(3),tr.covered-failing td:nth-child(3),tr.covered-quarantined td:nth-child(3){color:#bb2219;font-weight:600}
tr.covered-passing td:nth-child(3){color:#17703a;font-weight:600}tr.covered-healed td:nth-child(3){color:#7136b8;font-weight:600}
@media (prefers-color-scheme: dark){body{background:#15181e;color:#e7eaf0}th,td{border-color:#2d333e}thead th{background:#1b1f27}}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${m.totals.requirements} requirements, ${(m.totals.coveragePct * 100).toFixed(1)}% covered by passing journeys, ${m.totals.gaps} gap(s). Generated ${escapeHtml(new Date().toISOString())} by EZTest Studio.</p>
<table><thead><tr><th scope="col">Requirement</th><th scope="col">Title</th><th scope="col">Coverage</th><th scope="col">Journeys (latest status)</th><th scope="col">Gap</th></tr></thead>
<tbody>
${rows}
</tbody></table>
${m.untracedJourneys.length ? `<p>Journeys without requirements: ${m.untracedJourneys.map((j) => `<code>${escapeHtml(j)}</code>`).join(', ')}</p>` : ''}
</body></html>
`;
}

export { traceabilityToCsv };

/** Run a WIQL query against Azure DevOps and cache the requirements it returns. */
export async function fetchAdoRequirements(app: StudioApp, query: string): Promise<{ requirements: RequirementInfo[]; fetchedAt: string; query: string }> {
  if (!/^\s*select\b/i.test(query)) throw new HttpError(400, 'The query must be a WIQL SELECT statement');
  const { client } = await adoClient(app);
  // Shared with `eztest ado requirements`: every page of the query, title, state, area, iteration and type.
  const { queryRequirements } = await import('../../alm-ado/index.js');
  const requirements: RequirementInfo[] = await queryRequirements(client, { wiql: query });
  return { requirements, fetchedAt: new Date().toISOString(), query };
}
