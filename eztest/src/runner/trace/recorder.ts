/**
 * Time-travel recorder for one journey attempt: listens to the page's network
 * and console, takes DOM snapshots before and after every step, collects the
 * step's locator, heal and post-condition details through step hooks, and
 * writes `trace/<journeyId>-<attempt>/trace.json`. Every string is redacted
 * at write time, after the whole attempt ran, so values learned late (a
 * password typed in step 3) are masked everywhere.
 */
import { gzipSync } from 'node:zlib';
import type { Locator, Page, Request } from '../../browser/index.js';
import {
  nowIso,
  sha256,
  type Condition,
  type ConditionResult,
  type JourneyResult,
  type Step,
  type StepResult,
} from '../../core/index.js';
import { conditionToText } from '../../intent/conditions.js';
import { safeName, type EvidenceWriter } from '../evidence.js';
import type { StepHooks } from '../hooks.js';
import { describeCandidate } from '../locate.js';
import { REDACTED, Redactor } from './redact.js';
import { serializePage, type RawSnapshot } from './serializer.js';
import { TRACE_ROOT, type StoredResource, type TraceResourceStore } from './store.js';
import {
  TRACE_FORMAT,
  TRACE_VERSION,
  type HealAttempt,
  type SnapshotRef,
  type TimeTravelOptions,
  type TraceBody,
  type TraceCondition,
  type TraceConsoleEntry,
  type TraceFile,
  type TraceNetworkEntry,
  type TraceStep,
  type TriedLocator,
} from './types.js';

export const SENSITIVE_DESC = /pass(?:word|wd|phrase)?|secret|token|api[-_ ]?key|\bpin\b|\botp\b|one[- ]time|cvv|cvc/i;
const RESOURCE_TYPES = new Set(['stylesheet', 'image', 'font']);
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const INLINE_BODY_BYTES = 1024;

/** Trace directory of a journey attempt, relative to the run directory. */
export function traceDirOf(journeyId: string, attempt: number): string {
  return `${TRACE_ROOT}/${safeName(journeyId)}-${attempt}`;
}

export interface ResolvedTimeTravel {
  dom: boolean;
  network: boolean;
  console: boolean;
  screenshots: boolean;
  maxBodyBytes: number;
}

export function resolveTimeTravel(o: TimeTravelOptions): ResolvedTimeTravel {
  return {
    dom: o.dom ?? true,
    network: o.network ?? true,
    console: o.console ?? true,
    screenshots: o.screenshots ?? true,
    maxBodyBytes: Math.max(0, Math.floor(o.maxBodyBytes ?? 65536)),
  };
}

interface RawNet {
  slot: number;
  req: Request;
  startedAt: string;
  done?: Omit<TraceNetworkEntry, 'stepIndex' | 'requestHeaders' | 'responseHeaders' | 'requestBody' | 'responseBody'> & {
    reqHeaders: Record<string, string>;
    resHeaders?: Record<string, string>;
    reqBody?: string;
    resBody?: Buffer;
    resTruncated?: boolean;
    resOmitted?: string;
    reqContentType?: string;
  };
}

interface Slot {
  index: number;
  execution: number;
}

interface Current {
  slot: number;
  step: Step;
  value?: string;
  edited: boolean;
  startMs: number;
  startedAt: string;
  urlBefore: string;
  locatedAt?: number;
  actStart?: number;
  actEnd?: number;
  verifyStart?: number;
  verifyEnd?: number;
  healStart?: number;
  snapshotMs: number;
  tried: TriedLocator[];
  healAttempts: HealAttempt[];
  healNotes: string[];
  before?: RawSnapshot;
  beforeAt?: string;
  sensitive: boolean;
  loc?: Locator;
}

interface PendingStep {
  slot: Slot;
  cur: Current;
  result: StepResult;
  after?: RawSnapshot;
  afterAt?: string;
  urlAfter: string;
  jpeg?: Buffer;
}

export interface RecorderInit {
  runId: string;
  runDir: string;
  browserName: string;
  journeyId: string;
  journeyName: string;
  attempt: number;
  page: Page;
  evidence: EvidenceWriter;
  store: TraceResourceStore;
  options: TimeTravelOptions;
}

export class JourneyTraceRecorder {
  readonly dir: string;
  readonly redactor: Redactor;
  private readonly cfg: ResolvedTimeTravel;
  private readonly slots: Slot[] = [];
  private currentSlot = -1;
  private cur?: Current;
  private readonly net: RawNet[] = [];
  private readonly netByReq = new Map<Request, RawNet>();
  private readonly pending: Array<Promise<void>> = [];
  private readonly consoleLog: Array<Omit<TraceConsoleEntry, 'stepIndex'> & { slot: number }> = [];
  private readonly steps: PendingStep[] = [];
  /** url -> stored body, for inlining images/CSS into snapshots. */
  private readonly urlResources = new Map<string, Promise<StoredResource | undefined>>();
  private readonly startedAt = nowIso();
  private readonly t0 = Date.now();
  private readonly off: Array<() => void> = [];

  constructor(private readonly init: RecorderInit) {
    this.dir = traceDirOf(init.journeyId, init.attempt);
    this.redactor = new Redactor(init.options.masker);
    this.cfg = resolveTimeTravel(init.options);
    this.followed.add(init.page);
    this.listen();
  }

  // ---------------------------------------------------------------- listeners

  /**
   * The journey switched to another tab or popup: snapshots, screenshots and
   * URLs come from it from now on, and its network/console traffic is recorded too.
   */
  followPage(page: Page): void {
    if (page === this.init.page) return;
    const known = this.followed.has(page);
    this.init.page = page;
    if (!known) {
      this.followed.add(page);
      this.listen();
    }
  }

  private readonly followed = new Set<Page>();

  private listen(): void {
    const { page } = this.init;
    const on = <T>(event: string, fn: (arg: T) => void) => {
      page.on(event as 'console', fn as never);
      this.off.push(() => page.off(event as 'console', fn as never));
    };
    if (this.cfg.network || this.cfg.dom) {
      on<Request>('request', (req) => {
        const r: RawNet = { slot: this.currentSlot, req, startedAt: nowIso() };
        this.netByReq.set(req, r);
        if (this.cfg.network) this.net.push(r);
      });
      on<Request>('requestfinished', (req) => this.track(this.complete(req)));
      on<Request>('requestfailed', (req) => this.track(this.complete(req, req.failure()?.errorText ?? 'failed')));
    }
    if (this.cfg.console) {
      on<import('../../browser/index.js').ConsoleMessage>('console', (m) => {
        const loc = m.location();
        this.consoleLog.push({ slot: this.currentSlot, type: m.type(), text: m.text(), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined, at: nowIso() });
      });
      on<Error>('pageerror', (e) => {
        this.consoleLog.push({ slot: this.currentSlot, type: 'pageerror', text: `${e.name}: ${e.message}`, at: nowIso() });
      });
    }
  }

  private track(p: Promise<void>): void {
    this.pending.push(p.catch(() => undefined));
  }

  private async complete(req: Request, failure?: string): Promise<void> {
    const raw = this.netByReq.get(req);
    if (!raw) return;
    const res = failure ? null : await req.response().catch(() => null);
    const reqHeaders = await req.allHeaders().catch(() => req.headers());
    const resHeaders = res ? await res.allHeaders().catch(() => res.headers()) : undefined;
    const sizes = await req.sizes().catch(() => undefined);
    const t = req.timing();
    const span = (a: number, b: number) => (a >= 0 && b >= 0 && b >= a ? Math.round((b - a) * 100) / 100 : undefined);
    const mime = resHeaders?.['content-type'] ?? '';
    const type = req.resourceType();
    const done: NonNullable<RawNet['done']> = {
      method: req.method(),
      url: req.url(),
      resourceType: type,
      status: res?.status(),
      statusText: res?.statusText(),
      failure,
      startedAt: raw.startedAt,
      durationMs: t.responseEnd >= 0 ? Math.round(t.responseEnd) : undefined,
      timing: {
        dnsMs: span(t.domainLookupStart, t.domainLookupEnd),
        connectMs: span(t.connectStart, t.connectEnd),
        waitMs: span(t.requestStart, t.responseStart),
        receiveMs: span(t.responseStart, t.responseEnd),
      },
      sizes: sizes
        ? { requestBody: sizes.requestBodySize, responseBody: sizes.responseBodySize, requestHeaders: sizes.requestHeadersSize, responseHeaders: sizes.responseHeadersSize }
        : undefined,
      mimeType: mime || undefined,
      reqHeaders,
      resHeaders,
      reqContentType: reqHeaders['content-type'],
    };
    if (this.cfg.maxBodyBytes > 0) {
      const post = req.postData();
      if (post) done.reqBody = post;
    }
    const status = res?.status() ?? 0;
    const hasBody = res && !(status >= 300 && status < 400) && status !== 204;
    if (hasBody && this.cfg.network && this.cfg.maxBodyBytes > 0 && isTextual(mime)) {
      const body = await res.body().catch(() => undefined);
      if (body) {
        done.resTruncated = body.length > this.cfg.maxBodyBytes;
        done.resBody = body.subarray(0, this.cfg.maxBodyBytes);
      }
    } else if (hasBody && this.cfg.network) {
      done.resOmitted = mime ? `non-text body (${mime.split(';')[0]})` : 'body not captured';
    }
    if (hasBody && this.cfg.dom && RESOURCE_TYPES.has(type) && !this.urlResources.has(req.url())) {
      this.urlResources.set(
        req.url(),
        res
          .body()
          .then((b) => (b.length <= MAX_RESOURCE_BYTES ? this.init.store.put(b, mime || 'application/octet-stream', { journeyId: this.init.journeyId }) : undefined))
          .catch(() => undefined),
      );
    }
    raw.done = done;
  }

  // ---------------------------------------------------------------- steps

  /** Start recording a step execution. `interpolate` resolves ${vars} in its value. */
  beginStep(index: number, step: Step, execution: number, edited: boolean, interpolate: (s: string) => string): void {
    this.slots.push({ index, execution });
    this.currentSlot = this.slots.length - 1;
    let value: string | undefined;
    try {
      value = step.value !== undefined ? interpolate(step.value) : undefined;
    } catch {
      value = step.value;
    }
    const sensitive = SENSITIVE_DESC.test(step.target?.description ?? '');
    if (sensitive) this.redactor.learn(value);
    this.cur = {
      slot: this.currentSlot, step, value, edited, startMs: Date.now(), startedAt: nowIso(), urlBefore: this.init.page.url(),
      snapshotMs: 0, tried: [], healAttempts: [], healNotes: [], sensitive,
    };
  }

  /** Step hooks feeding this recorder. */
  readonly hooks: StepHooks = {
    located: (res) => {
      const c = this.cur;
      if (!c) return;
      c.locatedAt = Date.now();
      c.tried = (res.tried ?? []).map((t) => ({ candidate: t.candidate, description: describeCandidate(t.candidate), count: t.count, ...(t.error ? { error: t.error } : {}) }));
    },
    beforeAct: async (loc) => {
      const c = this.cur;
      if (!c) return;
      if (loc) c.loc = loc;
      if (!c.before) {
        if (loc && c.value !== undefined && !c.sensitive) {
          c.sensitive = await isSensitiveInput(loc);
          if (c.sensitive) this.redactor.learn(c.value);
        }
        if (this.cfg.dom) {
          const t = Date.now();
          c.before = await this.capture(loc);
          c.beforeAt = nowIso();
          c.snapshotMs += Date.now() - t;
          if (c.before?.target?.sensitive && !c.sensitive) {
            c.sensitive = true;
            this.redactor.learn(c.value);
          }
        }
      }
      c.actStart = Date.now();
    },
    afterAct: () => {
      if (this.cur) this.cur.actEnd = Date.now();
    },
    beforeVerify: async () => {
      if (this.cur) this.cur.verifyStart = Date.now();
    },
    afterVerify: () => {
      if (this.cur) this.cur.verifyEnd = Date.now();
    },
    beforeHeal: async () => {
      if (this.cur && this.cur.healStart === undefined) this.cur.healStart = Date.now();
    },
    healCandidate: (h) => {
      this.cur?.healAttempts.push({ tier: h.tier, locator: h.resolved, description: describeCandidate(h.resolved), confidence: h.confidence, reason: h.reason, matches: h.matches });
    },
    healNote: (m) => {
      this.cur?.healNotes.push(m);
    },
  };

  private async capture(loc?: Locator): Promise<RawSnapshot | undefined> {
    const n = loc ? await loc.count().catch(() => 0) : 0;
    const handle = loc && n === 1 ? await loc.elementHandle({ timeout: 500 }).catch(() => null) : null;
    try {
      return await serializePage(this.init.page, handle);
    } catch {
      return undefined;
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
  }

  /** Finish the current step: after-snapshot, viewport JPEG. */
  async endStep(result: StepResult): Promise<void> {
    const c = this.cur;
    if (!c) return;
    const loc = c.loc;
    this.cur = undefined;
    const p: PendingStep = { slot: this.slots[c.slot], cur: c, result, urlAfter: this.init.page.url() };
    if (this.cfg.dom) {
      const t = Date.now();
      if (!c.before) {
        // Locate failed before any action: the page as the step gave up on it.
        c.before = await this.capture(loc);
        c.beforeAt = nowIso();
      }
      p.after = await this.capture(loc);
      p.afterAt = nowIso();
      c.snapshotMs += Date.now() - t;
    }
    if (this.cfg.screenshots) {
      p.jpeg = await this.init.page.screenshot({ type: 'jpeg', quality: 55, timeout: 3000 }).catch(() => undefined);
    }
    this.steps.push(p);
    this.currentSlot = -1;
  }

  /** A step that never ran (skipped in the debugger). */
  recordSkipped(index: number, step: Step, result: StepResult): void {
    this.slots.push({ index, execution: 1 });
    const slot = this.slots.length - 1;
    const now = Date.now();
    this.steps.push({
      slot: this.slots[slot],
      cur: { slot, step, edited: false, startMs: now, startedAt: nowIso(), urlBefore: this.init.page.url(), snapshotMs: 0, tried: [], healAttempts: [], healNotes: [], sensitive: false },
      result,
      urlAfter: this.init.page.url(),
    });
  }

  // ---------------------------------------------------------------- writing

  /** Settle in-flight requests, write snapshots, bodies and trace.json. Returns the trace.json evidence id. */
  async finish(journey: JourneyResult): Promise<string | undefined> {
    for (const o of this.off.splice(0)) o();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(this.pending), new Promise((r) => (timer = setTimeout(r, 3000)))]);
    clearTimeout(timer);
    const { evidence, journeyId } = this.init;
    const meta = (stepId?: string, description?: string) => ({ journeyId, ...(stepId ? { stepId } : {}), ...(description ? { description } : {}) });
    const R = this.redactor;
    const resources: TraceFile['resources'] = {};
    const snapshotPaths = new Map<string, string>();

    const writeSnapshot = async (raw: RawSnapshot | undefined, at: string | undefined, phase: 'before' | 'after', ps: PendingStep): Promise<SnapshotRef | undefined> => {
      if (!raw) return undefined;
      let html = raw.html;
      for (let i = 0; i < raw.styles.length; i++) {
        const res = await this.init.store.put(R.mask(raw.styles[i]), 'text/css', { journeyId });
        resources[res.key] = { path: res.path, contentType: res.contentType, size: res.size };
        html = html.replace(new RegExp(`ezres:${i}(?=["&])`, 'g'), `ezres:${res.key}`);
      }
      // ezurl: references (images, unreadable stylesheets), also inside same-origin iframe srcdoc (escaped quotes).
      const urls = [...html.matchAll(/(src|href)=("|&quot;)ezurl:(.*?)\2/g)];
      for (const m of urls) {
        const q = m[2];
        const url = q === '"' ? unescapeAttr(m[3]) : unescapeAttr(unescapeAttr(m[3]));
        const res = await this.urlResources.get(url);
        if (res) {
          resources[res.key] = { path: res.path, contentType: res.contentType, size: res.size };
          html = html.split(m[0]).join(`${m[1]}=${q}ezres:${res.key}${q}`);
        } else {
          const safe = q === '"' ? escapeAttr(R.url(url)) : escapeAttr(escapeAttr(R.url(url)));
          html = html.split(m[0]).join(`${m[1]}=${q}${q} data-ez-${m[1]}=${q}${safe}${q}`);
        }
      }
      html = R.mask(html);
      const gz = gzipSync(Buffer.from(html, 'utf8'));
      const hash = sha256(html);
      let path = snapshotPaths.get(hash);
      if (!path) {
        path = `${this.dir}/snapshots/${String(ps.slot.index).padStart(3, '0')}-${ps.slot.execution}-${phase}.html.gz`;
        await evidence.store('trace', path, gz, meta(ps.cur.step.id, `DOM snapshot ${phase} ${ps.cur.step.id}`));
        snapshotPaths.set(hash, path);
      }
      return {
        phase, path, sha256: hash, bytes: html.length, url: R.url(raw.url), title: R.mask(raw.title), viewport: raw.viewport, scroll: raw.scroll,
        ...(raw.target ? { target: { ...raw.target, regionText: R.mask(raw.target.regionText) } } : {}),
        text: R.mask(raw.text), nodeCount: raw.nodeCount, engine: 'in-page', capturedAt: at ?? nowIso(),
      };
    };

    const body = async (text: string | Buffer | undefined, contentType: string | undefined, truncated?: boolean, omitted?: string): Promise<TraceBody | undefined> => {
      if (omitted) return { size: 0, omitted };
      if (text === undefined) return undefined;
      const str = typeof text === 'string' ? text : text.toString('utf8');
      const clipped = str.length > this.cfg.maxBodyBytes ? str.slice(0, this.cfg.maxBodyBytes) : str;
      const red = R.body(clipped, contentType ?? '');
      const isTrunc = truncated || str.length > this.cfg.maxBodyBytes;
      if (red.length <= INLINE_BODY_BYTES) return { text: red, size: str.length, ...(isTrunc ? { truncated: true } : {}) };
      const res = await this.init.store.put(red, (contentType ?? 'text/plain').includes('json') ? 'application/json' : 'text/plain', { journeyId, description: 'network body' });
      return { path: res.path, size: str.length, ...(isTrunc ? { truncated: true } : {}) };
    };

    const network = async (r: RawNet): Promise<TraceNetworkEntry> => {
      const d = r.done;
      const stepIndex = r.slot >= 0 ? this.slots[r.slot].index : -1;
      if (!d) {
        return { stepIndex, method: r.req.method(), url: R.url(r.req.url()), resourceType: r.req.resourceType(), startedAt: r.startedAt, failure: 'no response before the journey ended', requestHeaders: {} };
      }
      return {
        stepIndex, method: d.method, url: R.url(d.url), resourceType: d.resourceType, status: d.status, statusText: d.statusText, failure: d.failure,
        startedAt: d.startedAt, durationMs: d.durationMs, timing: d.timing, sizes: d.sizes, mimeType: d.mimeType,
        requestHeaders: R.headers(d.reqHeaders), responseHeaders: d.resHeaders ? R.headers(d.resHeaders) : undefined,
        requestBody: await body(d.reqBody, d.reqContentType),
        responseBody: await body(d.resBody, d.mimeType, d.resTruncated, d.resOmitted),
      };
    };

    const allNet = await Promise.all(this.net.map(network));
    const allConsole: Array<TraceConsoleEntry & { slot: number }> = this.consoleLog.map((c) => ({
      ...c, stepIndex: c.slot >= 0 ? this.slots[c.slot].index : -1, text: R.mask(c.text), location: c.location ? R.url(c.location) : undefined,
    }));

    const steps: TraceStep[] = [];
    for (const ps of this.steps) {
      const { cur: c, result: sr } = ps;
      const slotIdx = c.slot;
      const before = await writeSnapshot(c.before, c.beforeAt, 'before', ps);
      const after = await writeSnapshot(ps.after, ps.afterAt, 'after', ps);
      let viewportJpeg: string | undefined;
      if (ps.jpeg) {
        const res = await this.init.store.put(ps.jpeg, 'image/jpeg', { journeyId, description: `viewport after ${c.step.id}` });
        viewportJpeg = res.path;
      }
      const shotId = sr.evidence.find((id) => evidence.vault.entries.some((e) => e.id === id && e.kind === 'screenshot'));
      const shot = shotId ? evidence.vault.entries.find((e) => e.id === shotId) : undefined;
      const end = c.startMs + sr.durationMs;
      const ms = (a?: number, b?: number) => (a !== undefined && b !== undefined && b >= a ? b - a : undefined);
      steps.push({
        index: ps.slot.index,
        execution: ps.slot.execution,
        stepId: c.step.id,
        intent: R.mask(c.step.intent),
        action: c.step.action,
        ...(c.value !== undefined ? { value: c.sensitive ? REDACTED : R.mask(c.value) } : {}),
        ...(c.step.target ? { targetDescription: R.mask(c.step.target.description) } : {}),
        status: sr.status,
        ...(sr.error ? { error: R.mask(sr.error.message) } : {}),
        startedAt: c.startedAt,
        durationMs: sr.durationMs,
        timings: {
          locateMs: ms(c.startMs, c.locatedAt),
          actMs: ms(c.actStart, c.actEnd),
          verifyMs: ms(c.verifyStart, c.verifyEnd),
          healMs: ms(c.healStart, Math.max(end, c.verifyEnd ?? 0, c.actEnd ?? 0)),
          snapshotMs: c.snapshotMs || undefined,
        },
        locator: {
          used: sr.usedLocator,
          usedDescription: sr.usedLocator ? describeCandidate(sr.usedLocator) : undefined,
          tried: c.tried,
        },
        ...(c.healAttempts.length || c.healNotes.length || sr.heal ? { heal: { attempts: c.healAttempts, notes: c.healNotes.map((n) => R.mask(n)), record: sr.heal } } : {}),
        conditions: sr.conditions.map((r) => traceCondition(r, R)),
        snapshots: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
        network: allNet.filter((n, i) => this.net[i].slot === slotIdx),
        console: allConsole.filter((x) => x.slot === slotIdx).map(({ slot: _s, ...rest }) => rest),
        ...(shot || viewportJpeg ? { screenshot: { evidenceId: shot?.id, path: shot?.path, viewportJpeg } } : {}),
        url: { before: R.url(c.urlBefore), after: R.url(ps.urlAfter) },
        ...(c.edited ? { edited: true } : {}),
      });
    }

    const vp = this.init.page.viewportSize() ?? undefined;
    const trace: TraceFile = {
      format: TRACE_FORMAT,
      version: TRACE_VERSION,
      source: 'eztest',
      runId: this.init.runId,
      journeyId,
      journeyName: R.mask(this.init.journeyName),
      attempt: this.init.attempt,
      browser: this.init.browserName,
      startedAt: this.startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - this.t0,
      status: journey.status,
      viewport: vp,
      steps,
      unattributed: {
        network: allNet.filter((_, i) => this.net[i].slot < 0),
        console: allConsole.filter((x) => x.slot < 0).map(({ slot: _s, ...rest }) => rest),
      },
      resources,
      dir: this.dir,
    };
    let json = R.mask(JSON.stringify(trace, null, 1));
    try {
      JSON.parse(json);
    } catch {
      json = JSON.stringify(R.deep(trace), null, 1);
    }
    const ref = await evidence.store('trace', `${this.dir}/trace.json`, json, meta(undefined, 'time-travel trace index'));
    return ref.id;
  }
}

function traceCondition(r: ConditionResult, R: Redactor): TraceCondition {
  let text: string;
  try {
    text = conditionToText(r.condition);
  } catch {
    text = r.condition.type;
  }
  const exp = expectedOf(r.condition);
  return {
    type: r.condition.type,
    text: R.mask(text),
    ...(exp !== undefined ? { expected: R.mask(exp) } : {}),
    ...(r.actual !== undefined ? { actual: R.mask(r.actual) } : {}),
    passed: r.passed,
    ...(r.message ? { message: R.mask(r.message) } : {}),
  };
}

function expectedOf(c: Condition): string | undefined {
  switch (c.type) {
    case 'urlMatches': return c.pattern;
    case 'count': return String(c.equals);
    case 'dbRowCount': return String(c.equals);
    case 'apiStatus': return String(c.status);
    case 'ledgerEquals': return c.expected ?? (c.otherKey ? `\${${c.otherKey}}` : undefined);
    case 'visible': return 'visible';
    case 'hidden': return 'hidden';
    case 'downloadExists': return 'file exists';
    default: return 'value' in c && c.value !== undefined ? String(c.value) : undefined;
  }
}

function isTextual(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.startsWith('text/') || m.includes('json') || m.includes('xml') || m.includes('javascript') || m.includes('x-www-form-urlencoded') || m.includes('graphql');
}

export async function isSensitiveInput(loc: Locator): Promise<boolean> {
  return loc
    .evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') return false;
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      return type === 'password' || /password|one-time-code|cc-number|cc-csc/.test(ac);
    }, undefined, { timeout: 1000 })
    .catch(() => false);
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
