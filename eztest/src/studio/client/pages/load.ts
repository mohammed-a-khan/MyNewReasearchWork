/**
 * The Performance workspace (EZTest Load): design scenarios (populations,
 * profiles with a curve preview, SLAs, user path outline and YAML), the
 * correlation assistant, run control with the live dashboard, and results
 * with analysis, comparison and trends.
 */
import { api } from '../core/api.js';
import { clear, h, svg, uid } from '../core/dom.js';
import { onTopic } from '../core/events.js';
import { dateTime } from '../core/format.js';
import { link, navigate } from '../core/router.js';
import { button, card, emptyState, stat } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { codeBlock, dataTable, field, filePicker, pageHeader, registerSectionPage, runPicker, sevBadge, withStates, type SubPageDef } from './assurance-ui.js';

// ------------------------------------------------------------------ types (server views)

interface ScenarioListItem { path: string; name?: string; model?: string; populations?: number; userPaths?: number; sla?: number; error?: string }
interface CurvePoint { at: number; value: number }
interface Population { name: string; userPath: string; share: number; percent: number; peak: number; durationMs: number; curve: CurvePoint[]; zone?: string; network?: { latencyMs: number; downloadKbps: number; uploadKbps: number; lossPercent: number }; browser?: boolean; profile?: Record<string, unknown> }
interface OutlineNode { kind: string; name: string; children?: OutlineNode[]; extract?: string[] }
interface Summary { name: string; model: 'closed' | 'open'; baseUrl?: string; populations: Population[]; total: CurvePoint[]; userPaths: Array<{ name: string; browser: boolean; source?: string; data: string[]; init: number; actions: OutlineNode[] }>; sla: Array<Record<string, unknown>>; monitors: Array<{ type: string; name?: string }>; data: string[] }
interface ScenarioView { path: string; doc: Record<string, unknown>; text: string; valid: boolean; error?: string; summary?: Summary }
interface Row { kind: string; name: string; count: number; errors: number; mean: number; p50: number; p90: number; p95: number; p99: number; max: number }
interface Point { t: number; vus: number; rps: number; errors: number; iterations: number; latency: { p50: number; p90: number; p95: number; p99: number; max: number; mean: number } | null; rows: Row[]; errorsByType: Record<string, number> }
interface SlaItem { sla: string; metric: string; name: string; value: number | null; warn?: number; fail?: number; status: string; unit: string }
interface Snapshot { runId: string; scenario: string; state: string; elapsedMs: number; durationMs: number; vus: number; point?: Point; totals: { requests: number; errors: number; iterations: number; dropped: number }; sla: SlaItem[]; monitors: Array<{ name: string; type: string; values: Record<string, number> }>; populations: Array<{ name: string; vus: number; target: number; queued: number }>; path?: string; error?: string }
interface RunListItem { runId: string; scenario: string; startedAt: string; durationMs: number; verdict: string; requests: number; rps: number; errorRate: number; p95: number; maxVus: number; agents: number }
interface NameStats { kind: string; name: string; count: number; errors: number; errorRate: number; throughput: number; latency: { mean: number; p50: number; p90: number; p95: number; p99: number; max: number } }
interface Results { runId: string; scenario: { name: string; model: string }; verdict: string; durationMs: number; startedAt: string; totals: { requests: number; rps: number; errorRate: number; maxVus: number; latency: { p50: number; p95: number; p99: number }; dropped: number }; names: NameStats[]; sla: { status: string; items: SlaItem[] }; analysis: { findings: Array<{ kind: string; severity: string; title: string; detail: string }> }; timeline: Point[]; monitors: Array<{ name: string; points: Array<{ t: number; values: Record<string, number> }> }>; errors: { byType: Record<string, number> } }

const BASELINE_KEY = 'eztest.load.baseline';
const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : n >= 100 ? String(Math.round(n)) : n.toFixed(d));

// ------------------------------------------------------------------ charts

/** Multi-series line chart (inline SVG, accessible summary, never colour alone: legend names each line). */
export function seriesChart(title: string, xs: number[], series: Array<{ label: string; values: Array<number | null>; cls: string }>, opts: { unit?: string; height?: number; xUnit?: string } = {}): HTMLElement {
  const W = 640;
  const H = opts.height ?? 150;
  const padL = 44;
  const padB = 18;
  const vals = series.flatMap((s) => s.values.filter((v): v is number => typeof v === 'number'));
  const max = Math.max(1, ...vals) * 1.1;
  const xMax = Math.max(1, ...xs);
  const X = (x: number) => padL + (x / xMax) * (W - padL - 8);
  const Y = (v: number) => 6 + (1 - v / max) * (H - 6 - padB);
  const unit = opts.unit ?? '';
  const summary = `${title}: ${series.map((s) => {
    const v = s.values.filter((x): x is number => typeof x === 'number');
    return `${s.label} latest ${v.length ? fmt(v[v.length - 1]) : 'none'}${unit}, max ${v.length ? fmt(Math.max(...v)) : 'none'}${unit}`;
  }).join('; ')}`;
  const paths = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      d += `${d && s.values[i - 1] !== null && s.values[i - 1] !== undefined ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`;
    });
    return svg('path', { class: `ld-series ${s.cls}`, d });
  });
  return h(
    'figure',
    { class: 'ld-chart' },
    h('figcaption', null, h('span', { class: 'ld-chart-title', text: title }), h('span', { class: 'ld-legend' }, series.map((s) => h('span', { class: 'ld-legend-item' }, h('span', { class: `ld-swatch ${s.cls}`, 'aria-hidden': 'true' }), s.label)))),
    svg(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, class: 'ld-svg', role: 'img', 'aria-label': summary, preserveAspectRatio: 'none' },
      svg('title', { text: summary }),
      [0, 0.5, 1].map((f) => svg('line', { class: 'ld-grid', x1: padL, x2: W - 8, y1: Y(max * f), y2: Y(max * f) })),
      [0, 0.5, 1].map((f) => svg('text', { class: 'ld-tick', x: padL - 4, y: Y(max * f) + 3, 'text-anchor': 'end', text: `${fmt(max * f, 0)}${unit}` })),
      [0, 0.5, 1].map((f) => svg('text', { class: 'ld-tick', x: X(xMax * f), y: H - 4, 'text-anchor': 'middle', text: `${Math.round(xMax * f)}${opts.xUnit ?? 's'}` })),
      paths,
    ),
  );
}

function curveChart(s: Summary): HTMLElement {
  const xs = s.total.map((p) => p.at / 1000);
  const series = [{ label: 'total', values: s.total.map((p) => p.value), cls: 's1' }, ...s.populations.slice(0, 4).map((p, i) => ({ label: p.name, values: s.total.map((t) => interp(p.curve, t.at)), cls: `s${i + 2}` }))];
  return seriesChart(s.model === 'closed' ? 'Virtual users over time' : 'Arrival rate over time (iterations/s)', xs, series);
}

function interp(c: CurvePoint[], t: number): number {
  if (!c.length) return 0;
  if (t <= c[0].at) return c[0].value;
  for (let i = 1; i < c.length; i++) if (c[i].at >= t) return c[i - 1].value + ((c[i].value - c[i - 1].value) * (t - c[i - 1].at)) / Math.max(1, c[i].at - c[i - 1].at);
  return c[c.length - 1].value;
}

function outline(nodes: OutlineNode[]): HTMLElement {
  return h('ul', { class: 'ld-outline' }, nodes.map((n) => h('li', null, h('span', { class: `ld-kind ld-kind-${n.kind}`, text: n.kind }), ' ', h('span', { text: n.name }), n.extract?.length ? h('span', { class: 'muted small', text: `  extracts ${n.extract.join(', ')}` }) : null, n.children?.length ? outline(n.children) : null)));
}

function statusBadge(s: string): HTMLElement {
  return sevBadge(s === 'pass' ? 'pass' : s === 'warn' ? 'warn' : s === 'fail' || s === 'error' ? 'fail' : 'info', s);
}

// ------------------------------------------------------------------ Design

const PROFILE_FIELDS: Record<string, Array<[string, string]>> = {
  constant: [['vus', 'Virtual users'], ['rate', 'Rate (iterations/s)'], ['duration', 'Duration']],
  ramp: [['vus', 'Virtual users'], ['rate', 'Rate (iterations/s)'], ['rampUp', 'Ramp-up'], ['plateau', 'Plateau'], ['rampDown', 'Ramp-down']],
  step: [['from', 'From'], ['step', 'Step'], ['every', 'Every'], ['to', 'To'], ['hold', 'Hold']],
  peak: [['base', 'Base'], ['peak', 'Peak'], ['duration', 'Duration'], ['peakEvery', 'Peak every'], ['peakFor', 'Peak for']],
  soak: [['vus', 'Virtual users'], ['rate', 'Rate (iterations/s)'], ['duration', 'Duration'], ['rampUp', 'Ramp-up']],
};

const designSection: SubPageDef = {
  id: 'design',
  title: 'Design',
  icon: 'layers',
  description: 'Scenarios, populations, profiles, SLAs',
  mount(root) {
    const picker = h('select', { class: 'input', id: uid('scn') });
    const body = h('div', { class: 'stack', id: 'load-design' });
    const newBtn = button('New scenario', { icon: 'plus', onclick: () => void createNew() });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Design', 'Scenarios of user paths and populations: the load profile per population (with its curve), network emulation, SLAs, and the YAML behind it.', h('div', { class: 'row' }, field('Scenario', picker), newBtn)), body));
    let current: ScenarioView | undefined;
    const refreshList = async (select?: string) => {
      const r = await api.get<{ scenarios: ScenarioListItem[] }>('/api/load/scenarios');
      clear(picker);
      for (const s of r.scenarios) picker.appendChild(h('option', { value: s.path, text: s.error ? `${s.path} (invalid)` : `${s.name} — ${s.path}` }));
      if (!r.scenarios.length) {
        clear(body).appendChild(emptyState('No load scenarios yet', 'Create one, or generate it from a recording or a run in the Correlation section.', button('New scenario', { icon: 'plus', onclick: () => void createNew() })));
        return;
      }
      picker.value = select && r.scenarios.some((s) => s.path === select) ? select : r.scenarios[0].path;
      await open(picker.value);
    };
    picker.addEventListener('change', () => void open(picker.value));
    const createNew = async () => {
      const path = `load/scenario-${Date.now().toString(36)}.yaml`;
      const doc = { version: 1, name: 'New scenario', baseUrl: 'http://localhost:8080', profile: { type: 'ramp', vus: 10, rampUp: '30s', plateau: '1m', rampDown: '10s' }, userPaths: { browse: { actions: [{ transaction: { name: 'home', actions: [{ request: { name: 'GET /', url: '/' } }] } }], thinkTime: { min: '1s', max: '3s' } } }, populations: [{ name: 'visitors', userPath: 'browse', share: 100 }], sla: [{ match: '*', kind: 'transaction', p95: { warn: 800, fail: 1500 }, errorRate: { fail: 0.01 } }] };
      try {
        await api.put('/api/load/scenario', { path, doc });
        toast(`Created ${path}`, { kind: 'success' });
        await refreshList(path);
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    const open = async (path: string) => {
      const v = await withStates(body, () => api.get<ScenarioView>(`/api/load/scenario?path=${encodeURIComponent(path)}`), { retry: () => void open(path) });
      if (!v) return;
      current = v;
      render();
    };
    const render = () => {
      const v = current!;
      clear(body);
      const doc = v.doc as { name?: string; baseUrl?: string; model?: string; profile?: Record<string, unknown>; populations?: Array<Record<string, unknown>>; userPaths?: Record<string, unknown>; sla?: Array<Record<string, unknown>> };
      const preview = h('div', { 'aria-live': 'polite', id: 'load-preview' });
      const showPreview = (s?: Summary, error?: string) => {
        clear(preview);
        if (error) preview.appendChild(h('p', { class: 'note note-warn', role: 'alert', text: error }));
        if (s) preview.append(curveChart(s), h('p', { class: 'muted small', text: s.populations.map((p) => `${p.name}: ${p.percent}% · peak ${p.peak} ${s.model === 'closed' ? 'VUs' : '/s'} · ${Math.round(p.durationMs / 1000)} s`).join('   ') }));
      };
      showPreview(v.summary, v.valid ? undefined : v.error);
      let timer: number | undefined;
      const changed = () => {
        if (timer) clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const r = await api.post<{ valid: boolean; summary?: Summary; error?: string }>('/api/load/preview', { doc }).catch((e: Error) => ({ valid: false, error: e.message, summary: undefined }));
          showPreview(r.summary, r.valid ? undefined : r.error);
        }, 250);
      };
      // general
      const name = h('input', { class: 'input', value: doc.name ?? '', oninput: () => ((doc.name = name.value), changed()) });
      const baseUrl = h('input', { class: 'input', value: doc.baseUrl ?? '', oninput: () => ((doc.baseUrl = baseUrl.value || undefined), changed()) });
      const model = h('select', { class: 'input', onchange: () => ((doc.model = model.value), changed()) }, h('option', { value: 'closed', text: 'Closed (virtual users)' }), h('option', { value: 'open', text: 'Open (arrival rate)' }));
      model.value = doc.model ?? 'closed';
      // profile
      doc.profile ??= { type: 'ramp', vus: 10, rampUp: '30s' };
      const prof = doc.profile;
      const profType = h('select', { class: 'input', onchange: () => ((prof.type = profType.value), renderProfile(), changed()) }, Object.keys(PROFILE_FIELDS).map((k) => h('option', { value: k, text: k })));
      profType.value = String(prof.type ?? 'ramp');
      const profFields = h('div', { class: 'form-grid' });
      const renderProfile = () => {
        clear(profFields);
        for (const [k, label] of PROFILE_FIELDS[String(prof.type)] ?? []) {
          const inp = h('input', { class: 'input', value: prof[k] === undefined ? '' : String(prof[k]), placeholder: /vus|rate|from|step|to|base|peak/.test(k) ? 'number' : 'e.g. 30s', oninput: () => {
            const raw = inp.value.trim();
            if (!raw) delete prof[k];
            else prof[k] = /^\d+(\.\d+)?$/.test(raw) && /^(vus|rate|from|step|to|base|peak)$/.test(k) ? Number(raw) : raw;
            changed();
          } });
          profFields.appendChild(field(label, inp));
        }
      };
      renderProfile();
      // populations
      doc.populations ??= [{ name: Object.keys(doc.userPaths ?? {})[0] ?? 'main', userPath: Object.keys(doc.userPaths ?? {})[0] ?? 'main', share: 100 }];
      const pathNames = Object.keys(doc.userPaths ?? {});
      const popBox = h('div', { class: 'stack' });
      const renderPops = () => {
        clear(popBox);
        const tbl = h('table', { class: 'data-table' }, h('caption', { class: 'sr-only', text: 'Populations' }), h('thead', null, h('tr', null, ['Name', 'User path', 'Share %', 'Zone', 'Latency ms', 'Download kbps', 'Loss %', ''].map((t) => h('th', { scope: 'col', text: t || 'Actions' })))));
        const tb = h('tbody');
        doc.populations!.forEach((p, i) => {
          const net = (p.network ?? {}) as Record<string, number>;
          const cell = (k: string, v: unknown, label: string, onv: (s: string) => void, type = 'text') => h('td', null, h('input', { class: 'input input-sm', type, value: v === undefined ? '' : String(v), 'aria-label': `${label} of population ${i + 1}`, oninput: (e: Event) => (onv((e.target as HTMLInputElement).value), changed()) }));
          const sel = h('select', { class: 'input input-sm', 'aria-label': `User path of population ${i + 1}`, onchange: () => ((p.userPath = sel.value), changed()) }, pathNames.map((n) => h('option', { value: n, text: n })));
          sel.value = String(p.userPath);
          const setNet = (k: string) => (s: string) => {
            const n = Number(s);
            const nn = { ...(p.network as Record<string, number> | undefined) };
            if (!s || !Number.isFinite(n)) delete nn[k];
            else nn[k] = n;
            p.network = Object.keys(nn).length ? nn : undefined;
          };
          tb.appendChild(h('tr', null,
            cell('name', p.name, 'Name', (s) => (p.name = s)),
            h('td', null, sel),
            cell('share', p.share, 'Share', (s) => (p.share = Number(s) || 0), 'number'),
            cell('zone', p.zone, 'Zone', (s) => (p.zone = s || undefined)),
            cell('latency', net.latencyMs, 'Latency', setNet('latencyMs'), 'number'),
            cell('down', net.downloadKbps, 'Download bandwidth', setNet('downloadKbps'), 'number'),
            cell('loss', net.lossPercent, 'Packet loss', setNet('lossPercent'), 'number'),
            h('td', null, button('Remove', { small: true, kind: 'ghost', ariaLabel: `Remove population ${String(p.name)}`, disabled: doc.populations!.length < 2, onclick: () => (doc.populations!.splice(i, 1), renderPops(), changed()) })),
          ));
        });
        tbl.appendChild(tb);
        popBox.append(h('div', { class: 'table-wrap' }, tbl), button('Add population', { icon: 'plus', small: true, onclick: () => (doc.populations!.push({ name: `population${doc.populations!.length + 1}`, userPath: pathNames[0], share: 10 }), renderPops(), changed()) }));
      };
      renderPops();
      // SLAs
      doc.sla ??= [];
      const slaBox = h('div', { class: 'stack' });
      const renderSla = () => {
        clear(slaBox);
        const tbl = h('table', { class: 'data-table' }, h('caption', { class: 'sr-only', text: 'SLA profiles' }), h('thead', null, h('tr', null, ['Match', 'Kind', 'p95 warn ms', 'p95 fail ms', 'Error rate fail', ''].map((t) => h('th', { scope: 'col', text: t || 'Actions' })))));
        const tb = h('tbody');
        doc.sla!.forEach((s, i) => {
          const p95 = (s.p95 ?? {}) as { warn?: number; fail?: number };
          const er = (s.errorRate ?? {}) as { fail?: number };
          const num = (v: string) => (v === '' ? undefined : Number(v));
          const inp = (v: unknown, label: string, on: (x: string) => void, type = 'number') => h('td', null, h('input', { class: 'input input-sm', type, step: 'any', value: v === undefined ? '' : String(v), 'aria-label': `${label} of SLA ${i + 1}`, oninput: (e: Event) => (on((e.target as HTMLInputElement).value), changed()) }));
          const kind = h('select', { class: 'input input-sm', 'aria-label': `Kind of SLA ${i + 1}`, onchange: () => ((s.kind = kind.value), changed()) }, ['any', 'transaction', 'request'].map((k) => h('option', { value: k, text: k })));
          kind.value = String(s.kind ?? 'any');
          tb.appendChild(h('tr', null,
            inp(s.match ?? '*', 'Match', (x) => (s.match = x || '*'), 'text'),
            h('td', null, kind),
            inp(p95.warn, 'p95 warning', (x) => (s.p95 = { ...p95, warn: num(x) })),
            inp(p95.fail, 'p95 failure', (x) => (s.p95 = { ...p95, fail: num(x) })),
            inp(er.fail, 'Error-rate failure', (x) => (s.errorRate = { fail: num(x) })),
            h('td', null, button('Remove', { small: true, kind: 'ghost', ariaLabel: `Remove SLA ${i + 1}`, onclick: () => (doc.sla!.splice(i, 1), renderSla(), changed()) })),
          ));
        });
        tbl.appendChild(tb);
        slaBox.append(h('div', { class: 'table-wrap' }, tbl), button('Add SLA', { icon: 'plus', small: true, onclick: () => (doc.sla!.push({ match: '*', kind: 'transaction', p95: { fail: 1000 } }), renderSla(), changed()) }));
      };
      renderSla();
      const save = async () => {
        try {
          await api.put('/api/load/scenario', { path: v.path, doc });
          toast(`Saved ${v.path}`, { kind: 'success' });
          await open(v.path);
        } catch (e) {
          toastError((e as Error).message);
        }
      };
      body.append(
        card('Scenario', h('div', { class: 'form-grid' }, field('Name', name), field('Base URL', baseUrl), field('Load model', model)), { actions: h('div', { class: 'row' }, button('Save', { icon: 'save', kind: 'primary', onclick: () => void save() }), button('Run…', { icon: 'run', onclick: () => navigate(link('load', 'run')) })) }),
        card('Load profile', h('div', { class: 'stack' }, field('Profile', profType), profFields, preview)),
        card('Populations', h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Each population runs a user path with a share of the load; latency, bandwidth and loss emulate its network (EZTest\'s connection shaper).' }), popBox)),
        card('SLAs', slaBox),
        v.summary ? card('User paths', h('div', { class: 'stack' }, v.summary.userPaths.map((p) => h('div', null, h('h3', { class: 'h3', text: `${p.name}${p.browser ? ' (browser-level)' : ''}` }), p.source ? h('p', { class: 'muted small', text: `source: ${p.source}` }) : null, outline(p.actions))))) : h('span'),
        card('YAML', codeBlock(v.text, { label: 'Scenario file', tall: true })),
      );
    };
    return {
      show: () => void refreshList(picker.value || undefined).catch((e: Error) => clear(body).appendChild(emptyState('Could not load scenarios', e.message))),
    };
  },
};

// ------------------------------------------------------------------ Correlation

const correlationSection: SubPageDef = {
  id: 'correlation',
  title: 'Correlation',
  icon: 'target',
  description: 'Recording → correlated user path, rules',
  mount(root) {
    const body = h('div', { class: 'stack' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Correlation assistant', 'Turn captured traffic (an EZTest run or a HAR recording) into a user path whose session ids, CSRF tokens, ViewStates and OAuth tokens are extracted at run time.'), body));
    let har: string | undefined;
    let lastResult: { path: unknown; baseUrl: string } | undefined;
    const out = h('div', { 'aria-live': 'polite', id: 'corr-out', class: 'stack' });
    const packs = ['aspnet', 'jsf', 'salesforce', 'd365', 'sap', 'generic'];
    const checks = packs.map((p) => {
      const id = uid('pack');
      const c = h('input', { type: 'checkbox', id, checked: true, value: p });
      return { p, c, el: h('label', { for: id, class: 'check' }, c, ` ${p}`) };
    });
    const excluded = new Set<string>();
    const picker = runPicker({ label: 'From run', onChange: () => undefined });
    const harInfo = h('span', { class: 'muted small' });
    const scenarioPath = h('input', { class: 'input', value: 'load/recorded.yaml' });
    const run = async () => {
      const body: Record<string, unknown> = { frameworks: checks.filter((x) => x.c.checked).map((x) => x.p), exclude: [...excluded] };
      if (har) body.har = har;
      else body.runId = picker.el.querySelector('select')?.value || undefined;
      const r = await withStates(out, () => api.post<{ path: unknown; baseUrl: string; requests: number; transactions: string[]; correlations: Array<{ variable: string; rule: string; framework?: string; kind: string; expression: string; preview: string; sourceRequest: number; usedBy: number[] }>; candidates: Array<{ value: string; rule: string; reason: string; source: number }>; warnings: string[]; env: string[] }>('/api/load/correlate', body), { loading: 'Correlating…' });
      if (!r) return;
      lastResult = r;
      out.append(
        h('div', { class: 'row wrap' }, stat(r.requests, 'requests'), stat(r.transactions.length, 'transactions'), stat(r.correlations.length, 'correlated values'), stat(r.env.length, 'credentials to set')),
        dataTable({ caption: 'Correlated values', rows: r.correlations, empty: 'No dynamic values found.', columns: [
          { title: 'Variable', render: (c) => h('code', { text: c.variable }) },
          { title: 'Rule', render: (c) => `${c.rule}${c.framework ? ` (${c.framework})` : ''}` },
          { title: 'Extracted from', render: (c) => `request ${c.sourceRequest + 1}: ${c.kind}` },
          { title: 'Used by', render: (c) => c.usedBy.map((u) => u + 1).join(', ') },
          { title: 'Value', render: (c) => h('code', { text: c.preview }) },
          { title: 'Keep', render: (c) => button('Exclude', { small: true, kind: 'ghost', ariaLabel: `Exclude ${c.variable}`, onclick: () => (excluded.add(c.rule), void run()) }) },
        ] }),
        r.candidates.length ? dataTable({ caption: 'Candidates not correlated', rows: r.candidates.slice(0, 50), columns: [{ title: 'Rule', render: (c) => c.rule }, { title: 'Value', render: (c) => h('code', { text: c.value }) }, { title: 'Why', render: (c) => c.reason }] }) : h('span'),
        r.warnings.length ? h('ul', { class: 'bullets warn-text' }, r.warnings.map((w) => h('li', { text: w }))) : h('span'),
        r.env.length ? h('p', { class: 'note', text: `Set on the load generators: ${r.env.join(', ')}` }) : h('span'),
        h('div', { class: 'row wrap' }, field('Save as', scenarioPath), button('Save scenario', { icon: 'save', kind: 'primary', onclick: () => void saveScenario() }), excluded.size ? button(`Reset exclusions (${excluded.size})`, { small: true, onclick: () => (excluded.clear(), void run()) }) : h('span')),
        codeBlock(JSON.stringify(r.path, null, 2), { label: 'Generated user path', tall: true }),
      );
    };
    const saveScenario = async () => {
      if (!lastResult) return;
      const doc = { version: 1, name: 'Recorded scenario', baseUrl: lastResult.baseUrl, profile: { type: 'ramp', vus: 10, rampUp: '30s', plateau: '2m', rampDown: '10s' }, userPaths: { main: lastResult.path }, sla: [{ match: '*', kind: 'transaction', p95: { warn: 1000, fail: 3000 }, errorRate: { fail: 0.01 } }] };
      try {
        const r = await api.put<{ saved: string }>('/api/load/scenario', { path: scenarioPath.value, doc });
        toast(`Saved ${r.saved}`, { kind: 'success' });
        const check = await api.post<{ paths: Array<{ path: string; ok: boolean; requests: Array<{ name: string; ok: boolean; ms: number; error?: string }>; errors: string[] }> }>('/api/load/check', { path: r.saved }).catch(() => undefined);
        if (check) out.prepend(card('Replay check (1 virtual user)', dataTable({ caption: 'Replay check', rows: check.paths.flatMap((p) => p.requests), columns: [{ title: 'Request', render: (x) => x.name }, { title: 'Result', render: (x) => statusBadge(x.ok ? 'pass' : 'fail') }, { title: 'ms', class: 'num', render: (x) => fmt(x.ms) }, { title: 'Error', render: (x) => x.error ?? '' }] })));
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    // rule editor
    const rulesBox = h('div', { class: 'stack' });
    let rules: Array<Record<string, unknown>> = [];
    const renderRules = () => {
      clear(rulesBox);
      rulesBox.appendChild(dataTable({ caption: 'Project correlation rules', rows: rules, empty: 'No project rules: the framework packs and heuristics apply.', columns: [
        { title: 'Name', render: (r) => String(r.name) }, { title: 'From', render: (r) => String(r.from ?? 'body') },
        { title: 'Expression', render: (r) => h('code', { text: String(r.regex ?? r.json ?? (r.boundary ? `${(r.boundary as { left: string }).left}…${(r.boundary as { right: string }).right}` : r.header ?? '')) }) },
        { title: 'Variable', render: (r) => String(r.var ?? '') },
        { title: '', render: (r) => button('Delete', { small: true, kind: 'ghost', ariaLabel: `Delete rule ${String(r.name)}`, onclick: () => void saveRules(rules.filter((x) => x !== r)) }) },
      ] }));
      const rn = h('input', { class: 'input' });
      const rf = h('select', { class: 'input' }, ['body', 'header', 'cookie'].map((x) => h('option', { value: x, text: x })));
      const rk = h('select', { class: 'input' }, ['regex', 'json', 'boundary'].map((x) => h('option', { value: x, text: x })));
      const re = h('input', { class: 'input', placeholder: 'regex group 1, $.json.path, or left…right' });
      const rv = h('input', { class: 'input' });
      rulesBox.append(h('form', { class: 'form-grid', onsubmit: (e: Event) => {
        e.preventDefault();
        const r: Record<string, unknown> = { name: rn.value || 'rule', from: rf.value, var: rv.value || undefined, enabled: true };
        if (rk.value === 'regex') r.regex = re.value;
        else if (rk.value === 'json') r.json = re.value;
        else {
          const [left, right] = re.value.split('…');
          r.boundary = { left: left ?? '', right: right ?? '' };
        }
        if (rf.value === 'header' || rf.value === 'cookie') r.header = rn.value;
        void saveRules([...rules, r]);
      } }, field('Rule name (header/cookie name)', rn), field('Look in', rf), field('Extractor', rk), field('Expression', re), field('Variable', rv), h('div', null, h('button', { type: 'submit', class: 'btn', text: 'Add rule' }))));
    };
    const saveRules = async (next: Array<Record<string, unknown>>) => {
      try {
        const r = await api.put<{ rules: Array<Record<string, unknown>> }>('/api/load/rules', { rules: next });
        rules = r.rules;
        renderRules();
        toast('Rules saved', { kind: 'success' });
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    body.append(
      card('Source', h('div', { class: 'stack' },
        h('div', { class: 'row wrap' }, picker.el, h('span', { class: 'muted', text: 'or' }), filePicker({ label: 'Upload a HAR file', accept: '.har,application/json', id: 'har-upload', onFile: (f) => void f.text().then((t) => ((har = t), (harInfo.textContent = `${f.name} (${Math.round(f.size / 1024)} KB)`))) }), harInfo),
        h('fieldset', { class: 'fieldset' }, h('legend', { text: 'Framework rule packs' }), h('div', { class: 'row wrap' }, checks.map((x) => x.el))),
        h('div', null, button('Correlate', { icon: 'target', kind: 'primary', onclick: () => void run() })),
      )),
      out,
      card('Rule editor', rulesBox),
    );
    return {
      show: async () => {
        await picker.refresh().catch(() => undefined);
        const r = await api.get<{ rules: Array<Record<string, unknown>> }>('/api/load/rules').catch(() => ({ rules: [] }));
        rules = r.rules;
        renderRules();
      },
    };
  },
};

// ------------------------------------------------------------------ Run (control + live dashboard)

function dashboard(el: HTMLElement, history: Point[], snap: Snapshot): void {
  clear(el);
  const p = snap.point;
  const xs = history.map((x) => x.t);
  el.append(
    h('div', { class: 'row wrap ld-kpis', role: 'group', 'aria-label': 'Live figures' },
      stat(snap.vus, 'active VUs'), stat(fmt(p?.rps ?? 0), 'requests/s'), stat(p?.errors ?? 0, 'errors/s', (p?.errors ?? 0) > 0 ? 'bad' : undefined),
      stat(fmt(p?.latency?.p50), 'p50 ms'), stat(fmt(p?.latency?.p90), 'p90 ms'), stat(fmt(p?.latency?.p95), 'p95 ms'), stat(fmt(p?.latency?.p99), 'p99 ms'),
      stat(snap.totals.requests, 'requests'), stat(snap.totals.errors, 'errors', snap.totals.errors ? 'bad' : undefined)),
    h('div', { class: 'ld-grid2' },
      seriesChart('Active virtual users', xs, [{ label: 'VUs', values: history.map((x) => x.vus), cls: 's1' }]),
      seriesChart('Throughput', xs, [{ label: 'requests/s', values: history.map((x) => x.rps), cls: 's2' }, { label: 'errors/s', values: history.map((x) => x.errors), cls: 's5' }]),
      seriesChart('Response time', xs, [{ label: 'p50', values: history.map((x) => x.latency?.p50 ?? null), cls: 's1' }, { label: 'p90', values: history.map((x) => x.latency?.p90 ?? null), cls: 's2' }, { label: 'p95', values: history.map((x) => x.latency?.p95 ?? null), cls: 's3' }, { label: 'p99', values: history.map((x) => x.latency?.p99 ?? null), cls: 's4' }], { unit: ' ms' }),
      snap.monitors.length ? h('div', { class: 'stack' }, snap.monitors.map((m) => h('div', null, h('strong', { text: m.name }), h('p', { class: 'small muted', text: Object.entries(m.values).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no samples yet' })))) : h('span'),
    ),
    dataTable<Row>({ caption: 'Transactions and requests (last second)', rows: (p?.rows ?? []).filter((r) => r.kind !== 'iteration'), empty: 'No responses in the last second.', columns: [
      { title: 'Name', render: (r) => r.name }, { title: 'Kind', render: (r) => r.kind }, { title: 'Count', class: 'num', render: (r) => String(r.count) }, { title: 'Errors', class: 'num', render: (r) => String(r.errors) },
      { title: 'p50', class: 'num', render: (r) => fmt(r.p50) }, { title: 'p90', class: 'num', render: (r) => fmt(r.p90) }, { title: 'p95', class: 'num', render: (r) => fmt(r.p95) }, { title: 'p99', class: 'num', render: (r) => fmt(r.p99) },
    ] }),
    h('div', { class: 'ld-grid2' },
      dataTable({ caption: 'SLAs (live window)', rows: snap.sla, empty: 'No SLA has data yet.', columns: [{ title: 'SLA', render: (s) => s.sla }, { title: 'Name', render: (s) => s.name }, { title: 'Metric', render: (s) => s.metric }, { title: 'Value', class: 'num', render: (s) => (s.value === null ? '–' : s.unit === 'ratio' ? `${(s.value * 100).toFixed(2)}%` : fmt(s.value)) }, { title: 'Status', render: (s) => statusBadge(s.status) }] }),
      dataTable({ caption: 'Errors by type (last second)', rows: Object.entries(p?.errorsByType ?? {}).map(([type, n]) => ({ type, n })), empty: 'No errors.', columns: [{ title: 'Type', render: (x) => x.type }, { title: 'Count', class: 'num', render: (x) => String(x.n) }] }),
    ),
  );
}

const runSection: SubPageDef = {
  id: 'run',
  title: 'Run',
  icon: 'activity',
  description: 'Run control and the live dashboard',
  mount(root) {
    const picker = h('select', { class: 'input', id: uid('runscn') });
    const duration = h('input', { class: 'input', type: 'number', min: '1', placeholder: 'from the profile', id: uid('dur') });
    const status = h('p', { class: 'muted', 'aria-live': 'polite', id: 'load-status' });
    const controls = h('div', { class: 'row wrap', id: 'load-controls' });
    const dash = h('div', { class: 'stack', id: 'load-dashboard' });
    const history: Point[] = [];
    let visible = false;
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Run', 'Start a load test on this machine and watch throughput, response-time percentiles, errors, active VUs, SLAs and monitors live; add VUs or stop it at any time.'),
      card('Start', h('form', { class: 'form-grid', onsubmit: (e: Event) => (e.preventDefault(), void start()) }, field('Scenario', picker), field('Duration override (seconds)', duration), h('div', null, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Start load test' })))),
      status, controls, dash));
    const n = h('input', { class: 'input input-sm', type: 'number', value: '5', 'aria-label': 'Virtual users to add or remove' });
    const ctl = async (body: Record<string, unknown>) => {
      try {
        await api.post('/api/load/active/control', body);
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    const renderControls = (running: boolean) => {
      clear(controls);
      if (!running) return;
      controls.append(
        n,
        button('Add VUs', { icon: 'plus', onclick: () => void ctl({ op: 'vus', n: Number(n.value) }) }),
        button('Remove VUs', { onclick: () => void ctl({ op: 'vus', n: -Number(n.value) }) }),
        button('Stop', { icon: 'stop', kind: 'danger', onclick: () => void ctl({ op: 'stop' }) }),
        button('Abort', { kind: 'ghost', onclick: async () => (await confirmDialog({ title: 'Abort the load test?', message: 'Running iterations are abandoned and not recorded.', confirm: 'Abort', danger: true })) && void ctl({ op: 'abort' }) }),
      );
    };
    const showSnap = (s: Snapshot | null) => {
      if (!s) {
        status.textContent = 'No load test running.';
        renderControls(false);
        return;
      }
      if (s.point && (!history.length || history[history.length - 1].t < s.point.t)) history.push(s.point);
      status.textContent = `${s.scenario} (${s.path ?? ''}): ${s.state}, ${Math.round(s.elapsedMs / 1000)} s${s.durationMs ? ` of ${Math.round(s.durationMs / 1000)} s` : ''}${s.error ? ` — ${s.error}` : ''}`;
      renderControls(s.state === 'running');
      dashboard(dash, history, s);
    };
    onTopic('load', (m) => {
      if (m.type === 'point') showSnap(m.snapshot as Snapshot);
      else if (m.type === 'started') history.length = 0;
      else if (m.type === 'done') {
        status.textContent = `Finished: ${String(m.verdict).toUpperCase()}`;
        renderControls(false);
        toast(`Load test ${String(m.verdict)}`, { kind: m.verdict === 'pass' ? 'success' : 'warning', action: { label: 'Open results', run: () => navigate(link('load', 'results', String(m.runId))) } });
      } else if (m.type === 'failed') toastError(`Load test failed: ${String(m.error)}`);
    });
    const start = async (): Promise<void> => {
      if (!picker.value) {
        toastError('Choose a scenario');
        return;
      }
      try {
        history.length = 0;
        await api.post('/api/load/runs', { path: picker.value, durationMs: duration.value ? Number(duration.value) * 1000 : undefined });
        status.textContent = 'Starting…';
      } catch (e) {
        toastError((e as Error).message);
      }
    };
    return {
      show: async () => {
        visible = true;
        const r = await api.get<{ scenarios: ScenarioListItem[] }>('/api/load/scenarios').catch(() => ({ scenarios: [] as ScenarioListItem[] }));
        const keep = picker.value;
        clear(picker);
        for (const s of r.scenarios.filter((x) => !x.error)) picker.appendChild(h('option', { value: s.path, text: `${s.name} — ${s.path}` }));
        if (keep) picker.value = keep;
        const a = await api.get<{ active: Snapshot | null }>('/api/load/active').catch(() => ({ active: null }));
        showSnap(a.active);
        void visible;
      },
      hide: () => {
        visible = false;
      },
    };
  },
};

// ------------------------------------------------------------------ Results

const resultsSection: SubPageDef = {
  id: 'results',
  title: 'Results',
  icon: 'compare',
  description: 'Analysis, comparison, trends',
  mount(root) {
    const list = h('div', { class: 'stack' });
    const detail = h('div', { class: 'stack', id: 'load-result' });
    root.appendChild(h('div', { class: 'page-inner' }, pageHeader('Results', 'Every load run with its SLA verdict, automatic analysis (response-time knee, saturated resources, errors), the comparison with a baseline and the trend over runs.'), list, detail));
    const baseline = () => {
      try {
        return localStorage.getItem(BASELINE_KEY) ?? undefined;
      } catch {
        return undefined;
      }
    };
    const showRun = async (runId: string) => {
      const r = await withStates(detail, () => api.get<Results>(`/api/load/results/${encodeURIComponent(runId)}`), { retry: () => void showRun(runId) });
      if (!r) return;
      const tl = r.timeline;
      const xs = tl.map((p) => p.t);
      const base = baseline();
      detail.append(
        card(`${r.scenario.name} · ${dateTime(r.startedAt)}`, h('div', { class: 'stack' },
          h('div', { class: 'row wrap' }, statusBadge(r.verdict), stat(r.totals.requests, 'requests'), stat(fmt(r.totals.rps), 'req/s'), stat(`${(r.totals.errorRate * 100).toFixed(2)}%`, 'errors'), stat(`${fmt(r.totals.latency.p50)} / ${fmt(r.totals.latency.p95)} / ${fmt(r.totals.latency.p99)}`, 'p50 / p95 / p99 ms'), stat(r.totals.maxVus, 'peak VUs')),
          h('div', { class: 'row wrap' }, h('a', { class: 'btn', href: `/runs/${encodeURIComponent(r.runId)}/report.html`, target: '_blank', rel: 'noopener', text: 'Open HTML report' }), button(base === r.runId ? 'Baseline' : 'Set as baseline', { disabled: base === r.runId, onclick: () => {
            try {
              localStorage.setItem(BASELINE_KEY, r.runId);
            } catch {
              // storage unavailable
            }
            void showRun(r.runId);
          } })),
        )),
        card('SLAs', dataTable({ caption: 'SLA results', rows: r.sla.items, empty: 'No SLAs defined.', columns: [{ title: 'SLA', render: (s) => s.sla }, { title: 'Name', render: (s) => s.name }, { title: 'Metric', render: (s) => s.metric }, { title: 'Value', class: 'num', render: (s) => (s.value === null ? '–' : s.unit === 'ratio' ? `${(s.value * 100).toFixed(2)}%` : fmt(s.value)) }, { title: 'Warn', class: 'num', render: (s) => String(s.warn ?? '–') }, { title: 'Fail', class: 'num', render: (s) => String(s.fail ?? '–') }, { title: 'Status', render: (s) => statusBadge(s.status) }] })),
        card('Analysis', r.analysis.findings.length ? h('ul', { class: 'bullets' }, r.analysis.findings.map((f) => h('li', null, sevBadge(f.severity === 'high' ? 'fail' : f.severity === 'medium' ? 'warn' : 'info', f.severity), ' ', h('strong', { text: f.title }), ` ${f.detail}`))) : h('p', { class: 'muted', text: 'No bottleneck, saturation or error pattern found.' })),
        h('div', { class: 'ld-grid2' },
          seriesChart('Active virtual users', xs, [{ label: 'VUs', values: tl.map((p) => p.vus), cls: 's1' }]),
          seriesChart('Throughput', xs, [{ label: 'requests/s', values: tl.map((p) => p.rps), cls: 's2' }, { label: 'errors/s', values: tl.map((p) => p.errors), cls: 's5' }]),
          seriesChart('Response time', xs, [{ label: 'p50', values: tl.map((p) => p.latency?.p50 ?? null), cls: 's1' }, { label: 'p95', values: tl.map((p) => p.latency?.p95 ?? null), cls: 's3' }, { label: 'p99', values: tl.map((p) => p.latency?.p99 ?? null), cls: 's4' }], { unit: ' ms' }),
          ...r.monitors.filter((m) => m.points.length).slice(0, 3).map((m) => {
            const keys = [...new Set(m.points.flatMap((p) => Object.keys(p.values)))].filter((k) => !/count$|^cpus$|^status$/.test(k)).slice(0, 4);
            const by = new Map(m.points.map((p) => [p.t, p.values]));
            return seriesChart(`Monitor: ${m.name}`, xs, keys.map((k, i) => ({ label: k, values: xs.map((t) => by.get(t)?.[k] ?? null), cls: `s${i + 1}` })));
          }),
        ),
        card('Transactions', dataTable<NameStats>({ caption: 'Transactions and requests', rows: r.names.filter((n) => n.kind !== 'iteration'), columns: [
          { title: 'Name', render: (n) => n.name }, { title: 'Kind', render: (n) => n.kind }, { title: 'Count', class: 'num', render: (n) => String(n.count) }, { title: 'Errors', class: 'num', render: (n) => `${n.errors} (${(n.errorRate * 100).toFixed(1)}%)` },
          { title: 'Avg', class: 'num', render: (n) => fmt(n.latency.mean) }, { title: 'p90', class: 'num', render: (n) => fmt(n.latency.p90) }, { title: 'p95', class: 'num', render: (n) => fmt(n.latency.p95) }, { title: 'p99', class: 'num', render: (n) => fmt(n.latency.p99) }, { title: '/s', class: 'num', render: (n) => fmt(n.throughput, 2) },
        ] })),
      );
      if (base && base !== r.runId) {
        const cmp = await api.get<{ regressions: number; improvements: number; rows: Array<{ name: string; verdict: string; reasons: string[]; baseline?: { p95: number }; current?: { p95: number } }> }>(`/api/load/compare?baseline=${encodeURIComponent(base)}&current=${encodeURIComponent(r.runId)}`).catch(() => undefined);
        if (cmp) detail.append(card(`Compared with baseline ${base}`, h('div', { class: 'stack' }, h('p', { text: `${cmp.regressions} regression(s), ${cmp.improvements} improvement(s)` }), dataTable({ caption: 'Baseline comparison', rows: cmp.rows, columns: [{ title: 'Name', render: (x) => x.name }, { title: 'p95 before', class: 'num', render: (x) => fmt(x.baseline?.p95) }, { title: 'p95 now', class: 'num', render: (x) => fmt(x.current?.p95) }, { title: 'Verdict', render: (x) => statusBadge(x.verdict === 'regression' ? 'fail' : x.verdict === 'improvement' ? 'pass' : x.verdict) }, { title: 'Why', render: (x) => x.reasons.join('; ') }] }))));
      }
      const t = await api.get<{ runs: Array<{ runId: string; p95: number; rps: number }>; series: Array<{ name: string; p95: number[]; direction: string; slope: number }> }>(`/api/load/trend?scenario=${encodeURIComponent(r.scenario.name)}`).catch(() => undefined);
      if (t && t.runs.length > 1) detail.append(card('Trend over runs', h('div', { class: 'stack' }, seriesChart('p95 of all requests per run', t.runs.map((_, i) => i + 1), [{ label: 'p95', values: t.runs.map((x) => x.p95), cls: 's3' }], { unit: ' ms', xUnit: '' }), dataTable({ caption: 'Trend per transaction', rows: t.series.slice(0, 20), columns: [{ title: 'Name', render: (x) => x.name }, { title: 'Direction', render: (x) => statusBadge(x.direction === 'worse' ? 'fail' : x.direction === 'better' ? 'pass' : 'flat') }, { title: 'ms per run', class: 'num', render: (x) => fmt(x.slope, 2) }] }))));
    };
    return {
      show: async (segs) => {
        const r = await withStates(list, () => api.get<{ runs: RunListItem[] }>('/api/load/results'), { retry: () => undefined });
        if (!r) return;
        clear(detail);
        if (!r.runs.length) {
          list.appendChild(emptyState('No load runs yet', 'Run a scenario from the Run section or with eztest load run.'));
          return;
        }
        list.appendChild(dataTable<RunListItem>({ caption: 'Load runs', rows: r.runs, columns: [
          { title: 'Run', render: (x) => h('a', { href: link('load', 'results', x.runId), text: x.runId }) }, { title: 'Scenario', render: (x) => x.scenario }, { title: 'When', render: (x) => dateTime(x.startedAt) },
          { title: 'Verdict', render: (x) => statusBadge(x.verdict) }, { title: 'Requests', class: 'num', render: (x) => String(x.requests) }, { title: 'req/s', class: 'num', render: (x) => fmt(x.rps) }, { title: 'p95', class: 'num', render: (x) => fmt(x.p95) }, { title: 'Peak VUs', class: 'num', render: (x) => String(x.maxVus) },
        ] }));
        await showRun(segs[0] ?? r.runs[0].runId);
      },
    };
  },
};

export function registerLoadPage(): void {
  registerSectionPage({ id: 'load', title: 'Performance', icon: 'gauge', order: 59, sections: [designSection, correlationSection, runSection, resultsSection] });
}
