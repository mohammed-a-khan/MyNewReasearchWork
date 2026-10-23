/**
 * Flaky ranking with per-run outcome strips, run compare, and trends
 * (pass/heal/flaky rates, durations, failures by classification, slowest
 * journeys and steps, tags and areas).
 */
import { join } from 'node:path';
import type { JourneyResult, RunResult } from '../../core/index.js';
import {
  applyTriageOverrides,
  loadQuarantine,
  loadTriageOverrides,
  quarantineStatus,
  scoreFlakiness,
  summarizeFlakeCauses,
  withFlakeCauses,
  TRIAGE_CATEGORIES,
  triageRun,
  type QuarantineEntry,
  type TriageCategory,
} from '../../insights/index.js';
import type { StudioApp } from '../app.js';
import { completedRuns, isHookResult, journeyFiles, loadRun, nonTestJourneyIds, openHistory, qualityPaths, readJsonFile } from './common.js';
import { flattenStepResults } from '../../core/index.js';

// ------------------------------------------------------------------ flaky

export async function flakyBoard(app: StudioApp, n = 20) {
  const history = await openHistory(app);
  const paths = await qualityPaths(app);
  const qfile = await loadQuarantine(paths.quarantine).catch(() => ({ version: 1 as const, entries: [] as QuarantineEntry[] }));
  const qs = quarantineStatus(qfile);
  const files = await journeyFiles(app);
  const names = new Map(files.map((f) => [f.id, f.name]));
  const runs = history ? history.runs.slice(-n) : [];
  const skip = await nonTestJourneyIds(app, files);
  const ids = new Set([...(history?.journeyIds() ?? []), ...files.map((f) => f.id)].filter((id) => !skip.has(id)));
  const rows = [...ids].map((id) => {
    const outcomes = history?.outcomesFor(id) ?? [];
    const statuses = outcomes.map((o) => o.status);
    const causes = summarizeFlakeCauses(id, outcomes, n);
    // Retried passes and their classified root cause (overlay, timing, detached, network, data) feed the score.
    const score = withFlakeCauses(scoreFlakiness(id, statuses), causes);
    const strip = runs.map((r) => {
      const mine = r.outcomes.filter((o) => o.journeyId === id);
      const last = mine.length ? mine.reduce((a, b) => (b.attempt >= a.attempt ? b : a)) : undefined;
      return { runId: r.runId, startedAt: r.startedAt, status: last?.status ?? 'not-run', attempts: mine.length, durationMs: last?.durationMs };
    });
    const q = qfile.entries.find((e) => e.journeyId === id);
    const unit = /^(.+)@((?:chromium|firefox|webkit|chrome|msedge)(?:-[a-z]+)?)$/.exec(id);
    return {
      journeyId: id,
      // Cross-browser runs record one row per journey x browser unit (<id>@<browser>).
      ...(unit ? { journey: unit[1], browser: unit[2] } : {}),
      name: names.get(id) ?? (unit ? `${names.get(unit[1]) ?? unit[1]} [${unit[2]}]` : id),
      onDisk: names.has(id) || (!!unit && names.has(unit[1])),
      score: { state: score.state, samples: score.samples, flips: score.flips, flipRate: score.flipRate, failRate: score.failRate, failRateInterval: score.failRateInterval, healedRate: score.healedRate, healedTrendRising: score.healedTrendRising, reasons: score.reasons, quarantine: score.quarantine, ...(score.rootCause ? { rootCause: score.rootCause } : {}) },
      strip,
      // Runs that needed a retry to pass are a strong flakiness signal too.
      retriedPasses: Math.max(causes.retriedPasses, strip.filter((s) => s.attempts > 1 && (s.status === 'passed' || s.status === 'passed-healed')).length),
      flakeCauses: causes.byCause,
      quarantine: q ? { ...q, expired: qs.expired.includes(q), expiringSoon: qs.expiringSoon.includes(q) } : undefined,
    };
  });
  rows.sort((a, b) => b.score.flipRate - a.score.flipRate || b.score.failRate - a.score.failRate || a.journeyId.localeCompare(b.journeyId));
  // Cross-browser runs: each journey over all its browsers (the worst state wins), next to the per-browser rows.
  const rank = { broken: 4, flaky: 3, recovering: 2, new: 1, stable: 0 } as Record<string, number>;
  const combinedMap = new Map<string, { journeyId: string; name: string; state: string; browsers: Record<string, string> }>();
  for (const r of rows) {
    if (!('browser' in r) || !r.browser || !r.journey) continue;
    const c = combinedMap.get(r.journey) ?? { journeyId: r.journey, name: names.get(r.journey) ?? r.journey, state: 'stable', browsers: {} };
    c.browsers[r.browser] = r.score.state;
    if ((rank[r.score.state] ?? 0) > (rank[c.state] ?? 0)) c.state = r.score.state;
    combinedMap.set(r.journey, c);
  }
  const combined = [...combinedMap.values()].sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0) || a.journeyId.localeCompare(b.journeyId));
  return { runs: runs.map((r) => ({ runId: r.runId, startedAt: r.startedAt })), rows, ...(combined.length ? { combined } : {}), quarantine: { entries: qfile.entries, warnings: qs.warnings, active: qs.active.length, expired: qs.expired.length } };
}

// ------------------------------------------------------------------ compare

type JStatus = JourneyResult['status'] | 'absent';

const isPass = (s: string) => s === 'passed' || s === 'passed-healed';
const isFail = (s: string) => s === 'failed' || s === 'error' || s === 'blocked';

export type ChangeKind = 'newly-failing' | 'fixed' | 'newly-healed' | 'heal-resolved' | 'still-failing' | 'added' | 'removed' | 'unchanged' | 'other';

function classify(a: JStatus, b: JStatus): ChangeKind {
  if (a === 'absent') return 'added';
  if (b === 'absent') return 'removed';
  if (!isFail(a) && isFail(b)) return 'newly-failing';
  if (isFail(a) && isPass(b)) return 'fixed';
  if (isFail(a) && isFail(b)) return 'still-failing';
  if (a === 'passed' && b === 'passed-healed') return 'newly-healed';
  if (a === 'passed-healed' && b === 'passed') return 'heal-resolved';
  if (a === b) return 'unchanged';
  return 'other';
}

async function readinessOf(dir: string) {
  const r = await readJsonFile<{ insights?: { readiness?: { decision: string; score: number } } }>(join(dir, 'report.json'));
  return r?.insights?.readiness ? { decision: r.insights.readiness.decision, score: r.insights.readiness.score } : undefined;
}

export async function compareRuns(app: StudioApp, aId: string, bId: string) {
  const [A, B] = await Promise.all([loadRun(app, aId), loadRun(app, bId)]);
  const tests = (r: RunResult) => r.journeys.filter((j) => !isHookResult(j));
  const ids = [...new Set([...tests(A.run).map((j) => j.journeyId), ...tests(B.run).map((j) => j.journeyId)])];
  const find = (r: RunResult, id: string) => tests(r).find((j) => j.journeyId === id);
  const flat = (j?: JourneyResult) => flattenStepResults(j?.steps ?? []).map((x) => x.result);
  const journeys = ids.map((id) => {
    const a = find(A.run, id);
    const b = find(B.run, id);
    const sa: JStatus = a?.status ?? 'absent';
    const sb: JStatus = b?.status ?? 'absent';
    const sa_ = flat(a);
    const sb_ = flat(b);
    const stepIds = [...new Set([...sa_.map((s) => s.stepId), ...sb_.map((s) => s.stepId)])];
    const steps = stepIds.map((sid) => {
      const x = sa_.find((s) => s.stepId === sid);
      const y = sb_.find((s) => s.stepId === sid);
      const ka = (x?.status ?? 'absent') as JStatus;
      const kb = (y?.status ?? 'absent') as JStatus;
      return {
        stepId: sid,
        intent: y?.intent ?? x?.intent ?? sid,
        a: ka,
        b: kb,
        change: classify(ka, kb),
        durationA: x?.durationMs,
        durationB: y?.durationMs,
        healA: x?.heal ? { tier: x.heal.tier, locator: x.heal.healed } : undefined,
        healB: y?.heal ? { tier: y.heal.tier, locator: y.heal.healed } : undefined,
        errorB: y?.error?.message?.slice(0, 300),
      };
    });
    return { journeyId: id, name: b?.name ?? a?.name ?? id, a: sa, b: sb, change: classify(sa, sb), durationA: a?.durationMs, durationB: b?.durationMs, steps };
  });
  const order: ChangeKind[] = ['newly-failing', 'still-failing', 'newly-healed', 'fixed', 'heal-resolved', 'added', 'removed', 'other', 'unchanged'];
  journeys.sort((x, y) => order.indexOf(x.change) - order.indexOf(y.change) || x.journeyId.localeCompare(y.journeyId));
  const counts: Partial<Record<ChangeKind, number>> = {};
  for (const j of journeys) counts[j.change] = (counts[j.change] ?? 0) + 1;
  const stepChanges = journeys.flatMap((j) => j.steps.filter((s) => s.change !== 'unchanged').map((s) => ({ journeyId: j.journeyId, ...s })));
  const durations = journeys
    .filter((j) => j.durationA !== undefined && j.durationB !== undefined)
    .map((j) => ({ journeyId: j.journeyId, name: j.name, a: j.durationA!, b: j.durationB!, delta: j.durationB! - j.durationA!, ratio: j.durationA! ? j.durationB! / j.durationA! : 0 }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return {
    a: { runId: aId, startedAt: A.run.startedAt, summary: A.run.summary, durationMs: A.run.durationMs, readiness: await readinessOf(A.dir) },
    b: { runId: bId, startedAt: B.run.startedAt, summary: B.run.summary, durationMs: B.run.durationMs, readiness: await readinessOf(B.dir) },
    counts,
    journeys,
    stepChanges,
    durations,
  };
}

// ------------------------------------------------------------------ trends

export async function trends(app: StudioApp, n = 30) {
  const runs = (await completedRuns(app)).slice(0, n).reverse();
  const history = await openHistory(app);
  const paths = await qualityPaths(app);
  const overrides = await loadTriageOverrides(paths.overrides).catch(() => ({ version: 1 as const, overrides: [] }));
  const started = new Map(runs.map((r) => [r.runId, r.startedAt ?? '']));
  const files = await journeyFiles(app);
  const fileOf = new Map(files.map((f) => [f.id, f]));
  const out = await app.outputDir();
  const points: Array<{
    runId: string;
    startedAt: string;
    total: number;
    executed: number;
    passRate: number;
    healRate: number;
    flakyRate: number;
    meanDurationMs: number;
    failures: Record<TriageCategory, number>;
  }> = [];
  const journeyDur = new Map<string, { name: string; total: number; n: number; max: number; last: number }>();
  const stepDur = new Map<string, { journeyId: string; stepId: string; intent: string; total: number; n: number; max: number }>();
  const tagAgg = new Map<string, { tag: string; runs: number; passed: number; healed: number; failed: number }>();
  const areaAgg = new Map<string, { area: string; runs: number; passed: number; healed: number; failed: number }>();
  for (const r of runs) {
    let lr;
    try {
      lr = await loadRun(app, r.runId);
    } catch {
      continue;
    }
    const run = lr.run;
    const executed = run.journeys.filter((j) => j.status !== 'skipped' && !isHookResult(j));
    const pass = executed.filter((j) => isPass(j.status)).length;
    const healed = executed.filter((j) => j.status === 'passed-healed').length;
    // Flaky rate as known at that run: journeys labelled flaky from history up to and including it.
    let flakyN = 0;
    if (history) {
      const upto = history.runs.filter((h) => h.startedAt <= run.startedAt);
      for (const j of executed) {
        const seq = upto.map((h) => h.outcomes.filter((o) => o.journeyId === j.journeyId).pop()?.status).filter((s): s is NonNullable<typeof s> => !!s);
        if (scoreFlakiness(j.journeyId, seq).state === 'flaky') flakyN++;
      }
    }
    const failures = Object.fromEntries(TRIAGE_CATEGORIES.map((c) => [c, 0])) as Record<TriageCategory, number>;
    const rep = await readJsonFile<{ insights?: { triage?: { runId: string; verdicts: Parameters<typeof applyTriageOverrides>[0]['verdicts'] } } }>(join(out, r.runId, 'report.json'));
    // Verdicts recorded at analysis time; runs analyzed elsewhere (or not at all) are triaged now.
    let base = rep?.insights?.triage?.verdicts;
    if (!base && executed.some((j) => isFail(j.status))) {
      try {
        base = triageRun({ run, evidence: lr.evidence }).verdicts;
      } catch {
        base = [];
      }
    }
    const verdicts = applyTriageOverrides({ runId: r.runId, verdicts: base ?? [] }, overrides, (id) => started.get(id));
    const classified = new Set<string>();
    for (const v of verdicts) {
      failures[v.category] = (failures[v.category] ?? 0) + 1;
      classified.add(v.journeyId);
    }
    for (const j of executed) if (isFail(j.status) && !classified.has(j.journeyId)) failures.unknown++;
    points.push({
      runId: r.runId,
      startedAt: run.startedAt,
      total: run.journeys.length,
      executed: executed.length,
      passRate: executed.length ? pass / executed.length : 0,
      healRate: executed.length ? healed / executed.length : 0,
      flakyRate: executed.length ? flakyN / executed.length : 0,
      meanDurationMs: executed.length ? executed.reduce((s, j) => s + j.durationMs, 0) / executed.length : 0,
      failures,
    });
    for (const j of executed) {
      const d = journeyDur.get(j.journeyId) ?? { name: j.name, total: 0, n: 0, max: 0, last: 0 };
      d.total += j.durationMs;
      d.n++;
      d.max = Math.max(d.max, j.durationMs);
      d.last = j.durationMs;
      journeyDur.set(j.journeyId, d);
      for (const { result: s } of flattenStepResults(j.steps)) {
        if (s.status === 'skipped' || s.children?.length) continue;
        const k = `${j.journeyId}/${s.stepId}`;
        const sd = stepDur.get(k) ?? { journeyId: j.journeyId, stepId: s.stepId, intent: s.intent, total: 0, n: 0, max: 0 };
        sd.total += s.durationMs;
        sd.n++;
        sd.max = Math.max(sd.max, s.durationMs);
        stepDur.set(k, sd);
      }
      const bump = <T extends { runs: number; passed: number; healed: number; failed: number }>(m: Map<string, T>, key: string, init: T) => {
        const a = m.get(key) ?? init;
        a.runs++;
        if (j.status === 'passed') a.passed++;
        else if (j.status === 'passed-healed') a.healed++;
        else if (isFail(j.status)) a.failed++;
        m.set(key, a);
      };
      for (const t of j.tags.length ? j.tags : ['(untagged)']) bump(tagAgg, t, { tag: t, runs: 0, passed: 0, healed: 0, failed: 0 });
      const f = fileOf.get(j.journeyId);
      const area = f ? f.path.split('/').slice(0, -1).join('/') || '.' : '(not on disk)';
      bump(areaAgg, area, { area, runs: 0, passed: 0, healed: 0, failed: 0 });
    }
  }
  const slowJourneys = [...journeyDur.entries()].map(([id, d]) => ({ journeyId: id, name: d.name, meanMs: d.total / d.n, maxMs: d.max, lastMs: d.last, samples: d.n })).sort((a, b) => b.meanMs - a.meanMs).slice(0, 10);
  const slowSteps = [...stepDur.values()].map((d) => ({ journeyId: d.journeyId, stepId: d.stepId, intent: d.intent, meanMs: d.total / d.n, maxMs: d.max, samples: d.n })).sort((a, b) => b.meanMs - a.meanMs).slice(0, 10);
  return {
    points,
    slowJourneys,
    slowSteps,
    tags: [...tagAgg.values()].sort((a, b) => b.failed / b.runs - a.failed / a.runs || b.runs - a.runs),
    areas: [...areaAgg.values()].sort((a, b) => b.failed / b.runs - a.failed / a.runs || b.runs - a.runs),
    categories: TRIAGE_CATEGORIES,
  };
}

// ------------------------------------------------------------------ summary (nav badges, dashboard)

export async function qualitySummary(app: StudioApp) {
  const { collectHeals } = await import('./heals.js');
  const heals = await collectHeals(app, { runs: 30 }).catch(() => ({ items: [] as Array<{ status: string; key: string; lastRunId: string; runs: Array<{ runId: string }> }> }));
  const pending = heals.items.filter((h) => h.status === 'pending');
  const paths = await qualityPaths(app);
  const qs = quarantineStatus(await loadQuarantine(paths.quarantine).catch(() => ({ version: 1 as const, entries: [] })));
  const latest = (await completedRuns(app))[0];
  return {
    pendingHeals: pending.length,
    /** runId -> heals of that run still to review (for run-detail tab badges). */
    pendingByRun: pending.reduce<Record<string, number>>((m, h) => {
      for (const r of h.runs) m[r.runId] = (m[r.runId] ?? 0) + 1;
      return m;
    }, {}),
    quarantine: { active: qs.active.length, expiringSoon: qs.expiringSoon.length, expired: qs.expired.length },
    latestRun: latest ? { runId: latest.runId, failed: (latest.summary?.failed ?? 0) + (latest.summary?.errors ?? 0), healed: latest.summary?.passedHealed ?? 0 } : undefined,
  };
}
