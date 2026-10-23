/**
 * The trace viewer's step tabs: Action (locator used, candidates tried with
 * counts, heal ladder with confidence, phase timings), Conditions (expected
 * vs actual with a word diff), Network (waterfall, headers and bodies, JSON
 * pretty-printed, masked by the server), Console and Evidence (ids and the
 * hash-chain / bundle integrity badge).
 */
import { api } from '../../core/api.js';
import { add, clear, h } from '../../core/dom.js';
import { ms } from '../../core/format.js';
import type { RunDetail } from '../../core/registry.js';
import { badge, statusIcon } from '../../ui/badge.js';
import { createTable } from '../../ui/table.js';
import { createTabs, type TabsHandle } from '../../ui/tabs.js';
import { kitIcon, meter, section } from '../debug/kit.js';
import { bodyBlock, conditionsTable, consoleList, headerList } from '../debug/panels.js';
import { nestLabel, type Nest } from './nesting.js';
import { PHASES, assetText, type NetworkEntry, type TraceFile, type TraceSource, type TraceStep } from './model.js';

export interface StepTabs {
  el: HTMLElement;
  tabs: TabsHandle;
  show(step: TraceStep | undefined): void;
}

function kvRow(k: string, v: Node | string | undefined | null): Node[] {
  if (v === undefined || v === null || v === '') return [];
  return [h('dt', { text: k }), h('dd', null, v)];
}

function actionTab(el: HTMLElement, s: TraceStep, nest?: Nest): void {
  const total = Math.max(1, s.durationMs);
  const bar = h('div', { class: 'phase-bar', role: 'img', 'aria-label': PHASES.map((p) => `${p.label} ${ms(s.timings[p.key] ?? 0)}`).join(', ') });
  for (const p of PHASES) {
    const v = s.timings[p.key];
    if (!v) continue;
    const seg = h('span', { class: ['phase-seg', p.cls], title: `${p.label}: ${ms(v)}` });
    seg.style.width = `${Math.max(1, (v / total) * 100)}%`;
    bar.appendChild(seg);
  }
  add(
    el,
    h('div', { class: 'sd-head' }, statusIcon(s.status), h('strong', { text: s.intent }), s.edited ? h('span', { class: 'pill pill-warn', text: 'edited in debugger' }) : null),
    s.error ? h('p', { class: 'error-note', role: 'note', text: s.error }) : null,
    h(
      'dl',
      { class: 'kv' },
      kvRow('Nesting', nest ? nestLabel(nest) : undefined),
      kvRow('Action', s.action),
      kvRow('Target', s.targetDescription),
      kvRow('Value', s.value),
      kvRow('Locator used', s.locator.usedDescription ? h('code', { class: 'trace-used', text: s.locator.usedDescription }) : 'none'),
      kvRow('URL before', s.url.before),
      kvRow('URL after', s.url.after !== s.url.before ? s.url.after : undefined),
      kvRow('Duration', ms(s.durationMs)),
    ),
    section(
      'Timing',
      bar,
      h('ul', { class: 'phase-legend' }, PHASES.map((p) => h('li', null, h('span', { class: ['phase-swatch', p.cls], 'aria-hidden': 'true' }), `${p.label} ${ms(s.timings[p.key] ?? 0) || '0 ms'}`)), s.timings.snapshotMs ? h('li', { class: 'muted', text: `snapshots ${ms(s.timings.snapshotMs)}` }) : null),
    ),
    s.locator.tried.length
      ? section(
          'Candidates tried',
          h(
            'table',
            { class: 'table compact' },
            h('caption', { class: 'sr-only', text: 'Locator candidates tried, in order' }),
            h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Locator' }), h('th', { scope: 'col', text: 'Matches' }))),
            h(
              'tbody',
              null,
              s.locator.tried.map((t) =>
                h(
                  'tr',
                  { class: t.count === 1 ? 'row-ok' : 'row-bad' },
                  h('td', null, h('code', { text: t.description }), t.error ? h('p', { class: 'error-note', text: t.error }) : null),
                  h('td', null, h('span', { class: ['pill', t.count === 1 ? 'pill-ok' : t.count === 0 ? 'pill-bad' : 'pill-warn'], text: t.count < 0 ? 'invalid' : t.count === 1 ? '1 (unique)' : String(t.count) })),
                ),
              ),
            ),
          ),
        )
      : null,
    s.heal && (s.heal.attempts.length || s.heal.notes.length)
      ? section(
          'Heal ladder',
          s.heal.record ? h('p', null, badge(s.heal.record.verified ? 'passed-healed' : 'failed', s.heal.record.verified ? `Healed via ${s.heal.record.tier}, verified` : `Heal via ${s.heal.record.tier} not verified`), ' ', h('span', { class: 'muted small', text: s.heal.record.reason })) : null,
          h(
            'ol',
            { class: 'heal-ladder' },
            s.heal.attempts.map((a) => h('li', { class: 'heal-rung' }, h('span', { class: 'chip', text: a.tier }), h('code', { text: a.description }), meter(a.confidence, 'Confidence'), h('span', { class: 'muted small', text: `${a.matches} match${a.matches === 1 ? '' : 'es'}` }), h('p', { class: 'small', text: a.reason }))),
          ),
          s.heal.notes.length ? h('ul', { class: 'bullets small muted' }, s.heal.notes.map((n) => h('li', { text: n }))) : null,
        )
      : null,
  );
}

function conditionsTab(el: HTMLElement, s: TraceStep): void {
  if (!s.conditions.length) {
    el.appendChild(h('p', { class: 'panel-empty', text: 'This step has no post-conditions.' }));
    return;
  }
  el.appendChild(conditionsTable(s.conditions));
}

function consoleTab(el: HTMLElement, s: TraceStep): void {
  el.appendChild(consoleList(s.console, 'No console messages during this step.'));
}

/** Network waterfall (virtualized) with a request detail pane. */
function networkTab(el: HTMLElement, source: TraceSource, s: TraceStep): void {
  const entries = s.network;
  const t0 = Math.min(...entries.map((n) => Date.parse(n.startedAt)).filter(Number.isFinite), Date.parse(s.startedAt));
  const t1 = Math.max(...entries.map((n) => Date.parse(n.startedAt) + (n.durationMs ?? 0)).filter(Number.isFinite), Date.parse(s.startedAt) + s.durationMs);
  const span = Math.max(1, t1 - t0);
  const detail = h('div', { class: 'net-detail' });
  const filter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter requests', 'aria-label': 'Filter requests' });
  const short = (u: string) => {
    try {
      const x = new URL(u);
      return `${x.pathname}${x.search}`;
    } catch {
      return u;
    }
  };
  const table = createTable<NetworkEntry & { k: number }>({
    label: `Network requests of step ${s.index + 1}`,
    key: (r) => String(r.k),
    rowHeight: 28,
    rows: entries.map((n, k) => ({ ...n, k })),
    columns: [
      { id: 'method', title: 'Method', width: '4.2rem', value: (r) => r.method, sortable: true },
      { id: 'status', title: 'Status', width: '3.8rem', sortable: true, value: (r) => r.status ?? 0, render: (r) => h('span', { class: (r.status ?? 0) >= 400 || r.failure ? 'bad-text' : '', text: String(r.status ?? (r.failure ? 'failed' : '')) }) },
      { id: 'url', title: 'URL', width: 'minmax(8rem, 1.4fr)', sortable: true, value: (r) => r.url, render: (r) => h('span', { class: 'mono', title: r.url, text: short(r.url) }) },
      { id: 'type', title: 'Type', width: '4.8rem', sortable: true, value: (r) => r.resourceType },
      {
        id: 'wf',
        title: 'Waterfall',
        width: 'minmax(6rem, 1fr)',
        value: (r) => Date.parse(r.startedAt),
        sortable: true,
        render: (r) => {
          const start = Date.parse(r.startedAt) - t0;
          const d = r.durationMs ?? 0;
          const bar = h('span', { class: ['wf-bar', (r.status ?? 0) >= 400 || r.failure ? 'bad' : ''], title: `${ms(d) || '0 ms'} (wait ${ms(r.timing?.waitMs) || '–'}, receive ${ms(r.timing?.receiveMs) || '–'})` });
          bar.style.left = `${(start / span) * 100}%`;
          bar.style.width = `${Math.max(0.8, (d / span) * 100)}%`;
          return h('span', { class: 'wf-track' }, bar);
        },
      },
      { id: 'time', title: 'Time', width: '4.2rem', align: 'end', sortable: true, value: (r) => r.durationMs, render: (r) => ms(r.durationMs) },
    ],
    empty: 'No requests during this step.',
    onSelect: (r) => void showDetail(r),
  });
  filter.addEventListener('input', () => table.setFilter(filter.value));
  const showDetail = async (r: NetworkEntry) => {
    clear(detail).append(
      h('p', { class: 'net-title' }, h('strong', { text: `${r.method} ` }), h('span', { class: 'mono', text: r.url })),
      h('p', { class: 'muted small', text: [r.status ? `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}` : r.failure, r.resourceType, r.mimeType, r.durationMs !== undefined ? ms(r.durationMs) : '', r.sizes ? `${r.sizes.responseBody} B` : ''].filter(Boolean).join(' · ') }),
    );
    if (r.timing) {
      detail.appendChild(h('dl', { class: 'kv small' }, kvRow('DNS', ms(r.timing.dnsMs)), kvRow('Connect', ms(r.timing.connectMs)), kvRow('Waiting (TTFB)', ms(r.timing.waitMs)), kvRow('Receive', ms(r.timing.receiveMs))));
    }
    const hReq = headerList('Request headers', r.requestHeaders);
    if (hReq) detail.appendChild(hReq);
    const body = async (title: string, b: NetworkEntry['requestBody'], ct?: string) => {
      if (!b) return null;
      if (b.omitted) return section(title, h('p', { class: 'muted', text: `Not captured: ${b.omitted}` }));
      let text = b.text;
      if (text === undefined && b.path) text = await assetText(source, b.path).catch((e) => `(could not load: ${(e as Error).message})`);
      const blk = bodyBlock(title, text, ct);
      if (blk && b.truncated) blk.appendChild(h('p', { class: 'muted small', text: `Truncated (${b.size} bytes in total)` }));
      return blk;
    };
    const reqBody = await body('Request body', r.requestBody, r.requestHeaders['content-type']);
    if (reqBody) detail.appendChild(reqBody);
    const hRes = headerList('Response headers', r.responseHeaders);
    if (hRes) detail.appendChild(hRes);
    const resBody = await body('Response body', r.responseBody, r.mimeType);
    if (resBody) detail.appendChild(resBody);
  };
  el.append(h('div', { class: 'panel-toolbar' }, filter, h('span', { class: 'muted small', text: `${entries.length} request${entries.length === 1 ? '' : 's'}` })), h('div', { class: 'table-frame net-frame' }, table.el), detail);
}

async function evidenceTab(el: HTMLElement, source: TraceSource, trace: TraceFile, s: TraceStep, runDetail: () => Promise<RunDetail | undefined>): Promise<void> {
  const rows: Node[] = [];
  if (source.kind === 'uploaded') {
    rows.push(
      h(
        'p',
        { class: 'row' },
        source.verified
          ? badge('ok', `${source.bundleKind === 'browser' ? 'Browser trace' : 'Bundle'} integrity verified`)
          : badge('bad', `${source.bundleKind === 'browser' ? 'Browser trace' : 'Bundle'} integrity: ${source.problems.length} problem${source.problems.length === 1 ? '' : 's'}`),
      ),
    );
    if (source.problems.length) rows.push(h('ul', { class: 'bullets bad-text' }, source.problems.slice(0, 20).map((p) => h('li', { text: p }))));
  } else {
    const d = await runDetail();
    if (d) {
      rows.push(h('p', { class: 'row trace-chain' }, d.verification.ok ? badge('ok', `Chain verified (${d.verification.entries} entries)`) : badge('bad', 'Evidence chain broken')));
      const j = d.run.journeys.find((x) => x.journeyId === trace.journeyId && x.attempt === trace.attempt) ?? d.run.journeys.find((x) => x.journeyId === trace.journeyId);
      const st = j?.steps.find((x) => x.stepId === s.stepId);
      const ids = [...new Set([...(st?.evidence ?? []), ...(s.screenshot?.evidenceId ? [s.screenshot.evidenceId] : [])])];
      const traceIds = (j?.evidence ?? []).filter((id) => d.evidence[id]?.kind === 'trace');
      rows.push(
        h(
          'table',
          { class: 'table compact' },
          h('caption', { class: 'sr-only', text: 'Evidence for this step' }),
          h('thead', null, h('tr', null, ['Id', 'Kind', 'File'].map((t) => h('th', { scope: 'col', text: t })))),
          h(
            'tbody',
            null,
            [...ids, ...traceIds].map((id) => h('tr', null, h('td', null, h('code', { text: id })), h('td', { text: d.evidence[id]?.kind ?? '' }), h('td', { class: 'mono small', text: d.evidence[id]?.path ?? '' }))),
          ),
        ),
      );
      if (!ids.length && !traceIds.length) rows.push(h('p', { class: 'muted', text: 'No evidence ids recorded for this step.' }));
    } else rows.push(h('p', { class: 'muted', text: 'Run details are not available.' }));
  }
  if (s.screenshot?.viewportJpeg) rows.push(h('p', { class: 'muted small' }, 'Viewport capture: ', h('code', { text: s.screenshot.viewportJpeg })));
  clear(el).append(...rows);
}

export function createStepTabs(o: { source: TraceSource; trace: TraceFile; runDetail(): Promise<RunDetail | undefined>; nestOf?(s: TraceStep): Nest | undefined }): StepTabs {
  const panels: Record<string, HTMLElement> = {};
  let current: TraceStep | undefined;
  const renderers: Record<string, (el: HTMLElement, s: TraceStep) => void> = {
    action: (el, s) => actionTab(el, s, o.nestOf?.(s)),
    conditions: conditionsTab,
    network: (el, s) => networkTab(el, o.source, s),
    console: consoleTab,
    evidence: (el, s) => void evidenceTab(el, o.source, o.trace, s, o.runDetail),
  };
  const renderTab = (id: string) => {
    const el = panels[id];
    if (!el) return;
    clear(el);
    if (!current) {
      el.appendChild(h('p', { class: 'panel-empty', text: 'Select a step.' }));
      return;
    }
    renderers[id](el, current);
  };
  const def = (id: string, title: string) => ({
    id,
    title,
    mount: (el: HTMLElement) => {
      panels[id] = h('div', { class: 'trace-tab-body' });
      el.appendChild(panels[id]);
      renderTab(id);
    },
  });
  const tabs = createTabs({
    label: 'Step details',
    class: 'trace-tabs',
    tabs: [def('action', 'Action'), def('conditions', 'Conditions'), def('network', 'Network'), def('console', 'Console'), def('evidence', 'Evidence')],
    onSelect: (id) => renderTab(id),
  });
  return {
    el: h('section', { class: 'trace-details', 'aria-label': 'Step details' }, tabs.el),
    tabs,
    show(s) {
      current = s;
      tabs.setBadge('network', s?.network.length || undefined);
      tabs.setBadge('console', s?.console.length || undefined);
      const failedConds = s?.conditions.filter((c) => !c.passed).length;
      tabs.setBadge('conditions', s?.conditions.length ? (failedConds ? `${failedConds}✖` : s.conditions.length) : undefined);
      for (const id of Object.keys(panels)) {
        // Only the visible tab renders now; others render when selected.
        if (id === tabs.selected) renderTab(id);
      }
    },
  };
}

export { api, kitIcon };
