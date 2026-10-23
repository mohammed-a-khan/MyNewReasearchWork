/**
 * Language services for `.ez` journeys (and YAML/JSON journeys where they
 * apply), shaped as LSP results. They reuse the grammar, the validator and
 * the Studio's language services (explainLine, grammar, formatText), so the
 * editor, Studio and the runner agree on what a line means.
 */
import { extname } from 'node:path';
import { parseIntent, tryParseCondition } from '../intent/index.js';
import { slugify } from '../core/index.js';
import { formatText, explainLine } from '../studio/language.js';
import { grammar, validateText, type JourneyFormat } from '../studio/authoring.js';
import { pathToUri, range, uriToPath, type Location, type Position, type Range, type Workspace } from './workspace.js';

// ------------------------------------------------------------------ LSP shapes (the subset used)

export interface Diagnostic {
  range: Range;
  severity: 1 | 2 | 3 | 4;
  code?: string;
  source: string;
  message: string;
  data?: { suggestions?: string[]; replace?: 'line' | 'range' };
}
export interface TextEdit {
  range: Range;
  newText: string;
}
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}
export interface CompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit;
  filterText?: string;
  sortText?: string;
}
export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[];
}
export interface CodeAction {
  title: string;
  kind: string;
  diagnostics?: Diagnostic[];
  edit: WorkspaceEdit;
  isPreferred?: boolean;
}

/** LSP CompletionItemKind / SymbolKind values used here. */
export const CompletionKind = { Text: 1, Function: 3, Field: 5, Variable: 6, Class: 7, Module: 9, Property: 10, Keyword: 14, Snippet: 15, File: 17, Reference: 18, Constant: 21, Event: 23 } as const;
export const SymbolKind = { File: 1, Module: 2, Namespace: 3, Property: 7, Field: 8, Function: 12, Variable: 13, Event: 24, Operator: 25 } as const;

export function formatOfUri(uri: string): JourneyFormat | undefined {
  const ext = extname(uriToPath(uri)).toLowerCase();
  return ext === '.ez' ? 'ez' : ext === '.json' ? 'json' : ext === '.yaml' || ext === '.yml' ? 'yaml' : undefined;
}

// ------------------------------------------------------------------ line structure

const HEADER = /^(journey|name|id|tags|role|requirements?|risk|base\s*url|variables|vars|description|lenses|data|params|parameters|returns|device|viewport|locale|time\s*zone|colou?r\s*scheme|reduced\s*motion|geolocation|permissions|user\s*agent|touch|offline|http\s*credentials|extra\s*headers|headers|loaders)\s*:\s*(.*)$/i;
const EXPECT = /^(?:(?:then|and|also)\s+)?(?:expect|verify)\s+(?:softly\s+)?(?:that\s+)?(.+)$/i;
const OPENER = /^(?:if|unless|repeat|for\s+each|while|retry|try|group|in\s+(?:the\s+)?(?:frame|.*\bframe)|until|repeat\s+until)\b/i;
const END = /^(?:end(?:\s+\w+)*|done|next|endif)\s*[.;]?$/i;
const BRANCH = /^(?:otherwise|else|on\s+(?:failure|error)|catch|if\s+(?:it|that|this)\s+fails|when\s+it\s+fails)\b/i;
const EXAMPLES = /^(?:examples|scenarios|data\s+table)\s*:/i;

export type LineKind = 'blank' | 'comment' | 'header' | 'step' | 'expect' | 'end' | 'branch' | 'examples' | 'table';

/** Classify every line of an .ez document. */
export function lineKinds(lines: string[]): LineKind[] {
  let inSteps = false;
  let inExamples = false;
  return lines.map((raw) => {
    const t = raw.trim();
    if (!t) return 'blank';
    if (t.startsWith('#') || t.startsWith('//')) return 'comment';
    if (EXAMPLES.test(t)) {
      inExamples = true;
      return 'examples';
    }
    if (inExamples && t.startsWith('|')) return 'table';
    if (!inSteps && HEADER.test(t)) return 'header';
    inSteps = true;
    if (END.test(t)) return 'end';
    if (EXPECT.test(t)) return 'expect';
    if (BRANCH.test(t) && !/\bthen\b/i.test(t.replace(/^otherwise\s+if/i, ''))) return 'branch';
    if (/^(?:otherwise|else)\s+(?:if|unless)\b/i.test(t)) return 'branch';
    return 'step';
  });
}

/** True when a step line opens a multi-line block (no inline child after "then"/":"). */
function opensBlock(t: string): boolean {
  if (!OPENER.test(t)) return false;
  try {
    const s = parseIntent(t);
    return Array.isArray(s.steps) && s.steps.length === 0;
  } catch {
    return /(?:\bthen|:)\s*$/i.test(t) || /^(?:try|repeat|retry|group)\b/i.test(t);
  }
}

// ------------------------------------------------------------------ tokens at a position

interface Token {
  text: string;
  range: Range;
}

function quotedAt(line: string, lineNo: number, ch: number): Token | undefined {
  const re = /"([^"]*)"/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (ch >= m.index && ch <= m.index + m[0].length) return { text: m[1], range: range(lineNo, m.index + 1, m.index + 1 + m[1].length) };
  }
  return undefined;
}

function varAt(line: string, lineNo: number, ch: number): Token | undefined {
  const re = /\$\{([A-Za-z_]\w*)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const from = m.index + 2;
    const close = line.indexOf('}', m.index);
    if (ch >= m.index && ch <= (close < 0 ? from + m[1].length : close + 1)) return { text: m[1], range: range(lineNo, from, from + m[1].length) };
  }
  return undefined;
}

function wordAt(line: string, lineNo: number, ch: number): Token | undefined {
  const re = /[A-Za-z_][\w.-]*/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (ch >= m.index && ch <= m.index + m[0].length) return { text: m[0], range: range(lineNo, m.index, m.index + m[0].length) };
  }
  return undefined;
}

// References in step lines: journeys, named queries, roles, connections, document checks.
const RUN_JOURNEY = /\b(?:run|call|include|perform|execute)\s+journey\s+"([^"]+)"/i;
const NAMED_QUERY = /\bquery\s+"([A-Za-z_][\w.-]*)"/i;
const ROLE_REFS = [/^\s*role\s*:\s*([\w-]+)/i, /\b(?:log|sign)\s*in\s+as\s+([\w-]+)/i, /^\s*(?:call\s+api|send\s+graphql|call\s+soap)\b.*?\bas\s+([\w-]+)\s+(?:and|with)\b/i];
const CONNECTION_REF = /\bon\s+([A-Za-z_][\w-]*)\b(?=\s*(?:with|as|and|returns|within|$))/i;
const DOCUMENT_REF = /^\s*compare\s+document\b.*?\busing\s+([\w-]+)/i;

interface Ref {
  kind: 'journey' | 'query' | 'role' | 'connection' | 'document';
  name: string;
  range: Range;
}

/** References on one line (with their ranges). */
export function referencesOn(line: string, lineNo: number, kind: LineKind): Ref[] {
  const out: Ref[] = [];
  const at = (m: RegExpExecArray, group = 1) => {
    const i = m.index + m[0].lastIndexOf(m[group]);
    return range(lineNo, i, i + m[group].length);
  };
  let m: RegExpExecArray | null;
  if (kind === 'header') {
    if ((m = ROLE_REFS[0].exec(line))) out.push({ kind: 'role', name: m[1], range: at(m) });
    return out;
  }
  if (kind !== 'step' && kind !== 'expect') return out;
  if ((m = RUN_JOURNEY.exec(line))) out.push({ kind: 'journey', name: m[1], range: at(m) });
  if ((m = NAMED_QUERY.exec(line))) {
    out.push({ kind: 'query', name: m[1], range: at(m) });
    const rest = line.slice(m.index + m[0].length);
    const c = /^\s+on\s+([A-Za-z_][\w-]*)/.exec(rest);
    if (c) {
      const i = m.index + m[0].length + c[0].lastIndexOf(c[1]);
      out.push({ kind: 'connection', name: c[1], range: range(lineNo, i, i + c[1].length) });
    }
  } else if (/^\s*(?:run|get|call)\b.*\b(?:query|procedure)\b/i.test(line) && (m = CONNECTION_REF.exec(line.replace(/"[^"]*"/g, (q) => ' '.repeat(q.length))))) {
    out.push({ kind: 'connection', name: m[1], range: range(lineNo, m.index + m[0].lastIndexOf(m[1]), m.index + m[0].lastIndexOf(m[1]) + m[1].length) });
  }
  for (const re of ROLE_REFS.slice(1)) if ((m = re.exec(line))) out.push({ kind: 'role', name: m[1], range: at(m) });
  if ((m = DOCUMENT_REF.exec(line))) out.push({ kind: 'document', name: m[1], range: at(m) });
  return out;
}

// ------------------------------------------------------------------ variables

interface VarDef {
  name: string;
  range: Range;
  how: string;
}

/** Where a document defines variables. */
export function variableDefinitions(lines: string[]): VarDef[] {
  const kinds = lineKinds(lines);
  const out: VarDef[] = [];
  const push = (name: string, lineNo: number, index: number, how: string) => out.push({ name, range: range(lineNo, index, index + name.length), how });
  let examplesHeader = false;
  lines.forEach((line, i) => {
    const k = kinds[i];
    if (k === 'header') {
      const h = HEADER.exec(line.trim())!;
      const key = h[1].toLowerCase();
      const off = line.indexOf(h[2], line.indexOf(':'));
      if (key === 'variables' || key === 'vars') for (const m of h[2].matchAll(/([A-Za-z_][\w.-]*)\s*=/g)) push(m[1], i, off + (m.index ?? 0), 'Variables header');
      if (key === 'params' || key === 'parameters') for (const m of h[2].matchAll(/[A-Za-z_][\w-]*/g)) push(m[0], i, off + (m.index ?? 0), 'parameter');
      if (key === 'data') for (const m of h[2].matchAll(/\bas\s+(\w+)/gi)) push(m[1], i, off + (m.index ?? 0) + m[0].lastIndexOf(m[1]), 'test data');
      return;
    }
    if (k === 'examples') {
      examplesHeader = true;
      return;
    }
    if (k === 'table' && examplesHeader) {
      examplesHeader = false;
      for (const m of line.matchAll(/[^|\s][^|]*?(?=\s*\|)/g)) push(m[0].trim(), i, m.index ?? 0, 'Examples column');
      return;
    }
    if (k !== 'step') return;
    let m: RegExpExecArray | null;
    if ((m = /^(\s*)(?:set\s+(?:the\s+)?(?:variable\s+)?|let\s+)([A-Za-z_][\w-]*)\s+(?:to|=|be)\b/di.exec(line))) push(m[2], i, m.indices![2][0], 'Set variable');
    else if ((m = /^(\s*)(?:increment|increase|decrement|decrease)\s+([A-Za-z_][\w-]*)/di.exec(line))) push(m[2], i, m.indices![2][0], 'Increment');
    if ((m = /^(\s*)for\s+each\s+([A-Za-z_]\w*)\s+in\b/di.exec(line))) push(m[2], i, m.indices![2][0], 'For each');
    const cap = /\b(?:as|store\s+(?:the\s+\w+\s+)?as)\s+([A-Za-z_][\w.-]*)\s*(?:\[[^\]]*\])?\s*:?\s*$/di.exec(line.replace(/"[^"]*"/g, (q) => '_'.repeat(q.length)));
    if (cap) push(cap[1], i, cap.indices![1][0], 'captured');
  });
  return out;
}

/** Ranges of every reference to a variable on a line: `${name...}` and, in expression positions, the bare name. */
function variableRefs(line: string, lineNo: number, name: string, kind: LineKind): Range[] {
  const out: Range[] = [];
  for (const m of line.matchAll(new RegExp(`\\$\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[}.:\\[])`, 'g'))) out.push(range(lineNo, (m.index ?? 0) + 2, (m.index ?? 0) + 2 + name.length));
  // Bare names inside safe expressions (Set variable ... to <expr>, If <expr>, Expect <expr>, For each x in <expr>).
  const t = line.trim();
  let exprStart = -1;
  if (kind === 'step') {
    const set = /^(?:set\s+(?:the\s+)?(?:variable\s+)?|let\s+)[A-Za-z_][\w-]*\s+(?:to|=|be)\s+/i.exec(t);
    const fe = /^for\s+each\s+\w+\s+in\s+(?!data\b)/i.exec(t);
    if (set) exprStart = set[0].length;
    else if (fe) exprStart = fe[0].length;
    else {
      try {
        const s = parseIntent(t);
        if (s.flow?.expr) exprStart = Math.max(0, t.indexOf(s.flow.expr));
      } catch {
        // not a step
      }
    }
  } else if (kind === 'expect') {
    const e = EXPECT.exec(t);
    if (e && tryParseCondition(e[1])?.type === 'expr') exprStart = t.length - e[1].length;
  }
  if (exprStart >= 0) {
    const indent = line.length - line.trimStart().length;
    const body = t.slice(exprStart).replace(/"[^"]*"|'[^']*'|\$\{[^}]*\}/g, (q) => ' '.repeat(q.length));
    for (const m of body.matchAll(new RegExp(`(?<![\\w.$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w(])`, 'g'))) {
      const at = indent + exprStart + (m.index ?? 0);
      out.push(range(lineNo, at, at + name.length));
    }
  }
  return out;
}

// ------------------------------------------------------------------ diagnostics

const closest = (want: string, pool: string[], max = 3): string[] => {
  const lev = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return d[b.length];
  };
  return pool.map((p) => ({ p, d: lev(want.toLowerCase(), p.toLowerCase()) })).filter((x) => x.d <= Math.max(3, Math.floor(want.length / 2))).sort((a, b) => a.d - b.d).slice(0, max).map((x) => x.p);
};

export function diagnose(ws: Workspace, uri: string, text: string): Diagnostic[] {
  const fmt = formatOfUri(uri);
  if (!fmt) return [];
  const lines = text.split(/\r?\n/);
  const out: Diagnostic[] = [];
  const v = validateText(text, fmt);
  for (const e of v.errors) {
    const ln = e.line !== undefined ? Math.min(Math.max(0, e.line - 1), lines.length - 1) : 0;
    const from = Math.max(0, (e.column ?? (/^\s*/.exec(lines[ln] ?? '')?.[0].length ?? 0) + 1) - 1);
    out.push({
      range: range(ln, from, Math.max(from, (lines[ln] ?? '').length)), severity: 1, code: 'eztest.parse', source: 'eztest',
      message: e.message.replace(/^line \d+:\s*/, '') + (e.suggestions.length ? `\nClosest phrasing: ${e.suggestions[0]}` : ''),
      data: { suggestions: e.suggestions, replace: 'line' },
    });
  }
  if (fmt !== 'ez') return out;
  // Cross-file checks: references to roles, journeys, named queries and connections that do not exist.
  const cfg = ws.config();
  const kinds = lineKinds(lines);
  const pools: Record<Ref['kind'], () => string[] | undefined> = {
    role: () => (cfg.path ? cfg.roles.map((r) => r.name) : undefined),
    connection: () => (cfg.path ? cfg.connections.map((r) => r.name) : undefined),
    document: () => (cfg.path ? cfg.documents.map((r) => r.name) : undefined),
    query: () => {
      const q = [...ws.queries().keys()];
      return q.length ? q : undefined;
    },
    journey: () => ws.journeys().flatMap((j) => [j.id, j.name]),
  };
  const known: Record<Ref['kind'], (n: string) => boolean> = {
    role: (n) => cfg.roles.some((r) => r.name === n),
    connection: (n) => cfg.connections.some((r) => r.name === n),
    document: (n) => cfg.documents.some((r) => r.name === n),
    query: (n) => ws.queries().has(n),
    journey: (n) => ws.findJourney(n) !== undefined,
  };
  const label: Record<Ref['kind'], string> = { role: 'role', connection: 'database connection', document: 'document check', query: 'named query', journey: 'journey' };
  lines.forEach((line, i) => {
    for (const r of referencesOn(line, i, kinds[i])) {
      if (r.name.includes('${')) continue;
      const pool = pools[r.kind]();
      if (pool === undefined || known[r.kind](r.name)) continue;
      const sugg = closest(r.name, [...new Set(pool)]);
      out.push({
        range: r.range, severity: 2, code: `eztest.unknown-${r.kind}`, source: 'eztest',
        message: `Unknown ${label[r.kind]} "${r.name}"${sugg.length ? ` (did you mean "${sugg[0]}"?)` : ''}`,
        data: { suggestions: sugg, replace: 'range' },
      });
    }
  });
  return out;
}

// ------------------------------------------------------------------ code actions

export function codeActions(uri: string, text: string, diagnostics: Diagnostic[]): CodeAction[] {
  const lines = text.split(/\r?\n/);
  const out: CodeAction[] = [];
  for (const d of diagnostics) {
    const sugg = d.data?.suggestions ?? [];
    sugg.slice(0, 3).forEach((s, i) => {
      let edit: TextEdit;
      if (d.data?.replace === 'range') edit = { range: d.range, newText: s };
      else {
        const ln = d.range.start.line;
        const raw = lines[ln] ?? '';
        const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
        edit = { range: range(ln, indent, raw.length), newText: s };
      }
      out.push({ title: `Use "${s}"`, kind: 'quickfix', diagnostics: [d], isPreferred: i === 0, edit: { changes: { [uri]: [edit] } } });
    });
  }
  return out;
}

// ------------------------------------------------------------------ formatting

export function format(uri: string, text: string): TextEdit[] {
  const fmt = formatOfUri(uri);
  if (!fmt) return [];
  let next: string;
  try {
    next = formatText(text, fmt);
  } catch {
    return [];
  }
  if (next === text) return [];
  const lines = text.split(/\r?\n/);
  return [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } }, newText: next }];
}

// ------------------------------------------------------------------ hover

export function hover(ws: Workspace, uri: string, text: string, pos: Position): { contents: { kind: 'markdown'; value: string }; range?: Range } | null {
  if (formatOfUri(uri) !== 'ez') return null;
  const lines = text.split(/\r?\n/);
  const line = lines[pos.line] ?? '';
  const kinds = lineKinds(lines);
  const v = varAt(line, pos.line, pos.character);
  if (v) {
    const def = variableDefinitions(lines).find((d) => d.name === v.text);
    return { contents: { kind: 'markdown', value: `**\${${v.text}}**: ${def ? `defined on line ${def.range.start.line + 1} (${def.how})` : 'not defined in this journey (a run variable, config var or caller parameter)'}` }, range: v.range };
  }
  for (const r of referencesOn(line, pos.line, kinds[pos.line])) {
    if (pos.character < r.range.start.character || pos.character > r.range.end.character) continue;
    if (r.kind === 'journey') {
      const j = ws.findJourney(r.name);
      return { contents: { kind: 'markdown', value: j ? `**Journey** ${j.name}\n\n\`${j.id}\` in \`${uriToPath(j.uri)}\`` : `Unknown journey "${r.name}"` }, range: r.range };
    }
    if (r.kind === 'query') {
      const f = ws.queries().get(r.name);
      const sql = f ? ws.text(pathToUri(f)) : undefined;
      return { contents: { kind: 'markdown', value: f ? `**Named query** ${r.name}\n\n\`\`\`sql\n${(sql ?? '').trim().slice(0, 1200)}\n\`\`\`` : `Unknown named query "${r.name}"` }, range: r.range };
    }
    if (r.kind === 'role') {
      const role = (ws.config().raw.identity as { roles?: Record<string, Record<string, unknown>> } | undefined)?.roles?.[r.name];
      const facts = role ? [`login ${String(role.loginUrl ?? '')}`, role.totp ? 'MFA (TOTP)' : '', role.api ? 'API token' : ''].filter(Boolean).join(' · ') : '';
      return { contents: { kind: 'markdown', value: role ? `**Role** ${r.name}: ${facts}` : `Unknown role "${r.name}"` }, range: r.range };
    }
  }
  const e = explainLine(line);
  if (e.kind === 'blank' || e.kind === 'comment') return null;
  const md: string[] = [];
  if (e.kind === 'error') {
    md.push(`**${e.summary}**`, '', e.message ?? '');
    if (e.suggestions?.length) md.push('', `Did you mean: ${e.suggestions.map((s) => `\`${s}\``).join(' · ')}`);
  } else if (e.kind === 'header') {
    md.push(`**${e.summary}**`, '', e.message ?? '');
  } else {
    md.push(`**${e.rule ? `${e.rule.category} · ${e.rule.name}` : e.summary}**`, '');
    const rows: Array<[string, string | undefined]> = [['Action', e.action], ['Target', e.target], ['Value', e.value], ['Stores as', e.captureAs]];
    for (const [k, val] of rows) if (val) md.push(`- ${k}: \`${val}\``);
    // Expect lines right below a step are its post-conditions.
    const checks = [...(e.postconditions ?? [])];
    for (let i = pos.line + 1; i < lines.length && (kinds[i] === 'expect' || kinds[i] === 'comment'); i++) {
      if (kinds[i] === 'expect') checks.push(...(explainLine(lines[i]).postconditions ?? []));
    }
    if (checks.length) md.push('', `Checks: ${checks.join('; ')}`);
    if (e.optional) md.push('', 'Optional step: a failure does not fail the journey.');
    if (e.rule) md.push('', `Example: \`${e.rule.example}\``);
  }
  return { contents: { kind: 'markdown', value: md.join('\n') } };
}

// ------------------------------------------------------------------ definition

export function definition(ws: Workspace, uri: string, text: string, pos: Position): Location[] {
  const lines = text.split(/\r?\n/);
  const line = lines[pos.line] ?? '';
  const kinds = lineKinds(lines);
  const v = varAt(line, pos.line, pos.character);
  if (v) {
    const def = variableDefinitions(lines).find((d) => d.name === v.text);
    return def ? [{ uri, range: def.range }] : [];
  }
  const refs = referencesOn(line, pos.line, kinds[pos.line]);
  const hit = refs.find((r) => pos.character >= r.range.start.character - 1 && pos.character <= r.range.end.character + 1) ?? (refs.length === 1 ? refs[0] : undefined);
  if (hit) {
    const cfg = ws.config();
    switch (hit.kind) {
      case 'journey': {
        const j = ws.findJourney(hit.name);
        return j ? [{ uri: j.uri, range: range(j.nameLine, 0, 0) }] : [];
      }
      case 'query': {
        const f = ws.queries().get(hit.name);
        return f ? [{ uri: pathToUri(f), range: range(0, 0, 0) }] : [];
      }
      case 'role': return cfg.roles.filter((r) => r.name === hit.name).map((r) => r.location);
      case 'connection': return cfg.connections.filter((r) => r.name === hit.name).map((r) => r.location);
      case 'document': return cfg.documents.filter((r) => r.name === hit.name).map((r) => r.location);
    }
  }
  // A bare variable in an expression.
  const w = wordAt(line, pos.line, pos.character);
  if (w) {
    const def = variableDefinitions(lines).find((d) => d.name === w.text.split('.')[0]);
    if (def && variableRefs(line, pos.line, def.name, kinds[pos.line]).some((r) => pos.character >= r.start.character && pos.character <= r.end.character)) return [{ uri, range: def.range }];
  }
  return [];
}

// ------------------------------------------------------------------ rename

interface RenameTarget {
  kind: 'variable' | 'journey';
  name: string;
  range: Range;
  /** For journeys: rename the name or the id. */
  field?: 'name' | 'id';
}

function renameTarget(ws: Workspace, uri: string, text: string, pos: Position): RenameTarget | undefined {
  const lines = text.split(/\r?\n/);
  const line = lines[pos.line] ?? '';
  const kinds = lineKinds(lines);
  const v = varAt(line, pos.line, pos.character);
  if (v) return { kind: 'variable', name: v.text, range: v.range };
  if (kinds[pos.line] === 'header') {
    const h = HEADER.exec(line.trim())!;
    const key = h[1].toLowerCase();
    const start = line.indexOf(h[2], line.indexOf(':'));
    if ((key === 'journey' || key === 'name') && pos.character >= start) return { kind: 'journey', name: h[2].trim(), range: range(pos.line, start, start + h[2].trim().length), field: 'name' };
    if (key === 'id' && pos.character >= start) return { kind: 'journey', name: h[2].trim(), range: range(pos.line, start, start + h[2].trim().length), field: 'id' };
  }
  const r = referencesOn(line, pos.line, kinds[pos.line]).find((x) => x.kind === 'journey' && pos.character >= x.range.start.character && pos.character <= x.range.end.character);
  if (r) {
    const j = ws.findJourney(r.name);
    return { kind: 'journey', name: r.name, range: r.range, field: j && j.id === r.name && j.name !== r.name ? 'id' : 'name' };
  }
  const defs = variableDefinitions(lines);
  const w = wordAt(line, pos.line, pos.character);
  const def = w && defs.find((d) => d.name === w.text);
  if (def && w) return { kind: 'variable', name: def.name, range: w.range };
  return undefined;
}

export function prepareRename(ws: Workspace, uri: string, text: string, pos: Position): { range: Range; placeholder: string } | null {
  const t = renameTarget(ws, uri, text, pos);
  return t ? { range: t.range, placeholder: t.name } : null;
}

export function rename(ws: Workspace, uri: string, text: string, pos: Position, newName: string): WorkspaceEdit | null {
  const t = renameTarget(ws, uri, text, pos);
  if (!t) return null;
  if (t.kind === 'variable') {
    if (!/^[A-Za-z_][\w-]*$/.test(newName)) throw new Error(`"${newName}" is not a valid variable name`);
    const lines = text.split(/\r?\n/);
    const kinds = lineKinds(lines);
    const edits: TextEdit[] = [];
    const seen = new Set<string>();
    const add = (r: Range) => {
      const k = `${r.start.line}:${r.start.character}`;
      if (seen.has(k)) return;
      seen.add(k);
      edits.push({ range: r, newText: newName });
    };
    for (const d of variableDefinitions(lines)) if (d.name === t.name) add(d.range);
    lines.forEach((l, i) => variableRefs(l, i, t.name, kinds[i]).forEach(add));
    return { changes: { [uri]: edits } };
  }
  // Journey: its header plus every "Run journey" reference in the workspace.
  const j = ws.findJourney(t.name) ?? (t.field === 'name' ? { uri, name: t.name, id: slugify(t.name), nameLine: t.range.start.line, explicitId: false } : undefined);
  if (!j) return null;
  const oldName = j.name;
  const oldId = j.id;
  const renamingId = t.field === 'id';
  const newId = renamingId ? newName : j.explicitId ? oldId : slugify(newName);
  const changes: Record<string, TextEdit[]> = {};
  const push = (u: string, e: TextEdit) => (changes[u] ??= []).push(e);
  const headerText = ws.text(j.uri) ?? '';
  const hl = headerText.split(/\r?\n/);
  const replaceHeader = (lineNo: number | undefined, value: string, next: string) => {
    if (lineNo === undefined) return;
    const l = hl[lineNo] ?? '';
    const i = l.lastIndexOf(value);
    if (i >= 0) push(j.uri, { range: range(lineNo, i, i + value.length), newText: next });
  };
  if (renamingId) replaceHeader('idLine' in j ? j.idLine : undefined, oldId, newName);
  else replaceHeader(j.nameLine, oldName, newName);
  for (const other of [...new Set([...ws.journeys().map((x) => x.uri), ...ws.documents.keys()])]) {
    if (formatOfUri(other) !== 'ez') continue;
    const body = ws.text(other);
    if (body === undefined) continue;
    const ls = body.split(/\r?\n/);
    const ks = lineKinds(ls);
    ls.forEach((l, i) => {
      for (const r of referencesOn(l, i, ks[i])) {
        if (r.kind !== 'journey') continue;
        if (r.name === oldName && !renamingId) push(other, { range: r.range, newText: newName });
        else if (r.name === oldId && newId !== oldId) push(other, { range: r.range, newText: newId });
      }
    });
  }
  return { changes };
}

// ------------------------------------------------------------------ document symbols

export function documentSymbols(uri: string, text: string): DocumentSymbol[] {
  if (formatOfUri(uri) !== 'ez') return [];
  const lines = text.split(/\r?\n/);
  const kinds = lineKinds(lines);
  const full = (i: number) => range(i, 0, lines[i].length);
  const name = /^(?:journey|name)\s*:\s*(.+)$/im.exec(text)?.[1].trim() ?? 'Journey';
  const root: DocumentSymbol = { name, detail: 'journey', kind: SymbolKind.Module, range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? '').length } }, selectionRange: range(0, 0, 0), children: [] };
  const stack: DocumentSymbol[] = [root];
  let last: DocumentSymbol | undefined;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const k = kinds[i];
    const parent = stack[stack.length - 1];
    switch (k) {
      case 'header': {
        const h = HEADER.exec(t)!;
        if (/^(journey|name)$/i.test(h[1])) root.selectionRange = full(i);
        root.children.push({ name: `${h[1]}: ${h[2]}`, kind: SymbolKind.Property, range: full(i), selectionRange: full(i), children: [] });
        break;
      }
      case 'step': {
        const sym: DocumentSymbol = { name: t, kind: SymbolKind.Function, range: full(i), selectionRange: full(i), children: [] };
        parent.children.push(sym);
        last = sym;
        if (opensBlock(t)) {
          sym.kind = SymbolKind.Namespace;
          stack.push(sym);
        }
        break;
      }
      case 'expect':
        (last ?? parent).children.push({ name: t, kind: SymbolKind.Event, range: full(i), selectionRange: full(i), children: [] });
        break;
      case 'branch':
        if (stack.length > 1) {
          parent.children.push({ name: t, kind: SymbolKind.Operator, range: full(i), selectionRange: full(i), children: [] });
          if (/^(?:otherwise|else)\s+(?:if|unless)\b/i.test(t)) {
            /* chained if: closed by the same End */
          }
        }
        break;
      case 'end':
        if (stack.length > 1) {
          const open = stack.pop()!;
          open.range = { start: open.range.start, end: { line: i, character: lines[i].length } };
          last = open;
        }
        break;
      case 'examples':
        root.children.push({ name: 'Examples', kind: SymbolKind.Field, range: full(i), selectionRange: full(i), children: [] });
        break;
      default:
        break;
    }
  });
  return [root];
}

// ------------------------------------------------------------------ completion

function snippet(example: string): string {
  let n = 0;
  return example.replace(/[$}\\]/g, (c) => `\\${c}`).replace(/"([^"]*)"/g, (_m, inner: string) => `"\${${++n}:${inner}}"`);
}

function phraseItems(kind: 'action' | 'expectation' | 'header', stripExpect: boolean, edit: Range): CompletionItem[] {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const g of grammar()) {
    if (g.kind !== kind) continue;
    for (const ex of g.examples) {
      const label = stripExpect ? ex.text.replace(/^Expect\s+/, '') : ex.text;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({
        label, kind: kind === 'header' ? CompletionKind.Property : kind === 'expectation' ? CompletionKind.Event : CompletionKind.Snippet,
        detail: g.category, documentation: ex.rule ? `Rule ${ex.rule} · keywords: ${ex.keywords.join(', ')}` : undefined,
        insertTextFormat: 2, textEdit: { range: edit, newText: snippet(label) }, filterText: label, sortText: `${kind === 'action' ? 0 : 1}${label}`,
      });
    }
  }
  return out;
}

function names(list: string[], kind: number, detail: string, edit: Range, wrap: (s: string) => string = (s) => s): CompletionItem[] {
  return [...new Set(list)].sort().map((n) => ({ label: wrap(n), kind, detail, textEdit: { range: edit, newText: wrap(n) } }));
}

export function complete(ws: Workspace, uri: string, text: string, pos: Position): CompletionItem[] {
  const fmt = formatOfUri(uri);
  const lines = text.split(/\r?\n/);
  const line = lines[pos.line] ?? '';
  const before = line.slice(0, pos.character);
  const cfg = ws.config();
  const edit = (len: number): Range => range(pos.line, pos.character - len, pos.character);
  let m: RegExpExecArray | null;
  if (fmt === 'yaml' || fmt === 'json') {
    m = /^(\s*(?:-\s*)?"?intent"?:\s*["']?)([^"']*)$/.exec(before) ?? /^(\s*-\s+["']?)([^"':]*)$/.exec(before);
    return m ? phraseItems('action', false, edit(m[2].length)) : [];
  }
  if ((m = /\$\{([\w.-]*)$/.exec(before))) {
    const local = variableDefinitions(lines).map((d) => d.name);
    return names(local, CompletionKind.Variable, 'variable', edit(m[1].length)).map((c) => ({ ...c, textEdit: { range: c.textEdit!.range, newText: `${c.label}}` } }));
  }
  if ((m = /\b(?:run|call|include|perform|execute)\s+journey\s+"([^"]*)$/i.exec(before))) {
    const js = ws.journeys().filter((j) => j.uri !== uri);
    return js.map((j) => ({ label: j.id, kind: CompletionKind.Module, detail: j.name, documentation: uriToPath(j.uri), textEdit: { range: edit(m![1].length), newText: j.id } }));
  }
  if ((m = /\bquery\s+"([\w.-]*)$/i.exec(before))) return names([...ws.queries().keys()], CompletionKind.Function, 'named query', edit(m[1].length));
  if ((m = /^\s*role\s*:\s*([\w-]*)$/i.exec(before)) || (m = /\b(?:log|sign)\s*in\s+as\s+([\w-]*)$/i.exec(before)) || (m = /^\s*call\s+api\b.*\bas\s+([\w-]*)$/i.exec(before))) {
    return names(cfg.roles.map((r) => r.name), CompletionKind.Class, 'role', edit(m[1].length));
  }
  if ((m = /^\s*tags\s*:.*?(@?[\w-]*)$/i.exec(before))) {
    const tags = new Set<string>();
    for (const j of ws.journeys()) {
      const t = /^tags\s*:\s*(.*)$/im.exec(ws.text(j.uri) ?? '');
      t?.[1].split(/[,\s]+/).filter(Boolean).forEach((x) => tags.add(x.replace(/^@/, '')));
    }
    return names([...tags], CompletionKind.Constant, 'tag', edit(m[1].length), (t) => `@${t}`);
  }
  if ((m = /^\s*lenses\s*:(?:.*[,\s])?([\w:-]*)$/i.exec(before))) {
    const l = ['a11y', 'security', 'visual', 'perf'];
    return names([...l, ...l.map((x) => `${x}:warn`)], CompletionKind.Constant, 'lens', edit(m[1].length));
  }
  if ((m = /^\s*(?:use\s+data|data\s*:)\s+([\w]*)$/i.exec(before))) return names(cfg.entities.map((e) => e.name), CompletionKind.Class, 'data entity', edit(m[1].length));
  if ((m = /\b(?:query|procedure)\s+".*"\s+on\s+([\w-]*)$/i.exec(before))) return names(cfg.connections.map((c) => c.name), CompletionKind.Module, 'DB connection', edit(m[1].length));
  if ((m = /^\s*compare\s+document\b.*\busing\s+([\w-]*)$/i.exec(before))) return names(cfg.documents.map((d) => d.name), CompletionKind.Function, 'document check', edit(m[1].length));
  if ((m = /^(\s*)((?:expect|verify)\s+)(.*)$/i.exec(before)) && !m[3].includes('"')) return phraseItems('expectation', true, edit(m[3].length));
  if ((m = /^(\s*)([^"]*)$/.exec(before))) {
    const kinds = lineKinds(lines.slice(0, pos.line));
    const inSteps = kinds.some((k) => k === 'step' || k === 'expect');
    const typed = m[2];
    return inSteps
      ? [...phraseItems('action', false, edit(typed.length)), ...phraseItems('expectation', false, edit(typed.length))]
      : [...phraseItems('header', false, edit(typed.length)), ...phraseItems('action', false, edit(typed.length))];
  }
  return [];
}
