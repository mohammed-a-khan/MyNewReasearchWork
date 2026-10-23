/**
 * Collects and runs one test file inside a worker process (see worker.mjs).
 * Semantics follow what EZTest's tests rely on: hooks run outer-to-inner
 * before a test and inner-to-outer after it, a failing beforeAll skips the
 * suite's tests (its afterAll still runs), a returned function from
 * beforeAll / beforeEach is its teardown, ctx.skip() skips the test.
 */
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssertionError } from './expect.js';
import { inline } from './format.js';
import { newSuite, SkipSignal, state, type Hook, type RunningTest, type SuiteNode, type TestContext, type TestNode } from './state.js';

export interface RunOptions {
  root: string;
  testTimeout: number;
  hookTimeout: number;
  retry: number;
  /** Full-name filter (-t). */
  grep?: string;
  /** Allow .only when CI is set (otherwise a file with .only fails there, so it cannot slip into CI). */
  allowOnly?: boolean;
  color: boolean;
}

export interface SerializedError {
  name: string;
  message: string;
  /** Cleaned stack (project frames only). */
  stack?: string;
  diff?: string;
  /** Source lines around the failing line, with a caret. */
  frame?: string;
  /** file:line:col of that line. */
  location?: string;
}

export interface TestResult {
  path: string[];
  state: 'pass' | 'fail' | 'skip' | 'todo';
  durationMs: number;
  retries: number;
  errors: SerializedError[];
  note?: string;
}

export interface Events {
  testStart(path: string[], timeoutMs: number): void;
  testEnd(result: TestResult): void;
  hookStart(kind: string, timeoutMs: number): void;
  hookEnd(): void;
}

export interface FileResult {
  file: string;
  tests: TestResult[];
  /** Errors outside any test: collection, hooks of suites, unhandled rejections. */
  errors: Array<SerializedError & { where: string }>;
  durationMs: number;
}

let opts: RunOptions;

function colorize(code: number, s: string) {
  return state.color ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const isInternal = (line: string) => /node:internal|node_modules[\\/]|\/tools\/testkit\/|\(native\)|<anonymous>/.test(line) || /^\s*at (new Promise|process\.processTicksAndRejections|Array\.forEach)/.test(line);

function frameFromStack(stack: string | undefined): { file: string; line: number; col: number } | undefined {
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (!/^\s*at /.test(line) || isInternal(line)) continue;
    const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
    if (!file.startsWith(opts.root)) continue;
    return { file, line: Number(m[2]), col: Number(m[3]) };
  }
  return undefined;
}

function sourceFrame(file: string, line: number, col: number): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, line + 2);
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const src = lines[i - 1].replace(/\t/g, '  ');
    const gutter = `${String(i).padStart(width)}|`;
    out.push(i === line ? `${colorize(1, gutter)} ${src}` : colorize(2, `${gutter} ${src}`));
    if (i === line) out.push(`${' '.repeat(width)}| ${' '.repeat(Math.max(0, col - 1))}${colorize(31, '^')}`);
  }
  return out.join('\n');
}

function rel(p: string) {
  return relative(opts.root, p).split(sep).join('/');
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    let stack: string | undefined;
    try {
      stack = e.stack;
    } catch {
      stack = undefined;
    }
    const loc = frameFromStack(stack);
    const projectFrames = (stack ?? '')
      .split('\n')
      .slice(1)
      .filter((l) => /^\s*at /.test(l) && !isInternal(l))
      .map((l) => l.replace(pathToFileURL(opts.root).href + '/', '').replace(opts.root + '/', ''))
      .slice(0, 8);
    const out: SerializedError = {
      name: e.name || 'Error',
      message: e.message,
      stack: projectFrames.join('\n') || undefined,
      diff: e instanceof AssertionError ? e.diff : (e as { diff?: string }).diff,
    };
    if (loc) {
      out.location = `${rel(loc.file)}:${loc.line}:${loc.col}`;
      out.frame = sourceFrame(loc.file, loc.line, loc.col);
    }
    const cause = (e as { cause?: unknown }).cause;
    if (cause !== undefined && !(e instanceof AssertionError)) out.message += `\nCaused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : inline(cause)}`;
    if (e instanceof AggregateError && e.errors?.length) out.message += `\n${e.errors.map((x: unknown, i: number) => `  [${i}] ${x instanceof Error ? `${x.name}: ${x.message}` : inline(x)}`).join('\n')}`;
    return out;
  }
  return { name: 'Thrown value', message: inline(e, 2000) };
}

class TimeoutError extends Error {
  constructor(message: string, site?: Error) {
    super(message);
    this.name = 'Error';
    // Point at the declaration of the test / hook that timed out.
    if (site?.stack) this.stack = `Error: ${message}\n${site.stack.split('\n').slice(1).join('\n')}`;
  }
}

/** Runs fn (sync or async) with a timeout; the timer error carries the declaration site. */
async function withTimeout(fn: () => unknown, ms: number, what: () => string, onTimeout?: () => void, site?: Error): Promise<unknown> {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return await fn();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(what(), site));
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pathOf(node: TestNode | SuiteNode): string[] {
  const names: string[] = [];
  for (let n: TestNode | SuiteNode | undefined = node; n && n.parent; n = n.parent) names.unshift(n.name);
  return names;
}

function inherited<K extends 'timeout' | 'retry'>(node: TestNode | SuiteNode, key: K): number | undefined {
  for (let n: TestNode | SuiteNode | undefined = node; n; n = n.parent) if (n.options[key] !== undefined) return n.options[key];
  return undefined;
}

async function collect(suite: SuiteNode): Promise<void> {
  if (suite.factory) {
    const prev = state.current;
    state.current = suite;
    try {
      await suite.factory();
    } finally {
      state.current = prev;
    }
  }
  for (const c of suite.children) if (c.kind === 'suite') await collect(c);
}

function hasOnly(s: SuiteNode): boolean {
  return s.children.some((c) => c.mode === 'only' || (c.kind === 'suite' && hasOnly(c)));
}

/** A suite holding a .only somewhere below it counts as .only itself (so its siblings are skipped). */
function bubbleOnly(s: SuiteNode): void {
  for (const c of s.children) {
    if (c.kind !== 'suite') continue;
    bubbleOnly(c);
    if (c.mode === 'run' && hasOnly(c)) c.mode = 'only';
  }
}

/** Applies .only, the -t filter and skip inheritance; returns whether anything in the suite runs. */
function interpret(s: SuiteNode, grep: RegExp | undefined): boolean {
  let any = false;
  const someOnly = s.children.some((c) => c.mode === 'only');
  for (const c of s.children) {
    if (s.mode === 'skip' || s.mode === 'todo') {
      if (c.mode !== 'todo') c.mode = 'skip';
    } else if (someOnly && c.mode === 'run') c.mode = 'skip';
    if (c.kind === 'test') {
      if ((c.mode === 'run' || c.mode === 'only') && grep && !grep.test(pathOf(c).join(' '))) c.mode = 'skip';
      if (c.mode === 'run' || c.mode === 'only') any = true;
    } else {
      const runs = interpret(c, grep);
      if (!runs && (c.mode === 'run' || c.mode === 'only')) c.mode = 'skip';
      any ||= runs;
    }
  }
  return any;
}

function allTests(s: SuiteNode, out: TestNode[] = []): TestNode[] {
  for (const c of s.children) {
    if (c.kind === 'test') out.push(c);
    else allTests(c, out);
  }
  return out;
}

function hasTests(s: SuiteNode): boolean {
  return s.children.some((c) => c.kind === 'test' || hasTests(c));
}

let fileResult: FileResult;
let events: Events;
const reported = new Set<TestNode>();

function record(node: TestNode, r: Omit<TestResult, 'path'>): void {
  if (reported.has(node)) return;
  reported.add(node);
  const result = { path: pathOf(node), ...r };
  fileResult.tests.push(result);
  events.testEnd(result);
}

function skipAll(s: SuiteNode, note?: string): void {
  for (const t of allTests(s)) record(t, { state: t.mode === 'todo' ? 'todo' : 'skip', durationMs: 0, retries: 0, errors: [], note });
}

function suiteError(s: SuiteNode, e: unknown, where: string): void {
  const path = pathOf(s);
  fileResult.errors.push({ ...serializeError(e), where: [...path, where].join(' > ') || where });
}

async function callHook(hook: Hook, kind: string, args: unknown[]): Promise<unknown> {
  const ms = hook.timeout ?? opts.hookTimeout;
  events.hookStart(kind, ms);
  try {
    return await withTimeout(() => hook.fn(...args), ms, () => `Hook timed out in ${ms}ms.\nIf this is a long-running hook, pass a timeout value as the last argument to ${kind}() or configure "hookTimeout".`, undefined, hook.site);
  } finally {
    events.hookEnd();
  }
}

/** beforeEach chain, outer suites first; returns teardown functions. */
async function runBeforeEach(s: SuiteNode, ctx: TestContext): Promise<Array<() => unknown>> {
  const chain: SuiteNode[] = [];
  for (let n: SuiteNode | undefined = s; n; n = n.parent) chain.unshift(n);
  const cleanups: Array<() => unknown> = [];
  for (const suite of chain) {
    for (const h of suite.hooks.beforeEach) {
      const r = await callHook(h, 'beforeEach', [ctx, suite]);
      if (typeof r === 'function') cleanups.push(r as () => unknown);
    }
  }
  return cleanups;
}

async function runAfterEach(s: SuiteNode, ctx: TestContext): Promise<void> {
  for (let n: SuiteNode | undefined = s; n; n = n.parent) {
    for (const h of [...n.hooks.afterEach].reverse()) await callHook(h, 'afterEach', [ctx, n]);
  }
}

async function runTest(t: TestNode): Promise<void> {
  if (t.mode === 'skip' || t.mode === 'todo') {
    record(t, { state: t.mode, durationMs: 0, retries: 0, errors: [] });
    return;
  }
  const start = performance.now();
  const timeoutMs = inherited(t, 'timeout') ?? opts.testTimeout;
  const retry = inherited(t, 'retry') ?? opts.retry;
  const path = pathOf(t);
  let errors: unknown[] = [];
  let skipped: SkipSignal | undefined;
  let attempt = 0;
  events.testStart(path, timeoutMs);
  for (; attempt <= retry; attempt++) {
    errors = [];
    const running: RunningTest = { node: t, softErrors: [], onFinished: [], onFailed: [] };
    state.running = running;
    const abort = new AbortController();
    const ctx: TestContext = {
      skip(note?: string): never {
        throw new SkipSignal(note);
      },
      onTestFinished: (fn) => running.onFinished.push(fn),
      onTestFailed: (fn) => running.onFailed.push(fn),
      task: { name: t.name, fullName: path.join(' > '), file: fileResult.file },
      signal: abort.signal,
    };
    const fail = (e: unknown) => {
      if (e instanceof SkipSignal) skipped = e;
      else errors.push(e);
    };
    let cleanups: Array<() => unknown> = [];
    try {
      cleanups = await runBeforeEach(t.parent, ctx);
      await withTimeout(() => t.fn!(ctx), timeoutMs, () => `Test timed out in ${timeoutMs}ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure "testTimeout".`, () => abort.abort(new Error('test timed out')), t.site);
    } catch (e) {
      fail(e);
    }
    errors.push(...running.softErrors);
    try {
      await runAfterEach(t.parent, ctx);
      for (const c of cleanups.reverse()) await withTimeout(c, opts.hookTimeout, () => `beforeEach teardown timed out in ${opts.hookTimeout}ms.`);
    } catch (e) {
      fail(e);
    }
    for (const fn of [...running.onFinished].reverse()) {
      try {
        await withTimeout(fn, opts.hookTimeout, () => `onTestFinished callback timed out in ${opts.hookTimeout}ms.`);
      } catch (e) {
        fail(e);
      }
    }
    if (errors.length && !skipped) {
      for (const fn of running.onFailed) {
        try {
          await withTimeout(fn, opts.hookTimeout, () => `onTestFailed callback timed out in ${opts.hookTimeout}ms.`);
        } catch (e) {
          fail(e);
        }
      }
    }
    state.running = undefined;
    if (skipped || !errors.length) break;
  }
  const durationMs = performance.now() - start;
  if (skipped) record(t, { state: 'skip', durationMs, retries: attempt, errors: [], note: skipped.note });
  else record(t, { state: errors.length ? 'fail' : 'pass', durationMs, retries: Math.min(attempt, retry), errors: errors.map(serializeError) });
}

async function runSuite(s: SuiteNode): Promise<void> {
  if (s.mode === 'skip' || s.mode === 'todo') {
    skipAll(s);
    return;
  }
  if (s.parent && !hasTests(s)) {
    suiteError(s, new Error(`No test found in suite ${s.name}`), 'describe');
    return;
  }
  const cleanups: Array<() => unknown> = [];
  let beforeAllFailed = false;
  try {
    for (const h of s.hooks.beforeAll) {
      const r = await callHook(h, 'beforeAll', [s]);
      if (typeof r === 'function') cleanups.push(r as () => unknown);
    }
  } catch (e) {
    beforeAllFailed = true;
    suiteError(s, e, 'beforeAll');
    skipAll(s, 'beforeAll failed');
  }
  if (!beforeAllFailed) {
    for (const c of s.children) {
      if (c.kind === 'test') await runTest(c);
      else await runSuite(c);
    }
  }
  try {
    for (const h of [...s.hooks.afterAll].reverse()) await callHook(h, 'afterAll', [s]);
    for (const c of cleanups.reverse()) await withTimeout(c, opts.hookTimeout, () => `beforeAll teardown timed out in ${opts.hookTimeout}ms.`);
  } catch (e) {
    suiteError(s, e, 'afterAll');
  }
}

/** Imports, collects and runs `file`; reports through `ev`. */
export async function runFile(file: string, o: RunOptions, ev: Events): Promise<FileResult> {
  opts = o;
  events = ev;
  state.color = o.color;
  const start = performance.now();
  fileResult = { file: rel(file), tests: [], errors: [], durationMs: 0 };
  const root = newSuite(rel(file), undefined, 'run');
  state.file = file;
  state.root = root;
  state.current = root;
  state.collecting = true;
  try {
    await import(pathToFileURL(file).href);
    await collect(root);
  } catch (e) {
    state.collecting = false;
    fileResult.errors.push({ ...serializeError(e), where: 'collecting the file' });
    fileResult.durationMs = performance.now() - start;
    return fileResult;
  }
  state.collecting = false;
  if (!hasTests(root)) {
    fileResult.errors.push({ ...serializeError(new Error(`No test found in ${rel(file)}`)), where: 'collecting the file' });
  } else {
    let grep: RegExp | undefined;
    if (o.grep) {
      try {
        grep = new RegExp(o.grep);
      } catch {
        grep = new RegExp(o.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    }
    if (process.env.CI && !o.allowOnly && hasOnly(root)) {
      fileResult.errors.push({ ...serializeError(new Error('.only is not allowed when CI is set (it would hide the other tests); remove it or pass --allow-only')), where: 'collecting the file' });
      fileResult.durationMs = performance.now() - start;
      return fileResult;
    }
    bubbleOnly(root);
    if (!interpret(root, grep)) root.mode = 'skip';
    await runSuite(root);
  }
  fileResult.durationMs = performance.now() - start;
  return fileResult;
}

/** Errors raised outside the test flow (unhandled rejections / exceptions). */
export function unhandled(e: unknown, kind: string): void {
  if (!fileResult) return;
  fileResult.errors.push({ ...serializeError(e), where: kind });
}
