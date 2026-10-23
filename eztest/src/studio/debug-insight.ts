/**
 * Live step details for the Studio debugger. While a debug session runs, this
 * observer wraps the journey page's step hooks (without replacing the trace
 * recorder's) and listens to the page, so the debugger can show, for the step
 * that just ran or is paused: the resolved locator, every candidate tried
 * with its match count, the heal ladder, post-conditions (expected vs
 * actual), and the step's network requests and console messages.
 *
 * Everything leaves through the session's own masking (config secrets,
 * learned secrets) plus header, URL and body redaction.
 */
import type { ConsoleMessage, Page, Request } from '../browser/index.js';
import { conditionToText } from '../intent/conditions.js';
import { describeCandidate, Redactor, setStepHooks, stepHooksFor, type StepHooks } from '../runner/index.js';
import type { DebugSessionManager } from './debug-session.js';
import type { StudioEvent } from './runs.js';

const MAX_BODY = 16 * 1024;
const MAX_NET = 300;
const MAX_CONSOLE = 300;

export interface LiveNetworkEntry {
  id: number;
  stepIndex: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  startedAt: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  mimeType?: string;
}

export interface LiveConsoleEntry {
  stepIndex: number;
  type: string;
  text: string;
  location?: string;
  at: number;
}

export interface LiveStepDetails {
  index: number;
  stepId: string;
  intent: string;
  execution: number;
  status?: string;
  durationMs?: number;
  startedAt: number;
  used?: { description: string; strategy: string; value: string };
  tried: Array<{ description: string; count: number; error?: string }>;
  notes: string[];
  heal: { attempts: Array<{ tier: string; description: string; confidence: number; reason: string; matches: number }>; notes: string[] };
  conditions: Array<{ text: string; type: string; passed: boolean; actual?: string; message?: string; expected?: string }>;
}

function expectedOf(c: Record<string, unknown>): string | undefined {
  for (const k of ['value', 'pattern', 'expected', 'equals', 'status']) if (c[k] !== undefined) return String(c[k]);
  return undefined;
}

function isTextual(mime: string): boolean {
  return /json|text|xml|javascript|x-www-form-urlencoded/i.test(mime);
}

export class DebugInsight {
  private steps = new Map<number, LiveStepDetails>();
  private network: LiveNetworkEntry[] = [];
  private consoleLog: LiveConsoleEntry[] = [];
  private current = -1;
  private netSeq = 0;
  private offPage: Array<() => void> = [];
  private readonly redactor = new Redactor();
  private readonly off: () => void;

  constructor(private readonly manager: DebugSessionManager) {
    this.off = manager.subscribe((e) => this.onEvent(e));
  }

  private mask<T>(v: T): T {
    const s = this.manager.current;
    return s ? s.controller.maskDeep(v) : v;
  }

  private onEvent(e: StudioEvent): void {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'queued':
        this.reset();
        break;
      case 'debug.attached':
        this.attach();
        break;
      case 'debug.detached':
        this.detachPage();
        break;
      case 'debug.stepStarted': {
        const index = Number(d.stepIndex);
        const prev = this.steps.get(index);
        this.current = index;
        this.steps.set(index, {
          index, stepId: String(d.stepId ?? ''), intent: String(d.intent ?? ''), execution: (prev?.execution ?? 0) + 1, startedAt: Date.now(),
          tried: [], notes: [], heal: { attempts: [], notes: [] }, conditions: [],
        });
        // Network and console of an earlier execution of the same step are dropped (edit-and-continue re-runs it).
        if (prev) {
          this.network = this.network.filter((n) => n.stepIndex !== index);
          this.consoleLog = this.consoleLog.filter((c) => c.stepIndex !== index);
        }
        break;
      }
      case 'debug.stepFinished': {
        const s = this.steps.get(Number(d.stepIndex));
        if (s) {
          s.status = String(d.status);
          s.durationMs = Number(d.durationMs);
        }
        break;
      }
      case 'debug.stepSkipped': {
        const index = Number(d.stepIndex);
        const s = this.steps.get(index);
        if (s) s.status = 'skipped';
        else this.steps.set(index, { index, stepId: String(d.stepId ?? ''), intent: '', execution: 0, status: 'skipped', startedAt: Date.now(), tried: [], notes: [], heal: { attempts: [], notes: [] }, conditions: [] });
        break;
      }
      default:
        break;
    }
  }

  private reset(): void {
    this.detachPage();
    this.steps.clear();
    this.network = [];
    this.consoleLog = [];
    this.current = -1;
  }

  /** Wrap the page's step hooks (the trace recorder keeps its own) and follow its traffic. */
  private attach(): void {
    const c = this.manager.current?.controller;
    const page = c?.page;
    if (!c || !page) return;
    this.detachPage();
    this.follow(page);
    // Tabs and popups: the runner switches the journey to another page; follow it too.
    this.offPage.push(c.onPage((p) => p && this.follow(p)));
  }

  private readonly followed = new WeakSet<Page>();

  private follow(page: Page): void {
    const inner = stepHooksFor(page);
    if (!this.wrapped.has(inner as object)) {
      const w = this.wrap(inner);
      this.wrapped.add(w);
      setStepHooks(page, w);
    }
    if (!this.followed.has(page)) {
      this.followed.add(page);
      this.listen(page);
    }
  }

  private readonly wrapped = new WeakSet<object>();

  private detachPage(): void {
    for (const o of this.offPage.splice(0)) o();
  }

  private cur(): LiveStepDetails | undefined {
    return this.steps.get(this.current);
  }

  private wrap(inner: StepHooks | undefined): StepHooks {
    return {
      located: (res) => {
        const c = this.cur();
        if (c) {
          c.tried = (res.tried ?? []).map((t) => ({ description: describeCandidate(t.candidate), count: t.count, ...(t.error ? { error: t.error } : {}) }));
          c.notes = [...res.notes];
          if (res.candidate) c.used = { description: describeCandidate(res.candidate), strategy: res.candidate.strategy, value: res.candidate.value };
        }
        inner?.located?.(res);
      },
      beforeAct: async (loc, info) => inner?.beforeAct?.(loc, info),
      afterAct: (err) => inner?.afterAct?.(err),
      beforeVerify: async () => inner?.beforeVerify?.(),
      afterVerify: (results) => {
        const c = this.cur();
        if (c) {
          c.conditions = results.map((r) => {
            let text: string;
            try {
              text = conditionToText(r.condition);
            } catch {
              text = r.condition.type;
            }
            return { text, type: r.condition.type, passed: r.passed, actual: r.actual, message: r.message, expected: expectedOf(r.condition as Record<string, unknown>) };
          });
        }
        inner?.afterVerify?.(results);
      },
      beforeHeal: async (failure) => inner?.beforeHeal?.(failure),
      healCandidate: (h) => {
        const c = this.cur();
        if (c) {
          c.heal.attempts.push({ tier: h.tier, description: describeCandidate(h.resolved), confidence: h.confidence, reason: h.reason, matches: h.matches });
          c.used = { description: describeCandidate(h.resolved), strategy: h.resolved.strategy, value: h.resolved.value };
        }
        inner?.healCandidate?.(h);
      },
      healNote: (m) => {
        this.cur()?.heal.notes.push(m);
        inner?.healNote?.(m);
      },
    };
  }

  private listen(page: Page): void {
    const byReq = new Map<Request, LiveNetworkEntry>();
    const onRequest = (req: Request) => {
      if (this.network.length >= MAX_NET) this.network.shift();
      const n: LiveNetworkEntry = { id: ++this.netSeq, stepIndex: this.current, method: req.method(), url: req.url(), resourceType: req.resourceType(), startedAt: Date.now() };
      byReq.set(req, n);
      this.network.push(n);
    };
    const onDone = (req: Request, failure?: string) => {
      const n = byReq.get(req);
      if (!n) return;
      byReq.delete(req);
      n.durationMs = Date.now() - n.startedAt;
      if (failure) n.failure = failure;
      void (async () => {
        const res = failure ? null : await req.response().catch(() => null);
        n.status = res?.status();
        n.requestHeaders = await req.allHeaders().catch(() => req.headers());
        n.responseHeaders = res ? await res.allHeaders().catch(() => res.headers()) : undefined;
        n.mimeType = n.responseHeaders?.['content-type'];
        const post = req.postData();
        if (post) n.requestBody = post.slice(0, MAX_BODY);
        const status = n.status ?? 0;
        if (res && isTextual(n.mimeType ?? '') && !(status >= 300 && status < 400) && status !== 204) {
          const b = await res.body().catch(() => undefined);
          if (b) n.responseBody = b.subarray(0, MAX_BODY).toString('utf8');
        }
      })().catch(() => undefined);
    };
    const onFinished = (req: Request) => onDone(req);
    const onFailed = (req: Request) => onDone(req, req.failure()?.errorText ?? 'failed');
    const onConsole = (m: ConsoleMessage) => {
      if (this.consoleLog.length >= MAX_CONSOLE) this.consoleLog.shift();
      const loc = m.location();
      this.consoleLog.push({ stepIndex: this.current, type: m.type(), text: m.text(), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined, at: Date.now() });
    };
    const onError = (e: Error) => {
      this.consoleLog.push({ stepIndex: this.current, type: 'pageerror', text: `${e.name}: ${e.message}`, at: Date.now() });
    };
    page.on('request', onRequest);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    page.on('console', onConsole);
    page.on('pageerror', onError);
    this.offPage.push(() => {
      this.followed.delete(page);
      page.off('request', onRequest);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('console', onConsole);
      page.off('pageerror', onError);
    });
  }

  private redactNet(n: LiveNetworkEntry): LiveNetworkEntry {
    const R = this.redactor;
    const ct = n.requestHeaders?.['content-type'] ?? '';
    return {
      ...n,
      url: R.url(n.url),
      requestHeaders: n.requestHeaders ? R.headers(n.requestHeaders) : undefined,
      responseHeaders: n.responseHeaders ? R.headers(n.responseHeaders) : undefined,
      requestBody: n.requestBody !== undefined ? R.body(n.requestBody, ct) : undefined,
      responseBody: n.responseBody !== undefined ? R.body(n.responseBody, n.mimeType ?? '') : undefined,
    };
  }

  /** Details of one step (or the current one), with its network and console, masked. */
  details(index?: number): { step?: LiveStepDetails; network: LiveNetworkEntry[]; console: LiveConsoleEntry[]; current: number } {
    const i = index ?? this.current;
    const step = this.steps.get(i);
    return this.mask({
      step,
      network: this.network.filter((n) => n.stepIndex === i).map((n) => this.redactNet(n)),
      console: this.consoleLog.filter((c) => c.stepIndex === i),
      current: this.current,
    });
  }

  /** Status of every step seen so far. */
  summary(): Array<{ index: number; status?: string; durationMs?: number; execution: number }> {
    return [...this.steps.values()].map((s) => ({ index: s.index, status: s.status, durationMs: s.durationMs, execution: s.execution })).sort((a, b) => a.index - b.index);
  }

  close(): void {
    this.reset();
    this.off();
  }
}
