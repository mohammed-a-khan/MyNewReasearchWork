/**
 * Breakpoints: one list for the whole Studio (kept per journey file and
 * line, remembered across reloads), a CodeMirror gutter that shows and
 * toggles them on step lines (in the Journeys editor and the Debugger), a
 * context menu, and a condition picker built from the declarative
 * post-condition types: no free-text code, only values.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view';
import { api } from '../../core/api.js';
import { h, uid } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { vocabulary } from '../../core/state.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { editorExtensions } from '../journeys/editor.js';
import { ezOutline, structuredOutline } from '../journeys/ezlang.js';
import { codeOutline } from '../journeys/sdk.js';
import { featureOutline } from '../journeys/gherkin.js';
import { openMenu } from './kit.js';

export interface Bp {
  /** Stable client id. */
  id: string;
  path: string;
  /** 1-based line of the step. */
  line: number;
  enabled: boolean;
  /** `.ez` condition text built by the picker, e.g. `page contains "Saved"`. */
  condition?: string;
  /** Id of the breakpoint in the running debug session. */
  serverId?: string;
  hits?: number;
}

const KEY = 'ez-debug-breakpoints';

function load(): Bp[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Bp[];
    return Array.isArray(v) ? v.filter((b) => typeof b.path === 'string' && Number.isInteger(b.line)).map((b) => ({ ...b, serverId: undefined, hits: undefined })) : [];
  } catch {
    return [];
  }
}

export const breakpoints = store<Bp[]>(load());
breakpoints.subscribe((list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.map(({ serverId: _s, hits: _h, ...b }) => b)));
  } catch {
    // storage unavailable
  }
}, false);

let seq = 0;
const newId = () => `cbp-${Date.now().toString(36)}-${++seq}`;

export const bpsFor = (path: string) => breakpoints.get().filter((b) => b.path === path).sort((a, b) => a.line - b.line);

/** Hooks the debugger installs to mirror changes into a running session. */
export const bpSync: { added?(b: Bp): void; removed?(b: Bp): void; changed?(b: Bp): void } = {};

export function addBreakpoint(path: string, line: number, condition?: string): Bp {
  const existing = breakpoints.get().find((b) => b.path === path && b.line === line);
  if (existing) {
    if (condition !== undefined) updateBreakpoint(existing.id, { condition: condition || undefined });
    return existing;
  }
  const bp: Bp = { id: newId(), path, line, enabled: true, ...(condition ? { condition } : {}) };
  breakpoints.update((l) => [...l, bp]);
  bpSync.added?.(bp);
  return bp;
}

export function removeBreakpoint(id: string): void {
  const bp = breakpoints.get().find((b) => b.id === id);
  if (!bp) return;
  breakpoints.update((l) => l.filter((b) => b.id !== id));
  bpSync.removed?.(bp);
}

export function updateBreakpoint(id: string, patch: Partial<Bp>): void {
  let changed: Bp | undefined;
  breakpoints.update((l) => l.map((b) => (b.id === id ? (changed = { ...b, ...patch }) : b)));
  if (changed) bpSync.changed?.(changed);
}

export function toggleBreakpoint(path: string, line: number): void {
  const bp = breakpoints.get().find((b) => b.path === path && b.line === line);
  if (bp) removeBreakpoint(bp.id);
  else addBreakpoint(path, line);
}

/** The step line a line belongs to (an Expect line belongs to its step), or undefined outside steps. */
/** Block structure lines ("End", "Otherwise", "On failure") are not steps. */
const STRUCTURE = /^(?:end\b.*|done|next|endif|otherwise|else|on\s+(?:failure|error)|catch|if\s+(?:it|that|this)\s+fails|when\s+it\s+fails)\s*:?[.;]?$/i;

function stepItems(text: string, format: string) {
  if (format === 'ts') return codeOutline(text);
  if (format === 'feature') return featureOutline(text).filter((x) => x.kind === 'step');
  return (format === 'ez' ? ezOutline(text) : structuredOutline(text)).filter((x) => x.kind === 'step' && !STRUCTURE.test(x.text));
}

/** The step line a line belongs to (an Expect line belongs to its step), or undefined outside steps. */
export function stepLineFor(text: string, format: string, line: number): number | undefined {
  // Code: only the lines that are SDK calls themselves.
  if (format === 'ts' || format === 'feature') return stepItems(text, format).some((s) => s.line === line) ? line : undefined;
  const lines = text.split(/\r?\n/);
  if (STRUCTURE.test((lines[line - 1] ?? '').trim())) return undefined;
  const hit = [...stepItems(text, format)].reverse().find((s) => s.line <= line);
  return hit?.line;
}

export function stepLines(text: string, format: string): number[] {
  return stepItems(text, format).map((x) => x.line);
}

// ------------------------------------------------------------------ CodeMirror gutter

class BpMarker extends GutterMarker {
  constructor(
    readonly bp: Pick<Bp, 'enabled' | 'condition'>,
  ) {
    super();
  }
  eq(other: BpMarker): boolean {
    return other.bp.enabled === this.bp.enabled && other.bp.condition === this.bp.condition;
  }
  toDOM(): Node {
    const label = `${this.bp.enabled ? '' : 'Disabled '}${this.bp.condition ? 'conditional ' : ''}breakpoint${this.bp.condition ? `: ${this.bp.condition}` : ''}`;
    return h('span', { class: ['bp-dot', !this.bp.enabled && 'off', this.bp.condition && 'cond'], title: label, 'aria-label': label, role: 'img' });
  }
}

class SpacerMarker extends GutterMarker {
  toDOM(): Node {
    return h('span', { class: 'bp-spacer' });
  }
}

const setMarkers = StateEffect.define<Array<{ line: number; bp: Pick<Bp, 'enabled' | 'condition'> }>>();

function markersFor(state: EditorState, list: Array<{ line: number; bp: Pick<Bp, 'enabled' | 'condition'> }>): RangeSet<BpMarker> {
  const doc = state.doc;
  const ranges = list
    .filter((x) => x.line >= 1 && x.line <= doc.lines)
    .sort((a, b) => a.line - b.line)
    .map((x) => new BpMarker(x.bp).range(doc.line(x.line).from));
  return RangeSet.of(ranges, true);
}

/** Lines that carry a marker, in document order. */
function markerLines(state: EditorState, set: RangeSet<BpMarker>): Array<{ line: number; marker: BpMarker }> {
  const out: Array<{ line: number; marker: BpMarker }> = [];
  const it = set.iter();
  while (it.value) {
    out.push({ line: state.doc.lineAt(it.from).number, marker: it.value });
    it.next();
  }
  return out;
}

/** The breakpoint gutter for one journey file. */
export function breakpointGutter(file: { path: string; format: string }): Extension {
  const field = StateField.define<RangeSet<BpMarker>>({
    create: (state) => markersFor(state, bpsFor(file.path).map((b) => ({ line: b.line, bp: b }))),
    update(set, tr) {
      for (const e of tr.effects) if (e.is(setMarkers)) return markersFor(tr.state, e.value);
      return tr.docChanged ? set.map(tr.changes) : set;
    },
  });
  // Keep the store in sync with the editor (lines move as the text is edited) and the editor with the store.
  const sync = ViewPlugin.fromClass(
    class {
      private readonly off: () => void;
      constructor(readonly view: EditorView) {
        this.off = breakpoints.subscribe(() => this.pull(), false);
      }
      pull() {
        const want = bpsFor(file.path).map((b) => ({ line: b.line, bp: { enabled: b.enabled, condition: b.condition } }));
        const have = markerLines(this.view.state, this.view.state.field(field)).map((x) => ({ line: x.line, bp: x.marker.bp }));
        const same = want.length === have.length && want.every((w, i) => w.line === have[i].line && w.bp.enabled === have[i].bp.enabled && w.bp.condition === have[i].bp.condition);
        if (!same) queueMicrotask(() => this.view.dispatch({ effects: setMarkers.of(want) }));
      }
      update(u: { docChanged: boolean; state: EditorState }) {
        if (!u.docChanged) return;
        const lines = markerLines(u.state, u.state.field(field)).map((x) => x.line);
        const list = bpsFor(file.path);
        if (lines.length !== list.length || list.some((b, i) => b.line !== lines[i])) {
          const moved = new Map(list.map((b, i) => [b.id, lines[i]]));
          queueMicrotask(() => breakpoints.update((all) => all.map((b) => (b.path === file.path && moved.get(b.id) !== undefined ? { ...b, line: moved.get(b.id)! } : b)).filter((b) => b.path !== file.path || moved.has(b.id))));
        }
      }
      destroy() {
        this.off();
      }
    },
  );
  const lineAt = (view: EditorView, pos: number) => view.state.doc.lineAt(pos).number;
  return [
    field,
    sync,
    gutter({
      class: 'cm-bp-gutter',
      renderEmptyElements: true,
      markers: (v) => v.state.field(field),
      initialSpacer: () => new SpacerMarker(),
      domEventHandlers: {
        mousedown(view, block, event) {
          if ((event as MouseEvent).button !== 0) return false;
          const stepLine = stepLineFor(view.state.doc.toString(), file.format, lineAt(view, block.from));
          if (stepLine === undefined) {
            toast('Breakpoints go on step lines', { timeout: 1800 });
            return true;
          }
          toggleBreakpoint(file.path, stepLine);
          return true;
        },
        contextmenu(view, block, event) {
          const e = event as MouseEvent;
          e.preventDefault();
          const stepLine = stepLineFor(view.state.doc.toString(), file.format, lineAt(view, block.from));
          if (stepLine !== undefined) breakpointMenu(file.path, stepLine, e.clientX, e.clientY, view.state.doc.line(stepLine).text.trim());
          return true;
        },
      },
    }),
  ];
}

/** Context menu for a step line's breakpoint. */
export function breakpointMenu(path: string, line: number, x: number, y: number, stepText: string): void {
  const bp = breakpoints.get().find((b) => b.path === path && b.line === line);
  openMenu(
    x,
    y,
    bp
      ? [
          { label: bp.condition ? 'Edit condition…' : 'Add condition…', run: () => void editCondition(path, line, stepText) },
          { label: bp.enabled ? 'Disable breakpoint' : 'Enable breakpoint', run: () => updateBreakpoint(bp.id, { enabled: !bp.enabled }) },
          ...(bp.condition ? [{ label: 'Remove condition', run: () => updateBreakpoint(bp.id, { condition: undefined }) }] : []),
          { label: 'Remove breakpoint', danger: true, run: () => removeBreakpoint(bp.id) },
        ]
      : [
          { label: 'Add breakpoint', run: () => void addBreakpoint(path, line) },
          { label: 'Add conditional breakpoint…', run: () => void editCondition(path, line, stepText) },
        ],
    'Breakpoint actions',
  );
}

// ------------------------------------------------------------------ condition picker

interface CondType {
  type: string;
  label: string;
  target?: boolean;
  value?: 'text' | 'number' | 'variable';
  build(t: string, v: string): string;
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** The declarative condition types, phrased exactly as the runner prints them (so they parse back). */
export const CONDITION_TYPES: CondType[] = [
  { type: 'pageContainsText', label: 'The page contains text', value: 'text', build: (_t, v) => `page contains ${q(v)}` },
  { type: 'pageNotContainsText', label: 'The page does not contain text', value: 'text', build: (_t, v) => `page does not contain ${q(v)}` },
  { type: 'urlContains', label: 'The URL contains', value: 'text', build: (_t, v) => `URL contains ${q(v)}` },
  { type: 'titleContains', label: 'The title contains', value: 'text', build: (_t, v) => `title contains ${q(v)}` },
  { type: 'visible', label: 'An element is visible', target: true, build: (t) => `${t} is visible` },
  { type: 'hidden', label: 'An element is hidden', target: true, build: (t) => `${t} is hidden` },
  { type: 'textContains', label: 'An element contains text', target: true, value: 'text', build: (t, v) => `${t} contains ${q(v)}` },
  { type: 'valueEquals', label: 'A field has the value', target: true, value: 'text', build: (t, v) => `${t} has value ${q(v)}` },
  { type: 'count', label: 'Number of matching elements', target: true, value: 'number', build: (t, v) => `there are ${Number(v) || 0} ${t}` },
  { type: 'ledgerEquals', label: 'A captured value equals', value: 'variable', build: (t, v) => `\${${t}} equals ${q(v)}` },
];

/** Validate condition text by parsing it as the expectation of a throwaway step. */
async function checkCondition(text: string): Promise<string | undefined> {
  try {
    const r = await api.post<{ ok: boolean; errors: Array<{ message: string }> }>('/api/validate', { content: `Journey: Condition check\nOpen "/"\nExpect ${text}\n`, format: 'ez' });
    return r.ok ? undefined : r.errors.map((e) => e.message.replace(/^line \d+:\s*/, '')).join('; ');
  } catch (e) {
    return (e as Error).message;
  }
}

/** Open the picker; resolves with the built condition text (or undefined when cancelled). */
export async function pickCondition(initial?: string, stepText?: string): Promise<string | undefined> {
  const typeId = uid('ct');
  const targetId = uid('ctt');
  const valueId = uid('ctv');
  const typeSel = h('select', { id: typeId, class: 'input' }, CONDITION_TYPES.map((c) => h('option', { value: c.type, text: c.label })));
  const target = h('input', { id: targetId, class: 'input mono', placeholder: 'the "Save" button', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${targetId}-help` });
  const value = h('input', { id: valueId, class: 'input', autocomplete: 'off', spellcheck: 'false' });
  const varSel = h('select', { class: 'input', 'aria-label': 'Captured value' });
  for (const v of vocabulary.get().variables) varSel.appendChild(h('option', { value: v, text: v }));
  const preview = h('code', { class: 'cond-preview' });
  const status = h('p', { class: 'help', role: 'status', 'aria-live': 'polite' });
  const targetField = h('div', { class: 'field' }, h('label', { for: targetId, text: 'Element' }), target, h('p', { id: `${targetId}-help`, class: 'help', text: 'An .ez target, e.g. the "Sign in" button, the Email field, testid=total.' }));
  const varField = h('div', { class: 'field' }, h('label', { text: 'Captured value name' }), varSel, h('input', { class: 'input mono', placeholder: 'or type a name', 'aria-label': 'Captured value name', autocomplete: 'off', oninput: (e: Event) => (varSel.value = '', (varName = (e.target as HTMLInputElement).value)) }));
  let varName = '';
  const valueLabel = h('label', { for: valueId, text: 'Value' });
  const valueField = h('div', { class: 'field' }, valueLabel, value);
  // Prefill from an existing condition when it matches one of the shapes.
  if (initial) {
    for (const c of CONDITION_TYPES) {
      const probe = c.build('§T', '§V').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('§T', '(.+?)').replace('"§V"', '"(.*)"').replace('§V', '(\\d+)');
      const m = new RegExp(`^${probe}$`).exec(initial);
      if (m) {
        typeSel.value = c.type;
        const groups = m.slice(1);
        if (c.target) target.value = groups.shift() ?? '';
        else if (c.value === 'variable') varName = groups.shift() ?? '';
        value.value = groups.shift() ?? '';
        break;
      }
    }
  } else if (stepText) {
    const m = /"([^"]+)"/.exec(stepText);
    if (m) value.value = m[1];
  }
  const current = () => CONDITION_TYPES.find((c) => c.type === typeSel.value)!;
  const build = () => {
    const c = current();
    const t = c.value === 'variable' ? varName || varSel.value : target.value.trim();
    return c.build(t, value.value);
  };
  const render = () => {
    const c = current();
    targetField.hidden = !c.target;
    varField.hidden = c.value !== 'variable';
    valueField.hidden = !c.value;
    if (c.value === 'variable') valueLabel.textContent = 'Expected value';
    else valueLabel.textContent = c.value === 'number' ? 'How many' : 'Text';
    value.type = c.value === 'number' ? 'number' : 'text';
    preview.textContent = `Pause only when ${build()}`;
  };
  for (const el of [typeSel, target, value, varSel]) el.addEventListener('input', render);
  render();
  return openModal<string>({
    title: 'Breakpoint condition',
    size: 'md',
    body: h(
      'div',
      { class: 'stack' },
      stepText ? h('p', { class: 'muted' }, 'Step: ', h('code', { text: stepText })) : null,
      h('div', { class: 'field' }, h('label', { for: typeId, text: 'Pause when' }), typeSel),
      targetField,
      varField,
      valueField,
      h('p', { class: 'cond-preview-row' }, preview),
      status,
    ),
    actions: [
      { label: 'Cancel', run: () => '' },
      {
        label: 'Save condition',
        kind: 'primary',
        run: async () => {
          const c = current();
          if (c.target && !target.value.trim()) {
            status.textContent = 'Name the element to check.';
            return undefined;
          }
          if (c.value === 'variable' && !(varName || varSel.value)) {
            status.textContent = 'Choose a captured value.';
            return undefined;
          }
          const text = build();
          status.textContent = 'Checking…';
          const problem = await checkCondition(text);
          if (problem) {
            status.textContent = `Not a valid condition: ${problem}`;
            return undefined;
          }
          return text;
        },
      },
    ],
    initialFocus: typeSel,
  }).result.then((v) => (v ? v : undefined));
}

async function editCondition(path: string, line: number, stepText: string): Promise<void> {
  const bp = breakpoints.get().find((b) => b.path === path && b.line === line);
  const cond = await pickCondition(bp?.condition, stepText);
  if (!cond) return;
  if (bp) updateBreakpoint(bp.id, { condition: cond, enabled: true });
  else addBreakpoint(path, line, cond);
}

export { editCondition };

/** Contribute the gutter to every journey editor (Journeys page and Debugger). */
export function installBreakpointGutter(): void {
  if (!editorExtensions.includes(breakpointGutter)) editorExtensions.push(breakpointGutter);
}
