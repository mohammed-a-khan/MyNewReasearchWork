/** Project › Monitors: @monitor journeys, health, uptime and latency charts, status page, and the monitor loop started from the Studio. */
import { api } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { onTopic } from '../core/events.js';
import { dateTime, relTime } from '../core/format.js';
import { badge, button, card, emptyState, stat } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable, field, lineChart, pageHeader, sevBadge, statusStrip, withStates, type SubPageDef } from './assurance-ui.js';

interface MonitorView {
  journeys: Array<{ id: string; name: string; tags: string[]; steps: number; writes: Array<{ stepId?: string; reason: string }> }>;
  error?: string;
  summary?: {
    overall: string;
    counts: Record<string, number>;
    journeys: Array<{ journeyId: string; name: string; health: string; uptimePct: number | null; p50Ms: number | null; p95Ms: number | null; consecutiveFailures: number; lastRunAt?: string; failingStep?: string }>;
    runs: number;
    ticks: number;
    updatedAt: string;
    lastRunError?: string;
    recentAlerts: Array<{ at: string; journeyId: string; kind: string }>;
  };
  durations: Record<string, number[]>;
  history: Array<{ at: string; journeyId: string; status: string; durationMs: number }>;
  loop: { running: boolean; startedAt?: string; intervalMs?: number; ticks?: number; runs?: number; lastEvent?: string; lastError?: string; journeys?: string[] };
}

export const monitorsSection: SubPageDef = {
  id: 'monitors',
  title: 'Monitors',
  icon: 'pulse',
  description: '@monitor journeys, uptime, latency',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Monitors', 'Journeys tagged @monitor run on a schedule against a live environment: health, uptime and latency per journey, and the status page.', button('Open status page', { icon: 'external', onclick: () => window.open('/api/project/monitors/status-page', '_blank', 'noopener') })), body));
    let visible = false;
    onTopic('monitor', () => {
      if (visible) void load();
    });
    const load = async () => {
      const v = await withStates(body, () => api.get<MonitorView>('/api/project/monitors'), { retry: () => void load() });
      if (!v) return;
      const interval = h('input', { class: 'input', type: 'number', min: '5', value: '300' });
      const iterations = h('input', { class: 'input', type: 'number', min: '1', placeholder: 'until stopped' });
      const writesId = uid('w');
      const writes = h('input', { type: 'checkbox', id: writesId });
      const unsafe = v.journeys.filter((j) => j.writes.length);
      const start = async () => {
        if (!(await confirmDialog({ title: 'Start monitoring?', message: `Run ${v.journeys.length} @monitor journey(s) every ${interval.value} s against the active environment${writes.checked ? ', including journeys that write data' : ''}.`, confirm: 'Start' }))) return;
        try {
          await api.post('/api/project/monitors/start', { intervalSec: Number(interval.value), iterations: iterations.value || undefined, allowWrites: writes.checked });
          toast('Monitor loop started', { kind: 'success' });
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      };
      const stop = async () => {
        try {
          await api.post('/api/project/monitors/stop', {});
          toast('Stopping after the current run');
          await load();
        } catch (e) {
          toastError((e as Error).message);
        }
      };
      const loop = v.loop;
      const s = v.summary;
      body.append(
        v.error ? h('p', { class: 'note note-bad', text: v.error }) : h('span'),
        card('Monitor loop', h('div', { class: 'stack' },
          loop.running
            ? h('div', { class: 'stack-sm' }, h('p', { class: 'row wrap' }, badge('running', 'Running'), h('span', { class: 'muted', text: `every ${Math.round((loop.intervalMs ?? 0) / 1000)} s since ${relTime(loop.startedAt)} · ${loop.runs ?? 0} run(s) · ${loop.journeys?.length ?? 0} journey(s)` })), button('Stop monitor', { kind: 'danger', icon: 'stop', onclick: () => void stop() }))
            : h('div', { class: 'stack-sm' },
                h('div', { class: 'form-grid' }, field('Interval (seconds)', interval), field('Runs (optional)', iterations)),
                unsafe.length ? h('div', { class: 'note note-warn' }, h('p', { text: 'These journeys write data; monitors only run them when allowed explicitly:' }), h('ul', { class: 'bullets' }, unsafe.map((j) => h('li', { text: `${j.name}: ${j.writes.map((w) => w.reason).join('; ')}` }))), h('label', { class: 'check', for: writesId }, writes, h('span', { text: 'Allow writes' }))) : h('span'),
                button('Start monitor', { kind: 'primary', icon: 'run', disabled: !v.journeys.length, onclick: () => void start() })),
          loop.lastError ? h('p', { class: 'bad-text', text: loop.lastError }) : h('span'))),
        v.journeys.length
          ? card('Monitored journeys', dataTable({ caption: 'Journeys tagged @monitor', rows: v.journeys, columns: [{ title: 'Journey', render: (j) => h('strong', { text: j.name }) }, { title: 'Steps', render: (j) => String(j.steps) }, { title: 'Safety', render: (j) => (j.writes.length ? sevBadge('warn', 'writes data') : sevBadge('ok', 'read-only')) }] }))
          : emptyState('No @monitor journeys', 'Tag journeys that are safe to run in production with @monitor (Tags: @monitor). Monitors never run journeys that write data unless you allow it.'),
        s
          ? h('div', { class: 'stack' },
              h('div', { class: 'stats' }, stat(s.overall, 'Overall', s.overall === 'up' ? 'ok' : s.overall === 'down' ? 'bad' : 'warn'), stat(s.runs, 'Runs'), stat(s.counts.up ?? 0, 'Up', 'ok'), stat(s.counts.down ?? 0, 'Down', 'bad'), stat(relTime(s.updatedAt), 'Updated')),
              h('div', { class: 'cards' }, s.journeys.map((j) => {
                const hist = v.history.filter((x) => x.journeyId === j.journeyId);
                const durs = v.durations[j.journeyId] ?? [];
                return card(j.name, h('div', { class: 'stack-sm' },
                  h('p', { class: 'row wrap' }, sevBadge(j.health), h('span', { class: 'muted', text: `uptime ${j.uptimePct === null ? '–' : `${j.uptimePct.toFixed(2)}%`} · p50 ${j.p50Ms ?? '–'} ms · p95 ${j.p95Ms ?? '–'} ms · last ${dateTime(j.lastRunAt)}` })),
                  hist.length ? statusStrip(hist.map((x) => ({ at: x.at, ok: x.status === 'passed' || x.status === 'passed-healed' })), `${j.name} uptime`) : h('p', { class: 'small muted', text: 'No history from the Studio loop yet.' }),
                  lineChart((hist.length ? hist.map((x) => ({ x: dateTime(x.at), y: x.durationMs })) : durs.map((d, i) => ({ x: `run ${i + 1}`, y: d }))), { label: `${j.name} latency`, unit: ' ms', threshold: j.p95Ms ?? undefined }),
                  j.failingStep ? h('p', { class: 'bad-text small', text: `Failing at ${j.failingStep}` }) : h('span')));
              })),
              s.recentAlerts.length ? card('Recent alerts', h('ul', { class: 'bullets' }, s.recentAlerts.map((a) => h('li', { text: `${dateTime(a.at)} · ${a.journeyId} ${a.kind}` })))) : h('span'))
          : h('p', { class: 'muted', text: 'No monitor state yet: start the loop (or run "eztest monitor") to collect results.' }),
      );
    };
    return { show: () => ((visible = true), void load()), hide: () => (visible = false) };
  },
};
