/**
 * The testkit's own expect: each matcher passes and fails as EZTest's tests rely on,
 * and failures carry readable messages and diffs.
 */
import { AssertionError, describe, expect, it, vi } from '../support/testkit.js';
import { diffLines, renderDiff, valueDiff } from '../../tools/testkit/diff.js';
import { equals, subsetEquals } from '../../tools/testkit/equals.js';
import { inline, pretty } from '../../tools/testkit/format.js';

function failure(fn: () => unknown): AssertionError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AssertionError) return e;
    throw e;
  }
  throw new Error('expected an AssertionError');
}

async function asyncFailure(fn: () => Promise<unknown>): Promise<AssertionError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AssertionError) return e;
    throw e;
  }
  throw new Error('expected an AssertionError');
}

class Point {
  constructor(public x: number, public y: number) {}
}

describe('equality', () => {
  it('toEqual: recursive, ignores undefined properties and classes, Object.is for primitives', () => {
    expect({ a: 1, b: [1, { c: 'x' }], d: undefined }).toEqual({ a: 1, b: [1, { c: 'x' }] });
    expect(new Point(1, 2)).toEqual({ x: 1, y: 2 });
    expect(NaN).toEqual(NaN);
    expect(equals(0, -0)).toBe(false);
    expect([1, 2]).not.toEqual([2, 1]);
    expect({ a: 1 }).not.toEqual({ a: 1, b: 2 });
    expect(new Date(5)).toEqual(new Date(5));
    expect(new Date(5)).not.toEqual(new Date(6));
    expect(/a/g).toEqual(/a/g);
    expect(/a/g).not.toEqual(/a/i);
    expect(new Map([[1, { a: 1 }]])).toEqual(new Map([[1, { a: 1 }]]));
    expect(new Set([1, 2])).toEqual(new Set([2, 1]));
    expect(new Set([1, 2])).not.toEqual(new Set([1, 3]));
    expect(Buffer.from('ab')).toEqual(Buffer.from('ab'));
    expect(new Uint8Array([1, 2])).not.toEqual(new Uint8Array([1, 3]));
    expect([1, 2]).not.toEqual({ 0: 1, 1: 2, length: 2 });
    expect(new Error('x')).toEqual(new Error('x'));
    expect(new Error('x')).not.toEqual(new Error('y'));
    expect(new URL('https://a.example/x')).toEqual(new URL('https://a.example/x'));
  });

  it('toStrictEqual compares classes and undefined properties', () => {
    expect({ a: 1 }).toStrictEqual({ a: 1 });
    expect(new Point(1, 2)).not.toStrictEqual({ x: 1, y: 2 });
    expect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 });
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    const b: Record<string, unknown> = { n: 1 };
    b.self = b;
    expect(a).toEqual(b);
    expect(pretty(a)).toContain('[Circular]');
  });

  it('toMatchObject: subsets, recursively; arrays element-wise with equal length', () => {
    expect({ a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }] }).toMatchObject({ b: { c: 2 }, e: [{ f: 1 }] });
    expect({ a: 1 }).not.toMatchObject({ a: 1, b: 2 });
    expect({ e: [1, 2] }).not.toMatchObject({ e: [1] });
    expect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]);
    expect(subsetEquals(new Point(1, 2), { x: 1 })).toBe(true);
    expect({ d: new Date(1) }).toMatchObject({ d: new Date(1) });
    expect({ reason: 'probe not enabled here' }).toMatchObject({ reason: /not enabled/ });
    expect({ reason: 'enabled' }).not.toMatchObject({ reason: /not enabled/ });
  });

  it('asymmetric matchers', () => {
    expect({ id: 7, name: 'x', tags: ['a', 'b'], when: new Date() }).toEqual({
      id: expect.any(Number),
      name: expect.stringMatching(/^x$/),
      tags: expect.arrayContaining(['b']),
      when: expect.anything(),
    });
    expect({ a: { b: 1, c: 2 } }).toEqual({ a: expect.objectContaining({ b: 1 }) });
    expect('hello world').toEqual(expect.stringContaining('lo w'));
    expect([1, 2, 3]).toEqual(expect.arrayContaining([3, 1]));
    expect([1, 2]).not.toEqual(expect.arrayContaining([4]));
    expect(null).not.toEqual(expect.anything());
    expect('s').toEqual(expect.any(String));
    expect(new Point(1, 1)).toEqual(expect.any(Point));
    expect({ a: 'x' }).toEqual(expect.not.objectContaining({ a: 'y' }));
    expect([{ a: 1, b: 2 }]).toContainEqual(expect.objectContaining({ b: 2 }));
    expect(0.1 + 0.2).toEqual(expect.closeTo(0.3, 5));
  });
});

describe('matchers', () => {
  it('toBe, toBeDefined / Undefined / Null / NaN / Truthy / Falsy, toBeTypeOf, toBeInstanceOf', () => {
    expect(1).toBe(1);
    expect('a').not.toBe('b');
    const o = {};
    expect(o).toBe(o);
    expect({}).not.toBe({});
    expect(0).toBeDefined();
    expect(undefined).toBeUndefined();
    expect(null).toBeNull();
    expect(NaN).toBeNaN();
    expect(1).toBeTruthy();
    expect('').toBeFalsy();
    expect(1).toBeTypeOf('number');
    expect(() => 1).toBeTypeOf('function');
    expect(new Point(0, 0)).toBeInstanceOf(Point);
    expect(new TypeError('x')).toBeInstanceOf(Error);
  });

  it('numbers', () => {
    expect(2).toBeGreaterThan(1);
    expect(2).toBeGreaterThanOrEqual(2);
    expect(1).toBeLessThan(2);
    expect(2).toBeLessThanOrEqual(2);
    expect(10n).toBeGreaterThan(9n);
    expect(0.1 + 0.2).toBeCloseTo(0.3);
    expect(0.1 + 0.2).toBeCloseTo(0.3, 10);
    expect(1.01).not.toBeCloseTo(1, 2);
    expect(() => expect('1').toBeGreaterThan(0)).toThrow(TypeError);
  });

  it('strings and collections', () => {
    expect('abc').toMatch(/b/);
    expect('abc').toMatch('bc');
    expect('abc').not.toMatch(/^b/);
    expect('abc').toContain('b');
    expect([1, 2]).toContain(2);
    expect(new Set(['x'])).toContain('x');
    expect([{ a: 1 }]).not.toContain({ a: 1 });
    expect([{ a: 1 }]).toContainEqual({ a: 1 });
    expect([1, 2, 3]).toHaveLength(3);
    expect('ab').toHaveLength(2);
    expect({ a: { b: [{ c: 5 }] } }).toHaveProperty('a.b[0].c', 5);
    expect({ a: { b: 1 } }).toHaveProperty(['a', 'b']);
    expect({ a: 1 }).not.toHaveProperty('b');
    expect(3).toBeOneOf([1, 2, 3]);
    expect(4).toSatisfy((n: number) => n % 2 === 0);
  });

  it('toThrow: none, message part, regex, class, error instance, object', () => {
    const boom = () => {
      throw new RangeError('out of range: 7');
    };
    expect(boom).toThrow();
    expect(boom).toThrow('range');
    expect(boom).toThrow(/range: \d/);
    expect(boom).toThrow(RangeError);
    expect(boom).toThrow(new Error('out of range: 7'));
    expect(boom).toThrow({ name: 'RangeError' });
    expect(boom).not.toThrow(TypeError);
    expect(() => 1).not.toThrow();
    expect(() => {
      throw 'plain string';
    }).toThrow('plain');
    expect(failure(() => expect(() => 1).toThrow()).message).toBe('expected the function to throw an error, but it did not');
  });

  it('.resolves / .rejects', async () => {
    await expect(Promise.resolve({ a: 1 })).resolves.toEqual({ a: 1 });
    await expect(Promise.reject(new TypeError('bad thing'))).rejects.toThrow(/bad/);
    await expect(Promise.reject(new TypeError('bad thing'))).rejects.toBeInstanceOf(TypeError);
    await expect(Promise.reject(Object.assign(new Error('x'), { code: 42 }))).rejects.toMatchObject({ code: 42 });
    await expect(async () => {
      throw new Error('from fn');
    }).rejects.toThrow('from fn');
    expect((await asyncFailure(() => expect(Promise.resolve(1)).rejects.toThrow())).message).toBe('promise resolved 1 instead of rejecting');
    expect((await asyncFailure(() => expect(Promise.reject(new Error('no'))).resolves.toBe(1))).message).toBe('promise rejected "Error: no" instead of resolving');
  });

  it('expect.poll retries until the assertion passes, and times out with the last failure', async () => {
    let n = 0;
    await expect.poll(() => ++n, { interval: 5 }).toBeGreaterThan(3);
    await expect.poll(async () => 'ready').not.toBe('busy');
    const e = await asyncFailure(() => expect.poll(() => 'busy', { timeout: 120, interval: 10 }).toBe('ready'));
    expect(e.message).toMatch(/^expect\.poll timed out after 120ms: expected 'busy' to be 'ready'/);
    const hung = await asyncFailure(() => expect.poll(() => new Promise(() => {}), { timeout: 50 }).toBe(1));
    expect(hung.message).toContain('did not settle');
  });

  it('expect(value, message) prefixes the failure', () => {
    expect(failure(() => expect(1, 'the count').toBe(2)).message).toBe('the count: expected 1 to be 2 // Object.is equality');
  });

  it('expect.unreachable', () => {
    expect(() => expect.unreachable('nope')).toThrow('nope');
  });

  it('mock functions and spies', () => {
    const f = vi.fn((a: number) => a * 2);
    expect(f(2)).toBe(4);
    f.mockReturnValueOnce(10);
    expect(f(1)).toBe(10);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledWith(2);
    expect(f).toHaveBeenLastCalledWith(1);
    expect(f.mock.results[0]).toEqual({ type: 'return', value: 4 });
    const target = { hello: (who: string) => `hi ${who}` };
    const spy = vi.spyOn(target, 'hello').mockImplementation(() => 'mocked');
    expect(target.hello('x')).toBe('mocked');
    expect(spy.mock.calls).toEqual([['x']]);
    spy.mockRestore();
    expect(target.hello('x')).toBe('hi x');
    expect(vi.isMockFunction(spy)).toBe(true);
  });
});

describe('failure output', () => {
  it('messages name both values', () => {
    expect(failure(() => expect('a').toBe('b')).message).toBe("expected 'a' to be 'b' // Object.is equality");
    expect(failure(() => expect([1]).not.toContain(1)).message).toBe('expected [1] not to contain 1');
    expect(failure(() => expect({ a: 1 }).toBe({ a: 1 })).message).toContain('replace "toBe" with "toStrictEqual"');
  });

  it('object diffs show only the changed lines with context', () => {
    const e = failure(() => expect({ name: 'x', list: [1, 2, 3], n: 1 }).toEqual({ name: 'x', list: [1, 9, 3], n: 1 }));
    expect(e.diff).toBe(['- Expected', '+ Received', '', '  {', '    "name": "x",', '    "list": [', '      1,', '-     9,', '+     2,', '      3,', '    ],', '    "n": 1,', '  }'].join('\n'));
  });

  it('toMatchObject diffs leave out the properties it did not compare', () => {
    const e = failure(() => expect({ id: 1, other: 'noise', nested: { a: 1, b: 2 } }).toMatchObject({ nested: { a: 2 } }));
    expect(e.diff).not.toContain('noise');
    expect(e.diff).toContain('-     "a": 2,');
    expect(e.diff).toContain('+     "a": 1,');
  });

  it('asymmetric matchers that match print as unchanged', () => {
    const e = failure(() => expect({ id: 5, name: 'a' }).toEqual({ id: expect.any(Number), name: 'b' }));
    expect(e.diff).toContain('    "id": 5,');
    expect(e.diff).toContain('-   "name": "b",');
  });

  it('multi-line strings diff line by line', () => {
    const d = valueDiff('one\ntwo\nthree', 'one\n2\nthree')!;
    expect(d).toBe(['- Expected', '+ Received', '', '  one', '- two', '+ 2', '  three'].join('\n'));
  });

  it('-0 and equal values', () => {
    expect(valueDiff([0], [-0])).toContain('+   -0,');
    expect(valueDiff({ a: [1] }, { a: [1] })).toBeUndefined();
  });

  it('the line diff is minimal and long unchanged runs collapse', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'c', 'd']).map((o) => `${o.kind}${o.line}`)).toEqual([' a', '-b', ' c', '+d']);
    const a = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const b = [...a];
    b[20] = 'changed';
    const out = renderDiff(a.join('\n'), b.join('\n'));
    expect(out).toContain('  ...');
    expect(out.split('\n').length).toBeLessThan(20);
  });

  it('inline forms are short and one-line', () => {
    expect(inline({ a: [1, 2], b: 'x' })).toBe('{ "a": [1, 2], "b": "x" }');
    expect(inline('it\'s')).toBe("'it\\'s'");
    expect(inline(new Point(1, 2))).toBe('Point { "x": 1, "y": 2 }');
    expect(inline('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('expect.soft', () => {
  it('records the failure and lets the test go on', async () => {
    // Soft failures fail the test at its end; check the bookkeeping directly.
    const { state } = await import('../../tools/testkit/state.js');
    const saved = state.running!.softErrors.length;
    expect.soft(1).toBe(2);
    expect(state.running!.softErrors.length).toBe(saved + 1);
    state.running!.softErrors.pop();
  });
});
