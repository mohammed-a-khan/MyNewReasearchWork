/**
 * Test management: suites (named sets of cases, explicit or by tag), test
 * cycles (a release's planned execution of suites, with testers assigned per
 * case, dates and state) and progress computed from the runs recorded for the
 * cycle. Stored as one JSON project file (`manual.plansFile`, default
 * `test-plans.json`) so it is reviewed and versioned with the journeys.
 *
 * Results are never stored here: a cycle lists its run ids, and progress is
 * read from those runs' run.json (the same results that readiness,
 * traceability and ADO publishing use).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { EzTestError, slugify, type JourneyResult, type RunResult } from '../core/index.js';

const Id = z.string().regex(/^[A-Za-z0-9][\w.-]{0,80}$/, 'ids are letters, digits, ".", "_" or "-"');

export const SuiteSchema = z.strictObject({
  id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  /** Journey ids. */
  cases: z.array(z.string().min(1)).default([]),
  /** Also every journey with one of these tags (without "@"). */
  tags: z.array(z.string().min(1)).default([]),
});

export const CycleSchema = z.strictObject({
  id: Id,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  /** Release / milestone label. */
  release: z.string().max(200).optional(),
  suites: z.array(Id).default([]),
  /** Extra cases outside the suites. */
  cases: z.array(z.string().min(1)).default([]),
  /** journeyId -> tester. Unassigned cases fall back to the case's Assignee: header. */
  assignments: z.record(z.string(), z.string().min(1).max(120)).default({}),
  start: z.string().optional(),
  due: z.string().optional(),
  state: z.enum(['planned', 'active', 'closed']).default('planned'),
  /** Runs that executed cases of this cycle (newest last). */
  runs: z.array(z.string().min(1)).default([]),
  createdAt: z.string().optional(),
  createdBy: z.string().max(120).optional(),
});

export const PlansFileSchema = z.strictObject({
  version: z.literal(1).default(1),
  suites: z.array(SuiteSchema).default([]),
  cycles: z.array(CycleSchema).default([]),
});

export type Suite = z.infer<typeof SuiteSchema>;
export type Cycle = z.infer<typeof CycleSchema>;
export type PlansFile = z.infer<typeof PlansFileSchema>;

export function parsePlans(input: unknown): PlansFile {
  const r = PlansFileSchema.safeParse(input);
  if (!r.success) throw new EzTestError(`Invalid test plans: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'PLANS_INVALID');
  const ids = new Set<string>();
  for (const s of r.data.suites) {
    if (ids.has(`s:${s.id}`)) throw new EzTestError(`Duplicate suite id ${s.id}`, 'PLANS_INVALID');
    ids.add(`s:${s.id}`);
  }
  for (const c of r.data.cycles) {
    if (ids.has(`c:${c.id}`)) throw new EzTestError(`Duplicate cycle id ${c.id}`, 'PLANS_INVALID');
    ids.add(`c:${c.id}`);
    for (const s of c.suites) if (!ids.has(`s:${s}`)) throw new EzTestError(`Cycle ${c.id} names unknown suite ${s}`, 'PLANS_INVALID');
  }
  return r.data;
}

export async function loadPlans(path: string): Promise<PlansFile> {
  if (!existsSync(path)) return { version: 1, suites: [], cycles: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new EzTestError(`${path} is not valid JSON: ${(e as Error).message}`, 'PLANS_INVALID');
  }
  return parsePlans(raw);
}

export async function savePlans(path: string, plans: PlansFile): Promise<void> {
  const data = parsePlans(plans);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);
}

/** A fresh, unused id from a name. */
export function newId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name).slice(0, 60) || 'item';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

export interface CaseInfo {
  id: string;
  name: string;
  tags: string[];
  type: 'automated' | 'manual' | 'hybrid';
  assignee?: string;
  path?: string;
  risk?: number;
  requirements?: string[];
  manualSteps?: number;
}

/** The cases a suite holds (explicit ids first, then tag matches), in a stable order. */
export function suiteCases(s: Suite, all: CaseInfo[]): string[] {
  const out: string[] = [];
  for (const id of s.cases) if (!out.includes(id)) out.push(id);
  for (const c of all) if (s.tags.some((t) => c.tags.includes(t.replace(/^@/, ''))) && !out.includes(c.id)) out.push(c.id);
  return out;
}

/** All cases of a cycle (its suites, then its extra cases). */
export function cycleCases(c: Cycle, plans: PlansFile, all: CaseInfo[]): string[] {
  const out: string[] = [];
  for (const sid of c.suites) {
    const s = plans.suites.find((x) => x.id === sid);
    if (s) for (const id of suiteCases(s, all)) if (!out.includes(id)) out.push(id);
  }
  for (const id of c.cases) if (!out.includes(id)) out.push(id);
  return out;
}

export function assigneeOf(c: Cycle, caseId: string, all: CaseInfo[]): string | undefined {
  return c.assignments[caseId] ?? all.find((x) => x.id === caseId)?.assignee;
}

export type CaseState = 'passed' | 'failed' | 'blocked' | 'skipped' | 'untested' | 'in-progress';

export interface CaseProgress {
  id: string;
  name: string;
  type: CaseInfo['type'];
  assignee?: string;
  state: CaseState;
  runId?: string;
  at?: string;
  testers: string[];
  /** Manual steps with a verdict / all manual steps, in the latest result. */
  manualDone?: number;
  manualTotal?: number;
  missing?: boolean;
}

export interface CycleProgress {
  cycle: Pick<Cycle, 'id' | 'name' | 'state' | 'start' | 'due' | 'release'>;
  total: number;
  counts: Record<CaseState, number>;
  /** Executed (passed, failed, blocked, skipped) / total. */
  executedRatio: number;
  passRatio: number;
  cases: CaseProgress[];
  byAssignee: Array<{ assignee: string; total: number; counts: Record<CaseState, number> }>;
  bySuite: Array<{ suite: string; name: string; total: number; counts: Record<CaseState, number> }>;
  /** Executed cases per day (burn-up), oldest first. */
  burnup: Array<{ date: string; executed: number; passed: number }>;
}

const emptyCounts = (): Record<CaseState, number> => ({ passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0, 'in-progress': 0 });

/** A case's state from one journey result (Examples rows: worst row wins). */
export function stateOf(results: JourneyResult[]): CaseState {
  if (!results.length) return 'untested';
  const anyStep = (pred: (s: JourneyResult['steps'][number]) => boolean) => results.some((r) => r.steps.some(pred));
  if (results.some((r) => r.error?.name === 'ManualBlocked') || anyStep((s) => s.status === 'blocked')) return 'blocked';
  if (results.some((r) => r.status === 'failed' || r.status === 'error')) return 'failed';
  if (results.some((r) => r.error?.name === 'CancelledError' || r.error?.name === 'ManualPending' || (r.manual?.pending ?? 0) > 0)) {
    return results.some((r) => (r.manual?.executed ?? 0) > 0) ? 'in-progress' : 'untested';
  }
  if (results.every((r) => r.status === 'skipped')) return 'skipped';
  return 'passed';
}

/** Progress of a cycle from its runs (latest result of each case wins). */
export function cycleProgress(c: Cycle, plans: PlansFile, all: CaseInfo[], runs: RunResult[]): CycleProgress {
  const ids = cycleCases(c, plans, all);
  const ordered = runs.filter((r) => c.runs.includes(r.runId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const latest = new Map<string, { run: RunResult; results: JourneyResult[] }>();
  const firstDone = new Map<string, { date: string; passed: boolean }>();
  for (const r of ordered) {
    const grouped = new Map<string, JourneyResult[]>();
    for (const j of r.journeys) {
      const base = ids.find((id) => j.journeyId === id || j.journeyId.startsWith(`${id}-`));
      if (!base) continue;
      grouped.set(base, [...(grouped.get(base) ?? []), j]);
    }
    for (const [id, results] of grouped) {
      const st = stateOf(results);
      if (st === 'untested') continue;
      latest.set(id, { run: r, results });
      if (st !== 'in-progress') firstDone.set(id, { date: r.startedAt.slice(0, 10), passed: st === 'passed' });
    }
  }
  const cases: CaseProgress[] = ids.map((id) => {
    const info = all.find((x) => x.id === id);
    const l = latest.get(id);
    const res = l?.results ?? [];
    const testers = [...new Set(res.flatMap((r) => r.manual?.testers ?? []))];
    const md = res.reduce((n, r) => n + (r.manual?.executed ?? 0), 0);
    const mt = res.reduce((n, r) => n + (r.manual ? r.manual.executed + r.manual.pending : 0), 0);
    return {
      id, name: info?.name ?? id, type: info?.type ?? 'automated', ...(assigneeOf(c, id, all) ? { assignee: assigneeOf(c, id, all) } : {}),
      state: stateOf(res), ...(l ? { runId: l.run.runId, at: l.run.startedAt } : {}), testers,
      ...(mt ? { manualDone: md, manualTotal: mt } : {}), ...(info ? {} : { missing: true }),
    };
  });
  const counts = emptyCounts();
  for (const x of cases) counts[x.state]++;
  const by = <K extends string>(key: (x: CaseProgress) => K | undefined) => {
    const m = new Map<K, CaseProgress[]>();
    for (const x of cases) {
      const k = key(x);
      if (k !== undefined) m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const byAssignee = [...by((x) => x.assignee ?? '(unassigned)')].map(([assignee, xs]) => {
    const cc = emptyCounts();
    for (const x of xs) cc[x.state]++;
    return { assignee, total: xs.length, counts: cc };
  }).sort((a, b) => a.assignee.localeCompare(b.assignee));
  const bySuite = c.suites.map((sid) => {
    const s = plans.suites.find((x) => x.id === sid);
    const own = s ? suiteCases(s, all) : [];
    const cc = emptyCounts();
    for (const x of cases.filter((y) => own.includes(y.id))) cc[x.state]++;
    return { suite: sid, name: s?.name ?? sid, total: own.length, counts: cc };
  });
  const days = [...new Set([...firstDone.values()].map((v) => v.date))].sort();
  let exec = 0;
  let pass = 0;
  const burnup = days.map((d) => {
    for (const v of firstDone.values()) if (v.date === d) (exec++, v.passed && pass++);
    return { date: d, executed: exec, passed: pass };
  });
  const executed = cases.filter((x) => x.state !== 'untested' && x.state !== 'in-progress').length;
  return {
    cycle: { id: c.id, name: c.name, state: c.state, ...(c.start ? { start: c.start } : {}), ...(c.due ? { due: c.due } : {}), ...(c.release ? { release: c.release } : {}) },
    total: cases.length, counts, executedRatio: cases.length ? executed / cases.length : 0, passRatio: cases.length ? counts.passed / cases.length : 0,
    cases, byAssignee, bySuite, burnup,
  };
}

/** Plain-text progress (CLI). */
export function cycleProgressText(p: CycleProgress): string {
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const c = p.counts;
  const lines = [
    `${p.cycle.name} (${p.cycle.id}, ${p.cycle.state}${p.cycle.due ? `, due ${p.cycle.due}` : ''}): ${pct(p.executedRatio)} executed, ${pct(p.passRatio)} passed`,
    `  ${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked, ${c.skipped} skipped, ${c['in-progress']} in progress, ${c.untested} untested of ${p.total}`,
  ];
  for (const a of p.byAssignee) lines.push(`  ${a.assignee}: ${a.total - a.counts.untested - a.counts['in-progress']}/${a.total} executed (${a.counts.failed + a.counts.blocked} failed or blocked)`);
  for (const x of p.cases) lines.push(`    ${x.state.padEnd(11)} ${x.id}${x.assignee ? ` @${x.assignee}` : ''}${x.runId ? ` (${x.runId})` : ''}${x.missing ? ' [no such journey]' : ''}`);
  return lines.join('\n');
}
