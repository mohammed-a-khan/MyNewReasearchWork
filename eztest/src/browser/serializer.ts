/**
 * Value transfer between Node and the page for evaluate():
 *
 * Both directions use the same tagged-JSON encoding. Plain JSON values pass
 * as is; everything else is an object with an `__ez$` tag:
 *   u undefined | n NaN/Infinity/-Infinity/-0 | b bigint | d Date | r RegExp
 *   e Error | url URL | a array | o object | map Map | set Set | ref (cycle)
 *   h handle (argument only: index into the handle list)
 * Arrays and objects carry an id (pre-order index) so cycles and shared
 * references survive the trip.
 *
 * The page side is a self-contained function (stringified into the
 * evaluation wrapper).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Tagged = any;

/** Page-side codec. Returns {ser, deser}. Self-contained (stringified). */
export function pageCodec() {
  function ser(value: unknown, seen: Map<object, number> = new Map()): unknown {
    if (value === undefined) return { __ez$: 'u' };
    if (value === null) return null;
    const t = typeof value;
    if (t === 'number') {
      const n = value as number;
      if (Number.isNaN(n)) return { __ez$: 'n', v: 'NaN' };
      if (n === Infinity) return { __ez$: 'n', v: 'Infinity' };
      if (n === -Infinity) return { __ez$: 'n', v: '-Infinity' };
      if (Object.is(n, -0)) return { __ez$: 'n', v: '-0' };
      return n;
    }
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'bigint') return { __ez$: 'b', v: String(value) };
    if (t === 'function' || t === 'symbol') return { __ez$: 'u' };
    const o = value as object;
    if (o instanceof Date) return { __ez$: 'd', v: Number.isNaN(o.getTime()) ? null : o.toISOString() };
    if (o instanceof RegExp) return { __ez$: 'r', s: o.source, f: o.flags };
    if (o instanceof Error) return { __ez$: 'e', n: o.name, m: o.message, s: o.stack };
    if (typeof URL !== 'undefined' && o instanceof URL) return { __ez$: 'url', v: o.href };
    if (typeof Node !== 'undefined' && o instanceof Node) return { __ez$: 'u' };
    if (typeof Window !== 'undefined' && o instanceof Window) return { __ez$: 'u' };
    if (seen.has(o)) return { __ez$: 'ref', id: seen.get(o) };
    const id = seen.size;
    seen.set(o, id);
    if (Array.isArray(o)) return { __ez$: 'a', id, v: o.map((x) => ser(x, seen)) };
    if (o instanceof Map) return { __ez$: 'map', id, v: [...o.entries()].map(([k, v]) => [ser(k, seen), ser(v, seen)]) };
    if (o instanceof Set) return { __ez$: 'set', id, v: [...o.values()].map((v) => ser(v, seen)) };
    if (ArrayBuffer.isView(o)) return { __ez$: 'a', id, v: Array.from(o as unknown as ArrayLike<number>).map((x) => ser(x, seen)) };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      let v: unknown;
      try {
        v = (o as Record<string, unknown>)[k];
      } catch {
        continue;
      }
      out[k] = ser(v, seen);
    }
    return { __ez$: 'o', id, v: out };
  }

  function deser(value: unknown, handles: unknown[], refs: unknown[] = []): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((x) => deser(x, handles, refs));
    const v = value as Record<string, any>;
    switch (v.__ez$) {
      case 'u': return undefined;
      case 'n': return v.v === 'NaN' ? NaN : v.v === 'Infinity' ? Infinity : v.v === '-Infinity' ? -Infinity : -0;
      case 'b': return BigInt(v.v);
      case 'd': return new Date(v.v === null ? NaN : v.v);
      case 'r': return new RegExp(v.s, v.f);
      case 'e': {
        const e = new Error(v.m);
        e.name = v.n;
        if (v.s) e.stack = v.s;
        return e;
      }
      case 'url': return new URL(v.v);
      case 'h': return handles[v.i];
      case 'ref': return refs[v.id];
      case 'a': {
        const arr: unknown[] = [];
        refs[v.id] = arr;
        for (const x of v.v) arr.push(deser(x, handles, refs));
        return arr;
      }
      case 'map': {
        const m = new Map();
        refs[v.id] = m;
        for (const [k, x] of v.v) m.set(deser(k, handles, refs), deser(x, handles, refs));
        return m;
      }
      case 'set': {
        const s = new Set();
        refs[v.id] = s;
        for (const x of v.v) s.add(deser(x, handles, refs));
        return s;
      }
      case 'o': {
        const o: Record<string, unknown> = {};
        refs[v.id] = o;
        for (const k of Object.keys(v.v)) o[k] = deser(v.v[k], handles, refs);
        return o;
      }
      default: {
        // Untagged plain object (hand-written JSON).
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(v)) o[k] = deser(v[k], handles, refs);
        return o;
      }
    }
  }
  return { ser, deser };
}

/** Node side: encode an argument; values for which `isHandle` is true become handle references. */
export function serializeArgument(value: unknown, isHandle: (v: unknown) => boolean, handles: unknown[]): Tagged {
  const seen = new Map<object, number>();
  const visit = (v: unknown): Tagged => {
    if (isHandle(v)) {
      const i = handles.indexOf(v);
      if (i >= 0) return { __ez$: 'h', i };
      handles.push(v);
      return { __ez$: 'h', i: handles.length - 1 };
    }
    if (v === undefined) return { __ez$: 'u' };
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number') {
      const n = v as number;
      if (Number.isNaN(n)) return { __ez$: 'n', v: 'NaN' };
      if (n === Infinity) return { __ez$: 'n', v: 'Infinity' };
      if (n === -Infinity) return { __ez$: 'n', v: '-Infinity' };
      if (Object.is(n, -0)) return { __ez$: 'n', v: '-0' };
      return n;
    }
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'bigint') return { __ez$: 'b', v: String(v) };
    if (t === 'function') throw new Error('evaluate(): a function cannot be an argument (pass data; put the function in the page code instead)');
    if (t === 'symbol') return { __ez$: 'u' };
    const o = v as object;
    if (o instanceof Date) return { __ez$: 'd', v: Number.isNaN(o.getTime()) ? null : o.toISOString() };
    if (o instanceof RegExp) return { __ez$: 'r', s: o.source, f: o.flags };
    if (o instanceof Error) return { __ez$: 'e', n: o.name, m: o.message, s: o.stack };
    if (o instanceof URL) return { __ez$: 'url', v: o.href };
    if (seen.has(o)) return { __ez$: 'ref', id: seen.get(o) };
    const id = seen.size;
    seen.set(o, id);
    if (Array.isArray(o)) return { __ez$: 'a', id, v: o.map(visit) };
    if (o instanceof Map) return { __ez$: 'map', id, v: [...o.entries()].map(([k, x]) => [visit(k), visit(x)]) };
    if (o instanceof Set) return { __ez$: 'set', id, v: [...o.values()].map(visit) };
    if (Buffer.isBuffer(o) || ArrayBuffer.isView(o)) return { __ez$: 'a', id, v: Array.from(o as unknown as ArrayLike<number>) };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = visit((o as Record<string, unknown>)[k]);
    return { __ez$: 'o', id, v: out };
  };
  return visit(value);
}

/** Node side: decode a value produced by the page-side `ser`. */
export function deserializeValue(value: Tagged): unknown {
  return pageCodec().deser(value, []);
}

/**
 * Normalise a function's source so it can be used as an expression:
 * method shorthand (`name() {}` / `async name() {}`) becomes a function expression.
 */
export function functionSource(fn: (...args: any[]) => unknown): string {
  const src = fn.toString();
  if (/^\s*(async\s+)?function\b/.test(src)) return src;
  if (/^\s*(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(src)) return src;
  if (/^\s*(async\s*)?\(/.test(src)) return src; // arrow with destructured params
  if (/^\s*class\b/.test(src)) return src;
  if (/^\s*async\s+/.test(src)) return `async function ${src.replace(/^\s*async\s+/, '')}`;
  if (/^\s*\*/.test(src)) return `function${src}`;
  return `function ${src}`;
}

/** The no-op helper esbuild's keepNames transform (tsx, EZTest's testkit) expects in function sources. */
export const KEEP_NAMES_SHIM = 'var __name = function (f) { return f; };';
