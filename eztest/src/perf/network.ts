/**
 * Captured network traffic in EZTest's neutral form, plus HAR conversion.
 * The runner's network evidence files and HAR files both normalize to this.
 */
import { EzTestError } from '../core/index.js';

export interface NetworkTiming {
  /** Epoch milliseconds when the request started, if known. */
  startTime?: number;
  /** Total duration in ms. */
  duration?: number;
  [k: string]: number | undefined;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  /** Number = total duration in ms; object = detailed timing. */
  timing?: number | NetworkTiming;
  /** Network-level failure (DNS, connection refused...) when there was no response. */
  failure?: string;
  journeyId?: string;
  stepId?: string;
  /** Logical step / page label used for grouping (EZTest Load transactions). */
  group?: string;
}

export function entryDuration(e: NetworkEntry): number | undefined {
  if (typeof e.timing === 'number') return e.timing;
  return e.timing?.duration;
}

export function entryStart(e: NetworkEntry): number | undefined {
  return typeof e.timing === 'object' ? e.timing.startTime : undefined;
}

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; headers: HarHeader[]; postData?: { text?: string; mimeType?: string } };
  response: { status: number; headers: HarHeader[]; content?: { text?: string; encoding?: string; mimeType?: string } };
  _failureText?: string;
}
export interface Har {
  log: { entries: HarEntry[]; pages?: Array<{ id: string; title: string }> };
}

const headerMap = (hs: HarHeader[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of hs ?? []) {
    const k = h.name.toLowerCase();
    if (k.startsWith(':')) continue; // HTTP/2 pseudo headers
    out[k] = out[k] !== undefined ? `${out[k]}, ${h.value}` : h.value;
  }
  return out;
};

export function isHar(x: unknown): x is Har {
  return !!x && typeof x === 'object' && !!(x as Har).log && Array.isArray((x as Har).log.entries);
}

export function harToEntries(har: Har): NetworkEntry[] {
  const titles = new Map((har.log.pages ?? []).map((p) => [p.id, p.title]));
  return har.log.entries.map((e) => {
    let body = e.response.content?.text;
    if (body !== undefined && e.response.content?.encoding === 'base64') body = Buffer.from(body, 'base64').toString('utf8');
    const start = Date.parse(e.startedDateTime);
    return {
      method: e.request.method.toUpperCase(),
      url: e.request.url,
      status: e.response.status,
      requestHeaders: headerMap(e.request.headers),
      requestBody: e.request.postData?.text,
      responseHeaders: headerMap(e.response.headers),
      responseBody: body,
      timing: { startTime: Number.isFinite(start) ? start : undefined, duration: e.time },
      failure: e._failureText,
      group: e.pageref ? (titles.get(e.pageref) ?? e.pageref) : undefined,
    };
  });
}

/** Accept an entries array, `{ entries: [...] }`, or a HAR document. */
export function normalizeNetworkLog(input: unknown): NetworkEntry[] {
  let arr: unknown;
  if (isHar(input)) return harToEntries(input);
  if (Array.isArray(input)) arr = input;
  else if (input && typeof input === 'object' && Array.isArray((input as { entries?: unknown }).entries)) {
    arr = (input as { entries: unknown[] }).entries;
  } else {
    throw new EzTestError('Network log must be an array of entries, { entries }, or a HAR document', 'NETWORK_LOG_INVALID');
  }
  const out: NetworkEntry[] = [];
  for (const [i, raw] of (arr as unknown[]).entries()) {
    const e = raw as Partial<NetworkEntry>;
    if (!e || typeof e.url !== 'string' || typeof e.method !== 'string') {
      throw new EzTestError(`Network log entry ${i} lacks method/url`, 'NETWORK_LOG_INVALID');
    }
    const lower = (h?: Record<string, string>) =>
      h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])) : undefined;
    out.push({
      ...e,
      method: e.method.toUpperCase(),
      url: e.url,
      status: typeof e.status === 'number' ? e.status : 0,
      requestHeaders: lower(e.requestHeaders),
      responseHeaders: lower(e.responseHeaders),
    } as NetworkEntry);
  }
  return out;
}
