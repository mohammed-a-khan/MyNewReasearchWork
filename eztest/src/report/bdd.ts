/**
 * The feature / rule / scenario hierarchy of a run's Gherkin scenarios, for
 * the HTML and JSON reports, the JUnit report (one suite per feature) and the
 * Studio. Journeys that are not Gherkin scenarios are not part of it.
 */
import type { JourneyResult, JourneyStatus, RunResult, StepResult, StepStatus } from '../core/index.js';
import { escapeHtml as e } from './escape.js';

export interface BddStepEntry {
  keyword: string;
  text: string;
  line: number;
  status: StepStatus;
  /** definition, ez (EZTest phrasing), undefined, ambiguous. */
  match?: string;
  location?: string;
  durationMs: number;
  background?: boolean;
  error?: string;
}

export interface BddScenarioEntry {
  journeyId: string;
  name: string;
  keyword: string;
  line: number;
  status: JourneyStatus;
  durationMs: number;
  attempt: number;
  browser?: string;
  tags: string[];
  examples?: { name: string; line: number; row?: { line: number; index: number } };
  steps: BddStepEntry[];
  /** Before / After hooks that failed. */
  hookFailures: string[];
}

export interface BddRuleEntry {
  name: string;
  line: number;
  status: JourneyStatus;
  scenarios: BddScenarioEntry[];
}

export interface BddCounts {
  passed: number;
  passedHealed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface BddFeatureEntry {
  name: string;
  file: string;
  line: number;
  status: JourneyStatus;
  counts: BddCounts;
  durationMs: number;
  /** Scenarios directly under the feature (not in a rule). */
  scenarios: BddScenarioEntry[];
  rules: BddRuleEntry[];
}

export interface BddReport {
  features: BddFeatureEntry[];
  totals: { features: number; rules: number; scenarios: number; steps: number } & BddCounts;
}

const RANK: Record<JourneyStatus, number> = { passed: 0, 'passed-healed': 1, skipped: 2, failed: 3, error: 4 };

/** The worst status (an all-skipped group is skipped; passed and skipped together pass). */
export function worstStatus(list: JourneyStatus[]): JourneyStatus {
  if (!list.length) return 'skipped';
  if (list.every((s) => s === 'skipped')) return 'skipped';
  const bad = list.filter((s) => s === 'failed' || s === 'error');
  if (bad.length) return bad.includes('error') ? 'error' : 'failed';
  return list.reduce<JourneyStatus>((w, s) => (s !== 'skipped' && RANK[s] > RANK[w] ? s : w), 'passed');
}

const count = (js: Array<{ status: JourneyStatus }>): BddCounts => ({
  passed: js.filter((j) => j.status === 'passed').length,
  passedHealed: js.filter((j) => j.status === 'passed-healed').length,
  failed: js.filter((j) => j.status === 'failed').length,
  skipped: js.filter((j) => j.status === 'skipped').length,
  errors: js.filter((j) => j.status === 'error').length,
});

function stepEntry(s: StepResult): BddStepEntry {
  const g = s.gherkin!;
  return {
    keyword: g.keyword ?? '', text: g.text ?? s.intent, line: g.line, status: s.status, durationMs: s.durationMs,
    ...(g.match ? { match: g.match } : {}), ...(g.location ? { location: g.location } : {}), ...(g.background ? { background: true } : {}),
    ...(s.error && s.status !== 'skipped' ? { error: s.error.message.split('\n')[0] } : {}),
  };
}

function scenarioEntry(j: JourneyResult): BddScenarioEntry {
  const b = j.bdd!;
  const steps = j.steps.filter((s) => s.gherkin?.kind === 'step');
  return {
    journeyId: j.journeyId, name: j.name, keyword: b.scenario.keyword, line: b.examples?.row?.line ?? b.scenario.line, status: j.status, durationMs: j.durationMs,
    attempt: j.attempt, ...(j.browser ? { browser: j.browser } : {}), tags: j.tags, ...(b.examples ? { examples: b.examples } : {}),
    // Results that never ran (cancelled, no rows) have the journey's steps without Gherkin records.
    steps: steps.length ? steps.map(stepEntry) : j.steps.map((s) => ({ keyword: '', text: s.intent, line: 0, status: s.status, durationMs: s.durationMs })),
    hookFailures: j.steps.filter((s) => (s.gherkin && s.gherkin.kind !== 'step') && s.status === 'failed').map((s) => `${s.intent}: ${s.error?.message ?? 'failed'}`),
  };
}

/** The hierarchy of a run's Gherkin scenarios, features in file order; undefined when the run has none. */
export function bddHierarchy(run: RunResult): BddReport | undefined {
  const js = run.journeys.filter((j) => j.bdd);
  if (!js.length) return undefined;
  const features = new Map<string, BddFeatureEntry>();
  for (const j of js) {
    const b = j.bdd!;
    let f = features.get(b.file);
    if (!f) {
      f = { name: b.feature.name, file: b.file, line: b.feature.line, status: 'passed', counts: count([]), durationMs: 0, scenarios: [], rules: [] };
      features.set(b.file, f);
    }
    const sc = scenarioEntry(j);
    if (b.rule) {
      let r = f.rules.find((x) => x.line === b.rule!.line);
      if (!r) f.rules.push((r = { name: b.rule.name, line: b.rule.line, status: 'passed', scenarios: [] }));
      r.scenarios.push(sc);
    } else f.scenarios.push(sc);
  }
  const out = [...features.values()].sort((a, b) => a.file.localeCompare(b.file));
  for (const f of out) {
    const byLine = (a: BddScenarioEntry, b: BddScenarioEntry) => a.line - b.line || a.journeyId.localeCompare(b.journeyId);
    f.scenarios.sort(byLine);
    f.rules.sort((a, b) => a.line - b.line);
    for (const r of f.rules) {
      r.scenarios.sort(byLine);
      r.status = worstStatus(r.scenarios.map((s) => s.status));
    }
    const all = [...f.scenarios, ...f.rules.flatMap((r) => r.scenarios)];
    f.status = worstStatus(all.map((s) => s.status));
    f.counts = count(all);
    f.durationMs = all.reduce((n, s) => n + s.durationMs, 0);
  }
  const scenarios = out.flatMap((f) => [...f.scenarios, ...f.rules.flatMap((r) => r.scenarios)]);
  return {
    features: out,
    totals: { features: out.length, rules: out.reduce((n, f) => n + f.rules.length, 0), scenarios: scenarios.length, steps: scenarios.reduce((n, s) => n + s.steps.length, 0), ...count(scenarios) },
  };
}

/** A compact feature / rule table (counts only), for reports too large to list every step. */
export function bddSummaryHtml(run: RunResult): string {
  const h = bddHierarchy(run);
  if (!h) return '';
  const row = (name: string, file: string, status: JourneyStatus, c: BddCounts, depth: number) =>
    `<tr><td${depth ? ' style="padding-left:1.5rem"' : ''}>${e(name)}</td><td><code>${e(file)}</code></td><td>${e(status)}</td><td>${e(c.passed + c.passedHealed)}</td><td>${e(c.failed + c.errors)}</td><td>${e(c.skipped)}</td></tr>`;
  const rows = h.features.flatMap((f) => [
    row(f.name || f.file, f.file, f.status, f.counts, 0),
    ...f.rules.map((r) => row(`Rule: ${r.name}`, `${f.file}:${r.line}`, r.status, count(r.scenarios), 1)),
  ]);
  return `<section aria-labelledby="bdd-h"><h2 id="bdd-h">Features</h2><table class="static"><caption>${e(h.totals.features)} feature(s), ${e(h.totals.scenarios)} scenario(s); every scenario is in the list below and in report.json (bdd)</caption><thead><tr><th scope="col">Feature / rule</th><th scope="col">File</th><th scope="col">Status</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Skipped</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
}
