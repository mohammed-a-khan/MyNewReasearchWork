/**
 * context.tracing: records API actions (with DOM snapshots before / after,
 * the action target marked), network traffic with bodies, console messages
 * and screencast frames into a trace zip in EZTest's own browser trace format
 * (see trace-format.ts). Studio opens these archives in the time-travel
 * viewer.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SelectorChain } from './injected/contract.js';
import type { ChromiumContext } from './chromium/browser.js';
import type { ChromiumFrame } from './chromium/frame.js';
import type { ChromiumPage } from './chromium/page.js';
import type { Request, Response } from './chromium/network.js';
import {
  BROWSER_TRACE_FORMAT, BROWSER_TRACE_MANIFEST, BROWSER_TRACE_VERSION,
  type BrowserTraceAction, type BrowserTraceConsole, type BrowserTraceFrame, type BrowserTraceManifest, type BrowserTraceRequest, type BrowserTraceSnapshot,
} from './trace-format.js';
import { writeZip } from './zip-writer.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TracingStartOptions {
  name?: string;
  title?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const headerRecord = (h: Array<{ name: string; value: string }> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { name, value } of h ?? []) out[name] = name in out ? `${out[name]}, ${value}` : value;
  return out;
};
const jsonl = (rows: unknown[]) => Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

/** Page-side DOM serializer (BrowserTraceNode trees); inputs carry their live state. Runs in the page, so it is self-contained. */
function snapshotDom(markTarget: boolean, target: Element | null): unknown {
  const SKIP = new Set(['SCRIPT', 'NOSCRIPT']);
  const visit = (n: Node): unknown => {
    if (n.nodeType === 3) return (n as Text).data;
    if (n.nodeType !== 1) return undefined;
    const el = n as Element;
    if (SKIP.has(el.nodeName)) return undefined;
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    const state: Record<string, unknown> = {};
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') state.checked = el.checked;
      else state.value = el.value;
    } else if (el instanceof HTMLTextAreaElement) state.value = el.value;
    else if (el instanceof HTMLOptionElement) state.selected = el.selected;
    if (el.scrollTop) state.scrollTop = el.scrollTop;
    if (el.scrollLeft) state.scrollLeft = el.scrollLeft;
    const node: Record<string, unknown> = { tag: el.nodeName.toLowerCase(), attrs, children: [] };
    if (Object.keys(state).length) node.state = state;
    if (markTarget && el === target) node.target = true;
    const kids = el instanceof HTMLTemplateElement ? el.content.childNodes : el.childNodes;
    for (const c of Array.from(kids)) {
      const v = visit(c);
      if (v !== undefined) (node.children as unknown[]).push(v);
    }
    return node;
  };
  return {
    doctype: document.doctype?.name,
    dom: (document.documentElement ? visit(document.documentElement) : undefined) ?? { tag: 'html', attrs: {}, children: [] },
    viewport: { width: innerWidth, height: innerHeight },
    url: location.href,
    title: document.title,
  };
}

export class Tracing {
  private recording = false;
  private t0 = 0;
  private startedAt = '';
  private actions: BrowserTraceAction[] = [];
  private consoleLog: BrowserTraceConsole[] = [];
  private frames: BrowserTraceFrame[] = [];
  private network: BrowserTraceRequest[] = [];
  private snapshots = new Map<string, Buffer>();
  private resources = new Map<string, Buffer>();
  private pending: Array<Promise<unknown>> = [];
  private options: TracingStartOptions = {};
  private callSeq = 0;
  private stopScreencasts: Array<() => Promise<void>> = [];
  private readonly pageIds = new WeakMap<ChromiumPage, string>();
  private pageSeq = 0;
  private onPage?: (p: ChromiumPage) => void;

  constructor(private readonly context: ChromiumContext) {}

  isRecording(): boolean {
    return this.recording;
  }

  private ms(): number {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  private pageId(p: ChromiumPage): string {
    let id = this.pageIds.get(p);
    if (!id) this.pageIds.set(p, (id = `page-${++this.pageSeq}`));
    return id;
  }

  private resource(b: Buffer): string {
    const path = `resources/${sha256(b)}`;
    this.resources.set(path, b);
    return path;
  }

  private browserName(): string {
    try {
      return String((this.context as any).browser?.()?.browserType?.()?.name?.() ?? 'chromium');
    } catch {
      return 'chromium';
    }
  }

  async start(options: TracingStartOptions = {}): Promise<void> {
    if (this.recording) throw new Error('tracing.start: a trace is already being recorded; call tracing.stop() first');
    this.recording = true;
    this.options = options;
    this.t0 = performance.now();
    this.startedAt = new Date().toISOString();
    this.actions = [];
    this.consoleLog = [];
    this.frames = [];
    this.network = [];
    this.snapshots.clear();
    this.resources.clear();
    if (options.screenshots) {
      this.onPage = (p) => void this.screencast(p);
      this.context.on('page', this.onPage);
      for (const p of this.context.pages()) await this.screencast(p);
    }
  }

  private async screencast(page: ChromiumPage): Promise<void> {
    try {
      const stop = await page.startScreencast({ format: 'jpeg', quality: 60, maxWidth: 800, maxHeight: 800 }, (f) => {
        if (!this.recording) return;
        this.frames.push({ atMs: this.ms(), page: this.pageId(page), resource: this.resource(f.data), width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
      });
      this.stopScreencasts.push(stop);
    } catch {
      /* page went away */
    }
  }

  async startChunk(options: { name?: string; title?: string } = {}): Promise<void> {
    if (!this.recording) await this.start({ ...this.options, ...options });
  }

  async stopChunk(options: { path?: string } = {}): Promise<void> {
    await this.stop(options);
  }

  async stop(options: { path?: string } = {}): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    if (this.onPage) this.context.off('page', this.onPage);
    for (const s of this.stopScreencasts.splice(0)) await s().catch(() => undefined);
    await Promise.allSettled(this.pending.splice(0));
    if (options.path) {
      const files: Array<{ name: string; data: Buffer }> = [
        { name: 'actions.jsonl', data: jsonl([...this.actions].sort((a, b) => a.startMs - b.startMs)) },
        { name: 'network.jsonl', data: jsonl([...this.network].sort((a, b) => a.startMs - b.startMs)) },
        { name: 'console.jsonl', data: jsonl(this.consoleLog) },
        { name: 'frames.jsonl', data: jsonl(this.frames) },
        ...[...this.snapshots].map(([name, data]) => ({ name, data })),
        ...[...this.resources].map(([name, data]) => ({ name, data })),
      ];
      const vp = this.context.options.viewport;
      const manifest: BrowserTraceManifest = {
        format: BROWSER_TRACE_FORMAT, version: BROWSER_TRACE_VERSION,
        ...((this.options.title ?? this.options.name) ? { title: this.options.title ?? this.options.name } : {}),
        browser: this.browserName(), platform: process.platform, startedAt: this.startedAt, durationMs: this.ms(),
        ...(vp === null ? {} : { viewport: vp ?? { width: 1280, height: 720 } }),
        counts: { actions: this.actions.length, requests: this.network.length, console: this.consoleLog.length, frames: this.frames.length, snapshots: this.snapshots.size, resources: this.resources.size },
        files: files.map((f) => ({ path: f.name, sha256: sha256(f.data), bytes: f.data.length })),
      };
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, writeZip([{ name: BROWSER_TRACE_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 1)) }, ...files]));
    }
    this.actions = [];
    this.consoleLog = [];
    this.frames = [];
    this.network = [];
    this.snapshots.clear();
    this.resources.clear();
  }

  async group(_name: string): Promise<void> {
    /* groups are not recorded */
  }

  async groupEnd(): Promise<void> {
    /* groups are not recorded */
  }

  /** Capture a snapshot of the main frame of `page`; returns its file name. */
  private async snapshot(page: ChromiumPage, id: string, phase: 'before' | 'after', chain?: SelectorChain): Promise<string | undefined> {
    if (!this.options.snapshots || page.isClosed()) return undefined;
    try {
      const frame = page.mainFrame();
      const ctx = await frame.context('engine', 5000);
      let target: unknown = null;
      if (chain) {
        const h = (await ctx.callEngine((e, h, c) => h.query(e, c)[0] ?? null, [chain], false)) as unknown as { asElement(): unknown };
        target = h.asElement() ?? null;
      }
      const snap = (await ctx.evaluate(`(${snapshotDom.toString()})`, [!!chain, target], true)) as any;
      const doc: BrowserTraceSnapshot = {
        action: id, phase, url: String(snap.url ?? ''), title: String(snap.title ?? ''), ...(snap.doctype ? { doctype: String(snap.doctype) } : {}),
        viewport: snap.viewport ?? { width: 0, height: 0 }, dom: snap.dom, atMs: this.ms(),
      };
      const name = `snapshots/${id}-${phase}.json`;
      this.snapshots.set(name, Buffer.from(JSON.stringify(doc)));
      return name;
    } catch {
      return undefined;
    }
  }

  /** Record one API call around `fn`. */
  async action<T>(page: ChromiumPage, cls: string, method: string, params: Record<string, unknown>, fn: () => Promise<T>, chain?: SelectorChain): Promise<T> {
    if (!this.recording) return fn();
    const id = `a${++this.callSeq}`;
    const before = await this.snapshot(page, id, 'before', chain);
    const a: BrowserTraceAction = { id, api: `${cls}.${method}`, page: this.pageId(page), params, startMs: this.ms(), endMs: 0, ...(before ? { before } : {}) };
    this.actions.push(a);
    try {
      return await fn();
    } catch (e) {
      a.error = (e as Error).message;
      throw e;
    } finally {
      a.endMs = this.ms();
      const after = await this.snapshot(page, id, 'after', chain);
      if (after) a.after = after;
    }
  }

  onNavigation(_page: ChromiumPage, _frame: ChromiumFrame): void {
    /* navigations show in snapshots and network */
  }

  onConsole(type: string, text: string): void {
    if (this.recording) this.consoleLog.push({ atMs: this.ms(), type, text });
  }

  onNetwork(name: string, r: Request | Response): void {
    if (!this.recording || (name !== 'requestfinished' && name !== 'requestfailed')) return;
    const req = r as Request;
    const end = this.ms();
    const job = (async () => {
      const res = req.response_;
      let responseBody: BrowserTraceRequest['responseBody'];
      if (res && name === 'requestfinished') {
        const body = await res.body().catch(() => undefined);
        if (body) responseBody = { resource: this.resource(body), size: body.length, contentType: res.headers()['content-type'] ?? '' };
      }
      const post = req.postData();
      const duration = Math.max(0, req.timing().responseEnd);
      this.network.push({
        startMs: Math.max(0, Math.round((end - duration) * 10) / 10), durationMs: duration, startedAt: new Date(req.wallTime).toISOString(), resourceType: req.resourceType(),
        method: req.method(), url: req.url(), requestHeaders: headerRecord(req.headersArray()),
        ...(post !== null ? { requestBody: { text: post, contentType: req.headers()['content-type'] ?? '' } } : {}),
        status: res?.status() ?? -1, statusText: res?.statusText() ?? '', responseHeaders: headerRecord(res?.headersArrayRaw()),
        ...(responseBody ? { responseBody } : {}),
      });
    })();
    this.pending.push(job);
  }
}
