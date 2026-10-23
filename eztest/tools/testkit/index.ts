/**
 * EZTest testkit: the test API EZTest's own test files import (dev-only, not shipped).
 *
 *   import { describe, it, expect, beforeAll, afterAll, vi } from '../support/testkit.js';
 *
 * Written for this repository from scratch; run with `npm test` (tools/testkit/cli.mjs).
 */
import { inline } from './format.js';
import { currentSuite, newSuite, state, type Awaitable, type Hook, type Mode, type SuiteNode, type TestContext, type TestNode, type TestOptions } from './state.js';

export { expect, AssertionError } from './expect.js';
export type { Assertion, PollOptions } from './expect.js';
export { vi } from './mock.js';
export type { Mock, MockInstance } from './mock.js';
export type { TestContext, TestOptions } from './state.js';

type TestFn = (ctx: TestContext) => Awaitable<unknown>;
type SuiteFn = () => Awaitable<unknown>;

/** The declaration site; V8 formats the stack only if a timeout report reads it. */
function callSite(): Error {
  return new Error('declared here');
}

/** (name, fn), (name, fn, timeout), (name, options, fn), (name, fn, options). */
function parseArgs<F>(a: unknown, b: unknown): { fn?: F; options: TestOptions } {
  if (typeof a === 'function') return { fn: a as F, options: typeof b === 'number' ? { timeout: b } : ((b as TestOptions) ?? {}) };
  if (typeof b === 'function') return { fn: b as F, options: typeof a === 'number' ? { timeout: a } : ((a as TestOptions) ?? {}) };
  return { fn: undefined, options: typeof a === 'number' ? { timeout: a } : ((a as TestOptions) ?? {}) };
}

function titleOf(name: unknown): string {
  if (typeof name === 'string') return name;
  if (typeof name === 'function') return name.name || '<anonymous>';
  return String(name);
}

function modeOf(base: Mode, options: TestOptions): Mode {
  if (options.skip) return 'skip';
  if (options.todo) return 'todo';
  if (options.only) return 'only';
  return base;
}

function addTest(base: Mode, name: unknown, a?: unknown, b?: unknown): void {
  const suite = currentSuite('it');
  const { fn, options } = parseArgs<TestFn>(a, b);
  const mode = !fn && base !== 'skip' ? 'todo' : modeOf(base, options);
  const node: TestNode = { kind: 'test', name: titleOf(name), parent: suite, mode, options, fn, site: callSite() };
  suite.children.push(node);
}

function addSuite(base: Mode, name: unknown, a?: unknown, b?: unknown): void {
  const parent = currentSuite('describe');
  const { fn, options } = parseArgs<SuiteFn>(a, b);
  const mode = !fn ? 'todo' : modeOf(base, options);
  parent.children.push(newSuite(titleOf(name), parent, mode, options, fn));
}

/** printf-style test titles for .each: %s %d %i %f %j %o %O %# %$ %%, and $name / $a.b for object rows. */
export function formatTitle(template: string, args: unknown[], index: number): string {
  let i = 0;
  let out = template.replace(/%([sdifjoO#$%])/g, (m, c: string) => {
    if (c === '%') return '%';
    if (c === '#') return String(index);
    if (c === '$') return String(index + 1);
    if (i >= args.length) return m;
    const v = args[i++];
    switch (c) {
      case 's':
        return typeof v === 'string' ? v : inline(v, 200);
      case 'd':
      case 'i':
        return typeof v === 'number' || typeof v === 'bigint' ? String(c === 'i' && typeof v === 'number' ? Math.trunc(v) : v) : 'NaN';
      case 'f':
        return String(Number(v));
      case 'j':
        try {
          return JSON.stringify(v);
        } catch {
          return '[Circular]';
        }
      default:
        return inline(v, 200);
    }
  });
  const row = args.length === 1 ? args[0] : undefined;
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    out = out.replace(/\$([A-Za-z_][\w]*(?:\.[\w]+)*)/g, (m, path: string) => {
      let v: unknown = row;
      for (const p of path.split('.')) {
        if (v === null || v === undefined || typeof v !== 'object') return m;
        if (!(p in (v as object))) return m;
        v = (v as Record<string, unknown>)[p];
      }
      return inline(v, 200);
    });
  }
  return out;
}

type EachArgs<T> = T extends readonly unknown[] ? T : [T];

interface EachFn {
  <T extends readonly unknown[] | [unknown]>(cases: ReadonlyArray<T>): (name: string, fnOrOptions: ((...args: T) => Awaitable<unknown>) | TestOptions | number, fnOrTimeout?: ((...args: T) => Awaitable<unknown>) | number | TestOptions) => void;
  <T>(cases: ReadonlyArray<T>): (name: string, fnOrOptions: ((...args: EachArgs<T>) => Awaitable<unknown>) | TestOptions | number, fnOrTimeout?: ((...args: EachArgs<T>) => Awaitable<unknown>) | number | TestOptions) => void;
}

function eachFor(add: (name: unknown, a?: unknown, b?: unknown) => void): EachFn {
  return ((cases: ReadonlyArray<unknown>) =>
    (name: string, a?: unknown, b?: unknown) => {
      cases.forEach((row, index) => {
        const args = Array.isArray(row) ? (row as unknown[]) : [row];
        const { fn, options } = parseArgs<(...xs: unknown[]) => unknown>(a, b);
        const title = formatTitle(name, args, index);
        if (!fn) add(title, options);
        else add(title, options, () => fn(...args));
      });
    }) as EachFn;
}

export interface TestAPI {
  (name: string | Function, fn?: TestFn, timeoutOrOptions?: number | TestOptions): void;
  (name: string | Function, options: TestOptions | number, fn: TestFn): void;
  skip: TestAPI;
  only: TestAPI;
  todo: (name: string | Function, ...rest: unknown[]) => void;
  /** Accepted for compatibility; tests in a file always run one after another. */
  concurrent: TestAPI;
  sequential: TestAPI;
  each: EachFn;
  skipIf(condition: unknown): TestAPI;
  runIf(condition: unknown): TestAPI;
}

export interface SuiteAPI {
  (name: string | Function, fn?: SuiteFn, timeoutOrOptions?: number | TestOptions): void;
  (name: string | Function, options: TestOptions | number, fn: SuiteFn): void;
  skip: SuiteAPI;
  only: SuiteAPI;
  todo: (name: string | Function, ...rest: unknown[]) => void;
  concurrent: SuiteAPI;
  sequential: SuiteAPI;
  each: EachFn;
  skipIf(condition: unknown): SuiteAPI;
  runIf(condition: unknown): SuiteAPI;
}

function makeApi<A extends TestAPI | SuiteAPI>(addFn: (mode: Mode, name: unknown, a?: unknown, b?: unknown) => void, mode: Mode): A {
  const api = ((name: unknown, a?: unknown, b?: unknown) => addFn(mode, name, a, b)) as unknown as A;
  const lazy = (key: string, get: () => unknown) => Object.defineProperty(api, key, { get, configurable: true });
  lazy('skip', () => makeApi<A>(addFn, 'skip'));
  lazy('only', () => makeApi<A>(addFn, mode === 'skip' ? 'skip' : 'only'));
  lazy('concurrent', () => api);
  lazy('sequential', () => api);
  Object.defineProperty(api, 'todo', { value: (name: unknown) => addFn('todo', name), configurable: true });
  Object.defineProperty(api, 'each', { get: () => eachFor((name, a, b) => addFn(mode, name, a, b)), configurable: true });
  Object.defineProperty(api, 'skipIf', { value: (c: unknown) => (c ? makeApi<A>(addFn, 'skip') : api), configurable: true });
  Object.defineProperty(api, 'runIf', { value: (c: unknown) => (c ? api : makeApi<A>(addFn, 'skip')), configurable: true });
  return api;
}

export const it: TestAPI = makeApi<TestAPI>(addTest, 'run');
export const test: TestAPI = it;
export const describe: SuiteAPI = makeApi<SuiteAPI>(addSuite, 'run');
export const suite: SuiteAPI = describe;

function addHook(kind: keyof SuiteNode['hooks'], fn: Hook['fn'], timeout?: number): void {
  const s = currentSuite(kind);
  if (typeof fn !== 'function') throw new TypeError(`${kind}() needs a function`);
  s.hooks[kind].push({ fn, timeout, site: callSite() });
}

/** Runs once before the tests of the enclosing describe (or file). A returned function runs as its teardown. */
export function beforeAll(fn: () => Awaitable<unknown>, timeout?: number): void {
  addHook('beforeAll', fn as Hook['fn'], timeout);
}
export function afterAll(fn: () => Awaitable<unknown>, timeout?: number): void {
  addHook('afterAll', fn as Hook['fn'], timeout);
}
/** Runs before each test of the enclosing describe (outer hooks first). A returned function runs after the test. */
export function beforeEach(fn: (ctx: TestContext) => Awaitable<unknown>, timeout?: number): void {
  addHook('beforeEach', fn as Hook['fn'], timeout);
}
export function afterEach(fn: (ctx: TestContext) => Awaitable<unknown>, timeout?: number): void {
  addHook('afterEach', fn as Hook['fn'], timeout);
}

function running(what: string) {
  if (!state.running) throw new Error(`${what}() can only be called while a test runs`);
  return state.running;
}
/** Registers a callback that runs after the current test, pass or fail. */
export function onTestFinished(fn: () => unknown): void {
  running('onTestFinished').onFinished.push(fn);
}
/** Registers a callback that runs after the current test when it failed. */
export function onTestFailed(fn: () => unknown): void {
  running('onTestFailed').onFailed.push(fn);
}
