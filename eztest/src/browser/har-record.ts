/**
 * HAR 1.2 recording: the one HAR builder of EZTest (the runner's "Record HAR"
 * step and the `recordHar` context option both use {@link buildHarLog}).
 *
 * `newContext({ recordHar: { path, content?, urlFilter? } })` records every
 * request of the context's pages and writes the HAR when the context closes.
 * content: 'embed' (default; text bodies inline), 'omit' (no bodies).
 * 'attach' (bodies as separate files) is not supported and is rejected.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecordHarOptions } from './types.js';
import { urlMatches } from './util.js';

/** What the builder needs to know about one request. */
export interface HarRecord {
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  failure?: string;
  startedAt: number;
  durationMs?: number;
  response?: { text(): Promise<string> };
}

export interface HarBuildOptions {
  /** Keep only requests whose URL passes. */
  urlFilter?: (url: string) => boolean;
  /** Applied to body texts and query values (secrets). */
  mask?: (s: string) => string;
  /** 'embed' (default) or 'omit' the response bodies. */
  content?: 'embed' | 'omit';
  /** Text bodies longer than this are cut. Default 64 KiB. */
  maxBodyChars?: number;
}

const TEXTUAL = /json|text|xml|javascript|html/;

/** A HAR 1.2 document from recorded requests. */
export async function buildHarLog(records: Iterable<HarRecord>, o: HarBuildOptions = {}) {
  const mask = o.mask ?? ((s: string) => s);
  const max = o.maxBodyChars ?? 64 * 1024;
  const entries = [];
  for (const r of records) {
    if (o.urlFilter && !o.urlFilter(r.url)) continue;
    let content: { size: number; mimeType: string; text?: string } = { size: -1, mimeType: r.responseHeaders?.['content-type'] ?? '' };
    if (o.content !== 'omit' && r.response && TEXTUAL.test(content.mimeType)) {
      const text = await r.response.text().catch(() => undefined);
      if (text !== undefined) content = { size: text.length, mimeType: content.mimeType, text: mask(text.slice(0, max)) };
    }
    const u = new URL(r.url);
    entries.push({
      startedDateTime: new Date(r.startedAt).toISOString(),
      time: r.durationMs ?? 0,
      request: {
        method: r.method, url: r.url, httpVersion: 'HTTP/1.1', cookies: [], headersSize: -1, bodySize: r.postData?.length ?? 0,
        headers: Object.entries(r.headers).map(([name, value]) => ({ name, value })),
        queryString: [...u.searchParams].map(([name, value]) => ({ name, value: mask(value) })),
        ...(r.postData ? { postData: { mimeType: r.headers['content-type'] ?? '', text: r.postData } } : {}),
      },
      response: {
        status: r.status ?? 0, statusText: r.failure ?? '', httpVersion: 'HTTP/1.1', cookies: [], headersSize: -1, bodySize: content.size, redirectURL: '',
        headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value })), content,
      },
      cache: {},
      timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 },
      _resourceType: r.resourceType,
    });
  }
  return { log: { version: '1.2', creator: { name: 'EZTest', version: '0.1.0' }, entries } };
}

interface PageLike {
  on(event: 'request', fn: (req: RequestLike) => void): unknown;
  on(event: 'response', fn: (res: ResponseLike) => void): unknown;
  on(event: 'requestfailed', fn: (req: RequestLike) => void): unknown;
}
interface RequestLike {
  method(): string;
  url(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  failure(): { errorText: string } | null;
}
interface ResponseLike {
  request(): RequestLike;
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
}

/** Check a recordHar option up front (bad options fail newContext, not the close). */
export function checkRecordHar(o: RecordHarOptions): void {
  if (!o || typeof o.path !== 'string' || !o.path) throw new Error('newContext: recordHar needs a path, e.g. { recordHar: { path: "network.har" } }');
  if (o.content === 'attach') throw new Error('newContext: recordHar content "attach" is not supported; use "embed" (bodies in the HAR) or "omit"');
  if (o.content !== undefined && o.content !== 'embed' && o.content !== 'omit') throw new Error(`newContext: recordHar content must be "embed" or "omit" (got ${JSON.stringify(o.content)})`);
}

/** Records the requests of a context's pages and writes the HAR on save(). */
export class HarRecorder {
  private readonly records: Array<HarRecord & { req: RequestLike }> = [];
  private saved = false;

  constructor(readonly options: RecordHarOptions) {
    checkRecordHar(options);
  }

  attach(page: PageLike): void {
    page.on('request', (req) => {
      const post = req.postData();
      this.records.push({ req, method: req.method(), url: req.url(), resourceType: req.resourceType(), headers: req.headers(), ...(post ? { postData: post } : {}), startedAt: Date.now() });
    });
    page.on('response', (res) => {
      const rec = this.find(res.request());
      if (!rec) return;
      rec.status = res.status();
      rec.responseHeaders = res.headers();
      rec.durationMs = Date.now() - rec.startedAt;
      rec.response = res;
    });
    page.on('requestfailed', (req) => {
      const rec = this.find(req);
      if (rec) rec.failure = req.failure()?.errorText ?? 'failed';
    });
  }

  private find(req: RequestLike): (HarRecord & { req: RequestLike }) | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].req === req) return this.records[i];
    return undefined;
  }

  /** Write the HAR (once; while the pages are still open, so bodies can be read). */
  async save(): Promise<void> {
    if (this.saved) return;
    this.saved = true;
    const f = this.options.urlFilter;
    const urlFilter = f === undefined ? undefined : (u: string) => urlMatches(undefined, u, f);
    const har = await buildHarLog(this.records, { urlFilter, content: this.options.content === 'omit' ? 'omit' : 'embed', maxBodyChars: Number.MAX_SAFE_INTEGER });
    await mkdir(dirname(this.options.path), { recursive: true });
    await writeFile(this.options.path, JSON.stringify(har, null, 2));
  }
}
