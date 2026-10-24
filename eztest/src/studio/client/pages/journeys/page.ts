/**
 * Journeys: explorer, multi-file editor tabs with dirty indicators, the
 * CodeMirror editor (autocomplete, diagnostics, hover docs), the visual step
 * view, an outline of steps, and live reload when files change on disk.
 * Deep link: `#/journeys/<path>:<line>`.
 */
import { askVariables } from '../../core/run-variables.js';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { api, ApiError } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { onTopic } from '../../core/events.js';
import { basename, plural } from '../../core/format.js';
import { registerShortcut } from '../../core/keys.js';
import { registerCommand, registerCommandProvider, registerPage, type PageContext } from '../../core/registry.js';
import { link, navigate, type Route } from '../../core/router.js';
import { journeys, loadGrammar, problems, refreshJourneys, refreshVocabulary, session, setFileProblems, type Issue, type JourneyEntry } from '../../core/state.js';
import { button, emptyState, iconButton } from '../../ui/badge.js';
import { icon } from '../../ui/icons.js';
import { confirmDialog, openModal, promptDialog } from '../../ui/modal.js';
import { createSplit } from '../../ui/split.js';
import { toast, toastError } from '../../ui/toast.js';
import { createTree, type TreeNode } from '../../ui/tree.js';
import { showPanel } from '../../ui/shell.js';
import type { Format } from './assist.js';
import { createEditorState, createEditorView, forceLinting, goToLine, redo, replaceDoc, undo } from './editor.js';
import { ezOutline, structuredOutline, type OutlineItem } from './ezlang.js';
import { codeOutline } from './sdk.js';
import { featureOutline } from './gherkin.js';
import { createVisualView, type VisualHandle } from './visual.js';

interface Tab {
  path: string;
  format: Format;
  saved: string;
  state: EditorState;
  mode: 'code' | 'steps';
  validation?: { ok: boolean; errors: Issue[]; journey?: { name: string; steps: number } };
  conflict?: 'changed' | 'removed';
  cursorLine: number;
}

const tabs: Tab[] = [];
let active: Tab | undefined;
let view: EditorView | undefined;
let visual: VisualHandle | undefined;
let ui: ReturnType<typeof buildUi> | undefined;

const isDirty = (t: Tab) => (t === active && view ? view.state : t.state).doc.toString() !== t.saved;
const textOf = (t: Tab) => (t === active && view ? view.state : t.state).doc.toString();
export const anyDirty = () => tabs.some(isDirty);

function parseRest(rest: string): { path?: string; line?: number } {
  if (!rest) return {};
  const m = /^(.*?)(?::(\d+))?$/.exec(rest);
  return { path: m?.[1] || undefined, line: m?.[2] ? Number(m[2]) : undefined };
}

// ------------------------------------------------------------------ explorer

function buildTree(list: JourneyEntry[]): Array<TreeNode<JourneyEntry>> {
  const root: Array<TreeNode<JourneyEntry>> = [];
  const folders = new Map<string, TreeNode<JourneyEntry>>();
  const probs = problems.get();
  for (const j of [...list].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = j.path.split('/');
    let siblings = root;
    let acc = '';
    for (const part of parts.slice(0, -1)) {
      acc = acc ? `${acc}/${part}` : part;
      let f = folders.get(acc);
      if (!f) {
        f = { id: `dir:${acc}`, label: part, children: [] };
        folders.set(acc, f);
        siblings.push(f);
      }
      siblings = f.children!;
    }
    const n = (probs[j.path] ?? []).length || (j.error ? 1 : 0);
    const open = tabs.find((t) => t.path === j.path);
    const dirty = open ? isDirty(open) : false;
    siblings.push({
      id: j.path,
      label: j.name ?? basename(j.path),
      detail: basename(j.path),
      icon: 'file',
      data: j,
      class: n ? 'has-problems' : undefined,
      description: [j.error ? 'does not parse' : `${j.steps ?? 0} steps`, n ? plural(n, 'problem') : '', dirty ? 'unsaved changes' : ''].filter(Boolean).join(', '),
      decorations: [
        dirty ? h('span', { class: 'dirty-dot', title: 'Unsaved changes' }) : null,
        n ? h('span', { class: 'problem-count', title: plural(n, 'problem') }, icon('alert', { size: 12 }), String(n)) : null,
      ],
    });
  }
  return root;
}

// ------------------------------------------------------------------ UI

function buildUi(ctx: PageContext) {
  const filter = h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter by name, tag, requirement', 'aria-label': 'Filter journeys', autocomplete: 'off' });
  const tagSel = h('select', { class: 'input input-sm', 'aria-label': 'Filter by tag' }, h('option', { value: '', text: 'All tags' }));
  const count = h('p', { class: 'explorer-count', role: 'status', 'aria-live': 'polite' });
  const tree = createTree<JourneyEntry>({ label: 'Journey files', onActivate: (n) => n.data && void openFile(n.data.path), onDelete: (n) => n.data && void deleteJourney(n.data.path) });
  const explorer = h(
    'aside',
    { class: 'explorer', 'aria-label': 'Journey explorer' },
    h(
      'div',
      { class: 'pane-head' },
      h('h2', { class: 'pane-title', text: 'Explorer' }),
      h('div', { class: 'pane-actions' }, iconButton('New journey', 'plus', () => void newJourney()), iconButton('Refresh', 'refresh', () => void refreshJourneys()), iconButton('Delete the selected journey (Delete key)', 'trash', () => { const n = tree.selectedNode(); if (n?.data) void deleteJourney(n.data.path); else toast('Select a journey file first', { timeout: 2000 }); }), iconButton('Collapse folders', 'collapse', () => tree.expandAll(false))),
    ),
    h('div', { class: 'explorer-filters' }, filter, tagSel),
    count,
    h('div', { class: 'explorer-tree' }, tree.el),
  );

  const heading = h('h1', { class: 'sr-only', tabindex: '-1', text: 'Journeys' });
  const tabList = h('div', { class: 'editor-tabs', role: 'tablist', 'aria-label': 'Open journeys' });
  const modeCode = h('button', { type: 'button', class: 'seg', 'aria-pressed': 'true', onclick: () => setMode('code') }, icon('code'), h('span', { text: 'Code' }));
  const modeSteps = h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', onclick: () => setMode('steps') }, icon('steps'), h('span', { text: 'Steps' }));
  const outlineBtn = iconButton('Toggle outline', 'list', () => outlineSplit.toggle(), { pressed: true });
  const toolbar = h(
    'div',
    { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Editor actions' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, modeCode, modeSteps),
    h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
    button('Save', { icon: 'save', small: true, kind: 'primary', id: 'btn-save', onclick: () => void save(), title: 'Save (Ctrl+S)' }),
    button('Format', { icon: 'format', small: true, onclick: () => void format(), title: 'Format (Shift+Alt+F)' }),
    button('Convert…', { icon: 'convert', small: true, onclick: () => void convert() }),
    button('Run', { icon: 'run', small: true, onclick: () => void runActive(), title: 'Run this journey (Ctrl+Enter)' }),
    h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
    button('Rename…', { icon: 'edit', small: true, id: 'btn-rename', onclick: () => void renameActive(), title: 'Rename or move this journey file' }),
    button('Delete…', { icon: 'trash', small: true, kind: 'danger', id: 'btn-delete', onclick: () => void deleteActive(), title: 'Delete this journey file from disk' }),
    h('span', { class: 'tb-spacer' }),
    outlineBtn,
  );
  const banner = h('div', { class: 'editor-banner', hidden: true, role: 'alert' });
  const editorHost = h('div', { class: 'editor-host', id: 'editor-host' });
  const visualHost = h('div', { class: 'visual-host', hidden: true });
  const welcome = h('div', { class: 'editor-welcome' });
  const outlineList = h('ol', { class: 'outline-list' });
  const outline = h('aside', { class: 'outline', 'aria-label': 'Outline' }, h('div', { class: 'pane-head' }, h('h2', { class: 'pane-title', text: 'Outline' })), outlineList);
  const center = h('div', { class: 'editor-center' }, editorHost, visualHost, welcome);
  const outlineSplit = createSplit({ direction: 'row', first: center, second: outline, size: 240, min: 160, sizeSecond: true, storageKey: 'outline', label: 'Resize outline' });
  const summary = h('p', { class: 'validation-summary', id: 'validation-summary', role: 'status', 'aria-live': 'polite' });
  const cursorInfo = h('span', { class: 'cursor-info' });
  const statusline = h(
    'div',
    { class: 'editor-statusline' },
    summary,
    h('button', { type: 'button', class: 'link-btn', onclick: () => showPanel('problems', true), text: 'Problems panel' }),
    h('span', { class: 'tb-spacer' }),
    cursorInfo,
  );
  const editorArea = h('div', { class: 'editor-area' }, heading, tabList, toolbar, banner, outlineSplit.el, statusline);
  const split = createSplit({ direction: 'row', first: explorer, second: editorArea, size: 280, min: 200, max: 560, storageKey: 'explorer', label: 'Resize explorer' });
  ctx.root.classList.add('page-journeys');
  ctx.root.appendChild(split.el);

  const renderExplorer = () => {
    const q = filter.value.trim().toLowerCase();
    const t = tagSel.value;
    const all = journeys.get();
    const list = all.filter((j) => {
      if (t && !j.tags.includes(t)) return false;
      if (!q) return true;
      return [j.path, j.id, j.name, ...j.tags, ...j.requirements].some((x) => x && x.toLowerCase().includes(q));
    });
    count.textContent = `${list.length} of ${plural(all.length, 'journey')}`;
    tree.setNodes(buildTree(list));
    if (active) tree.select(active.path);
  };
  filter.addEventListener('input', renderExplorer);
  tagSel.addEventListener('change', renderExplorer);
  journeys.subscribe((list) => {
    const tags = [...new Set(list.flatMap((j) => j.tags))].sort();
    const cur = tagSel.value;
    clear(tagSel).appendChild(h('option', { value: '', text: 'All tags' }));
    for (const tg of tags) tagSel.appendChild(h('option', { value: tg, text: `@${tg}` }));
    tagSel.value = tags.includes(cur) ? cur : '';
    renderExplorer();
  });
  problems.subscribe(() => renderExplorer(), false);

  return { heading, tabList, toolbar, banner, editorHost, visualHost, welcome, outlineList, outlineBtn, summary, cursorInfo, modeCode, modeSteps, renderExplorer, tree, filter };
}

// ------------------------------------------------------------------ tabs

function renderTabs(): void {
  if (!ui) return;
  clear(ui.tabList);
  tabs.forEach((t, i) => {
    const on = t === active;
    const dirty = isDirty(t);
    const tabBtn = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'etab-btn',
        'aria-selected': String(on),
        'aria-controls': 'editor-host',
        tabindex: on ? '0' : '-1',
        title: `${t.path} (Delete closes the tab)`,
        onclick: () => activate(t),
        onauxclick: (e: MouseEvent) => e.button === 1 && void closeTab(t),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Delete') {
            e.preventDefault();
            void closeTab(t);
            return;
          }
          const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -2;
          if (n === -2) return;
          e.preventDefault();
          const next = tabs[(n + tabs.length) % tabs.length];
          activate(next);
          (ui!.tabList.querySelectorAll<HTMLElement>('[role="tab"]')[tabs.indexOf(next)])?.focus();
        },
      },
      icon('file', { size: 13 }),
      h('span', { class: 'etab-name', text: basename(t.path) }),
      dirty ? h('span', { class: 'dirty-dot', role: 'img', 'aria-label': 'unsaved changes' }) : null,
      t.validation && !t.validation.ok ? h('span', { class: 'etab-err', role: 'img', 'aria-label': `${t.validation.errors.length} problems` }, String(t.validation.errors.length)) : null,
    );
    ui!.tabList.appendChild(
      h('div', { class: ['etab', on && 'active', dirty && 'dirty'], role: 'presentation' }, tabBtn, h('span', { class: 'etab-close', 'aria-hidden': 'true', title: 'Close (Alt+W or Delete)', onclick: () => void closeTab(t) }, icon('close', { size: 13 }))),
    );
  });
}

function setSummary(t: Tab | undefined): void {
  if (!ui) return;
  const s = ui.summary;
  s.className = 'validation-summary';
  if (!t?.validation) {
    s.textContent = t ? 'Checking…' : '';
    return;
  }
  const v = t.validation;
  if (v.ok) {
    s.classList.add('ok');
    s.textContent = `✔ Valid: ${v.journey ? `${v.journey.name}, ${plural(v.journey.steps, 'step')}` : 'no problems found'}`;
  } else {
    s.classList.add('bad');
    s.textContent = `✖ ${plural(v.errors.length, 'problem')} found`;
  }
}

function renderOutline(): void {
  if (!ui) return;
  clear(ui.outlineList);
  if (!active) return;
  const text = textOf(active);
  const items: OutlineItem[] = active.format === 'ez' ? ezOutline(text) : active.format === 'ts' ? codeOutline(text) : active.format === 'feature' ? featureOutline(text) : structuredOutline(text);
  let stepNo = 0;
  const steps = items.filter((x) => x.kind === 'step');
  const cur = [...steps].reverse().find((x) => x.line <= active!.cursorLine);
  for (const it of items) {
    if (it.kind === 'step') stepNo++;
    const errs = (active.validation?.errors ?? []).some((e) => e.line === it.line);
    ui.outlineList.appendChild(
      h(
        'li',
        { class: ['outline-item', `ol-${it.kind}`, it === cur && 'current', errs && 'has-error'] },
        h(
          'button',
          { type: 'button', class: 'outline-btn', 'aria-current': it === cur ? 'step' : undefined, onclick: () => view && goToLine(view, it.line) },
          it.kind === 'step' ? h('span', { class: 'outline-num', text: String(stepNo) }) : icon('check', { size: 11 }),
          h('span', { class: 'outline-text', text: it.text }),
          errs ? icon('alert', { size: 12, label: 'has a problem' }) : null,
        ),
      ),
    );
  }
  if (!items.length) ui.outlineList.appendChild(h('li', { class: 'outline-empty', text: 'No steps yet' }));
}

let outlineTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleOutline = () => {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 150);
};

function renderBanner(): void {
  if (!ui) return;
  const b = ui.banner;
  clear(b);
  b.hidden = !active?.conflict;
  if (!active?.conflict) return;
  const t = active;
  if (t.conflict === 'removed') {
    b.append(icon('warning'), h('span', { text: `${t.path} was deleted on disk. Save to recreate it, or close the tab.` }), button('Close tab', { small: true, onclick: () => void closeTab(t, true) }));
  } else {
    b.append(
      icon('warning'),
      h('span', { text: `${t.path} changed on disk while you have unsaved edits.` }),
      button('Reload from disk', { small: true, onclick: () => void reloadFromDisk(t) }),
      button('Keep my version', { small: true, onclick: () => ((t.conflict = undefined), renderBanner()) }),
    );
  }
}

function setMode(mode: 'code' | 'steps'): void {
  if (!active || !ui) return;
  if (mode === 'steps' && active.format === 'ts') {
    toast('Code journeys (TypeScript) have no visual steps view: their steps are the SDK calls in the code', { timeout: 3500 });
    return;
  }
  if (mode === 'steps' && active.format === 'feature') {
    toast('Feature files have no visual steps view: the outline lists their scenarios and steps', { timeout: 3500 });
    return;
  }
  active.mode = mode;
  applyMode();
  if (mode === 'steps') void visual?.refresh().then(() => visual?.focus());
  else view?.focus();
}

function applyMode(): void {
  if (!ui) return;
  const mode = active?.mode ?? 'code';
  ui.modeCode.setAttribute('aria-pressed', String(mode === 'code'));
  ui.modeSteps.setAttribute('aria-pressed', String(mode === 'steps'));
  ui.editorHost.hidden = !active || mode !== 'code';
  ui.visualHost.hidden = !active || mode !== 'steps';
  ui.welcome.hidden = !!active;
  ui.toolbar.hidden = !active;
}

function activate(t: Tab, opts: { line?: number; focus?: boolean; updateHash?: boolean } = {}): void {
  if (!ui) return;
  // Sync the live buffer back into its tab first, including when re-activating the same tab
  // (outline, problem links, deep links): restoring a stale t.state would discard unsaved edits.
  if (active && view) active.state = view.state;
  active = t;
  if (!view) view = createEditorView(ui.editorHost, t.state);
  else if (view.state !== t.state) view.setState(t.state);
  renderTabs();
  applyMode();
  setSummary(t);
  renderOutline();
  renderBanner();
  ui.tree.select(t.path);
  ui.cursorInfo.textContent = `${t.format.toUpperCase()} · Ln ${t.cursorLine}`;
  if (t.mode === 'steps') void visual?.refresh();
  if (opts.line) goToLine(view, opts.line, 1, opts.focus !== false);
  else if (opts.focus) view.focus();
  if (opts.updateHash !== false) navigate(link('journeys', t.path), { replace: true });
}

function makeTab(path: string, format: Format, content: string): Tab {
  const tab: Tab = {
    path,
    format,
    saved: content,
    mode: 'code',
    cursorLine: 1,
    state: undefined as unknown as EditorState,
  };
  tab.state = createEditorState({
    path,
    format,
    content,
    onChange: () => {
      renderTabsSoon();
      scheduleOutline();
    },
    onValidated: (r) => {
      tab.validation = r;
      setFileProblems(tab.path, r.errors);
      if (tab === active) {
        setSummary(tab);
        renderOutline();
      }
      renderTabsSoon();
    },
    onCursor: (line) => {
      if (tab.cursorLine === line) return;
      tab.cursorLine = line;
      if (tab === active && ui) {
        ui.cursorInfo.textContent = `${tab.format.toUpperCase()} · Ln ${line}`;
        scheduleOutline();
      }
    },
  });
  return tab;
}

let tabsTimer: ReturnType<typeof setTimeout> | undefined;
let lastDirty = '';
function renderTabsSoon(): void {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(() => {
    const sig = tabs.map((t) => `${t.path}:${isDirty(t)}:${t.validation?.errors.length ?? '-'}`).join('|');
    if (sig === lastDirty) return;
    lastDirty = sig;
    renderTabs();
    ui?.renderExplorer();
  }, 80);
}

export async function openFile(path: string, line?: number, focus = true): Promise<void> {
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    activate(existing, { line, focus });
    return;
  }
  try {
    const r = await api.get<{ path: string; format: Format; content: string }>(`/api/file?path=${encodeURIComponent(path)}`);
    const again = tabs.find((t) => t.path === r.path);
    if (again) return activate(again, { line, focus });
    const tab = makeTab(r.path, r.format, r.content);
    tabs.push(tab);
    activate(tab, { line, focus });
  } catch (e) {
    toastError(`Could not open ${path}: ${(e as Error).message}`);
  }
}

async function closeTab(t: Tab, force = false): Promise<void> {
  if (!force && isDirty(t)) {
    const ok = await confirmDialog({ title: 'Discard unsaved changes?', message: `${t.path} has unsaved changes.`, confirm: 'Discard', danger: true });
    if (!ok) return;
  }
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  setFileProblems(t.path, []);
  if (active === t) {
    active = undefined;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next, { focus: true });
    else {
      renderTabs();
      applyMode();
      setSummary(undefined);
      renderOutline();
      renderBanner();
      navigate(link('journeys'), { replace: true });
    }
  } else renderTabs();
  void refreshProblemsFor(t.path);
}

async function refreshProblemsFor(path: string): Promise<void> {
  // The editor's live problems for a closed tab fall back to the file on disk.
  try {
    const r = await api.get<{ content: string; format: Format }>(`/api/file?path=${encodeURIComponent(path)}`);
    const v = await api.post<{ errors: Issue[] }>('/api/validate', { content: r.content, format: r.format });
    setFileProblems(path, v.errors);
  } catch {
    setFileProblems(path, []);
  }
}

async function save(t = active): Promise<void> {
  if (!t) return;
  const content = textOf(t);
  try {
    const r = await api.put<{ saved: string; validation: Tab['validation'] }>('/api/file', { path: t.path, content });
    t.saved = content;
    t.conflict = undefined;
    t.validation = r.validation;
    if (t === active) {
      setSummary(t);
      renderBanner();
    }
    renderTabs();
    ui?.renderExplorer();
    toast(`Saved ${r.saved}${r.validation?.ok ? '' : ' (with problems)'}`, { kind: r.validation?.ok ? 'success' : 'warning', timeout: 2500 });
    announce(`Saved ${r.saved}`);
    void refreshJourneys();
  } catch (e) {
    toastError(`Not saved: ${(e as Error).message}`);
  }
}

async function format(): Promise<void> {
  if (!active || !view) return;
  if (active.format === 'ts') {
    toast('Format TypeScript with your project formatter (Prettier, ESLint); the Studio formats .ez, YAML and JSON', { timeout: 3500 });
    return;
  }
  try {
    const r = await api.post<{ content: string }>('/api/format', { content: view.state.doc.toString(), format: active.format });
    replaceDoc(view, r.content, 'input.format');
    toast('Formatted', { timeout: 1500 });
  } catch (e) {
    toastError((e as Error).message);
  }
}

async function convert(): Promise<void> {
  if (!active) return;
  const t = active;
  if (t.format === 'ts') {
    toastError('Code journeys cannot be converted to .ez, YAML or JSON');
    return;
  }
  if (t.format === 'feature') {
    toastError('Feature files run as they are; to turn one into .ez journeys use Import (Gherkin)');
    return;
  }
  const target = h('select', { class: 'input', id: uid('conv') }, (['ez', 'yaml', 'json'] as const).filter((f) => f !== t.format).map((f) => h('option', { value: f, text: f === 'ez' ? '.ez (plain English)' : f.toUpperCase() })));
  const preview = h('pre', { class: 'code-preview', tabindex: '0', 'aria-label': 'Conversion preview' });
  const err = h('p', { class: 'field-error', role: 'alert' });
  let converted = '';
  const run = async () => {
    err.textContent = '';
    try {
      converted = (await api.post<{ content: string }>('/api/convert', { content: textOf(t), from: t.format, to: target.value })).content;
      preview.textContent = converted;
    } catch (e) {
      converted = '';
      preview.textContent = '';
      err.textContent = (e as Error).message;
    }
  };
  target.addEventListener('change', () => void run());
  await run();
  const newPath = () => t.path.replace(/\.(ez|ya?ml|json)$/i, `.${target.value === 'yaml' ? 'yaml' : target.value}`);
  await openModal({
    title: `Convert ${basename(t.path)}`,
    size: 'lg',
    body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', { for: target.id, text: 'Convert to' }), target), err, preview),
    actions: [
      { label: 'Close', run: () => true },
      {
        label: 'Save as new file',
        kind: 'primary',
        run: async () => {
          if (!converted) return undefined;
          try {
            const p = newPath();
            await api.put('/api/file', { path: p, content: converted, create: true });
            void refreshJourneys();
            setTimeout(() => void openFile(p), 0);
            return true;
          } catch (e) {
            err.textContent = (e as Error).message;
            return undefined;
          }
        },
      },
    ],
  }).result;
}

/**
 * Replace the buffer with the file on disk. When `onlyIfUnchanged` is set and
 * the user edited the buffer while the file was being fetched, keep their edits
 * and flag a conflict instead of silently overwriting them.
 */
async function reloadFromDisk(t: Tab, o: { content?: string; onlyIfUnchanged?: boolean } = {}): Promise<void> {
  try {
    const before = textOf(t);
    const content = o.content ?? (await api.get<{ content: string }>(`/api/file?path=${encodeURIComponent(t.path)}`)).content;
    if (o.onlyIfUnchanged && textOf(t) !== before) {
      t.conflict = 'changed';
      if (t === active) renderBanner();
      return;
    }
    t.saved = content;
    t.conflict = undefined;
    if (t === active && view) replaceDoc(view, content, 'input.reload');
    else t.state = t.state.update({ changes: { from: 0, to: t.state.doc.length, insert: content } }).state;
    renderTabs();
    renderBanner();
  } catch (e) {
    toastError((e as Error).message);
  }
}

/** A journey file changed on disk (another editor, git, an import). */
async function onDiskChange(type: string, path: string): Promise<void> {
  const t = tabs.find((x) => x.path === path);
  if (!t) return;
  if (type === 'removed') {
    t.conflict = 'removed';
    if (t === active) renderBanner();
    return;
  }
  let content: string;
  try {
    content = (await api.get<{ content: string }>(`/api/file?path=${encodeURIComponent(path)}`)).content;
  } catch {
    return;
  }
  if (content === t.saved || content === textOf(t)) {
    t.saved = content;
    if (t.conflict === 'removed') t.conflict = undefined;
    renderTabs();
    if (t === active) renderBanner();
    return;
  }
  if (!isDirty(t)) {
    await reloadFromDisk(t, { content, onlyIfUnchanged: true });
    if (t.conflict) return;
    toast(`Reloaded ${basename(path)} (changed on disk)`, { timeout: 2500 });
  } else {
    t.conflict = 'changed';
    if (t === active) renderBanner();
  }
}

function journeyIdFor(path: string): string | undefined {
  return journeyIdsFor(path)[0];
}

/** The journeys "Run" starts: a feature's scenario at the cursor (every Examples row of an outline), else the file's journeys. */
function journeyIdsFor(path: string): string[] {
  const j = journeys.get().find((x) => x.path === path);
  if (!j) return [];
  if (j.format === 'feature' && j.code?.length) {
    const at = active?.path === path ? active.cursorLine : 0;
    const row = j.code.find((c) => c.row === at);
    if (row) return [row.id];
    const lines = [...new Set(j.code.map((c) => c.line))].filter((l) => l <= at);
    const sc = lines.length ? Math.max(...lines) : undefined;
    return sc !== undefined ? j.code.filter((c) => c.line === sc).map((c) => c.id) : j.code.map((c) => c.id);
  }
  return j.id ? [j.id] : [];
}

async function runActive(): Promise<void> {
  if (!active) return;
  if (isDirty(active)) await save(active);
  const id = journeyIdFor(active.path) ?? active.validation?.journey?.name;
  if (!id) {
    toastError('This journey has no id yet: fix its problems and save it first.');
    return;
  }
  try {
    const ids = journeyIdsFor(active.path);
    const variables = await askVariables(ids);
    if (!variables) return;
    const r = await api.post<{ id: string }>('/api/runs', Object.keys(variables).length ? { journeys: ids, variables } : { journeys: ids });
    navigate(link('run', r.id));
  } catch (e) {
    toastError(`Could not start the run: ${(e as Error).message}`);
  }
}

async function newJourney(): Promise<void> {
  const dir = session.get()?.journeysDir ?? 'journeys';
  const nameId = uid('nj-name');
  const pathId = uid('nj-path');
  const name = h('input', { id: nameId, class: 'input', placeholder: 'Checkout as a guest', autocomplete: 'off' });
  const path = h('input', { id: pathId, class: 'input mono', value: `${dir}/new-journey.ez`, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${pathId}-help` });
  const err = h('p', { class: 'field-error', role: 'alert' });
  let pathTouched = false;
  path.addEventListener('input', () => (pathTouched = true));
  name.addEventListener('input', () => {
    if (pathTouched) return;
    const slug = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'new-journey';
    path.value = `${dir}/${slug}.ez`;
  });
  const created = await openModal<string>({
    title: 'New journey',
    size: 'sm',
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: nameId, text: 'Journey name' }), name),
      h('div', { class: 'field' }, h('label', { for: pathId, text: 'File path (in the project)' }), path, h('p', { id: `${pathId}-help`, class: 'help', text: 'Use .ez for plain English, .yaml / .json, or .journey.ts for a code journey (eztest/sdk).' })),
      err,
    ),
    actions: [
      { label: 'Cancel', run: () => '' },
      {
        label: 'Create from template',
        kind: 'primary',
        run: async () => {
          try {
            const r = await api.post<{ path: string }>('/api/journeys', { path: path.value.trim(), name: name.value.trim() || 'New journey' });
            return r.path;
          } catch (e) {
            err.textContent = (e as Error).message;
            return undefined;
          }
        },
      },
    ],
    initialFocus: name,
  }).result;
  if (created) {
    await refreshJourneys();
    toast(`Created ${created}`, { kind: 'success', timeout: 2500 });
    await openFile(created);
  }
}

async function renameActive(): Promise<void> {
  if (!active) return;
  const t = active;
  if (isDirty(t)) await save(t);
  const to = await promptDialog({ title: 'Rename journey file', label: 'New path', value: t.path, confirm: 'Rename' });
  if (!to || to === t.path) return;
  try {
    await api.post('/api/file/rename', { from: t.path, to });
    setFileProblems(t.path, []);
    t.path = to;
    await refreshJourneys();
    activate(t);
    toast(`Renamed to ${to}`, { kind: 'success', timeout: 2500 });
  } catch (e) {
    toastError((e as Error).message);
  }
}

async function deleteActive(): Promise<void> {
  if (active) await deleteJourney(active.path);
}

/** Delete a journey file (asks first); closes its tab if it is open. */
async function deleteJourney(path: string): Promise<void> {
  if (!(await confirmDialog({ title: 'Delete journey file?', message: `Delete ${path} from disk? This cannot be undone from the Studio (Source Control can still restore a committed file).`, confirm: 'Delete', danger: true }))) return;
  try {
    await api.del('/api/file', { path });
    const t = tabs.find((x) => x.path === path);
    if (t) await closeTab(t, true);
    await refreshJourneys();
    toast(`Deleted ${path}`, { timeout: 2500 });
  } catch (e) {
    toastError((e as Error).message);
  }
}

function renderWelcome(): void {
  if (!ui) return;
  const recent = journeys.get().slice(0, 6);
  clear(ui.welcome).appendChild(
    h(
      'div',
      { class: 'welcome' },
      emptyState('No journey open', 'Pick a journey in the explorer, or start a new one. Ctrl+P opens any journey by name.', button('New journey', { kind: 'primary', icon: 'plus', onclick: () => void newJourney() })),
      recent.length
        ? h('div', { class: 'welcome-recent' }, h('h2', { class: 'welcome-h', text: 'Journeys' }), h('ul', null, recent.map((j) => h('li', null, h('button', { type: 'button', class: 'link-btn', onclick: () => void openFile(j.path), text: j.name ?? j.path }), h('span', { class: 'muted', text: ` ${j.path}` })))))
        : null,
    ),
  );
}

// ------------------------------------------------------------------ registration

export function registerJourneysPage(): void {
  registerPage({
    id: 'journeys',
    title: 'Journeys',
    icon: 'journeys',
    order: 20,
    shortcut: 'Alt+2',
    mount(ctx) {
      ui = buildUi(ctx);
      visual = createVisualView({
        getText: () => (view ? view.state.doc.toString() : ''),
        getFormat: () => active?.format ?? 'ez',
        apply: (text) => view && replaceDoc(view, text, 'input.visual'),
        showInCode: (line) => {
          setMode('code');
          if (view) goToLine(view, line);
        },
        undo: () => {
          if (view) {
            undo(view);
            void visual?.refresh();
          }
        },
      });
      ui.visualHost.appendChild(visual.el);
      journeys.subscribe(() => !active && renderWelcome());
      applyMode();
      void loadGrammar().catch(() => undefined);
      void refreshVocabulary().catch(() => undefined);
      onTopic('files', (m) => void onDiskChange(String(m.type), String(m.path)));
      return {
        show(r: Route) {
          const { path, line } = parseRest(r.rest);
          if (path && (path !== active?.path || line)) void openFile(path, line);
        },
        focus() {
          if (active && active.mode === 'code') view?.focus();
          else ui?.heading.focus();
        },
      };
    },
  });

  window.addEventListener('beforeunload', (e) => {
    if (anyDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  const editorActive = () => !!active && location.hash.startsWith('#/journeys');
  registerCommand({ id: 'journey.new', title: 'New journey…', group: 'Journeys', icon: 'plus', run: () => newJourney() });
  registerCommand({ id: 'editor.save', title: 'Save journey', group: 'Editor', icon: 'save', shortcut: 'Mod+S', when: () => !!active, run: () => save() });
  registerCommand({ id: 'editor.saveAll', title: 'Save all journeys', group: 'Editor', icon: 'save', when: () => tabs.some(isDirty), run: async () => { for (const t of tabs.filter(isDirty)) await save(t); } });
  registerCommand({ id: 'editor.format', title: 'Format journey', group: 'Editor', icon: 'format', shortcut: 'Shift+Alt+F', when: () => !!active, run: () => format() });
  registerCommand({ id: 'editor.convert', title: 'Convert journey to another format…', group: 'Editor', icon: 'convert', when: () => !!active, run: () => convert() });
  registerCommand({ id: 'editor.toggleView', title: 'Toggle code / visual steps view', group: 'Editor', icon: 'steps', shortcut: 'Mod+E', when: () => !!active, run: () => setMode(active?.mode === 'steps' ? 'code' : 'steps') });
  registerCommand({ id: 'editor.run', title: 'Run this journey', group: 'Run', icon: 'run', shortcut: 'Mod+Enter', when: () => !!active, run: () => runActive() });
  registerCommand({ id: 'editor.close', title: 'Close journey tab', group: 'Editor', icon: 'close', shortcut: 'Alt+W', when: () => !!active, run: () => closeTab(active!) });
  registerCommand({ id: 'editor.rename', title: 'Rename journey file…', group: 'Journeys', icon: 'edit', when: () => !!active, run: () => renameActive() });
  registerCommand({ id: 'editor.delete', title: 'Delete journey file…', group: 'Journeys', icon: 'trash', when: () => !!active, run: () => deleteActive() });
  registerCommand({ id: 'editor.goToStep', title: 'Go to step…', group: 'Editor', icon: 'steps', shortcut: 'Mod+Shift+O', when: () => !!active, run: () => import('../../ui/palette.js').then((m) => m.openPalette('@')) });
  registerCommand({ id: 'editor.validate', title: 'Validate journey now', group: 'Editor', icon: 'check', when: () => !!active && !!view, run: () => view && forceLinting(view) });
  registerCommand({ id: 'editor.redo', title: 'Redo', group: 'Editor', when: () => !!view, run: () => void (view && redo(view)) });

  registerShortcut({ keys: 'Mod+S', title: 'Save journey', group: 'Editor', inInputs: true, when: editorActive, run: () => void save() });
  registerShortcut({ keys: 'Shift+Alt+F', title: 'Format journey', group: 'Editor', inInputs: true, when: editorActive, run: () => void format() });
  registerShortcut({ keys: 'Mod+E', title: 'Toggle code / steps view', group: 'Editor', inInputs: true, when: editorActive, run: () => setMode(active?.mode === 'steps' ? 'code' : 'steps') });
  registerShortcut({ keys: 'Mod+Enter', title: 'Run this journey', group: 'Editor', inInputs: true, when: editorActive, run: () => void runActive() });
  registerShortcut({ keys: 'Alt+W', title: 'Close journey tab', group: 'Editor', inInputs: true, when: editorActive, run: () => active && void closeTab(active) });
  registerShortcut({ keys: 'Mod+Shift+O', title: 'Go to step', group: 'Editor', inInputs: true, when: editorActive, run: () => void import('../../ui/palette.js').then((m) => m.openPalette('@')) });

  registerCommandProvider({
    id: 'journeys',
    items: () =>
      journeys.get().map((j) => ({
        id: `journey:${j.path}`,
        title: j.name ?? basename(j.path),
        detail: j.path,
        group: 'Journeys',
        icon: 'file' as const,
        keywords: [j.path, j.id ?? '', ...j.tags.map((t) => `@${t}`), ...j.requirements],
        run: () => navigate(link('journeys', j.path)),
      })),
  });
  registerCommandProvider({
    id: 'steps',
    prefix: '@',
    hint: 'Steps of the open journey',
    items: () => {
      if (!active) return [];
      const t = active;
      const items = t.format === 'ez' ? ezOutline(textOf(t)) : t.format === 'ts' ? codeOutline(textOf(t)) : t.format === 'feature' ? featureOutline(textOf(t)) : structuredOutline(textOf(t));
      let n = 0;
      return items
        .filter((x) => x.kind === 'step')
        .map((x) => ({
          id: `step:${x.line}`,
          title: x.text,
          detail: `step ${++n} · line ${x.line}`,
          group: `Steps in ${basename(t.path)}`,
          icon: 'steps' as const,
          run: () => {
            navigate(link('journeys', t.path));
            setMode('code');
            if (view) goToLine(view, x.line);
          },
        }));
    },
  });
}

/** For other pages (e.g. the Problems panel): open a journey at a line. */
export function openJourneyAt(path: string, line?: number): void {
  navigate(link('journeys', line ? `${path}:${line}` : path));
}

export { ApiError };
