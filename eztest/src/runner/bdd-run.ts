/**
 * Running a Gherkin scenario (a journey loaded from a `.feature` file).
 *
 * Each Gherkin step becomes one top-level step result, in order:
 *  - a matching step definition (eztest/bdd) runs as a reported group whose
 *    children are its SDK calls (ui, api, db, expect ...), through the same
 *    runner path as code journeys: strict locating, healing, evidence, trace
 *    and the debugger;
 *  - a step without a definition whose text is an EZTest phrasing runs as
 *    that EZTest step (the plain-English fallback);
 *  - otherwise the step fails as undefined (with a snippet to paste) or
 *    ambiguous (listing the definitions that match).
 *
 * Before hooks run first (a failure skips the steps), After hooks always run
 * last, BeforeStep / AfterStep hooks run inside each step. Steps after a
 * failed step are skipped. Each scenario attempt gets a fresh World.
 */
import { relative, sep } from 'node:path';
import { nowIso, type GherkinStepRecord, type Journey, type JourneyBddRecord, type Step, type StepResult } from '../core/index.js';
import { DataTable } from '../bdd/datatable.js';
import { ezFallback } from '../bdd/fallback.js';
import { loadGlue } from '../bdd/load.js';
import { hooksFor, matchStep, type BddContext, type Glue, type HookDefinition, type HookResult, type ScenarioInfo, type StepInfo } from '../bdd/registry.js';
import { snippet } from '../bdd/snippets.js';
import { sdk } from '../sdk/journey.js';
import { openCodeHost, type CodeHostHandle } from './code-host.js';
import type { FlowEnv, FlowScope } from './flow.js';
import { skippedStep } from './step.js';

interface BddStepArgs {
  keyword: string;
  type: 'context' | 'action' | 'outcome';
  background?: boolean;
  docString?: { content: string; mediaType?: string; line: number };
  dataTable?: string[][];
  empty?: boolean;
}

type Outcome = { steps: StepResult[]; status: 'passed' | 'passed-healed' | 'failed' | 'skipped'; error?: { message: string; name?: string } };

const rel = (file: string, base: string) => {
  const r = relative(base, file);
  return (r && !r.startsWith('..') ? r : file).split(sep).join('/');
};

/** Where a Gherkin journey's result belongs in the feature / rule / scenario hierarchy. */
export function bddRecord(journey: Journey, baseDir: string = process.cwd()): JourneyBddRecord | undefined {
  const b = journey.bdd;
  if (!b) return undefined;
  return {
    file: rel(b.uri, baseDir),
    feature: { name: b.feature.name, line: b.feature.line },
    ...(b.rule ? { rule: { name: b.rule.name, line: b.rule.line } } : {}),
    scenario: { name: b.scenario.name, line: b.scenario.line, keyword: b.scenario.keyword },
    ...(b.examples ? { examples: { name: b.examples.name, line: b.examples.line, ...(b.examples.row ? { row: b.examples.row } : {}) } } : {}),
  };
}

function annotate(h: CodeHostHandle, before: number, g: GherkinStepRecord): StepResult | undefined {
  if (h.results.length <= before) return undefined;
  const r = h.results[h.results.length - 1];
  r.gherkin = { ...g, ...(r.gherkin ?? {}) };
  return r;
}

const failedHard = (r: StepResult | undefined) => !!r && ((r.status === 'failed' && !r.soft) || r.status === 'blocked');

function withTimeout<T>(p: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return p;
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_r, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Run one attempt of a Gherkin scenario. */
export async function runBddScenario(journey: Journey, scope: FlowScope, flow: FlowEnv): Promise<Outcome> {
  const b = journey.bdd!;
  const file = b.uri;
  const baseDir = flow.opts.baseDir ?? process.cwd();
  const h = openCodeHost(scope, flow, file);
  const steps = journey.steps;
  const info = (s: Step): GherkinStepRecord => {
    const a = (s.args ?? {}) as unknown as BddStepArgs;
    return { kind: 'step', keyword: a.keyword, text: s.value ?? '', line: s.source?.line ?? 0, ...(a.background ? { background: true } : {}) };
  };

  // ---------------------------------------------------------------- step definitions
  let glue: Glue;
  try {
    glue = await loadGlue(b.glue, { cwd: baseDir });
  } catch (e) {
    glue = { steps: [], hooks: [], params: undefined as unknown as Glue['params'], errors: [(e as Error).message] };
  }
  if (glue.errors.length) {
    const message = `Step definitions could not be loaded: ${glue.errors.join('; ')}`;
    const res: StepResult[] = [
      { stepId: 'step-definitions', intent: 'Load step definitions', status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { message, name: 'StepDefinitionError' } },
      ...steps.map((s) => ({ ...skippedStep(s, 'not run: step definitions could not be loaded'), gherkin: info(s) })),
    ];
    return { steps: res, status: 'failed', error: { message, name: 'StepDefinitionError' } };
  }

  const tags = journey.tags;
  const scenario: ScenarioInfo = {
    name: journey.name, tags: tags.map((t) => `@${t}`), feature: b.feature.name, ...(b.rule ? { rule: b.rule.name } : {}),
    uri: file, line: b.scenario.line, ...(Object.keys(journey.variables).length && b.examples ? { example: { ...journey.variables } } : {}),
  };
  const world: Record<string, unknown> = glue.world ? (new glue.world({ parameters: b.worldParameters ?? {} }) as Record<string, unknown>) : {};
  const attach = (name: string, content: string | Uint8Array, description?: string) => h.host.evidence('data', name, content, description ?? `attachment ${name}`);
  const ctxFor = (extra: Partial<BddContext> = {}): BddContext => ({ ...sdk, world, scenario, attach, ...extra });
  const label = (hk: HookDefinition, kind: string) => `${kind} hook${hk.name ? `: ${hk.name}` : ''} (${rel(hk.file, baseDir)}:${hk.line})`;
  const scenarioResult = (): HookResult => {
    const bad = h.results.find((r) => r.status === 'failed' || r.status === 'blocked');
    return bad ? { status: 'failed', ...(bad.error ? { error: { message: bad.error.message } } : {}) } : { status: h.results.some((r) => r.status === 'passed-healed') ? 'passed-healed' : 'passed' };
  };

  const runHook = async (hk: HookDefinition, kind: 'before' | 'after'): Promise<StepResult | undefined> => {
    const before = h.results.length;
    try {
      await h.group(label(hk, kind === 'before' ? 'Before' : 'After'), async () => {
        await hk.fn.call(world, { ...ctxFor(), ...(kind === 'after' ? { result: scenarioResult() } : {}) });
      }, { file: hk.file, line: hk.line });
    } catch {
      // recorded as the hook's failure
    }
    return annotate(h, before, { kind, line: hk.line, match: 'hook', location: `${rel(hk.file, baseDir)}:${hk.line}` });
  };

  const stepHooks = (kind: 'beforeStep' | 'afterStep') => hooksFor(glue, kind, tags);
  const beforeStep = stepHooks('beforeStep');
  const afterStep = stepHooks('afterStep');
  const runStepHooks = async (list: HookDefinition[], ctx: BddContext, result?: HookResult) => {
    for (const hk of list) await hk.fn.call(world, { ...ctx, ...(result ? { result } : {}) });
  };

  const runStep = async (s: Step): Promise<StepResult | undefined> => {
    const a = (s.args ?? {}) as unknown as BddStepArgs;
    const g = info(s);
    const text = s.value ?? '';
    const source = s.source ? { file: s.source.file, line: s.source.line } : undefined;
    const before = h.results.length;
    if (a.empty) {
      h.results.push({ stepId: s.id, intent: s.intent, status: 'passed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], warnings: ['the scenario has no steps'] });
      return annotate(h, before, g);
    }
    const gStep: StepInfo = { keyword: a.keyword, text, line: g.line, type: a.type };
    const dataTable = a.dataTable ? new DataTable(a.dataTable) : undefined;
    const docString = a.docString ? { content: a.docString.content, ...(a.docString.mediaType ? { mediaType: a.docString.mediaType } : {}) } : undefined;
    const ctx = ctxFor({ gherkinStep: gStep, ...(dataTable ? { dataTable } : {}), ...(docString ? { docString } : {}) });
    const matches = matchStep(glue, text, world);

    if (matches.length > 1) {
      const list = matches.map((m) => `  ${String(m.definition.pattern)} (${rel(m.definition.file, baseDir)}:${m.definition.line})`).join('\n');
      h.results.push({
        stepId: s.id, intent: s.intent, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [],
        error: { name: 'AmbiguousStep', message: `Ambiguous step "${text}": ${matches.length} step definitions match:\n${list}\nMake the patterns more specific or remove one.` },
      });
      return annotate(h, before, { ...g, match: 'ambiguous', location: matches.map((m) => `${rel(m.definition.file, baseDir)}:${m.definition.line}`).join(', ') });
    }

    if (matches.length === 1) {
      const { definition: d } = matches[0];
      let args: unknown[];
      try {
        args = await Promise.all(matches[0].args);
      } catch (e) {
        h.results.push({ stepId: s.id, intent: s.intent, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [], error: { name: 'ParameterError', message: `A parameter of "${text}" could not be converted: ${(e as Error).message}` } });
        return annotate(h, before, { ...g, match: 'definition', location: `${rel(d.file, baseDir)}:${d.line}`, pattern: String(d.pattern) });
      }
      const extra = dataTable ? [dataTable] : docString ? [docString.content] : [];
      try {
        await h.group(s.intent, async () => {
          await runStepHooks(beforeStep, ctx);
          let err: unknown;
          try {
            await withTimeout(Promise.resolve(d.fn.call(world, ctx, ...args, ...extra)), d.options.timeout, `Step "${text}"`);
          } catch (e) {
            err = e;
          }
          await runStepHooks(afterStep, ctx, err ? { status: 'failed', error: { message: (err as Error).message ?? String(err) } } : { status: 'passed' });
          if (err) throw err;
        }, source);
      } catch {
        // recorded as the step's failure
      }
      return annotate(h, before, { ...g, match: 'definition', location: `${rel(d.file, baseDir)}:${d.line}`, pattern: String(d.pattern) });
    }

    const fb = b.fallback ? ezFallback({ text, type: a.type, ...(docString ? { docString } : {}), ...(a.dataTable ? { dataTable: a.dataTable } : {}) }) : undefined;
    if (fb) {
      const mark = { ...g, match: 'ez' as const, location: fb.rule };
      try {
        if (fb.steps.length === 1 && !beforeStep.length && !afterStep.length) {
          await h.exec({ ...fb.steps[0], id: s.id, intent: s.intent }, source ? { source } : {});
        } else {
          await h.group(s.intent, async () => {
            await runStepHooks(beforeStep, ctx);
            let err: unknown;
            try {
              for (let i = 0; i < fb.steps.length; i++) await h.exec({ ...fb.steps[i], id: `${s.id}-${i + 1}`, intent: fb.lines[i] }, source ? { source } : {});
            } catch (e) {
              err = e;
            }
            await runStepHooks(afterStep, ctx, err ? { status: 'failed', error: { message: (err as Error).message ?? String(err) } } : { status: 'passed' });
            if (err) throw err;
          }, source);
        }
      } catch {
        // recorded as the step's failure
      }
      return annotate(h, before, mark);
    }

    const snip = snippet({ text, type: a.type, hasDataTable: !!a.dataTable, hasDocString: !!a.docString }, glue.params);
    h.results.push({
      stepId: s.id, intent: s.intent, status: 'failed', startedAt: nowIso(), durationMs: 0, conditions: [], evidence: [],
      error: {
        name: 'UndefinedStep',
        message: `Undefined step "${text}": no step definition matches${b.fallback ? ' and it is not an EZTest phrasing' : ''}. Add a step definition:\n\n${snip}`,
      },
    });
    return annotate(h, before, { ...g, match: 'undefined', snippet: snip });
  };

  await h.within(async () => {
    let blocked: string | undefined;
    for (const hk of hooksFor(glue, 'before', tags)) {
      if (flow.opts.signal?.aborted) break;
      const r = await runHook(hk, 'before');
      if (failedHard(r)) {
        blocked = `not run: ${r!.intent} failed`;
        break;
      }
    }
    for (const s of steps) {
      if (!blocked && flow.opts.signal?.aborted) blocked = 'not run: run cancelled';
      if (blocked) {
        h.results.push({ ...skippedStep(s, blocked), gherkin: info(s) });
        continue;
      }
      const r = await runStep(s);
      if (failedHard(r)) blocked = `not run: step "${s.intent}" ${r!.status}`;
    }
    // After hooks run even when a step failed (not when the run was cancelled).
    if (!flow.opts.signal?.aborted) for (const hk of hooksFor(glue, 'after', tags)) await runHook(hk, 'after');
  });

  const top = h.results;
  const hard = top.find(failedHard);
  const soft = top.find((r) => r.status === 'failed' && r.soft);
  const status: Outcome['status'] = hard || soft
    ? 'failed'
    : top.length && top.every((r) => r.status === 'skipped')
      ? 'skipped'
      : top.some((r) => r.status === 'passed-healed')
        ? 'passed-healed'
        : 'passed';
  const bad = hard ?? soft;
  return {
    steps: top,
    status,
    ...(bad ? { error: { message: `${bad.intent}: ${bad.error?.message.split('\n')[0] ?? bad.status}`, name: bad.error?.name ?? 'StepFailed' } } : {}),
  };
}
