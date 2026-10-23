/**
 * Test management for the Studio: manual and hybrid cases (list, read into
 * the form editor, render and save as `.ez`), guided manual runs (start,
 * session state, verdicts, end), suites / cycles / assignments with progress
 * and dashboards, and converting a manual case to an automated journey.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Journey, JourneyResult, RunResult } from '../core/index.js';
import { latestResults, recentRuns } from '../analytics/project.js';
import { loadJourneyFile } from '../intent/index.js';
import {
  automateWithGrammar, automateWithRecording, caseFromJourney, cycleProgress, loadPlans, parsePlans, renderManualCase, savePlans,
  type CaseInfo, type CaseProgress, type ManualCaseInput, type PlansFile, type RecordedStep,
} from '../manual/index.js';
import { journeyKind, manualStepCount, type ManualAttachment, type ManualVerdict } from '../runner/manual.js';
import { listJourneys, type JourneyEntry } from './authoring.js';
import type { StudioApp } from './app.js';
import { HttpError } from './http.js';
import { assertRunId, type RunPlanJourney } from './runs.js';

export async function manualConfig(app: StudioApp): Promise<{ plansFile: string; testers: string[]; casesDir: string; journeysDir: string }> {
  try {
    const c = (await app.config()).config;
    return { plansFile: c.manual.plansFile, testers: c.manual.testers, casesDir: c.manual.casesDir, journeysDir: c.journeysDir };
  } catch {
    return { plansFile: 'test-plans.json', testers: [], casesDir: 'manual', journeysDir: await app.journeysDir() };
  }
}

async function masker(app: StudioApp): Promise<{ maskDeep<T>(v: T): T; mask(s: string): string }> {
  try {
    return (await app.config()).masker;
  } catch {
    return { maskDeep: <T>(v: T) => v, mask: (s: string) => s };
  }
}

// ------------------------------------------------------------------ cases

export interface CaseListItem extends CaseInfo {
  path: string;
  steps: number;
  last?: { runId: string; status: string; at: string; testers: string[]; pending: number };
}

export async function allCaseInfo(app: StudioApp): Promise<{ entries: JourneyEntry[]; cases: CaseInfo[] }> {
  const entries = (await listJourneys(app.cwd, await app.journeysDir())).filter((e) => e.id && !e.error);
  const cases: CaseInfo[] = entries.flatMap((e): CaseInfo[] => e.code?.length
    ? e.code.map((c) => ({ id: c.id, name: c.name, tags: c.tags ?? [], type: 'automated' as const, path: e.path, risk: c.risk ?? 3, requirements: c.requirements ?? [] }))
    : [{ id: e.id!, name: e.name ?? e.id!, tags: e.tags, type: e.kind ?? 'automated', ...(e.assignee ? { assignee: e.assignee } : {}), path: e.path, risk: e.risk ?? 3, requirements: e.requirements }]);
  return { entries, cases };
}

/** Manual and hybrid cases with their latest result. */
export async function listCases(app: StudioApp): Promise<{ cases: CaseListItem[]; testers: string[]; casesDir: string }> {
  const cfg = await manualConfig(app);
  const { entries, cases } = await allCaseInfo(app);
  const manual = cases.filter((c) => c.type !== 'automated');
  const journeys: Journey[] = [];
  for (const c of manual) {
    try {
      journeys.push(await loadJourneyFile(resolve(app.cwd, c.path!)));
    } catch {
      // listed with an error by the journeys page
    }
  }
  const { latest } = await latestResults(await app.outputDir(), journeys);
  const out: CaseListItem[] = manual.map((c) => {
    const j = journeys.find((x) => x.id === c.id);
    const l = latest.get(c.id);
    const res = l?.results ?? [];
    return {
      ...c, path: c.path!, steps: entries.find((e) => e.path === c.path)?.steps ?? 0, manualSteps: j ? manualStepCount(j) : 0,
      ...(l ? { last: { runId: l.runId, status: statusOf(res), at: l.startedAt, testers: [...new Set(res.flatMap((r) => r.manual?.testers ?? []))], pending: res.reduce((n, r) => n + (r.manual?.pending ?? 0), 0) } } : {}),
    };
  });
  const testers = [...new Set([...cfg.testers, ...manual.map((c) => c.assignee).filter((x): x is string => !!x)])].sort();
  return { cases: (await masker(app)).maskDeep(out), testers, casesDir: cfg.casesDir };
}

function statusOf(rs: JourneyResult[]): string {
  if (rs.some((r) => r.steps.some((s) => s.status === 'blocked'))) return 'blocked';
  if (rs.some((r) => r.status === 'failed' || r.status === 'error')) return 'failed';
  if (rs.some((r) => (r.manual?.pending ?? 0) > 0)) return rs.some((r) => (r.manual?.executed ?? 0) > 0) ? 'in-progress' : 'not-run';
  if (rs.every((r) => r.status === 'skipped')) return 'skipped';
  return rs.some((r) => r.status === 'passed-healed') ? 'passed-healed' : 'passed';
}

export async function readCase(app: StudioApp, path: unknown): Promise<{ path: string; ez: string; model: ManualCaseInput; kind: string; steps: Array<{ id: string; manual: boolean; text: string; expected: string[] }>; baseUrl?: string }> {
  const abs = await app.journeyPath(path);
  if (!existsSync(abs)) throw new HttpError(404, 'File not found');
  let j;
  try {
    j = await loadJourneyFile(abs);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  const steps = j.steps.map((x) => ({ id: x.id, manual: x.action === 'manual', text: x.action === 'manual' ? x.value ?? '' : x.intent, expected: ((x.args?.expected as string[] | undefined) ?? []) }));
  let baseUrl: string | undefined;
  try {
    baseUrl = (await app.config()).config.baseUrl;
  } catch {
    baseUrl = undefined;
  }
  return { path: app.rel(abs), ez: await readFile(abs, 'utf8'), model: caseFromJourney(j), kind: journeyKind(j), steps, ...(baseUrl ? { baseUrl } : {}) };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : typeof v === 'string' ? v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) : []);

/** The case editor's JSON body as a ManualCaseInput (shape-checked; the .ez parser checks the rest). */
export function caseInput(v: unknown): ManualCaseInput {
  if (!v || typeof v !== 'object') throw new HttpError(400, '"case" must be an object');
  const o = v as Record<string, unknown>;
  const steps = Array.isArray(o.steps) ? o.steps : [];
  if (steps.length > 500) throw new HttpError(413, 'Too many steps');
  const params = o.parameters as { columns?: unknown; rows?: unknown } | undefined;
  const columns = params ? strs(params.columns) : [];
  return {
    name: str(o.name), ...(str(o.id) ? { id: str(o.id) } : {}), ...(o.type === 'hybrid' ? { type: 'hybrid' as const } : { type: 'manual' as const }),
    ...(str(o.description) ? { description: str(o.description) } : {}), ...(str(o.assignee) ? { assignee: str(o.assignee) } : {}),
    ...(str(o.preconditions) ? { preconditions: str(o.preconditions) } : {}), requirements: strs(o.requirements), tags: strs(o.tags),
    ...(Number.isInteger(o.risk) ? { risk: o.risk as number } : {}), ...(str(o.baseUrl) ? { baseUrl: str(o.baseUrl) } : {}),
    steps: steps.map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      return { ...(str(x.instruction) ? { instruction: str(x.instruction) } : {}), ...(str(x.automated) ? { automated: str(x.automated) } : {}), expected: strs(x.expected), attachments: strs(x.attachments), checks: strs(x.checks) };
    }),
    ...(columns.length && Array.isArray(params?.rows) ? { parameters: { columns, rows: (params!.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) } } : {}),
  };
}

export function previewCase(model: ManualCaseInput): { ez: string; id: string; steps: number; manualSteps: number; kind: string } {
  try {
    const { ez, journey } = renderManualCase(model);
    return { ez, id: journey.id, steps: journey.steps.length, manualSteps: manualStepCount(journey), kind: journeyKind(journey) };
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

/** Write a case: to `path` (replace) or a new file under journeysDir/casesDir. */
export async function saveCase(app: StudioApp, model: ManualCaseInput, path?: string): Promise<{ path: string; ez: string; id: string; created: boolean }> {
  const p = previewCase(model);
  const cfg = await manualConfig(app);
  const { cases } = await allCaseInfo(app);
  let abs: string;
  if (path) abs = await app.journeyPath(path);
  else {
    abs = await app.journeyPath(join(cfg.journeysDir, cfg.casesDir, `${p.id}.ez`));
    if (existsSync(abs)) throw new HttpError(409, `${app.rel(abs)} already exists; open it to edit, or give the case another name`);
  }
  const clash = cases.find((c) => c.id === p.id && c.path && resolve(app.cwd, c.path) !== abs);
  if (clash) throw new HttpError(409, `Journey id "${p.id}" is already used by ${clash.path}; set another Id`);
  const created = !existsSync(abs);
  await mkdir(dirname(abs), { recursive: true });
  app.confine(relative(app.cwd, abs));
  await writeFile(abs, p.ez);
  app.hub.publish('manual', { type: 'case-saved', path: app.rel(abs), id: p.id });
  return { path: app.rel(abs), ez: p.ez, id: p.id, created };
}

// ------------------------------------------------------------------ runs

/** State of a guided run: the plan, verdicts so far, pending steps; from memory while running, else from run.json. */
export async function runSession(app: StudioApp, runId: string) {
  assertRunId(runId);
  const m = await masker(app);
  const active = app.runs.find(runId);
  const pending = app.manual.pending(runId);
  const runJson = join(await app.outputDir(), runId, 'run.json');
  let result: RunResult | undefined;
  if (existsSync(runJson)) {
    try {
      result = JSON.parse(await readFile(runJson, 'utf8')) as RunResult;
    } catch {
      result = undefined;
    }
  }
  if (!active && !result) throw new HttpError(404, `Run ${runId} not found`);
  const status: Record<string, Record<string, string>> = {};
  for (const e of active?.events ?? []) {
    if (e.type === 'step:end') (status[String(e.data.journeyId)] ??= {})[String(e.data.stepId)] = String(e.data.status);
    if (e.type === 'step:start') (status[String(e.data.journeyId)] ??= {})[String(e.data.stepId)] ??= 'running';
  }
  const flat = (r: JourneyResult) => {
    const out: JourneyResult['steps'] = [];
    const walk = (l: JourneyResult['steps']) => l.forEach((s) => (out.push(s), walk(s.children ?? [])));
    walk(r.steps);
    return out;
  };
  const plan: RunPlanJourney[] = active?.plan ?? (result?.journeys ?? []).map((j) => ({
    id: j.journeyId, name: j.name, type: j.manual?.type ?? 'automated',
    steps: flat(j).map((s) => ({ id: s.stepId, intent: s.intent, manual: !!s.manual, depth: 0, ...(s.manual ? { instruction: s.manual.instruction, expected: s.manual.expected } : {}) })),
  }));
  const verdicts: Record<string, Record<string, { verdict: string; tester?: string; notes?: string; actual?: string; attachments: string[]; at?: string }>> = {};
  for (const j of result?.journeys ?? []) {
    for (const s of flat(j)) {
      (status[j.journeyId] ??= {})[s.stepId] = s.status;
      if (s.manual) (verdicts[j.journeyId] ??= {})[s.stepId] = { verdict: s.manual.verdict, ...(s.manual.tester ? { tester: s.manual.tester } : {}), ...(s.manual.notes ? { notes: s.manual.notes } : {}), ...(s.manual.actual ? { actual: s.manual.actual } : {}), attachments: s.manual.attachments, ...(s.manual.at ? { at: s.manual.at } : {}) };
    }
  }
  for (const a of app.manual.answers(runId)) ((verdicts[a.journeyId] ??= {})[a.stepId] ??= { verdict: a.status, ...(a.tester ? { tester: a.tester } : {}), attachments: [], at: a.at });
  const state = active ? active.state : 'done';
  return m.maskDeep({
    runId, state, request: active ? { tester: active.request.tester, cycle: active.request.cycle } : undefined,
    plan, status, verdicts, pending: pending.map((p) => ({ key: p.key, since: p.since, ...p.request })),
    summary: result?.summary, journeys: result?.journeys.map((j) => ({ journeyId: j.journeyId, status: j.status, manual: j.manual, error: j.error })),
    report: result ? `/runs/${encodeURIComponent(runId)}/report.html` : undefined,
  });
}

const ATTACH_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

/** The verdict body of POST /api/manual/verdict (validated; attachments decoded from base64). */
export function verdictInput(body: Record<string, unknown>): ManualVerdict {
  const status = String(body.status ?? '');
  if (!['passed', 'failed', 'blocked', 'skipped'].includes(status)) throw new HttpError(400, 'status must be passed, failed, blocked or skipped');
  const tester = str(body.tester).trim();
  if (!tester) throw new HttpError(400, 'A tester name is required');
  if (tester.length > 120) throw new HttpError(400, 'The tester name is too long');
  const notes = str(body.notes);
  const actual = str(body.actual);
  if ((status === 'failed' || status === 'blocked') && !notes.trim() && !actual.trim()) throw new HttpError(400, `A ${status} verdict needs notes or what you observed`);
  const list = Array.isArray(body.attachments) ? body.attachments : [];
  if (list.length > 10) throw new HttpError(400, 'At most 10 attachments per step');
  const attachments: ManualAttachment[] = list.map((a, i) => {
    const x = (a ?? {}) as Record<string, unknown>;
    const type = str(x.contentType).toLowerCase();
    if (!ATTACH_TYPES.has(type)) throw new HttpError(415, `Attachment ${i + 1}: ${type || 'unknown type'} is not accepted (PNG, JPEG, GIF, WebP, PDF or text)`);
    const b64 = str(x.data).replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new HttpError(400, `Attachment ${i + 1}: data must be base64`);
    const data = Buffer.from(b64, 'base64');
    if (!data.length) throw new HttpError(400, `Attachment ${i + 1} is empty`);
    if (type === 'image/png' && data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new HttpError(400, `Attachment ${i + 1} is not a PNG image`);
    if (type === 'image/jpeg' && data.subarray(0, 3).toString('hex') !== 'ffd8ff') throw new HttpError(400, `Attachment ${i + 1} is not a JPEG image`);
    if (type === 'application/pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, `Attachment ${i + 1} is not a PDF`);
    const name = (str(x.name) || `attachment-${i + 1}`).replace(/[^\w. -]+/g, '_').slice(0, 100);
    return { name, contentType: type, data };
  });
  return { status: status as ManualVerdict['status'], tester, ...(notes.trim() ? { notes } : {}), ...(actual.trim() ? { actual } : {}), attachments };
}

// ------------------------------------------------------------------ plans

export async function plansPath(app: StudioApp): Promise<string> {
  return app.confine((await manualConfig(app)).plansFile);
}

export async function readPlans(app: StudioApp): Promise<PlansFile> {
  try {
    return await loadPlans(await plansPath(app));
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

export async function writePlans(app: StudioApp, v: unknown): Promise<PlansFile> {
  let plans: PlansFile;
  try {
    plans = parsePlans(v);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
  await savePlans(await plansPath(app), plans);
  app.hub.publish('manual', { type: 'plans' });
  return plans;
}

/** Record that a run executes (part of) a cycle. */
export async function recordCycleRun(app: StudioApp, cycleId: string, runId: string): Promise<void> {
  const plans = await readPlans(app);
  const c = plans.cycles.find((x) => x.id === cycleId);
  if (!c) throw new HttpError(404, `No cycle "${cycleId}"`);
  if (!c.runs.includes(runId)) c.runs.push(runId);
  if (c.state === 'planned') c.state = 'active';
  await writePlans(app, plans);
}

export async function plansOverview(app: StudioApp) {
  const plans = await readPlans(app);
  const { cases } = await allCaseInfo(app);
  const runs = (await recentRuns(await app.outputDir(), 500)).map((r) => r.run);
  const progress = plans.cycles.map((c) => cycleProgress(c, plans, cases, runs));
  const cfg = await manualConfig(app);
  const testers = [...new Set([...cfg.testers, ...cases.map((c) => c.assignee).filter((x): x is string => !!x), ...plans.cycles.flatMap((c) => Object.values(c.assignments))])].sort();
  return (await masker(app)).maskDeep({ path: app.rel(await plansPath(app)), plans, cases, testers, progress });
}

/** Cases of a cycle to run now: assigned to `tester` (when given) and, by default, not yet passed. */
export async function cycleRunSelection(app: StudioApp, cycleId: string, opts: { tester?: string; only?: 'open' | 'all' | 'failed' }): Promise<string[]> {
  const plans = await readPlans(app);
  const c = plans.cycles.find((x) => x.id === cycleId);
  if (!c) throw new HttpError(404, `No cycle "${cycleId}"`);
  if (c.state === 'closed') throw new HttpError(409, `Cycle "${c.name}" is closed`);
  const { cases } = await allCaseInfo(app);
  const runs = (await recentRuns(await app.outputDir(), 500)).map((r) => r.run);
  const p = cycleProgress(c, plans, cases, runs);
  const only = opts.only ?? 'open';
  const pick = (x: CaseProgress) => !x.missing && (!opts.tester || x.assignee === opts.tester) && (only === 'all' || (only === 'failed' ? x.state === 'failed' || x.state === 'blocked' : x.state !== 'passed'));
  const ids = p.cases.filter(pick).map((x) => x.id);
  if (!ids.length) throw new HttpError(400, opts.tester ? `No ${only === 'all' ? '' : 'open '}cases in "${c.name}" are assigned to ${opts.tester}` : `No ${only === 'all' ? '' : 'open '}cases in "${c.name}"`);
  return ids;
}

/** Active cycles' progress and one tester's open assignments. */
export async function dashboard(app: StudioApp, tester?: string) {
  const o = await plansOverview(app);
  const active = o.progress.filter((p) => p.cycle.state !== 'closed');
  const mine = tester
    ? active.flatMap((p) => p.cases.filter((c) => c.assignee === tester && c.state !== 'passed').map((c) => ({ ...c, cycle: p.cycle.id, cycleName: p.cycle.name })))
    : [];
  return { tester, cycles: active, mine, testers: o.testers };
}

// ------------------------------------------------------------------ automation

export async function automateCase(app: StudioApp, path: unknown, method: 'grammar' | 'recording', recorded: RecordedStep[] = []) {
  const abs = await app.journeyPath(path);
  if (!existsSync(abs)) throw new HttpError(404, 'File not found');
  const j = await loadJourneyFile(abs);
  try {
    const r = method === 'recording' ? automateWithRecording(j, recorded) : automateWithGrammar(j);
    return { path: app.rel(abs), ez: r.ez, kind: journeyKind(r.journey), automated: r.automated, kept: r.kept, uncheckedExpectations: r.uncheckedExpectations, id: r.journey.id };
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

/** Serve a reference file named by an `Attachment:` line (project-confined; images, PDF and text only). */
export async function referenceFile(app: StudioApp, path: unknown): Promise<{ data: Buffer; type: string; name: string }> {
  const rel = str(path);
  if (!rel) throw new HttpError(400, '"path" is required');
  const abs = app.confine(rel);
  const { isSensitive, relPosix } = await import('./security.js');
  if (isSensitive(relPosix(app.cwd, abs))) throw new HttpError(403, 'Not readable from the Studio');
  if (!existsSync(abs)) throw new HttpError(404, `Not found: ${rel}`);
  const ext = abs.toLowerCase().split('.').pop() ?? '';
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8' };
  const type = types[ext];
  if (!type) throw new HttpError(415, 'Only images, PDF and text files can be opened as references');
  return { data: await readFile(abs), type, name: abs.split(/[\\/]/).pop()! };
}
