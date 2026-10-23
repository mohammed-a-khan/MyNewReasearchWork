/**
 * `expect` for EZTest's own tests: matchers, `.not`, `.resolves` / `.rejects`,
 * `expect.poll`, `expect.soft`, asymmetric matchers. Failures are AssertionErrors
 * that carry a rendered diff (see diff.ts).
 */
import { asymmetric, isAsymmetric, notAsymmetric } from './asymmetric.js';
import { valueDiff } from './diff.js';
import { equals, subsetEquals, subsetForDiff } from './equals.js';
import { inline } from './format.js';
import { isMock, type MockInstance } from './mock.js';
import { state } from './state.js';

export class AssertionError extends Error {
  actual?: unknown;
  expected?: unknown;
  /** Rendered "- Expected / + Received" block, when a diff helps. */
  diff?: string;
  constructor(message: string, opts: { actual?: unknown; expected?: unknown; diff?: string } = {}) {
    super(message);
    this.name = 'AssertionError';
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.diff = opts.diff;
  }
}

interface Outcome {
  pass: boolean;
  /** Message for the failing direction: receives "not " when negated. */
  message: (not: string) => string;
  /** Values to diff when the (non-negated) assertion fails. */
  diff?: { expected: unknown; actual: unknown };
}

type Matcher = (actual: unknown, ...args: any[]) => Outcome;

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function needNumber(v: unknown, what: string): asserts v is number | bigint {
  if (typeof v !== 'number' && typeof v !== 'bigint') throw new TypeError(`${what}: expected a number or bigint, received ${typeName(v)} ${inline(v)}`);
}

function thrownMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

function getPath(obj: unknown, path: string | readonly (string | number)[]): { found: boolean; value: unknown } {
  const parts = Array.isArray(path) ? path.map(String) : String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter((p, i, a) => p !== '' || a.length === 1);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    const box = typeof cur === 'object' || typeof cur === 'function' ? (cur as object) : Object(cur);
    if (!(p in box)) return { found: false, value: undefined };
    cur = (box as Record<string, unknown>)[p];
  }
  return { found: true, value: cur };
}

function mockOf(v: unknown, name: string): MockInstance {
  if (!isMock(v)) throw new TypeError(`${name}: ${inline(v)} is not a mock function (use vi.fn() or vi.spyOn())`);
  return v as MockInstance;
}

const callsText = (calls: unknown[][]) => (calls.length ? calls.map((c, i) => `  ${i + 1}: ${inline(c, 300)}`).join('\n') : '  (no calls)');

const matchers: Record<string, Matcher> = {
  toBe(a, e) {
    return {
      pass: Object.is(a, e),
      message: (not) => `expected ${inline(a)} ${not}to be ${inline(e)} // Object.is equality${!not && equals(a, e, true) ? '\n\nIf it should pass with deep equality, replace "toBe" with "toStrictEqual"' : ''}`,
      diff: { expected: e, actual: a },
    };
  },
  toEqual(a, e) {
    return { pass: equals(a, e), message: (not) => `expected ${inline(a)} ${not}to deeply equal ${inline(e)}`, diff: { expected: e, actual: a } };
  },
  toStrictEqual(a, e) {
    return { pass: equals(a, e, true), message: (not) => `expected ${inline(a)} ${not}to strictly equal ${inline(e)}`, diff: { expected: e, actual: a } };
  },
  toMatchObject(a, e) {
    if (typeof e !== 'object' || e === null) throw new TypeError(`toMatchObject: the expected value must be an object, received ${typeName(e)}`);
    return { pass: subsetEquals(a, e), message: (not) => `expected ${inline(a)} ${not}to match object ${inline(e)}`, diff: { expected: e, actual: subsetForDiff(a, e) } };
  },
  toMatch(a, e: string | RegExp) {
    if (typeof a !== 'string') throw new TypeError(`toMatch: expected a string, received ${typeName(a)} ${inline(a)}`);
    const pass = typeof e === 'string' ? a.includes(e) : (e.lastIndex = 0, e.test(a));
    return { pass, message: (not) => `expected ${inline(a, 600)} ${not}to ${typeof e === 'string' ? 'include' : 'match'} ${typeof e === 'string' ? inline(e) : String(e)}` };
  },
  toContain(a, item) {
    let pass: boolean;
    if (typeof a === 'string') pass = a.includes(String(item));
    else if (a && typeof (a as Iterable<unknown>)[Symbol.iterator] === 'function') pass = [...(a as Iterable<unknown>)].includes(item);
    else if (a && typeof a === 'object' && 'contains' in a && typeof (a as { contains: unknown }).contains === 'function') pass = (a as { contains(x: unknown): boolean }).contains(item);
    else throw new TypeError(`toContain: expected a string, array or iterable, received ${typeName(a)} ${inline(a)}`);
    return { pass, message: (not) => `expected ${inline(a, 600)} ${not}to contain ${inline(item)}` };
  },
  toContainEqual(a, item) {
    if (!a || typeof (a as Iterable<unknown>)[Symbol.iterator] !== 'function') throw new TypeError(`toContainEqual: expected an array or iterable, received ${typeName(a)}`);
    return { pass: [...(a as Iterable<unknown>)].some((x) => equals(x, item)), message: (not) => `expected ${inline(a, 600)} ${not}to contain an item equal to ${inline(item)}` };
  },
  toHaveLength(a, n: number) {
    const len = a !== null && a !== undefined ? (a as { length?: unknown }).length : undefined;
    if (typeof len !== 'number') throw new TypeError(`toHaveLength: ${inline(a)} has no length`);
    return { pass: len === n, message: (not) => `expected ${inline(a)} ${not}to have a length of ${n}, but its length is ${len}` };
  },
  toHaveProperty(a, path: string | (string | number)[], ...rest: unknown[]) {
    const { found, value } = getPath(a, path);
    const withValue = rest.length > 0;
    const pass = found && (!withValue || equals(value, rest[0]));
    const p = Array.isArray(path) ? path.join('.') : path;
    return {
      pass,
      message: (not) => `expected ${inline(a)} ${not}to have property "${p}"${withValue ? ` with value ${inline(rest[0])}${found ? `, it is ${inline(value)}` : ''}` : ''}`,
      diff: withValue && found ? { expected: rest[0], actual: value } : undefined,
    };
  },
  toBeDefined(a) {
    return { pass: a !== undefined, message: (not) => `expected ${inline(a)} ${not}to be defined` };
  },
  toBeUndefined(a) {
    return { pass: a === undefined, message: (not) => `expected ${inline(a)} ${not}to be undefined` };
  },
  toBeNull(a) {
    return { pass: a === null, message: (not) => `expected ${inline(a)} ${not}to be null` };
  },
  toBeNaN(a) {
    return { pass: Number.isNaN(a), message: (not) => `expected ${inline(a)} ${not}to be NaN` };
  },
  toBeTruthy(a) {
    return { pass: !!a, message: (not) => `expected ${inline(a)} ${not}to be truthy` };
  },
  toBeFalsy(a) {
    return { pass: !a, message: (not) => `expected ${inline(a)} ${not}to be falsy` };
  },
  toBeGreaterThan(a, n) {
    needNumber(a, 'toBeGreaterThan');
    return { pass: a > n, message: (not) => `expected ${inline(a)} ${not}to be greater than ${inline(n)}` };
  },
  toBeGreaterThanOrEqual(a, n) {
    needNumber(a, 'toBeGreaterThanOrEqual');
    return { pass: a >= n, message: (not) => `expected ${inline(a)} ${not}to be greater than or equal to ${inline(n)}` };
  },
  toBeLessThan(a, n) {
    needNumber(a, 'toBeLessThan');
    return { pass: a < n, message: (not) => `expected ${inline(a)} ${not}to be less than ${inline(n)}` };
  },
  toBeLessThanOrEqual(a, n) {
    needNumber(a, 'toBeLessThanOrEqual');
    return { pass: a <= n, message: (not) => `expected ${inline(a)} ${not}to be less than or equal to ${inline(n)}` };
  },
  toBeCloseTo(a, n: number, digits = 2) {
    if (typeof a !== 'number') throw new TypeError(`toBeCloseTo: expected a number, received ${typeName(a)}`);
    const pass = (a === Infinity && n === Infinity) || (a === -Infinity && n === -Infinity) || Math.abs(a - n) < 10 ** -digits / 2;
    return { pass, message: (not) => `expected ${a} ${not}to be close to ${n} (${digits} decimal digits), the difference is ${Math.abs(a - n)}` };
  },
  toBeInstanceOf(a, ctor: Function) {
    if (typeof ctor !== 'function') throw new TypeError('toBeInstanceOf: expected a class or constructor');
    return { pass: a instanceof ctor, message: (not) => `expected ${inline(a)} ${not}to be an instance of ${ctor.name || 'the given class'}` };
  },
  toBeTypeOf(a, type: string) {
    return { pass: typeof a === type, message: (not) => `expected ${inline(a)} ${not}to be type of "${type}", it is "${typeof a}"` };
  },
  toBeOneOf(a, options: readonly unknown[]) {
    return { pass: options.some((o) => equals(a, o)), message: (not) => `expected ${inline(a)} ${not}to be one of ${inline(options)}` };
  },
  toSatisfy(a, pred: (v: unknown) => boolean, msg?: string) {
    return { pass: !!pred(a), message: (not) => `expected ${inline(a)} ${not}to satisfy ${msg ?? (pred.name || 'the predicate')}` };
  },
  toThrow(a, expected?: unknown) {
    // Under .rejects, `a` is already the rejection reason (see `thrown` below).
    let threw = false;
    let error: unknown;
    if (a instanceof Thrown) {
      threw = true;
      error = a.error;
    } else {
      if (typeof a !== 'function') throw new TypeError(`toThrow: expected a function (or a promise with .rejects), received ${typeName(a)}`);
      try {
        (a as () => unknown)();
      } catch (e) {
        threw = true;
        error = e;
      }
    }
    if (expected === undefined) return { pass: threw, message: (not) => (not ? `expected the function not to throw, but it threw ${inline(error, 400)}` : 'expected the function to throw an error, but it did not') };
    if (!threw) return { pass: false, message: () => `expected the function to throw ${describeThrowExpectation(expected)}, but it did not throw` };
    const msg = thrownMessage(error);
    let pass: boolean;
    let diff: Outcome['diff'];
    if (typeof expected === 'string') pass = msg.includes(expected);
    else if (expected instanceof RegExp) pass = (expected.lastIndex = 0, expected.test(msg));
    else if (isAsymmetric(expected)) pass = expected.matches(error);
    else if (typeof expected === 'function') pass = error instanceof (expected as new () => unknown);
    else if (expected instanceof Error) {
      pass = msg === expected.message;
      diff = { expected: expected.message, actual: msg };
    } else if (expected && typeof expected === 'object') {
      pass = subsetEquals(error, expected);
      diff = { expected, actual: subsetForDiff(error, expected) };
    } else pass = false;
    return {
      pass,
      message: (not) => `expected the thrown error ${not}to ${typeof expected === 'function' ? 'be an instance of' : 'match'} ${describeThrowExpectation(expected)}\n\nThrown: ${error instanceof Error ? `${error.name}: ${error.message}` : inline(error, 400)}`,
      diff,
    };
  },
  toHaveBeenCalled(a) {
    const m = mockOf(a, 'toHaveBeenCalled');
    return { pass: m.mock.calls.length > 0, message: (not) => `expected "${m.getMockName()}" ${not}to be called at least once\n\nCalls:\n${callsText(m.mock.calls)}` };
  },
  toHaveBeenCalledTimes(a, n: number) {
    const m = mockOf(a, 'toHaveBeenCalledTimes');
    return { pass: m.mock.calls.length === n, message: (not) => `expected "${m.getMockName()}" ${not}to be called ${n} times, but it was called ${m.mock.calls.length} times` };
  },
  toHaveBeenCalledWith(a, ...args: unknown[]) {
    const m = mockOf(a, 'toHaveBeenCalledWith');
    return { pass: m.mock.calls.some((c) => equals(c, args)), message: (not) => `expected "${m.getMockName()}" ${not}to be called with ${inline(args, 300)}\n\nCalls:\n${callsText(m.mock.calls)}` };
  },
  toHaveBeenLastCalledWith(a, ...args: unknown[]) {
    const m = mockOf(a, 'toHaveBeenLastCalledWith');
    const last = m.mock.calls[m.mock.calls.length - 1];
    return { pass: !!last && equals(last, args), message: (not) => `expected the last call of "${m.getMockName()}" ${not}to be with ${inline(args, 300)}`, diff: last ? { expected: args, actual: last } : undefined };
  },
  toHaveBeenNthCalledWith(a, n: number, ...args: unknown[]) {
    const m = mockOf(a, 'toHaveBeenNthCalledWith');
    const call = m.mock.calls[n - 1];
    return { pass: !!call && equals(call, args), message: (not) => `expected call ${n} of "${m.getMockName()}" ${not}to be with ${inline(args, 300)}`, diff: call ? { expected: args, actual: call } : undefined };
  },
  toHaveReturned(a) {
    const m = mockOf(a, 'toHaveReturned');
    return { pass: m.mock.results.some((r) => r.type === 'return'), message: (not) => `expected "${m.getMockName()}" ${not}to have returned` };
  },
  toHaveReturnedWith(a, v: unknown) {
    const m = mockOf(a, 'toHaveReturnedWith');
    return { pass: m.mock.results.some((r) => r.type === 'return' && equals(r.value, v)), message: (not) => `expected "${m.getMockName()}" ${not}to have returned ${inline(v)}` };
  },
};
matchers.toThrowError = matchers.toThrow;
matchers.toBeCalled = matchers.toHaveBeenCalled;
matchers.toBeCalledTimes = matchers.toHaveBeenCalledTimes;
matchers.toBeCalledWith = matchers.toHaveBeenCalledWith;

function describeThrowExpectation(e: unknown): string {
  if (typeof e === 'string') return `a message including ${inline(e)}`;
  if (e instanceof RegExp) return String(e);
  if (typeof e === 'function') return e.name || 'the given class';
  if (e instanceof Error) return `the message ${inline(e.message)}`;
  return inline(e);
}

/** A rejection reason handed to toThrow under `.rejects`. */
class Thrown {
  constructor(readonly error: unknown) {}
}

export interface Assertion<R = void> {
  not: Assertion<R>;
  resolves: Assertion<Promise<void>>;
  rejects: Assertion<Promise<void>>;
  toBe(expected: unknown): R;
  toEqual(expected: unknown): R;
  toStrictEqual(expected: unknown): R;
  toMatchObject(expected: object | readonly unknown[]): R;
  toMatch(expected: string | RegExp): R;
  toContain(item: unknown): R;
  toContainEqual(item: unknown): R;
  toHaveLength(length: number): R;
  toHaveProperty(path: string | readonly (string | number)[], value?: unknown): R;
  toBeDefined(): R;
  toBeUndefined(): R;
  toBeNull(): R;
  toBeNaN(): R;
  toBeTruthy(): R;
  toBeFalsy(): R;
  toBeGreaterThan(n: number | bigint): R;
  toBeGreaterThanOrEqual(n: number | bigint): R;
  toBeLessThan(n: number | bigint): R;
  toBeLessThanOrEqual(n: number | bigint): R;
  toBeCloseTo(n: number, digits?: number): R;
  toBeInstanceOf(ctor: Function): R;
  toBeTypeOf(type: 'string' | 'number' | 'bigint' | 'boolean' | 'symbol' | 'undefined' | 'object' | 'function'): R;
  toBeOneOf(options: readonly unknown[]): R;
  toSatisfy(predicate: (value: any) => boolean, message?: string): R;
  toThrow(expected?: string | RegExp | Function | Error | object): R;
  toThrowError(expected?: string | RegExp | Function | Error | object): R;
  toHaveBeenCalled(): R;
  toHaveBeenCalledTimes(n: number): R;
  toHaveBeenCalledWith(...args: unknown[]): R;
  toHaveBeenLastCalledWith(...args: unknown[]): R;
  toHaveBeenNthCalledWith(n: number, ...args: unknown[]): R;
  toHaveReturned(): R;
  toHaveReturnedWith(value: unknown): R;
  toBeCalled(): R;
  toBeCalledTimes(n: number): R;
  toBeCalledWith(...args: unknown[]): R;
}

export interface PollOptions {
  /** Total time to keep retrying, ms (default 1000). */
  timeout?: number;
  /** Pause between attempts, ms (default 50). */
  interval?: number;
  message?: string;
}

type Mode = 'sync' | 'resolves' | 'rejects';

interface Flags {
  not: boolean;
  mode: Mode;
  message?: string;
  soft: boolean;
  /** Stack captured where expect() was called, for failures that surface after an await. */
  site?: Error;
}

function fail(outcome: Outcome, flags: Flags): AssertionError {
  const not = flags.not ? 'not ' : '';
  let message = outcome.message(not);
  if (flags.message) message = `${flags.message}: ${message}`;
  const diff = !flags.not && outcome.diff ? valueDiff(outcome.diff.expected, outcome.diff.actual, colors()) : undefined;
  const err = new AssertionError(message, { actual: outcome.diff?.actual, expected: outcome.diff?.expected, diff });
  if (flags.site?.stack) err.stack = `AssertionError: ${message}\n${flags.site.stack.split('\n').slice(1).join('\n')}`;
  return err;
}

function colors() {
  const on = state.color;
  const wrap = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[39m` : s);
  return { red: wrap(31), green: wrap(32), dim: (s: string) => (on ? `\x1b[2m${s}\x1b[22m` : s) };
}

function report(err: unknown, flags: Flags): void {
  if (flags.soft && state.running) state.running.softErrors.push(err);
  else throw err;
}

function check(name: string, actual: unknown, args: unknown[], flags: Flags): void {
  const m = matchers[name];
  const outcome = m(actual, ...args);
  if (outcome.pass === flags.not) report(fail(outcome, flags), flags);
}

function build(actual: unknown, flags: Flags): Assertion<any> {
  const target: Record<string, unknown> = {};
  for (const name of Object.keys(matchers)) {
    target[name] = (...args: unknown[]) => {
      if (flags.mode === 'sync') return check(name, actual, args, flags);
      const site = flags.site ?? new Error('expect');
      return (async () => {
        const subject = typeof actual === 'function' ? (actual as () => unknown)() : actual;
        if (flags.mode === 'resolves') {
          let value: unknown;
          try {
            value = await subject;
          } catch (e) {
            return report(fail({ pass: false, message: () => `promise rejected ${e instanceof Error ? `"${e.name}: ${e.message}"` : inline(e)} instead of resolving` }, { ...flags, not: false, site }), flags);
          }
          return check(name, value, args, { ...flags, site });
        }
        let value: unknown;
        try {
          value = await subject;
        } catch (e) {
          return check(name, name === 'toThrow' || name === 'toThrowError' ? new Thrown(e) : e, args, { ...flags, site });
        }
        return report(fail({ pass: false, message: () => `promise resolved ${inline(value)} instead of rejecting` }, { ...flags, not: false, site }), flags);
      })();
    };
  }
  Object.defineProperty(target, 'not', { get: () => build(actual, { ...flags, not: !flags.not }) });
  Object.defineProperty(target, 'resolves', { get: () => build(actual, { ...flags, mode: 'resolves', site: new Error('expect') }) });
  Object.defineProperty(target, 'rejects', { get: () => build(actual, { ...flags, mode: 'rejects', site: new Error('expect') }) });
  return target as unknown as Assertion<any>;
}

function pollAssertion(fn: () => unknown, opts: PollOptions, not: boolean): Assertion<Promise<void>> {
  const timeout = opts.timeout ?? 1000;
  const interval = opts.interval ?? 50;
  const site = new Error('expect.poll');
  const target: Record<string, unknown> = {};
  for (const name of Object.keys(matchers)) {
    target[name] = (...args: unknown[]) =>
      new Promise<void>((resolve, reject) => {
        let last: unknown;
        let done = false;
        const deadline = setTimeout(() => {
          done = true;
          const why = last instanceof Error ? last : new AssertionError(last === undefined ? 'the polled function did not settle in time' : `expect.poll: ${inline(last)}`);
          const err = new AssertionError(`${opts.message ? `${opts.message}: ` : ''}expect.poll timed out after ${timeout}ms: ${why.message}`, { diff: (why as AssertionError).diff });
          err.stack = `AssertionError: ${err.message}\n${site.stack?.split('\n').slice(1).join('\n') ?? ''}`;
          reject(err);
        }, timeout);
        const attempt = async () => {
          while (!done) {
            try {
              const value = await fn();
              if (done) return;
              check(name, value, args, { not, mode: 'sync', soft: false, site });
              done = true;
              clearTimeout(deadline);
              resolve();
              return;
            } catch (e) {
              last = e;
            }
            if (done) return;
            await new Promise((r) => setTimeout(r, interval));
          }
        };
        void attempt();
      });
  }
  Object.defineProperty(target, 'not', { get: () => pollAssertion(fn, opts, !not) });
  return target as unknown as Assertion<Promise<void>>;
}

export interface ExpectStatic {
  <T>(actual: T, message?: string): Assertion<void>;
  soft<T>(actual: T, message?: string): Assertion<void>;
  poll<T>(fn: () => T | Promise<T>, options?: PollOptions | number): Assertion<Promise<void>>;
  unreachable(message?: string): never;
  anything(): any;
  any(ctor: unknown): any;
  objectContaining<T = any>(sample: T): any;
  arrayContaining<T = unknown>(sample: readonly T[]): any;
  stringContaining(sample: string): any;
  stringMatching(sample: string | RegExp): any;
  closeTo(n: number, digits?: number): any;
  not: typeof notAsymmetric;
}

const expectFn = ((actual: unknown, message?: string) => build(actual, { not: false, mode: 'sync', message, soft: false })) as ExpectStatic;
expectFn.soft = (actual: unknown, message?: string) => build(actual, { not: false, mode: 'sync', message, soft: true });
expectFn.poll = (fn, options) => pollAssertion(fn, typeof options === 'number' ? { timeout: options } : (options ?? {}), false);
expectFn.unreachable = (message?: string): never => {
  throw new AssertionError(message ?? 'expected not to reach this point');
};
Object.assign(expectFn, asymmetric);
expectFn.not = notAsymmetric;

export const expect: ExpectStatic = expectFn;
