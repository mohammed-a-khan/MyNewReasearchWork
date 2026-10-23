/**
 * Compare runs: another trace of the same journey (by default the last
 * passing one) against this one, step by step, from `diffTraces`: the first
 * divergence, timing deltas, locator changes, a word diff of the target
 * region, URL, condition and network differences, and the diverging step's
 * snapshots side by side.
 */
import { api } from '../../core/api.js';
import { add, announce, clear, h, uid } from '../../core/dom.js';
import { ms, relTime } from '../../core/format.js';
import { link } from '../../core/router.js';
import { badge, statusIcon } from '../../ui/badge.js';
import { createTable } from '../../ui/table.js';
import { kitIcon, section } from '../debug/kit.js';
import { snapshotFrame } from './snapshot.js';
import { snapshotUrl, type TraceFile, type TraceSource } from './model.js';

interface StepDiff {
  stepId: string;
  intent: string;
  index: { a?: number; b?: number };
  presence: 'both' | 'only-a' | 'only-b';
  status: { a?: string; b?: string; changed: boolean };
  locator: { a?: string; b?: string; changed: boolean; healTier?: { a?: string; b?: string } };
  timing: { a?: number; b?: number; deltaMs?: number; phases: { locateMs?: number; actMs?: number; verifyMs?: number } };
  url: { a?: string; b?: string; changed: boolean };
  conditions: Array<{ text: string; a?: boolean; b?: boolean }>;
  text: { changed: boolean; removed: string[]; added: string[] };
  network: { added: string[]; removed: string[]; statusChanged: Array<{ request: string; a?: number; b?: number }> };
  reasons: string[];
}

interface TraceDiff {
  journeyId: string;
  a: { runId: string; attempt: number; status: string };
  b: { runId: string; attempt: number; status: string };
  steps: StepDiff[];
  summary: { changedSteps: number; firstDivergence?: { stepId: string; reasons: string[] }; statusChanges: string[]; locatorChanges: string[]; slower: string[]; totalDeltaMs: number };
}

interface RunOption {
  runId: string;
  attempt: number;
  status: string;
  startedAt?: string;
  durationMs: number;
}

export interface CompareView {
  el: HTMLElement;
  load(): Promise<void>;
}

const signed = (n: number | undefined) => (n === undefined ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${ms(Math.abs(n)) || '0 ms'}`);

export function createCompareView(o: { source: Extract<TraceSource, { kind: 'run' }>; trace: TraceFile; onJump(stepId: string): void }): CompareView {
  const selId = uid('cmp');
  const sel = h('select', { id: selId, class: 'input input-sm' });
  const status = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  const callout = h('div', { class: 'cmp-callout' });
  const stats = h('div', { class: 'stats cmp-stats' });
  const detail = h('div', { class: 'cmp-detail' });
  const tableHost = h('div', { class: 'table-frame cmp-frame' });
  const el = h(
    'section',
    { class: 'compare', 'aria-label': 'Compare runs' },
    h('div', { class: 'panel-toolbar' }, kitIcon('compare'), h('label', { for: selId, class: 'small', text: 'Compare this run with' }), sel, status),
    callout,
    stats,
    tableHost,
    detail,
  );
  let other: TraceFile | undefined;
  let diff: TraceDiff | undefined;
  let options: RunOption[] = [];

  const keyOf = (r: RunOption) => `${r.runId}/${o.trace.journeyId}/${r.attempt}`;

  async function load(): Promise<void> {
    status.textContent = 'Looking for other runs of this journey…';
    try {
      const r = await api.get<{ runs: RunOption[] }>(`/api/traces/journey/${encodeURIComponent(o.trace.journeyId)}`);
      options = r.runs.filter((x) => !(x.runId === o.source.runId && x.attempt === o.source.attempt));
    } catch (e) {
      status.textContent = `Cannot list runs: ${(e as Error).message}`;
      return;
    }
    clear(sel);
    if (!options.length) {
      status.textContent = 'No other run of this journey has a trace yet.';
      clear(callout).appendChild(h('p', { class: 'panel-empty', text: 'Run this journey again with time-travel tracing to compare.' }));
      return;
    }
    const lastPassing = options.find((x) => x.status === 'passed') ?? options.find((x) => x.status === 'passed-healed') ?? options[0];
    for (const r of options) {
      sel.appendChild(h('option', { value: keyOf(r), text: `${r === lastPassing && r.status.startsWith('passed') ? 'Last passing · ' : ''}${r.runId}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''} · ${r.status} · ${relTime(r.startedAt)}`, selected: r === lastPassing }));
    }
    sel.onchange = () => void compare(sel.value);
    await compare(keyOf(lastPassing));
  }

  async function compare(aRef: string): Promise<void> {
    const bRef = `${o.source.runId}/${o.trace.journeyId}/${o.source.attempt}`;
    status.textContent = 'Comparing…';
    try {
      const [runId, journeyId, attempt] = aRef.split('/');
      [diff, other] = await Promise.all([
        api.get<TraceDiff>(`/api/traces/diff?a=${encodeURIComponent(aRef)}&b=${encodeURIComponent(bRef)}`),
        api.get<TraceFile>(`/api/runs/${encodeURIComponent(runId)}/traces/${encodeURIComponent(journeyId)}/${attempt}`),
      ]);
    } catch (e) {
      status.textContent = `Cannot compare: ${(e as Error).message}`;
      return;
    }
    status.textContent = '';
    render();
  }

  function render(): void {
    if (!diff) return;
    const d = diff;
    const first = d.summary.firstDivergence;
    const firstStep = first ? d.steps.find((s) => s.stepId === first.stepId) : undefined;
    clear(callout).appendChild(
      first && firstStep
        ? h(
            'div',
            { class: 'callout callout-diverge', role: 'note' },
            kitIcon('compare', { size: 18 }),
            h(
              'div',
              null,
              h('p', { class: 'callout-title' }, h('strong', { text: `First divergence at step ${(firstStep.index.b ?? firstStep.index.a ?? 0) + 1}: ` }), h('span', { text: firstStep.intent })),
              h('ul', { class: 'chips' }, first.reasons.map((r) => h('li', { class: 'chip', text: r }))),
              h('p', { class: 'muted small' }, 'A: ', h('a', { href: link('runs', d.a.runId), text: d.a.runId }), ` (${d.a.status}) · B (this run): ${d.b.runId} (${d.b.status})`),
            ),
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => o.onJump(firstStep.stepId) }, h('span', { text: 'Show this step' })),
          )
        : h('div', { class: 'callout callout-same', role: 'note' }, kitIcon('check', { size: 18 }), h('p', null, h('strong', { text: 'No divergence: ' }), `same steps, statuses, locators, URLs and network as ${d.a.runId}.`)),
    );
    clear(stats).append(
      h('div', { class: 'stat' }, h('strong', { class: 'stat-value', text: String(d.summary.changedSteps) }), h('span', { class: 'stat-caption', text: 'changed steps' })),
      h('div', { class: 'stat' }, h('strong', { class: 'stat-value', text: signed(d.summary.totalDeltaMs) }), h('span', { class: 'stat-caption', text: 'total time' })),
      h('div', { class: 'stat' }, h('strong', { class: 'stat-value', text: String(d.summary.locatorChanges.length) }), h('span', { class: 'stat-caption', text: 'locator changes' })),
      h('div', { class: 'stat' }, h('strong', { class: 'stat-value', text: String(d.summary.slower.length) }), h('span', { class: 'stat-caption', text: 'much slower' })),
    );
    const maxDelta = Math.max(1, ...d.steps.map((s) => Math.abs(s.timing.deltaMs ?? 0)));
    const table = createTable<StepDiff>({
      label: 'Steps compared, A (other run) versus B (this run)',
      key: (r) => r.stepId,
      rowHeight: 34,
      rows: d.steps,
      rowClass: (r) => (r.reasons.length ? 'cmp-changed' : undefined),
      columns: [
        { id: 'n', title: '#', width: '2.6rem', value: (r) => (r.index.b ?? r.index.a ?? 0) + 1 },
        { id: 'intent', title: 'Step', width: 'minmax(10rem, 2fr)', value: (r) => r.intent, render: (r) => h('span', { title: r.intent, text: r.intent }) },
        { id: 'status', title: 'Status A → B', width: '7rem', value: (r) => `${r.status.a}>${r.status.b}`, render: (r) => h('span', { class: 'cmp-status' }, r.status.a ? statusIcon(r.status.a) : h('span', { class: 'muted', text: '–' }), h('span', { 'aria-hidden': 'true', text: '→' }), r.status.b ? statusIcon(r.status.b) : h('span', { class: 'muted', text: '–' })) },
        {
          id: 'delta',
          title: 'Δ time',
          width: '8rem',
          align: 'end',
          value: (r) => r.timing.deltaMs,
          render: (r) => {
            const v = r.timing.deltaMs ?? 0;
            const bar = h('span', { class: ['delta-bar', v > 0 ? 'slower' : 'faster'] });
            bar.style.width = `${(Math.abs(v) / maxDelta) * 100}%`;
            return h('span', { class: 'delta-cell' }, h('span', { class: 'delta-track', 'aria-hidden': 'true' }, bar), h('span', { class: v > 250 ? 'bad-text' : '', text: signed(r.timing.deltaMs) }));
          },
        },
        { id: 'why', title: 'Differences', width: 'minmax(8rem, 2fr)', value: (r) => r.reasons.join(', '), render: (r) => (r.reasons.length ? h('span', { class: 'cmp-reasons', text: r.reasons.join(' · ') }) : h('span', { class: 'muted', text: 'same' })) },
      ],
      onSelect: (r) => showStep(r),
      empty: 'No steps',
    });
    clear(tableHost).appendChild(table.el);
    if (firstStep) {
      table.select(firstStep.stepId);
      showStep(firstStep);
    } else clear(detail);
    announce(first ? `First divergence at step ${(firstStep?.index.b ?? 0) + 1}` : 'No divergence');
  }

  function posOf(t: TraceFile | undefined, stepId: string): number {
    if (!t) return -1;
    let best = -1;
    t.steps.forEach((s, i) => {
      if (s.stepId === stepId && (best < 0 || s.execution >= t.steps[best].execution)) best = i;
    });
    return best;
  }

  function showStep(s: StepDiff): void {
    clear(detail);
    const pa = posOf(other, s.stepId);
    const pb = posOf(o.trace, s.stepId);
    const sa = pa >= 0 ? other!.steps[pa] : undefined;
    const sb = pb >= 0 ? o.trace.steps[pb] : undefined;
    const aSource: TraceSource | undefined = diff ? { kind: 'run', runId: diff.a.runId, journeyId: o.trace.journeyId, attempt: diff.a.attempt } : undefined;
    const phase = (st?: { snapshots: { before?: unknown; after?: unknown }; status: string }) => (st?.status === 'failed' || !st?.snapshots.after ? 'before' : 'after');
    const snapCol = (title: string, src: TraceSource | undefined, st: typeof sa, pos: number) => {
      const col = h('div', { class: 'snap-pane' }, h('p', { class: 'snap-label', text: title }));
      const frame = h('div', { class: 'snap-frame' });
      col.appendChild(frame);
      const ph = phase(st);
      const ref = st?.snapshots[ph];
      if (!src || !st || !ref) frame.appendChild(h('p', { class: 'panel-empty', text: 'No snapshot' }));
      else requestAnimationFrame(() => frame.appendChild(snapshotFrame(snapshotUrl(src, pos, ph), ref, `${title}: ${st.intent} (${ph})`, { zoom: 'fit', viewport: 'recorded', host: frame })));
      return col;
    };
    add(
      detail,
      h('h3', { class: 'kit-h', text: `Step ${(s.index.b ?? s.index.a ?? 0) + 1}: ${s.intent}` }),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: 'Status' }),
        h('dd', null, s.status.a ? badge(s.status.a) : '–', ' → ', s.status.b ? badge(s.status.b) : '–'),
        h('dt', { text: 'Locator' }),
        h('dd', { class: s.locator.changed ? 'cmp-locator changed' : 'cmp-locator' }, h('code', { text: s.locator.a ?? 'none' }), s.locator.changed ? [' → ', h('code', { text: s.locator.b ?? 'none' })] : null, s.locator.healTier ? h('span', { class: 'chip', text: `heal ${s.locator.healTier.a ?? '–'} → ${s.locator.healTier.b ?? '–'}` }) : null),
        h('dt', { text: 'Timing' }),
        h('dd', { text: `${ms(s.timing.a) || '–'} → ${ms(s.timing.b) || '–'} (${signed(s.timing.deltaMs)}; locate ${signed(s.timing.phases.locateMs)}, act ${signed(s.timing.phases.actMs)}, verify ${signed(s.timing.phases.verifyMs)})` }),
        s.url.changed ? [h('dt', { text: 'URL after' }), h('dd', { class: 'mono small', text: `${s.url.a ?? '–'} → ${s.url.b ?? '–'}` })] : null,
      ),
      s.text.changed
        ? section(
            'Target region text',
            h('div', { class: 'text-diff' }, s.text.removed.map((t) => h('del', { text: t })), s.text.added.map((t) => h('ins', { text: t }))),
          )
        : null,
      s.conditions.length ? section('Conditions that changed', h('ul', { class: 'bullets' }, s.conditions.map((c) => h('li', { text: `${c.text}: ${c.a === undefined ? '–' : c.a ? 'passed' : 'failed'} → ${c.b === undefined ? '–' : c.b ? 'passed' : 'failed'}` })))) : null,
      s.network.added.length || s.network.removed.length || s.network.statusChanged.length
        ? section(
            'Network differences',
            h(
              'ul',
              { class: 'bullets mono small' },
              s.network.added.map((n) => h('li', { class: 'ok-text', text: `+ ${n}` })),
              s.network.removed.map((n) => h('li', { class: 'bad-text', text: `− ${n}` })),
              s.network.statusChanged.map((n) => h('li', { class: 'warn-text', text: `~ ${n.request}: ${n.a ?? '–'} → ${n.b ?? '–'}` })),
            ),
          )
        : null,
      section('Snapshots side by side', h('div', { class: 'snap-panes side cmp-snaps' }, snapCol(`A · ${diff?.a.runId ?? ''}`, aSource, sa, pa), snapCol('B · this run', o.source, sb, pb))),
    );
  }

  return { el, load };
}
