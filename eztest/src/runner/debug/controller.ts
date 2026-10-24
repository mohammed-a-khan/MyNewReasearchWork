/**
 * DebugController: the live step debugger. Pass one as `RunOptions.debug`
 * (the run is then forced to concurrency 1). The runner calls its checkpoints
 * before every step, before post-condition verification and healing (when
 * stepping into), and when a step fails; the controller decides whether to
 * pause and resumes with a command. While paused, the current or an upcoming
 * step can be replaced (edit-and-continue), retried or skipped, an ad-hoc
 * step can be evaluated against the live page, and the page can be inspected
 * (element picker, locator validation, input forwarding).
 *
 * Breakpoint conditions use the declarative post-condition model; nothing is
 * ever evaluated as code.
 */
import type { BrowserContext, Page } from '../../browser/index.js';
import { setPauseHandler } from '../../browser/pause.js';
import {
  Condition,
  EzTestError,
  Step,
  nowIso,
  type DebugEvent,
  type EventBus,
  type Journey,
  type StepInput,
  type StepResult,
} from '../../core/index.js';
import { evaluateConditionOnce, type ConditionEnv } from '../conditions.js';
import { SENSITIVE_DESC } from '../trace/recorder.js';
import { REDACTED, Redactor } from '../trace/redact.js';
import { dispatchInput, type InputEvent } from './input.js';
import { clearHighlights, pickElement, validateLocator, type PickOptions, type PickResult, type ValidateInput, type ValidateResult } from './picker.js';
import { parseStepText } from './parse.js';

export type PausePhase = 'before-step' | 'before-verify' | 'before-heal' | 'failed';

export interface BreakpointInput {
  /** Journey the breakpoint applies to (default: any). */
  journeyId?: string;
  /** Zero-based step index ... */
  stepIndex?: number;
  /** ... or step id ... */
  stepId?: string;
  /** ... or a source line of a code journey (eztest/sdk): pauses before a `ui.*`, `step()` ... call on that line. */
  line?: number;
  /** With `line`: the file (absolute, or a suffix such as "orders.journey.ts"); default any file. */
  file?: string;
  /** Pause only when this declarative condition holds on the live page/ledger. */
  condition?: Condition;
  enabled?: boolean;
}

export interface Breakpoint extends BreakpointInput {
  id: string;
  enabled: boolean;
  hits: number;
}

export interface DebugControllerOptions {
  /** Events go here as well as to the run's EventBus. */
  events?: EventBus;
  /** Pause before a failing step fails the journey. Default true. */
  pauseOnFailure?: boolean;
  /** Pause before the very first step. Default false. */
  pauseAtStart?: boolean;
  breakpoints?: BreakpointInput[];
  /** Masks secrets in state reads and events (config SecretMasker). */
  masker?: { mask(text: string): string };
}

/** What the runner exposes about the journey attempt being debugged. */
export interface DebugJourneySession {
  journey: Journey;
  attempt: number;
  page: Page;
  context: BrowserContext;
  ledger(): Record<string, unknown>;
  vars(): Record<string, unknown>;
  conditionEnv(): ConditionEnv;
  /** Run a step against the live page, outside the journey. */
  runAdHoc(step: Step, opts: { commit: boolean }): Promise<StepResult>;
}

export interface Checkpoint {
  phase: PausePhase;
  index: number;
  step: Step;
  result?: StepResult;
  /** Multi-actor journeys: the actor whose session runs the step. */
  actor?: string;
}

export type DebugCommand = { kind: 'continue' } | { kind: 'retry' } | { kind: 'skip' };

export interface DebugState {
  status: 'idle' | 'running' | 'paused' | 'finished';
  journeyId?: string;
  journeyName?: string;
  attempt?: number;
  stepIndex?: number;
  stepId?: string;
  intent?: string;
  /** Multi-actor journeys: the actor of the current step (its browser is the one shown). */
  actor?: string;
  phase?: PausePhase;
  reason?: string;
  pausedAt?: string;
  url?: string;
  vars?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  /** The failed result when paused on failure. */
  lastResult?: StepResult;
  /** Source location of the current step (code journeys: the line of the SDK call). */
  source?: { file: string; line: number };
  /** The journey is a code journey (eztest/sdk): breakpoints by line, no edit-and-continue. */
  code?: { file: string; name: string; line?: number };
  steps?: Array<{ index: number; id: string; intent: string; edited: boolean }>;
  breakpoints: Breakpoint[];
  pauseOnFailure: boolean;
}

export interface EvaluateOptions {
  /** Keep ledger changes (captures) in the journey. Default false. */
  commit?: boolean;
}

/** A command arrived in a state that does not allow it. */
export class DebugStateError extends EzTestError {
  readonly status = 409;
  constructor(message: string) {
    super(message, 'DEBUG_STATE');
    this.name = 'DebugStateError';
  }
}

interface Paused {
  cp: Checkpoint;
  reason: string;
  at: string;
  resolve(cmd: DebugCommand): void;
}

export class DebugController {
  pauseOnFailure: boolean;
  private readonly bps = new Map<string, Breakpoint>();
  private bpSeq = 0;
  private mode: 'run' | 'stepOver' | 'stepInto' = 'run';
  private pauseRequested: boolean;
  private runTo?: { journeyId?: string; stepIndex?: number; stepId?: string; line?: number; file?: string };
  private paused?: Paused;
  private session?: DebugJourneySession;
  private readonly overrides = new Map<number, Step>();
  private readonly editedIdx = new Set<number>();
  private status: 'idle' | 'running' | 'finished' = 'idle';
  private runBus?: EventBus;
  private waiters: Array<{ resolve(s: DebugState): void; reject(e: Error): void }> = [];
  private finishWaiters: Array<() => void> = [];
  private readonly pageListeners = new Set<(page: Page | undefined) => void>();
  private evalChain: Promise<unknown> = Promise.resolve();
  private readonly redactor: Redactor;
  private currentIndex = -1;
  private currentActor?: string;
  private currentStep?: Step;
  /** page.pause() asked for a pause at this checkpoint. */
  private pageRequestedPause = false;

  constructor(private readonly opts: DebugControllerOptions = {}) {
    this.pauseOnFailure = opts.pauseOnFailure ?? true;
    this.pauseRequested = opts.pauseAtStart ?? false;
    this.redactor = new Redactor(opts.masker);
    for (const b of opts.breakpoints ?? []) this.addBreakpoint(b);
  }

  // ------------------------------------------------------------ breakpoints

  addBreakpoint(input: BreakpointInput): Breakpoint {
    if (input.stepIndex === undefined && input.stepId === undefined && input.line === undefined) throw new EzTestError('A breakpoint needs stepIndex, stepId or line', 'BAD_BREAKPOINT');
    if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) throw new EzTestError('line must be a positive integer', 'BAD_BREAKPOINT');
    if (input.stepIndex !== undefined && (!Number.isInteger(input.stepIndex) || input.stepIndex < 0)) throw new EzTestError('stepIndex must be a non-negative integer', 'BAD_BREAKPOINT');
    const condition = input.condition ? Condition.parse(input.condition) : undefined;
    const bp: Breakpoint = { ...input, ...(condition ? { condition } : {}), id: `bp-${++this.bpSeq}`, enabled: input.enabled ?? true, hits: 0 };
    this.bps.set(bp.id, bp);
    return bp;
  }

  removeBreakpoint(id: string): boolean {
    return this.bps.delete(id);
  }

  clearBreakpoints(): void {
    this.bps.clear();
  }

  get breakpoints(): Breakpoint[] {
    return [...this.bps.values()].map((b) => ({ ...b }));
  }

  // ------------------------------------------------------------ control

  get isPaused(): boolean {
    return this.paused !== undefined;
  }

  /** The live page of the journey being debugged. */
  get page(): Page | undefined {
    return this.session?.page;
  }

  /** Pause at the next checkpoint. */
  pause(): void {
    if (!this.paused) this.pauseRequested = true;
  }

  resume(): void {
    this.mode = 'run';
    this.release({ kind: 'continue' }, 'resume');
  }

  /** Never pause again: drop breakpoints, run-to targets and pause-on-failure, and resume. */
  disarm(): void {
    this.bps.clear();
    this.runTo = undefined;
    this.pauseOnFailure = false;
    this.pauseRequested = false;
    this.resume();
  }

  /** Run the current step, pause before the next one. */
  stepOver(): void {
    this.mode = 'stepOver';
    this.release({ kind: 'continue' }, 'stepOver');
  }

  /** Pause at the next checkpoint, including before verification and before healing. */
  stepInto(): void {
    this.mode = 'stepInto';
    this.release({ kind: 'continue' }, 'stepInto');
  }

  /** Continue and pause before the given step (or, in a code journey, before the next SDK call on a line). */
  runToStep(where: { journeyId?: string; stepIndex?: number; stepId?: string; line?: number; file?: string }): void {
    if (where.stepIndex === undefined && where.stepId === undefined && where.line === undefined) throw new EzTestError('runToStep needs stepIndex, stepId or line', 'BAD_COMMAND');
    this.runTo = where;
    this.mode = 'run';
    if (this.paused) this.release({ kind: 'continue' }, 'runToStep');
  }

  /** Re-run the current step (paused on failure or before it), optionally replaced. */
  retry(step?: Step | StepInput | string): void {
    const p = this.requirePaused(['failed', 'before-step'], 'retry');
    if (step !== undefined) this.replaceStep(step, { index: p.cp.index });
    this.mode = 'run';
    this.release({ kind: p.cp.phase === 'failed' ? 'retry' : 'continue' }, 'retry');
  }

  /** Skip the current step (paused on failure or before it). */
  skip(): void {
    this.requirePaused(['failed', 'before-step'], 'skip');
    this.mode = 'run';
    this.release({ kind: 'skip' }, 'skip');
  }

  /**
   * Edit-and-continue: replace the current (when paused before it or on its
   * failure) or an upcoming step. Text is parsed as an `.ez` step line
   * (Expect lines may follow on the next lines). The step keeps its id.
   */
  replaceStep(input: Step | StepInput | string, opts: { index?: number } = {}): Step {
    const s = this.requireSession();
    if (s.journey.code) throw new DebugStateError('Edit-and-continue works for .ez, YAML and JSON journeys only; this is a code journey (edit the TypeScript file and run again)');
    const index = opts.index ?? (this.paused ? this.paused.cp.index : this.currentIndex + 1);
    if (!Number.isInteger(index) || index < 0 || index >= s.journey.steps.length) throw new EzTestError(`No step ${index} in journey ${s.journey.id}`, 'BAD_COMMAND');
    const min = this.paused && (this.paused.cp.phase === 'before-step' || this.paused.cp.phase === 'failed') ? this.paused.cp.index : this.currentIndex + 1;
    if (index < min) throw new DebugStateError(`Step ${index} already ran or is running; only the current or upcoming steps can be edited`);
    const original = this.overrides.get(index) ?? s.journey.steps[index];
    const parsed = typeof input === 'string' ? parseStepText(input) : Step.parse(input);
    const step = Step.parse({ ...parsed, id: typeof input === 'object' && 'id' in input && input.id ? input.id : original.id });
    this.overrides.set(index, step);
    this.editedIdx.add(index);
    this.emit({ type: 'debug.stepEdited', journeyId: s.journey.id, stepIndex: index, stepId: step.id, intent: this.redactor.mask(step.intent) });
    return step;
  }

  /** Run one step against the live page without adding it to the journey (a step "console"). */
  async evaluate(input: Step | StepInput | string, opts: EvaluateOptions = {}): Promise<StepResult> {
    this.requirePaused(undefined, 'evaluate');
    const s = this.requireSession();
    const parsed = typeof input === 'string' ? parseStepText(input) : Step.parse(input);
    const step = Step.parse({ ...parsed, id: `adhoc-${parsed.id}` });
    const run = this.evalChain.then(() => s.runAdHoc(step, { commit: opts.commit ?? false }));
    this.evalChain = run.catch(() => undefined);
    const r = await run;
    const masked = this.redactor.deep(r);
    this.emit({ type: 'debug.evaluated', journeyId: s.journey.id, stepId: step.id, intent: this.redactor.mask(step.intent), status: r.status });
    return masked;
  }

  // ------------------------------------------------------------ inspection

  state(): DebugState {
    const s = this.session;
    const p = this.paused;
    const R = this.redactor;
    const base: DebugState = {
      status: p ? 'paused' : this.status,
      breakpoints: this.breakpoints,
      pauseOnFailure: this.pauseOnFailure,
    };
    if (!s) return base;
    const steps = s.journey.steps.map((st, i) => {
      const o = this.overrides.get(i) ?? st;
      let intent = R.mask(o.intent);
      // Upcoming values for password-like fields are not known secrets yet: hide them by shape.
      if (o.value && o.value.length >= 3 && SENSITIVE_DESC.test(o.target?.description ?? '')) intent = intent.split(o.value).join(REDACTED);
      return { index: i, id: o.id, intent, edited: this.editedIdx.has(i) };
    });
    let url: string | undefined;
    try {
      url = R.url(s.page.url());
    } catch {
      url = undefined;
    }
    const cur = p?.cp ?? (this.currentIndex >= 0 ? { index: this.currentIndex, step: this.overrides.get(this.currentIndex) ?? s.journey.steps[this.currentIndex] } : undefined);
    return {
      ...base,
      journeyId: s.journey.id,
      journeyName: s.journey.name,
      attempt: s.attempt,
      ...(cur ? { stepIndex: cur.index, stepId: cur.step?.id, intent: cur.step ? R.mask(cur.step.intent) : undefined } : {}),
      ...((p?.cp.actor ?? this.currentActor) ? { actor: p?.cp.actor ?? this.currentActor } : {}),
      ...(cur?.step?.source ? { source: { file: cur.step.source.file, line: cur.step.source.line } } : {}),
      ...(s.journey.code ? { code: s.journey.code } : {}),
      ...(p ? { phase: p.cp.phase, reason: p.reason, pausedAt: p.at } : {}),
      ...(p?.cp.result ? { lastResult: R.deep(p.cp.result) } : {}),
      url,
      vars: R.deep(safeJson(s.vars())),
      ledger: R.deep(safeJson(s.ledger())),
      steps,
    };
  }

  /** Resolves with the state at the next pause (immediately if paused). Rejects when the run finishes first. */
  waitForPause(timeoutMs = 30_000): Promise<DebugState> {
    if (this.paused) return Promise.resolve(this.state());
    if (this.status === 'finished') return Promise.reject(new Error('The debug run has finished'));
    return new Promise<DebugState>((resolve, reject) => {
      const w = {
        resolve: (st: DebugState) => {
          clearTimeout(timer);
          resolve(st);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`No pause within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Resolves when the debugged run has finished. */
  waitForFinish(): Promise<void> {
    if (this.status === 'finished') return Promise.resolve();
    return new Promise((r) => this.finishWaiters.push(r));
  }

  /** Called with the live page whenever it changes (journey attempt start/end). */
  onPage(listener: (page: Page | undefined) => void): () => void {
    this.pageListeners.add(listener);
    return () => this.pageListeners.delete(listener);
  }

  /** Ranked locator candidates for the element at a viewport point (paused only). */
  async pick(point: { x: number; y: number }, opts: PickOptions = {}): Promise<PickResult> {
    this.requirePaused(undefined, 'pick');
    return pickElement(this.requireSession().page, point, opts);
  }

  /** Count (and highlight) the elements a locator or `.ez` target matches (paused only). */
  async validate(input: ValidateInput, opts: { highlight?: boolean } = {}): Promise<ValidateResult> {
    this.requirePaused(undefined, 'validate');
    const s = this.requireSession();
    return validateLocator(s.page, input, { ...opts, vars: s.vars() });
  }

  /** Forward mouse/keyboard/wheel input to the live page (paused only). */
  async input(e: InputEvent): Promise<void> {
    this.requirePaused(undefined, 'input');
    await dispatchInput(this.requireSession().page, e);
  }

  // ------------------------------------------------------------ runner side (internal)

  /** @internal The run started; events also go to the run's bus. */
  runStarted(bus?: EventBus): void {
    this.runBus = bus;
    this.status = 'running';
  }

  /** @internal The run finished. */
  runFinished(): void {
    this.status = 'finished';
    this.paused = undefined;
    for (const w of this.waiters.splice(0)) w.reject(new Error('The debug run has finished'));
    for (const f of this.finishWaiters.splice(0)) f();
    this.emit({ type: 'debug.finished' });
  }

  /** Mask known and learned secrets in any JSON-like value (for hosts forwarding events). */
  maskDeep<T>(value: T): T {
    return this.redactor.deep(value);
  }

  /** @internal A value that must never show up in state or events (e.g. typed into a password field). */
  learnSecret(value: string | undefined): void {
    this.redactor.learn(value);
  }

  /** @internal A journey attempt is starting on a new page. */
  attach(session: DebugJourneySession): void {
    if (this.session && this.session.context !== session.context) setPauseHandler(this.session.context, undefined);
    this.session = session;
    // page.pause() in this journey's pages pauses the debugger right there.
    setPauseHandler(session.context, () => this.pauseHere());
    this.overrides.clear();
    this.editedIdx.clear();
    this.currentIndex = -1;
    this.emit({ type: 'debug.attached', journeyId: session.journey.id, attempt: session.attempt });
    for (const l of this.pageListeners) safe(() => l(session.page));
  }

  /** @internal The journey's current tab changed (popup / new tab): inspect, pick and screencast the new one. */
  switchPage(page: Page): void {
    const s = this.session;
    if (!s || s.page === page) return;
    s.page = page;
    for (const l of this.pageListeners) safe(() => l(page));
  }

  /** @internal The journey attempt ended. */
  detach(): void {
    const s = this.session;
    if (!s) return;
    setPauseHandler(s.context, undefined);
    this.emit({ type: 'debug.detached', journeyId: s.journey.id, attempt: s.attempt });
    for (const l of this.pageListeners) safe(() => l(undefined));
    this.session = undefined;
  }

  /** @internal The step to run at `index` (an edit if one was made) and whether it was edited. */
  stepAt(index: number, original: Step): { step: Step; edited: boolean } {
    const o = this.overrides.get(index);
    return o ? { step: o, edited: true } : { step: original, edited: false };
  }

  /** @internal */
  stepStarted(index: number, step: Step, actor?: string): void {
    this.currentIndex = index;
    this.currentStep = step;
    this.currentActor = actor;
    this.emit({ type: 'debug.stepStarted', journeyId: this.session?.journey.id ?? '', stepIndex: index, stepId: step.id, intent: this.redactor.mask(step.intent), ...(actor ? { actor } : {}) });
  }

  /** @internal */
  stepFinished(index: number, step: Step, result: StepResult): void {
    this.emit({ type: 'debug.stepFinished', journeyId: this.session?.journey.id ?? '', stepIndex: index, stepId: step.id, status: result.status, durationMs: result.durationMs });
  }

  /** @internal */
  stepSkipped(index: number, step: Step): void {
    this.emit({ type: 'debug.stepSkipped', journeyId: this.session?.journey.id ?? '', stepIndex: index, stepId: step.id });
  }

  /** @internal Decide whether to pause here; resolves with the user's command. */
  async checkpoint(cp: Checkpoint): Promise<DebugCommand> {
    const reason = await this.pauseReason(cp);
    if (!reason) return { kind: 'continue' };
    this.mode = 'run';
    this.pauseRequested = false;
    return new Promise<DebugCommand>((resolve) => {
      this.paused = { cp, reason, at: nowIso(), resolve };
      const s = this.session;
      this.emit({
        type: 'debug.paused', journeyId: s?.journey.id ?? '', stepIndex: cp.index, stepId: cp.step.id, phase: cp.phase, reason,
        intent: this.redactor.mask(cp.step.intent), ...(cp.result?.error ? { error: this.redactor.mask(cp.result.error.message) } : {}),
        ...(cp.actor ? { actor: cp.actor } : {}),
      });
      const st = this.state();
      for (const w of this.waiters.splice(0)) w.resolve(st);
    });
  }

  /** @internal page.pause() inside the debugged journey: pause right here (mid-step) until resumed. */
  async pauseHere(): Promise<void> {
    const step = this.currentStep;
    if (!this.session || !step) throw new DebugStateError('page.pause(): no journey step is running under the debugger');
    this.pageRequestedPause = true;
    await this.checkpoint({ phase: 'before-verify', index: this.currentIndex, step, ...(this.currentActor ? { actor: this.currentActor } : {}) });
  }

  private async pauseReason(cp: Checkpoint): Promise<string | undefined> {
    if (this.pageRequestedPause) {
      this.pageRequestedPause = false;
      return 'page.pause()';
    }
    if (cp.phase === 'failed') return this.pauseOnFailure ? 'failure' : undefined;
    if (this.pauseRequested) return 'pause';
    if (this.mode === 'stepInto') return 'step';
    if (cp.phase !== 'before-step') return undefined;
    if (this.mode === 'stepOver') return 'step';
    const jid = this.session?.journey.id;
    const rt = this.runTo;
    if (rt && (rt.journeyId === undefined || rt.journeyId === jid) && (rt.line !== undefined ? sameLine(rt, cp.step) : rt.stepIndex === cp.index || rt.stepId === cp.step.id)) {
      this.runTo = undefined;
      return 'runToStep';
    }
    for (const bp of this.bps.values()) {
      if (!bp.enabled) continue;
      if (bp.journeyId !== undefined && bp.journeyId !== jid) continue;
      if (bp.line !== undefined) {
        if (!sameLine(bp, cp.step)) continue;
      } else if (bp.stepIndex !== undefined ? bp.stepIndex !== cp.index : bp.stepId !== cp.step.id) continue;
      if (bp.condition && this.session) {
        const r = await evaluateConditionOnce(bp.condition, this.session.conditionEnv()).catch(() => undefined);
        if (!r?.passed) continue;
      }
      bp.hits++;
      return `breakpoint ${bp.id}`;
    }
    return undefined;
  }

  private release(cmd: DebugCommand, command: string): void {
    const p = this.paused;
    if (!p) {
      // Not paused: stepOver/stepInto/runToStep take effect at the next checkpoint; resume cancels a pending pause.
      if (command === 'resume') this.pauseRequested = false;
      return;
    }
    this.paused = undefined;
    const page = this.session?.page;
    if (page) void clearHighlights(page).catch(() => undefined);
    this.emit({ type: 'debug.resumed', journeyId: this.session?.journey.id ?? '', stepIndex: p.cp.index, command });
    p.resolve(cmd);
  }

  private requirePaused(phases: PausePhase[] | undefined, what: string): Paused {
    const p = this.paused;
    if (!p) throw new DebugStateError(`Cannot ${what}: the debugger is not paused`);
    if (phases && !phases.includes(p.cp.phase)) throw new DebugStateError(`Cannot ${what} while paused ${p.cp.phase}`);
    return p;
  }

  private requireSession(): DebugJourneySession {
    if (!this.session) throw new DebugStateError('No journey is being debugged');
    return this.session;
  }

  private emit(e: DebugEvent): void {
    this.opts.events?.emit(e);
    if (this.runBus && this.runBus !== this.opts.events) this.runBus.emit(e);
  }
}

/** A line breakpoint matches a step created on that line (of that file, when given). */
function sameLine(bp: BreakpointInput, step: Step): boolean {
  const src = step.source;
  if (!src || src.line !== bp.line) return false;
  if (!bp.file) return true;
  const norm = (f: string) => f.replace(/\\/g, '/');
  return norm(src.file) === norm(bp.file) || norm(src.file).endsWith(`/${norm(bp.file).replace(/^\/+/, '')}`);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // listeners never break the debugger
  }
}

function safeJson(v: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(v ?? {})) as Record<string, unknown>;
  } catch {
    return {};
  }
}
