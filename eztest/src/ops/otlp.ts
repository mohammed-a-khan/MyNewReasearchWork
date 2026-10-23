/**
 * OpenTelemetry trace export of a run, as OTLP/HTTP JSON (POST /v1/traces),
 * implemented directly (no SDK dependency).
 *
 * One trace per run: a root span for the run, a child span per journey
 * attempt and a span per step (block children nested). The trace id is derived
 * from the run id, so re-exporting a run is idempotent. Failed spans carry
 * status ERROR and the (already masked) error message.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { RunResult, StepResult } from '../core/index.js';
import { EZTEST_VERSION } from './version.js';

type AttrValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
interface Attr {
  key: string;
  value: AttrValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
}

const attr = (key: string, v: string | number | boolean | undefined): Attr | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: v } };
};
const attrs = (o: Record<string, string | number | boolean | undefined>): Attr[] => Object.entries(o).map(([k, v]) => attr(k, v)).filter((a): a is Attr => !!a);
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const spanId = () => randomBytes(8).toString('hex');
const STATUS_OK = 1;
const STATUS_ERROR = 2;

export function traceIdForRun(runId: string): string {
  return createHash('sha256').update(`eztest-run:${runId}`).digest('hex').slice(0, 32);
}

/** Build the OTLP JSON payload for a run. */
export function runToOtlp(run: RunResult, o: { serviceName?: string; resource?: Record<string, string> } = {}): { resourceSpans: unknown[] } {
  const traceId = traceIdForRun(run.runId);
  const spans: OtlpSpan[] = [];
  const runStart = Date.parse(run.startedAt);
  const runEnd = Date.parse(run.finishedAt) || runStart + run.durationMs;
  const rootId = spanId();
  const failed = run.summary.failed + run.summary.errors;
  spans.push({
    traceId, spanId: rootId, name: `eztest run ${run.runId}`, kind: 1, startTimeUnixNano: nanos(runStart), endTimeUnixNano: nanos(runEnd),
    attributes: attrs({
      'eztest.run.id': run.runId, 'eztest.run.total': run.summary.total, 'eztest.run.passed': run.summary.passed, 'eztest.run.passed_healed': run.summary.passedHealed,
      'eztest.run.failed': run.summary.failed, 'eztest.run.errors': run.summary.errors, 'eztest.run.skipped': run.summary.skipped, 'eztest.evidence.head': run.evidenceHead,
      'eztest.browser': run.environment?.browser, 'url.full': run.environment?.baseUrl,
    }),
    status: failed ? { code: STATUS_ERROR, message: `${failed} journey(s) failed` } : { code: STATUS_OK },
  });
  const stepSpans = (steps: StepResult[], parent: string, journeyId: string, fallbackStart: number) => {
    let cursor = fallbackStart;
    for (const s of steps) {
      const start = Date.parse(s.startedAt) || cursor;
      const end = start + Math.max(0, s.durationMs);
      cursor = end;
      const id = spanId();
      const bad = s.status === 'failed' || s.status === 'blocked';
      spans.push({
        traceId, spanId: id, parentSpanId: parent, name: s.intent.slice(0, 200), kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
        attributes: attrs({
          'eztest.journey.id': journeyId, 'eztest.step.id': s.stepId, 'eztest.step.status': s.status, 'eztest.heal.tier': s.heal?.tier,
          'eztest.heal.verified': s.heal ? s.heal.verified : undefined, 'eztest.step.iteration': s.iteration, 'eztest.evidence': s.evidence.join(',') || undefined,
        }),
        status: bad ? { code: STATUS_ERROR, message: s.error?.message?.slice(0, 500) } : s.status === 'skipped' ? { code: 0 } : { code: STATUS_OK },
      });
      if (s.children?.length) stepSpans(s.children, id, journeyId, start);
    }
  };
  for (const j of run.journeys) {
    const start = Date.parse(j.startedAt) || runStart;
    const id = spanId();
    const bad = j.status === 'failed' || j.status === 'error';
    spans.push({
      traceId, spanId: id, parentSpanId: rootId, name: j.name.slice(0, 200), kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(start + Math.max(0, j.durationMs)),
      attributes: attrs({ 'eztest.journey.id': j.journeyId, 'eztest.journey.status': j.status, 'eztest.journey.attempt': j.attempt, 'eztest.journey.risk': j.risk, 'eztest.journey.tags': j.tags.join(',') || undefined, 'eztest.journey.requirements': j.requirements.join(',') || undefined }),
      status: bad ? { code: STATUS_ERROR, message: j.error?.message?.slice(0, 500) } : { code: STATUS_OK },
    });
    stepSpans(j.steps, id, j.journeyId, start);
  }
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': o.serviceName ?? 'eztest', 'service.version': EZTEST_VERSION, ...(o.resource ?? {}) }) },
      scopeSpans: [{ scope: { name: 'eztest', version: EZTEST_VERSION }, spans }],
    }],
  };
}

export function otlpTracesUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, '');
  return /\/v1\/traces$/.test(e) ? e : `${e}/v1/traces`;
}

/** POST the run's spans to an OTLP/HTTP collector. Batches large runs (default 2,000 spans per request). */
export async function exportRunTrace(run: RunResult, o: { endpoint: string; headers?: Record<string, string>; serviceName?: string; batch?: number; fetch?: typeof fetch; timeoutMs?: number }): Promise<{ spans: number; requests: number; traceId: string }> {
  const payload = runToOtlp(run, { serviceName: o.serviceName });
  const rs = payload.resourceSpans[0] as { resource: unknown; scopeSpans: Array<{ scope: unknown; spans: OtlpSpan[] }> };
  const all = rs.scopeSpans[0].spans;
  const size = Math.max(1, o.batch ?? 2000);
  const f = o.fetch ?? fetch;
  let requests = 0;
  for (let i = 0; i < all.length; i += size) {
    const body = { resourceSpans: [{ resource: rs.resource, scopeSpans: [{ scope: rs.scopeSpans[0].scope, spans: all.slice(i, i + size) }] }] };
    const r = await f(otlpTracesUrl(o.endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
    if (!r.ok) throw new Error(`OTLP export to ${otlpTracesUrl(o.endpoint)} failed: HTTP ${r.status}`);
    requests++;
  }
  return { spans: all.length, requests, traceId: traceIdForRun(run.runId) };
}
