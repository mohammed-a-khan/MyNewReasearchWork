/**
 * Manual and hybrid execution.
 *
 * - A `Manual:` step asks the run's ManualVerdictProvider (Studio's guided
 *   runner, or the terminal prompt of `eztest run --manual prompt`) for a
 *   tester's verdict: passed / failed / blocked / skipped, notes, what was
 *   observed and attachments. Everything lands in the Evidence Vault of the
 *   same run (hash-chained), so manual results feed readiness, traceability,
 *   history and ADO publishing exactly like automated ones.
 * - In a hybrid journey (automated steps and manual ones) the browser stays
 *   open while the run waits: the tester sees a screenshot of the page at the
 *   pause, acts, gives the verdict, and the automation continues. `Expect`
 *   lines under a manual step are checked automatically after the verdict.
 * - A manual journey (only manual steps) needs no browser: it runs through the
 *   built-in "manual" platform driver.
 *
 * Without a provider a manual step is recorded as not executed (skipped,
 * `manual.verdict: "pending"`), never as a pass.
 */
import { interpolate, journeyStatusFrom, nowIso, type Journey, type JourneyManualSummary, type JourneyResult, type ManualStepRecord, type Step, type StepResult } from '../core/index.js';
import { flattenSteps } from '../core/steps.js';
import { safeName } from './evidence.js';
import type { PlatformDriver, PlatformRunEnv } from './platform.js';
import type { RunOptions, StepContext } from './types.js';

export type ManualVerdictStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

/** What the tester is asked. Texts are interpolated and masked. */
export interface ManualStepRequest {
  runId: string;
  journeyId: string;
  journeyName: string;
  stepId: string;
  /** 1-based position among the journey's manual steps, and how many there are. */
  index: number;
  total: number;
  instruction: string;
  expected: string[];
  /** Project-relative reference files named by `Attachment:` lines. */
  attachments: string[];
  /** Automated post-conditions checked after the verdict (plain English). */
  checks: string[];
  /** True when the step pauses an automated (hybrid) journey; the page is live. */
  hybrid: boolean;
  attempt: number;
  url?: string;
  title?: string;
  /** Page screenshot at the pause (hybrid): evidence id and run-relative path. */
  screenshot?: { evidenceId: string; path: string };
  assignee?: string;
  preconditions?: string;
  requestedAt: string;
}

export interface ManualAttachment {
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface ManualVerdict {
  status: ManualVerdictStatus;
  notes?: string;
  /** What the tester observed. */
  actual?: string;
  tester?: string;
  attachments?: ManualAttachment[];
}

/** Supplies verdicts for manual steps (Studio guided runner, terminal prompt, tests). */
export interface ManualVerdictProvider {
  verdict(req: ManualStepRequest, signal?: AbortSignal): Promise<ManualVerdict>;
}

/** Thrown by a provider when the tester ended the run early: the step and the rest are recorded as not executed. */
export class ManualRunEnded extends Error {
  constructor(message = 'manual run ended by the tester') {
    super(message);
    this.name = 'ManualRunEnded';
  }
}

export type JourneyKind = 'automated' | 'manual' | 'hybrid';

/** Leaf steps (blocks expanded). */
function leaves(steps: Step[]): Step[] {
  return flattenSteps(steps).filter((s) => !(s.steps || s.else || s.catch));
}

/** automated | manual | hybrid: the `Type:` header, else inferred from the steps. */
export function journeyKind(j: Pick<Journey, 'type' | 'steps'>): JourneyKind {
  if (j.type) return j.type;
  const l = leaves(j.steps);
  const manual = l.filter((s) => s.action === 'manual').length;
  if (!manual) return 'automated';
  return manual === l.length && flattenSteps(j.steps).every((s) => s.action === 'manual' || s.action === 'group') ? 'manual' : 'hybrid';
}

/** A manual journey runs without a browser (only manual steps, at most group blocks). */
export function isManualJourney(j: Pick<Journey, 'type' | 'steps'>): boolean {
  return journeyKind(j) === 'manual' && flattenSteps(j.steps).every((s) => s.action === 'manual' || s.action === 'group');
}

export function manualStepCount(j: Pick<Journey, 'steps'>): number {
  return flattenSteps(j.steps).filter((s) => s.action === 'manual').length;
}

const MAX_ATTACHMENT = 15 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

function extOf(a: ManualAttachment): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(a.name);
  if (m) return m[1].toLowerCase();
  return a.contentType === 'image/png' ? 'png' : a.contentType === 'image/jpeg' ? 'jpg' : a.contentType === 'application/pdf' ? 'pdf' : 'bin';
}

interface ManualCtx {
  runId: string;
  journey: Journey;
  attempt: number;
  opts: RunOptions;
  evidence: StepContext['evidence'];
  interpolate(s: string): string;
  /** Live page of a hybrid journey. */
  page?: StepContext['page'];
  /** Which manual step this is (1-based) and how many the journey has. */
  index: number;
  total: number;
}

type Core = Omit<StepResult, 'stepId' | 'intent' | 'startedAt' | 'durationMs'>;

/** Ask for a verdict on one manual step and record it (verdict JSON + attachments) in the Evidence Vault. */
export async function runManualStep(step: Step, c: ManualCtx): Promise<Core & { ended?: boolean }> {
  const mask = (s: string) => (c.opts.mask ? c.opts.mask(s) : s);
  const text = (s: string) => {
    try {
      return mask(c.interpolate(s));
    } catch {
      return mask(s);
    }
  };
  const args = (step.args ?? {}) as { expected?: string[]; attachments?: string[] };
  const instruction = text(step.value ?? step.intent.replace(/^manual[^:]*:\s*/i, ''));
  const expected = (args.expected ?? []).map(text);
  const prefix = `journeys/${safeName(c.journey.id)}/attempt-${c.attempt}`;
  const meta = (description: string) => ({ journeyId: c.journey.id, stepId: step.id, description });
  const record: ManualStepRecord = { verdict: 'pending', instruction, expected, attachments: [] };
  const evidence: string[] = [];
  const provider = c.opts.manual;
  if (!provider) {
    return {
      status: 'skipped', conditions: [], evidence, manual: record,
      error: { message: 'manual step not executed: no tester attached (run it from Studio, or `eztest run --manual prompt`)', name: 'ManualPending' },
    };
  }
  let screenshot: ManualStepRequest['screenshot'];
  let url: string | undefined;
  let title: string | undefined;
  if (c.page) {
    try {
      url = mask(c.page.url());
      title = mask(await c.page.title());
      const png = await c.page.screenshot({ fullPage: false, timeout: 5000 });
      const ref = await c.evidence.store('screenshot', `${prefix}/${safeName(step.id)}.manual-pause.png`, png, meta('page at the manual pause'));
      evidence.push(ref.id);
      screenshot = { evidenceId: ref.id, path: ref.path };
      record.pageScreenshot = ref.id;
    } catch {
      // the page may be gone (closed tab); the tester still gets the instruction
    }
  }
  const { conditionToText } = await import('../intent/conditions.js');
  const req: ManualStepRequest = {
    runId: c.runId, journeyId: c.journey.id, journeyName: c.journey.name, stepId: step.id, index: c.index, total: c.total,
    instruction, expected, attachments: args.attachments ?? [], checks: step.postconditions.map((x) => {
      try {
        return text(conditionToText(x));
      } catch {
        return x.type;
      }
    }),
    hybrid: !!c.page, attempt: c.attempt, ...(url ? { url } : {}), ...(title ? { title } : {}), ...(screenshot ? { screenshot } : {}),
    ...(c.journey.assignee ? { assignee: c.journey.assignee } : {}), ...(c.journey.preconditions ? { preconditions: text(c.journey.preconditions) } : {}),
    requestedAt: nowIso(),
  };
  let v: ManualVerdict;
  try {
    v = await provider.verdict(req, c.opts.signal);
  } catch (e) {
    const ended = e instanceof ManualRunEnded || (e as Error).name === 'ManualRunEnded';
    const cancelled = !!c.opts.signal?.aborted || (e as Error).name === 'CancelledError' || (e as Error).name === 'AbortError';
    return {
      status: 'skipped', conditions: [], evidence, manual: record, ended: ended || cancelled,
      error: { message: ended ? 'not executed: the tester ended the manual run' : cancelled ? 'not run: run cancelled' : `manual verdict failed: ${(e as Error).message}`, name: ended ? 'ManualPending' : cancelled ? 'CancelledError' : 'ManualError' },
    };
  }
  if (!['passed', 'failed', 'blocked', 'skipped'].includes(v.status)) throw new Error(`manual verdict "${String(v.status)}" is not passed, failed, blocked or skipped`);
  record.verdict = v.status;
  record.at = nowIso();
  if (v.tester) record.tester = mask(v.tester.trim().slice(0, 120));
  if (v.notes?.trim()) record.notes = mask(v.notes.trim().slice(0, 20_000));
  if (v.actual?.trim()) record.actual = mask(v.actual.trim().slice(0, 20_000));
  for (const [i, a] of (v.attachments ?? []).entries()) {
    if (a.data.byteLength > MAX_ATTACHMENT) throw new Error(`attachment ${a.name} is larger than 15 MB`);
    const kind = IMAGE.test(a.contentType) ? 'screenshot' : a.contentType === 'application/pdf' ? 'document' : 'data';
    const ref = await c.evidence.store(kind, `${prefix}/${safeName(step.id)}.manual-${i + 1}.${extOf(a)}`, a.data, meta(`tester attachment: ${mask(a.name).slice(0, 120)}`));
    record.attachments.push(ref.id);
    evidence.push(ref.id);
  }
  // The verdict itself (tester, notes, observed result, attachment ids) is evidence too.
  const vr = await c.evidence.store('data', `${prefix}/${safeName(step.id)}.manual.json`, JSON.stringify({ request: { ...req, screenshot: undefined }, record }, null, 2), meta(`manual verdict: ${v.status}${record.tester ? ` by ${record.tester}` : ''}`));
  evidence.unshift(vr.id);
  const status: StepResult['status'] = v.status === 'blocked' ? 'blocked' : v.status;
  const why = record.notes ?? record.actual;
  return {
    status, conditions: [], evidence, manual: record,
    ...(status === 'failed' ? { error: { message: `manual step failed${record.tester ? ` (${record.tester})` : ''}${why ? `: ${why.split('\n')[0].slice(0, 300)}` : ''}`, name: 'ManualFailure' } } : {}),
    ...(status === 'blocked' ? { error: { message: `manual step blocked${why ? `: ${why.split('\n')[0].slice(0, 300)}` : ''}`, name: 'ManualBlocked' } } : {}),
    ...(status === 'skipped' ? { error: { message: `skipped by the tester${why ? `: ${why.split('\n')[0].slice(0, 300)}` : ''}`, name: 'ManualSkipped' } } : {}),
  };
}

/** Position of a manual step among a journey's manual steps (1-based). */
function manualIndex(journey: Journey, step: Step): { index: number; total: number } {
  const all = flattenSteps(journey.steps).filter((s) => s.action === 'manual');
  return { index: Math.max(1, all.findIndex((s) => s.id === step.id) + 1), total: all.length };
}

/**
 * A `Manual:` step inside a browser journey (hybrid): ask the tester while the page stays open,
 * then check the step's automated post-conditions on the live page.
 */
export async function executeManualStep(step: Step, ctx: StepContext, opts: RunOptions, conditionTimeoutMs: number): Promise<Core> {
  const pos = manualIndex(ctx.journey, step);
  const r = await runManualStep(step, {
    runId: ctx.runId, journey: ctx.journey, attempt: ctx.attempt, opts, evidence: ctx.evidence, interpolate: (s) => ctx.interpolate(s), page: ctx.page, ...pos,
  });
  const { ended, ...core } = r;
  if (ended && core.error?.name !== 'CancelledError') core.error = { message: core.error?.message ?? 'not executed', name: 'ManualEnded' };
  if (core.status !== 'passed' || !step.postconditions.length) return core;
  const { evaluateConditions } = await import('./conditions.js');
  const { envFor } = await import('./step.js');
  const conditions = await evaluateConditions(step.postconditions, envFor(ctx, opts), conditionTimeoutMs);
  const bad = conditions.filter((x) => !x.passed);
  return {
    ...core, conditions,
    ...(bad.length ? { status: 'failed' as const, error: { message: `post-condition failed after the manual step: ${bad.map((x) => `${x.condition.type}: ${x.message ?? 'failed'}`).join('; ')}` } } : {}),
  };
}

/** The manual/hybrid summary of a journey result (undefined for automated journeys). */
export function manualSummary(j: Journey, steps: StepResult[]): JourneyManualSummary | undefined {
  const kind = journeyKind(j);
  if (kind === 'automated') return undefined;
  const flat: StepResult[] = [];
  const walk = (l: StepResult[]) => l.forEach((s) => (flat.push(s), walk(s.children ?? [])));
  walk(steps);
  const manual = flat.filter((s) => s.manual);
  const total = manualStepCount(j);
  const executed = manual.filter((s) => s.manual!.verdict !== 'pending').length;
  return {
    type: kind === 'manual' ? 'manual' : 'hybrid',
    executed,
    pending: Math.max(0, total - executed),
    testers: [...new Set(manual.map((s) => s.manual!.tester).filter((t): t is string => !!t))],
    ...(j.assignee ? { assignee: j.assignee } : {}),
  };
}

/** Executes manual journeys (only `Manual:` steps): no browser, one verdict per step. */
export const manualDriver: PlatformDriver = {
  name: 'eztest-manual',
  platforms: ['manual'],
  environment: () => ({ manual: 'tester' }),
  async runAttempt(journey: Journey, attempt: number, env: PlatformRunEnv): Promise<JourneyResult> {
    const opts = env.opts;
    const startedAt = nowIso();
    const t0 = Date.now();
    const vars = { ...journey.variables, ...(opts.variables ?? {}) };
    const I = (s: string) => interpolate(s, vars);
    const total = manualStepCount(journey);
    let index = 0;
    let stop: { message: string; name: string } | undefined;
    const runList = async (list: Step[]): Promise<StepResult[]> => {
      const out: StepResult[] = [];
      for (const step of list) {
        const st = nowIso();
        const s0 = Date.now();
        if (opts.signal?.aborted && !stop) stop = { message: 'not run: run cancelled', name: 'CancelledError' };
        if (stop) {
          out.push({ stepId: step.id, intent: step.intent, status: 'skipped', startedAt: st, durationMs: 0, conditions: [], evidence: [], error: { ...stop }, ...(step.action === 'manual' ? { manual: { verdict: 'pending', instruction: step.value ?? '', expected: ((step.args?.expected as string[]) ?? []), attachments: [] } } : {}) });
          continue;
        }
        opts.events?.emit({ type: 'step:start', journeyId: journey.id, stepId: step.id, intent: step.intent });
        let sr: StepResult;
        if (step.action === 'group') {
          const children = await runList(step.steps ?? []);
          sr = { stepId: step.id, intent: step.intent, status: journeyStatusFrom(children) === 'passed' ? 'passed' : children.some((x) => x.status === 'failed' || x.status === 'blocked') ? 'failed' : 'skipped', startedAt: st, durationMs: Date.now() - s0, conditions: [], evidence: [], children };
        } else if (step.action !== 'manual') {
          sr = { stepId: step.id, intent: step.intent, status: 'failed', startedAt: st, durationMs: 0, conditions: [], evidence: [], error: { message: `"${step.action}" step in a manual journey` } };
        } else {
          index++;
          try {
            const r = await runManualStep(step, { runId: env.runId, journey, attempt, opts, evidence: env.evidence, interpolate: I, index, total });
            const { ended, ...core } = r;
            sr = { stepId: step.id, intent: step.intent, startedAt: st, durationMs: Date.now() - s0, ...core };
            if (ended) stop = { message: core.error?.message ?? 'not executed', name: core.error?.name ?? 'ManualPending' };
            // A blocked step blocks the rest of the case; a failed one does not (the tester records every step).
            else if (core.status === 'blocked') stop = { message: `blocked by step "${step.intent}"`, name: 'ManualBlocked' };
          } catch (e) {
            sr = { stepId: step.id, intent: step.intent, status: 'failed', startedAt: st, durationMs: Date.now() - s0, conditions: [], evidence: [], error: { message: (e as Error).message } };
          }
        }
        opts.events?.emit({ type: 'step:end', journeyId: journey.id, stepId: step.id, status: sr.status, durationMs: sr.durationMs });
        out.push(sr);
      }
      return out;
    };
    const steps = await runList(journey.steps);
    const summary = manualSummary(journey, steps);
    let status = journeyStatusFrom(steps);
    // A case with steps never given a verdict is not a pass.
    if ((status === 'passed' || status === 'passed-healed') && summary && summary.pending > 0) status = 'skipped';
    const firstBad = steps.find((s) => s.status === 'failed' || s.status === 'blocked');
    const cancelled = stop?.name === 'CancelledError';
    return {
      journeyId: journey.id, name: journey.name, status, startedAt, durationMs: Date.now() - t0, steps,
      tags: journey.tags, requirements: journey.requirements, risk: journey.risk, attempt, browser: 'manual', ledger: {},
      evidence: [],
      ...(firstBad?.error ? { error: { ...firstBad.error } } : cancelled ? { error: { message: 'Run cancelled', name: 'CancelledError' } } : status === 'skipped' && steps.find((s) => s.error)?.error ? { error: { ...steps.find((s) => s.error)!.error! } } : {}),
      ...(summary ? { manual: summary } : {}),
    };
  },
};
