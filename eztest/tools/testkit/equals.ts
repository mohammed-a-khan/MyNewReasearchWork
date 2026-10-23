/**
 * Deep equality for the testkit's matchers.
 *
 * `equals(a, b)` is toEqual's notion: recursive, Object.is for primitives
 * (so NaN equals NaN and 0 differs from -0), properties whose value is
 * undefined are ignored, the object's class is not compared (its
 * Object.prototype.toString tag is), asymmetric matchers match either side.
 * `strict` (toStrictEqual) also compares classes and undefined properties.
 * `subsetEquals(actual, expected)` is toMatchObject's notion.
 */
import { isAsymmetric } from './asymmetric.js';

function tag(v: unknown): string {
  return Object.prototype.toString.call(v);
}

function keysOf(v: object, strict: boolean): Array<string | symbol> {
  const keys: Array<string | symbol> = Object.keys(v);
  for (const s of Object.getOwnPropertySymbols(v)) if (Object.getOwnPropertyDescriptor(v, s)?.enumerable) keys.push(s);
  if (strict) return keys;
  return keys.filter((k) => (v as Record<string | symbol, unknown>)[k] !== undefined);
}

function isIterableObject(v: object): v is Iterable<unknown> {
  return typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

export function equals(a: unknown, b: unknown, strict = false): boolean {
  return eq(a, b, strict, [], []);
}

function eq(a: unknown, b: unknown, strict: boolean, aStack: unknown[], bStack: unknown[]): boolean {
  if (isAsymmetric(b)) return b.matches(a);
  if (isAsymmetric(a)) return a.matches(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    // Functions are compared by identity (above).
    return false;
  }
  const ta = tag(a);
  if (ta !== tag(b)) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  switch (ta) {
    case '[object Number]':
    case '[object String]':
    case '[object Boolean]':
    case '[object BigInt]':
      return Object.is((a as { valueOf(): unknown }).valueOf(), (b as { valueOf(): unknown }).valueOf());
    case '[object Date]':
      return Object.is((a as Date).getTime(), (b as Date).getTime());
    case '[object RegExp]':
      return (a as RegExp).source === (b as RegExp).source && (a as RegExp).flags === (b as RegExp).flags;
    case '[object URL]':
      return String(a) === String(b);
  }
  if (a instanceof URL && b instanceof URL) return a.href === b.href;
  if (a instanceof Error && b instanceof Error) {
    if (a.name !== b.name || a.message !== b.message) return false;
    if (!eq((a as { cause?: unknown }).cause, (b as { cause?: unknown }).cause, strict, aStack, bStack)) return false;
    if (a instanceof AggregateError && b instanceof AggregateError && !eq(a.errors, b.errors, strict, aStack, bStack)) return false;
  }
  // Cycles: a pair already being compared is assumed equal.
  for (let i = aStack.length - 1; i >= 0; i--) if (aStack[i] === a) return bStack[i] === b;
  aStack.push(a);
  bStack.push(b);
  try {
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && !(a instanceof DataView)) {
      const x = a as unknown as ArrayLike<unknown>;
      const y = b as unknown as ArrayLike<unknown>;
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
      return true;
    }
    if (ta === '[object ArrayBuffer]') return equals(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false;
      outer: for (const x of a) {
        if (b.has(x)) continue;
        for (const y of b) if (eq(x, y, strict, aStack, bStack)) continue outer;
        return false;
      }
      return true;
    }
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      outer: for (const [k, x] of a) {
        if (b.has(k)) {
          if (!eq(x, b.get(k), strict, aStack, bStack)) return false;
          continue;
        }
        for (const [k2, y] of b) if (eq(k, k2, strict, aStack, bStack) && eq(x, y, strict, aStack, bStack)) continue outer;
        return false;
      }
      return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (strict && (i in a) !== (i in b)) return false;
        if (!eq(a[i], b[i], strict, aStack, bStack)) return false;
      }
      // Extra non-index own properties on arrays are compared too.
      const ka = Object.keys(a).filter((k) => !/^\d+$/.test(k));
      const kb = Object.keys(b).filter((k) => !/^\d+$/.test(k));
      if (ka.length || kb.length) return eqKeys(a, b, strict, aStack, bStack, ka, kb);
      return true;
    }
    if (!Array.isArray(a) && !Array.isArray(b) && isIterableObject(a) && isIterableObject(b) && a.constructor === b.constructor && ta !== '[object Object]') {
      const xa = [...a];
      const xb = [...b];
      if (xa.length !== xb.length) return false;
      for (let i = 0; i < xa.length; i++) if (!eq(xa[i], xb[i], strict, aStack, bStack)) return false;
    }
    return eqKeys(a, b, strict, aStack, bStack, keysOf(a, strict), keysOf(b, strict));
  } finally {
    aStack.pop();
    bStack.pop();
  }
}

function eqKeys(a: object, b: object, strict: boolean, aStack: unknown[], bStack: unknown[], ka: Array<string | symbol>, kb: Array<string | symbol>): boolean {
  if (ka.length !== kb.length) return false;
  const kbSet = new Set(kb);
  for (const k of ka) {
    if (!kbSet.has(k)) return false;
    if (!eq((a as Record<string | symbol, unknown>)[k], (b as Record<string | symbol, unknown>)[k], strict, aStack, bStack)) return false;
  }
  return true;
}

/** toMatchObject: every property of `expected` is in `actual` and matches (recursively); arrays match element-wise with equal lengths. */
export function subsetEquals(actual: unknown, expected: unknown, seen = new WeakMap<object, unknown>()): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  // A pattern stands for the strings it matches (`{ reason: /not enabled/ }`).
  if (expected instanceof RegExp && typeof actual === 'string') return (expected.lastIndex = 0, expected.test(actual));
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) return equals(actual, expected);
  if (expected instanceof Date || expected instanceof RegExp || expected instanceof Map || expected instanceof Set || ArrayBuffer.isView(expected) || expected instanceof URL) return equals(actual, expected);
  if (seen.get(expected) === actual) return true;
  seen.set(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => subsetEquals(actual[i], e, seen));
  }
  if (Array.isArray(actual)) return false;
  for (const k of Reflect.ownKeys(expected)) {
    if (typeof k === 'symbol' && !Object.getOwnPropertyDescriptor(expected, k)?.enumerable) continue;
    if (typeof k === 'string' && !Object.prototype.propertyIsEnumerable.call(expected, k)) continue;
    const ev = (expected as Record<string | symbol, unknown>)[k];
    if (!(k in actual)) return false;
    if (!subsetEquals((actual as Record<string | symbol, unknown>)[k], ev, seen)) return false;
  }
  return true;
}

/** The part of `actual` that toMatchObject compared, so the diff shows only what matters. */
export function subsetForDiff(actual: unknown, expected: unknown, seen = new WeakSet<object>()): unknown {
  if (isAsymmetric(expected)) return expected.matches(actual) ? expected : actual;
  if (expected instanceof RegExp && typeof actual === 'string' && (expected.lastIndex = 0, expected.test(actual))) return expected;
  if (typeof expected !== 'object' || expected === null || typeof actual !== 'object' || actual === null) return actual;
  if (seen.has(actual)) return actual;
  seen.add(actual);
  if (Array.isArray(expected) && Array.isArray(actual)) return actual.map((a, i) => (i < expected.length ? subsetForDiff(a, expected[i], seen) : a));
  if (Array.isArray(expected) || Array.isArray(actual) || expected instanceof Date || expected instanceof RegExp || expected instanceof Map || expected instanceof Set) return actual;
  const out: Record<string | symbol, unknown> = {};
  const proto = Object.getPrototypeOf(actual);
  if (proto && proto !== Object.prototype) Object.setPrototypeOf(out, proto);
  for (const k of Reflect.ownKeys(expected)) {
    if (k in actual) out[k] = subsetForDiff((actual as Record<string | symbol, unknown>)[k], (expected as Record<string | symbol, unknown>)[k], seen);
  }
  return out;
}
