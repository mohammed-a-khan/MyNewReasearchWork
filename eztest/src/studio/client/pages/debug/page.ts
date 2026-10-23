/**
 * The Debugger (`#/debug/<journey path>`): the journey's source with gutter
 * breakpoints and the current step highlighted, a step outline with live
 * status, the debug toolbar (F5 start/continue, F6 pause, F10 step over, F11
 * step into, run to cursor, restart, stop, pause on failure), the live
 * browser view with the element picker, side panels (variables, step
 * details, console, network, call stack, breakpoints), edit-and-continue and
 * the step console. Also launchable from the Journeys editor (F5).
 */
import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { api } from '../../core/api.js';
import { announce, clear, h, uid } from '../../core/dom.js';
import { basename } from '../../core/format.js';
import { registerShortcut } from '../../core/keys.js';
import { registerCommand, registerPage, type PageContext } from '../../core/registry.js';
import { link, navigate, route as currentRoute, type Route } from '../../core/router.js';
import { journeys, loadGrammar, refreshJourneys, refreshVocabulary, type Issue } from '../../core/state.js';
import { statusIcon } from '../../ui/badge.js';
import { createSplit } from '../../ui/split.js';
import { createTabs } from '../../ui/tabs.js';
import { toast, toastError } from '../../ui/toast.js';
import type { Format } from '../journeys/assist.js';
import { createEditorState, createEditorView, goToLine, replaceDoc } from '../journeys/editor.js';
import { anyDirty } from '../journeys/page.js';
import { codeJourneyLines, codeOutline } from '../journeys/sdk.js';
import { breakpointMenu, breakpoints, bpSync, bpsFor, installBreakpointGutter, stepLineFor, toggleBreakpoint, type Bp } from './breakpoints.js';
import { kitIcon, toolButton } from './kit.js';
import { createLiveView, type LiveView } from './live.js';
import { mountBreakpoints, mountCallStack, mountConsole, mountNetwork, mountStepDetails, mountVariables, type StepLine } from './panels.js';
import { createEditPanel, createStepConsole } from './repl.js';
import { command, dbg, isActive, isPaused, refreshState, resume, startSession, stopSession, type DbgView } from './state.js';

interface Card {
  /** Top-level index (journey.steps); absent for steps nested in blocks. */
  index?: number;
  pos: number;
  id: string;
  text: string;
  expects: string[];
  line?: number;
  endLine?: number;
  depth: number;
  parent?: number;
  block?: boolean;
}

interface OpenFile {
  path: string;
  format: Format;
  saved: string;
}

const LAST_KEY = 'ez-debug-last';

let file: OpenFile | undefined;
let view: EditorView | undefined;
/** Every step line of the file (nested ones too) and the top-level ones. */
let entries: Card[] = [];
let cards: Card[] = [];
let live: LiveView | undefined;
let ui: ReturnType<typeof buildUi> | undefined;
let pauseOnFailure = true;
let validation: { ok: boolean; errors: Issue[] } | undefined;

const onDebugPage = () => currentRoute.get().page === 'debug';
/** The open file is a code journey (eztest/sdk): breakpoints by line, no edit-and-continue. */
const isCode = () => file?.format === 'ts';
/** Base step id of a code step ("L12-3" -> "L12"). */
const codeBase = (id: string | undefined) => id?.replace(/-\d+$/, '');
const onJourneysPage = () => currentRoute.get().page === 'journeys';
const textOf = () => (view ? view.state.doc.toString() : '');
const dirty = () => !!file && textOf() !== file.saved;

/** Steps for the panels: top-level ones, then nested executions (loop iterations, branches, sub-journeys) as they ran. */
export const stepLines = (): StepLine[] => {
  const d = here();
  const top = cards.filter((c) => c.line !== undefined && !c.block).map((c) => ({ index: c.index!, line: c.line!, text: c.text, id: c.id }));
  const nested = (d.order ?? [])
    .filter((i, k, all) => i >= cards.length && all.indexOf(i) === k)
    .map((i) => {
      const e = entryForIndex(i);
      const runs = e ? runsOf(e, d) : [];
      return { index: i, line: e?.line ?? 0, text: `↳ ${d.steps[i]?.intent ?? e?.text ?? d.steps[i]?.stepId ?? ''}${runs.length > 1 ? ` (run ${runs.indexOf(i) + 1} of ${runs.length})` : ''}`, id: d.steps[i]?.stepId };
    });
  return [...top, ...nested];
};

// ------------------------------------------------------------------ current-step decoration

const setCurrent = StateEffect.define<{ line: number; kind: 'paused' | 'failed' | 'running' } | null>();
const currentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setCurrent)) {
        if (!e.value || e.value.line > tr.state.doc.lines) return Decoration.none;
        const ln = tr.state.doc.line(e.value.line);
        return Decoration.set([Decoration.line({ class: `cm-debug-line cm-debug-${e.value.kind}`, attributes: { 'data-debug-current': e.value.kind } }).range(ln.from)]);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function withDebugExtensions(state: EditorState): EditorState {
  return state.update({ effects: StateEffect.appendConfig.of([currentField]) }).state;
}

// ------------------------------------------------------------------ UI

function buildUi(ctx: PageContext) {
  const heading = h('h1', { class: 'sr-only', tabindex: '-1', text: 'Debugger' });
  const journeySel = h('select', { class: 'input input-sm dbg-journey', id: 'dbg-journey', 'aria-label': 'Journey to debug' });
  const btn = {
    start: toolButton('Start debugging', 'play', () => void startOrContinue(), { id: 'dbg-start', shortcut: 'F5', text: true, kind: 'go' }),
    pause: toolButton('Pause', 'pause', () => void command('pause'), { id: 'dbg-pause', shortcut: 'F6' }),
    over: toolButton('Step over', 'stepOver', () => void command('stepOver'), { id: 'dbg-over', shortcut: 'F10' }),
    into: toolButton('Step into', 'stepInto', () => void command('stepInto'), { id: 'dbg-into', shortcut: 'F11' }),
    cursor: toolButton('Run to cursor', 'runToCursor', () => void runToCursor(), { id: 'dbg-cursor', shortcut: 'Ctrl+F10' }),
    restart: toolButton('Restart', 'restart', () => void restart(), { id: 'dbg-restart', shortcut: 'Ctrl+Shift+F5' }),
    stop: toolButton('Stop', 'stop', () => void stopSession(), { id: 'dbg-stop', shortcut: 'Shift+F5', kind: 'stop' }),
    save: toolButton('Save', 'save', () => void save(), { id: 'dbg-save', shortcut: 'Ctrl+S' }),
  };
  const pofId = uid('pof');
  const pof = h('input', { type: 'checkbox', id: pofId, checked: true });
  pof.addEventListener('change', () => {
    pauseOnFailure = pof.checked;
    for (const other of document.querySelectorAll<HTMLInputElement>('.dbg-pof-mirror')) other.checked = pof.checked;
  });
  const pofMirror = h('label', { class: 'check small' }, h('input', { type: 'checkbox', class: 'dbg-pof-mirror', checked: true, onchange: (e: Event) => ((pof.checked = (e.target as HTMLInputElement).checked), pof.dispatchEvent(new Event('change'))) }), 'Pause on failure');
  const status = h('div', { class: 'dbg-status', id: 'dbg-status', role: 'status', 'aria-live': 'polite' });
  const toolbar = h(
    'div',
    { class: 'dbg-toolbar', role: 'toolbar', 'aria-label': 'Debug controls' },
    kitIcon('bug', { class: 'dbg-logo' }),
    journeySel,
    h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
    btn.start,
    btn.pause,
    btn.over,
    btn.into,
    btn.cursor,
    btn.restart,
    btn.stop,
    h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
    h('label', { class: 'check small', for: pofId }, pof, 'Pause on failure'),
    h('span', { class: 'tb-sep', 'aria-hidden': 'true' }),
    btn.save,
    h('span', { class: 'tb-spacer' }),
    status,
  );

  // Left: source + outline.
  const editorHost = h('div', { class: 'dbg-editor', id: 'dbg-editor' });
  const fileLabel = h('span', { class: 'pane-title dbg-file' });
  const dirtyDot = h('span', { class: 'dirty-dot', hidden: true, role: 'img', 'aria-label': 'unsaved changes' });
  const source = h('section', { class: 'dbg-source', 'aria-label': 'Journey source' }, h('div', { class: 'pane-head' }, h('div', { class: 'row' }, fileLabel, dirtyDot), h('span', { class: 'muted small', text: 'Click the gutter to set a breakpoint' })), editorHost);
  const outlineList = h('ol', { class: 'dbg-outline', id: 'dbg-outline', 'aria-label': 'Steps' });
  const outline = h('section', { class: 'dbg-outline-pane', 'aria-label': 'Steps' }, h('div', { class: 'pane-head' }, h('h2', { class: 'pane-title', text: 'Steps' })), outlineList);
  const leftSplit = createSplit({ direction: 'column', first: source, second: outline, size: 220, min: 90, sizeSecond: true, storageKey: 'dbg-outline', label: 'Resize steps list' });

  // Center: live view. Right: panels.
  live = createLiveView({ insertStep });
  const panelCtx = {
    path: () => file?.path,
    steps: stepLines,
    goToLine: (line: number) => view && goToLine(view, line),
    topCount: () => cards.length,
    blocks: (index: number) => {
      const out: Array<{ text: string; line?: number }> = [];
      for (let e = entryForIndex(index), p = e?.parent; p !== undefined; p = entries[p]?.parent) out.push({ text: entries[p].text, line: entries[p].line });
      return out;
    },
  };
  const tabs = createTabs({
    label: 'Debugger panels',
    class: 'dbg-tabs',
    tabs: [
      { id: 'vars', title: 'Variables', mount: (el) => mountVariables(el) },
      { id: 'step', title: 'Step', mount: (el) => mountStepDetails(el, panelCtx) },
      { id: 'console', title: 'Console', mount: (el) => mountConsole(el) },
      { id: 'network', title: 'Network', mount: (el) => mountNetwork(el) },
      { id: 'stack', title: 'Stack', mount: (el) => mountCallStack(el, panelCtx) },
      { id: 'bps', title: 'Breakpoints', mount: (el) => mountBreakpoints(el, panelCtx, pofMirror) },
    ],
  });
  const side = h('aside', { class: 'dbg-side', 'aria-label': 'Debugger panels' }, tabs.el);
  const centerSplit = createSplit({ direction: 'row', first: live.el, second: side, size: 420, min: 260, max: 760, sizeSecond: true, storageKey: 'dbg-side', label: 'Resize debugger panels' });

  // Bottom: edit-and-continue + step console.
  const edit = createEditPanel({ stepText, applyToFile, codeOnly: isCode });
  const repl = createStepConsole({ insertStep });
  const bottom = h('section', { class: 'dbg-bottom', 'aria-label': 'Edit and step console' }, edit.el, repl.el);
  const rightSplit = createSplit({ direction: 'column', first: centerSplit.el, second: bottom, size: 270, min: 110, sizeSecond: true, storageKey: 'dbg-bottom', label: 'Resize step console' });
  const main = createSplit({ direction: 'row', first: leftSplit.el, second: rightSplit.el, size: 400, min: 260, max: 760, storageKey: 'dbg-left', label: 'Resize journey source' });
  ctx.root.classList.add('page-debug');
  ctx.root.append(heading, toolbar, main.el);

  journeySel.addEventListener('change', () => {
    const p = journeySel.value;
    if (p) navigate(link('debug', p));
  });
  journeys.subscribe((list) => {
    clear(journeySel).appendChild(h('option', { value: '', text: list.length ? 'Choose a journey…' : 'No journeys' }));
    for (const j of list.filter((x) => x.format === 'ez' || x.format === 'yaml' || x.format === 'json' || x.format === 'ts')) journeySel.appendChild(h('option', { value: j.path, text: `${j.name ?? j.path}${j.format === 'ts' ? ' (code)' : ''}`, disabled: !!j.error }));
    journeySel.value = file?.path ?? '';
  });

  return { heading, journeySel, btn, status, editorHost, fileLabel, dirtyDot, outlineList, tabs, edit, repl, pof };
}

// ------------------------------------------------------------------ file

async function openFile(path: string): Promise<void> {
  if (!ui) return;
  if (file?.path === path && view) return;
  if (dirty() && !(await import('../../ui/modal.js').then((m) => m.confirmDialog({ title: 'Discard unsaved changes?', message: `${file!.path} has unsaved changes in the debugger.`, confirm: 'Discard', danger: true })))) {
    navigate(link('debug', file!.path), { replace: true });
    return;
  }
  let r: { path: string; format: Format; content: string };
  try {
    r = await api.get(`/api/file?path=${encodeURIComponent(path)}`);
  } catch (e) {
    toastError(`Could not open ${path}: ${(e as Error).message}`);
    return;
  }
  file = { path: r.path, format: r.format, saved: r.content };
  try {
    localStorage.setItem(LAST_KEY, r.path);
  } catch {
    // ignore
  }
  const state = withDebugExtensions(
    createEditorState({
      path: r.path,
      format: r.format,
      content: r.content,
      onChange: () => {
        scheduleModel();
        renderDirty();
      },
      onValidated: (v) => (validation = v),
    }),
  );
  if (!view) view = createEditorView(ui.editorHost, state);
  else view.setState(state);
  ui.fileLabel.textContent = basename(r.path);
  ui.fileLabel.title = r.path;
  ui.journeySel.value = r.path;
  renderDirty();
  await loadModel();
  paintCurrent();
}

function renderDirty(): void {
  if (!ui) return;
  ui.dirtyDot.hidden = !dirty();
  ui.btn.save.disabled = !dirty();
}

let modelTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleModel(): void {
  clearTimeout(modelTimer);
  modelTimer = setTimeout(() => void loadModel(), 300);
}

/** Steps of the open file with lines: `.ez` through the debugger outline (block-aware), YAML/JSON through the step model. */
async function loadModel(): Promise<void> {
  if (!file) return;
  try {
    if (file.format === 'ts') {
      // Code journeys: every SDK call line is a step; ids are the runner's line ids (L12).
      entries = codeOutline(textOf()).map((x, pos) => ({ pos, id: `L${x.line}`, text: x.text, expects: [], line: x.line, endLine: x.line, depth: 0 }));
    } else if (file.format === 'ez') {
      const o = await api.post<{ entries: Card[] }>('/api/debug/outline', { content: textOf() });
      if (o.entries.length || !entries.length) entries = o.entries;
    } else {
      const m = await api.post<{ steps: Card[] }>('/api/model', { content: textOf(), format: file.format });
      if (m.steps.length || !entries.length) entries = m.steps.map((s, pos) => ({ ...s, pos, depth: 0 }));
    }
    cards = entries.filter((e) => e.depth === 0 && e.index !== undefined);
  } catch {
    // keep the last good outline
  }
  renderOutline();
  dbg.update((d) => ({ ...d }));
}

async function save(): Promise<boolean> {
  if (!file || !view) return false;
  const content = textOf();
  try {
    const r = await api.put<{ saved: string; validation: { ok: boolean } }>('/api/file', { path: file.path, content });
    file.saved = content;
    renderDirty();
    toast(`Saved ${r.saved}${r.validation.ok ? '' : ' (with problems)'}`, { kind: r.validation.ok ? 'success' : 'warning', timeout: 2500 });
    void refreshJourneys();
    return true;
  } catch (e) {
    toastError(`Not saved: ${(e as Error).message}`);
    return false;
  }
}

/** The innermost step whose lines contain `line`. */
function entryAtLine(line: number): Card | undefined {
  return [...entries].reverse().find((c) => c.line !== undefined && c.line <= line);
}

/** The file step a runtime step index refers to: top-level by index, nested (blocks, loops) by step id. */
export function entryForIndex(index: number | undefined): Card | undefined {
  if (index === undefined) return undefined;
  if (isCode()) {
    const id = codeBase(dbg.get().steps[index]?.stepId);
    return id ? entries.find((e) => e.id === id) : undefined;
  }
  if (index < cards.length) return cards[index];
  const id = dbg.get().steps[index]?.stepId;
  return id ? entries.find((e) => e.id === id && e.depth > 0) : undefined;
}

function cursorLine(): number {
  return view ? view.state.doc.lineAt(view.state.selection.main.head).number : 1;
}

/** Insert an `.ez` step after the step at the cursor (or after the current debug step). */
function insertStep(text: string): void {
  if (!view || !file) return;
  if (file.format !== 'ez') {
    toastError('Steps can be inserted into .ez journeys; copy it for YAML/JSON.');
    return;
  }
  const d = dbg.get();
  const atCursor = entryAtLine(cursorLine());
  const ref = view.hasFocus || d.current === undefined ? atCursor : entryForIndex(d.current) ?? atCursor;
  const doc = view.state.doc;
  const afterLine = Math.min(doc.lines, ref?.block ? ref.line ?? doc.lines : ref?.endLine ?? ref?.line ?? doc.lines);
  const ln = doc.line(afterLine);
  const baseIndent = /^\s*/.exec(doc.line(ref?.line ?? afterLine).text)?.[0] ?? '';
  const indent = ref?.block ? `${baseIndent}  ` : baseIndent;
  view.dispatch({ changes: { from: ln.to, insert: `\n${indent}${text}` }, selection: EditorSelection.cursor(ln.to + 1 + indent.length + text.length), scrollIntoView: true });
  toast(`Inserted at line ${afterLine + 1} (unsaved: Ctrl+S saves)`, { timeout: 2500 });
  announce(`Inserted step at line ${afterLine + 1}`);
}

function stepText(index: number): string | undefined {
  const c = entryForIndex(index);
  if (!c) return undefined;
  return [c.text, ...c.expects.map((e) => `  Expect ${e}`)].join('\n');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';

/**
 * Write an edited step into the file, keeping its id. `.ez` steps (top-level
 * or nested in a block) are replaced on their own lines so everything else
 * stays byte for byte; YAML/JSON go through the step model.
 */
async function applyToFile(index: number, text: string): Promise<boolean> {
  if (!file || !view) return false;
  const original = entryForIndex(index);
  if (!original || original.line === undefined) {
    toastError('This step is not in the open file (it may come from a sub-journey or a hook)');
    return false;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let stepLine = lines[0];
  const expects = lines.slice(1).map((l) => l.replace(/^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:that\s+)?/i, ''));
  try {
    let content: string;
    if (file.format === 'ez') {
      const hasId = /\[[^\]]*\bid\s*=/.test(stepLine);
      // The step id comes from its text (a "-2" suffix for repeats): keep the old one when the text changes it.
      if (!hasId && slug(stepLine.replace(/\s*\[[^\]]*\]\s*$/, '')) !== original.id.replace(/-\d+$/, '') && slug(stepLine) !== original.id) stepLine = `${stepLine} [id=${original.id}]`;
      const doc = textOf().split('\n');
      const indent = /^\s*/.exec(doc[original.line - 1] ?? '')?.[0] ?? '';
      const last = original.block ? original.line + original.expects.length : original.endLine ?? original.line;
      // Expectations of a block step sit after its End: only the step line (and its own following Expect lines) change.
      const replaced = [`${indent}${stepLine}`, ...expects.map((e) => `${indent}  Expect ${e}`)];
      if (original.block) doc.splice(original.line - 1, 1, replaced[0]);
      else doc.splice(original.line - 1, last - original.line + 1, ...replaced);
      content = doc.join('\n');
      const v = await api.post<{ ok: boolean; errors: Array<{ message: string }> }>('/api/validate', { content, format: 'ez' });
      if (!v.ok) {
        toastError(`Not applied: ${v.errors.map((e) => e.message).join('; ')}`);
        return false;
      }
    } else {
      const build = (line: string) => cards.map((c) => (c.index === original.index ? { text: line, expects } : { from: c.index }));
      content = (await api.post<{ content: string }>('/api/model/apply', { content: textOf(), format: file.format, steps: build(stepLine) })).content;
    }
    replaceDoc(view, content, 'input.debug');
    const ok = await save();
    await loadModel();
    if (ok) announce('Applied the edited step to the journey file');
    return ok;
  } catch (e) {
    toastError(`Could not apply: ${(e as Error).message}`);
    return false;
  }
}

// ------------------------------------------------------------------ outline + current step

/** Runtime executions of a nested file step (loop iterations, If branches): every index that ran with its id. */
function runsOf(e: Card, d = here()): number[] {
  const code = isCode();
  return (d.order ?? []).filter((i, k, all) => i >= cards.length && all.indexOf(i) === k && (code ? codeBase(d.steps[i]?.stepId) === e.id : d.steps[i]?.stepId === e.id));
}

function statusIconFor(st: string | undefined, here: boolean, paused: boolean): HTMLElement {
  if (here && paused && (!st || st === 'running')) return h('span', { class: 'status-icon st-pausedhere', role: 'img', 'aria-label': 'Paused here', title: 'Paused here' }, kitIcon('pause', { size: 11 }));
  if (st) return statusIcon(st);
  return h('span', { class: 'status-icon st-pending', role: 'img', 'aria-label': 'Not run yet', title: 'Not run yet' });
}

/** The session's view when it debugs the open file; otherwise an empty one (another journey's statuses must not show here). */
function here(): DbgView {
  const d = dbg.get();
  return file && d.journeyId && journeyIdsForPath(file.path).includes(d.journeyId) ? d : { phase: 'idle', steps: {}, order: [] };
}

function renderOutline(): void {
  if (!ui) return;
  const d = here();
  const list = ui.outlineList;
  clear(list);
  const bpLines = new Set(file ? bpsFor(file.path).map((b) => b.line) : []);
  const live = ['running', 'paused', 'starting'].includes(d.phase);
  const failedHere = d.phase === 'paused' && d.state?.phase === 'failed';
  const matched = new Set<number>();
  for (const c of entries) {
    let st: string | undefined;
    let dur: number | undefined;
    let current = false;
    let note = '';
    if (c.depth === 0 && c.index !== undefined && !c.block) {
      st = d.steps[c.index]?.status;
      dur = d.steps[c.index]?.durationMs;
      current = live && d.current === c.index;
    } else if (c.block) {
      // A block's status is its children's: failed if any failed, running while inside.
      const kids = entries.filter((x) => x.parent === c.pos).flatMap((x) => runsOf(x, d));
      if (kids.length) st = kids.some((i) => d.steps[i]?.status === 'failed') ? 'failed' : kids.some((i) => d.steps[i]?.status === 'running') ? 'running' : 'passed';
      current = live && d.current !== undefined && kids.includes(d.current);
    } else {
      const runs = runsOf(c, d);
      runs.forEach((i) => matched.add(i));
      const lastRun = runs[runs.length - 1];
      if (lastRun !== undefined) {
        st = d.steps[lastRun]?.status;
        dur = d.steps[lastRun]?.durationMs;
      }
      current = live && d.current !== undefined && runs.includes(d.current);
      if (runs.length > 1) note = `×${runs.length}`;
    }
    const label = c.depth === 0 ? (c.index === undefined && isCode() ? `${c.line}` : String((c.index ?? 0) + 1)) : '↳';
    const li = h(
      'li',
      { class: ['dbg-step', c.depth > 0 && 'nested', c.block && 'block', current && 'current', st && `st-${st}`, current && failedHere && !c.block && 'failed-here'], dataset: { index: c.index, id: c.id, status: st || 'pending', depth: c.depth } },
      h(
        'button',
        {
          type: 'button',
          class: 'dbg-step-btn',
          'aria-current': current && !c.block ? 'step' : undefined,
          onclick: () => c.line && view && goToLine(view, c.line),
          oncontextmenu: (e: MouseEvent) => {
            if (!file || !c.line || c.block) return;
            e.preventDefault();
            breakpointMenu(file.path, c.line, e.clientX, e.clientY, c.text);
          },
        },
        h('span', { class: 'sr-only', text: c.depth > 0 ? `Nested step, level ${c.depth}:` : c.block ? 'Block:' : 'Step' }),
        h('span', { class: 'dbg-step-num', 'aria-hidden': c.depth > 0 ? 'true' : undefined, text: label }),
        statusIconFor(st, current, d.phase === 'paused'),
        c.line !== undefined && bpLines.has(c.line) ? h('span', { class: 'bp-dot small', role: 'img', 'aria-label': 'breakpoint' }) : null,
        h('span', { class: 'dbg-step-text', text: c.text }),
        note ? h('span', { class: 'pill pill-run', title: `Ran ${note.slice(1)} times (loop iterations)`, text: note }) : null,
        dur !== undefined ? h('span', { class: 'dbg-step-dur', text: `${Math.round(dur)} ms` }) : null,
      ),
    );
    li.style.setProperty('--depth', String(c.depth));
    list.appendChild(li);
  }
  // Executed steps that are not lines of this file (sub-journeys, hooks).
  const extra = (d.order ?? []).filter((i, k, all) => i >= cards.length && all.indexOf(i) === k && !matched.has(i));
  if (extra.length) {
    list.appendChild(h('li', { class: 'dbg-step-sep', text: 'Other executed steps (sub-journeys, hooks)' }));
    for (const i of extra) {
      const s = d.steps[i];
      const current = live && d.current === i;
      list.appendChild(
        h('li', { class: ['dbg-step', 'nested', current && 'current', s?.status && `st-${s.status}`], dataset: { index: i, status: s?.status ?? 'pending' } },
          h('div', { class: 'dbg-step-btn' }, h('span', { class: 'dbg-step-num', text: '↳' }), statusIconFor(s?.status, current, d.phase === 'paused'), h('span', { class: 'dbg-step-text', text: s?.intent ?? s?.stepId ?? '' }), s?.durationMs !== undefined ? h('span', { class: 'dbg-step-dur', text: `${Math.round(s.durationMs)} ms` }) : null),
        ),
      );
    }
  }
  if (!entries.length) list.appendChild(h('li', { class: 'panel-empty', text: file ? 'No steps found (fix the journey first).' : 'Choose a journey to debug.' }));
}

function paintCurrent(): void {
  if (!view) return;
  const d = dbg.get();
  const sessionHere = !!file && !!d.journeyId && journeyIdsForPath(file.path).includes(d.journeyId);
  const active = sessionHere && ['running', 'paused'].includes(d.phase) && d.current !== undefined;
  // Code journeys: the paused call's own source line (the server reports it), else the running step's line id.
  const src = isCode() && d.phase === 'paused' && d.state && 'source' in d.state ? (d.state as { source?: { file: string; line: number } }).source : undefined;
  const codeLine = src && file && src.file.replace(/\\/g, '/').endsWith(file.path) ? src.line : undefined;
  const line = active ? codeLine ?? entryForIndex(d.current)?.line : undefined;
  const kind = d.phase === 'paused' ? (d.state?.phase === 'failed' ? 'failed' : 'paused') : 'running';
  view.dispatch({ effects: setCurrent.of(line ? { line, kind } : null) });
  if (line && d.phase === 'paused') {
    const ln = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({ effects: EditorView.scrollIntoView(ln.from, { y: 'nearest' }) });
  }
}

function journeyIdForPath(path: string): string | undefined {
  const j = journeys.get().find((x) => x.path === path);
  // A code file can declare several journeys: debug the one around the cursor (else the first).
  if (j?.code?.length && file?.path === path && view) {
    const at = cursorLine();
    const lines = codeJourneyLines(textOf());
    const k = lines.reduce((best, x, i) => (x.line <= at ? i : best), 0);
    return j.code[k]?.id ?? j.id;
  }
  return j?.id;
}

/** Every journey id a file holds (one, or each journey() of a code file). */
function journeyIdsForPath(path: string): string[] {
  const j = journeys.get().find((x) => x.path === path);
  if (!j) return [];
  return j.code?.length ? j.code.map((c) => c.id) : j.id ? [j.id] : [];
}

function pathForJourney(id: string): string | undefined {
  return journeys.get().find((j) => j.id === id)?.path;
}

function renderStatus(): void {
  if (!ui) return;
  const d = dbg.get();
  const paused = d.phase === 'paused';
  const active = isActive();
  const b = ui.btn;
  const label = paused ? 'Continue' : 'Start debugging';
  (b.start.querySelector('span') as HTMLElement).textContent = label;
  b.start.title = `${label} (${paused ? 'F8 / F5' : 'F5'})`;
  b.start.disabled = d.phase === 'starting' || d.phase === 'running';
  b.pause.disabled = d.phase !== 'running';
  b.over.disabled = !paused;
  b.into.disabled = !paused;
  b.cursor.disabled = d.phase === 'starting';
  b.restart.disabled = !active;
  b.stop.disabled = !active;
  const s = ui.status;
  clear(s);
  const nestedIntent = d.current !== undefined && d.current >= cards.length ? d.steps[d.current]?.intent ?? d.state?.intent : undefined;
  const actor = d.current !== undefined ? d.steps[d.current]?.actor ?? d.state?.actor : undefined;
  const base = d.current === undefined ? '' : nestedIntent !== undefined ? `nested step "${nestedIntent}"` : `step ${d.current + 1}`;
  // Multi-actor journeys: say whose browser is acting (and shown).
  const step = base && actor ? `${base} as ${actor}` : base;
  let text: string;
  let tone: string;
  switch (d.phase) {
    case 'starting':
      text = 'Starting the browser…';
      tone = 'running';
      break;
    case 'running':
      text = `Running${step ? ` ${step}` : ''}`;
      tone = 'running';
      break;
    case 'paused':
      text = d.state?.phase === 'failed' ? `Paused on failure at ${step}` : `Paused before ${step}${d.state?.reason ? ` (${d.state.reason.replace(/ bp-\d+$/, '')})` : ''}`;
      tone = d.state?.phase === 'failed' ? 'failed' : 'paused';
      break;
    case 'done':
      text = `Finished${d.result?.status ? `: ${d.result.status}` : ''}`;
      tone = d.result?.status?.startsWith('passed') ? 'passed' : 'failed';
      break;
    case 'error':
      text = d.error ? `Error: ${d.error}` : 'The debug session failed';
      tone = 'failed';
      break;
    default:
      text = 'Not debugging';
      tone = 'idle';
  }
  s.dataset.state = d.phase;
  s.dataset.tone = tone;
  s.append(h('span', { class: `dbg-dot tone-${tone}`, 'aria-hidden': 'true' }), h('span', { text }));
  if (d.phase === 'done' && d.result?.runId) s.append(h('a', { class: 'link-btn small', href: link('runs', d.result.runId), text: 'Open run' }));
}

// ------------------------------------------------------------------ session actions

type BpTarget = { stepIndex: number } | { stepId: string } | { line: number; file: string };

/** Where a breakpoint on a line points: a top-level step by index, a nested one by id (it pauses in every iteration), a code line. */
function bpTargetAt(line: number): BpTarget | undefined {
  const e = entries.find((x) => x.line === line);
  if (!e) return undefined;
  if (isCode() && file) return { line, file: file.path };
  if (e.block) {
    // A block line has no checkpoint of its own: stop before its first child.
    const first = entries.find((x) => x.parent === e.pos && !x.block);
    return first ? { stepId: first.id } : undefined;
  }
  return e.depth === 0 && e.index !== undefined ? { stepIndex: e.index } : { stepId: e.id };
}

function breakpointsForStart(): Array<BpTarget & { condition?: string; enabled?: boolean }> {
  if (!file) return [];
  const out: Array<BpTarget & { condition?: string; enabled?: boolean }> = [];
  for (const b of bpsFor(file.path)) {
    const t = bpTargetAt(b.line);
    if (t) out.push({ ...t, enabled: b.enabled, ...(b.condition ? { condition: b.condition } : {}) });
  }
  return out;
}

const sameTarget = (t: BpTarget, s: { stepIndex?: number; stepId?: string; line?: number }) => ('line' in t ? s.line === t.line : 'stepIndex' in t ? s.stepIndex === t.stepIndex : s.stepId === t.stepId);

async function linkServerBreakpoints(): Promise<void> {
  if (!file) return;
  try {
    const r = await api.get<{ breakpoints: Array<{ id: string; stepIndex?: number; stepId?: string; line?: number }> }>('/api/debug/breakpoints');
    const mine = bpsFor(file.path);
    breakpoints.update((all) =>
      all.map((b) => {
        if (!mine.includes(b)) return b;
        const t = bpTargetAt(b.line);
        const s = t ? r.breakpoints.find((x) => sameTarget(t, x)) : undefined;
        return s ? { ...b, serverId: s.id } : b;
      }),
    );
  } catch {
    // ignore
  }
}

async function start(opts: { runTo?: BpTarget } = {}): Promise<void> {
  if (!file) {
    toastError('Choose a journey to debug');
    return;
  }
  if (dirty() && !(await save())) return;
  await loadModel();
  if (!validation?.ok && validation) {
    toastError('Fix the problems in this journey before debugging it');
    return;
  }
  let id = journeyIdForPath(file.path);
  if (!id) {
    await refreshJourneys();
    id = journeyIdForPath(file.path);
  }
  if (!id) {
    toastError('This journey has no id yet: fix its problems and save it first.');
    return;
  }
  const bps = breakpointsForStart();
  try {
    await startSession({ journey: id, breakpoints: bps, pauseOnFailure, pauseAtStart: opts.runTo === undefined && !bps.some((b) => b.enabled !== false) });
  } catch (e) {
    toastError(`Could not start debugging: ${(e as Error).message}`);
    return;
  }
  if (opts.runTo !== undefined) await command('runToStep', opts.runTo);
  live?.connect();
  void linkServerBreakpoints();
  announce(`Debugging ${id}`);
}

async function startOrContinue(): Promise<void> {
  const d = dbg.get();
  if (d.phase === 'paused') await command('resume');
  else if (d.phase === 'idle' || d.phase === 'done' || d.phase === 'error') await start();
}

async function runToCursor(): Promise<void> {
  const e = entryAtLine(cursorLine());
  const t = e?.line !== undefined ? bpTargetAt(e.line) : undefined;
  if (!t) {
    toastError('Put the cursor on a step');
    return;
  }
  const d = dbg.get();
  if (!isActive() && d.phase !== 'paused') await start({ runTo: t });
  else await command('runToStep', t);
}

async function restart(): Promise<void> {
  await stopSession();
  // Wait for the run to wind down.
  for (let i = 0; i < 100 && isActive(); i++) await new Promise((r) => setTimeout(r, 100));
  await start();
}

function toggleBreakpointAtCursor(): void {
  const active = document.activeElement?.closest('.cm-editor') as HTMLElement | null;
  const v = (active && EditorView.findFromDOM(active)) || (onDebugPage() ? view : undefined);
  if (!v) return;
  const path = onDebugPage() ? file?.path : currentRoute.get().rest.replace(/:\d+$/, '');
  if (!path) return;
  const format = /\.ya?ml$/i.test(path) ? 'yaml' : /\.json$/i.test(path) ? 'json' : /\.(?:m?ts|m?js)$/i.test(path) ? 'ts' : 'ez';
  const line = stepLineFor(v.state.doc.toString(), format, v.state.doc.lineAt(v.state.selection.main.head).number);
  if (line === undefined) {
    toast('Put the cursor on a step to set a breakpoint', { timeout: 1800 });
    return;
  }
  toggleBreakpoint(path, line);
  const on = breakpoints.get().some((b) => b.path === path && b.line === line);
  announce(`Breakpoint ${on ? 'set' : 'removed'} at line ${line}`);
}

/** Debug the journey open in the Journeys editor. */
function debugFromEditor(): void {
  const path = currentRoute.get().rest.replace(/:\d+$/, '');
  if (!path) {
    toastError('Open a journey first');
    return;
  }
  if (anyDirty()) toast('Unsaved editor changes are not debugged: save first (Ctrl+S).', { kind: 'warning', timeout: 4000 });
  navigate(link('debug', path));
  setTimeout(() => void waitAndStart(path), 0);
}

async function waitAndStart(path: string): Promise<void> {
  for (let i = 0; i < 50 && file?.path !== path; i++) await new Promise((r) => setTimeout(r, 60));
  if (file?.path === path && !isActive()) await start();
}

// Mirror breakpoint edits into the running session.
function installSync(): void {
  const live = () => isActive() && !!file && dbg.get().journeyId === journeyIdForPath(file.path);
  const add = async (b: Bp) => {
    if (!live() || b.path !== file?.path) return;
    const t = bpTargetAt(b.line);
    if (!t) return;
    try {
      const s = await api.post<{ id: string }>('/api/debug/breakpoints', { ...t, enabled: b.enabled, ...(b.condition ? { condition: b.condition } : {}) });
      breakpoints.update((all) => all.map((x) => (x.id === b.id ? { ...x, serverId: s.id } : x)));
    } catch (e) {
      toastError(`Breakpoint: ${(e as Error).message}`);
    }
  };
  const del = async (b: Bp) => {
    if (!live() || !b.serverId) return;
    await api.del(`/api/debug/breakpoints/${encodeURIComponent(b.serverId)}`).catch(() => undefined);
  };
  bpSync.added = (b) => void add(b);
  bpSync.removed = (b) => void del(b);
  bpSync.changed = (b) => void del(b).then(() => add(b));
}

// ------------------------------------------------------------------ registration

export function registerDebugPage(): void {
  installBreakpointGutter();
  installSync();
  registerPage({
    id: 'debug',
    title: 'Debug',
    icon: 'activity',
    order: 25,
    mount(ctx) {
      ui = buildUi(ctx);
      void loadGrammar().catch(() => undefined);
      void refreshVocabulary().catch(() => undefined);
      dbg.subscribe(() => {
        renderStatus();
        renderOutline();
        paintCurrent();
        const d = dbg.get();
        // Follow the session's journey when it is not the one on screen.
        if (onDebugPage() && d.journeyId && file && journeyIdForPath(file.path) !== d.journeyId && isActive()) {
          const p = pathForJourney(d.journeyId);
          if (p) navigate(link('debug', p), { replace: true });
        }
        if (isActive()) live?.connect();
        else if (d.phase === 'done' || d.phase === 'error') live?.disconnect();
        if (d.state?.breakpoints && file) {
          const hits = new Map(d.state.breakpoints.map((b) => [b.id, b.hits]));
          const mine = bpsFor(file.path);
          if (mine.some((b) => b.serverId && hits.get(b.serverId) !== b.hits)) breakpoints.update((all) => all.map((b) => (b.serverId && hits.has(b.serverId) ? { ...b, hits: hits.get(b.serverId) } : b)));
        }
      });
      breakpoints.subscribe(() => renderOutline(), false);
      void resume().then(() => {
        if (isActive()) live?.connect();
      });
      return {
        show(r: Route) {
          let path = r.rest;
          if (!path) {
            const d = dbg.get();
            path = (d.journeyId && pathForJourney(d.journeyId)) || file?.path || (() => {
              try {
                return localStorage.getItem(LAST_KEY) ?? '';
              } catch {
                return '';
              }
            })();
            if (!path) {
              const first = journeys.get()[0];
              if (first) path = first.path;
            }
            if (path) navigate(link('debug', path), { replace: true });
          }
          if (path) void openFile(path);
          void refreshState();
        },
        focus() {
          if (view) view.focus();
          else ui?.heading.focus();
        },
      };
    },
  });

  const whenDebug = () => onDebugPage();
  const whenAny = () => onDebugPage() || (onJourneysPage() && !!currentRoute.get().rest);
  const cmd = (id: string, title: string, shortcut: string | undefined, when: () => boolean, run: () => void, keywords: string[] = []) => {
    registerCommand({ id, title, group: 'Debug', shortcut, when, run, keywords });
    if (shortcut) registerShortcut({ keys: shortcut, title, group: 'Debug', inInputs: true, when, run: () => run() });
  };
  cmd('debug.start', 'Debug this journey / Continue', 'F5', whenAny, () => (onJourneysPage() ? debugFromEditor() : void startOrContinue()), ['start', 'run', 'debugger']);
  cmd('debug.continue', 'Continue', 'F8', () => onDebugPage() && isPaused(), () => void command('resume'));
  cmd('debug.pause', 'Pause', 'F6', () => onDebugPage() && dbg.get().phase === 'running', () => void command('pause'));
  cmd('debug.stepOver', 'Step over', 'F10', () => onDebugPage() && isPaused(), () => void command('stepOver'));
  cmd('debug.stepInto', 'Step into (verification, healing)', 'F11', () => onDebugPage() && isPaused(), () => void command('stepInto'));
  cmd('debug.runToCursor', 'Run to cursor', 'Mod+F10', whenDebug, () => void runToCursor());
  cmd('debug.restart', 'Restart debugging', 'Mod+Shift+F5', () => onDebugPage() && isActive(), () => void restart());
  cmd('debug.stop', 'Stop debugging', 'Shift+F5', () => onDebugPage() && isActive(), () => void stopSession());
  cmd('debug.toggleBreakpoint', 'Toggle breakpoint on the step at the cursor', 'F9', whenAny, () => toggleBreakpointAtCursor());
  cmd('debug.inspect', 'Inspect element in the live view', 'Alt+I', () => onDebugPage() && isPaused(), () => live?.toggleInspect());
  cmd('debug.save', 'Save journey (debugger)', 'Mod+S', () => onDebugPage() && dirty(), () => void save());
  cmd('debug.console', 'Focus the step console', undefined, () => onDebugPage(), () => ui?.repl.focus());
  cmd('debug.edit', 'Edit the current step (edit and continue)', undefined, () => onDebugPage() && isPaused(), () => ui?.edit.open());
  cmd('debug.open', 'Open the debugger', undefined, () => true, () => navigate(link('debug')));
}
