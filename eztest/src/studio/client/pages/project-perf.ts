/** Project › Performance: Web Vitals per step with budgets and violations, and network timings. Load tests live in the Performance workspace (pages/load.ts). */
import { api } from '../core/api.js';
import { clear, h } from '../core/dom.js';
import { ms } from '../core/format.js';
import { link, navigate } from '../core/router.js';
import { card, emptyState } from '../ui/badge.js';
import { toastError } from '../ui/toast.js';
import { dataTable, pageHeader, runPicker, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

interface PerfStep {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  status: string;
  durationMs: number;
  vitals?: { LCP: number | null; CLS: number; INP: number | null; FCP: number | null; TTFB: number | null };
  budget?: { status: string; items: Array<{ metric: string; status: string; value?: number; warn?: number; error?: number }> };
  network: { requests: number; failed: number; p50: number | null; p95: number | null; max: number | null; slowest: Array<{ method: string; url: string; status: number; ms?: number }> };
}

interface PerfView {
  runId: string;
  budgetsSource: string;
  budgetsError?: string;
  steps: PerfStep[];
  api?: { status: string; items: Array<{ metric: string; status: string; value?: number; warn?: number; error?: number; samples?: number }> };
  violations: Array<{ metric: string; status: string; value?: number; warn?: number; error?: number; intent: string }>;
  hasVitals: boolean;
  requests: number;
}

function vital(s: PerfStep, k: 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB'): HTMLElement {
  const v = s.vitals?.[k];
  if (v === undefined || v === null) return h('span', { class: 'muted', text: '–' });
  const item = s.budget?.items.find((i) => i.metric === k);
  const text = k === 'CLS' ? v.toFixed(3) : `${Math.round(v)} ms`;
  return item && item.status !== 'pass' ? sevBadge(item.status === 'fail' ? 'fail' : 'warn', text) : h('span', { text });
}

async function mountPerfRun(el: HTMLElement, runId: string): Promise<void> {
  const v = await withStates(el, () => api.get<PerfView>(`/api/project/perf/runs/${encodeURIComponent(runId)}`), { retry: () => void mountPerfRun(el, runId) });
  if (!v) return;
  el.append(
    v.budgetsError ? h('p', { class: 'note note-warn', text: v.budgetsError }) : h('span'),
    h('p', { class: 'muted', text: `Budgets: ${v.budgetsSource}. ${v.hasVitals ? '' : 'This run has no Web Vitals: add the "perf" lens (lenses: [perf]) to measure LCP, CLS, INP, FCP and TTFB after every step.'}` }),
    v.violations.length
      ? card(`Budget violations (${v.violations.length})`, dataTable({ caption: 'Budget violations', rows: v.violations, columns: [{ title: 'Step', render: (x) => x.intent }, { title: 'Metric', render: (x) => x.metric }, { title: 'Value', render: (x) => (x.value === undefined ? '' : x.metric === 'CLS' ? x.value.toFixed(3) : `${Math.round(x.value)} ms`) }, { title: 'Budget', render: (x) => `warn ${x.warn ?? '–'} / fail ${x.error ?? '–'}` }, { title: 'Status', render: (x) => sevBadge(x.status) }] }))
      : v.hasVitals ? h('p', null, sevBadge('pass', 'Every step is within its Web Vitals budget')) : h('span'),
    card('Per step', dataTable<PerfStep>({
      caption: 'Web Vitals and network per step',
      rows: v.steps,
      columns: [
        { title: 'Step', render: (s) => h('div', null, h('strong', { text: s.intent }), h('div', { class: 'small muted', text: `${s.journeyName} · ${ms(s.durationMs)}` })) },
        { title: 'LCP', render: (s) => vital(s, 'LCP') },
        { title: 'CLS', render: (s) => vital(s, 'CLS') },
        { title: 'INP', render: (s) => vital(s, 'INP') },
        { title: 'FCP', render: (s) => vital(s, 'FCP') },
        { title: 'TTFB', render: (s) => vital(s, 'TTFB') },
        { title: 'Requests', class: 'num', render: (s) => `${s.network.requests}${s.network.failed ? ` (${s.network.failed} failed)` : ''}` },
        { title: 'p95', class: 'num', render: (s) => (s.network.p95 === null ? '–' : `${Math.round(s.network.p95)} ms`) },
      ],
    })),
    v.api ? card('API budgets', dataTable({ caption: 'API budgets', rows: v.api.items, columns: [{ title: 'Metric', render: (i) => i.metric }, { title: 'Value', render: (i) => (i.value === undefined ? '–' : String(Math.round(i.value * 100) / 100)) }, { title: 'Samples', render: (i) => String(i.samples ?? '') }, { title: 'Status', render: (i) => sevBadge(i.status) }] })) : h('span'),
    card('Load testing', h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Turn this run\'s captured traffic into a correlated load test (Correlation assistant), then design, run and analyse it.' }), h('div', null, h('a', { class: 'btn', href: link('load', 'correlation'), text: 'Open the Performance workspace' })))),
  );
}

export const perfSection: SubPageDef = {
  id: 'perf',
  title: 'Performance',
  icon: 'gauge',
  description: 'Web Vitals, budgets, network timings',
  mount(root) {
    const body = h('div', { class: 'stack' });
    const picker = runPicker({ label: 'Run', onChange: (id) => navigate(link('project', 'perf', id)) });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Performance', 'Web Vitals per step against budgets and the network timings each step captured.', picker.el), body));
    return {
      show: async (segs) => {
        const runId = await picker.set(segs[0]).catch((e: Error) => (toastError(e.message), undefined));
        if (!runId) {
          clear(body).appendChild(emptyState('No runs yet', 'Run a journey (with the "perf" lens for Web Vitals) to see its performance here.'));
          return;
        }
        clear(body);
        await mountPerfRun(body, runId);
      },
    };
  },
};
