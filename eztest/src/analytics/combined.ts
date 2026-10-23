/**
 * One coverage view: UI elements, requirements, API operations, risk and
 * changed code, plus manual verification, each as covered / total with its
 * gaps, so a release reviewer sees every dimension of "what did we test" in
 * one place (Studio Quality › Coverage, `eztest coverage`).
 */
import type { JourneyStatus } from '../core/index.js';
import type { ApiCoverageReport } from '../contracts/coverage.js';
import type { ImpactResult } from '../insights/impact.js';
import type { TraceabilityMatrix } from '../insights/traceability.js';
import type { UiCoverageReport } from './ui-coverage.js';

export type CoverageDimensionId = 'ui' | 'requirements' | 'api' | 'risk' | 'change' | 'manual';

export interface CoverageGap {
  id: string;
  text: string;
  link?: string;
}

export interface CoverageDimension {
  id: CoverageDimensionId;
  label: string;
  covered: number;
  total: number;
  /** covered / total (0..1); undefined without data. */
  ratio?: number;
  status: 'ok' | 'warn' | 'bad' | 'no-data';
  detail: string;
  gaps: CoverageGap[];
}

export interface CombinedCoverage {
  generatedAt: string;
  dimensions: CoverageDimension[];
  /** Mean of the dimensions that have data. */
  overall?: number;
}

export interface JourneyLatest {
  id: string;
  name?: string;
  risk: number;
  status?: JourneyStatus | 'not-run';
  type?: 'automated' | 'manual' | 'hybrid';
  /** Manual steps without a verdict in the latest result. */
  manualPending?: number;
  manualSteps?: number;
}

export interface CombinedCoverageInput {
  ui?: UiCoverageReport;
  traceability?: TraceabilityMatrix;
  api?: ApiCoverageReport[];
  journeys?: JourneyLatest[];
  impact?: ImpactResult;
  /** Thresholds for ok / warn (default 0.8 / 0.5). */
  thresholds?: { ok?: number; warn?: number };
}

const PASS = (s?: string) => s === 'passed' || s === 'passed-healed';
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

export function combineCoverage(input: CombinedCoverageInput): CombinedCoverage {
  const ok = input.thresholds?.ok ?? 0.8;
  const warn = input.thresholds?.warn ?? 0.5;
  const tone = (r: number | undefined): CoverageDimension['status'] => (r === undefined ? 'no-data' : r >= ok ? 'ok' : r >= warn ? 'warn' : 'bad');
  const dim = (id: CoverageDimensionId, label: string, covered: number, total: number, detail: string, gaps: CoverageGap[], hasData = total > 0): CoverageDimension => {
    const ratio = hasData ? (total ? covered / total : 1) : undefined;
    return { id, label, covered, total, ...(ratio !== undefined ? { ratio } : {}), status: tone(ratio), detail, gaps };
  };
  const out: CoverageDimension[] = [];

  const ui = input.ui;
  out.push(ui && ui.totals.elements
    ? dim('ui', 'UI elements', ui.totals.tested, ui.totals.elements, `${ui.totals.tested}/${ui.totals.elements} interactive elements on ${ui.totals.pages} page(s) were interacted with or asserted (${pct(ui.totals.percent)}); ${ui.unvisitedLinks.length} link target(s) never visited.`,
      ui.pages.flatMap((p) => p.elements.filter((e) => !e.tested).map((e) => ({ id: `${p.route} ${e.role} ${e.label}`, text: `${e.role} "${e.label}" on ${p.route} is untested`, link: `#/quality/coverage/ui?page=${encodeURIComponent(p.route)}` }))).slice(0, 200))
    : dim('ui', 'UI elements', 0, 0, 'No DOM snapshots: enable trace.timeTravel so runs record the pages they visit.', []));

  const t = input.traceability;
  if (t && t.totals.requirements) {
    const covered = t.rows.filter((r) => r.coverage === 'covered-passing' || r.coverage === 'covered-healed').length;
    out.push(dim('requirements', 'Requirements', covered, t.totals.requirements, `${covered}/${t.totals.requirements} requirements have a passing journey (${pct(t.totals.coveragePct)}); ${t.untracedJourneys.length} journey(s) trace to no requirement.`,
      t.rows.filter((r) => r.coverage !== 'covered-passing' && r.coverage !== 'covered-healed').map((r) => ({ id: r.requirement.id, text: `${r.requirement.id}${r.requirement.title ? ` ${r.requirement.title}` : ''}: ${r.gap ?? r.coverage}`, link: '#/quality/traceability' }))));
  } else out.push(dim('requirements', 'Requirements', 0, 0, 'No requirements: add Requirements: headers to journeys or load a requirements list.', []));

  const api = input.api ?? [];
  if (api.length) {
    const total = api.reduce((n, r) => n + r.totals.operations, 0);
    const covered = api.reduce((n, r) => n + r.totals.coveredOperations, 0);
    out.push(dim('api', 'API operations', covered, total, api.map((r) => `${r.spec.title || r.spec.file}: ${r.totals.coveredOperations}/${r.totals.operations} operations, ${pct(r.totals.statusRatio)} of status codes, ${r.totals.violations} violation(s)`).join('; '),
      api.flatMap((r) => r.operations.filter((o) => !o.covered).map((o) => ({ id: o.id, text: `${o.method.toUpperCase()} ${o.path} (${o.id}) never called` })))));
  } else out.push(dim('api', 'API operations', 0, 0, 'No API coverage recorded: configure api.spec and run API steps.', []));

  const js = input.journeys ?? [];
  if (js.length) {
    const weight = js.reduce((n, j) => n + j.risk, 0);
    const earned = js.reduce((n, j) => n + (PASS(j.status) ? j.risk : 0), 0);
    const gaps = js.filter((j) => !PASS(j.status)).sort((a, b) => b.risk - a.risk).map((j) => ({ id: j.id, text: `risk ${j.risk}: ${j.name ?? j.id} ${j.status === 'not-run' || !j.status ? 'has not run' : j.status}`, link: `#/journeys` }));
    out.push(dim('risk', 'Risk-weighted', earned, weight, `${earned}/${weight} risk points covered by passing journeys (${pct(weight ? earned / weight : 0)}) over ${js.length} journey(s).`, gaps));
    const manualJs = js.filter((j) => j.type === 'manual' || j.type === 'hybrid');
    if (manualJs.length) {
      const steps = manualJs.reduce((n, j) => n + (j.manualSteps ?? 0), 0);
      const done = manualJs.reduce((n, j) => n + Math.max(0, (j.manualSteps ?? 0) - (j.manualPending ?? j.manualSteps ?? 0)), 0);
      out.push(dim('manual', 'Manual verification', done, steps, `${done}/${steps} manual steps of ${manualJs.length} manual or hybrid case(s) have a tester's verdict in their latest result.`,
        manualJs.filter((j) => (j.manualPending ?? j.manualSteps ?? 0) > 0).map((j) => ({ id: j.id, text: `${j.name ?? j.id}: ${j.manualPending ?? j.manualSteps} manual step(s) without a verdict`, link: '#/manual/cases' }))));
    }
  } else out.push(dim('risk', 'Risk-weighted', 0, 0, 'No journeys.', []));

  const im = input.impact;
  if (im) {
    const relevant = im.changedFiles.filter((f) => !im.ignoredFiles.includes(f));
    const status = new Map(js.map((j) => [j.id, j.status]));
    const coveredFiles = relevant.filter((f) => im.impacted.some((j) => j.via.some((v) => v.file === f) && PASS(status.get(j.journeyId))));
    out.push(dim('change', 'Changed code', coveredFiles.length, relevant.length, `${coveredFiles.length}/${relevant.length} changed file(s) are covered by an impacted journey that passed; ${im.uncovered.length} have no mapping or no journey.`,
      relevant.filter((f) => !coveredFiles.includes(f)).map((f) => {
        const u = im.uncovered.find((x) => x.file === f);
        return { id: f, text: `${f}: ${u ? (u.reason === 'no-mapping' ? 'no impact mapping covers it' : 'its mapping selects no journey') : 'impacted journeys did not pass'}` };
      }), true));
  } else out.push(dim('change', 'Changed code', 0, 0, 'No change data: configure selection.impactMapping and a base branch (vcs) to compare against.', []));

  const withData = out.filter((d) => d.ratio !== undefined);
  return {
    generatedAt: new Date().toISOString(),
    dimensions: out,
    ...(withData.length ? { overall: withData.reduce((n, d) => n + d.ratio!, 0) / withData.length } : {}),
  };
}

export function combinedCoverageText(c: CombinedCoverage): string {
  const lines = ['Coverage', ''];
  for (const d of c.dimensions) {
    lines.push(`${d.label.padEnd(20)} ${d.ratio === undefined ? 'no data'.padEnd(9) : pct(d.ratio).padEnd(9)} ${d.total ? `${d.covered}/${d.total}`.padEnd(12) : ''.padEnd(12)} ${d.detail}`);
  }
  if (c.overall !== undefined) lines.push('', `Overall (mean of dimensions with data): ${pct(c.overall)}`);
  return lines.join('\n');
}
