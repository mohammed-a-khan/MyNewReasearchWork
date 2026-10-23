/**
 * Provider verification: replay each contract expectation against a running
 * provider, after putting the provider into the expectation's state (a state
 * handler, which the engine builds from data hooks: named queries, SQL, HTTP
 * setup calls or journeys; or the provider's own state-change URL), and
 * compare the response under the contract's matchers. Message expectations
 * are verified against what the provider's message producer publishes
 * (from config: trigger the provider, then read its broker).
 */
import { EzTestError } from '../core/index.js';
import { compareMessage, compareResponse, isMessageExpectation, type Contract, type HttpExpectation, type MessageExpectation, type Mismatch, type ProviderState } from './model.js';

export type StateAction = 'setup' | 'teardown';
export type StateHandler = (state: ProviderState, action: StateAction) => Promise<void | Record<string, unknown>>;
/** Makes the provider publish the message an expectation describes and returns what it published. */
export type MessageProducer = (e: MessageExpectation) => Promise<{ contents: unknown; key?: string; headers?: Record<string, string> }>;

export interface VerifyOptions {
  /** Base URL of the running provider. */
  baseUrl: string;
  /** Handlers by state name ("*" handles any state without its own handler). */
  stateHandlers?: Record<string, StateHandler>;
  /** The provider's state-change endpoint (POST {state, params, action}), used for states without a handler. */
  stateChangeUrl?: string;
  /** Headers added to every replayed request (e.g. a bearer token for the provider). */
  requestHeaders?: Record<string, string> | (() => Promise<Record<string, string>>);
  /** Message producers by expectation description ("*" produces any message without its own producer). */
  messageProducers?: Record<string, MessageProducer>;
  /** Fail an expectation whose provider state has no handler (default true). */
  requireStateHandlers?: boolean;
  timeoutMs?: number;
}

export interface ExpectationResult {
  description: string;
  kind: 'http' | 'message';
  providerStates: string[];
  passed: boolean;
  mismatches: Mismatch[];
  error?: string;
  durationMs: number;
}

export interface ContractVerification {
  consumer: string;
  provider: string;
  /** Where the contract came from (a file, or consumer@version on the results server). */
  source: string;
  /** Content hash of the verified contract (contractHash). */
  hash: string;
  /** Consumer version, for contracts fetched from the results server. */
  consumerVersion?: string;
  /** False when an expectation failed. */
  passed: boolean;
  expectations: ExpectationResult[];
}

async function headersOf(h: VerifyOptions['requestHeaders']): Promise<Record<string, string>> {
  if (!h) return {};
  return typeof h === 'function' ? h() : h;
}

async function setState(opts: VerifyOptions, state: ProviderState, action: StateAction): Promise<void> {
  const h = opts.stateHandlers?.[state.name] ?? opts.stateHandlers?.['*'];
  if (h) {
    await h(state, action);
    return;
  }
  if (opts.stateChangeUrl) {
    const r = await fetch(opts.stateChangeUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: state.name, params: state.params ?? {}, action }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!r.ok) throw new EzTestError(`state change "${state.name}" (${action}) returned HTTP ${r.status}`, 'CONTRACT_STATE');
    return;
  }
  if (action === 'setup' && opts.requireStateHandlers !== false) {
    throw new EzTestError(`no handler for provider state "${state.name}" (add it to contracts.provider.states or set contracts.provider.stateChangeUrl)`, 'CONTRACT_STATE');
  }
}

function buildUrl(base: string, path: string, query?: Record<string, string[]>): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  // Keep the provider base path: "http://h/api" + "/orders" -> "http://h/api/orders".
  const bp = new URL(base).pathname.replace(/\/$/, '');
  if (bp && !path.startsWith(bp + '/')) u.pathname = `${bp}${path}`;
  for (const [k, vs] of Object.entries(query ?? {})) for (const v of vs) u.searchParams.append(k, v);
  return u.toString();
}

async function verifyMessage(e: MessageExpectation, opts: VerifyOptions): Promise<Mismatch[]> {
  const producer = opts.messageProducers?.[e.description] ?? opts.messageProducers?.['*'];
  if (!producer) throw new EzTestError(`no message producer for "${e.description}" (map it under contracts.provider.messageProducers)`, 'CONTRACT_MESSAGE');
  const produced = await producer(e);
  return compareMessage(e.message, produced);
}

async function verifyExpectation(e: HttpExpectation, opts: VerifyOptions): Promise<Mismatch[]> {
  const extra = await headersOf(opts.requestHeaders);
  const headers: Record<string, string> = { ...(e.request.headers ?? {}), ...extra };
  let body: string | undefined;
  if (e.request.body !== undefined) {
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (typeof e.request.body === 'string' && !/json/i.test(ct ?? '')) body = e.request.body;
    else {
      body = JSON.stringify(e.request.body);
      if (!ct) headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(buildUrl(opts.baseUrl, e.request.path, e.request.query), {
    method: e.request.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  const rh: Record<string, string> = {};
  res.headers.forEach((v, k) => (rh[k] = v));
  let parsed: unknown = text;
  if (/json/i.test(rh['content-type'] ?? '') && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return compareResponse(e.response, { status: res.status, headers: rh, body: text === '' ? undefined : parsed });
}

/** Verify every expectation of a contract against the provider. */
export async function verifyContract(contract: Contract, opts: VerifyOptions, meta: { source?: string; hash: string; consumerVersion?: string }): Promise<ContractVerification> {
  const results: ExpectationResult[] = [];
  for (const e of contract.expectations) {
    const started = Date.now();
    const r: ExpectationResult = { description: e.description, kind: isMessageExpectation(e) ? 'message' : 'http', providerStates: e.given.map((s) => s.name), passed: false, mismatches: [], durationMs: 0 };
    const done: ProviderState[] = [];
    try {
      for (const s of e.given) {
        await setState(opts, s, 'setup');
        done.push(s);
      }
      r.mismatches = isMessageExpectation(e) ? await verifyMessage(e, opts) : await verifyExpectation(e, opts);
      r.passed = r.mismatches.length === 0;
    } catch (err) {
      r.error = (err as Error).message;
      r.passed = false;
    } finally {
      for (const s of done.reverse()) await setState(opts, s, 'teardown').catch(() => undefined);
    }
    r.durationMs = Date.now() - started;
    results.push(r);
  }
  return {
    consumer: contract.consumer, provider: contract.provider, source: meta.source ?? 'contract', hash: meta.hash,
    ...(meta.consumerVersion ? { consumerVersion: meta.consumerVersion } : {}),
    expectations: results, passed: results.every((r) => r.passed),
  };
}

export function verificationText(v: ContractVerification): string {
  const lines = [`${v.passed ? 'PASS' : 'FAIL'} ${v.consumer} -> ${v.provider} (${v.source})`];
  for (const r of v.expectations) {
    lines.push(`  ${r.passed ? 'ok  ' : 'FAIL'} ${r.description}${r.providerStates.length ? ` [given ${r.providerStates.join(', ')}]` : ''}`);
    if (r.error) lines.push(`       error: ${r.error}`);
    for (const m of r.mismatches.slice(0, 10)) lines.push(`       ${m.message}`);
  }
  return lines.join('\n');
}
