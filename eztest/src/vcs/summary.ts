/**
 * What EZTest tells a pull request: the status ("EZTest: GO / GO_WITH_RISKS /
 * NO_GO" when a readiness policy ran, else the counts), one Markdown comment (failures, heals awaiting review, impacted
 * journeys, readiness gates) and line annotations on the failing journey
 * steps. Built from a run directory's report.json, so any CI can post it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { JourneyResult, RunResult, StepResult } from '../core/index.js';
import { flattenSteps, type Step } from '../core/index.js';
import { ezStepLine } from '../heal/apply.js';
import type { ImpactResult } from '../insights/impact.js';
import type { ReadinessResult } from '../insights/readiness.js';
import type { TriageReport } from '../insights/triage.js';
import { loadJourneyFile } from '../intent/index.js';
import { findJourneyFiles } from '../cli/journeys.js';
import type { HealProposal, JsonReport } from '../report/index.js';
import type { Annotation, StatusState } from './types.js';

export interface GatePolicy {
  /** Status for NO_GO (default failure). */
  noGo?: StatusState;
  /** Status for GO_WITH_RISKS (default success, described as a risk; set "failure" to block). */
  goWithRisks?: StatusState;
}

export interface PrSummaryInput {
  run: RunResult;
  readiness?: ReadinessResult;
  triage?: TriageReport;
  healProposals?: HealProposal[];
  impact?: ImpactResult;
  /** journeyId -> repository-relative file and text, for annotations and links. */
  files?: Map<string, JourneyFileRef>;
  reportUrl?: string;
  buildUrl?: string;
  policy?: GatePolicy;
  context?: string;
  /** Max rows per table (default 20). */
  maxRows?: number;
}

export interface JourneyFileRef {
  path: string;
  text: string;
  steps: Step[];
}

export interface PrSummary {
  decision: 'GO' | 'GO_WITH_RISKS' | 'NO_GO';
  state: StatusState;
  /** Short status description (<= 140 chars). */
  description: string;
  markdown: string;
  annotations: Annotation[];
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));

function failingStep(steps: StepResult[]): StepResult | undefined {
  for (const s of steps) {
    if (s.status === 'failed' || s.status === 'blocked') return failingStep(s.children ?? []) ?? s;
  }
  return undefined;
}

function allSteps(steps: StepResult[]): StepResult[] {
  return steps.flatMap((s) => [s, ...allSteps(s.children ?? [])]);
}

/** The file of a result's journey: exact id, or the Examples base id (`<id>-<row>`). */
export function fileOf(files: Map<string, JourneyFileRef> | undefined, journeyId: string): JourneyFileRef | undefined {
  if (!files) return undefined;
  if (files.has(journeyId)) return files.get(journeyId);
  let best: string | undefined;
  for (const id of files.keys()) if (journeyId.startsWith(`${id}-`) && (!best || id.length > best.length)) best = id;
  return best ? files.get(best) : undefined;
}

/** 1-based line of a step in a journey file (`.ez` only; YAML/JSON get line 1). */
export function stepLine(f: JourneyFileRef, stepId: string): number {
  if (!/\.ez$/i.test(f.path)) return 1;
  const step = flattenSteps(f.steps).find((s) => s.id === stepId);
  if (!step) return 1;
  const i = ezStepLine(f.text, step);
  return i === undefined ? 1 : i + 1;
}

export function decisionOf(run: RunResult, readiness?: ReadinessResult): PrSummary['decision'] {
  if (readiness) return readiness.decision;
  const bad = run.journeys.some((j) => (j.status === 'failed' || j.status === 'error') && !j.tags.includes('hook'));
  const healed = run.journeys.some((j) => j.status === 'passed-healed');
  return bad ? 'NO_GO' : healed ? 'GO_WITH_RISKS' : 'GO';
}

export function buildPrSummary(i: PrSummaryInput): PrSummary {
  const run = i.run;
  const max = i.maxRows ?? 20;
  const decision = decisionOf(run, i.readiness);
  const state: StatusState = decision === 'NO_GO' ? (i.policy?.noGo ?? 'failure') : decision === 'GO_WITH_RISKS' ? (i.policy?.goWithRisks ?? 'success') : 'success';
  const tests = run.journeys.filter((j) => !j.tags.includes('hook'));
  const s = { total: tests.length, passed: 0, healed: 0, failed: 0, skipped: 0 };
  for (const j of tests) {
    if (j.status === 'passed') s.passed++;
    else if (j.status === 'passed-healed') s.healed++;
    else if (j.status === 'skipped') s.skipped++;
    else s.failed++;
  }
  const verdict = new Map((i.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const failed = tests.filter((j) => j.status === 'failed' || j.status === 'error');
  const heals = i.healProposals ?? tests.flatMap((j) => allSteps(j.steps).filter((st) => st.heal).map((st) => ({ journeyId: j.journeyId, journeyName: j.name, stepId: st.stepId, intent: st.intent, tier: st.heal!.tier, confidence: st.heal!.confidence, verified: st.heal!.verified, from: st.heal!.original.map((o) => `${o.strategy}=${o.value}`), to: `${st.heal!.healed.strategy}=${st.heal!.healed.value}`, reason: st.heal!.reason, evidence: st.heal!.evidence, recommendation: st.heal!.verified ? ('accept' as const) : ('review' as const) })));
  const commit = run.environment?.gitCommit ? ` at \`${run.environment.gitCommit.slice(0, 10)}\`` : '';
  // No verdict unless the team runs a readiness policy: the counts speak for themselves (the check's state still fails on failures).
  const counts = `${s.passed + s.healed}/${s.total} passed${s.healed ? `, ${s.healed} healed` : ''}${s.failed ? `, ${s.failed} failed` : ''}`;
  const desc = i.readiness ? `EZTest: ${decision} (score ${i.readiness.score}) - ${counts}` : `EZTest: ${counts}`;
  const out: string[] = [];
  out.push(i.readiness ? `### EZTest: ${decision}` : '### EZTest results');
  out.push('');
  out.push(`Run \`${run.runId}\`${commit}: **${s.total}** journeys, ${s.passed} passed, ${s.healed} passed with heals, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''}.${i.reportUrl ? ` [Full report](${i.reportUrl})` : ''}${i.buildUrl ? ` · [Pipeline run](${i.buildUrl})` : ''}`);
  if (i.readiness) {
    const bad = i.readiness.gates.filter((g) => g.status !== 'pass');
    if (bad.length) {
      out.push('', '<details><summary>Readiness gates not passing</summary>', '', '| Gate | Status | Why |', '|---|---|---|');
      for (const g of bad.slice(0, max)) out.push(`| ${md(g.gate)} | ${md(g.status)} | ${md(g.summary)} |`);
      out.push('', '</details>');
    }
  }
  const annotations: Annotation[] = [];
  if (failed.length) {
    out.push('', `#### Failures (${failed.length})`, '', '| Journey | Step | Error | Triage |', '|---|---|---|---|');
    for (const j of failed.slice(0, max)) {
      const st = failingStep(j.steps);
      const err = (st?.error ?? j.error)?.message ?? j.status;
      const v = verdict.get(j.journeyId);
      const f = fileOf(i.files, j.journeyId);
      const line = f && st ? stepLine(f, st.stepId) : undefined;
      const where = f ? `\`${f.path}${line ? `:${line}` : ''}\`` : '';
      out.push(`| ${md(j.name)} ${where} | ${md(st?.intent ?? '-')} | ${md(err.split('\n')[0].slice(0, 200))} | ${v ? `${md(v.category)} (${Math.round(v.confidence * 100)}%)` : '-'} |`);
      if (f) annotations.push({ path: f.path, line: line ?? 1, level: 'failure', title: `${j.name}: ${st?.intent ?? j.status}`.slice(0, 200), message: `${err}${v ? `\n\nTriage: ${v.category} (${Math.round(v.confidence * 100)}%) ${v.reasons[0] ?? ''}` : ''}`.slice(0, 4000) });
    }
    if (failed.length > max) out.push(`| ... ${failed.length - max} more | | | |`);
  }
  if (heals.length) {
    out.push('', `#### Heals awaiting review (${heals.length})`, '', '| Journey | Step | Locator | Tier | Verified |', '|---|---|---|---|---|');
    for (const h of heals.slice(0, max)) {
      out.push(`| ${md(h.journeyName)} | ${md(h.intent)} | \`${md(h.from.join(' / '))}\` -> \`${md(h.to)}\` | ${md(h.tier)} ${Math.round(h.confidence * 100)}% | ${h.verified ? 'yes' : 'no'} |`);
      const f = fileOf(i.files, h.journeyId);
      if (f) annotations.push({ path: f.path, line: stepLine(f, h.stepId), level: 'warning', title: `Healed: ${h.intent}`.slice(0, 200), message: `The locator no longer matched; EZTest healed it (${h.tier}, ${Math.round(h.confidence * 100)}%${h.verified ? ', verified by the step expectations' : ', not verified'}).\n${h.from.join(' / ')} -> ${h.to}\nReview it in EZTest Studio (Quality > Heal review).` });
    }
    out.push('', 'Accept or reject them in EZTest Studio (Quality > Heal review); an accepted heal can open its own PR.');
  }
  if (i.impact?.impacted.length) {
    const ran = new Set(tests.map((j) => j.journeyId));
    out.push('', `#### Impacted journeys (${i.impact.impacted.length})`, '', '| Journey | Why | Ran |', '|---|---|---|');
    for (const x of i.impact.impacted.slice(0, max)) {
      const via = [...new Set(x.via.map((v) => `${v.file} (${v.match} ${v.value})`))].slice(0, 2).join(', ');
      out.push(`| ${md(x.name ?? x.journeyId)} | ${md(via)} | ${ran.has(x.journeyId) || [...ran].some((r) => r.startsWith(`${x.journeyId}-`)) ? 'yes' : '**no**'} |`);
    }
    if (i.impact.uncovered.length) out.push('', `Changed files no journey covers: ${i.impact.uncovered.slice(0, 10).map((u) => `\`${md(u.file)}\``).join(', ')}${i.impact.uncovered.length > 10 ? ' ...' : ''}`);
  }
  if (!failed.length && !heals.length) out.push('', 'Every journey passed on its own locators.');
  out.push('', `<sub>Updated ${new Date(run.finishedAt).toISOString()} by EZTest. This comment is edited in place on every run.</sub>`);
  return { decision, state, description: desc.slice(0, 140), markdown: out.join('\n'), annotations };
}

/** Load a run directory (report.json when present, else run.json) for a PR summary. */
export async function loadRunForPr(runDir: string): Promise<Pick<PrSummaryInput, 'run' | 'readiness' | 'triage' | 'healProposals'>> {
  const rj = join(runDir, 'report.json');
  if (existsSync(rj)) {
    const r = JSON.parse(await readFile(rj, 'utf8')) as JsonReport;
    return { run: r.run, readiness: r.insights?.readiness, triage: r.insights?.triage, healProposals: r.insights?.healProposals };
  }
  return { run: JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunResult };
}

/** journeyId -> file (repository-relative) for every journey under `paths`. */
export async function journeyFileIndex(repoRoot: string, cwd: string, paths: string[]): Promise<Map<string, JourneyFileRef>> {
  const out = new Map<string, JourneyFileRef>();
  for (const f of await findJourneyFiles(paths, cwd)) {
    try {
      const j = await loadJourneyFile(f);
      out.set(j.id, { path: relative(repoRoot, f).split(sep).join('/'), text: await readFile(f, 'utf8'), steps: j.steps });
    } catch {
      // an unparsable journey has no result to annotate
    }
  }
  return out;
}

export type { JourneyResult };
