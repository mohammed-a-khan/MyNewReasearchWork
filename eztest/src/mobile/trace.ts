/**
 * Time-travel trace for native journeys, in the same `eztest-trace` format as
 * web traces, so the Studio trace viewer, diffs and bundles work unchanged.
 * A "DOM snapshot" of a native screen is a self-contained HTML page: the
 * screenshot with every element of the page source drawn as a box at its
 * bounds (`data-ez-nid` = node index), plus the source tree. The step's
 * target is outlined by the viewer's usual highlight.
 */
import { gzipSync } from 'node:zlib';
import { nowIso, sha256, type ConditionResult, type HealRecord, type JourneyResult, type LocatorCandidate, type Step, type StepResult } from '../core/index.js';
import { conditionToText } from '../intent/conditions.js';
import type { EvidenceWriter } from '../runner/evidence.js';
import { traceDirOf } from '../runner/trace/recorder.js';
import { Redactor } from '../runner/trace/redact.js';
import type { TraceResourceStore } from '../runner/trace/store.js';
import { TRACE_FORMAT, TRACE_VERSION, type SnapshotRef, type TraceCondition, type TraceFile, type TraceStep } from '../runner/trace/types.js';
import { describeCandidate } from '../runner/locate.js';
import { describeFinder } from './locators.js';
import type { NativeContext, TriedFinder } from './native.js';
import { isNodeVisible, nameOf, screenText, textOf, type NativeNode, type PageSource } from './source.js';
import type { Rect } from './session.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The snapshot page for one screen (screenshot reference + element boxes + source). */
export function snapshotHtml(src: PageSource, xml: string, window: Rect, shotKey: string | undefined, title: string, mask: (s: string) => string): string {
  const boxes = src.nodes
    .filter((n) => n.bounds && isNodeVisible(n) && n.bounds.width > 0 && n.bounds.height > 0)
    .map((n) => {
      const b = n.bounds!;
      const label = [n.tag, nameOf(n), textOf(n)].filter(Boolean).join(' · ');
      return `<div class="el" data-ez-nid="${n.index}" title="${esc(mask(label))}" style="left:${b.x - window.x}px;top:${b.y - window.y}px;width:${b.width}px;height:${b.height}px"></div>`;
    })
    .join('');
  const source = mask(xml.length > 200_000 ? `${xml.slice(0, 200_000)}\n<!-- truncated -->` : xml);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(mask(title))}</title><style>
body{margin:0;font:12px/1.4 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;gap:16px;padding:12px;align-items:flex-start}
.screen{position:relative;flex:none;width:${window.width}px;height:${window.height}px;background:#000;overflow:hidden;border-radius:12px}
.shot{position:absolute;left:0;top:0;width:100%;height:100%}
.el{position:absolute;box-sizing:border-box;border:1px solid rgba(56,189,248,.35)}
.el:hover{background:rgba(56,189,248,.18);border-color:#38bdf8}
pre{margin:0;white-space:pre-wrap;word-break:break-all;max-width:640px;font:11px/1.35 ui-monospace,monospace;color:#cbd5e1}
</style></head><body><div class="screen">${shotKey ? `<img class="shot" alt="screen" src="ezres:${shotKey}">` : ''}${boxes}</div><pre>${esc(source)}</pre></body></html>`;
}

interface Snap {
  ref: SnapshotRef;
  /** Trace resource path of the screenshot (the viewer's filmstrip image). */
  shot?: string;
  src: PageSource;
}

interface PendingStep {
  index: number;
  step: Step;
  startedAt: string;
  t0: number;
  before?: Snap;
  contextBefore: string;
}

export interface NativeTraceInit {
  runId: string;
  journeyId: string;
  journeyName: string;
  attempt: number;
  platform: string;
  evidence: EvidenceWriter;
  store: TraceResourceStore;
  mask?: (s: string) => string;
  native: NativeContext;
}

/** Records a native journey attempt as an EZTest trace. */
export class NativeTraceRecorder {
  private readonly dir: string;
  private readonly R: Redactor;
  private readonly steps: TraceStep[] = [];
  private last?: Snap;
  private pending?: PendingStep;
  private readonly t0 = Date.now();
  private readonly startedAt = nowIso();
  private seq = 0;
  /** Resources referenced by snapshots (screenshots), keyed by their ezres: token. */
  private readonly resources: TraceFile['resources'] = {};
  /** Resolution details per step, reported by the executor. */
  readonly located = new Map<string, { tried: TriedFinder[]; used?: LocatorCandidate; heal?: { attempts: Array<{ tier: string; locator: LocatorCandidate; confidence: number; reason: string; matches: number }>; notes: string[] }; element?: string }>();

  constructor(private readonly init: NativeTraceInit) {
    this.dir = traceDirOf(init.journeyId, init.attempt);
    this.R = new Redactor(init.mask ? { mask: init.mask } : undefined);
  }

  /** Learn a value that must never appear in the trace (typed into a password field). */
  learn(v: string | undefined): void {
    this.R.learn(v);
  }

  private async snap(phase: 'before' | 'after', stepId: string, element?: string): Promise<Snap | undefined> {
    const n = this.init.native;
    try {
      n.invalidate();
      const [{ src, xml }, png, window] = await Promise.all([n.nativeSource(), n.device.screenshot().catch(() => undefined), n.window()]);
      const shot = png ? await this.init.store.put(png, 'image/png', { journeyId: this.init.journeyId, description: `screen ${phase} ${stepId}` }) : undefined;
      if (shot) this.resources[shot.key] = { path: shot.path, contentType: shot.contentType, size: shot.size };
      const html = snapshotHtml(src, xml, window, shot?.key, `${this.init.journeyName} ${stepId}`, (s) => this.R.mask(s));
      const gz = gzipSync(Buffer.from(html, 'utf8'));
      const path = `${this.dir}/snapshots/${String(this.seq++).padStart(3, '0')}-${phase}.html.gz`;
      await this.init.evidence.store('trace', path, gz, { journeyId: this.init.journeyId, stepId, description: `native screen snapshot ${phase} ${stepId}` });
      let target: SnapshotRef['target'];
      if (element) {
        const node: NativeNode | undefined = await n.nodeOf(element).catch(() => undefined);
        if (node?.bounds) target = { nid: node.index, box: { ...node.bounds }, tag: node.tag, ...(node.attrs.password === 'true' ? { sensitive: true } : {}) };
      }
      const ref: SnapshotRef = {
        phase, path, sha256: sha256(gz), bytes: gz.length, url: n.context, title: this.R.mask(this.init.journeyName),
        viewport: { width: window.width, height: window.height, deviceScaleFactor: 1 }, scroll: { x: 0, y: 0 },
        ...(target ? { target } : {}), text: this.R.mask(screenText(src)).slice(0, 4000), nodeCount: src.nodes.length, engine: 'native-source', capturedAt: nowIso(),
      };
      return { ref, src, ...(shot ? { shot: shot.path } : {}) };
    } catch {
      return undefined;
    }
  }

  async beginStep(index: number, step: Step): Promise<void> {
    const before = this.last ?? (await this.snap('before', step.id));
    this.pending = { index, step, startedAt: nowIso(), t0: Date.now(), before, contextBefore: this.init.native.context };
  }

  async endStep(sr: StepResult, screenshotEvidence?: { id: string; path: string }): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    const loc = this.located.get(p.step.id);
    const after = await this.snap('after', p.step.id, loc?.element);
    if (after) this.last = { ref: { ...after.ref, phase: 'before', target: undefined }, src: after.src };
    const R = this.R;
    const heal: HealRecord | undefined = sr.heal;
    this.steps.push({
      index: p.index, execution: 1, stepId: p.step.id, intent: R.mask(p.step.intent), action: p.step.action,
      ...(p.step.value !== undefined ? { value: R.mask(p.step.value) } : {}),
      ...(p.step.target ? { targetDescription: R.mask(p.step.target.description) } : {}),
      status: sr.status, ...(sr.error ? { error: R.mask(sr.error.message) } : {}),
      startedAt: p.startedAt, durationMs: Date.now() - p.t0, timings: {},
      locator: {
        ...(sr.usedLocator ? { used: sr.usedLocator, usedDescription: describeCandidate(sr.usedLocator) } : {}),
        tried: (loc?.tried ?? []).map((t) => ({ candidate: t.candidate, description: describeFinder(t.finder), count: t.count, ...(t.error ? { error: R.mask(t.error) } : {}) })),
      },
      ...(loc?.heal || heal ? {
        heal: {
          attempts: (loc?.heal?.attempts ?? []).map((a) => ({ tier: a.tier as never, locator: a.locator, description: `${a.locator.strategy}=${a.locator.value}`, confidence: a.confidence, reason: R.mask(a.reason), matches: a.matches })),
          notes: (loc?.heal?.notes ?? []).map((x) => R.mask(x)),
          ...(heal ? { record: heal } : {}),
        },
      } : {}),
      conditions: sr.conditions.map((c) => traceCondition(c, R)),
      snapshots: { ...(p.before ? { before: p.before.ref } : {}), ...(after ? { after: after.ref } : {}) },
      network: [], console: [],
      ...(screenshotEvidence || after?.shot ? { screenshot: { ...(screenshotEvidence ? { evidenceId: screenshotEvidence.id, path: screenshotEvidence.path } : {}), ...(after?.shot ? { viewportJpeg: after.shot } : {}) } } : {}),
      url: { before: p.contextBefore, after: this.init.native.context },
    });
  }

  /** Write trace.json; returns its evidence id. */
  async finish(journey: JourneyResult): Promise<string> {
    const window = await this.init.native.window().catch(() => undefined);
    const trace: TraceFile = {
      format: TRACE_FORMAT, version: TRACE_VERSION, source: 'eztest', runId: this.init.runId, journeyId: journey.journeyId,
      journeyName: this.R.mask(journey.name), attempt: this.init.attempt, browser: this.init.platform, startedAt: this.startedAt, finishedAt: nowIso(),
      durationMs: Date.now() - this.t0, status: journey.status, ...(window ? { viewport: { width: window.width, height: window.height } } : {}),
      steps: this.steps, unattributed: { network: [], console: [] }, resources: {}, dir: this.dir,
    };
    trace.resources = this.resources;
    const ref = await this.init.evidence.store('trace', `${this.dir}/trace.json`, JSON.stringify(trace, null, 1), { journeyId: journey.journeyId, description: 'time-travel trace index (native)' });
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
  return {
    type: r.condition.type, text: R.mask(text), ...(r.actual !== undefined ? { actual: R.mask(r.actual) } : {}), passed: r.passed, ...(r.message ? { message: R.mask(r.message) } : {}),
  };
}
