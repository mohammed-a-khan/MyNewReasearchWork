/**
 * Opt-in runner extensions: the time-travel trace and the live debugger.
 * `createRunExtensions` returns undefined unless `RunOptions.timeTravel.enabled`
 * or `RunOptions.debug` is set, so a plain run never reaches this code.
 * The journey loop hands each step to `JourneyExtension.runStep`, which wraps
 * the normal step execution with debugger checkpoints and trace capture.
 */
import { join } from 'node:path';
import type { BrowserContext, Page } from '../browser/index.js';
import { interpolate, nowIso, type Journey, type JourneyResult, type Logger, type Step, type StepResult } from '../core/index.js';
import { FingerprintStore } from '../heal/store.js';
import type { DebugController, PausePhase } from './debug/controller.js';
import type { EvidenceWriter } from './evidence.js';
import { clearStepHooks, setStepHooks, type StepHooks } from './hooks.js';
import { Ledger } from './ledger.js';
import { executeStepCore, skippedStep, type StepRuntime } from './step.js';
import { JourneyTraceRecorder, SENSITIVE_DESC, isSensitiveInput } from './trace/recorder.js';
import { TraceResourceStore } from './trace/store.js';
import type { RunOptions, StepContext } from './types.js';

export interface RunExtensionsInit {
  runId: string;
  runDir: string;
  browserName: string;
  evidence: EvidenceWriter;
  logger: Logger;
}

export interface JourneyExtensionInit {
  journey: Journey;
  attempt: number;
  page: Page;
  context: BrowserContext;
  ledger: Ledger;
  vars(): Record<string, unknown>;
  ctxFor(step: Step): StepContext;
  runtime: StepRuntime;
  /** The browser of this journey (cross-browser runs); default: the run's. */
  browserName?: string;
}

/** Build run extensions, or undefined when trace and debug are both off. */
export function createRunExtensions(options: RunOptions, init: RunExtensionsInit): RunExtensions | undefined {
  if (!options.timeTravel?.enabled && !options.debug) return undefined;
  return new RunExtensions(options, init);
}

export class RunExtensions {
  private readonly store?: TraceResourceStore;

  constructor(
    readonly options: RunOptions,
    readonly init: RunExtensionsInit,
  ) {
    if (options.timeTravel?.enabled) this.store = new TraceResourceStore(init.evidence);
    options.debug?.runStarted(options.events);
  }

  startJourney(j: JourneyExtensionInit): JourneyExtension {
    const tt = this.options.timeTravel;
    const recorder =
      tt?.enabled && this.store
        ? new JourneyTraceRecorder({
            runId: this.init.runId, runDir: this.init.runDir, browserName: j.browserName ?? this.init.browserName, journeyId: j.journey.id, journeyName: j.journey.name,
            attempt: j.attempt, page: j.page, evidence: this.init.evidence, store: this.store, options: tt,
          })
        : undefined;
    return new JourneyExtension(j, recorder, this.options.debug, this.init);
  }

  /** The run is over (always called, also on errors). */
  close(): void {
    this.options.debug?.runFinished();
  }
}

export class JourneyExtension {
  /** True while the debugger evaluates an ad-hoc step: hooks stay quiet. */
  private suspended = false;
  private currentIndex = -1;
  private currentStep?: Step;

  constructor(
    private readonly j: JourneyExtensionInit,
    private readonly trace: JourneyTraceRecorder | undefined,
    private readonly debug: DebugController | undefined,
    private readonly run: RunExtensionsInit,
  ) {
    setStepHooks(j.page, this.hooks());
    this.pages.add(j.page);
    this.currentPage = j.page;
    // Values aimed at password-like fields are secrets before they are ever typed.
    for (const s of j.journey.steps) {
      if (debug && s.value !== undefined && SENSITIVE_DESC.test(s.target?.description ?? '')) debug.learnSecret(interpolate(s.value, j.vars()));
    }
    debug?.attach({
      journey: j.journey,
      attempt: j.attempt,
      page: j.page,
      context: j.context,
      ledger: () => j.ledger.toJSON(),
      vars: () => j.vars(),
      conditionEnv: () => {
        const ctx = j.ctxFor(this.currentStep ?? j.journey.steps[0]);
        return { page: ctx.page, ledger: ctx.ledger, vars: () => ctx.vars(), interpolate: (s: string) => ctx.interpolate(s) };
      },
      runAdHoc: (step, o) => this.runAdHoc(step, o.commit),
    });
  }

  private hooks(): StepHooks {
    const t = this.trace?.hooks;
    const live = () => !this.suspended;
    return {
      located: (r) => {
        if (live()) t?.located?.(r);
      },
      beforeAct: async (loc, info) => {
        if (!live()) return;
        const step = this.currentStep;
        if (this.debug && loc && step?.value !== undefined && (await isSensitiveInput(loc))) this.debug.learnSecret(interpolate(step.value, this.j.vars()));
        await t?.beforeAct?.(loc, info);
      },
      afterAct: (e) => {
        if (live()) t?.afterAct?.(e);
      },
      beforeVerify: async () => {
        if (!live()) return;
        await this.innerCheckpoint('before-verify');
        await t?.beforeVerify?.();
      },
      afterVerify: (r) => {
        if (live()) t?.afterVerify?.(r);
      },
      beforeHeal: async (f) => {
        if (!live()) return;
        await this.innerCheckpoint('before-heal');
        await t?.beforeHeal?.(f);
      },
      healCandidate: (c) => {
        if (live()) t?.healCandidate?.(c);
      },
      healNote: (m) => {
        if (live()) t?.healNote?.(m);
      },
    };
  }

  private async innerCheckpoint(phase: PausePhase): Promise<void> {
    if (this.debug && this.currentStep) await this.debug.checkpoint({ phase, index: this.currentIndex, step: this.currentStep });
  }

  /** Run one journey step with debugger checkpoints and trace capture. */
  async runStep(index: number, original: Step, exec: (step: Step) => Promise<StepResult>, actor?: string): Promise<StepResult> {
    const dbg = this.debug;
    let { step, edited } = dbg ? dbg.stepAt(index, original) : { step: original, edited: false };
    this.currentIndex = index;
    this.currentStep = step;
    if (dbg) {
      const cmd = await dbg.checkpoint({ phase: 'before-step', index, step, ...(actor ? { actor } : {}) });
      ({ step, edited } = dbg.stepAt(index, original));
      if (cmd.kind === 'skip') return this.skip(index, step, 'skipped in the debugger');
    }
    for (let execution = 1; ; execution++) {
      this.currentStep = step;
      if (dbg && step.value !== undefined && SENSITIVE_DESC.test(step.target?.description ?? '')) dbg.learnSecret(interpolate(step.value, this.j.vars()));
      this.trace?.beginStep(index, step, execution, edited, (s) => interpolate(s, this.j.vars()));
      dbg?.stepStarted(index, step, actor);
      const sr = await exec(step);
      await this.trace?.endStep(sr);
      dbg?.stepFinished(index, step, sr);
      if (dbg && sr.status === 'failed') {
        const cmd = await dbg.checkpoint({ phase: 'failed', index, step, result: sr, ...(actor ? { actor } : {}) });
        if (cmd.kind === 'retry') {
          ({ step, edited } = dbg.stepAt(index, original));
          continue;
        }
        if (cmd.kind === 'skip') return this.skip(index, step, `skipped in the debugger after failing: ${sr.error?.message ?? 'failed'}`);
      }
      return sr;
    }
  }

  /**
   * A code `step()` group (eztest/sdk): a debugger checkpoint before it (breakpoints on its line,
   * step-over) and a notice when it ends. Its children go through runStep themselves.
   */
  group(index: number, step: Step): { before(): Promise<'continue' | 'skip'>; after(result: StepResult): void } {
    const dbg = this.debug;
    return {
      before: async () => {
        if (!dbg) return 'continue';
        this.currentIndex = index;
        this.currentStep = step;
        const cmd = await dbg.checkpoint({ phase: 'before-step', index, step });
        if (cmd.kind === 'skip') {
          dbg.stepSkipped(index, step);
          return 'skip';
        }
        dbg.stepStarted(index, step);
        return 'continue';
      },
      after: (result) => dbg?.stepFinished(index, step, result),
    };
  }

  /**
   * The journey's current tab changed (a popup or new tab became current):
   * step hooks, trace capture, screencast and debugger follow it.
   */
  followPage(page: Page): void {
    if (this.pages.has(page)) {
      if (page === this.currentPage) return;
    } else {
      this.pages.add(page);
      setStepHooks(page, this.hooks());
    }
    this.currentPage = page;
    this.trace?.followPage(page);
    this.debug?.switchPage(page);
  }

  private readonly pages = new Set<Page>();
  private currentPage?: Page;

  private skip(index: number, step: Step, reason: string): StepResult {
    const sr = skippedStep(step, reason);
    this.trace?.recordSkipped(index, step, sr);
    this.debug?.stepSkipped(index, step);
    return sr;
  }

  private async runAdHoc(step: Step, commit: boolean): Promise<StepResult> {
    const base = this.j.ctxFor(step);
    let ctx: StepContext = base;
    if (!commit) {
      const ledger = new Ledger();
      for (const [k, v] of Object.entries(this.j.ledger.view())) ledger.set(k, v);
      const vars = () => ({ ...base.vars(), ...ledger.view() });
      ctx = { ...base, ledger, vars, interpolate: (s: string) => interpolate(s, vars()) };
    }
    // A scratch fingerprint store: ad-hoc steps never teach the healer.
    const scratch = await FingerprintStore.open(join(this.run.runDir, '.debug-scratch-fingerprints.json'));
    const t0 = Date.now();
    const startedAt = nowIso();
    this.suspended = true;
    try {
      const core = await executeStepCore(step, ctx, { ...this.j.runtime, store: scratch });
      return { stepId: step.id, intent: step.intent, startedAt, durationMs: Date.now() - t0, ...core };
    } catch (e) {
      const err = e as Error;
      return { stepId: step.id, intent: step.intent, status: 'failed', startedAt, durationMs: Date.now() - t0, conditions: [], evidence: [], error: { message: err.message.split('\n')[0], name: err.name } };
    } finally {
      this.suspended = false;
    }
  }

  /** The attempt ended: write the trace, release the page. */
  async finish(result: JourneyResult): Promise<void> {
    clearStepHooks(this.j.page);
    for (const p of this.pages) clearStepHooks(p);
    this.debug?.detach();
    if (this.trace) {
      try {
        const id = await this.trace.finish(result);
        if (id) result.evidence.push(id);
      } catch (e) {
        this.run.logger.warn('could not write time-travel trace', { journeyId: this.j.journey.id, message: (e as Error).message });
      }
    }
  }
}
