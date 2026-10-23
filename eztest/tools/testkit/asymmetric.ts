/**
 * Asymmetric matchers: values that stand for "anything matching X" inside
 * toEqual / toMatchObject / toHaveBeenCalledWith expectations.
 */
import { equals } from './equals.js';
import { inline } from './format.js';

const MARK = Symbol.for('eztest.testkit.asymmetric');

export abstract class Asymmetric {
  readonly [MARK] = true;
  constructor(protected readonly inverse = false) {}
  abstract test(other: unknown): boolean;
  abstract describe(): string;
  matches(other: unknown): boolean {
    return this.inverse ? !this.test(other) : this.test(other);
  }
  toString(): string {
    return `${this.inverse ? 'Not' : ''}${this.describe()}`;
  }
  toJSON(): string {
    return this.toString();
  }
}

export function isAsymmetric(v: unknown): v is Asymmetric {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[MARK] === true;
}

class Anything extends Asymmetric {
  test(other: unknown) {
    return other !== null && other !== undefined;
  }
  describe() {
    return 'Anything';
  }
}

class Any extends Asymmetric {
  constructor(private readonly ctor: unknown, inverse = false) {
    super(inverse);
    if (ctor === undefined) throw new TypeError('expect.any() needs a constructor, e.g. expect.any(String)');
  }
  test(other: unknown) {
    const c = this.ctor;
    if (c === String) return typeof other === 'string' || other instanceof String;
    if (c === Number) return typeof other === 'number' || other instanceof Number;
    if (c === Boolean) return typeof other === 'boolean' || other instanceof Boolean;
    if (c === BigInt) return typeof other === 'bigint';
    if (c === Symbol) return typeof other === 'symbol';
    if (c === Function) return typeof other === 'function';
    if (c === Object) return other !== null && typeof other === 'object';
    return typeof c === 'function' && other instanceof (c as new (...a: unknown[]) => unknown);
  }
  describe() {
    return `Any<${(this.ctor as { name?: string })?.name ?? String(this.ctor)}>`;
  }
}

class ObjectContaining extends Asymmetric {
  constructor(private readonly sample: Record<string | symbol, unknown>, inverse = false) {
    super(inverse);
  }
  test(other: unknown) {
    if (other === null || other === undefined || typeof other !== 'object' && typeof other !== 'function') return false;
    for (const k of Reflect.ownKeys(this.sample)) {
      if (!(k in (other as object))) return false;
      if (!equals((other as Record<string | symbol, unknown>)[k], this.sample[k])) return false;
    }
    return true;
  }
  describe() {
    return `ObjectContaining ${inline(this.sample, 400)}`;
  }
}

class ArrayContaining extends Asymmetric {
  constructor(private readonly sample: unknown[], inverse = false) {
    super(inverse);
    if (!Array.isArray(sample)) throw new TypeError('expect.arrayContaining() needs an array');
  }
  test(other: unknown) {
    if (!Array.isArray(other)) return false;
    return this.sample.every((s) => other.some((o) => equals(o, s)));
  }
  describe() {
    return `ArrayContaining ${inline(this.sample, 400)}`;
  }
}

class StringContaining extends Asymmetric {
  constructor(private readonly sample: string, inverse = false) {
    super(inverse);
  }
  test(other: unknown) {
    return typeof other === 'string' && other.includes(this.sample);
  }
  describe() {
    return `StringContaining ${inline(this.sample)}`;
  }
}

class StringMatching extends Asymmetric {
  private readonly re: RegExp;
  constructor(sample: string | RegExp, inverse = false) {
    super(inverse);
    this.re = typeof sample === 'string' ? new RegExp(sample) : sample;
  }
  test(other: unknown) {
    return typeof other === 'string' && this.re.test(other);
  }
  describe() {
    return `StringMatching ${String(this.re)}`;
  }
}

class CloseTo extends Asymmetric {
  constructor(private readonly n: number, private readonly digits = 2, inverse = false) {
    super(inverse);
  }
  test(other: unknown) {
    return typeof other === 'number' && Math.abs(other - this.n) < 10 ** -this.digits / 2;
  }
  describe() {
    return `NumberCloseTo ${this.n} (${this.digits} digits)`;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- asymmetric matchers stand in for any value */
export const asymmetric = {
  anything: (): any => new Anything(),
  any: (ctor: unknown): any => new Any(ctor),
  objectContaining: (sample: object): any => new ObjectContaining(sample as Record<string, unknown>),
  arrayContaining: (sample: readonly unknown[]): any => new ArrayContaining([...sample]),
  stringContaining: (sample: string): any => new StringContaining(sample),
  stringMatching: (sample: string | RegExp): any => new StringMatching(sample),
  closeTo: (n: number, digits?: number): any => new CloseTo(n, digits),
};

export const notAsymmetric = {
  objectContaining: (sample: object): any => new ObjectContaining(sample as Record<string, unknown>, true),
  arrayContaining: (sample: readonly unknown[]): any => new ArrayContaining([...sample], true),
  stringContaining: (sample: string): any => new StringContaining(sample, true),
  stringMatching: (sample: string | RegExp): any => new StringMatching(sample, true),
  closeTo: (n: number, digits?: number): any => new CloseTo(n, digits, true),
};
