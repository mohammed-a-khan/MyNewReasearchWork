/**
 * Mock functions and spies (`vi.fn`, `vi.spyOn`) plus a few `vi` helpers.
 * Module mocking and fake timers are not provided: EZTest's tests use real modules and clocks.
 */
const MOCK = Symbol.for('eztest.testkit.mock');

type AnyFn = (...args: any[]) => any;

export interface MockResult<R> {
  type: 'return' | 'throw';
  value: R | unknown;
}

export interface MockInstance<A extends any[] = any[], R = any> {
  mock: { calls: A[]; results: Array<MockResult<R>>; instances: unknown[]; lastCall: A | undefined };
  getMockName(): string;
  mockName(name: string): this;
  mockImplementation(fn: (...args: A) => R): this;
  mockImplementationOnce(fn: (...args: A) => R): this;
  mockReturnValue(v: R): this;
  mockReturnValueOnce(v: R): this;
  mockResolvedValue(v: Awaited<R>): this;
  mockResolvedValueOnce(v: Awaited<R>): this;
  mockRejectedValue(e: unknown): this;
  mockRejectedValueOnce(e: unknown): this;
  /** Forgets recorded calls. */
  mockClear(): this;
  /** Forgets calls and implementations. */
  mockReset(): this;
  /** mockReset(), and for a spy puts the original method back. */
  mockRestore(): void;
}

export interface Mock<A extends any[] = any[], R = any> extends MockInstance<A, R> {
  (...args: A): R;
  new (...args: A): R;
}

const registry = new Set<MockInstance>();

export function isMock(v: unknown): v is MockInstance {
  return typeof v === 'function' && (v as unknown as Record<symbol, unknown>)[MOCK] === true;
}

function createMock<A extends any[], R>(impl?: (...args: A) => R, restore?: () => void, name = 'vi.fn()'): Mock<A, R> {
  let base = impl;
  let once: Array<(...args: A) => R> = [];
  let mockName = name;
  const mock = { calls: [] as A[], results: [] as Array<MockResult<R>>, instances: [] as unknown[], lastCall: undefined as A | undefined };
  const f = function (this: unknown, ...args: A) {
    mock.calls.push(args);
    mock.lastCall = args;
    mock.instances.push(this);
    const fn = once.length ? once.shift() : base;
    try {
      const value = fn ? (new.target ? Reflect.construct(fn as AnyFn, args, new.target) : fn.apply(this, args)) : undefined;
      mock.results.push({ type: 'return', value });
      return value;
    } catch (e) {
      mock.results.push({ type: 'throw', value: e });
      throw e;
    }
  } as unknown as Mock<A, R>;
  const api: Omit<MockInstance<A, R>, 'mock'> = {
    getMockName: () => mockName,
    mockName(n: string) {
      mockName = n;
      return f;
    },
    mockImplementation(fn) {
      base = fn;
      return f;
    },
    mockImplementationOnce(fn) {
      once.push(fn);
      return f;
    },
    mockReturnValue(v) {
      base = () => v;
      return f;
    },
    mockReturnValueOnce(v) {
      once.push(() => v);
      return f;
    },
    mockResolvedValue(v) {
      base = (() => Promise.resolve(v)) as unknown as (...args: A) => R;
      return f;
    },
    mockResolvedValueOnce(v) {
      once.push((() => Promise.resolve(v)) as unknown as (...args: A) => R);
      return f;
    },
    mockRejectedValue(e) {
      base = (() => Promise.reject(e)) as unknown as (...args: A) => R;
      return f;
    },
    mockRejectedValueOnce(e) {
      once.push((() => Promise.reject(e)) as unknown as (...args: A) => R);
      return f;
    },
    mockClear() {
      mock.calls.length = 0;
      mock.results.length = 0;
      mock.instances.length = 0;
      mock.lastCall = undefined;
      return f;
    },
    mockReset() {
      api.mockClear();
      base = impl;
      once = [];
      return f;
    },
    mockRestore() {
      api.mockReset();
      restore?.();
      registry.delete(f);
    },
  } as Omit<MockInstance<A, R>, 'mock'>;
  Object.assign(f, api, { mock });
  Object.defineProperty(f, MOCK, { value: true });
  registry.add(f);
  return f;
}

type Methods<T> = { [K in keyof T]-?: T[K] extends AnyFn ? K : never }[keyof T];

export const vi = {
  fn<F extends AnyFn = (...args: any[]) => any>(impl?: F): Mock<Parameters<F>, ReturnType<F>> {
    return createMock<Parameters<F>, ReturnType<F>>(impl);
  },
  spyOn<T extends object, K extends Methods<T>>(obj: T, key: K): Mock<T[K] extends AnyFn ? Parameters<T[K]> : never, T[K] extends AnyFn ? ReturnType<T[K]> : never> {
    const original = obj[key] as unknown as AnyFn;
    if (typeof original !== 'function') throw new TypeError(`vi.spyOn: ${String(key)} is not a function`);
    const own = Object.prototype.hasOwnProperty.call(obj, key);
    const spy = createMock(original, () => {
      if (own) (obj as Record<PropertyKey, unknown>)[key as PropertyKey] = original;
      else delete (obj as Record<PropertyKey, unknown>)[key as PropertyKey];
    }, String(key));
    (obj as Record<PropertyKey, unknown>)[key as PropertyKey] = spy;
    return spy as never;
  },
  isMockFunction: isMock,
  clearAllMocks(): void {
    for (const m of registry) m.mockClear();
  },
  resetAllMocks(): void {
    for (const m of registry) m.mockReset();
  },
  restoreAllMocks(): void {
    for (const m of [...registry]) m.mockRestore();
  },
  /** Retries `fn` until it returns without throwing (default timeout 1000 ms, interval 50 ms). */
  async waitFor<T>(fn: () => T | Promise<T>, options: { timeout?: number; interval?: number } | number = {}): Promise<T> {
    const o = typeof options === 'number' ? { timeout: options } : options;
    const end = Date.now() + (o.timeout ?? 1000);
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (Date.now() >= end) throw e;
      }
      await new Promise((r) => setTimeout(r, o.interval ?? 50));
    }
  },
  stubEnv(name: string, value: string | undefined): void {
    if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  },
  unstubAllEnvs(): void {
    for (const [k, v] of stubbedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    stubbedEnv.clear();
  },
};

const stubbedEnv = new Map<string, string | undefined>();
