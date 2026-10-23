/**
 * Release readiness for a run: the live decision (current policy, quarantine
 * and triage overrides applied), every gate with its reasons, risk-weighted
 * coverage, the decision trend, "what would make this GO", the policy editor
 * and sign-off notes recorded in the run's evidence vault.
 */
import { sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { a11yReadinessInputs } from '../../a11y/readiness.js';
import { EvidenceVault } from '../../core/index.js';
import { canonicalJson, keyFingerprint, loadPrivateKey } from '../../evidence-pack/manifest.js';
import {
  applyTriageOverrides,
  evaluateReadiness,
  readinessByBrowser,
  GATE_NAMES,
  loadQuarantine,
  loadRunArtifacts,
  loadTriageOverrides,
  parseReadinessPolicy,
  quarantineStatus,
  triageRun,
  type GateResult,
  type ReadinessPolicy,
  type ReadinessResult,
} from '../../insights/index.js';
import type { StudioApp } from '../app.js';
import { HttpError } from '../http.js';
import { completedRuns, flakyScores, openHistory, qualityPaths, readJsonFile, sha } from './common.js';
import { loadUiCoverage } from '../../analytics/ui-coverage.js';
import { failureTags } from '../../insights/failure-tags.js';

export const DEFAULT_POLICY_PATH = 'readiness-policy.yaml';

export const STARTER_POLICY = `# Release readiness policy (EZTest). Gates: noFailedCriticalJourneys, maxHealedRatio,
# minPassRate, noOpenProductBugs, perfBudgets, a11yNoCritical, docsReconciled, requirementsCovered,
# apiCoverage, contracts, uiCoverage (e.g. uiCoverage: 0.6), noNewFailures, manualVerified, a11yNoNewViolations.
version: 1
gates:
  noFailedCriticalJourneys: { minRisk: 4 }
  minPassRate: { min: 0.95 }
  maxHealedRatio: { max: 0.2 }
  noOpenProductBugs: true
exceptions: []
`;

export async function policyFile(app: StudioApp): Promise<{ path: string; abs: string; exists: boolean; configured: boolean }> {
  let rel: string | undefined;
  try {
    rel = (await app.config()).config.readiness.policyPath;
  } catch {
    rel = undefined;
  }
  const path = rel ?? DEFAULT_POLICY_PATH;
  const abs = app.confine(path);
  return { path, abs, exists: existsSync(abs), configured: !!rel };
}

export interface ToGoItem {
  gate?: string;
  action: string;
  link?: string;
  journeys?: string[];
}

/** Concrete steps that would turn the decision into GO, derived from failing gates and the score. */
export function whatWouldMakeGo(r: ReadinessResult, policy: ReadinessPolicy, ctx: { runId: string; failing: Array<{ id: string; status: string; risk: number }>; healed: string[] }): ToGoItem[] {
  if (r.decision === 'GO') return [];
  const out: ToGoItem[] = [];
  const link = (page: string, ...seg: string[]) => `#/quality/${page}${seg.length ? '/' + seg.map(encodeURIComponent).join('/') : ''}`;
  for (const g of r.gates) {
    if (g.status === 'pass' || g.status === 'waived') continue;
    const j = g.cites.journeys;
    switch (g.gate) {
      case 'noFailedCriticalJourneys':
        out.push({ gate: g.gate, action: g.status === 'no-data' ? 'Run the critical journeys (risk >= threshold or tagged @critical) so the gate has data' : `Fix the ${j.length} failing critical journey(s), or quarantine them with an owner and expiry if they are known-flaky`, journeys: j, link: link('triage', ctx.runId) });
        break;
      case 'minPassRate': {
        const m = /\((\d+)\/(\d+)\) vs min ([\d.]+)%/.exec(g.summary);
        const need = m ? Math.max(0, Math.ceil((Number(m[3]) / 100) * Number(m[2]) - Number(m[1]))) : undefined;
        out.push({ gate: g.gate, action: need ? `${need} more journey(s) must pass to reach the minimum pass rate` : 'Raise the pass rate to the policy minimum', journeys: ctx.failing.map((f) => f.id), link: link('triage', ctx.runId) });
        break;
      }
      case 'maxHealedRatio':
        if (g.status === 'no-data') out.push({ gate: g.gate, action: 'No journey passed, so the healed ratio has no data; it resolves once journeys pass' });
        else out.push({ gate: g.gate, action: `Review and accept the heals of ${ctx.healed.length} healed journey(s) in the Heal inbox, so they pass on their own locators next run`, journeys: ctx.healed, link: link('heals') });
        break;
      case 'noOpenProductBugs':
        out.push({ gate: g.gate, action: 'Resolve the product bugs triage found, or reclassify a misclassified failure with a reason', journeys: j, link: link('triage', ctx.runId) });
        break;
      case 'requirementsCovered':
        out.push({ gate: g.gate, action: `Cover the listed requirements with passing journeys (${g.cites.requirements.join(', ')})`, link: link('traceability') });
        break;
      default:
        out.push({ gate: g.gate, action: g.status === 'no-data' ? `Supply ${g.gate} results, or disable the gate in the policy` : `Fix: ${g.summary}` });
    }
    if (g.severity === 'blocker') out[out.length - 1].action += ' (blocker)';
  }
  const s = policy.scoring;
  if (r.score < s.goMinScore) out.push({ action: `Raise the risk-weighted score from ${r.score} to at least ${s.goMinScore}: every failing high-risk journey costs the most` });
  if (out.length) out.push({ action: 'Or record a time-boxed exception (waiver) for a gate in the policy, with a named approver and reason', link: link('readiness', ctx.runId) });
  return out;
}

export async function evaluateFor(app: StudioApp, runId: string, policyText?: string) {
  const out = await app.outputDir();
  const dir = join(out, runId);
  if (!existsSync(join(dir, 'run.json'))) throw new HttpError(404, `Run ${runId} not found`);
  const art = await loadRunArtifacts(dir);
  const pf = await policyFile(app);
  const text = policyText ?? (pf.exists ? await readFile(pf.abs, 'utf8') : undefined);
  const paths = await qualityPaths(app);
  const q = quarantineStatus(await loadQuarantine(paths.quarantine).catch(() => ({ version: 1 as const, entries: [] })));
  const flaky = await flakyScores(app);
  const triage = art.run.journeys.length ? triageRun({ run: art.run, evidence: art.evidence, networkLogs: art.networkLogs, flaky }) : undefined;
  const overrides = await loadTriageOverrides(paths.overrides).catch(() => ({ version: 1 as const, overrides: [] }));
  const runs = await completedRuns(app);
  const started = new Map(runs.map((r) => [r.runId, r.startedAt ?? '']));
  const verdicts = triage ? applyTriageOverrides(triage, overrides, (id) => started.get(id)) : [];
  let policy: ReadinessPolicy | undefined;
  let policyError: string | undefined;
  let result: ReadinessResult | undefined;
  if (text !== undefined) {
    try {
      policy = parseReadinessPolicy(text);
      const ui = await loadUiCoverage(dir);
      const history = await openHistory(app);
      const input = {
        run: art.run,
        evidence: art.evidence,
        ...(await a11yReadinessInputs(dir, art.evidence)),
        triage: triage ? { ...triage, verdicts } : undefined,
        flaky,
        quarantined: q.active.map((x) => x.journeyId),
        // UI coverage recorded at analysis (ui-coverage.json) and the run's failure tags.
        ...(ui?.totals.elements ? { uiCoverage: { percent: ui.totals.percent, tested: ui.totals.tested, total: ui.totals.elements, pages: ui.pages.map((p) => ({ route: p.route, percent: p.percent, tested: p.tested, total: p.total, journeys: p.journeys })), evidence: ui.evidenceId ? [ui.evidenceId] : [] } } : {}),
        ...(history?.runs.some((r) => r.runId === runId) ? { failureTags: failureTags(history.runs, runId) } : {}),
      };
      result = evaluateReadiness(policy, input);
      // Cross-browser runs: the decision per browser next to the combined one.
      const perBrowser = readinessByBrowser(policy, input);
      if (perBrowser) result.browsers = perBrowser;
    } catch (e) {
      policyError = (e as Error).message;
    }
  }
  // Risk-weighted coverage: share of executed risk that passed (healed passes at the policy's credit).
  const credit = policy?.scoring.healedPassCredit ?? 0.8;
  const qIds = new Set(q.active.map((x) => x.journeyId));
  const byRisk = new Map<number, { risk: number; total: number; passed: number; healed: number; failed: number; quarantined: number }>();
  let weight = 0;
  let earned = 0;
  for (const j of art.run.journeys) {
    if (j.status === 'skipped') continue;
    const b = byRisk.get(j.risk) ?? { risk: j.risk, total: 0, passed: 0, healed: 0, failed: 0, quarantined: 0 };
    b.total++;
    if (qIds.has(j.journeyId) && (j.status === 'failed' || j.status === 'error')) {
      b.quarantined++;
      byRisk.set(j.risk, b);
      continue;
    }
    weight += j.risk;
    if (j.status === 'passed') {
      b.passed++;
      earned += j.risk;
    } else if (j.status === 'passed-healed') {
      b.healed++;
      earned += j.risk * credit;
    } else b.failed++;
    byRisk.set(j.risk, b);
  }
  const recorded = (await readJsonFile<{ insights?: { readiness?: ReadinessResult } }>(join(dir, 'report.json')))?.insights?.readiness;
  const toGo =
    result && policy
      ? whatWouldMakeGo(result, policy, {
          runId,
          failing: art.run.journeys.filter((j) => (j.status === 'failed' || j.status === 'error') && !qIds.has(j.journeyId)).map((j) => ({ id: j.journeyId, status: j.status, risk: j.risk })),
          healed: art.run.journeys.filter((j) => j.status === 'passed-healed').map((j) => j.journeyId),
        })
      : [];
  return {
    runId,
    startedAt: art.run.startedAt,
    policy: { ...pf, abs: undefined, text: text ?? STARTER_POLICY, hash: text !== undefined ? sha(text) : undefined, error: policyError, gates: GATE_NAMES },
    result,
    recorded: recorded ? { decision: recorded.decision, score: recorded.score, evaluatedAt: recorded.evaluatedAt } : undefined,
    coverage: { weighted: weight ? earned / weight : 0, earned, weight, healedCredit: credit, byRisk: [...byRisk.values()].sort((a, b) => b.risk - a.risk) },
    quarantine: { active: q.active.map((x) => x.journeyId), warnings: q.warnings },
    overrides: verdicts.filter((v) => v.override).map((v) => ({ journeyId: v.journeyId, from: v.ruleCategory, to: v.category, by: v.override!.by, inherited: v.override!.inherited })),
    toGo,
    signoffs: await readSignoffs(dir, art.evidence),
    signing: await signingKeyStatus(app),
  };
}

/** Decisions recorded at analysis time for recent runs (oldest first). */
export async function decisionTrend(app: StudioApp, n = 30) {
  const runs = (await completedRuns(app)).slice(0, n).reverse();
  const out = await app.outputDir();
  const points: Array<{ runId: string; startedAt?: string; decision?: string; score?: number }> = [];
  for (const r of runs) {
    const rep = await readJsonFile<{ insights?: { readiness?: { decision: string; score: number } } }>(join(out, r.runId, 'report.json'));
    points.push({ runId: r.runId, startedAt: r.startedAt, decision: rep?.insights?.readiness?.decision, score: rep?.insights?.readiness?.score });
  }
  return points;
}

// ------------------------------------------------------------------ sign-off

export interface SigningStatus {
  configured: boolean;
  source?: string;
  fingerprint?: string;
  hint: string;
}

/** The evidence-pack ed25519 key: EZTEST_SIGNING_KEY (a PEM file path), else eztest-signing.key.pem or .eztest/signing.key.pem. */
export async function signingKeyStatus(app: StudioApp): Promise<SigningStatus & { pem?: string }> {
  const fromEnv = app.env.EZTEST_SIGNING_KEY;
  const candidates = [fromEnv ? resolve(app.cwd, fromEnv) : undefined, resolve(app.cwd, 'eztest-signing.key.pem'), resolve(app.cwd, '.eztest', 'signing.key.pem')].filter((x): x is string => !!x);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pem = await readFile(p, 'utf8');
      const key = loadPrivateKey(pem);
      return { configured: true, source: p === candidates[0] && fromEnv ? 'EZTEST_SIGNING_KEY' : app.rel(p), fingerprint: keyFingerprint(key), hint: 'Sign-offs are signed with the evidence-pack ed25519 key.', pem };
    } catch (e) {
      return { configured: false, hint: `The signing key at ${app.rel(p)} could not be loaded: ${(e as Error).message}. Sign-offs are recorded hashed but unsigned.` };
    }
  }
  return {
    configured: false,
    hint: 'No ed25519 signing key is configured (EZTEST_SIGNING_KEY, eztest-signing.key.pem or .eztest/signing.key.pem; create one with "eztest keys generate"). Sign-offs are recorded in the evidence vault hashed but unsigned.',
  };
}

export interface SignoffNote {
  type: 'eztest.readiness-signoff';
  version: 1;
  runId: string;
  approver: string;
  comment: string;
  decision: string;
  score: number;
  gates: Array<{ gate: string; status: string }>;
  policySha256?: string;
  evidenceHeadBefore: string;
  signedAt: string;
  /** sha256 of the canonical note without the signature block. */
  digest: string;
  signature?: { algorithm: 'ed25519'; keyFingerprint: string; value: string };
  unsigned?: string;
}

export async function readSignoffs(runDir: string, evidence: Array<{ id: string; path: string; description?: string }>) {
  const out: Array<SignoffNote & { evidenceId: string }> = [];
  for (const e of evidence) {
    if (!e.path.startsWith('signoffs/')) continue;
    const n = await readJsonFile<SignoffNote>(join(runDir, e.path));
    if (n?.type === 'eztest.readiness-signoff') out.push({ ...n, evidenceId: e.id });
  }
  return out;
}

export async function recordSignoff(app: StudioApp, runId: string, approver: string, comment: string, expectDecision?: string) {
  const ev = await evaluateFor(app, runId);
  if (!ev.result) throw new HttpError(422, ev.policy.error ? `The readiness policy is invalid: ${ev.policy.error}` : 'No readiness policy; create one before signing off');
  if (expectDecision && expectDecision !== ev.result.decision) throw new HttpError(409, `The decision changed to ${ev.result.decision} since you reviewed it; review again`);
  const dir = join(await app.outputDir(), runId);
  const vault = await EvidenceVault.resume(dir).catch((e: Error) => {
    throw new HttpError(409, `Cannot add to this run's evidence vault: ${e.message}`);
  });
  const signing = await signingKeyStatus(app);
  const body: Omit<SignoffNote, 'digest' | 'signature' | 'unsigned'> = {
    type: 'eztest.readiness-signoff',
    version: 1,
    runId,
    approver,
    comment,
    decision: ev.result.decision,
    score: ev.result.score,
    gates: ev.result.gates.map((g: GateResult) => ({ gate: g.gate, status: g.status })),
    ...(ev.policy.hash ? { policySha256: ev.policy.hash } : {}),
    evidenceHeadBefore: vault.headHash,
    signedAt: new Date().toISOString(),
  };
  const canonical = canonicalJson(body);
  const note: SignoffNote = { ...body, digest: sha(canonical) };
  if (signing.configured && signing.pem) {
    const key = loadPrivateKey(signing.pem);
    note.signature = { algorithm: 'ed25519', keyFingerprint: keyFingerprint(key), value: sign(null, Buffer.from(canonical), key).toString('base64') };
  } else {
    note.unsigned = 'no ed25519 signing key configured; the note is hashed and chained into the evidence manifest but not signed';
  }
  const stamp = note.signedAt.replace(/[-:.]/g, '');
  const ref = await vault.store('report', `signoffs/signoff-${stamp}.json`, JSON.stringify(note, null, 2) + '\n', {
    description: `readiness sign-off by ${approver}: ${note.decision}${note.signature ? ' (ed25519 signed)' : ' (hashed, unsigned)'}`,
  });
  return { note, evidenceId: ref.id, head: vault.headHash };
}
