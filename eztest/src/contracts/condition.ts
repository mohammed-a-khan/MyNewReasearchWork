/**
 * "Expect response orders to conform to OpenAPI "specs/shop.yaml"": the
 * apiContract post-condition. The API step remembers which request produced
 * each captured response, so the condition can find the operation; naming the
 * operation explicitly works for any captured value.
 */
import { resolve } from 'node:path';
import type { Condition, ConditionResult } from '../core/index.js';
import { apiRequestOf } from './condition-rules.js';
import { cachedSpec, describeViolations, validateExchange } from './openapi.js';

export { rememberApiRequest, apiRequestOf, type ApiRequestMeta } from './condition-rules.js';

type ApiContractCondition = Extract<Condition, { type: 'apiContract' }>;

export interface ContractConditionEnv {
  ledger: { get(k: string): unknown };
  interpolate: (s: string) => string;
  baseDir?: string;
  /** The configured api.spec (absolute path), used when the condition names no spec. */
  apiSpec?: string;
}

export function evaluateApiContract(c: ApiContractCondition, env: ContractConditionEnv): ConditionResult {
  const fail = (message: string): ConditionResult => ({ condition: c, passed: false, message });
  const v = env.ledger.get(c.captureKey) as { status?: number; headers?: Record<string, string>; body?: unknown } | undefined;
  if (v === undefined) return fail(`ledger has no value "${c.captureKey}"`);
  const file = c.spec ? resolve(env.baseDir ?? process.cwd(), env.interpolate(c.spec)) : env.apiSpec;
  if (!file) return fail('no API spec: name one ("conforms to OpenAPI "specs/api.yaml"") or set api.spec in the config');
  let spec;
  try {
    spec = cachedSpec(file);
  } catch (e) {
    return fail((e as Error).message);
  }
  const req = apiRequestOf(v);
  if (!req && !c.operation) return fail(`${c.captureKey} was not captured by an API step in this run; name the operation ("conforms to the API spec operation "getOrder"")`);
  const r = validateExchange(spec, {
    method: req?.method ?? 'GET', url: req?.url ?? '/', requestBody: req?.requestBody, requestContentType: req?.requestContentType, requestHeaders: req?.requestHeaders,
    status: v.status, responseHeaders: v.headers, responseBody: v.body,
  }, { ...(c.operation ? { operation: env.interpolate(c.operation) } : {}), ...(req ? {} : { request: false }) });
  return r.valid ? { condition: c, passed: true, actual: `conforms to ${r.operation}` } : { condition: c, passed: false, message: describeViolations(r), actual: r.violations.map((x) => x.message).join('; ') };
}
