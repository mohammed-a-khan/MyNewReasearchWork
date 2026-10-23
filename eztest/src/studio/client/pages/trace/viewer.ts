/**
 * The time-travel trace viewer: a filmstrip of viewport captures with
 * per-step duration bars (locate / act / verify / heal, coloured by status,
 * hover preview, click or arrow keys), a virtualized step list, the DOM
 * snapshot viewer, the step tabs, run comparison and bundle export. Used by
 * the Trace page and the run-detail "Trace" tab.
 */
import { api } from '../../core/api.js';
import { add, announce, clear, h, uid } from '../../core/dom.js';
import { dateTime, ms } from '../../core/format.js';
import type { RunDetail } from '../../core/registry.js';
import { link } from '../../core/router.js';
import { badge, statusIcon } from '../../ui/badge.js';
import { createSplit } from '../../ui/split.js';
import { createTable, type TableHandle } from '../../ui/table.js';
import { kitIcon, toolButton } from '../debug/kit.js';
import { createCompareView } from './compare.js';
import { createStepTabs } from './details.js';
import { nestLabel, nestingOf, type Nest, type ResultNode } from './nesting.js';
import { PHASES, assetUrl, bundleUrl, type TraceFile, type TraceSource, type TraceStep } from './model.js';
import { createSnapshotViewer } from './snapshot.js';

export interface TraceViewer {
  el: HTMLElement;
  select(pos: number, focus?: boolean): void;
  next(delta: number): void;
  togglePhase(): void;
  toggleSide(): void;
  togglePick(): void;
  toggleCompare(on?: boolean): void;
  readonly visible: boolean;
}

/** The viewer that keyboard shortcuts act on (the last one shown). */
let activeViewer: TraceViewer | undefined;
export const currentViewer = () => (activeViewer?.visible ? activeViewer : undefined);

export function createTraceViewer(o: { source: TraceSource; trace: TraceFile; stepId?: string; compact?: boolean; onOpenFile?(): void; onSelect?(step: TraceStep): void }): TraceViewer {
  const { trace, source } = o;
  const steps = trace.steps;
  let pos = Math.max(0, o.stepId ? lastPos(trace, o.stepId) : firstInteresting(trace));
  let runDetail: Promise<RunDetail | undefined> | undefined;
  let nest = new Map<number, Nest>();
  const getRunDetail = () => (runDetail ??= source.kind === 'run' ? api.get<RunDetail>(`/api/runs/${encodeURIComponent(source.runId)}`).catch(() => undefined) : Promise.resolve(undefined));

  // ---------------------------------------------------------- header
  const titleId = uid('trace-title');
  const compareBtn = source.kind === 'run' ? toolButton('Compare runs', 'compare', () => toggleCompare(), { kind: 'compare', pressed: false, shortcut: 'C', text: true }) : null;
  const bundle = bundleUrl(source);
  const exportLink = bundle ? h('a', { class: 'btn btn-sm trace-export', href: bundle, download: `${trace.journeyId}-${trace.attempt}.eztrace.zip` }, kitIcon('download', { size: 14 }), h('span', { text: 'Export bundle' })) : null;
  const openBtn = o.onOpenFile ? h('button', { type: 'button', class: 'btn btn-sm trace-open', title: 'Open a trace bundle (Alt+O)', onclick: () => o.onOpenFile!() }, kitIcon('upload', { size: 14 }), h('span', { text: 'Open trace…' })) : null;
  const fullLink = o.compact && source.kind === 'run' ? h('a', { class: 'btn btn-sm', href: link('trace', 'run', source.runId, trace.journeyId, String(trace.attempt)) }, kitIcon('external', { size: 14 }), h('span', { text: 'Full screen' })) : null;
  const integrity =
    source.kind === 'uploaded'
      ? source.verified
        ? badge('ok', 'Integrity verified')
        : badge('bad', `${source.problems.length} integrity problem${source.problems.length === 1 ? '' : 's'}`)
      : null;
  const header = h(
    'header',
    { class: 'trace-head' },
    h(
      'div',
      { class: 'trace-title-wrap' },
      h('h2', { class: 'trace-title', id: titleId, tabindex: '-1' }, kitIcon('film'), h('span', { text: trace.journeyName || trace.journeyId })),
      h(
        'p',
        { class: 'trace-meta' },
        badge(trace.status),
        h('span', { text: ` ${source.kind === 'run' ? trace.runId : source.name} · attempt ${trace.attempt} · ${trace.browser} · ${ms(trace.durationMs)} · ${steps.length} steps · ${dateTime(trace.startedAt)}` }),
        integrity ? [' ', integrity] : null,
      ),
    ),
    h('div', { class: 'trace-actions' }, compareBtn, exportLink, openBtn, fullLink),
  );
  const problems = source.kind === 'uploaded' && (source.problems.length || source.warnings.length)
    ? h('div', { class: 'callout callout-warn', role: 'alert' }, kitIcon('shield', { size: 18 }), h('div', null, h('p', { class: 'callout-title', text: source.problems.length ? 'This bundle was altered or is incomplete' : 'Import notes' }), h('ul', { class: 'bullets small' }, [...source.problems, ...source.warnings].slice(0, 12).map((p) => h('li', { text: p })))))
    : null;

  // ---------------------------------------------------------- filmstrip
  const film = h('ol', { class: 'filmstrip', role: 'listbox', 'aria-label': 'Filmstrip: one frame per step (arrow keys move)', tabindex: '0', 'aria-orientation': 'horizontal' });
  const preview = h('div', { class: 'film-preview', hidden: true, 'aria-hidden': 'true' });
  const maxDur = Math.max(1, ...steps.map((s) => s.durationMs));
  const optId = (i: number) => `${titleId}-f${i}`;
  steps.forEach((s, i) => {
    const total = Math.max(1, s.durationMs);
    const bar = h('span', { class: 'film-bar', 'aria-hidden': 'true' });
    bar.style.width = `${Math.max(8, (s.durationMs / maxDur) * 100)}%`;
    for (const p of PHASES) {
      const v = s.timings[p.key];
      if (!v) continue;
      const seg = h('span', { class: ['phase-seg', p.cls] });
      seg.style.width = `${(v / total) * 100}%`;
      bar.appendChild(seg);
    }
    const jpeg = s.screenshot?.viewportJpeg;
    const label = `Step ${i + 1}: ${s.intent}, ${s.status}, ${ms(s.durationMs)}${s.heal?.record ? ', healed' : ''}`;
    const item = h(
      'li',
      { class: ['film-item', `st-${s.status}`], id: optId(i), role: 'option', 'aria-selected': 'false', dataset: { pos: i } },
      h('span', { class: 'sr-only film-label', text: label }),
      h('span', { class: 'film-thumb', 'aria-hidden': 'true' }, jpeg ? h('img', { src: assetUrl(source, jpeg), alt: '', loading: 'lazy', draggable: 'false' }) : h('span', { class: 'film-empty', text: s.action })),
      h('span', { class: 'film-cap', 'aria-hidden': 'true' }, h('span', { class: 'film-num', text: String(i + 1) }), statusIcon(s.status), s.heal?.record ? kitIcon('shield', { size: 12, class: 'heal-ico' }) : null, h('span', { class: 'film-dur', text: ms(s.durationMs) })),
      bar,
    );
    item.addEventListener('click', () => select(i, false));
    item.addEventListener('mouseenter', () => showPreview(i, item));
    item.addEventListener('mouseleave', () => (preview.hidden = true));
    film.appendChild(item);
  });
  film.addEventListener('keydown', (e) => {
    let n = pos;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n++;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n--;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = steps.length - 1;
    else return;
    e.preventDefault();
    select(Math.max(0, Math.min(steps.length - 1, n)), false);
  });
  const showPreview = (i: number, item: HTMLElement) => {
    const s = steps[i];
    const jpeg = s.screenshot?.viewportJpeg;
    add(
      clear(preview),
      jpeg ? h('img', { src: assetUrl(source, jpeg), alt: '' }) : null,
      h('p', { class: 'film-preview-cap' }, h('strong', { text: `${i + 1}. ` }), s.intent),
      h('p', { class: 'muted small', text: PHASES.filter((p) => s.timings[p.key]).map((p) => `${p.label} ${ms(s.timings[p.key])}`).join(' · ') || ms(s.durationMs) }),
    );
    const r = item.getBoundingClientRect();
    const host = filmWrap.getBoundingClientRect();
    preview.style.left = `${Math.max(0, Math.min(host.width - 340, r.left - host.left + r.width / 2 - 170))}px`;
    preview.hidden = false;
  };
  const filmWrap = h('div', { class: 'film-wrap' }, film, preview);

  // ---------------------------------------------------------- step list
  type Row = TraceStep & { pos: number };
  const list: TableHandle<Row> = createTable<Row>({
    label: 'Trace steps',
    key: (r) => String(r.pos),
    rowHeight: 32,
    rows: steps.map((s, i) => ({ ...s, pos: i })),
    class: 'trace-steps',
    columns: [
      { id: 'n', title: '#', width: '2.4rem', value: (r) => r.pos + 1 },
      { id: 'status', title: 'Status', width: '2.6rem', srOnlyTitle: true, value: (r) => r.status, render: (r) => statusIcon(r.status) },
      {
        id: 'intent',
        title: 'Step',
        width: 'minmax(8rem, 1fr)',
        value: (r) => r.intent,
        render: (r) => {
          const n = nest.get(r.pos);
          const span = h('span', { class: ['ts-intent', n && 'nested'], title: n ? `${r.intent} (${nestLabel(n)})` : r.intent }, n ? h('span', { class: 'ts-nest' }, h('span', { 'aria-hidden': 'true', text: '↳' }), h('span', { class: 'sr-only', text: nestLabel(n) })) : null, n?.iteration !== undefined ? h('span', { class: 'pill pill-run', title: nestLabel(n), text: `#${n.iteration}` }) : null, r.heal?.record ? h('span', { class: 'pill pill-heal', text: r.heal.record.tier.split('-')[0] }) : null, r.execution > 1 ? h('span', { class: 'pill pill-warn', text: `run ${r.execution}` }) : null, h('span', { text: r.intent }));
          if (n) span.style.paddingLeft = `${Math.min(4, n.depth) * 12}px`;
          return span;
        },
      },
      { id: 'time', title: 'Time', width: '4.4rem', align: 'end', value: (r) => r.durationMs, render: (r) => ms(r.durationMs) },
    ],
    onSelect: (r) => select(r.pos, false),
    empty: 'This trace has no steps.',
  });
  const stepPane = h('aside', { class: 'trace-steplist', 'aria-label': 'Steps' }, h('div', { class: 'table-frame grow' }, list.el));

  // ---------------------------------------------------------- snapshot + tabs
  const snap = createSnapshotViewer();
  const tabs = createStepTabs({ source, trace, runDetail: getRunDetail, nestOf: (st) => nest.get(steps.indexOf(st)) });
  // Block nesting (If branches, loop iterations, sub-journeys) from the run's result tree.
  void getRunDetail().then((d) => {
    const j = d?.run.journeys.find((x) => x.journeyId === trace.journeyId && x.attempt === trace.attempt) ?? d?.run.journeys.find((x) => x.journeyId === trace.journeyId);
    nest = nestingOf(trace, j?.steps as ResultNode[] | undefined);
    if (!nest.size) return;
    list.setRows(steps.map((st, i) => ({ ...st, pos: i })));
    list.select(String(pos), { scroll: false });
    for (const [p, n] of nest) {
      const item = film.children[p] as HTMLElement | undefined;
      if (!item) continue;
      item.classList.add('nested');
      const lbl = item.querySelector('.film-label');
      if (lbl) lbl.textContent = `${lbl.textContent}, ${nestLabel(n)}`;
      item.querySelector('.film-cap')?.insertBefore(h('span', { class: 'film-nest', title: nestLabel(n), text: n.iteration !== undefined ? `↳#${n.iteration}` : '↳' }), item.querySelector('.film-cap .status-icon'));
    }
    tabs.show(steps[pos]);
  });
  const right = o.compact
    ? createSplit({ direction: 'column', first: snap.el, second: tabs.el, size: 280, min: 140, sizeSecond: true, storageKey: 'trace-tabs-compact', label: 'Resize step details' })
    : createSplit({ direction: 'row', first: snap.el, second: tabs.el, size: 420, min: 280, max: 900, sizeSecond: true, storageKey: 'trace-tabs', label: 'Resize step details' });
  const inspect = createSplit({ direction: 'row', first: stepPane, second: right.el, size: o.compact ? 260 : 340, min: 180, max: 520, storageKey: 'trace-steps', label: 'Resize step list' });
  inspect.el.classList.add('trace-main');
  const compareHost = h('div', { class: 'trace-compare', hidden: true });
  let compare: ReturnType<typeof createCompareView> | undefined;

  const el = h('section', { class: ['trace-viewer', o.compact && 'compact'], 'aria-labelledby': titleId }, header, problems, filmWrap, inspect.el, compareHost);

  function select(i: number, focus = false): void {
    if (!steps.length) {
      snap.show(source, undefined, 0);
      tabs.show(undefined);
      return;
    }
    pos = Math.max(0, Math.min(steps.length - 1, i));
    const s = steps[pos];
    for (const item of film.children) item.setAttribute('aria-selected', String((item as HTMLElement).dataset.pos === String(pos)));
    film.setAttribute('aria-activedescendant', optId(pos));
    (film.children[pos] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    list.select(String(pos), { focus });
    snap.show(source, s, pos);
    tabs.show(s);
    el.dataset.pos = String(pos);
    o.onSelect?.(s);
    announce(`Step ${pos + 1} of ${steps.length}: ${s.intent}, ${s.status}`);
  }

  function toggleCompare(on?: boolean): void {
    if (source.kind !== 'run' || !compareBtn) return;
    const show = on ?? compareHost.hidden;
    compareHost.hidden = !show;
    inspect.el.hidden = show;
    compareBtn.setAttribute('aria-pressed', String(show));
    if (show && !compare) {
      compare = createCompareView({
        source,
        trace,
        onJump: (stepId) => {
          toggleCompare(false);
          select(lastPos(trace, stepId), true);
        },
      });
      compareHost.appendChild(compare.el);
      void compare.load();
    }
  }

  const viewer: TraceViewer = {
    el,
    select,
    next: (d) => select(pos + d, false),
    togglePhase: () => snap.togglePhase(),
    toggleSide: () => snap.toggleSide(),
    togglePick: () => snap.togglePick(),
    toggleCompare,
    get visible() {
      return el.isConnected && el.offsetParent !== null;
    },
  };
  el.addEventListener('focusin', () => (activeViewer = viewer));
  el.addEventListener('mousedown', () => (activeViewer = viewer));
  activeViewer = viewer;
  requestAnimationFrame(() => select(pos));
  return viewer;
}

function lastPos(t: TraceFile, stepId: string): number {
  let best = -1;
  t.steps.forEach((s, i) => {
    if (s.stepId === stepId && (best < 0 || s.execution >= t.steps[best].execution)) best = i;
  });
  return best;
}

/** Open on the first failed or healed step, else the first. */
function firstInteresting(t: TraceFile): number {
  const f = t.steps.findIndex((s) => s.status === 'failed');
  if (f >= 0) return f;
  const hl = t.steps.findIndex((s) => s.status === 'passed-healed');
  return hl >= 0 ? hl : 0;
}
