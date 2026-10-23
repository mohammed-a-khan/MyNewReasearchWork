/**
 * Step definitions, hooks, parameter types and the World, as registered by
 * step definition files (`Given(...)`, `Before(...)`, `defineParameterType(...)`).
 *
 * The registry lives on `globalThis` (a `Symbol.for` key), like the SDK
 * runtime, so a step file that resolves `eztest/bdd` to another copy of this
 * module still registers with the runner that loads it. Registrations are
 * kept per loaded file, so a file that changed and is loaded again replaces
 * its own definitions.
 */
import { callSite } from '../sdk/callsite.js';
import { shared as sdkShared } from '../sdk/runtime.js';
import type { SdkContext } from '../sdk/types.js';
import type { DataTable } from './datatable.js';
import { ParameterTypeRegistry, stepExpression, type ParameterTypeSpec, type StepExpression } from './expressions.js';
import { parseTagExpression, evaluateTags, type TagExpression } from './tags.js';

/** What a scenario's steps and hooks share: one per scenario attempt. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type World = Record<string, any>;

export interface ScenarioInfo {
  /** The scenario's name (with the Examples row's values). */
  name: string;
  /** Inherited tags, with "@". */
  tags: string[];
  feature: string;
  rule?: string;
  /** Feature file (absolute) and line of the Scenario. */
  uri: string;
  line: number;
  /** The Examples row of an outline. */
  example?: Record<string, string>;
}

export interface StepInfo {
  keyword: string;
  text: string;
  line: number;
  type: 'context' | 'action' | 'outcome';
}

/** The first argument of every step definition and hook: EZTest's SDK plus the scenario's World. */
export interface BddContext<W = World> extends SdkContext {
  world: W;
  scenario: ScenarioInfo;
  /** The step being run (step definitions and step hooks). */
  gherkinStep?: StepInfo;
  /** The step's data table, also passed as the last argument. */
  dataTable?: DataTable;
  /** The step's doc string, also passed as the last argument. */
  docString?: { content: string; mediaType?: string };
  /** Attach text or a file to the report as evidence. */
  attach(name: string, content: string | Uint8Array, description?: string): Promise<string>;
}

/** What After / AfterStep hooks receive in addition. */
export interface HookResult {
  status: 'passed' | 'passed-healed' | 'failed' | 'skipped';
  error?: { message: string };
}

export type StepFn<W = World> = (this: W, ctx: BddContext<W>, ...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
export type HookFn<W = World> = (this: W, ctx: BddContext<W> & { result?: HookResult }) => unknown;

export interface StepDefinitionOptions {
  /** Step timeout for SDK calls inside (ms); default the run's step timeout. */
  timeout?: number;
}

export interface StepDefinition {
  /** `<file>:<line>` of the definition, unique. */
  id: string;
  keyword: 'Given' | 'When' | 'Then' | 'Step';
  pattern: string | RegExp;
  expression: StepExpression;
  fn: StepFn;
  options: StepDefinitionOptions;
  file: string;
  line: number;
}

export type HookKind = 'before' | 'after' | 'beforeStep' | 'afterStep' | 'beforeAll' | 'afterAll';

export interface HookOptions {
  /** Tag expression the scenario must match (`@db and not @readonly`). */
  tags?: string;
  /** Shown in reports ("Before hook: reset the database"). */
  name?: string;
  /** Lower runs first for Before hooks and last for After hooks (default 1000). */
  order?: number;
}

export interface HookDefinition {
  id: string;
  kind: HookKind;
  fn: HookFn;
  name?: string;
  tags?: string;
  tagExpression?: TagExpression;
  order: number;
  file: string;
  line: number;
  /** Registration order. */
  seq: number;
}

export type WorldConstructor = new (options: { parameters: Record<string, unknown> }) => unknown;

interface FileEntry {
  steps: StepDefinition[];
  hooks: HookDefinition[];
  params: ParameterTypeSpec[];
  world?: WorldConstructor;
}

interface BddShared {
  files: Map<string, FileEntry>;
  /** Definitions made outside a file load (tests, programmatic use). */
  inline: FileEntry;
  seq: number;
}

const KEY = Symbol.for('eztest.bdd.registry.v1');

export function bddShared(): BddShared {
  const g = globalThis as unknown as Record<symbol, BddShared | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { files: new Map(), inline: { steps: [], hooks: [], params: [] }, seq: 0 };
    g[KEY] = s;
  }
  return s;
}

/** The entry of the file being loaded right now (or the inline entry). */
function entry(): FileEntry {
  const s = bddShared();
  const loading = sdkShared().loading.at(-1);
  if (!loading) return s.inline;
  let e = s.files.get(loading);
  if (!e) s.files.set(loading, (e = { steps: [], hooks: [], params: [] }));
  return e;
}

function site(): { file: string; line: number } {
  const c = callSite();
  return { file: c?.file ?? sdkShared().loading.at(-1) ?? '<inline>', line: c?.line ?? 0 };
}

function define(keyword: StepDefinition['keyword'], pattern: string | RegExp, a: StepFn | StepDefinitionOptions, b?: StepFn): void {
  const fn = typeof a === 'function' ? a : b;
  const options = typeof a === 'function' ? {} : a ?? {};
  if (typeof fn !== 'function') throw new TypeError(`${keyword}(${String(pattern)}) needs a function`);
  if (!(pattern instanceof RegExp) && typeof pattern !== 'string') throw new TypeError(`${keyword}() needs a pattern: an expression string or a RegExp`);
  const at = site();
  // The expression is compiled when the steps are matched (custom parameter types may be defined later in the file).
  entry().steps.push({ id: `${at.file}:${at.line}`, keyword, pattern, expression: undefined as unknown as StepExpression, fn, options, file: at.file, line: at.line });
}

/** A step definition. Matching ignores the keyword: `Given`, `When`, `Then` and `Step` are interchangeable. */
export function Given(pattern: string | RegExp, fn: StepFn): void;
export function Given(pattern: string | RegExp, options: StepDefinitionOptions, fn: StepFn): void;
export function Given(pattern: string | RegExp, a: StepFn | StepDefinitionOptions, b?: StepFn): void {
  define('Given', pattern, a, b);
}

export function When(pattern: string | RegExp, fn: StepFn): void;
export function When(pattern: string | RegExp, options: StepDefinitionOptions, fn: StepFn): void;
export function When(pattern: string | RegExp, a: StepFn | StepDefinitionOptions, b?: StepFn): void {
  define('When', pattern, a, b);
}

export function Then(pattern: string | RegExp, fn: StepFn): void;
export function Then(pattern: string | RegExp, options: StepDefinitionOptions, fn: StepFn): void;
export function Then(pattern: string | RegExp, a: StepFn | StepDefinitionOptions, b?: StepFn): void {
  define('Then', pattern, a, b);
}

/** A step definition for any keyword. */
export function Step(pattern: string | RegExp, fn: StepFn): void;
export function Step(pattern: string | RegExp, options: StepDefinitionOptions, fn: StepFn): void;
export function Step(pattern: string | RegExp, a: StepFn | StepDefinitionOptions, b?: StepFn): void {
  define('Step', pattern, a, b);
}

function hook(kind: HookKind, a: string | HookOptions | HookFn, b?: HookFn): void {
  const fn = typeof a === 'function' ? a : b;
  if (typeof fn !== 'function') throw new TypeError(`${kind} hook needs a function`);
  const o: HookOptions = typeof a === 'string' ? { tags: a } : typeof a === 'function' ? {} : a ?? {};
  let tagExpression: TagExpression | undefined;
  if (o.tags) tagExpression = parseTagExpression(o.tags);
  const at = site();
  const s = bddShared();
  entry().hooks.push({
    id: `${kind}:${at.file}:${at.line}`, kind, fn, ...(o.name ? { name: o.name } : {}), ...(o.tags ? { tags: o.tags } : {}), ...(tagExpression ? { tagExpression } : {}),
    order: o.order ?? 1000, file: at.file, line: at.line, seq: ++s.seq,
  });
}

/** Runs before each scenario (optionally only scenarios matching a tag expression). */
export function Before(fn: HookFn): void;
export function Before(tagsOrOptions: string | HookOptions, fn: HookFn): void;
export function Before(a: string | HookOptions | HookFn, b?: HookFn): void {
  hook('before', a, b);
}

/** Runs after each scenario, also when it failed (`ctx.result` holds the outcome). */
export function After(fn: HookFn): void;
export function After(tagsOrOptions: string | HookOptions, fn: HookFn): void;
export function After(a: string | HookOptions | HookFn, b?: HookFn): void {
  hook('after', a, b);
}

/** Runs before each step of matching scenarios. */
export function BeforeStep(fn: HookFn): void;
export function BeforeStep(tagsOrOptions: string | HookOptions, fn: HookFn): void;
export function BeforeStep(a: string | HookOptions | HookFn, b?: HookFn): void {
  hook('beforeStep', a, b);
}

/** Runs after each step of matching scenarios (`ctx.result` holds the step's outcome). */
export function AfterStep(fn: HookFn): void;
export function AfterStep(tagsOrOptions: string | HookOptions, fn: HookFn): void;
export function AfterStep(a: string | HookOptions | HookFn, b?: HookFn): void {
  hook('afterStep', a, b);
}

/**
 * What BeforeAll / AfterAll hooks receive: the SDK (`api`, `db`, `ui` ...), `shared` (values set on it
 * by a BeforeAll are copied into the World of every scenario the hook applies to; AfterAll sees them
 * all), the World parameters and `attach`.
 */
export interface BddAllContext extends SdkContext {
  shared: Record<string, unknown>;
  parameters: Record<string, unknown>;
  attach(name: string, content: string | Uint8Array, description?: string): Promise<string>;
  result?: HookResult;
}

export type AllHookFn = (this: Record<string, unknown>, ctx: BddAllContext) => unknown;

/**
 * Runs once per run (per `eztest run` process, so once per shard with --shard; every --workers slot
 * shares it) before the first scenario it applies to. Tag-filtered like Before. The values it sets on
 * `ctx.shared` (or returns as an object) are copied into every matching scenario's World. When it fails,
 * the scenarios it applies to fail without running.
 */
export function BeforeAll(fn: AllHookFn): void;
export function BeforeAll(tagsOrOptions: string | HookOptions, fn: AllHookFn): void;
export function BeforeAll(a: string | HookOptions | AllHookFn, b?: AllHookFn): void {
  hook('beforeAll', a as string | HookOptions | HookFn, b as HookFn | undefined);
}

/** Runs once at the end of the run when a scenario it applies to ran; sees every BeforeAll's `shared` values. */
export function AfterAll(fn: AllHookFn): void;
export function AfterAll(tagsOrOptions: string | HookOptions, fn: AllHookFn): void;
export function AfterAll(a: string | HookOptions | AllHookFn, b?: AllHookFn): void {
  hook('afterAll', a as string | HookOptions | HookFn, b as HookFn | undefined);
}

/** A custom parameter type for expressions: `{color}`, `{customer}`. */
export function defineParameterType<T>(spec: ParameterTypeSpec<T>): void {
  if (!spec || typeof spec.name !== 'string') throw new TypeError('defineParameterType({ name, regexp, transformer }) needs a name');
  entry().params.push(spec as ParameterTypeSpec);
}

/** The class each scenario's World is made from (`new World({ parameters })`); default a plain object. */
export function setWorldConstructor(ctor: WorldConstructor): void {
  if (typeof ctor !== 'function') throw new TypeError('setWorldConstructor needs a class');
  entry().world = ctor;
}

/** Thrown for a step that is written but not implemented yet. */
export class PendingStepError extends Error {
  constructor(message = 'pending') {
    super(message);
    this.name = 'PendingStepError';
  }
}

/** Mark a step definition as not implemented yet: the step fails as "pending". */
export function pending(reason?: string): never {
  throw new PendingStepError(reason ? `pending: ${reason}` : 'pending');
}

// ------------------------------------------------------------------ the glue a scenario runs with

/** The step definitions, hooks and parameter types of a set of loaded files. */
export interface Glue {
  steps: StepDefinition[];
  hooks: HookDefinition[];
  params: ParameterTypeRegistry;
  world?: WorldConstructor;
  /** Problems with definitions (bad expressions, duplicate parameter types). */
  errors: string[];
}

/** Build the glue of the given files (absolute paths, in load order), plus inline definitions. */
export function glueOf(files: string[], o: { inline?: boolean } = {}): Glue {
  const s = bddShared();
  const entries = files.map((f) => s.files.get(f)).filter((e): e is FileEntry => !!e);
  if (o.inline !== false) entries.push(s.inline);
  const params = new ParameterTypeRegistry();
  const errors: string[] = [];
  const seenParams = new Set<string>();
  for (const e of entries) {
    for (const p of e.params) {
      if (seenParams.has(p.name)) continue;
      seenParams.add(p.name);
      try {
        params.define(p);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  const steps: StepDefinition[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const d of e.steps) {
      // A step file bundled into two entry files registers twice: keep one per call site.
      const key = `${d.id}\u0000${String(d.pattern)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        steps.push({ ...d, expression: stepExpression(d.pattern, params) });
      } catch (err) {
        errors.push(`${d.file}:${d.line}: ${(err as Error).message}`);
      }
    }
  }
  const hooks: HookDefinition[] = [];
  const seenHooks = new Set<string>();
  for (const e of entries) {
    for (const h of e.hooks) {
      if (seenHooks.has(h.id)) continue;
      seenHooks.add(h.id);
      hooks.push(h);
    }
  }
  const world = [...entries].reverse().find((e) => e.world)?.world;
  return { steps, hooks, params, ...(world ? { world } : {}), errors };
}

export interface StepMatch {
  definition: StepDefinition;
  args: unknown[];
}

/** Every definition whose pattern matches the text. */
export function matchStep(glue: Glue, text: string, world?: unknown): StepMatch[] {
  const out: StepMatch[] = [];
  for (const d of glue.steps) {
    const m = d.expression.match(text, world);
    if (m) out.push({ definition: d, args: m.args });
  }
  return out;
}

/** Hooks of a kind that apply to a scenario with these tags, in run order. */
export function hooksFor(glue: Glue, kind: HookKind, tags: string[]): HookDefinition[] {
  const list = glue.hooks.filter((h) => h.kind === kind && (!h.tagExpression || evaluateTags(h.tagExpression, tags)));
  list.sort((a, b) => a.order - b.order || a.seq - b.seq);
  // After hooks run in reverse: the last registered (and the lowest order) runs last.
  return kind === 'after' || kind === 'afterStep' || kind === 'afterAll' ? list.reverse() : list;
}

/** Forget every registration (tests). */
export function resetBddRegistry(): void {
  const s = bddShared();
  s.files.clear();
  s.inline = { steps: [], hooks: [], params: [] };
}

/** Registrations of one loaded file (used to keep them when a cached module is not evaluated again). */
export function fileRegistrations(file: string): FileEntry | undefined {
  return bddShared().files.get(file);
}

export function setFileRegistrations(file: string, e: FileEntry | undefined): void {
  const s = bddShared();
  if (e) s.files.set(file, e);
  else s.files.delete(file);
}
