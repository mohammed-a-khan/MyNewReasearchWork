/**
 * Shared data access for the Quality Center routes: where the project's
 * quality state lives (`.eztest/`), reading runs, journeys and history, and the
 * write guard (no writes to the healer's state while a run is in progress).
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDebugRunId, type EvidenceRef, type RunResult } from '../../core/index.js';
import { loadJourneyFile } from '../../intent/index.js';
import { HistoryStore, readEvidenceManifest, scoreHistory, type FlakyScore } from '../../insights/index.js';
import { listJourneys } from '../authoring.js';
import { bddOptionsOf, extraFeatureDirs } from '../bdd.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { assertRunId, listRuns, type RunListItem } from '../runs.js';

export interface QualityPaths {
  dir: string;
  history: string;
  fingerprints: string;
  decisions: string;
  quarantine: string;
  overrides: string;
  bugs: string;
  requirementsCsv: string;
  requirementsAdo: string;
}

/** `.eztest/` sits next to the output directory (where the runner keeps the fingerprint store). */
export async function qualityPaths(app: StudioApp): Promise<QualityPaths> {
  const out = await app.outputDir();
  const dir = join(dirname(resolve(out)), '.eztest');
  return {
    dir,
    // History is written by RunManager at <cwd>/.eztest/history.json.
    history: resolve(app.cwd, '.eztest', 'history.json'),
    fingerprints: join(dir, 'fingerprints.json'),
    decisions: join(dir, 'heal-decisions.json'),
    quarantine: join(dir, 'quarantine.json'),
    overrides: join(dir, 'triage-overrides.json'),
    bugs: join(dir, 'triage-bugs.json'),
    requirementsCsv: join(dir, 'requirements.csv'),
    requirementsAdo: join(dir, 'requirements-ado.json'),
  };
}

export function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Refuse writes to healer/quarantine state while a run is executing (the runner writes the same files). */
export function assertIdle(app: StudioApp): void {
  const cur = app.runs.current;
  if (cur) throw new HttpError(409, `A run is in progress (${cur.id}); try again when it finishes`);
}

export function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw new HttpError(400, 'Writes need "confirm": true (review the change first)');
}

export function personName(v: unknown, what = 'reviewer'): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, `A ${what} name is required`);
  if (s.length > 120) throw new HttpError(400, `The ${what} name is too long`);
  return s;
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The Quality Center's branch filter for a Studio session (set from the Source Control page / status bar). */
const branchFilters = new WeakMap<StudioApp, string>();

export function setBranchFilter(app: StudioApp, branch: string | undefined): void {
  if (branch) branchFilters.set(app, branch);
  else branchFilters.delete(app);
}

export function branchFilter(app: StudioApp): string | undefined {
  return branchFilters.get(app);
}

/** Completed (not cancelled, not debug sessions) runs, newest first (of the filtered branch, when a branch filter is set). */
export async function completedRuns(app: StudioApp): Promise<RunListItem[]> {
  const b = branchFilters.get(app);
  // Studio debug sessions (debug-...) stay out of triage, readiness, compare, flaky and trends.
  return (await listRuns(await app.outputDir())).filter((r) => r.summary && !r.cancelled && !r.error && !r.debug && (!b || r.branch === b));
}

export interface LoadedRun {
  runId: string;
  dir: string;
  run: RunResult;
  evidence: EvidenceRef[];
}

const runCache = new Map<string, { mtime: number; value: LoadedRun }>();

export async function loadRun(app: StudioApp, runId: string): Promise<LoadedRun> {
  assertRunId(runId);
  const dir = join(await app.outputDir(), runId);
  const p = join(dir, 'run.json');
  if (!existsSync(p)) throw new HttpError(404, `Run ${runId} not found`);
  const mtimeMs = (statSync(join(dir, 'evidence-manifest.jsonl'), { throwIfNoEntry: false })?.mtimeMs ?? 0) + (statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  const key = dir;
  const hit = runCache.get(key);
  if (hit && hit.mtime === mtimeMs) return hit.value;
  const run = JSON.parse(await readFile(p, 'utf8')) as RunResult;
  const value = { runId, dir, run, evidence: await readEvidenceManifest(dir) };
  runCache.set(key, { mtime: mtimeMs, value });
  if (runCache.size > 300) runCache.delete(runCache.keys().next().value as string);
  return value;
}

/** The run to show: the requested one, else the newest completed run. */
export async function pickRun(app: StudioApp, requested: string | null | undefined): Promise<string | undefined> {
  if (requested) {
    assertRunId(requested);
    if (isDebugRunId(requested)) throw new HttpError(400, `${requested} is a debug session: debug sessions are not analyzed (triage, readiness, compare)`);
    return requested;
  }
  return (await completedRuns(app))[0]?.runId;
}

export interface JourneyFileInfo {
  id: string;
  name: string;
  path: string;
  format: 'ez' | 'yaml' | 'json' | 'ts' | 'feature';
  tags: string[];
  requirements: string[];
  risk: number;
  kind?: 'automated' | 'manual' | 'hybrid';
}

/** Journeys on disk (parsing ones only), with their project-relative paths. */
export async function journeyFiles(app: StudioApp): Promise<JourneyFileInfo[]> {
  const list = await listJourneys(app.cwd, await app.journeysDir(), await extraFeatureDirs(app));
  return list
    .filter((j) => j.id && !j.error)
    .flatMap((j) =>
      // A code journey file holds one journey per journey() call.
      j.code?.length
        ? j.code.map((c) => ({ id: c.id, name: c.name, path: j.path, format: j.format, tags: c.tags ?? j.tags, requirements: c.requirements ?? [], risk: c.risk ?? 3 }))
        : [{ id: j.id!, name: j.name ?? j.id!, path: j.path, format: j.format, tags: j.tags, requirements: j.requirements, risk: j.risk ?? 3, ...(j.kind ? { kind: j.kind } : {}) }],
    );
}

export async function journeyById(app: StudioApp, id: string) {
  const f = (await journeyFiles(app)).find((j) => j.id === id);
  if (!f) return undefined;
  if (f.format === 'feature') {
    const { loadFeatureJourneys } = await import('../../bdd/load.js');
    const journey = (await loadFeatureJourneys(resolve(app.cwd, f.path), { ...(await bddOptionsOf(app)), cwd: app.cwd })).find((j) => j.id === id);
    return journey ? { file: f, journey } : undefined;
  }
  if (f.format === 'ts') {
    const { loadCodeJourneys } = await import('../../runner/code-journeys.js');
    const journey = (await loadCodeJourneys(resolve(app.cwd, f.path), { cwd: app.cwd })).find((j) => j.id === id);
    return journey ? { file: f, journey } : undefined;
  }
  return { file: f, journey: await loadJourneyFile(resolve(app.cwd, f.path)) };
}

export async function openHistory(app: StudioApp): Promise<HistoryStore | undefined> {
  try {
    const h = await HistoryStore.open((await qualityPaths(app)).history);
    const b = branchFilters.get(app);
    return b ? h.forBranch(b) : h;
  } catch {
    return undefined;
  }
}

export async function flakyScores(app: StudioApp): Promise<FlakyScore[]> {
  const h = await openHistory(app);
  return h && h.journeyIds().length ? scoreHistory(h) : [];
}

/** beforeAll/afterAll hook journeys appear in run results tagged "hook"; they are setup, not tests. */
export function isHookResult(j: { tags?: string[] }): boolean {
  return !!j.tags?.includes('hook');
}

/**
 * Journeys that are not tests in their own right and stay out of flaky, quarantine,
 * traceability and trend statistics: @library sub-journeys (never run on their own)
 * and hook journeys (seen tagged "hook" in recent runs).
 */
export async function nonTestJourneyIds(app: StudioApp, files?: JourneyFileInfo[]): Promise<Set<string>> {
  const out = new Set((files ?? (await journeyFiles(app))).filter((f) => f.tags.includes('library')).map((f) => f.id));
  for (const r of (await completedRuns(app)).slice(0, 20)) {
    try {
      for (const j of (await loadRun(app, r.runId)).run.journeys) if (isHookResult(j)) out.add(j.journeyId);
    } catch {
      // unreadable run: skip
    }
  }
  return out;
}

/** URL of a run artifact for the client (served read-only by the assets route). */
export function assetUrl(runId: string, path: string): string {
  return `/runs/${encodeURIComponent(runId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function evidenceView(runId: string, e: EvidenceRef | undefined) {
  if (!e) return undefined;
  return { id: e.id, kind: e.kind, path: e.path, url: assetUrl(runId, e.path), description: e.description, stepId: e.stepId, journeyId: e.journeyId, sha256: e.sha256 };
}

/** Publish a change on the `quality` topic so open pages refresh. */
export function publishQuality(app: StudioApp, type: string, data: Record<string, unknown> = {}): void {
  app.hub.publish('quality', { type, ...data });
}
