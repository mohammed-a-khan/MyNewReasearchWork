/**
 * Read EZTest's browser trace archive (the per-attempt zip `context.tracing`
 * writes, format "eztest-browser-trace", see src/browser/trace-format.ts) into
 * the time-travel trace model, so Studio's viewer opens it like a native
 * trace: every API action becomes a step with before/after DOM snapshots
 * (rendered as static HTML: scripts and handlers stripped, password values
 * dropped), the network requests and console messages that follow it until
 * the next action,
 * and the last screencast frame. Every file is checked against the manifest's
 * SHA-256 list; differences are reported as problems. Values typed into
 * password-like fields are learned and masked everywhere.
 */
import { readFile } from 'node:fs/promises';
import { sha256 } from '../../core/index.js';
import {
  BROWSER_TRACE_FORMAT, BROWSER_TRACE_MANIFEST,
  type BrowserTraceAction, type BrowserTraceConsole, type BrowserTraceFrame, type BrowserTraceManifest, type BrowserTraceNode, type BrowserTraceRequest, type BrowserTraceSnapshot,
} from '../../browser/trace-format.js';
import { memorySource, type TraceSource } from './read.js';
import { REDACTED, Redactor, type Masker } from './redact.js';
import { extFor } from './store.js';
import { TRACE_FORMAT, TRACE_VERSION, type SnapshotRef, type TraceConsoleEntry, type TraceFile, type TraceNetworkEntry, type TraceStep } from './types.js';
import { readZip } from './zip.js';

export interface BrowserTraceReadOptions {
  masker?: Masker;
  /** Text bodies kept up to this many bytes. Default 65536. */
  maxBodyBytes?: number;
}

export interface OpenedBrowserTrace {
  trace: TraceFile;
  source: TraceSource;
  warnings: string[];
  /** Files that are missing, extra or altered against the manifest. */
  problems: string[];
  manifest: BrowserTraceManifest;
}

const SKIP_APIS = /\.(?:newPage|close|waitForEvent|setDefaultTimeout|setDefaultNavigationTimeout)$/;
const SENSITIVE = /pass(?:word|wd|phrase)?|secret|token|api[-_ ]?key|\bpin\b|\botp\b|one[- ]time|cvv|cvc/i;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'noscript', 'object', 'embed', 'base']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function lines<T>(buf: Buffer | undefined): T[] {
  if (!buf) return [];
  const out: T[] = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn line
    }
  }
  return out;
}

/** True when the zip holds an EZTest browser trace (by its manifest). */
export function isBrowserTrace(files: Map<string, Buffer>): boolean {
  const m = files.get(BROWSER_TRACE_MANIFEST);
  if (!m) return false;
  try {
    return (JSON.parse(m.toString('utf8')) as { format?: string }).format === BROWSER_TRACE_FORMAT;
  } catch {
    return false;
  }
}

interface Rendered {
  html: string;
  target?: number;
  targetSensitive: boolean;
  nodeCount: number;
  text: string;
}

function renderSnapshot(s: BrowserTraceSnapshot, password: Set<string>): Rendered {
  let nid = 0;
  let target: number | undefined;
  let targetSensitive = false;
  const text: string[] = [];
  const visit = (n: BrowserTraceNode | string, parent: string, depth: number): string => {
    if (depth > 2000) return '';
    if (typeof n === 'string') {
      if (parent !== 'style' && parent !== 'title') text.push(n);
      return parent === 'style' ? n.replace(/<\/style/gi, '<\\/style') : esc(n);
    }
    if (!n || typeof n.tag !== 'string') return '';
    const tag = n.tag.toLowerCase();
    if (DROP.has(tag)) return '';
    const raw = n.attrs ?? {};
    const id = ++nid;
    let attrs = ` data-ez-nid="${id}"`;
    const type = (raw.type ?? '').toLowerCase();
    const secret = (tag === 'input' || tag === 'textarea') && (type === 'password' || SENSITIVE.test(`${raw.name ?? ''} ${raw.id ?? ''} ${raw.autocomplete ?? ''}`));
    if (n.target) {
      target = id;
      targetSensitive = secret;
    }
    let value = n.state?.value;
    for (const [k, v] of Object.entries(raw)) {
      const lk = k.toLowerCase();
      if (lk.startsWith('on') || lk === 'srcset' || lk === 'integrity' || lk === 'nonce') continue;
      if ((lk === 'value' || lk === 'checked' || lk === 'selected') && (tag === 'input' || tag === 'textarea' || tag === 'option')) {
        if (lk === 'value') value ??= v;
        continue;
      }
      let val = String(v);
      if (/^\s*(javascript|vbscript|data:text\/html)/i.test(val) && ['href', 'src', 'action', 'formaction'].includes(lk)) val = '#';
      if (tag === 'iframe' && (lk === 'src' || lk === 'srcdoc')) continue;
      if ((tag === 'img' && lk === 'src') || (tag === 'link' && lk === 'href')) val = `ezurl:${val}`;
      attrs += ` ${k}="${escAttr(val)}"`;
    }
    if (n.state?.checked) attrs += ' checked';
    if (n.state?.selected) attrs += ' selected';
    if (n.state?.scrollTop) attrs += ` data-ez-scroll-top="${n.state.scrollTop}"`;
    if (n.state?.scrollLeft) attrs += ` data-ez-scroll-left="${n.state.scrollLeft}"`;
    if (secret && value) password.add(value);
    if (tag === 'input' && value !== undefined) attrs += secret ? ' value="" data-ez-redacted="1"' : ` value="${escAttr(value)}"`;
    if (tag === 'iframe') attrs += ' data-ez-cross-origin="1"';
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    let inner = '';
    if (tag === 'textarea') inner = secret ? '' : esc(value ?? '');
    else for (const c of n.children ?? []) inner += visit(c, tag, depth + 1);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  const html = `${s.doctype ? `<!DOCTYPE ${s.doctype}>` : ''}${visit(s.dom, '', 0)}`;
  return { html, ...(target !== undefined ? { target } : {}), targetSensitive, nodeCount: nid, text: text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000) };
}

/** Open an EZTest browser trace zip (path or bytes) as a time-travel trace. */
export async function readBrowserTrace(input: Buffer | string, opts: BrowserTraceReadOptions = {}): Promise<OpenedBrowserTrace> {
  const zip = typeof input === 'string' ? await readFile(input) : input;
  const files = readZip(zip);
  if (!isBrowserTrace(files)) throw new Error(`not an EZTest browser trace (${BROWSER_TRACE_MANIFEST} with format "${BROWSER_TRACE_FORMAT}" missing)`);
  const manifest = JSON.parse(files.get(BROWSER_TRACE_MANIFEST)!.toString('utf8')) as BrowserTraceManifest;
  const warnings: string[] = [];
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const f of manifest.files ?? []) {
    listed.add(f.path);
    const data = files.get(f.path);
    if (!data) problems.push(`${f.path} is missing`);
    else if (sha256(data) !== f.sha256) problems.push(`${f.path} was altered (SHA-256 differs from the manifest)`);
  }
  for (const name of files.keys()) if (name !== BROWSER_TRACE_MANIFEST && !listed.has(name)) problems.push(`${name} is not in the manifest`);

  const actions = lines<BrowserTraceAction>(files.get('actions.jsonl')).filter((a) => !SKIP_APIS.test(a.api)).sort((a, b) => a.startMs - b.startMs);
  const requests = lines<BrowserTraceRequest>(files.get('network.jsonl'));
  const consoleLog = lines<BrowserTraceConsole>(files.get('console.jsonl'));
  const frames = lines<BrowserTraceFrame>(files.get('frames.jsonl'));
  const maxBody = Math.max(0, opts.maxBodyBytes ?? 65536);
  const R = new Redactor(opts.masker);
  const wall0 = Date.parse(manifest.startedAt) || Date.now();
  const iso = (ms: number) => new Date(wall0 + ms).toISOString();
  const snapshotOf = (name: string | undefined): BrowserTraceSnapshot | undefined => {
    const b = name ? files.get(name) : undefined;
    if (!b) return undefined;
    try {
      return JSON.parse(b.toString('utf8')) as BrowserTraceSnapshot;
    } catch {
      warnings.push(`${name} is not readable`);
      return undefined;
    }
  };

  // Learn secrets first: values typed into password-like targets.
  const password = new Set<string>();
  for (const a of actions) if (typeof a.params.value === 'string' && SENSITIVE.test(String(a.params.selector ?? ''))) password.add(a.params.value);
  const pre = actions.map((a) => {
    const bs = snapshotOf(a.before);
    const as = snapshotOf(a.after);
    const before = bs ? { snap: bs, r: renderSnapshot(bs, password) } : undefined;
    const after = as ? { snap: as, r: renderSnapshot(as, password) } : undefined;
    const sensitiveTarget = !!(before?.r.targetSensitive || after?.r.targetSensitive);
    if (sensitiveTarget && typeof a.params.value === 'string') password.add(a.params.value);
    return { a, before, after, sensitiveTarget };
  });
  for (const v of password) R.learn(v);

  const out = new Map<string, Buffer>();
  const resources: TraceFile['resources'] = {};
  const putResource = (data: Buffer | string, contentType: string): string => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const key = `${sha256(buf)}.${extFor(contentType)}`;
    const path = `resources/${key}`;
    if (!out.has(path)) out.set(path, buf);
    resources[key] = { path, contentType, size: buf.length };
    return key;
  };

  // Network.
  const byUrl = new Map<string, { resource: string; contentType: string }>();
  const network: Array<TraceNetworkEntry & { at: number }> = [];
  for (const q of requests) {
    if (q.responseBody) byUrl.set(q.url, { resource: q.responseBody.resource, contentType: q.responseBody.contentType });
    const body = (text: string | undefined, ct: string) => {
      if (text === undefined || maxBody === 0) return undefined;
      const red = R.body(text.slice(0, maxBody), ct);
      return red.length <= 1024 ? { text: red, size: text.length, ...(text.length > maxBody ? { truncated: true } : {}) } : { path: `resources/${putResource(red, ct.includes('json') ? 'application/json' : 'text/plain')}`, size: text.length };
    };
    const ct = q.responseBody?.contentType ?? '';
    const resBuf = q.responseBody ? files.get(q.responseBody.resource) : undefined;
    const resText = resBuf && /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))|\+json|\+xml/i.test(ct) ? resBuf.toString('utf8') : undefined;
    network.push({
      at: q.startMs, stepIndex: -1, method: q.method, url: R.url(q.url), resourceType: q.resourceType || 'other',
      status: q.status, statusText: q.statusText, startedAt: q.startedAt || iso(q.startMs), durationMs: q.durationMs, timing: {},
      requestHeaders: R.headers(q.requestHeaders), responseHeaders: R.headers(q.responseHeaders),
      requestBody: body(q.requestBody?.text, q.requestBody?.contentType ?? ''),
      responseBody: resText !== undefined ? body(resText, ct) : resBuf ? { size: resBuf.length, omitted: `non-text body (${ct.split(';')[0] || 'unknown'})` } : undefined,
      mimeType: ct || undefined,
    });
  }

  // Activity belongs to the latest action that started before it (a click's form post often starts after the click returns).
  const within = (t: number) => {
    for (let i = pre.length - 1; i >= 0; i--) if (t >= pre[i].a.startMs) return i;
    return -1;
  };
  const snapRef = (x: { snap: BrowserTraceSnapshot; r: Rendered } | undefined, phase: 'before' | 'after', i: number): SnapshotRef | undefined => {
    if (!x) return undefined;
    let html = x.r.html.replace(/(src|href)="ezurl:([^"]*)"/g, (_m, attr: string, rawUrl: string) => {
      const url = rawUrl.replace(/&amp;/g, '&');
      const hit = byUrl.get(url) ?? byUrl.get(new URL(url, x.snap.url || 'http://x/').toString());
      const buf = hit ? files.get(hit.resource) : undefined;
      return buf ? `${attr}="ezres:${putResource(buf, hit!.contentType || 'application/octet-stream')}"` : `${attr}="" data-ez-${attr}="${escAttr(R.url(url))}"`;
    });
    html = R.mask(html);
    const path = `snapshots/${String(i).padStart(3, '0')}-${phase}.html`;
    out.set(path, Buffer.from(html, 'utf8'));
    return {
      phase, path, sha256: sha256(html), bytes: html.length, url: R.url(x.snap.url), title: R.mask(x.snap.title ?? ''), viewport: { ...x.snap.viewport, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 },
      ...(x.r.target !== undefined ? { target: { nid: x.r.target, box: { x: 0, y: 0, width: 0, height: 0 }, tag: '', sensitive: x.r.targetSensitive } } : {}),
      text: R.mask(x.r.text), nodeCount: x.r.nodeCount, engine: 'browser-trace', capturedAt: iso(x.snap.atMs),
    };
  };

  const steps: TraceStep[] = pre.map(({ a, before, after, sensitiveTarget }, i) => {
    const selector = typeof a.params.selector === 'string' ? a.params.selector : undefined;
    const value = typeof a.params.value === 'string' ? a.params.value : typeof a.params.text === 'string' ? a.params.text : typeof a.params.url === 'string' ? a.params.url : undefined;
    const sensitive = sensitiveTarget || SENSITIVE.test(selector ?? '');
    const method = a.api.split('.').pop() ?? a.api;
    const intent = `${method}${selector ? ` ${selector}` : typeof a.params.url === 'string' ? ` ${a.params.url}` : ''}`;
    const frame = [...frames].reverse().find((f) => f.atMs <= a.endMs && f.atMs >= a.startMs - 1) ?? [...frames].reverse().find((f) => f.atMs <= a.endMs);
    const jpeg = frame ? files.get(frame.resource) : undefined;
    return {
      index: i, execution: 1, stepId: `browser-${a.id}`, intent: R.mask(intent), action: method,
      ...(value !== undefined ? { value: sensitive && a.params.value !== undefined ? REDACTED : R.mask(value) } : {}),
      ...(selector ? { targetDescription: R.mask(selector) } : {}),
      status: a.error ? 'failed' : 'passed', ...(a.error ? { error: R.mask(a.error) } : {}),
      startedAt: iso(a.startMs), durationMs: Math.max(0, Math.round(a.endMs - a.startMs)),
      timings: {},
      locator: { tried: selector ? [{ candidate: { strategy: 'css', value: selector }, description: R.mask(selector), count: a.error ? 0 : 1 }] : [] },
      conditions: [],
      snapshots: { ...(before ? { before: snapRef(before, 'before', i) } : {}), ...(after ? { after: snapRef(after, 'after', i) } : {}) },
      network: [],
      console: [],
      ...(jpeg ? { screenshot: { viewportJpeg: `resources/${putResource(jpeg, 'image/jpeg')}` } } : {}),
      url: { before: before ? R.url(before.snap.url) : undefined, after: after ? R.url(after.snap.url) : undefined },
    };
  });
  const unattributed: TraceFile['unattributed'] = { network: [], console: [] };
  for (const { at, ...n } of network) {
    const idx = within(at);
    if (idx >= 0) steps[idx].network.push({ ...n, stepIndex: idx });
    else unattributed.network.push(n);
  }
  for (const c of consoleLog) {
    const idx = within(c.atMs);
    const entry: TraceConsoleEntry = { stepIndex: idx, type: c.type, text: R.mask(c.text), at: iso(c.atMs) };
    if (idx >= 0) steps[idx].console.push(entry);
    else unattributed.console.push(entry);
  }
  if (!steps.length) warnings.push('The trace has no actions');

  const first = pre[0]?.a.startMs ?? 0;
  const last = pre.at(-1)?.a.endMs ?? first;
  const trace: TraceFile = {
    format: TRACE_FORMAT, version: TRACE_VERSION, source: 'browser', runId: 'browser-trace', journeyId: 'browser-trace',
    journeyName: R.mask(manifest.title ?? 'Browser trace'), attempt: 1, browser: manifest.browser ?? 'unknown',
    startedAt: iso(first), finishedAt: iso(last), durationMs: Math.round(last - first),
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    viewport: manifest.viewport, steps, unattributed, resources, dir: '.',
  };
  out.set('trace.json', Buffer.from(R.mask(JSON.stringify(trace, null, 1)), 'utf8'));
  const final = JSON.parse(out.get('trace.json')!.toString('utf8')) as TraceFile;
  return { trace: final, source: memorySource(out), warnings, problems, manifest };
}
