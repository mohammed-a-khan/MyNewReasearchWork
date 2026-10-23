/**
 * Drift guard: re-send recorded GET requests to the real service and report
 * structural differences (status, content type, JSON shape) per recording.
 * Values are not compared — only the contract the mocks stand in for.
 */
import { EzTestError } from '../core/index.js';
import { decodeBody, isJsonContentType, loadStore, parseStore, type MockStore, type Recording } from './store.js';

export type Shape =
  | { t: 'null' | 'boolean' | 'number' | 'string' | 'unknown' }
  | { t: 'array'; of?: Shape }
  | { t: 'object'; keys: Record<string, Shape> }
  | { t: 'mixed'; types: string[] };

export function shapeOf(v: unknown): Shape {
  if (v === null) return { t: 'null' };
  if (Array.isArray(v)) {
    let of: Shape | undefined;
    for (const el of v) of = of ? mergeShapes(of, shapeOf(el)) : shapeOf(el);
    return { t: 'array', of };
  }
  switch (typeof v) {
    case 'boolean':
      return { t: 'boolean' };
    case 'number':
      return { t: 'number' };
    case 'string':
      return { t: 'string' };
    case 'object': {
      const keys: Record<string, Shape> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) keys[k] = shapeOf(x);
      return { t: 'object', keys };
    }
    default:
      return { t: 'unknown' };
  }
}

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.t === 'object' && b.t === 'object') {
    const keys: Record<string, Shape> = { ...a.keys };
    for (const [k, s] of Object.entries(b.keys)) keys[k] = keys[k] ? mergeShapes(keys[k], s) : s;
    return { t: 'object', keys };
  }
  if (a.t === 'array' && b.t === 'array') {
    return { t: 'array', of: a.of && b.of ? mergeShapes(a.of, b.of) : (a.of ?? b.of) };
  }
  if (a.t === b.t) return a;
  const types = new Set([...(a.t === 'mixed' ? a.types : [a.t]), ...(b.t === 'mixed' ? b.types : [b.t])]);
  return { t: 'mixed', types: [...types].sort() };
}

export interface ShapeDifference {
  path: string;
  kind: 'missing-key' | 'extra-key' | 'type-changed';
  expected?: string;
  actual?: string;
}

const typeName = (s: Shape): string => (s.t === 'mixed' ? s.types.join('|') : s.t);

export function compareShapes(expected: Shape, actual: Shape, path = '$', out: ShapeDifference[] = []): ShapeDifference[] {
  if (expected.t !== actual.t) {
    // null in a recording is compatible with any type on the live side and vice versa (nullable fields).
    if (expected.t !== 'null' && actual.t !== 'null') out.push({ path, kind: 'type-changed', expected: typeName(expected), actual: typeName(actual) });
    return out;
  }
  if (expected.t === 'object' && actual.t === 'object') {
    for (const [k, s] of Object.entries(expected.keys)) {
      const a = actual.keys[k];
      if (!a) out.push({ path: `${path}.${k}`, kind: 'missing-key', expected: typeName(s) });
      else compareShapes(s, a, `${path}.${k}`, out);
    }
    for (const [k, s] of Object.entries(actual.keys)) {
      if (!(k in expected.keys)) out.push({ path: `${path}.${k}`, kind: 'extra-key', actual: typeName(s) });
    }
  } else if (expected.t === 'array' && actual.t === 'array' && expected.of && actual.of) {
    compareShapes(expected.of, actual.of, `${path}[]`, out);
  }
  return out;
}

export type DriftAuth =
  | { headers: Record<string, string> }
  | { bearer: string }
  | { clientCredentials: { tokenPath: string; clientId: string; clientSecret: string; scope?: string } };

export interface DriftOptions {
  auth?: DriftAuth;
  timeoutMs?: number;
  /** Only check recordings whose id is listed. */
  ids?: string[];
  fetch?: typeof fetch;
}

export interface DriftResultItem {
  id: string;
  method: string;
  path: string;
  outcome: 'ok' | 'drift' | 'error';
  differences: Array<
    | ShapeDifference
    | { path: string; kind: 'status-changed' | 'content-type-changed' | 'not-json'; expected?: string; actual?: string }
  >;
  error?: string;
}

export interface DriftReport {
  ok: boolean;
  target: string;
  checked: number;
  drifted: number;
  errors: number;
  /** Non-GET recordings are never re-sent (they could change data). */
  skippedNonGet: number;
  results: DriftResultItem[];
}

const mediaType = (ct: string | undefined) => (ct ?? '').split(';')[0].trim().toLowerCase();

async function authHeaders(target: string, auth: DriftAuth | undefined, f: typeof fetch, timeoutMs: number): Promise<Record<string, string>> {
  if (!auth) return {};
  if ('headers' in auth) return auth.headers;
  if ('bearer' in auth) return { authorization: `Bearer ${auth.bearer}` };
  const cc = auth.clientCredentials;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cc.clientId, client_secret: cc.clientSecret });
  if (cc.scope) body.set('scope', cc.scope);
  const res = await f(new URL(cc.tokenPath, target), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new EzTestError(`Drift auth: token request failed with HTTP ${res.status}`, 'MOCK_DRIFT_AUTH');
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new EzTestError('Drift auth: token response has no access_token', 'MOCK_DRIFT_AUTH');
  return { authorization: `Bearer ${json.access_token}` };
}

/** Compare recorded GET responses with what the real service returns now. */
export async function checkDrift(store: string | MockStore, target: string, opts: DriftOptions = {}): Promise<DriftReport> {
  const s = typeof store === 'string' ? await loadStore(store) : parseStore(store);
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let recs: Recording[] = s.recordings;
  if (opts.ids) recs = recs.filter((r) => opts.ids!.includes(r.id));
  const gets = recs.filter((r) => r.request.method === 'GET');
  if (gets.length === 0) throw new EzTestError('Drift check: the store has no GET recordings to check', 'MOCK_DRIFT_EMPTY');
  const headers = await authHeaders(target, opts.auth, f, timeoutMs);
  const results: DriftResultItem[] = [];
  for (const r of gets) {
    const item: DriftResultItem = { id: r.id, method: r.request.method, path: r.request.path, outcome: 'ok', differences: [] };
    try {
      const url = new URL(r.request.path + (r.request.query ? `?${r.request.query}` : ''), target);
      const res = await f(url, { headers: { accept: r.request.headers.accept ?? '*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      const liveBody = Buffer.from(await res.arrayBuffer());
      if (res.status !== r.response.status) {
        item.differences.push({ path: '$', kind: 'status-changed', expected: String(r.response.status), actual: String(res.status) });
      }
      const expCt = mediaType(r.response.headers['content-type']);
      const actCt = mediaType(res.headers.get('content-type') ?? undefined);
      if (expCt !== actCt) item.differences.push({ path: '$', kind: 'content-type-changed', expected: expCt || '(none)', actual: actCt || '(none)' });
      if (isJsonContentType(expCt) && isJsonContentType(actCt)) {
        let expected: unknown;
        let actual: unknown;
        try {
          expected = JSON.parse(decodeBody(r.response.body, r.response.bodyEncoding).toString('utf8'));
        } catch {
          item.differences.push({ path: '$', kind: 'not-json', expected: 'json', actual: 'recorded body is not JSON' });
        }
        try {
          actual = JSON.parse(liveBody.toString('utf8'));
        } catch {
          item.differences.push({ path: '$', kind: 'not-json', expected: 'json', actual: 'live body is not JSON' });
        }
        if (expected !== undefined && actual !== undefined) compareShapes(shapeOf(expected), shapeOf(actual), '$', item.differences as ShapeDifference[]);
      }
      if (item.differences.length) item.outcome = 'drift';
    } catch (e) {
      item.outcome = 'error';
      item.error = (e as Error).message;
    }
    results.push(item);
  }
  const drifted = results.filter((x) => x.outcome === 'drift').length;
  const errors = results.filter((x) => x.outcome === 'error').length;
  return {
    ok: drifted === 0 && errors === 0,
    target,
    checked: results.length,
    drifted,
    errors,
    skippedNonGet: recs.length - gets.length,
    results,
  };
}
