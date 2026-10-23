/**
 * The API-step hook: with `api.spec` configured, every API step's exchange is
 * validated against the spec (and recorded as contract evidence, which also
 * feeds API coverage); a contract break fails the step (mode "enforce") or is
 * only recorded ("warn"). Inside a contract session the exchange also becomes
 * a contract expectation.
 */
import { EzTestError } from '../core/index.js';
import { safeName } from '../runner/evidence.js';
import type { ApiExchangeHook } from '../runner/types.js';
import type { ContractRecorder } from './consumer.js';
import { cachedSpec, describeViolations, validateExchange, type ApiSpec } from './openapi.js';

export interface ContractHookOptions {
  /** Absolute spec path(s); the first spec with a matching operation validates the call. */
  specs?: string[];
  mode?: 'enforce' | 'warn';
  /** Fail calls that match no operation of any spec (default false: they are only reported as not covered). */
  strictPaths?: boolean;
  recorder?: ContractRecorder;
}

export interface ContractEvidence {
  method: string;
  url: string;
  status: number;
  spec?: string;
  operation?: string;
  valid: boolean;
  violations: Array<{ side: string; kind: string; pointer?: string; message: string }>;
  headerNames: string[];
  hasBody: boolean;
}

export function createContractHook(o: ContractHookOptions): ApiExchangeHook | undefined {
  const specs = o.specs ?? [];
  if (!specs.length && !o.recorder) return undefined;
  return async (x, ctx) => {
    const evidence: string[] = [];
    if (o.recorder) await o.recorder.recordHttp(ctx.ledger, x, x.step.intent);
    if (!specs.length || x.call.graphql || x.call.soap) return evidence;
    let chosen: { spec: ApiSpec; file: string } | undefined;
    let result: ReturnType<typeof validateExchange> | undefined;
    const ct = Object.entries(x.call.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    let body = x.call.body;
    if (typeof body === 'string' && ct && /x-www-form-urlencoded/i.test(ct)) body = Object.fromEntries(new URLSearchParams(body));
    if (body instanceof Uint8Array || (typeof FormData !== 'undefined' && body instanceof FormData)) body = undefined;
    for (const file of specs) {
      const spec = cachedSpec(file);
      const r = validateExchange(spec, {
        method: x.call.method, url: x.url, requestHeaders: x.call.headers, requestBody: body, ...(ct ? { requestContentType: ct } : {}),
        status: x.response.status, responseHeaders: x.response.headers, responseBody: x.response.body,
      });
      if (!result || r.operation) {
        result = r;
        chosen = { spec, file };
      }
      if (r.operation) break;
    }
    if (!result || !chosen) return evidence;
    const unknown = !result.operation;
    const record: ContractEvidence = {
      method: x.call.method, url: x.url, status: x.response.status, spec: chosen.file, ...(result.operation ? { operation: result.operation } : {}),
      valid: result.valid, violations: result.violations, headerNames: Object.keys(x.call.headers ?? {}), hasBody: body !== undefined && body !== '',
    };
    const ref = await ctx.evidence.store('data', `contracts/${safeName(ctx.journey.id)}/${safeName(x.step.id)}.json`, JSON.stringify(record, null, 2), {
      journeyId: ctx.journey.id, stepId: x.step.id, description: `API contract ${result.valid ? 'ok' : 'violated'}: ${x.call.method} ${x.url}`,
    });
    evidence.push(ref.id);
    if (!result.valid && (o.mode ?? 'enforce') === 'enforce' && (!unknown || o.strictPaths)) {
      throw new EzTestError(describeViolations(result, 8), 'API_CONTRACT', { violations: result.violations, evidence: ref.id });
    }
    if (!result.valid) ctx.logger.warn(describeViolations(result, 8));
    return evidence;
  };
}
