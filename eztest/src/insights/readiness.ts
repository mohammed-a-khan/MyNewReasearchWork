/**
 * Release readiness: policy-as-code (YAML) gates evaluated over a run and its
 * insights, producing GO / GO_WITH_RISKS / NO_GO with a risk-weighted score.
 * Every rationale entry cites evidence ids, journey ids or requirement ids
 * that exist; citations are validated before the decision is returned.
 * Exceptions (waivers) need a named approver and are recorded in the result.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { EvidenceRef, JourneyResult, RunResult } from '../core/index.js';
import { EzTestError, summarize } from '../core/index.js';
import type { TriageReport } from './triage.js';
import type { FlakyScore } from './flaky.js';
import { evaluateApiCoverageGate, evaluateContractsGate, type ApiCoverageGateInput, type ContractsGateInput } from '../contracts/readiness.js';
import { evaluateLoadGate, type LoadGateInput } from '../load/readiness.js';
import { evaluateApiSecurityGate, type ApiSecurityGateInput } from '../lenses/security-api.js';

const Severity = z.enum(['blocker', 'risk']);
type Severity = z.infer<typeof Severity>;

const gate = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ enabled: z.boolean().default(true), severity: Severity.optional(), ...shape });

const GatesSchema = z.strictObject({
  noFailedCriticalJourneys: z
    .union([z.boolean(), gate({ minRisk: z.number().int().min(1).max(5).default(4), tags: z.array(z.string()).default(['@critical']) })])
    .optional(),
  maxHealedRatio: z.union([z.number().min(0).max(1), gate({ max: z.number().min(0).max(1) })]).optional(),
  minPassRate: z
    .union([z.number().min(0).max(1), gate({ min: z.number().min(0).max(1), countHealedAsPass: z.boolean().default(true) })])
    .optional(),
  noOpenProductBugs: z.union([z.boolean(), gate({})]).optional(),
  perfBudgets: z.union([z.boolean(), gate({ allowWarnings: z.boolean().default(true) })]).optional(),
  a11yNoCritical: z.union([z.boolean(), gate({ impacts: z.array(z.string()).default(['critical']) })]).optional(),
  docsReconciled: z.union([z.boolean(), gate({})]).optional(),
  requirementsCovered: z.union([z.boolean(), gate({ requirements: z.array(z.string()).optional() })]).optional(),
  /** Share of spec operations (and optionally status codes) exercised, and no contract violations (api.spec). */
  apiCoverage: z
    .union([z.number().min(0).max(1), gate({ minOperations: z.number().min(0).max(1).default(0.8), minStatusCodes: z.number().min(0).max(1).optional(), noViolations: z.boolean().default(true) })])
    .optional(),
  /** Contract verification passed and the results server's can-release says yes (eztest contracts verify|can-release --run). */
  contracts: z.union([z.boolean(), gate({})]).optional(),
  /** EZTest Load: the load test's SLAs held (and no regression against its baseline beyond maxRegressions). */
  load: z.union([z.boolean(), gate({ allowWarnings: z.boolean().default(true), maxRegressions: z.number().int().min(0).default(0) })]).optional(),
  /** No API security findings at or above `failOn` (eztest api-scan --readiness). */
  apiSecurity: z.union([z.boolean(), gate({ failOn: z.enum(['info', 'low', 'medium', 'high']).default('medium') })]).optional(),
  /** Share of interactive UI elements (trace snapshots) the run interacted with or asserted on: `uiCoverage: 0.6` or `{ min, minPerPage, pages }`. */
  uiCoverage: z
    .union([z.number().min(0).max(1), gate({ min: z.number().min(0).max(1).default(0.8), minPerPage: z.number().min(0).max(1).optional(), pages: z.array(z.string()).optional() })])
    .optional(),
  /** No journey fails for the first time in its recent history (new-failure tag), nor regressed since its last run. */
  noNewFailures: z.union([z.boolean(), gate({ includeRegressed: z.boolean().default(true) })]).optional(),
  /** Every manual step of the run's manual and hybrid journeys has a tester's verdict. */
  manualVerified: z.union([z.boolean(), gate({})]).optional(),
  /** No accessibility issue that the previous scanned run did not have. */
  a11yNoNewViolations: z.union([z.boolean(), gate({})]).optional(),
});

const ExceptionSchema = z.strictObject({
  gate: z.string().min(1),
  approver: z.string().trim().min(1, 'exceptions require a named approver'),
  reason: z.string().trim().min(1),
  journeys: z.array(z.string()).optional(),
  expires: z.string().optional(),
});

export const ReadinessPolicySchema = z.strictObject({
  version: z.literal(1).default(1),
  gates: GatesSchema,
  scoring: z
    .strictObject({
      goMinScore: z.number().min(0).max(100).default(90),
      noGoBelowScore: z.number().min(0).max(100).default(50),
      healedPassCredit: z.number().min(0).max(1).default(0.8),
      blockerPenalty: z.number().min(0).default(30),
      riskPenalty: z.number().min(0).default(10),
      waivedPenalty: z.number().min(0).default(5),
    })
    .default({ goMinScore: 90, noGoBelowScore: 50, healedPassCredit: 0.8, blockerPenalty: 30, riskPenalty: 10, waivedPenalty: 5 }),
  exceptions: z.array(ExceptionSchema).default([]),
});
export type ReadinessPolicy = z.infer<typeof ReadinessPolicySchema>;
export type ReadinessException = z.infer<typeof ExceptionSchema>;
export type GateName = keyof z.infer<typeof GatesSchema>;

export const GATE_NAMES: GateName[] = [
  'noFailedCriticalJourneys',
  'maxHealedRatio',
  'minPassRate',
  'noOpenProductBugs',
  'perfBudgets',
  'a11yNoCritical',
  'docsReconciled',
  'requirementsCovered',
  'apiCoverage',
  'contracts',
  'load',
  'apiSecurity',
  'uiCoverage',
  'noNewFailures',
  'manualVerified',
  'a11yNoNewViolations',
];

const DEFAULT_SEVERITY: Record<GateName, Severity> = {
  noFailedCriticalJourneys: 'blocker',
  maxHealedRatio: 'risk',
  minPassRate: 'blocker',
  noOpenProductBugs: 'blocker',
  perfBudgets: 'risk',
  a11yNoCritical: 'risk',
  docsReconciled: 'risk',
  requirementsCovered: 'risk',
  apiCoverage: 'risk',
  contracts: 'blocker',
  load: 'blocker',
  apiSecurity: 'blocker',
  uiCoverage: 'risk',
  noNewFailures: 'risk',
  manualVerified: 'blocker',
  a11yNoNewViolations: 'risk',
};

export function parseReadinessPolicy(input: string | unknown): ReadinessPolicy {
  const raw = typeof input === 'string' ? parseYaml(input) : input;
  const r = ReadinessPolicySchema.safeParse(raw);
  if (!r.success) {
    throw new EzTestError(
      `Invalid readiness policy: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      'POLICY_INVALID',
    );
  }
  for (const ex of r.data.exceptions) {
    if (!(GATE_NAMES as string[]).includes(ex.gate)) throw new EzTestError(`Exception for unknown gate ${ex.gate}`, 'POLICY_INVALID');
  }
  if (Object.keys(r.data.gates).length === 0) throw new EzTestError('Readiness policy defines no gates', 'POLICY_INVALID');
  return r.data;
}

export async function loadReadinessPolicy(path: string): Promise<ReadinessPolicy> {
  return parseReadinessPolicy(await readFile(path, 'utf8'));
}

// --------------------------------------------------------------- inputs

export interface PerfGateItem {
  metric: string;
  status: 'pass' | 'warn' | 'fail' | 'no-data';
  value?: number;
  journeyId?: string;
  evidence?: string[];
}
export interface A11yGateItem {
  ruleId: string;
  impact: string | null | undefined;
  journeyId?: string;
  evidence?: string[];
}
export interface DocsGateInput {
  reconciled: boolean;
  mismatches?: Array<{ description: string; evidence?: string[]; journeyId?: string }>;
  evidence?: string[];
}
export interface OpenBug {
  id: string;
  title?: string;
  journeyId?: string;
  evidence?: string[];
}

export interface ReadinessInput {
  run: RunResult;
  /** Evidence manifest; every cited evidence id must be in it. */
  evidence: EvidenceRef[];
  triage?: TriageReport;
  flaky?: FlakyScore[];
  perf?: PerfGateItem[];
  a11y?: A11yGateItem[];
  docs?: DocsGateInput;
  openBugs?: OpenBug[];
  /** Overrides/extends policy requirement list. */
  requirements?: string[];
  /** API coverage per spec (api-coverage.json of the run). */
  apiCoverage?: ApiCoverageGateInput[];
  /** Contract verification and can-release results (contracts-results.json of the run). */
  contracts?: ContractsGateInput;
  /** Load test results (load-results.json of the run, or of a load run directory). */
  load?: LoadGateInput[];
  /** API security scan report of the run (api-security.json). */
  apiSecurity?: ApiSecurityGateInput;
  /** UI coverage of the run (ui-coverage.json) with the evidence id it was recorded under. */
  uiCoverage?: UiCoverageGateInput;
  /** Smart failure tags of the run's journeys (insights/failure-tags.ts). */
  failureTags?: Array<{ journeyId: string; tags: string[] }>;
  /** Accessibility issues new since the previous scanned run (coverage/a11y-trends.ts). */
  a11yNew?: Array<{ ruleId: string; route?: string; target?: string; journeys: string[]; evidence: string[] }>;
  /** Clock for exception expiry (tests). */
  now?: Date;
  /**
   * Journey ids under an active quarantine. Their failures (and triage verdicts) are
   * excluded from every gate and from the score, and listed in `quarantineIgnored`.
   */
  quarantined?: string[];
}

export interface UiCoverageGateInput {
  percent: number;
  tested: number;
  total: number;
  pages: Array<{ route: string; percent: number; tested: number; total: number; journeys: string[] }>;
  evidence: string[];
}

// --------------------------------------------------------------- outputs

export interface Citations {
  evidence: string[];
  journeys: string[];
  requirements: string[];
}

export interface RationaleItem {
  gate?: GateName;
  kind: 'violation' | 'waived' | 'missing-input' | 'info' | 'pass';
  text: string;
  cites: Citations;
}

export type GateStatus = 'pass' | 'fail' | 'waived' | 'no-data';

export interface GateResult {
  gate: GateName;
  severity: Severity;
  status: GateStatus;
  summary: string;
  cites: Citations;
  exception?: ReadinessException & { recordedAt: string };
}

export type ReadinessDecision = 'GO' | 'GO_WITH_RISKS' | 'NO_GO';

export interface ReadinessResult {
  decision: ReadinessDecision;
  score: number;
  runId: string;
  gates: GateResult[];
  rationale: RationaleItem[];
  exceptionsApplied: Array<ReadinessException & { recordedAt: string }>;
  exceptionsIgnored: Array<ReadinessException & { why: string }>;
  evaluatedAt: string;
  /** Quarantined journeys whose failures were not counted. */
  quarantineIgnored?: string[];
  /**
   * Cross-browser runs: the decision for each browser's units alone (the top-level decision is all
   * browsers combined). A browser-only failure shows as a NO_GO on that browser.
   */
  browsers?: Record<string, BrowserReadiness>;
}

export interface BrowserReadiness {
  decision: ReadinessDecision;
  score: number;
  /** Units that failed or errored on this browser. */
  failed: string[];
}

/**
 * Readiness of each browser of a cross-browser run (RunResult.browsers): the policy evaluated on that
 * browser's units only, with the triage verdicts and flaky scores of those units.
 */
export function readinessByBrowser(policy: ReadinessPolicy | string, input: ReadinessInput): Record<string, BrowserReadiness> | undefined {
  const names = Object.keys(input.run.browsers ?? {});
  if (names.length < 2) return undefined;
  const out: Record<string, BrowserReadiness> = {};
  for (const b of names) {
    const journeys = input.run.journeys.filter((j) => j.browser === b);
    if (!journeys.length) continue;
    const ids = new Set(journeys.map((j) => j.journeyId));
    const run = { ...input.run, journeys, summary: summarize(journeys) };
    const r = evaluateReadiness(policy, {
      ...input, run,
      ...(input.triage ? { triage: { ...input.triage, verdicts: input.triage.verdicts.filter((v) => ids.has(v.journeyId)) } } : {}),
      ...(input.flaky ? { flaky: input.flaky.filter((f) => ids.has(f.journeyId)) } : {}),
    });
    out[b] = { decision: r.decision, score: r.score, failed: journeys.filter((j) => j.status === 'failed' || j.status === 'error').map((j) => j.journeyId) };
  }
  return out;
}

const cites = (c: Partial<Citations> = {}): Citations => ({
  evidence: [...new Set(c.evidence ?? [])],
  journeys: [...new Set(c.journeys ?? [])],
  requirements: [...new Set(c.requirements ?? [])],
});

function journeyEvidence(j: JourneyResult, known: Set<string>): string[] {
  const failing = j.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
  const ids = [...(failing?.evidence ?? []), ...j.evidence];
  return ids.filter((x) => known.has(x)).slice(0, 5);
}

function gateConfig(policy: ReadinessPolicy, name: GateName): Record<string, unknown> | undefined {
  const g = policy.gates[name] as unknown;
  if (g === undefined || g === false) return undefined;
  if (g === true) return { enabled: true };
  if (typeof g === 'number') {
    if (name === 'maxHealedRatio') return { enabled: true, max: g };
    if (name === 'minPassRate') return { enabled: true, min: g, countHealedAsPass: true };
    if (name === 'apiCoverage') return { enabled: true, minOperations: g, noViolations: true };
    if (name === 'uiCoverage') return { enabled: true, min: g };
  }
  const obj = g as Record<string, unknown>;
  return obj.enabled === false ? undefined : obj;
}

export function evaluateReadiness(policyIn: ReadinessPolicy | string, inputIn: ReadinessInput): ReadinessResult {
  const policy = typeof policyIn === 'string' ? parseReadinessPolicy(policyIn) : parseReadinessPolicy(policyIn);
  let input = inputIn;
  if (!input.run || !Array.isArray(input.run.journeys)) throw new EzTestError('evaluateReadiness requires a RunResult', 'INVALID_INPUT');
  assertCitable(input);
  // Quarantine: failures of quarantined journeys neither fail gates nor lower the score.
  const quarantine = new Set(input.quarantined ?? []);
  const ignored = input.run.journeys.filter((j) => quarantine.has(j.journeyId) && (j.status === 'failed' || j.status === 'error'));
  const ignoredIds = new Set(ignored.map((j) => j.journeyId));
  const run: RunResult = ignored.length ? { ...input.run, journeys: input.run.journeys.filter((j) => !ignoredIds.has(j.journeyId)) } : input.run;
  if (ignored.length && input.triage) {
    input = { ...input, triage: { ...input.triage, verdicts: input.triage.verdicts.filter((v) => !ignoredIds.has(v.journeyId)) } };
  }
  const now = input.now ?? new Date();
  const known = new Set(input.evidence.map((e) => e.id));
  const journeyIds = new Set(run.journeys.map((j) => j.journeyId));
  const executed = run.journeys.filter((j) => j.status !== 'skipped');
  const gates: GateResult[] = [];
  const rationale: RationaleItem[] = [];

  const push = (name: GateName, cfg: Record<string, unknown>, status: GateStatus, summary: string, c: Citations, details: RationaleItem[] = []) => {
    const severity = (cfg.severity as Severity | undefined) ?? DEFAULT_SEVERITY[name];
    gates.push({ gate: name, severity, status, summary, cites: c });
    if (details.length) rationale.push(...details);
    else
      rationale.push({
        gate: name,
        kind: status === 'pass' ? 'pass' : status === 'no-data' ? 'missing-input' : 'violation',
        text: summary,
        cites: c,
      });
  };

  if (ignored.length) {
    rationale.push({
      kind: 'info',
      text: `${ignored.length} quarantined journey failure(s) not counted: ${ignored.map((j) => j.journeyId).join(', ')}.`,
      cites: cites({ journeys: ignored.map((j) => j.journeyId) }),
    });
  }
  if (run.journeys.length === 0 || executed.length === 0) {
    rationale.push({ kind: 'missing-input', text: 'The run executed no journeys; readiness cannot be established.', cites: cites() });
  }

  for (const name of GATE_NAMES) {
    const cfg = gateConfig(policy, name);
    if (!cfg) continue;
    switch (name) {
      case 'noFailedCriticalJourneys': {
        const minRisk = (cfg.minRisk as number | undefined) ?? 4;
        const tags = (cfg.tags as string[] | undefined) ?? ['@critical'];
        const critical = run.journeys.filter((j) => j.risk >= minRisk || j.tags.some((t) => tags.includes(t)));
        if (critical.length === 0) {
          push(name, cfg, 'no-data', `No critical journeys (risk >= ${minRisk} or tagged ${tags.join('/')}) were in the run.`, cites());
          break;
        }
        const bad = critical.filter((j) => j.status === 'failed' || j.status === 'error' || j.status === 'skipped');
        if (bad.length === 0) {
          push(name, cfg, 'pass', `All ${critical.length} critical journeys passed.`, cites({ journeys: critical.map((j) => j.journeyId) }));
        } else {
          push(
            name,
            cfg,
            'fail',
            `${bad.length} critical journey(s) did not pass.`,
            cites({ journeys: bad.map((j) => j.journeyId), evidence: bad.flatMap((j) => journeyEvidence(j, known)) }),
            bad.map((j) => ({
              gate: name,
              kind: 'violation' as const,
              text: `Critical journey "${j.name}" (risk ${j.risk}) ${j.status}${j.error ? `: ${j.error.message.slice(0, 160)}` : ''}.`,
              cites: cites({ journeys: [j.journeyId], evidence: journeyEvidence(j, known) }),
            })),
          );
        }
        break;
      }
      case 'maxHealedRatio': {
        const max = cfg.max as number;
        const passes = executed.filter((j) => j.status === 'passed' || j.status === 'passed-healed');
        const healed = passes.filter((j) => j.status === 'passed-healed');
        if (passes.length === 0) {
          push(name, cfg, 'no-data', 'No passing journeys to compute a healed ratio.', cites());
          break;
        }
        const ratio = healed.length / passes.length;
        const healEv = healed.flatMap((j) => j.steps.flatMap((s) => s.heal?.evidence ?? []).filter((x) => known.has(x)));
        push(
          name,
          cfg,
          ratio <= max ? 'pass' : 'fail',
          `Healed ratio ${(ratio * 100).toFixed(1)}% (${healed.length}/${passes.length}) vs max ${(max * 100).toFixed(1)}%.`,
          cites({ journeys: (healed.length ? healed : passes).map((j) => j.journeyId), evidence: healEv }),
        );
        break;
      }
      case 'minPassRate': {
        const min = cfg.min as number;
        if (executed.length === 0) {
          push(name, cfg, 'no-data', 'No executed journeys; pass rate undefined.', cites());
          break;
        }
        const countHealed = (cfg.countHealedAsPass as boolean | undefined) ?? true;
        const ok = executed.filter((j) => j.status === 'passed' || (countHealed && j.status === 'passed-healed'));
        const notOk = executed.filter((j) => !ok.includes(j));
        const rate = ok.length / executed.length;
        push(
          name,
          cfg,
          rate >= min ? 'pass' : 'fail',
          `Pass rate ${(rate * 100).toFixed(1)}% (${ok.length}/${executed.length}) vs min ${(min * 100).toFixed(1)}%.`,
          cites({
            journeys: (notOk.length ? notOk : ok).map((j) => j.journeyId),
            evidence: notOk.flatMap((j) => journeyEvidence(j, known)),
          }),
        );
        break;
      }
      case 'noOpenProductBugs': {
        if (!input.triage && !input.openBugs) {
          push(name, cfg, 'no-data', 'Neither triage results nor an open bug list were supplied.', cites());
          break;
        }
        const fromTriage = (input.triage?.verdicts ?? []).filter((v) => v.category === 'product-bug');
        const bugs = input.openBugs ?? [];
        if (fromTriage.length === 0 && bugs.length === 0) {
          push(name, cfg, 'pass', 'No product bugs found by triage and none open.', cites({ journeys: [...journeyIds].slice(0, 20) }));
          break;
        }
        const details: RationaleItem[] = [
          ...fromTriage.map((v) => ({
            gate: name,
            kind: 'violation' as const,
            text: `Triage classifies "${v.journeyName}" as a product bug (${(v.confidence * 100).toFixed(0)}%): ${v.reasons[0] ?? ''}`,
            cites: cites({ journeys: [v.journeyId], evidence: v.evidence.filter((x) => known.has(x)) }),
          })),
          ...bugs.map((b) => ({
            gate: name,
            kind: 'violation' as const,
            text: `Open product bug ${b.id}${b.title ? `: ${b.title}` : ''}.`,
            cites: cites({
              journeys: b.journeyId && journeyIds.has(b.journeyId) ? [b.journeyId] : [],
              evidence: (b.evidence ?? []).filter((x) => known.has(x)),
            }),
          })),
        ];
        push(
          name,
          cfg,
          'fail',
          `${fromTriage.length + bugs.length} open product bug(s).`,
          cites({ journeys: details.flatMap((d) => d.cites.journeys), evidence: details.flatMap((d) => d.cites.evidence) }),
          details,
        );
        break;
      }
      case 'perfBudgets': {
        const items = input.perf ?? [];
        if (items.length === 0) {
          push(name, cfg, 'no-data', 'No performance budget results were supplied.', cites());
          break;
        }
        const allowWarnings = (cfg.allowWarnings as boolean | undefined) ?? true;
        const bad = items.filter((p) => p.status === 'fail' || p.status === 'no-data' || (!allowWarnings && p.status === 'warn'));
        const c = (ps: PerfGateItem[]) =>
          cites({
            journeys: ps.map((p) => p.journeyId).filter((x): x is string => !!x && journeyIds.has(x)),
            evidence: ps.flatMap((p) => p.evidence ?? []).filter((x) => known.has(x)),
          });
        if (bad.length === 0) push(name, cfg, 'pass', `All ${items.length} performance budgets met.`, c(items));
        else
          push(
            name,
            cfg,
            'fail',
            `${bad.length} performance budget(s) exceeded or unmeasured.`,
            c(bad),
            bad.map((p) => ({
              gate: name,
              kind: 'violation' as const,
              text: `${p.metric} ${p.status}${p.value !== undefined ? ` (${p.value})` : ''}${p.journeyId ? ` in ${p.journeyId}` : ''}.`,
              cites: c([p]),
            })),
          );
        break;
      }
      case 'a11yNoCritical': {
        if (!input.a11y) {
          push(name, cfg, 'no-data', 'No accessibility scan results were supplied.', cites());
          break;
        }
        const impacts = (cfg.impacts as string[] | undefined) ?? ['critical'];
        const bad = input.a11y.filter((f) => f.impact && impacts.includes(f.impact));
        const c = (fs: A11yGateItem[]) =>
          cites({
            journeys: fs.map((f) => f.journeyId).filter((x): x is string => !!x && journeyIds.has(x)),
            evidence: fs.flatMap((f) => f.evidence ?? []).filter((x) => known.has(x)),
          });
        if (bad.length === 0) push(name, cfg, 'pass', `No ${impacts.join('/')} accessibility violations.`, c(input.a11y));
        else {
          const rules = [...new Set(bad.map((b) => b.ruleId))];
          push(name, cfg, 'fail', `${bad.length} ${impacts.join('/')} accessibility violation(s): ${rules.join(', ')}.`, c(bad));
        }
        break;
      }
      case 'docsReconciled': {
        if (!input.docs) {
          push(name, cfg, 'no-data', 'No document reconciliation result was supplied.', cites());
          break;
        }
        const d = input.docs;
        const ev = [...(d.evidence ?? []), ...(d.mismatches ?? []).flatMap((m) => m.evidence ?? [])].filter((x) => known.has(x));
        const js = (d.mismatches ?? []).map((m) => m.journeyId).filter((x): x is string => !!x && journeyIds.has(x));
        if (d.reconciled && (d.mismatches ?? []).length === 0) push(name, cfg, 'pass', 'Documents reconciled.', cites({ evidence: ev, journeys: js }));
        else
          push(
            name,
            cfg,
            'fail',
            `Documents not reconciled: ${(d.mismatches ?? []).map((m) => m.description).join('; ') || 'reconciliation failed'}.`,
            cites({ evidence: ev, journeys: js }),
          );
        break;
      }
      case 'requirementsCovered': {
        const required = [...new Set([...((cfg.requirements as string[] | undefined) ?? []), ...(input.requirements ?? [])])];
        if (required.length === 0) {
          push(name, cfg, 'no-data', 'No required requirement ids were configured or supplied.', cites());
          break;
        }
        const uncovered: string[] = [];
        const covering: string[] = [];
        for (const r of required) {
          const js = run.journeys.filter((j) => j.requirements.includes(r) && (j.status === 'passed' || j.status === 'passed-healed'));
          if (js.length === 0) uncovered.push(r);
          else covering.push(...js.map((j) => j.journeyId));
        }
        if (uncovered.length === 0)
          push(name, cfg, 'pass', `All ${required.length} requirements covered by passing journeys.`, cites({ requirements: required, journeys: covering }));
        else
          push(
            name,
            cfg,
            'fail',
            `${uncovered.length}/${required.length} requirement(s) lack a passing journey: ${uncovered.join(', ')}.`,
            cites({
              requirements: uncovered,
              journeys: run.journeys.filter((j) => j.requirements.some((r) => uncovered.includes(r))).map((j) => j.journeyId),
            }),
          );
        break;
      }
      case 'uiCoverage': {
        const u = input.uiCoverage;
        if (!u || !u.total) {
          push(name, cfg, 'no-data', 'No UI coverage was recorded (enable trace.timeTravel so runs keep DOM snapshots).', cites());
          break;
        }
        const min = (cfg.min as number | undefined) ?? 0.8;
        const perPage = cfg.minPerPage as number | undefined;
        const only = cfg.pages as string[] | undefined;
        const pages = only?.length ? u.pages.filter((p) => only.includes(p.route)) : u.pages;
        const scoped = only?.length ? { tested: pages.reduce((n, p) => n + p.tested, 0), total: pages.reduce((n, p) => n + p.total, 0) } : { tested: u.tested, total: u.total };
        const ratio = scoped.total ? scoped.tested / scoped.total : 0;
        const lowPages = perPage !== undefined ? pages.filter((p) => p.total && p.percent < perPage) : [];
        const missing = (only ?? []).filter((r) => !u.pages.some((p) => p.route === r));
        const c = cites({ evidence: u.evidence.filter((x) => known.has(x)), journeys: [...new Set(pages.flatMap((p) => p.journeys))].filter((j) => journeyIds.has(j)) });
        const pctx = (x: number) => `${(x * 100).toFixed(1)}%`;
        const text = `UI coverage ${pctx(ratio)} (${scoped.tested}/${scoped.total} interactive elements${only?.length ? ` on ${only.join(', ')}` : ` on ${u.pages.length} page(s)`}) vs min ${pctx(min)}${lowPages.length ? `; below ${pctx(perPage!)} on ${lowPages.map((p) => `${p.route} (${pctx(p.percent)})`).join(', ')}` : ''}${missing.length ? `; pages never visited: ${missing.join(', ')}` : ''}.`;
        if (!c.evidence.length && !c.journeys.length) push(name, cfg, 'no-data', `${text} (no recorded evidence to cite)`, cites());
        else push(name, cfg, ratio >= min && !lowPages.length && !missing.length ? 'pass' : 'fail', text, c);
        break;
      }
      case 'noNewFailures': {
        if (!input.failureTags) {
          push(name, cfg, 'no-data', 'No run history to classify failures against.', cites());
          break;
        }
        const withRegressed = (cfg.includeRegressed as boolean | undefined) ?? true;
        const bad = input.failureTags.filter((t) => journeyIds.has(t.journeyId) && (t.tags.includes('new-failure') || (withRegressed && t.tags.includes('regressed'))));
        if (!bad.length) push(name, cfg, 'pass', 'No new or regressed failures.', cites({ journeys: [...journeyIds].slice(0, 20) }));
        else {
          const byId = new Map(run.journeys.map((j) => [j.journeyId, j]));
          push(name, cfg, 'fail', `${bad.length} journey(s) newly failing: ${bad.map((b) => `${b.journeyId} (${b.tags.join(', ')})`).join('; ')}.`,
            cites({ journeys: bad.map((b) => b.journeyId), evidence: bad.flatMap((b) => (byId.get(b.journeyId) ? journeyEvidence(byId.get(b.journeyId)!, known) : [])) }));
        }
        break;
      }
      case 'manualVerified': {
        const manual = run.journeys.filter((j) => j.manual);
        if (!manual.length) {
          push(name, cfg, 'no-data', 'The run has no manual or hybrid journeys.', cites());
          break;
        }
        const pending = manual.filter((j) => j.manual!.pending > 0);
        const ev = (j: JourneyResult) => j.steps.flatMap((s) => (s.manual ? s.evidence : [])).filter((x) => known.has(x)).slice(0, 5);
        if (!pending.length) push(name, cfg, 'pass', `All manual steps of ${manual.length} manual/hybrid journey(s) have a verdict (testers: ${[...new Set(manual.flatMap((j) => j.manual!.testers))].join(', ') || 'unnamed'}).`, cites({ journeys: manual.map((j) => j.journeyId), evidence: manual.flatMap(ev) }));
        else push(name, cfg, 'fail', `${pending.reduce((n, j) => n + j.manual!.pending, 0)} manual step(s) in ${pending.length} journey(s) have no verdict: ${pending.map((j) => j.journeyId).join(', ')}.`, cites({ journeys: pending.map((j) => j.journeyId) }));
        break;
      }
      case 'a11yNoNewViolations': {
        if (!input.a11yNew) {
          push(name, cfg, 'no-data', 'No earlier accessibility scan to compare with.', cites());
          break;
        }
        const items = input.a11yNew;
        const c = cites({ journeys: items.flatMap((i) => i.journeys).filter((j) => journeyIds.has(j)), evidence: items.flatMap((i) => i.evidence).filter((x) => known.has(x)) });
        if (!items.length) push(name, cfg, 'pass', 'No new accessibility issues since the previous scanned run.', cites({ journeys: [...journeyIds].slice(0, 20) }));
        else push(name, cfg, 'fail', `${items.length} new accessibility issue(s): ${[...new Set(items.map((i) => i.ruleId))].join(', ')}.`, c);
        break;
      }
      case 'apiCoverage': case 'contracts': case 'load': {
        const r = name === 'apiCoverage' ? evaluateApiCoverageGate(input.apiCoverage, cfg, journeyIds) : name === 'load' ? evaluateLoadGate(input.load, cfg) : evaluateContractsGate(input.contracts);
        const c = cites({ evidence: r.evidence.filter((x) => known.has(x)), journeys: r.journeys.filter((x) => journeyIds.has(x)) });
        // A verdict must cite something that exists; results without recorded evidence count as missing input.
        if (r.status !== 'no-data' && !c.evidence.length && !c.journeys.length) push(name, cfg, 'no-data', `${r.summary} (no recorded evidence to cite)`, cites());
        else push(name, cfg, r.status, r.summary, c);
        break;
      }
      case 'apiSecurity': {
        const r = evaluateApiSecurityGate(input.apiSecurity, (cfg.failOn as 'info' | 'low' | 'medium' | 'high' | undefined) ?? 'medium');
        const c = cites({ evidence: r.evidence.filter((x) => known.has(x)) });
        if (r.status !== 'no-data' && !c.evidence.length) push(name, cfg, 'no-data', `${r.summary} (no recorded evidence to cite)`, cites());
        else push(name, cfg, r.status, r.summary, c);
        break;
      }
    }
  }

  if (gates.length === 0) throw new EzTestError('Readiness policy has no enabled gates', 'POLICY_INVALID');

  // ---------------- exceptions
  const exceptionsApplied: ReadinessResult['exceptionsApplied'] = [];
  const exceptionsIgnored: ReadinessResult['exceptionsIgnored'] = [];
  for (const ex of policy.exceptions) {
    if (ex.expires) {
      const t = Date.parse(ex.expires);
      if (!Number.isFinite(t)) {
        exceptionsIgnored.push({ ...ex, why: `unparseable expiry ${ex.expires}` });
        continue;
      }
      if (t < now.getTime()) {
        exceptionsIgnored.push({ ...ex, why: `expired ${ex.expires}` });
        continue;
      }
    }
    const g = gates.find((x) => x.gate === ex.gate);
    if (!g) {
      exceptionsIgnored.push({ ...ex, why: 'gate not enabled in policy' });
      continue;
    }
    if (g.status !== 'fail' && g.status !== 'no-data') {
      exceptionsIgnored.push({ ...ex, why: `gate status is ${g.status}; nothing to waive` });
      continue;
    }
    if (ex.journeys && ex.journeys.length > 0) {
      const outside = g.cites.journeys.filter((j) => !ex.journeys!.includes(j));
      if (g.cites.journeys.length === 0 || outside.length > 0) {
        exceptionsIgnored.push({ ...ex, why: `exception scoped to ${ex.journeys.join(', ')} but gate also fails for ${outside.join(', ') || 'unscoped items'}` });
        continue;
      }
    }
    const rec = { ...ex, recordedAt: now.toISOString() };
    g.status = 'waived';
    g.exception = rec;
    exceptionsApplied.push(rec);
    rationale.push({
      gate: g.gate,
      kind: 'waived',
      text: `Gate ${g.gate} waived by ${ex.approver}: ${ex.reason}${ex.expires ? ` (expires ${ex.expires})` : ''}.`,
      cites: g.cites,
    });
    for (const r of rationale) if (r.gate === g.gate && (r.kind === 'violation' || r.kind === 'missing-input')) r.kind = 'waived';
  }

  // ---------------- score + decision
  const s = policy.scoring;
  let weight = 0;
  let earned = 0;
  for (const j of executed) {
    weight += j.risk;
    if (j.status === 'passed') earned += j.risk;
    else if (j.status === 'passed-healed') earned += j.risk * s.healedPassCredit;
  }
  let score = weight > 0 ? (earned / weight) * 100 : 0;
  for (const g of gates) {
    if (g.status === 'fail' || g.status === 'no-data') score -= g.severity === 'blocker' ? s.blockerPenalty : s.riskPenalty;
    else if (g.status === 'waived') score -= s.waivedPenalty;
  }
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  const blockerFail = gates.some((g) => g.severity === 'blocker' && (g.status === 'fail' || g.status === 'no-data'));
  const riskIssue = gates.some((g) => g.status !== 'pass');
  let decision: ReadinessDecision;
  if (executed.length === 0 || blockerFail || score < s.noGoBelowScore) decision = 'NO_GO';
  else if (riskIssue || score < s.goMinScore) decision = 'GO_WITH_RISKS';
  else decision = 'GO';

  rationale.unshift({
    kind: 'info',
    text: `Decision ${decision}: risk-weighted score ${score}/100 over ${executed.length} executed journey(s); ${gates.filter((g) => g.status === 'pass').length}/${gates.length} gates passed.`,
    // When every executed journey was a quarantined failure, cite those (they are what the run consisted of).
    cites: cites({ journeys: executed.length ? executed.map((j) => j.journeyId) : ignored.map((j) => j.journeyId) }),
  });

  const result: ReadinessResult = {
    decision,
    score,
    runId: run.runId,
    gates,
    rationale,
    exceptionsApplied,
    exceptionsIgnored,
    evaluatedAt: now.toISOString(),
    ...(ignored.length ? { quarantineIgnored: ignored.map((j) => j.journeyId) } : {}),
  };
  validateReadinessCitations(result, input);
  return result;
}

/**
 * Every cited id must exist, and every violation/pass must cite at least one
 * thing. Only "missing-input" items (there is nothing to cite) and waivers of
 * gates that had no data may be empty.
 */
export function validateReadinessCitations(result: ReadinessResult, input: Pick<ReadinessInput, 'run' | 'evidence'>): void {
  const ev = new Set(input.evidence.map((e) => e.id));
  const js = new Set(input.run.journeys.map((j) => j.journeyId));
  for (const r of result.rationale) {
    const where = `rationale "${r.text.slice(0, 60)}"`;
    for (const id of r.cites.evidence) if (!ev.has(id)) throw new EzTestError(`${where} cites unknown evidence ${id}`, 'INVALID_CITATION');
    for (const id of r.cites.journeys) if (!js.has(id)) throw new EzTestError(`${where} cites unknown journey ${id}`, 'INVALID_CITATION');
    for (const q of r.cites.requirements) if (!q.trim()) throw new EzTestError(`${where} cites an empty requirement id`, 'INVALID_CITATION');
    const total = r.cites.evidence.length + r.cites.journeys.length + r.cites.requirements.length;
    const mustCite = r.kind === 'violation' || r.kind === 'pass' || (r.kind === 'info' && js.size > 0);
    if (mustCite && total === 0) throw new EzTestError(`${where} has no citations`, 'INVALID_CITATION');
  }
}

function assertCitable(input: ReadinessInput): void {
  const bad = (what: string) =>
    new EzTestError(`${what} must carry a journeyId or evidence ids so readiness reasons can cite them`, 'INVALID_INPUT');
  for (const p of input.perf ?? []) if (!p.journeyId && !(p.evidence ?? []).length) throw bad(`perf item ${p.metric}`);
  for (const a of input.a11y ?? []) if (!a.journeyId && !(a.evidence ?? []).length) throw bad(`a11y finding ${a.ruleId}`);
  if (input.docs && !(input.docs.evidence ?? []).length && !(input.docs.mismatches ?? []).some((m) => (m.evidence ?? []).length || m.journeyId)) {
    throw bad('docs reconciliation result');
  }
}
