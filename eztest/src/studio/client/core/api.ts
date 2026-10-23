/**
 * The Studio API client. The session token comes from the page's meta tag and
 * is sent as a header on every call (writes are refused without it).
 */
export const TOKEN = document.querySelector<HTMLMetaElement>('meta[name="eztest-token"]')?.content ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-EZTest-Token': TOKEN, Accept: 'application/json' };
  const init: RequestInit = { method, credentials: 'same-origin', headers, signal };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(path, init);
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new ApiError(r.status, typeof j.error === 'string' ? j.error : `HTTP ${r.status}`, j);
  return j as T;
}

export const api = {
  get: <T = Record<string, unknown>>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal),
  post: <T = Record<string, unknown>>(path: string, body?: unknown, signal?: AbortSignal) => call<T>('POST', path, body, signal),
  put: <T = Record<string, unknown>>(path: string, body?: unknown) => call<T>('PUT', path, body),
  del: <T = Record<string, unknown>>(path: string, body?: unknown) => call<T>('DELETE', path, body),
};

/** `/runs/<id>/<path>` URL of a run artifact. */
export function runAsset(runId: string, path: string): string {
  return `/runs/${encodeURIComponent(runId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function q(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  return s.toString();
}
