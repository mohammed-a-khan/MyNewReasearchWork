/**
 * Source Control (#/scm/<path>): the project's git status grouped into
 * journeys, queries and config; a word-level diff of the selected file;
 * stage / unstage / discard; commit; branch create and switch; pull and push
 * (with the user's own git credentials, never asked for here); history and
 * blame per journey (which step a line belongs to, who changed it and when);
 * a conflict indicator and a hunk-by-hunk resolver for journey files; pull
 * request proposals from heal review, baseline approval and quarantine; and
 * the Quality Center's branch filter.
 */
import { api, q } from '../core/api.js';
import { clear, h, uid } from '../core/dom.js';
import { onTopic } from '../core/events.js';
import { relTime } from '../core/format.js';
import { registerCommand, registerPage, registerStatusItem, type PageContext } from '../core/registry.js';
import { link, navigate, type Route } from '../core/router.js';
import { store } from '../core/store.js';
import { button } from '../ui/badge.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';

interface Entry {
  path: string;
  from?: string;
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked';
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
  category: 'journey' | 'query' | 'config' | 'other';
  sensitive: boolean;
}

interface Proposal {
  id: string;
  kind: string;
  title: string;
  files: string[];
  at: string;
  done?: { branch: string; url?: string; number?: number; pushed: boolean };
  error?: string;
}

interface Status {
  branch: { head?: string; sha?: string; upstream?: string; ahead: number; behind: number; detached: boolean };
  operation?: string;
  entries: Entry[];
  outsideProject: number;
  conflicts: string[];
  remote?: string;
  branchFilter: string | null;
  proposals: Proposal[];
}

interface Segment {
  kind: ' ' | '+' | '-';
  text: string;
}
interface WordLine {
  oldNo?: number;
  newNo?: number;
  kind: ' ' | '~' | '+' | '-';
  segments: Segment[];
}
interface BlameLine {
  line: number;
  text: string;
  shortSha: string;
  author: string;
  date: string;
  summary: string;
  uncommitted: boolean;
  stepId?: string;
}
interface Hunk {
  index: number;
  startLine: number;
  ours: string[];
  base?: string[];
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

const CATEGORY: Record<Entry['category'], string> = { journey: 'Journeys', query: 'Queries', config: 'Config', other: 'Other files' };
const STATE: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' };

/** Conflicts and pending changes, shared with the status bar item. */
export const scmSummary = store<{ branch?: string; changes: number; conflicts: number; ahead: number; behind: number } | undefined>(undefined);

function stateOf(e: Entry, staged: boolean): string {
  if (e.conflicted) return 'conflict';
  const letter = staged ? e.index : e.worktree;
  return STATE[letter] ?? (e.kind === 'untracked' ? 'untracked' : 'modified');
}

function wordDiffView(path: string, hunks: Array<{ header: string; lines: WordLine[] }>): HTMLElement {
  const lines = hunks.flatMap((hk) => hk.lines);
  const changed = lines.filter((l) => l.kind !== ' ').length;
  if (!hunks.length) return h('p', { class: 'muted', text: 'No changes.' });
  return h(
    'figure',
    { class: 'scm-diff' },
    h('figcaption', { class: 'q-diff-head' }, icon('file', { size: 14 }), h('code', { text: path }), h('span', { class: 'muted small', text: `${changed} changed line(s), word level` })),
    h(
      'div',
      { class: 'scm-diff-body', tabindex: '0', role: 'region', 'aria-label': `Word-level changes to ${path}` },
      hunks.map((hk) =>
        h(
          'div',
          { class: 'scm-hunk' },
          h('div', { class: 'scm-hunk-head', text: hk.header }),
          hk.lines.map((l) =>
            h(
              'div',
              { class: ['scm-line', `k-${l.kind === '~' ? 'chg' : l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx'}`] },
              h('span', { class: 'q-ln', 'aria-hidden': 'true', text: l.oldNo ?? '' }),
              h('span', { class: 'q-ln', 'aria-hidden': 'true', text: l.newNo ?? '' }),
              h('span', { class: 'q-mark', text: l.kind === ' ' ? ' ' : l.kind === '~' ? '±' : l.kind === '+' ? '+' : '−' }),
              h(
                'span',
                { class: 'q-code' },
                l.segments.length
                  ? l.segments.map((s) => (s.kind === '+' ? h('ins', { text: s.text, title: 'added' }) : s.kind === '-' ? h('del', { text: s.text, title: 'removed' }) : s.text))
                  : ' ',
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function mount(ctx: PageContext) {
  const heading = h('h1', { class: 'page-title', tabindex: '-1', text: 'Source Control' });
  const branchLine = h('p', { class: 'muted', id: 'scm-branch-line', 'aria-live': 'polite' });
  const toolbar = h('div', { class: 'q-toolbar', role: 'toolbar', 'aria-label': 'Source control actions' });
  const banner = h('div', { class: 'scm-banner', 'aria-live': 'polite' });
  const lists = h('div', { class: 'scm-lists', id: 'scm-lists' });
  const detail = h('section', { class: 'scm-detail', 'aria-label': 'Selected file' });
  const msgId = uid('msg');
  const message = h('textarea', { id: msgId, class: 'input', rows: 3, placeholder: 'Describe the change (first line: summary)' });
  const commitBtn = button('Commit staged', { icon: 'check', kind: 'primary', id: 'scm-commit', onclick: () => void commit() });
  const proposalsBox = h('div', { class: 'scm-proposals' });
  const filterId = uid('bf');
  const filterSel = h('select', { id: filterId, class: 'input input-sm', onchange: () => void setFilter(filterSel.value) });
  ctx.root.classList.add('page-scroll', 'q-page');
  ctx.root.append(
    h(
      'div',
      { class: 'page-inner q-wide' },
      h('header', { class: 'page-head row-between' }, h('div', null, heading, branchLine), toolbar),
      banner,
      h(
        'div',
        { class: 'scm-grid' },
        h(
          'div',
          { class: 'scm-left' },
          h('section', { class: 'scm-commit', 'aria-label': 'Commit' }, h('label', { for: msgId, class: 'q-label', text: 'Commit message' }), message, h('div', { class: 'row' }, commitBtn)),
          lists,
          h('section', { 'aria-labelledby': 'scm-prop-h' }, h('h2', { class: 'q-h2', id: 'scm-prop-h', text: 'Pull request proposals' }), proposalsBox),
          h('div', { class: 'q-inline-field' }, h('label', { for: filterId, text: 'Quality Center branch filter' }), filterSel),
        ),
        detail,
      ),
    ),
  );

  let status: Status | undefined;
  let selected: { path: string; staged: boolean } | undefined;
  let tab: 'diff' | 'history' | 'blame' | 'resolve' = 'diff';
  let branches: Array<{ name: string; current: boolean; remote: boolean }> = [];

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok, { kind: 'success' });
      await load();
    } catch (e) {
      toastError(`${label}: ${(e as Error).message}`);
    }
  };

  async function setFilter(v: string) {
    await act('Branch filter', () => api.post('/api/scm/branch-filter', { branch: v || null }), v ? `Quality Center shows runs of ${v}` : 'Quality Center shows every branch');
  }

  async function commit() {
    const m = message.value.trim();
    if (!m) {
      toastError('Write a commit message first');
      message.focus();
      return;
    }
    await act('Commit', async () => {
      const r = await api.post<{ sha: string; files: number }>('/api/scm/commit', { message: m });
      message.value = '';
      toast(`Committed ${r.files} file(s) as ${r.sha.slice(0, 8)}`, { kind: 'success' });
    });
  }

  function renderToolbar() {
    const branchSelId = uid('br');
    const sel = h(
      'select',
      { id: branchSelId, class: 'input input-sm', onchange: () => void act('Switch branch', () => api.post('/api/scm/switch', { name: sel.value }), `Switched to ${sel.value}`) },
      branches.filter((b) => !b.remote).map((b) => h('option', { value: b.name, selected: b.current, text: b.name })),
    );
    clear(toolbar).append(
      h('div', { class: 'q-inline-field' }, h('label', { for: branchSelId, text: 'Branch' }), sel),
      button('New branch', {
        icon: 'branch',
        small: true,
        onclick: async () => {
          const name = await promptDialog({ title: 'Create a branch', label: 'Branch name', placeholder: 'feature/checkout-journeys', confirm: 'Create and switch', validate: (v) => (/^[A-Za-z0-9._/-]+$/.test(v) && !v.includes('..') ? undefined : 'Letters, digits, . _ - and / only') });
          if (name) await act('Create branch', () => api.post('/api/scm/branch', { name }), `Created and switched to ${name}`);
        },
      }),
      button('Pull', { icon: 'down', small: true, id: 'scm-pull', onclick: () => void act('Pull', async () => {
        const r = await api.post<{ conflicts: string[] }>('/api/scm/pull');
        if (r.conflicts?.length) toastError(`Pulled with ${r.conflicts.length} conflict(s): resolve them below`);
        else toast('Up to date with the upstream', { kind: 'success' });
      }) }),
      button('Push', { icon: 'up', small: true, id: 'scm-push', onclick: () => void act('Push', () => api.post('/api/scm/push'), 'Pushed') }),
      button('Refresh', { icon: 'refresh', small: true, onclick: () => void load() }),
    );
  }

  function fileRow(e: Entry, staged: boolean): HTMLElement {
    const st = stateOf(e, staged);
    const isSel = selected?.path === e.path && selected.staged === staged;
    const open = () => {
      selected = { path: e.path, staged };
      tab = e.conflicted ? 'resolve' : 'diff';
      navigate(link('scm', e.path), { replace: true });
      render();
      void showDetail();
    };
    return h(
      'li',
      { class: ['scm-file', isSel && 'is-selected', e.conflicted && 'is-conflict'] },
      h('button', { class: 'scm-file-open', 'aria-current': isSel ? 'true' : undefined, title: e.path, onclick: open }, icon(e.conflicted ? 'warning' : 'file', { size: 14 }), h('span', { class: 'scm-file-name', text: e.path }), h('span', { class: `scm-state st-${st}`, text: st })),
      e.sensitive
        ? h('span', { class: 'muted small', text: 'not shown' })
        : e.conflicted
          ? null
          : staged
            ? button('Unstage', { small: true, kind: 'ghost', ariaLabel: `Unstage ${e.path}`, onclick: () => void act('Unstage', () => api.post('/api/scm/unstage', { paths: [e.path] })) })
            : h(
                'span',
                { class: 'row' },
                button('Stage', { small: true, kind: 'ghost', ariaLabel: `Stage ${e.path}`, onclick: () => void act('Stage', () => api.post('/api/scm/stage', { paths: [e.path] })) }),
                e.kind !== 'untracked'
                  ? button('Discard', {
                      small: true,
                      kind: 'ghost',
                      ariaLabel: `Discard changes to ${e.path}`,
                      onclick: async () => {
                        if (await confirmDialog({ title: 'Discard changes?', message: `The working-tree changes to ${e.path} are lost.`, confirm: 'Discard', danger: true })) await act('Discard', () => api.post('/api/scm/discard', { paths: [e.path], confirm: true }));
                      },
                    })
                  : null,
              ),
    );
  }

  function group(title: string, id: string, items: Array<{ e: Entry; staged: boolean }>, bulk?: HTMLElement): HTMLElement | null {
    if (!items.length) return null;
    const byCat = (['journey', 'query', 'config', 'other'] as const).map((c) => [c, items.filter((x) => x.e.category === c)] as const).filter(([, xs]) => xs.length);
    return h(
      'section',
      { class: 'scm-group', 'aria-labelledby': id },
      h('div', { class: 'row-between' }, h('h2', { class: 'q-h2', id, text: `${title} (${items.length})` }), bulk ?? null),
      byCat.map(([c, xs]) => h('div', { class: 'scm-cat' }, h('h3', { class: 'q-label', text: CATEGORY[c] }), h('ul', { class: 'scm-files', 'aria-label': `${title}: ${CATEGORY[c]}` }, xs.map((x) => fileRow(x.e, x.staged))))),
    );
  }

  function render() {
    if (!status) return;
    const s = status;
    const b = s.branch;
    branchLine.textContent = `${b.detached ? 'Detached HEAD' : `On ${b.head}`}${b.sha ? ` at ${b.sha.slice(0, 8)}` : ''}${b.upstream ? `, tracking ${b.upstream} (${b.ahead} ahead, ${b.behind} behind)` : ', no upstream yet'}${s.remote ? ` · ${s.remote}` : ''}`;
    clear(banner);
    if (s.conflicts.length || s.operation) {
      banner.append(h('div', { class: 'q-callout tone-warn', role: 'status', id: 'scm-conflict-banner' }, icon('warning', { size: 16 }), h('span', { text: `${s.operation ? `A ${s.operation} is in progress. ` : ''}${s.conflicts.length ? `${s.conflicts.length} file(s) have conflicts: open one to resolve it hunk by hunk.` : ''}` })));
    }
    const conflicts = s.entries.filter((e) => e.conflicted).map((e) => ({ e, staged: false }));
    const staged = s.entries.filter((e) => e.staged).map((e) => ({ e, staged: true }));
    const changes = s.entries.filter((e) => e.unstaged && !e.conflicted).map((e) => ({ e, staged: false }));
    const stageAll = changes.filter((x) => !x.e.sensitive).length ? button('Stage all', { small: true, onclick: () => void act('Stage', () => api.post('/api/scm/stage', { paths: changes.filter((x) => !x.e.sensitive).map((x) => x.e.path) })) }) : undefined;
    clear(lists).append(
      ...[group('Conflicts', 'scm-h-conf', conflicts), group('Staged', 'scm-h-staged', staged), group('Changes', 'scm-h-changes', changes, stageAll)].filter((x): x is HTMLElement => !!x),
    );
    if (!s.entries.length) lists.append(h('p', { class: 'muted', id: 'scm-clean', text: 'Nothing to commit: the working tree is clean.' }));
    if (s.outsideProject) lists.append(h('p', { class: 'muted small', text: `${s.outsideProject} change(s) outside this project are not listed.` }));
    commitBtn.disabled = !staged.length;
    clear(proposalsBox);
    if (!s.proposals.length) proposalsBox.append(h('p', { class: 'muted small', text: 'Accepting a heal, approving baselines or changing the quarantine adds a proposal here; open it as a pull request (branch and commit are made without touching your checkout; reviewers come from CODEOWNERS).' }));
    for (const p of s.proposals) {
      proposalsBox.append(
        h(
          'div',
          { class: 'scm-proposal' },
          h('div', null, h('strong', { text: p.title }), h('div', { class: 'muted small', text: `${p.files.join(', ')} · ${relTime(p.at)}` }), p.error ? h('div', { class: 'field-error', text: p.error }) : null),
          p.done
            ? p.done.url
              ? h('a', { href: p.done.url, target: '_blank', rel: 'noopener noreferrer', text: `PR #${p.done.number ?? ''}` })
              : h('span', { class: 'muted small', text: `branch ${p.done.branch}` })
            : button('Open pull request', {
                small: true,
                ariaLabel: `Open a pull request: ${p.title}`,
                onclick: async () => {
                  if (await confirmDialog({ title: 'Open a pull request?', message: `A branch with one commit (${p.files.join(', ')}) is pushed with your git credentials and a pull request is opened.`, confirm: 'Open pull request' })) {
                    await act('Pull request', async () => {
                      const r = await api.post<{ branch: string; pr?: { url: string; number: number } }>('/api/scm/propose', { id: p.id, confirm: true });
                      toast(r.pr ? `Opened PR #${r.pr.number}` : `Pushed ${r.branch}`, { kind: 'success' });
                    });
                  }
                },
              }),
        ),
      );
    }
    const names = [...new Set(branches.map((x) => x.name.replace(/^origin\//, '')))].sort();
    clear(filterSel).append(h('option', { value: '', text: 'All branches', selected: !s.branchFilter }), ...names.map((n) => h('option', { value: n, text: n, selected: s.branchFilter === n })));
  }

  async function showDetail() {
    clear(detail);
    if (!selected || !status) {
      detail.append(h('p', { class: 'muted', text: 'Select a file to see its changes, history and blame.' }));
      return;
    }
    const sel = selected;
    const e = status.entries.find((x) => x.path === sel.path);
    const tabs: Array<[typeof tab, string]> = [...(e?.conflicted ? [['resolve', 'Resolve'] as [typeof tab, string]] : []), ['diff', 'Changes'], ['history', 'History'], ['blame', 'Blame']];
    const tabList = h(
      'div',
      { class: 'tablist', role: 'tablist', 'aria-label': `Views of ${sel.path}` },
      tabs.map(([id, title]) =>
        h('button', {
          role: 'tab',
          class: 'tab',
          id: `scm-tab-${id}`,
          'aria-selected': String(tab === id),
          'aria-controls': 'scm-tabpanel',
          tabindex: tab === id ? '0' : '-1',
          text: title,
          onclick: () => {
            tab = id;
            void showDetail();
          },
        }),
      ),
    );
    const panel = h('div', { id: 'scm-tabpanel', role: 'tabpanel', 'aria-labelledby': `scm-tab-${tab}`, class: 'scm-panel', tabindex: '0' });
    detail.append(h('h2', { class: 'q-h2 scm-detail-title', text: sel.path }), h('div', { class: 'tabbar' }, tabList), panel);
    panel.append(h('p', { class: 'muted', role: 'status', text: 'Loading…' }));
    try {
      if (tab === 'diff') {
        const d = await api.get<{ hunks: Array<{ header: string; lines: WordLine[] }> }>(`/api/scm/diff?${q({ path: sel.path, staged: sel.staged ? '1' : undefined })}`);
        clear(panel).append(wordDiffView(sel.path, d.hunks));
      } else if (tab === 'history') {
        const r = await api.get<{ commits: Array<{ shortSha: string; author: string; date: string; subject: string }> }>(`/api/scm/log?${q({ path: sel.path })}`);
        clear(panel).append(
          r.commits.length
            ? h('table', { class: 'table scm-table' }, h('caption', { class: 'sr-only', text: `History of ${sel.path}` }), h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Commit' }), h('th', { scope: 'col', text: 'Author' }), h('th', { scope: 'col', text: 'When' }), h('th', { scope: 'col', text: 'Message' }))), h('tbody', null, r.commits.map((c) => h('tr', null, h('td', null, h('code', { text: c.shortSha })), h('td', { text: c.author }), h('td', { text: relTime(c.date), title: c.date }), h('td', { text: c.subject })))))
            : h('p', { class: 'muted', text: 'Not committed yet.' }),
        );
      } else if (tab === 'blame') {
        const r = await api.get<{ lines: BlameLine[] }>(`/api/scm/blame?${q({ path: sel.path })}`);
        clear(panel).append(
          r.lines.length
            ? h(
                'table',
                { class: 'table scm-table scm-blame' },
                h('caption', { class: 'sr-only', text: `Who changed each line of ${sel.path}` }),
                h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Line' }), h('th', { scope: 'col', text: 'Step' }), h('th', { scope: 'col', text: 'Changed by' }), h('th', { scope: 'col', text: 'When' }), h('th', { scope: 'col', text: 'Text' }))),
                h('tbody', null, r.lines.map((l) => h('tr', { class: l.uncommitted ? 'is-uncommitted' : '' }, h('td', { text: l.line }), h('td', null, l.stepId ? h('code', { text: l.stepId }) : ''), h('td', { text: l.uncommitted ? 'Not committed yet' : `${l.author} (${l.shortSha})`, title: l.summary }), h('td', { text: l.uncommitted ? '' : relTime(l.date), title: l.date }), h('td', null, h('code', { text: l.text })))),
                ),
              )
            : h('p', { class: 'muted', text: 'Not committed yet: no history to blame.' }),
        );
      } else await resolver(panel, sel.path);
    } catch (err) {
      clear(panel).append(h('p', { class: 'field-error', role: 'alert', text: (err as Error).message }));
    }
  }

  async function resolver(panel: HTMLElement, path: string) {
    const c = await api.get<{ hunks: Hunk[]; hash: string }>(`/api/scm/conflict?${q({ path })}`);
    const choices: Record<number, string | { text: string }> = {};
    const result = h('pre', { class: 'q-pre scm-result', role: 'region', 'aria-label': 'Resolved file preview', tabindex: '0' });
    const check = h('p', { class: 'small', role: 'status', id: 'scm-resolve-check' });
    const save = button('Save resolution and stage', {
      kind: 'primary',
      id: 'scm-resolve-save',
      disabled: true,
      onclick: () => void act('Resolve', () => api.post('/api/scm/resolve', { path, choices, hash: c.hash, confirm: true }), `${path} resolved and staged`),
    });
    const preview = async () => {
      const r = await api.post<{ result: string; check: { ok: boolean; error?: string; steps?: number }; resolved: number; total: number }>('/api/scm/resolve', { path, choices, hash: c.hash, preview: true });
      result.textContent = r.result;
      check.textContent = r.resolved < r.total ? `${r.total - r.resolved} of ${r.total} conflict(s) left` : r.check.ok ? `Valid journey${r.check.steps !== undefined ? ` (${r.check.steps} steps)` : ''}` : `Not valid yet: ${r.check.error}`;
      check.className = `small ${r.resolved === r.total && r.check.ok ? 'tone-ok' : 'field-error'}`;
      save.disabled = !(r.resolved === r.total && r.check.ok);
    };
    clear(panel).append(
      h('p', { class: 'muted', text: `${c.hunks.length} conflict(s). Choose a side for each hunk (or edit it), then save: the result must parse as a journey.` }),
      ...c.hunks.map((hk) => {
        const name = uid(`hunk${hk.index}`);
        const edit = h('textarea', { class: 'input', rows: Math.max(2, hk.ours.length + hk.theirs.length), 'aria-label': `Edited text for conflict ${hk.index + 1}`, value: [...hk.ours, ...hk.theirs].join('\n'), hidden: true, oninput: () => ((choices[hk.index] = { text: edit.value }), void preview()) });
        const opt = (value: string, label: string) =>
          h('label', { class: 'scm-choice' }, h('input', { type: 'radio', name, value, onchange: () => {
            edit.hidden = value !== 'edit';
            choices[hk.index] = value === 'edit' ? { text: edit.value } : value;
            void preview();
          } }), label);
        return h(
          'fieldset',
          { class: 'scm-conflict' },
          h('legend', { text: `Conflict ${hk.index + 1} at line ${hk.startLine}` }),
          h('div', { class: 'scm-sides' }, h('div', null, h('div', { class: 'q-label', text: `Ours (${hk.oursLabel || 'current'})` }), h('pre', { class: 'q-pre', text: hk.ours.join('\n') || '(nothing)' })), h('div', null, h('div', { class: 'q-label', text: `Theirs (${hk.theirsLabel || 'incoming'})` }), h('pre', { class: 'q-pre', text: hk.theirs.join('\n') || '(nothing)' }))),
          hk.base ? h('details', null, h('summary', { text: 'Common base' }), h('pre', { class: 'q-pre', text: hk.base.join('\n') || '(nothing)' })) : null,
          h('div', { class: 'row scm-choices' }, opt('ours', 'Keep ours'), opt('theirs', 'Keep theirs'), opt('both', 'Both (ours first)'), opt('edit', 'Edit')),
          edit,
        );
      }),
      check,
      h('div', { class: 'q-label', text: 'Result' }),
      result,
      h('div', { class: 'row' }, save),
    );
  }

  async function load() {
    try {
      const [s, b] = await Promise.all([api.get<Status>('/api/scm/status'), api.get<{ branches: typeof branches }>('/api/scm/branches')]);
      status = s;
      branches = b.branches;
      scmSummary.set({ branch: s.branch.head, changes: s.entries.length, conflicts: s.conflicts.length, ahead: s.branch.ahead, behind: s.branch.behind });
      const cur = selected && s.entries.find((e) => e.path === selected!.path);
      if (cur?.conflicted && tab === 'diff') tab = 'resolve';
      if (!cur?.conflicted && tab === 'resolve') tab = 'diff';
      if (selected && cur) selected.staged = cur.staged && !cur.unstaged ? true : selected.staged && cur.staged;
      renderToolbar();
      render();
      await showDetail();
    } catch (e) {
      clear(lists).append(h('div', { class: 'q-error', role: 'alert' }, icon('alert', { size: 18 }), h('p', { text: (e as Error).message })));
      clear(detail);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => !ctx.root.hidden && void load(), 150);
  };
  onTopic('files', kick);
  onTopic('scm', kick);
  onTopic('quality', kick);

  return {
    show(r: Route) {
      const path = r.rest;
      if (path && selected?.path !== path) {
        const e = status?.entries.find((x) => x.path === path);
        selected = { path, staged: !!e?.staged && !e.unstaged };
        tab = e?.conflicted ? 'resolve' : 'diff';
      }
      void load();
    },
    focus: () => heading.focus(),
  };
}

export function registerSourceControlPage(): void {
  registerPage({ id: 'scm', title: 'Source Control', icon: 'branch', route: 'scm', group: 'primary', order: 65, mount });
  registerCommand({ id: 'scm.open', title: 'Open Source Control', group: 'Navigate', icon: 'branch', run: () => navigate(link('scm')) });
  // Changes and the conflict indicator next to the branch item of the status bar.
  registerStatusItem({
    id: 'scm-changes',
    align: 'left',
    order: 21,
    mount(el) {
      const b = h('button', { class: 'scm-status', id: 'status-scm', onclick: () => navigate(link('scm')) });
      el.append(b);
      const paint = () => {
        const s = scmSummary.get();
        el.hidden = !s;
        if (!s) return;
        clear(b).append(icon(s.conflicts ? 'warning' : 'edit', { size: 12 }), h('span', { text: `${s.changes} change(s)${s.conflicts ? `, ${s.conflicts} conflict(s)` : ''}${s.ahead || s.behind ? ` ↑${s.ahead} ↓${s.behind}` : ''}` }));
        b.classList.toggle('has-conflicts', !!s.conflicts);
        b.setAttribute('aria-label', `Source Control: ${s.changes} change(s), ${s.conflicts} conflict(s), ${s.ahead} ahead, ${s.behind} behind`);
      };
      scmSummary.subscribe(paint);
      // 200 with repo: false outside a git repository, so pages without git log no errors.
      const refresh = () =>
        void api
          .get<{ repo: boolean; branch?: string | null; changes?: number; conflicts?: number; ahead?: number; behind?: number }>('/api/scm/summary')
          .then((s) => scmSummary.set(s.repo ? { branch: s.branch ?? undefined, changes: s.changes ?? 0, conflicts: s.conflicts ?? 0, ahead: s.ahead ?? 0, behind: s.behind ?? 0 } : undefined))
          .catch(() => undefined);
      let t: ReturnType<typeof setTimeout> | undefined;
      const later = () => {
        clearTimeout(t);
        t = setTimeout(refresh, 500);
      };
      refresh();
      onTopic('files', later);
      onTopic('scm', later);
    },
  });
}
