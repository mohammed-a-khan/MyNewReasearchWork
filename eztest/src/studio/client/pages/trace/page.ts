/**
 * The Trace page (`#/trace`, `#/trace/run/<runId>/<journeyId>/<attempt>[/<stepId>]`,
 * `#/trace/uploaded/<id>`), the run-detail "Trace" tab (deep link
 * `#/runs/<runId>/<journeyId>/<stepId>/trace`) and "Open trace…" for
 * EZTest trace bundles (checked for integrity on open).
 */
import { api } from '../../core/api.js';
import { clear, h, uid } from '../../core/dom.js';
import { ms, relTime } from '../../core/format.js';
import { registerShortcut } from '../../core/keys.js';
import { registerCommand, registerPage, registerRunDetailTab, type RunDetail } from '../../core/registry.js';
import { link, navigate, route as currentRoute, type Route } from '../../core/router.js';
import { badge, emptyState } from '../../ui/badge.js';
import { toast, toastError } from '../../ui/toast.js';
import { fileToBase64, kitIcon } from '../debug/kit.js';
import type { TraceFile, TraceSource } from './model.js';
import { createTraceViewer, currentViewer } from './viewer.js';

interface TraceListItem {
  journeyId: string;
  journeyName: string;
  attempt: number;
  status: string;
  steps: number;
  durationMs: number;
}

interface Uploaded {
  id: string;
  name: string;
  kind: 'bundle' | 'browser';
  problems: string[];
  warnings: string[];
  verified: boolean;
  trace: TraceFile;
}

const uploadedCache = new Map<string, Uploaded>();

/** A hidden file input shared by "Open trace…" everywhere. */
let fileInput: HTMLInputElement | undefined;
export function openTraceFile(): void {
  if (!fileInput) {
    fileInput = h('input', { type: 'file', id: 'trace-file-input', accept: '.zip,application/zip', class: 'sr-only', tabindex: '-1', 'aria-label': 'Trace file (.eztrace.zip bundle or EZTest browser trace zip)' });
    fileInput.addEventListener('change', () => {
      const f = fileInput!.files?.[0];
      fileInput!.value = '';
      if (f) void uploadTrace(f);
    });
    document.body.appendChild(fileInput);
  }
  fileInput.click();
}

export async function uploadTrace(file: File): Promise<void> {
  const close = toast(`Opening ${file.name}…`, { timeout: 0 });
  try {
    const data = await fileToBase64(file);
    const r = await api.post<Uploaded>('/api/traces/upload', { name: file.name, data });
    uploadedCache.set(r.id, r);
    close();
    openedToast(r);
    navigate(link('trace', 'uploaded', r.id));
  } catch (e) {
    close();
    toastError(`Cannot open ${file.name}: ${(e as Error).message}`);
  }
}

function openedToast(r: Uploaded): void {
  const what = r.kind === 'browser' ? 'Browser trace' : 'Bundle';
  toast(r.verified ? `${what} opened: integrity verified (${r.trace.steps.length} steps)` : `${what} opened with ${r.problems.length} integrity problem(s)`, { kind: r.verified ? 'success' : 'warning', timeout: 5000 });
}

/** Open a run's per-attempt browser trace (a `trace` evidence zip) in the time-travel viewer. */
export async function openRunBrowserTrace(runId: string, path: string): Promise<void> {
  try {
    const r = await api.post<Uploaded>(`/api/runs/${encodeURIComponent(runId)}/browser-trace`, { path });
    uploadedCache.set(r.id, r);
    openedToast(r);
    navigate(link('trace', 'uploaded', r.id));
  } catch (e) {
    toastError(`Cannot open ${path}: ${(e as Error).message}`);
  }
}

function browserTraceList(d: RunDetail): HTMLElement | undefined {
  const zips = Object.values(d.evidence).filter((e) => e.kind === 'trace' && /\.zip$/i.test(e.path));
  if (!zips.length) return undefined;
  return h('div', { class: 'stack trace-browser-list' },
    h('h3', { class: 'h4', text: 'Browser traces' }),
    h('ul', { class: 'bullets' }, zips.map((e) => h('li', null, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void openRunBrowserTrace(d.run.runId, e.path) }, kitIcon('film', { size: 13 }), h('span', { text: `Open ${e.path.replace(/^traces\//, '')}` })), e.description ? h('span', { class: 'muted small', text: ` ${e.description}` }) : null))));
}

function sourceOfUploaded(u: Uploaded): TraceSource {
  return { kind: 'uploaded', id: u.id, name: u.name, bundleKind: u.kind, problems: u.problems, warnings: u.warnings, verified: u.verified };
}

// ------------------------------------------------------------------ standalone page

function landing(root: HTMLElement): void {
  const fileBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openTraceFile() }, kitIcon('upload'), h('span', { text: 'Open trace…' }));
  const drop = h('div', { class: 'trace-drop', role: 'group', 'aria-label': 'Drop a trace file here' }, kitIcon('film', { size: 28 }), h('p', null, 'Drop an ', h('code', { text: '.eztrace.zip' }), ' bundle or an EZTest browser trace zip here'), fileBtn);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void uploadTrace(f);
  });
  const recent = h('ul', { class: 'trace-recent', 'aria-label': 'Recent traces' }, h('li', { class: 'muted', text: 'Looking for traces…' }));
  clear(root).appendChild(
    h(
      'div',
      { class: 'page-inner narrow' },
      h('div', { class: 'page-head' }, h('h1', { class: 'page-title', tabindex: '-1', text: 'Trace viewer' }), h('p', { class: 'muted', text: 'Time-travel through a journey: DOM before and after every step, network, console, locators and heals. Compare runs and share bundles.' })),
      drop,
      h('h2', { class: 'h3', text: 'Recent runs with traces' }),
      recent,
    ),
  );
  void (async () => {
    try {
      const runs = (await api.get<{ runs: Array<{ runId: string; startedAt?: string }> }>('/api/runs')).runs.slice(0, 12);
      const items: HTMLElement[] = [];
      for (const r of runs) {
        const t = await api.get<{ traces: TraceListItem[] }>(`/api/runs/${encodeURIComponent(r.runId)}/traces`).catch(() => ({ traces: [] }));
        for (const x of t.traces) {
          items.push(h('li', { class: 'trace-recent-item' }, badge(x.status), h('a', { href: link('trace', 'run', r.runId, x.journeyId, String(x.attempt)), text: x.journeyName || x.journeyId }), h('span', { class: 'muted small', text: ` ${r.runId} · ${x.steps} steps · ${ms(x.durationMs)} · ${relTime(r.startedAt)}` })));
        }
      }
      clear(recent);
      if (items.length) recent.append(...items);
      else recent.appendChild(h('li', { class: 'muted', text: 'No traces yet. Enable trace.timeTravel in eztest.config.yaml, or debug a journey (debug runs always record one).' }));
    } catch (e) {
      clear(recent).appendChild(h('li', { class: 'bad-text', text: (e as Error).message }));
    }
  })();
}

async function showRun(root: HTMLElement, runId: string, journeyId: string, attempt: number, stepId?: string): Promise<void> {
  clear(root).appendChild(h('p', { class: 'muted page-pad', role: 'status', text: 'Loading trace…' }));
  try {
    const trace = await api.get<TraceFile>(`/api/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(journeyId)}/${attempt}`);
    const v = createTraceViewer({ source: { kind: 'run', runId, journeyId, attempt }, trace, stepId, onOpenFile: openTraceFile });
    clear(root).append(h('h1', { class: 'sr-only', text: `Trace of ${trace.journeyName}` }), v.el);
  } catch (e) {
    clear(root).appendChild(emptyState('Trace not available', (e as Error).message, h('a', { class: 'btn', href: link('trace'), text: 'Back to traces' })));
  }
}

async function showUploaded(root: HTMLElement, id: string): Promise<void> {
  let u = uploadedCache.get(id);
  if (!u) {
    try {
      u = await api.get<Uploaded>(`/api/traces/uploaded/${encodeURIComponent(id)}`);
      uploadedCache.set(id, u);
    } catch (e) {
      clear(root).appendChild(emptyState('Trace not available', `${(e as Error).message}`, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openTraceFile(), text: 'Open trace…' })));
      return;
    }
  }
  const v = createTraceViewer({ source: sourceOfUploaded(u), trace: u.trace, onOpenFile: openTraceFile });
  clear(root).append(h('h1', { class: 'sr-only', text: `Trace ${u.name}` }), v.el);
}

// ------------------------------------------------------------------ run-detail tab

function mountRunTab(el: HTMLElement, d: RunDetail, ctx: { journeyId?: string; stepId?: string }): () => void {
  const host = h('div', { class: 'trace-tab-host' });
  const selId = uid('tj');
  const sel = h('select', { id: selId, class: 'input input-sm' });
  const bar = h('div', { class: 'panel-toolbar trace-tab-bar' }, h('label', { for: selId, class: 'small', text: 'Journey' }), sel, h('span', { class: 'tb-spacer' }), h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openTraceFile() }, kitIcon('upload', { size: 13 }), h('span', { text: 'Open trace…' })));
  el.append(bar, host);
  const browserTraces = browserTraceList(d);
  if (browserTraces) el.append(browserTraces);
  let traces: TraceListItem[] = [];
  const show = async (key: string, stepId?: string) => {
    const t = traces.find((x) => `${x.journeyId}/${x.attempt}` === key);
    if (!t) return;
    clear(host).appendChild(h('p', { class: 'muted', role: 'status', text: 'Loading trace…' }));
    try {
      const trace = await api.get<TraceFile>(`/api/runs/${encodeURIComponent(d.run.runId)}/traces/${encodeURIComponent(t.journeyId)}/${t.attempt}`);
      const v = createTraceViewer({ source: { kind: 'run', runId: d.run.runId, journeyId: t.journeyId, attempt: t.attempt }, trace, stepId, compact: true });
      clear(host).appendChild(v.el);
    } catch (e) {
      clear(host).appendChild(h('p', { class: 'bad-text', text: (e as Error).message }));
    }
  };
  void (async () => {
    try {
      traces = (await api.get<{ traces: TraceListItem[] }>(`/api/runs/${encodeURIComponent(d.run.runId)}/traces`)).traces;
    } catch (e) {
      clear(host).appendChild(h('p', { class: 'bad-text', text: (e as Error).message }));
      return;
    }
    if (!traces.length) {
      bar.hidden = true;
      if (browserTraces) {
        clear(host);
        return;
      }
      clear(host).appendChild(
        emptyState(
          'No time-travel trace for this run',
          'Turn on trace.timeTravel.enabled in eztest.config.yaml (or debug the journey) to record DOM snapshots, network and console for every step.',
          h('button', { type: 'button', class: 'btn', onclick: () => openTraceFile() }, kitIcon('upload'), h('span', { text: 'Open a trace file…' })),
        ),
      );
      return;
    }
    for (const t of traces) sel.appendChild(h('option', { value: `${t.journeyId}/${t.attempt}`, text: `${t.journeyName || t.journeyId}${t.attempt > 1 ? ` (attempt ${t.attempt})` : ''} · ${t.status}` }));
    const want = ctx.journeyId ? [...traces].reverse().find((t) => t.journeyId === ctx.journeyId) : traces.find((t) => t.status === 'failed') ?? traces[0];
    if (want) sel.value = `${want.journeyId}/${want.attempt}`;
    sel.addEventListener('change', () => void show(sel.value));
    await show(sel.value, ctx.stepId);
  })();
  return () => clear(host);
}

// ------------------------------------------------------------------ registration

export function registerTracePage(): void {
  registerPage({
    id: 'trace',
    title: 'Traces',
    icon: 'eye',
    order: 45,
    mount(ctx) {
      ctx.root.classList.add('page-trace');
      let shown = '';
      return {
        show(r: Route) {
          const key = r.rest;
          if (key === shown && ctx.root.firstChild) return;
          shown = key;
          const [kind, a, b, c, stepId] = r.segments;
          if (kind === 'run' && a && b) void showRun(ctx.root, a, b, Number(c) || 1, stepId);
          else if (kind === 'uploaded' && a) void showUploaded(ctx.root, a);
          else landing(ctx.root);
          ctx.root.classList.toggle('page-scroll', !kind);
        },
        focus() {
          ctx.root.querySelector<HTMLElement>('.page-title, .trace-title')?.focus();
        },
      };
    },
  });

  registerRunDetailTab({
    id: 'trace',
    title: 'Trace',
    order: 35,
    when: (d) => d.run.journeys.length > 0,
    mount: (el, d, ctx) => mountRunTab(el, d, ctx),
  });

  const viewerOn = () => !!currentViewer();
  const cmd = (id: string, title: string, keys: string | undefined, when: () => boolean, run: () => void) => {
    registerCommand({ id, title, group: 'Trace', shortcut: keys, when, run });
    if (keys) registerShortcut({ keys, title, group: 'Trace', when, run: () => run() });
  };
  cmd('trace.open', 'Open trace file (bundle or browser trace)…', 'Alt+O', () => true, () => openTraceFile());
  cmd('trace.next', 'Trace: next step', ']', viewerOn, () => currentViewer()?.next(1));
  cmd('trace.prev', 'Trace: previous step', '[', viewerOn, () => currentViewer()?.next(-1));
  cmd('trace.phase', 'Trace: toggle before / after snapshot', 'b', viewerOn, () => currentViewer()?.togglePhase());
  cmd('trace.side', 'Trace: side-by-side snapshots', 's', viewerOn, () => currentViewer()?.toggleSide());
  cmd('trace.pick', 'Trace: pick an element in the snapshot', 'p', viewerOn, () => currentViewer()?.togglePick());
  cmd('trace.compare', 'Trace: compare with another run', 'c', viewerOn, () => currentViewer()?.toggleCompare());
  cmd('trace.page', 'Open the trace viewer', undefined, () => currentRoute.get().page !== 'trace', () => navigate(link('trace')));
}
