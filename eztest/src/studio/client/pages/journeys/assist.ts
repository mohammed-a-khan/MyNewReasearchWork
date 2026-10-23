/**
 * Editor assistance for journeys:
 * - autocomplete of `.ez` phrasings (from the grammar), Expect phrasings,
 *   headers, role names, variables, document checks, DB connections, data
 *   entities, tags and lenses (from the project vocabulary);
 * - inline diagnostics from server validation, with "did you mean" quick fixes;
 * - hover docs explaining what a line does and which grammar rule it uses.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection, type Text } from '@codemirror/state';
import type { EditorView, Tooltip } from '@codemirror/view';
import type { Diagnostic } from '@codemirror/lint';
import { api } from '../../core/api.js';
import { h } from '../../core/dom.js';
import { grammar, vocabulary, type Issue } from '../../core/state.js';
import { HEADER_RE, localVariables } from './ezlang.js';

/** 'ts': code journeys, code steps and screens (eztest/sdk). 'feature': Gherkin feature files (docs/bdd.md). */
export type Format = 'ez' | 'yaml' | 'json' | 'ts' | 'feature';

/** Select the inside of the first quoted placeholder after inserting a phrasing. */
function insertWithPlaceholder(view: EditorView, text: string, from: number, to: number): void {
  const q = text.indexOf('"');
  const q2 = q >= 0 ? text.indexOf('"', q + 1) : -1;
  const sel = q >= 0 && q2 > q ? EditorSelection.range(from + q + 1, from + q2) : EditorSelection.cursor(from + text.length);
  view.dispatch({ changes: { from, to, insert: text }, selection: sel, userEvent: 'input.complete', scrollIntoView: true });
}

function phraseOptions(kind: 'action' | 'expectation' | 'header', stripExpect: boolean): Completion[] {
  const out: Completion[] = [];
  const seen = new Set<string>();
  for (const g of grammar.get()) {
    if (g.kind !== kind) continue;
    for (const ex of g.examples) {
      const label = stripExpect ? ex.text.replace(/^Expect\s+/, '') : ex.text;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({
        label,
        detail: g.category,
        type: kind === 'header' ? 'property' : kind === 'expectation' ? 'variable' : 'keyword',
        info: ex.rule ? `Rule ${ex.rule} · keywords: ${ex.keywords.join(', ')}` : undefined,
        apply: (view, _c, from, to) => insertWithPlaceholder(view, label, from, to),
        boost: kind === 'action' ? 1 : 0,
      });
    }
  }
  return out;
}

function names(list: string[], type: string, detail: string, wrap: (s: string) => string = (s) => s): Completion[] {
  return list.map((n) => ({ label: wrap(n), type, detail }));
}

function inSteps(doc: Text, lineNo: number): boolean {
  for (let i = 1; i < lineNo; i++) {
    const t = doc.line(i).text.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    if (!HEADER_RE.test(t)) return true;
  }
  return false;
}

/** Completion source for `.ez` files. */
export function ezCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const v = vocabulary.get();
  let m: RegExpExecArray | null;

  if ((m = /\$\{([\w.-]*)$/.exec(before))) {
    const vars = [...new Set([...localVariables(ctx.state.doc.toString()), ...v.variables])];
    return { from: ctx.pos - m[1].length, options: names(vars, 'variable', 'variable').map((c) => ({ ...c, apply: `${c.label}}` })), validFor: /^[\w.-]*$/ };
  }
  if ((m = /^\s*role\s*:\s*([\w-]*)$/i.exec(before)) || (m = /\b(?:log|sign)\s*in\s+as\s+([\w-]*)$/i.exec(before)) || (m = /^\s*call\s+api\b.*\bas\s+([\w-]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names(v.roles, 'type', 'role'), validFor: /^[\w-]*$/ };
  }
  if ((m = /^\s*tags\s*:.*?(@?[\w-]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names(v.tags, 'constant', 'tag', (t) => `@${t}`), validFor: /^@?[\w-]*$/ };
  }
  if ((m = /^\s*lenses\s*:(?:.*[,\s])?([\w:-]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names([...v.lenses, ...v.lenses.map((l) => `${l}:warn`)], 'constant', 'lens'), validFor: /^[\w:-]*$/ };
  }
  if ((m = /^\s*(?:use\s+data|data\s*:)\s+([\w]*)$/i.exec(before)) || (m = /^\s*data\s*:\s*([\w]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names(v.entities, 'class', 'data entity'), validFor: /^\w*$/ };
  }
  if ((m = /^\s*run\s+query\s+".*"\s+on\s+([\w-]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names(v.connections, 'namespace', 'DB connection'), validFor: /^[\w-]*$/ };
  }
  if ((m = /^\s*compare\s+document\b.*\busing\s+([\w-]*)$/i.exec(before))) {
    return { from: ctx.pos - m[1].length, options: names(v.documents, 'function', 'document check'), validFor: /^[\w-]*$/ };
  }
  if ((m = /^(\s*)((?:expect|verify)\s+)(.*)$/i.exec(before))) {
    const from = line.from + m[1].length + m[2].length;
    return { from, options: phraseOptions('expectation', true) };
  }
  // A phrasing at the start of a line.
  if ((m = /^(\s*)([^"]*)$/.exec(before))) {
    const typed = m[2];
    if (!typed && !ctx.explicit) return null;
    const from = line.from + m[1].length;
    const steps = inSteps(ctx.state.doc, line.number);
    const options = steps ? [...phraseOptions('action', false), ...phraseOptions('expectation', false)] : [...phraseOptions('header', false), ...phraseOptions('action', false)];
    return { from, options };
  }
  return null;
}

/** Completion source for YAML journeys: step intents after `intent:` or a list dash. */
export function yamlCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /^(\s*(?:-\s*)?intent:\s*["']?)([^"']*)$/.exec(before);
  if (!m) return null;
  return { from: line.from + m[1].length, options: phraseOptions('action', false) };
}

/** Validate through the server and turn issues into diagnostics with quick fixes. */
export function lintSource(format: () => Format, onResult: (r: { ok: boolean; errors: Issue[]; journey?: { name: string; steps: number } }) => void, path?: string) {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    const doc = view.state.doc;
    let r: { ok: boolean; errors: Issue[]; journey?: { name: string; steps: number } };
    try {
      r = await api.post('/api/validate', { content: doc.toString(), format: format(), ...(path ? { path } : {}) });
    } catch {
      return [];
    }
    onResult(r);
    // Feature files: how every step binds (step definition, EZTest phrasing, undefined, ambiguous).
    const steps = ((r as { bdd?: { diagnostics?: StepDiagnostic[] } }).bdd?.diagnostics ?? []).map((d) => stepDiagnostic(doc, d));
    // eztest lint findings (hard waits, fragile XPath, unchecked state changes, secrets, weak locators) as warnings.
    const lint = ((r as { lint?: Array<{ rule: string; severity: string; line?: number; message: string; suggestion: string; score?: number }> }).lint ?? []).map((f) => {
      const ln = f.line && f.line >= 1 && f.line <= doc.lines ? doc.line(f.line) : doc.line(1);
      return {
        from: ln.from + (/^\s*/.exec(ln.text)?.[0].length ?? 0), to: ln.to,
        severity: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info',
        source: `eztest lint: ${f.rule}${f.score !== undefined ? ` (locator score ${f.score}/100)` : ''}`,
        message: `${f.message}\nFix: ${f.suggestion}`,
      } satisfies Diagnostic;
    });
    return [...steps, ...lint, ...r.errors.map((e) => {
      const ln = e.line && e.line >= 1 && e.line <= doc.lines ? doc.line(e.line) : doc.line(1);
      const indent = /^\s*/.exec(ln.text)?.[0].length ?? 0;
      const from = Math.min(ln.to, ln.from + Math.max(0, (e.column ?? indent + 1) - 1));
      const to = Math.max(from, ln.to);
      return {
        from,
        to,
        severity: 'error',
        source: 'eztest',
        message: e.message.replace(/^line \d+:\s*/, ''),
        actions: e.line
          ? e.suggestions.slice(0, 3).map((s) => ({
              name: `Use “${s}”`,
              apply(v: EditorView) {
                const cur = v.state.doc.line(e.line!);
                const ind = /^\s*/.exec(cur.text)?.[0] ?? '';
                v.dispatch({ changes: { from: cur.from + ind.length, to: cur.to, insert: s }, userEvent: 'input.quickfix' });
              },
            }))
          : [],
      } satisfies Diagnostic;
    })];
  };
}

interface StepDiagnostic {
  line: number;
  column: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  snippet?: string;
  location?: string;
}

const STEP_SOURCE: Record<string, string> = {
  definition: 'step definition', ez: 'EZTest phrasing', undefined: 'undefined step', ambiguous: 'ambiguous step', outline: 'outline', definitions: 'step definitions', syntax: 'Gherkin',
};

/** A feature-file step diagnostic: the step's text range, with "Copy snippet" for an undefined step. */
function stepDiagnostic(doc: Text, d: StepDiagnostic): Diagnostic {
  const ln = d.line >= 1 && d.line <= doc.lines ? doc.line(d.line) : doc.line(1);
  const from = Math.min(ln.to, ln.from + Math.max(0, d.column - 1));
  const to = d.endColumn ? Math.min(ln.to, ln.from + d.endColumn - 1) : ln.to;
  return {
    from, to: Math.max(from, to), severity: d.severity, source: `eztest bdd: ${STEP_SOURCE[d.kind] ?? d.kind}`, message: d.message,
    actions: d.snippet
      ? [{ name: 'Copy snippet', apply() { void navigator.clipboard?.writeText(d.snippet!).catch(() => undefined); } }]
      : [],
  };
}

interface Explanation {
  kind: string;
  summary: string;
  action?: string;
  target?: string;
  value?: string;
  captureAs?: string;
  optional?: boolean;
  postconditions?: string[];
  rule?: { name: string; category: string; example: string; keywords: string[] };
  message?: string;
  suggestions?: string[];
}

const explainCache = new Map<string, Promise<Explanation>>();

function explain(line: string): Promise<Explanation> {
  let p = explainCache.get(line);
  if (!p) {
    p = api.post<Explanation>('/api/explain', { line });
    explainCache.set(line, p);
    if (explainCache.size > 300) explainCache.delete(explainCache.keys().next().value as string);
  }
  return p;
}

/** Hover docs for `.ez` lines. */
export async function ezHover(view: EditorView, pos: number): Promise<Tooltip | null> {
  const line = view.state.doc.lineAt(pos);
  const text = line.text.trim();
  if (!text || text.startsWith('#')) return null;
  let e: Explanation;
  try {
    e = await explain(text);
  } catch {
    return null;
  }
  if (e.kind === 'blank' || e.kind === 'comment') return null;
  const rows: Array<[string, string | undefined]> = [
    ['Action', e.action],
    ['Target', e.target],
    ['Value', e.value],
    ['Stores as', e.captureAs],
  ];
  return {
    pos: line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0),
    end: line.to,
    above: true,
    create() {
      const dom = h(
        'div',
        { class: 'ez-hover' },
        h('p', { class: 'ez-hover-title', text: e.kind === 'error' ? e.summary : e.rule ? `${e.rule.category} · ${e.rule.name}` : e.summary }),
        e.kind === 'step' ? h('dl', { class: 'ez-hover-kv' }, rows.filter(([, v]) => v).map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v! })])) : null,
        e.postconditions?.length ? h('p', { class: 'ez-hover-sub', text: `Checks: ${e.postconditions.join('; ')}` }) : null,
        e.optional ? h('p', { class: 'ez-hover-sub', text: 'Optional step: a failure does not fail the journey.' }) : null,
        e.message ? h('p', { class: e.kind === 'error' ? 'ez-hover-error' : 'ez-hover-sub', text: e.message }) : null,
        e.rule ? h('p', { class: 'ez-hover-sub' }, 'Example: ', h('code', { text: e.rule.example })) : null,
        e.suggestions?.length ? h('p', { class: 'ez-hover-sub', text: `Did you mean: ${e.suggestions.join(' · ')}` }) : null,
      );
      return { dom };
    },
  };
}
