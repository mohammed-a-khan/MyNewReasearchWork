/**
 * Quality › Coverage for the Studio: the combined coverage view, the UI
 * coverage map (pages, elements, untested lists) with a heat overlay painted
 * into stored DOM snapshots (served sandboxed, like the trace viewer), the
 * UI and accessibility trends over runs, and failure tags.
 */
import { join } from 'node:path';
import {
  a11yIssuesOfRun, a11yTrend, computeRunUiCoverage, loadUiCoverage, overlayCss, overlayMarks, projectCoverage,
  type ProjectCoverage, type UiCoverageOptions, type UiPageCoverage,
} from '../../analytics/index.js';
import { analyzeImpact, changedFilesFromGit, failureTags, loadImpactMapping, loadQuarantine, quarantineStatus, uniqueErrors, type ImpactResult } from '../../insights/index.js';
import { existsSync } from 'node:fs';
import { readSnapshotHtml, readTrace, renderSnapshot, runDirSource } from '../../runner/trace/read.js';
import { loadJourneyFile } from '../../intent/index.js';
import type { Journey } from '../../core/index.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { assertRunId } from '../runs.js';
import { completedRuns, journeyFiles, loadRun, openHistory, qualityPaths } from './common.js';
import { loadRequirementList } from './traceability.js';
import { resolve } from 'node:path';

interface Settings {
  ui: UiCoverageOptions;
  scopes: Array<{ name: string; include: string[]; exclude?: string[]; rules?: Record<string, 'off' | 'warn' | 'error'> }>;
}

async function settings(app: StudioApp): Promise<Settings & { masker?: { maskDeep<T>(v: T): T } }> {
  try {
    const l = await app.config();
    return { ui: l.config.coverage.ui, scopes: l.config.accessibility.scopes, masker: l.masker };
  } catch {
    return { ui: {}, scopes: [] };
  }
}

async function projectJourneys(app: StudioApp): Promise<Journey[]> {
  const out: Journey[] = [];
  for (const f of await journeyFiles(app)) {
    if (f.format === 'ts') continue;
    try {
      out.push(await loadJourneyFile(resolve(app.cwd, f.path)));
    } catch {
      // listed as a problem elsewhere
    }
  }
  return out;
}

/** Change coverage input: files changed against the default branch, through the impact mapping (when both exist). */
async function changeImpact(app: StudioApp, journeys: Journey[]): Promise<ImpactResult | undefined> {
  try {
    const cfg = (await app.config()).config;
    const mappingPath = resolve(app.cwd, cfg.selection.impactMapping);
    if (!existsSync(mappingPath) || !journeys.length) return undefined;
    const base = cfg.vcs.branchScope.defaultBranch ?? 'main';
    const files = await changedFilesFromGit({ cwd: app.cwd, base });
    if (!files.length) return undefined;
    return analyzeImpact(files, journeys.map((j) => ({ id: j.id, name: j.name, tags: j.tags, requirements: j.requirements, risk: j.risk })), await loadImpactMapping(mappingPath));
  } catch {
    return undefined;
  }
}

const cache = new WeakMap<StudioApp, { key: string; at: number; value: ProjectCoverage }>();

/** Project coverage over the latest result of every journey (or one run), cached until runs change. */
export async function coverageFor(app: StudioApp, runId?: string): Promise<ProjectCoverage> {
  const runs = await completedRuns(app);
  const key = `${runId ?? 'latest'}|${runs[0]?.runId ?? ''}|${runs.length}`;
  const hit = cache.get(app);
  if (hit && hit.key === key && Date.now() - hit.at < 60_000) return hit.value;
  const s = await settings(app);
  const journeys = await projectJourneys(app);
  const reqs = await loadRequirementList(app).catch(() => ({ list: undefined }));
  const q = quarantineStatus(await loadQuarantine((await qualityPaths(app)).quarantine).catch(() => ({ version: 1 as const, entries: [] })));
  const impact = await changeImpact(app, journeys);
  const value = await projectCoverage({
    outputDir: await app.outputDir(), journeys, ui: s.ui, quarantined: q.active.map((x) => x.journeyId),
    ...(reqs.list ? { requirements: reqs.list } : {}), ...(runId ? { runIds: [runId] } : {}), ...(impact ? { impact } : {}),
  });
  cache.set(app, { key, at: Date.now(), value });
  return value;
}

export function invalidateCoverage(app: StudioApp): void {
  cache.delete(app);
}

/** The overview: combined dimensions, UI pages (elements included), untested links, latest failure tags. */
export async function coverageOverview(app: StudioApp, runId?: string) {
  if (runId) assertRunId(runId);
  const s = await settings(app);
  const c = await coverageFor(app, runId);
  const latest = (await completedRuns(app))[0];
  let tags: ReturnType<typeof failureTags> = [];
  let errors: ReturnType<typeof uniqueErrors> = [];
  if (latest) {
    const h = await openHistory(app);
    if (h) tags = failureTags(h.runs, latest.runId);
    try {
      errors = uniqueErrors((await loadRun(app, latest.runId)).run);
    } catch {
      errors = [];
    }
  }
  const body = { ...c, latestRunId: latest?.runId, failureTags: tags, uniqueErrors: errors };
  return s.masker ? s.masker.maskDeep(body) : body;
}

export async function coveragePage(app: StudioApp, route: string, runId?: string): Promise<UiPageCoverage> {
  const c = await coverageFor(app, runId);
  const p = c.ui.pages.find((x) => x.route === route);
  if (!p) throw new HttpError(404, `No page ${route} in the coverage map`);
  return p;
}

/** A page's representative snapshot with the heat overlay (tested solid green, untested dashed red), as sandboxed HTML. */
export async function coverageOverlay(app: StudioApp, route: string, opts: { runId?: string; focus?: string } = {}): Promise<string> {
  const s = await settings(app);
  const page = await coveragePage(app, route, opts.runId);
  const ptr = page.representative;
  if (!ptr) throw new HttpError(404, `No snapshot of ${route}`);
  assertRunId(ptr.runId);
  const dir = join(await app.outputDir(), ptr.runId);
  const trace = await readTrace(dir, ptr.journeyId, ptr.attempt).catch(() => {
    throw new HttpError(404, 'The snapshot\'s trace is gone (the run was deleted)');
  });
  const ref = trace.steps[ptr.step]?.snapshots[ptr.phase];
  if (!ref) throw new HttpError(404, 'Snapshot not found in the trace');
  const src = runDirSource(dir);
  const marks = overlayMarks(await readSnapshotHtml(src, ref), page, s.ui);
  const html = await renderSnapshot(src, trace, ref, { highlight: false });
  const css = overlayCss(marks, opts.focus);
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, (m) => m + css) : css + html;
}

/** UI coverage and accessibility issues per run (oldest first), for the trend charts. */
export async function coverageTrend(app: StudioApp, n = 20) {
  const s = await settings(app);
  const runs = (await completedRuns(app)).slice(0, n).reverse();
  const out = await app.outputDir();
  const journeys = await projectJourneys(app);
  const ui: Array<{ runId: string; startedAt?: string; percent: number; tested: number; total: number; pages: number }> = [];
  const a11y = [];
  for (const r of runs) {
    const dir = join(out, r.runId);
    let rep = await loadUiCoverage(dir);
    if (!rep) {
      const c = await computeRunUiCoverage(dir, r.runId, journeys, s.ui).catch(() => undefined);
      if (c?.totals.snapshots) rep = c;
    }
    if (rep?.totals.elements) ui.push({ runId: r.runId, ...(r.startedAt ? { startedAt: r.startedAt } : {}), percent: rep.totals.percent, tested: rep.totals.tested, total: rep.totals.elements, pages: rep.totals.pages });
    a11y.push(await a11yIssuesOfRun(dir, r.runId, s.scopes, { routes: s.ui.routes, ...(r.startedAt ? { startedAt: r.startedAt } : {}) }).catch(() => ({ runId: r.runId, issues: [], scannedSteps: 0 })));
  }
  const body = { ui, a11y: a11yTrend(a11y) };
  return s.masker ? s.masker.maskDeep(body) : body;
}

/** CSV of the UI coverage map (one row per element). */
export function coverageCsv(c: ProjectCoverage): string {
  const q = (v: unknown) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [['page', 'role', 'element', 'count', 'tested', 'interactions', 'assertions', 'journeys']];
  for (const p of c.ui.pages) for (const e of p.elements) rows.push([p.route, e.role, e.label, String(e.count), e.tested ? 'yes' : 'no', String(e.interactions), String(e.assertions), e.journeys.join(' ')]);
  return rows.map((r) => r.map(q).join(',')).join('\n') + '\n';
}
