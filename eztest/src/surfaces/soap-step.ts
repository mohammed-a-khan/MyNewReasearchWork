/**
 * The step "Call SOAP operation <op> on <service> with ..." (custom handler
 * "eztest.soap"): runs a configured SOAP service call and keeps the response
 * (status, headers, parsed body, fault, validation and WS-Security results)
 * in the ledger, with request and response as masked network evidence.
 */
import { EzTestError, type Step } from '../core/index.js';
import type { StepContext } from '../runner/types.js';
import type { SoapConfig } from './soap-config.js';
import { flattenParams, SoapServiceClient, type SoapServiceOptions } from './soap-service.js';

export const SOAP_STEP = 'eztest.soap';

function safe(s: string): string {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'x';
}

export function createSoapStepHandler(cfg: SoapConfig | undefined, opts: Omit<SoapServiceOptions, 'fetch'> & { fetch?: typeof fetch }) {
  const clients = new Map<string, SoapServiceClient>();
  const client = (name: string): SoapServiceClient => {
    let c = clients.get(name);
    if (!c) {
      const svc = cfg?.services?.[name];
      if (!svc) throw new EzTestError(`No SOAP service "${name}" in soap.services (known: ${Object.keys(cfg?.services ?? {}).join(', ') || 'none'})`, 'CONFIG');
      c = new SoapServiceClient(name, svc, opts);
      clients.set(name, c);
    }
    return c;
  };
  return async (_page: unknown, step: Step, ctx: StepContext): Promise<Record<string, unknown>> => {
    const a = (step.args ?? {}) as Record<string, unknown>;
    const I = (v: unknown) => ctx.interpolate(String(v));
    const service = I(a.service);
    const operation = I(a.operation);
    let params: Record<string, string> | undefined;
    if (a.params && typeof a.params === 'object') params = Object.fromEntries(Object.entries(a.params as Record<string, unknown>).map(([k, v]) => [k, I(v)]));
    if (typeof a.json === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(I(a.json));
      } catch (e) {
        throw new EzTestError(`SOAP values are not valid JSON: ${(e as Error).message}`, 'SOAP_PARAM');
      }
      params = { ...flattenParams(parsed), ...(params ?? {}) };
    }
    const c = client(service);
    const mask = ctx.session?.mask ?? ((s: string) => s);
    const result = await c.call(operation, {
      ...(params ? { params } : {}), ...(a.body !== undefined ? { body: I(a.body) } : {}), ...(a.file !== undefined ? { file: I(a.file) } : {}),
      ...(a.allowFault === true ? { allowFault: true } : {}),
    });
    const entry = {
      method: 'POST', url: result.url, status: result.status, timing: result.durationMs, soapOperation: `${service}.${operation}`,
      requestBody: result.requestXml, responseHeaders: result.headers, responseBody: result.xml, journeyId: ctx.journey.id, stepId: step.id,
    };
    const ref = await ctx.evidence.store('network', `soap/${safe(ctx.journey.id)}/${safe(step.id)}.json`, mask(JSON.stringify({ entries: [entry] }, null, 2)),
      { journeyId: ctx.journey.id, stepId: step.id, description: `SOAP ${service}.${operation}` });
    const key = step.captureAs ?? 'response';
    const value = {
      status: result.status, headers: result.headers, body: result.body, ...(result.fault ? { fault: result.fault } : {}), durationMs: result.durationMs,
      xml: result.xml, valid: { request: result.validation.request?.valid ?? null, response: result.validation.response?.valid ?? null },
      ...(result.security ? { security: { ok: result.security.ok, signed: result.security.signed, trusted: result.security.trusted ?? null, signedParts: result.security.signedParts } } : {}),
      ...(result.attachments ? { attachments: result.attachments } : {}), evidence: ref.id,
    };
    ctx.ledger.set(key, value);
    return { [key]: value };
  };
}
