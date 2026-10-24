/**
 * Environment health: pre-flight checks before a run (URLs, API status, DB
 * pings), classification of failures as "environment" (5xx, DNS, connection,
 * navigation timeouts) and a circuit breaker that stops a run whose
 * environment went down, marking what is left `not run: environment unavailable`
 * instead of producing dozens of misleading product failures.
 */
import type { HealthCheckResult, JourneyResult } from '../../core/index.js';
import type { DbHandler } from '../types.js';

export type HealthCheck =
  | { name?: string; url: string; status?: number | number[]; contains?: string; timeoutMs?: number }
  | { name?: string; api: string; method?: 'GET' | 'HEAD' | 'POST'; status?: number | number[]; timeoutMs?: number; headers?: Record<string, string> }
  | { name?: string; db: string; sql?: string; timeoutMs?: number };

export interface HealthEnv {
  baseUrl?: string;
  db?: DbHandler;
  /** Test seam (default global fetch). */
  fetch?: typeof fetch;
}

function nameOf(c: HealthCheck): string {
  if (c.name) return c.name;
  if ('db' in c) return `db ${c.db}`;
  if ('api' in c) return `api ${c.api}`;
  return `url ${c.url}`;
}

/** Why a fetch failed, in plain words (DNS, refused, timeout, TLS). */
export function networkErrorText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const code = err.cause?.code ?? '';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `DNS lookup failed (${code})`;
  if (/ECONNREFUSED/.test(code)) return 'connection refused (ECONNREFUSED)';
  if (/ECONNRESET|UND_ERR_SOCKET/.test(code)) return `connection reset (${code})`;
  if (/CERT|SSL|TLS/i.test(code)) return `TLS problem (${code})`;
  return `${err.cause?.message ?? err.message}${code ? ` (${code})` : ''}`;
}

const okStatus = (want: number | number[] | undefined, got: number) =>
  want === undefined ? got < 400 : (Array.isArray(want) ? want : [want]).includes(got);

async function one(c: HealthCheck, env: HealthEnv): Promise<HealthCheckResult> {
  const t0 = Date.now();
  const name = nameOf(c);
  const timeoutMs = c.timeoutMs ?? 10_000;
  const done = (kind: HealthCheckResult['kind'], ok: boolean, message: string): HealthCheckResult => ({ name, kind, ok, ms: Date.now() - t0, message });
  if ('db' in c) {
    if (!env.db) return done('db', false, `no database handler for connection "${c.db}"`);
    try {
      const dialect = env.db.dialect ? await env.db.dialect(c.db) : 'sqlite';
      const sql = c.sql ?? (dialect === 'oracle' ? 'SELECT 1 FROM DUAL' : 'SELECT 1');
      const rows = await Promise.race([
        env.db.query(c.db, sql, []),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs).unref()),
      ]);
      return done('db', true, `${rows.length} row(s)`);
    } catch (e) {
      return done('db', false, (e as Error).message.split('\n')[0]);
    }
  }
  const kind: HealthCheckResult['kind'] = 'api' in c ? 'api' : 'url';
  const raw = 'api' in c ? c.api : c.url;
  let url: string;
  try {
    url = new URL(raw, env.baseUrl).toString();
  } catch {
    return done(kind, false, `cannot resolve "${raw}" without a baseUrl`);
  }
  try {
    const f = env.fetch ?? fetch;
    const res = await f(url, { method: 'api' in c ? (c.method ?? 'GET') : 'GET', headers: 'api' in c ? c.headers : undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const status = res.status;
    const body = 'contains' in c && c.contains ? await res.text() : '';
    if (!('contains' in c && c.contains)) await res.body?.cancel().catch(() => undefined);
    if (!okStatus(c.status, status)) return done(kind, false, `HTTP ${status} from ${url}`);
    if ('contains' in c && c.contains && !body.includes(c.contains)) return done(kind, false, `HTTP ${status} but the page does not contain "${c.contains}"`);
    return done(kind, true, `HTTP ${status}`);
  } catch (e) {
    return done(kind, false, `${url}: ${networkErrorText(e)}`);
  }
}

/** Run checks in parallel. */
export async function runHealthChecks(checks: HealthCheck[], env: HealthEnv): Promise<HealthCheckResult[]> {
  return Promise.all(checks.map((c) => one(c, env)));
}

// ------------------------------------------------------------------ classification

export interface NetLogEntry {
  method?: string;
  url: string;
  status?: number;
  resourceType?: string;
  failure?: string;
  stepId?: string;
}

const ENV_TEXT: Array<[RegExp, string]> = [
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'DNS lookup failed'],
  [/ECONNREFUSED|ERR_CONNECTION_REFUSED/i, 'connection refused'],
  [/ERR_CONNECTION_(?:RESET|CLOSED|TIMED_OUT)|ECONNRESET|socket hang up|EPIPE|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/i, 'connection dropped'],
  [/ERR_CERT_|SSL_ERROR|ERR_SSL/i, 'TLS problem'],
  [/(?:page\.goto|page\.reload|navigation)[^\n]*Timeout|Timeout[^\n]*exceeded[^\n]*navigat|(?:page\.goto|page\.reload|page\.waitForURL)[^\n]*timed out|ETIMEDOUT/i, 'navigation timed out'],
  [/environment unavailable/i, 'environment unavailable'],
];

/**
 * Is a failed journey an environment failure? Looks at the error text and at the
 * network log of the failing step: a 5xx on the page document (or a gateway error on
 * any call), or a network-level failure, is the environment, not the product.
 */
export function classifyEnvironmentFailure(j: Pick<JourneyResult, 'status' | 'steps' | 'error'>, network: NetLogEntry[] = []): string | undefined {
  if (j.status !== 'failed' && j.status !== 'error') return undefined;
  const failed = deepestFailure(j.steps);
  const text = [failed?.error?.message, j.error?.message].filter(Boolean).join('\n');
  for (const [re, why] of ENV_TEXT) if (re.test(text)) return `${why}: ${text.split('\n')[0].slice(0, 160)}`;
  const mine = network.filter((n) => !failed || !n.stepId || n.stepId === failed.stepId);
  // The page the journey was on when it failed (its last document) came back 5xx.
  const docs = network.filter((n) => n.resourceType === 'document' && n.status !== undefined);
  const doc = docs[docs.length - 1];
  if (doc && (doc.status ?? 0) >= 500) return `the page itself returned HTTP ${doc.status} (${shortUrl(doc.url)})`;
  const gwText = /returned (?:502|503|504)\b|\bHTTP (?:502|503|504)\b|status(?: code)? (?:502|503|504)\b/i.exec(text);
  if (gwText) return `gateway / service unavailable (${gwText[0]}): ${text.split('\n')[0].slice(0, 160)}`;
  const gw = mine.find((n) => n.status === 502 || n.status === 503 || n.status === 504);
  if (gw) return `HTTP ${gw.status} from ${shortUrl(gw.url)} (gateway / service unavailable)`;
  const net = mine.find((n) => n.failure && /ERR_(?:NAME_NOT_RESOLVED|CONNECTION|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|EMPTY_RESPONSE)/.test(n.failure) && n.resourceType !== 'image' && n.resourceType !== 'font');
  if (net) return `${shortUrl(net.url)} failed at network level (${net.failure})`;
  return undefined;
}

function deepestFailure(steps: JourneyResult['steps']): JourneyResult['steps'][number] | undefined {
  let cur = steps.find((s) => s.status === 'failed' && !s.soft);
  while (cur?.children?.length) {
    const inner = cur.children.find((s) => s.status === 'failed' && !s.soft);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`; // no query strings (tokens)
  } catch {
    return u;
  }
}

// ------------------------------------------------------------------ circuit breaker

export const ENVIRONMENT_UNAVAILABLE = 'not run: environment unavailable';

/**
 * Opens after `threshold` consecutive environment failures, but only when a probe
 * (health checks, else the base URL) confirms the environment is down: a product
 * bug that happens to look like an outage never stops the run.
 */
export class CircuitBreaker {
  private streak = 0;
  private probing?: Promise<boolean>;
  open?: { reason: string; afterJourney: string; openedAt: string };

  constructor(private readonly threshold: number, private readonly probe: () => Promise<{ ok: boolean; reason: string }>) {}

  /** Report a finished journey; resolves true when the circuit is (now) open. */
  async report(journeyId: string, environmentFailure: string | undefined): Promise<boolean> {
    if (this.open) return true;
    if (!environmentFailure) {
      this.streak = 0;
      return false;
    }
    this.streak++;
    if (this.streak < this.threshold) return false;
    // One probe at a time for all workers.
    this.probing ??= this.probe().then((p) => {
      this.probing = undefined;
      if (p.ok) {
        this.streak = 0;
        return false;
      }
      this.open ??= { reason: `${this.threshold} journeys in a row failed on the environment (last: ${environmentFailure}); probe: ${p.reason}`, afterJourney: journeyId, openedAt: new Date().toISOString() };
      return true;
    });
    return this.probing;
  }
}
