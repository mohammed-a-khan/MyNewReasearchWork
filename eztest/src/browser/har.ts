/**
 * HAR 1.2 replay: answer matching requests from a recorded HAR file.
 *
 * Matching: same method and URL (fragment ignored); among several entries
 * the one whose request body equals the request's wins, then the one with
 * the most equal request headers, then the first. Unmatched requests are
 * aborted (notFound: 'abort', default) or passed to the next handler
 * (notFound: 'fallback'). `.zip` HAR archives with `_file` content entries
 * are supported.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { URLMatch } from './types.js';
import { readZipEntries } from './launcher/unzip.js';
import type { Route, Request, RouteHandlerFn } from './chromium/network.js';

export interface RouteFromHAROptions {
  url?: URLMatch;
  notFound?: 'abort' | 'fallback';
  update?: boolean;
  updateContent?: 'embed' | 'attach';
  updateMode?: 'full' | 'minimal';
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  request: { method: string; url: string; headers?: HarHeader[]; postData?: { text?: string; mimeType?: string } };
  response: {
    status: number;
    statusText?: string;
    headers?: HarHeader[];
    content?: { text?: string; encoding?: string; mimeType?: string; _file?: string };
    redirectURL?: string;
  };
}

interface RouteTarget {
  route(url: URLMatch, handler: RouteHandlerFn, options?: { times?: number }): Promise<void>;
}

function stripHash(u: string): string {
  const i = u.indexOf('#');
  return i >= 0 ? u.slice(0, i) : u;
}

async function loadHar(file: string): Promise<{ entries: HarEntry[]; files: Map<string, Buffer> }> {
  const raw = await readFile(file);
  if (raw[0] === 0x50 && raw[1] === 0x4b) {
    const zip = readZipEntries(raw);
    const harName = [...zip.keys()].find((n) => n.endsWith('.har'));
    if (!harName) throw new Error(`${file}: no .har inside the archive`);
    const har = JSON.parse(zip.get(harName)!.toString('utf8'));
    return { entries: har.log?.entries ?? [], files: zip };
  }
  const har = JSON.parse(raw.toString('utf8'));
  return { entries: har.log?.entries ?? [], files: new Map() };
}

export async function routeFromHAR(target: RouteTarget, file: string, options: RouteFromHAROptions = {}): Promise<void> {
  if (options.update) throw new Error('routeFromHAR: update mode (recording) is not supported by the EZTest driver; record with "Record HAR" steps instead');
  const { entries, files } = await loadHar(file);
  const byKey = new Map<string, HarEntry[]>();
  for (const e of entries) {
    const key = `${e.request.method.toUpperCase()} ${stripHash(e.request.url)}`;
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }
  const baseDir = dirname(file);
  const pick = (req: Request): HarEntry | undefined => {
    const list = byKey.get(`${req.method().toUpperCase()} ${stripHash(req.url())}`);
    if (!list?.length) return undefined;
    if (list.length === 1) return list[0];
    const body = req.postData() ?? '';
    const sameBody = list.filter((e) => (e.request.postData?.text ?? '') === body);
    const pool = sameBody.length ? sameBody : list;
    const headers = req.headers();
    let best = pool[0];
    let bestScore = -1;
    for (const e of pool) {
      const score = (e.request.headers ?? []).filter((h) => headers[h.name.toLowerCase()] === h.value).length;
      if (score > bestScore) {
        best = e;
        bestScore = score;
      }
    }
    return best;
  };
  const handler = async (route: Route, req: Request) => {
    const entry = pick(req);
    if (!entry) {
      if (options.notFound === 'fallback') await route.fallback();
      else await route.abort();
      return;
    }
    const res = entry.response;
    const c = res.content ?? {};
    let body: Buffer;
    if (c._file) body = files.get(c._file) ?? (await readFile(join(baseDir, c._file)));
    else if (c.text !== undefined) body = Buffer.from(c.text, c.encoding === 'base64' ? 'base64' : 'utf8');
    else body = Buffer.alloc(0);
    const headers: Record<string, string> = {};
    for (const h of res.headers ?? []) {
      const k = h.name.toLowerCase();
      if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding' || k.startsWith(':')) continue;
      headers[k] = k in headers ? `${headers[k]}${k === 'set-cookie' ? '\n' : ', '}${h.value}` : h.value;
    }
    if (c.mimeType && !headers['content-type']) headers['content-type'] = c.mimeType;
    await route.fulfill({ status: res.status || 200, headers, body });
  };
  await target.route(options.url ?? '**/*', handler);
}
