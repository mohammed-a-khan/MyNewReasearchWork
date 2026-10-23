/**
 * Response assertions. Each throws an AssertionFailure with a precise message
 * (never a bare "expected true"), so failures read well in reports.
 */
import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { EzTestError } from '../core/index.js';
import type { ApiResponse } from './api.js';
import { getPath, hasPath } from './jsonpath.js';

type AjvLike = { compile(schema: object): ValidateFn };
type ValidateFn = ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string; params?: unknown }> | null };

// ajv ships CJS with a `default` export; NodeNext sees the module object.
const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => AjvLike;
const Ajv2020Ctor = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (o: object) => AjvLike;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: AjvLike) => void;

export class AssertionFailure extends EzTestError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ASSERTION_FAILED', details);
    this.name = 'AssertionFailure';
  }
}

let ajv07: AjvLike | undefined;
let ajv2020: AjvLike | undefined;
const compiled = new WeakMap<object, ValidateFn>();

function ajvFor(schema: Record<string, unknown>): AjvLike {
  const is2020 = typeof schema.$schema === 'string' && /2020-12|2019-09/.test(schema.$schema);
  if (is2020) {
    if (!ajv2020) {
      ajv2020 = new Ajv2020Ctor({ allErrors: true, strict: false });
      addFormats(ajv2020);
    }
    return ajv2020;
  }
  if (!ajv07) {
    ajv07 = new AjvCtor({ allErrors: true, strict: false });
    addFormats(ajv07);
  }
  return ajv07;
}

export interface SchemaResult {
  valid: boolean;
  errors: string[];
}

/** Validate data against a JSON Schema (draft-07 by default, 2019-09/2020-12 via $schema) with formats. */
export function validateSchema(data: unknown, schema: Record<string, unknown>): SchemaResult {
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    throw new EzTestError('validateSchema needs a non-empty JSON Schema', 'SCHEMA_EMPTY');
  }
  let fn = compiled.get(schema);
  if (!fn) {
    fn = ajvFor(schema).compile(schema);
    compiled.set(schema, fn);
  }
  const valid = fn(data);
  const errors = valid ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}${e.params ? ' ' + JSON.stringify(e.params) : ''}`);
  return { valid: Boolean(valid), errors };
}

const bodyOf = (r: ApiResponse | unknown): unknown =>
  r && typeof r === 'object' && 'status' in r && 'headers' in r && 'body' in r ? (r as ApiResponse).body : r;

export function expectSchema(resOrData: ApiResponse | unknown, schema: Record<string, unknown>): void {
  const r = validateSchema(bodyOf(resOrData), schema);
  if (!r.valid) throw new AssertionFailure(`Response does not match schema:\n  - ${r.errors.join('\n  - ')}`, { errors: r.errors });
}

export function expectStatus(res: ApiResponse, expected: number | number[] | '2xx' | '3xx' | '4xx' | '5xx'): void {
  const ok =
    typeof expected === 'string'
      ? Math.floor(res.status / 100) === Number(expected[0])
      : Array.isArray(expected)
        ? expected.includes(res.status)
        : res.status === expected;
  if (!ok) {
    const snippet = res.text.length > 300 ? res.text.slice(0, 300) + '...' : res.text;
    throw new AssertionFailure(`${res.method} ${res.url}: expected status ${JSON.stringify(expected)}, got ${res.status}. Body: ${snippet}`, {
      status: res.status,
    });
  }
}

export function expectHeader(res: ApiResponse, name: string, expected?: string | RegExp): void {
  const v = res.header(name);
  if (v === undefined) throw new AssertionFailure(`Expected header "${name}" to be present`);
  if (expected === undefined) return;
  const ok = typeof expected === 'string' ? v === expected : expected.test(v);
  if (!ok) throw new AssertionFailure(`Header "${name}": expected ${String(expected)}, got "${v}"`);
}

/** Assert the value at a JSON path. With no expected value, asserts the path exists. */
export function expectJsonPath(resOrData: ApiResponse | unknown, path: string, ...expected: [] | [unknown]): void {
  const data = bodyOf(resOrData);
  if (!hasPath(data, path)) throw new AssertionFailure(`Path ${path} not found in response`);
  if (expected.length === 0) return;
  const actual = getPath(data, path);
  if (!deepEqual(actual, expected[0])) {
    throw new AssertionFailure(`Path ${path}: expected ${JSON.stringify(expected[0])}, got ${JSON.stringify(actual)}`);
  }
}

export function expectResponseTime(res: ApiResponse, maxMs: number): void {
  if (!(res.durationMs <= maxMs)) throw new AssertionFailure(`${res.method} ${res.url} took ${res.durationMs}ms, budget ${maxMs}ms`);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
