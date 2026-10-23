/**
 * The debugger's side panels: Variables and Ledger (tree, masked values),
 * Step details (resolved locator, candidates tried with match counts, heal
 * ladder, conditions expected vs actual), Console and Network for the step,
 * the call stack (journey > step position) and the breakpoints list.
 */
import { add, clear, h } from '../../core/dom.js';
import { ms } from '../../core/format.js';
import { statusIcon } from '../../ui/badge.js';
import { createTable } from '../../ui/table.js';
import { createTree, type TreeNode } from '../../ui/tree.js';
import { breakpoints, breakpointMenu, editCondition, removeBreakpoint, updateBreakpoint, type Bp } from './breakpoints.js';
import { diffView, kitIcon, meter, pretty, section } from './kit.js';
import { dbg, refreshDetails, type ConsoleEntry, type DbgView, type NetEntry } from './state.js';

export interface StepLine {
  index: number;
  line: number;
  text: string;
  id?: string;
}

export interface PanelContext {
  path(): string | undefined;
  /** Steps of the open journey (index -> line). */
  steps(): StepLine[];
  /** Enclosing blocks (innermost first) of the step at a runtime index. */
  blocks?(index: number): Array<{ text: string; line?: number }>;
  /** Number of top-level steps (runtime indices past it are nested). */
  topCount?(): number;
  goToLine(line: number): void;
}

// ------------------------------------------------------------------ variables

function valueNodes(prefix: string, v: unknown, depth = 0): Array<TreeNode<unknown>> {
  if (v === null || typeof v !== 'object') return [];
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  return entries.slice(0, 500).map(([k, x]) => {
    const id = `${prefix}.${k}`;
    const isObj = x !== null && typeof x === 'object';
    const preview = isObj ? (Array.isArray(x) ? `Array(${x.length})` : `{${Object.keys(x as object).slice(0, 4).join(', ')}${Object.keys(x as object).length > 4 ? ', …' : ''}}`) : JSON.stringify(x);
    return {
      id,
      label: k,
      detail: preview?.length > 120 ? `${preview.slice(0, 117)}…` : preview,
      icon: isObj ? 'folder' : 'dot',
      description: isObj ? undefined : `value ${preview}`,
      class: !isObj && typeof x === 'string' && /\*{4}/.test(x) ? 'masked' : undefined,
      ...(isObj && depth < 6 ? { children: valueNodes(id, x, depth + 1) } : {}),
    } satisfies TreeNode<unknown>;
  });
}

export function mountVariables(el: HTMLElement): void {
  const tree = createTree<unknown>({ label: 'Variables and ledger', class: 'var-tree' });
  const empty = h('p', { class: 'panel-empty', text: 'Variables and captured values appear while paused.' });
  el.append(h('p', { class: 'dbg-note', text: 'Secrets are masked (****).' }), empty, tree.el);
  let sig = '';
  dbg.subscribe((d) => {
    const vars = d.state?.vars ?? {};
    const ledger = d.state?.ledger ?? {};
    const next = JSON.stringify([vars, ledger]);
    if (next === sig) return;
    sig = next;
    const nodes: Array<TreeNode<unknown>> = [
      { id: 'vars', label: 'Variables', detail: `${Object.keys(vars).length}`, children: valueNodes('vars', vars) },
      { id: 'ledger', label: 'Ledger (captured)', detail: `${Object.keys(ledger).length}`, children: valueNodes('ledger', ledger) },
    ];
    empty.hidden = d.phase === 'paused' || !!Object.keys(vars).length || !!Object.keys(ledger).length;
    tree.setNodes(nodes);
  });
}

// ------------------------------------------------------------------ step details

export function mountStepDetails(el: HTMLElement, ctx: PanelContext): void {
  const body = h('div', { class: 'step-details', id: 'dbg-step-details' });
  const picker = h('select', { class: 'input input-sm', 'aria-label': 'Show details of step' });
  el.append(h('div', { class: 'panel-toolbar' }, h('label', { class: 'small muted', text: 'Step' }), picker), body);
  picker.addEventListener('change', () => {
    const i = Number(picker.value);
    dbg.patch({ detailIndex: i });
    void refreshDetails(i);
  });
  dbg.subscribe((d) => {
    const steps = ctx.steps();
    const sel = d.detailIndex ?? d.details?.step?.index ?? d.current;
    clear(picker);
    for (const s of steps) picker.appendChild(h('option', { value: String(s.index), text: `${s.index + 1}. ${s.text}`, selected: s.index === sel }));
    renderDetails(body, d);
  });
}

function renderDetails(body: HTMLElement, d: DbgView): void {
  clear(body);
  const s = d.details?.step;
  const failed = d.state?.phase === 'failed' && d.state.lastResult && (d.detailIndex === undefined || d.detailIndex === d.state.stepIndex) ? d.state.lastResult : undefined;
  if (!s && !failed) {
    body.appendChild(h('p', { class: 'panel-empty', text: d.phase === 'idle' ? 'Start a debug run to see how each step resolved its target.' : 'This step has not run yet.' }));
    return;
  }
  const status = failed ? 'failed' : (s?.status ?? 'running');
  add(
    body,
    h('div', { class: 'sd-head' }, statusIcon(status), h('strong', { text: s?.intent || failed?.intent || '' }), h('span', { class: 'muted small', text: [s?.durationMs !== undefined ? ms(s.durationMs) : '', s && s.execution > 1 ? `run ${s.execution}× (edited)` : ''].filter(Boolean).join(' · ') })),
    failed?.error ? h('p', { class: 'error-note', role: 'alert', text: failed.error.message }) : null,
  );
  if (s) {
    add(
      body,
      section(
        'Resolved locator',
        s.used ? h('code', { class: 'sd-used', text: s.used.description }) : h('p', { class: 'muted', text: s.tried.length ? 'No candidate resolved to exactly one element.' : 'This step has no target.' }),
      ),
      s.tried.length
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
                s.tried.map((t) =>
                  h(
                    'tr',
                    { class: t.count === 1 ? 'row-ok' : 'row-bad' },
                    h('td', null, h('code', { text: t.description }), t.error ? h('p', { class: 'error-note', text: t.error }) : null),
                    h('td', null, h('span', { class: ['pill', t.count === 1 ? 'pill-ok' : t.count === 0 ? 'pill-bad' : 'pill-warn'], text: t.count < 0 ? 'invalid' : t.count === 1 ? '1 (unique)' : `${t.count}` })),
                  ),
                ),
              ),
            ),
            s.notes.length ? h('ul', { class: 'bullets small muted' }, s.notes.map((n) => h('li', { text: n }))) : null,
          )
        : null,
      s.heal.attempts.length || s.heal.notes.length
        ? section(
            'Heal ladder',
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
  const conds = s?.conditions.length
    ? s.conditions.map((c) => ({ text: c.text, expected: c.expected, actual: c.actual, passed: c.passed, message: c.message }))
    : (failed?.conditions ?? []).map((c) => ({ text: c.condition.type, expected: String(c.condition.value ?? c.condition.pattern ?? c.condition.expected ?? ''), actual: c.actual, passed: c.passed, message: c.message }));
  if (conds.length) body.appendChild(conditionsTable(conds));
}

export function conditionsTable(conds: Array<{ text: string; expected?: string; actual?: string; passed: boolean; message?: string }>): HTMLElement {
  return section(
    'Conditions',
    h(
      'table',
      { class: 'table compact cond-table' },
      h('caption', { class: 'sr-only', text: 'Post-conditions, expected versus actual' }),
      h('thead', null, h('tr', null, ['', 'Condition', 'Expected', 'Actual'].map((t, i) => h('th', { scope: 'col' }, i === 0 ? h('span', { class: 'sr-only', text: 'Result' }) : t)))),
      h(
        'tbody',
        null,
        conds.map((c) =>
          h(
            'tr',
            { class: c.passed ? 'row-ok' : 'row-bad' },
            h('td', null, statusIcon(c.passed ? 'passed' : 'failed')),
            h('td', null, h('span', { text: c.text }), c.message && !c.passed ? h('p', { class: 'error-note', text: c.message }) : null),
            h('td', null, h('code', { text: c.expected ?? '' })),
            h('td', null, c.passed || c.expected === undefined || c.actual === undefined || c.actual.length > 160 ? h('code', { class: 'cond-actual', text: c.actual && c.actual.length > 400 ? `${c.actual.slice(0, 400)}…` : (c.actual ?? '') }) : diffView(c.expected, c.actual, `Difference between expected and actual for ${c.text}`)),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ console and network

export function consoleList(entries: Array<Pick<ConsoleEntry, 'type' | 'text' | 'location'>>, empty: string): HTMLElement {
  if (!entries.length) return h('p', { class: 'panel-empty', text: empty });
  return h(
    'ol',
    { class: 'console-list', 'aria-label': 'Console messages' },
    entries.map((c) =>
      h(
        'li',
        { class: ['console-row', `ct-${c.type}`] },
        h('span', { class: 'console-type', text: c.type }),
        h('span', { class: 'console-text', text: c.text }),
        c.location ? h('span', { class: 'console-loc', text: c.location.replace(/^https?:\/\/[^/]+/, '') }) : null,
      ),
    ),
  );
}

export function mountConsole(el: HTMLElement): void {
  const body = h('div', { class: 'dbg-console' });
  el.appendChild(body);
  dbg.select((d) => d.details?.console ?? [], (a, b) => JSON.stringify(a) === JSON.stringify(b)).subscribe((list) => {
    clear(body).appendChild(consoleList(list, 'No console messages during this step.'));
  });
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return u;
  }
}

/** A key/value block of headers. */
export function headerList(title: string, headers: Record<string, string> | undefined): HTMLElement | null {
  if (!headers || !Object.keys(headers).length) return null;
  return section(title, h('dl', { class: 'kv hdrs' }, Object.entries(headers).map(([k, v]) => [h('dt', { text: k }), h('dd', { class: 'mono', text: v })])));
}

export function bodyBlock(title: string, text: string | undefined, contentType?: string): HTMLElement | null {
  if (!text) return null;
  return section(title, h('pre', { class: 'code-preview body-pre', tabindex: '0', 'aria-label': title, text: pretty(text, contentType) }));
}

export function mountNetwork(el: HTMLElement): void {
  const detail = h('div', { class: 'net-detail', id: 'dbg-net-detail' });
  const table = createTable<NetEntry>({
    label: 'Network requests of this step',
    key: (r) => String(r.id),
    rowHeight: 28,
    columns: [
      { id: 'method', title: 'Method', width: '4.5rem', value: (r) => r.method },
      { id: 'status', title: 'Status', width: '4rem', value: (r) => r.status ?? (r.failure ? 'failed' : ''), render: (r) => h('span', { class: (r.status ?? 0) >= 400 || r.failure ? 'bad-text' : '', text: String(r.status ?? (r.failure ? 'failed' : '…')) }) },
      { id: 'url', title: 'URL', width: 'minmax(8rem, 1fr)', value: (r) => r.url, render: (r) => h('span', { class: 'mono', title: r.url, text: shortUrl(r.url) }) },
      { id: 'time', title: 'Time', width: '4.5rem', align: 'end', value: (r) => r.durationMs, render: (r) => ms(r.durationMs) },
    ],
    empty: 'No requests during this step.',
    onSelect: (r) => showNet(r),
  });
  const showNet = (r: NetEntry) =>
    render(
      detail,
      h('p', { class: 'net-title' }, h('strong', { text: `${r.method} ` }), h('span', { class: 'mono', text: r.url })),
      h('p', { class: 'muted small', text: [r.status ? `HTTP ${r.status}` : r.failure, r.resourceType, r.mimeType, r.durationMs !== undefined ? ms(r.durationMs) : ''].filter(Boolean).join(' · ') }),
      headerList('Request headers', r.requestHeaders),
      bodyBlock('Request body', r.requestBody, r.requestHeaders?.['content-type']),
      headerList('Response headers', r.responseHeaders),
      bodyBlock('Response body', r.responseBody, r.mimeType),
    );
  el.append(h('div', { class: 'table-frame net-frame' }, table.el), detail);
  dbg.select((d) => d.details?.network ?? [], (a, b) => JSON.stringify(a) === JSON.stringify(b)).subscribe((list) => {
    table.setRows(list);
    clear(detail);
  });
}

function render(el: HTMLElement, ...children: Array<Node | null>): void {
  clear(el);
  for (const c of children) if (c) el.appendChild(c);
}

// ------------------------------------------------------------------ call stack

export function mountCallStack(el: HTMLElement, ctx: PanelContext): void {
  const list = h('ol', { class: 'call-stack', 'aria-label': 'Journey and step position' });
  el.appendChild(list);
  dbg.subscribe((d) => {
    clear(list);
    const st = d.state;
    if (!d.id || !st?.journeyId) {
      list.appendChild(h('li', { class: 'panel-empty', text: 'Not debugging.' }));
      return;
    }
    const steps = ctx.steps();
    const cur = d.current ?? st.stepIndex ?? 0;
    const phase = st.phase ? ` (${st.phase.replace('-', ' ')})` : '';
    const frames: Array<{ label: string; detail: string; line?: number; status?: string; current?: boolean }> = [];
    const s = steps.find((x) => x.index === cur);
    const top = ctx.topCount?.() ?? Number.MAX_SAFE_INTEGER;
    const name = (i: number) => (i < top ? `Step ${i + 1}` : 'Nested step');
    frames.push({ label: `${name(cur)}${phase}`, detail: s?.text ?? st.intent ?? '', line: s?.line || undefined, status: d.steps[cur]?.status ?? (d.phase === 'paused' ? 'paused' : 'running'), current: true });
    for (const b of ctx.blocks?.(cur) ?? []) frames.push({ label: 'in block', detail: b.text, line: b.line });
    // Earlier executions, most recent first (loop iterations show up once per run).
    const order = d.order ?? [];
    const at = order.lastIndexOf(cur);
    const before = (at >= 0 ? order.slice(0, at) : [...Array(cur).keys()]).reverse().slice(0, 40);
    for (const i of before) {
      const x = steps.find((y) => y.index === i);
      frames.push({ label: name(i), detail: x?.text ?? d.steps[i]?.intent ?? '', line: x?.line || undefined, status: d.steps[i]?.status });
    }
    frames.push({ label: `${st.journeyName ?? st.journeyId}`, detail: `journey ${st.journeyId} · attempt ${st.attempt ?? 1}${st.url ? ` · ${st.url}` : ''}` });
    for (const f of frames) {
      list.appendChild(
        h(
          'li',
          { class: ['cs-frame', f.current && 'current'] },
          h(
            'button',
            { type: 'button', class: 'cs-btn', disabled: f.line === undefined, 'aria-current': f.current ? 'step' : undefined, onclick: () => f.line && ctx.goToLine(f.line) },
            f.status ? statusIcon(f.status === 'paused' ? 'queued' : f.status) : kitIcon('layers', { size: 14 }),
            h('span', { class: 'cs-label', text: f.label }),
            h('span', { class: 'cs-detail', text: f.detail }),
          ),
        ),
      );
    }
  });
}

// ------------------------------------------------------------------ breakpoints list

export function mountBreakpoints(el: HTMLElement, ctx: PanelContext, pauseOnFailure: HTMLElement): void {
  const list = h('ul', { class: 'bp-list', id: 'dbg-bp-list', 'aria-label': 'Breakpoints' });
  const tools = h(
    'div',
    { class: 'panel-toolbar' },
    pauseOnFailure,
    h('span', { class: 'tb-spacer' }),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => breakpoints.get().filter((b) => b.path === ctx.path()).forEach((b) => updateBreakpoint(b.id, { enabled: false })), text: 'Disable all' }),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => breakpoints.get().filter((b) => b.path === ctx.path()).forEach((b) => removeBreakpoint(b.id)), text: 'Remove all' }),
  );
  el.append(tools, list);
  const draw = () => {
    clear(list);
    const path = ctx.path();
    const all = [...breakpoints.get()].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path === path ? -1 : b.path === path ? 1 : a.path.localeCompare(b.path)));
    if (!all.length) {
      list.appendChild(h('li', { class: 'panel-empty', text: 'No breakpoints. Click the gutter next to a step (or press F9).' }));
      return;
    }
    const steps = ctx.steps();
    for (const b of all) list.appendChild(bpRow(b, b.path === path ? steps.find((s) => s.line === b.line) : undefined, ctx));
  };
  breakpoints.subscribe(draw);
  dbg.select((d) => d.state?.breakpoints.map((b) => `${b.id}:${b.hits}`).join(',') ?? '').subscribe(draw, false);

}

function bpRow(b: Bp, step: StepLine | undefined, ctx: PanelContext): HTMLElement {
  const label = step ? `Step ${step.index + 1}: ${step.text}` : `${b.path}:${b.line}`;
  const cb = h('input', { type: 'checkbox', checked: b.enabled, 'aria-label': `Enable breakpoint at ${label}`, onchange: (e: Event) => updateBreakpoint(b.id, { enabled: (e.target as HTMLInputElement).checked }) });
  return h(
    'li',
    { class: ['bp-row', !b.enabled && 'off'] },
    cb,
    h('span', { class: ['bp-dot', !b.enabled && 'off', b.condition && 'cond'], 'aria-hidden': 'true' }),
    h(
      'button',
      {
        type: 'button',
        class: 'bp-label',
        onclick: () => b.path === ctx.path() && ctx.goToLine(b.line),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          breakpointMenu(b.path, b.line, e.clientX, e.clientY, step?.text ?? '');
        },
      },
      h('span', { class: 'bp-text', text: label }),
      h('span', { class: 'bp-where muted small', text: `${b.path.split('/').pop()}:${b.line}${b.hits ? ` · hit ${b.hits}×` : ''}` }),
      b.condition ? h('span', { class: 'bp-cond', text: `when ${b.condition}` }) : null,
    ),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit condition of ${label}`, title: 'Condition…', onclick: () => void editCondition(b.path, b.line, step?.text ?? '') }, kitIcon('edit', { size: 14 })),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove breakpoint at ${label}`, title: 'Remove', onclick: () => removeBreakpoint(b.id) }, kitIcon('x', { size: 14 })),
  );
}
