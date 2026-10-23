/**
 * Built-in bottom panels (Problems: every validation error across journeys,
 * live; Output: the event stream) and status bar items (connection, branch,
 * problems, active run, file watching).
 */
import { add, clear, h } from '../core/dom.js';
import { connection, onTopic, type HubMessage } from '../core/events.js';
import { plural } from '../core/format.js';
import { registerCommand, registerPanel, registerStatusItem } from '../core/registry.js';
import { link, navigate } from '../core/router.js';
import { activeRun, problemCount, problems, session } from '../core/state.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { showPanel, togglePanel } from '../ui/shell.js';
import { openJourneyAt } from './journeys/page.js';

const outputCount = store<number | undefined>(undefined);

function mountProblems(el: HTMLElement): void {
  const filter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter problems', 'aria-label': 'Filter problems' });
  const list = h('ul', { class: 'problems', 'aria-label': 'Problems by file' });
  const summary = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  el.classList.add('panel-problems');
  el.append(h('div', { class: 'panel-toolbar' }, filter, summary), list);
  const render = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const entries = Object.entries(problems.get()).sort(([a], [b]) => a.localeCompare(b));
    let shown = 0;
    for (const [path, errs] of entries) {
      const items = errs.filter((e) => !q || path.toLowerCase().includes(q) || e.message.toLowerCase().includes(q));
      if (!items.length) continue;
      shown += items.length;
      list.appendChild(
        h(
          'li',
          { class: 'problem-file' },
          h('p', { class: 'problem-path' }, icon('file', { size: 13 }), h('span', { text: path }), h('span', { class: 'count-pill', text: String(items.length) })),
          h(
            'ul',
            null,
            items.map((e) =>
              h(
                'li',
                null,
                h(
                  'button',
                  { type: 'button', class: 'problem', onclick: () => openJourneyAt(path, e.line) },
                  icon('alert', { size: 13, class: 'problem-icon' }),
                  h('span', { class: 'problem-msg', text: e.message.replace(/^line \d+:\s*/, '') }),
                  h('span', { class: 'problem-loc', text: e.line ? `Ln ${e.line}${e.column ? `, Col ${e.column}` : ''}` : '' }),
                ),
              ),
            ),
          ),
        ),
      );
    }
    summary.textContent = shown ? `${plural(shown, 'problem')} in ${plural(entries.length, 'file')}` : 'No problems in any journey.';
    if (!shown) list.appendChild(h('li', { class: 'panel-empty' }, icon('check', { size: 14 }), h('span', { text: ' No problems have been detected in the journeys.' })));
  };
  filter.addEventListener('input', render);
  problems.subscribe(render);
}

function summarize(m: HubMessage): string {
  const skip = new Set(['seq', 'topic', 'at', 'type']);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (skip.has(k) || v === undefined || typeof v === 'object') continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(' ').slice(0, 240);
}

function mountOutput(el: HTMLElement): void {
  const topicSel = h('select', { class: 'input input-sm', 'aria-label': 'Show topic' }, h('option', { value: '', text: 'All topics' }));
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm', text: 'Clear' });
  const log = h('ol', { class: 'output-log', 'aria-label': 'Event log' });
  el.classList.add('panel-output');
  el.append(h('div', { class: 'panel-toolbar' }, topicSel, clearBtn), log);
  const topics = new Set<string>();
  const items: HubMessage[] = [];
  const row = (m: HubMessage) =>
    h('li', { class: `out-row t-${m.topic}`, dataset: { topic: m.topic } }, h('time', { text: new Date(m.at).toLocaleTimeString() }), h('span', { class: 'out-topic', text: m.topic }), h('span', { class: 'out-type', text: m.type }), h('span', { class: 'out-msg', text: summarize(m) }));
  const render = () => {
    clear(log);
    for (const m of items) if (!topicSel.value || m.topic === topicSel.value) log.appendChild(row(m));
    log.scrollTop = log.scrollHeight;
  };
  topicSel.addEventListener('change', render);
  clearBtn.addEventListener('click', () => {
    items.length = 0;
    outputCount.set(undefined);
    render();
  });
  onTopic('*', (m) => {
    if (m.topic === 'system') return;
    items.push(m);
    if (items.length > 1000) items.splice(0, items.length - 1000);
    if (!topics.has(m.topic)) {
      topics.add(m.topic);
      topicSel.appendChild(h('option', { value: m.topic, text: m.topic }));
    }
    if (!topicSel.value || m.topic === topicSel.value) {
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
      log.appendChild(row(m));
      if (log.childElementCount > 1000) log.firstElementChild?.remove();
      if (stick) log.scrollTop = log.scrollHeight;
    }
  });
}

export function registerPanelsAndStatus(): void {
  registerPanel({ id: 'problems', title: 'Problems', order: 10, badge: problemCount, mount: mountProblems });
  registerPanel({ id: 'output', title: 'Output', order: 20, badge: outputCount, mount: mountOutput });

  registerStatusItem({
    id: 'connection',
    align: 'left',
    order: 10,
    mount(el) {
      connection.subscribe((c) => {
        clear(el).append(h('span', { class: `conn-dot conn-${c}`, 'aria-hidden': 'true' }), h('span', { text: c === 'open' ? 'Connected' : c === 'connecting' ? 'Connecting…' : 'Reconnecting…' }));
        el.title = c === 'open' ? 'Live updates are on' : 'Live updates are reconnecting';
      });
    },
  });
  registerStatusItem({
    id: 'branch',
    align: 'left',
    order: 20,
    mount(el) {
      session.subscribe((s) => {
        clear(el);
        el.hidden = !s?.branch;
        if (s?.branch) el.append(icon('branch', { size: 13 }), h('span', { text: s.branch }));
      });
    },
  });
  registerStatusItem({
    id: 'problems',
    align: 'left',
    order: 30,
    mount(el) {
      const btn = h('button', { type: 'button', class: 'sb-btn', id: 'status-problems', onclick: () => showPanel('problems', true) });
      el.appendChild(btn);
      problemCount.subscribe((n) => {
        clear(btn).append(icon(n ? 'alert' : 'check', { size: 13 }), h('span', { text: n ? plural(n, 'problem') : 'No problems' }));
        btn.setAttribute('aria-label', n ? `${plural(n, 'problem')}: open the Problems panel` : 'No problems: open the Problems panel');
        btn.classList.toggle('has-problems', n > 0);
      });
    },
  });
  registerStatusItem({
    id: 'run',
    align: 'left',
    order: 40,
    mount(el) {
      const btn = h('button', { type: 'button', class: 'sb-btn sb-run', id: 'status-run' });
      el.appendChild(btn);
      activeRun.subscribe((r) => {
        clear(btn);
        btn.hidden = !r;
        if (!r) return;
        btn.onclick = () => navigate(link('run', r.id));
        const label = r.state === 'cancelling' ? 'Cancelling…' : r.state === 'analyzing' ? 'Analyzing…' : `Running ${r.done}/${r.total}`;
        add(btn, h('span', { class: 'spinner sm', 'aria-hidden': 'true' }), h('span', { text: label }), r.current ? ' ' : null, r.current ? h('span', { class: 'sb-faint', text: r.current }) : null);
        // The name starts with the visible text (WCAG 2.5.3 label in name).
        btn.setAttribute('aria-label', `${label}${r.current ? ` ${r.current}` : ''}: show live progress`);
      });
    },
  });
  registerStatusItem({
    id: 'watching',
    align: 'right',
    order: 10,
    mount(el) {
      session.subscribe((s) => {
        clear(el);
        if (s?.watching) el.append(icon('eye', { size: 13 }), h('span', { text: s.watching === 'watch' ? 'Watching files' : 'Polling files' }));
      });
    },
  });
  registerStatusItem({
    id: 'panel',
    align: 'right',
    order: 20,
    mount(el) {
      el.appendChild(h('button', { type: 'button', class: 'sb-btn', 'aria-label': 'Toggle panel', title: 'Toggle panel (Ctrl+J)', onclick: () => togglePanel() }, icon('panel', { size: 13 })));
    },
  });

  registerCommand({ id: 'view.problems', title: 'Show problems', group: 'View', icon: 'alert', shortcut: 'Mod+Shift+M', run: () => showPanel('problems', true) });
  registerCommand({ id: 'view.output', title: 'Show output (event log)', group: 'View', icon: 'list', run: () => showPanel('output', true) });
  registerCommand({ id: 'view.panel', title: 'Toggle panel', group: 'View', icon: 'panel', shortcut: 'Mod+J', run: () => togglePanel() });
  onTopic('*', (m) => {
    if (m.topic !== 'system') outputCount.update((n) => (n ?? 0) + 1);
  });
}
