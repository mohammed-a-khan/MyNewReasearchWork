/**
 * Editor diagnostics for `.feature` files without running anything: syntax
 * problems (line and column), and per step which step definition or EZTest
 * phrasing it binds to, or that it is undefined or ambiguous.
 *
 * Step definitions are found by reading the step files' text (a static scan
 * of `Given(...)`, `When(...)`, `Then(...)`, `Step(...)` and
 * `defineParameterType({ name, regexp })` calls with literal arguments), so
 * the Studio never executes user code to show them. Patterns built at run
 * time are not seen; `eztest validate` loads the real modules.
 */
import { ezFallback } from './fallback.js';
import { ParameterTypeRegistry, stepExpression, type StepExpression } from './expressions.js';
import { compilePickles } from './gherkin/compile.js';
import { parseGherkinLenient, type GherkinIssue } from './gherkin/parser.js';
import { snippet } from './snippets.js';

export interface StaticDefinition {
  keyword: string;
  /** The pattern as written: an expression, or `/regex/flags`. */
  pattern: string;
  regexp?: { source: string; flags: string };
  file: string;
  line: number;
}

export interface StaticParameterType {
  name: string;
  sources: string[];
  file: string;
  line: number;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Read a JS string literal starting at `i` (quote char at text[i]); undefined for template literals with `${`. */
function readString(text: string, i: number): { value: string; end: number } | undefined {
  const q = text[i];
  let v = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      const n = text[j + 1];
      v += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j++;
      continue;
    }
    if (q === '`' && c === '$' && text[j + 1] === '{') return undefined;
    if (c === q) return { value: v, end: j + 1 };
    if (c === '\n' && q !== '`') return undefined;
    v += c;
  }
  return undefined;
}

/** Read a regex literal starting at `i` ("/" at text[i]). */
function readRegex(text: string, i: number): { source: string; flags: string; end: number } | undefined {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\n') return undefined;
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      const flags = /^[a-z]*/.exec(text.slice(j + 1))?.[0] ?? '';
      return { source: text.slice(i + 1, j), flags, end: j + 1 + flags.length };
    }
  }
  return undefined;
}

const CALL = /(?:^|[^\w.$])(Given|When|Then|Step)\s*\(\s*/g;
const PARAM = /defineParameterType\s*\(\s*\{/g;

/** Step definitions and parameter types written with literal arguments in a step file's text. */
export function scanStepDefinitions(text: string, file: string): { definitions: StaticDefinition[]; parameterTypes: StaticParameterType[] } {
  const definitions: StaticDefinition[] = [];
  for (const m of text.matchAll(CALL)) {
    const at = (m.index ?? 0) + m[0].length;
    const c = text[at];
    const line = lineAt(text, (m.index ?? 0) + m[0].indexOf(m[1]));
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(text, at);
      if (s) definitions.push({ keyword: m[1], pattern: s.value, file, line });
    } else if (c === '/') {
      const r = readRegex(text, at);
      if (r) definitions.push({ keyword: m[1], pattern: `/${r.source}/${r.flags}`, regexp: { source: r.source, flags: r.flags }, file, line });
    }
  }
  const parameterTypes: StaticParameterType[] = [];
  for (const m of text.matchAll(PARAM)) {
    const start = (m.index ?? 0) + m[0].length;
    const body = text.slice(start, start + 800);
    const nm = /\bname\s*:\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/.exec(body);
    if (!nm) continue;
    const re = /\bregexp\s*:\s*/.exec(body);
    const sources: string[] = [];
    if (re) {
      let k = re.index + re[0].length;
      const items = body[k] === '[';
      if (items) k++;
      for (;;) {
        while (/\s/.test(body[k] ?? '')) k++;
        const ch = body[k];
        if (ch === '/') {
          const r = readRegex(body, k);
          if (!r) break;
          sources.push(r.source);
          k = r.end;
        } else if (ch === "'" || ch === '"' || ch === '`') {
          const s = readString(body, k);
          if (!s) break;
          sources.push(s.value);
          k = s.end;
        } else break;
        while (/\s/.test(body[k] ?? '')) k++;
        if (!items || body[k] !== ',') break;
        k++;
      }
    }
    if (sources.length) parameterTypes.push({ name: nm[2], sources, file, line: lineAt(text, m.index ?? 0) });
  }
  return { definitions, parameterTypes };
}

export interface FeatureDiagnostic {
  line: number;
  column: number;
  /** 1-based column after the step text. */
  endColumn?: number;
  severity: 'error' | 'warning' | 'info';
  kind: 'syntax' | 'definition' | 'ez' | 'undefined' | 'ambiguous' | 'outline' | 'definitions';
  message: string;
  /** Undefined steps: a step definition to paste. */
  snippet?: string;
  /** `file:line` of the matching definition(s), or the EZTest grammar rule. */
  location?: string;
}

export interface FeatureAnalysis {
  ok: boolean;
  /** Syntax problems (as the parser reports them). */
  issues: GherkinIssue[];
  diagnostics: FeatureDiagnostic[];
  feature?: { name: string; line: number };
  /** Scenarios and Examples rows, as `eztest run` turns them into journeys. */
  scenarios: Array<{ name: string; line: number; rowLine?: number; tags: string[] }>;
  steps: number;
}

export interface AnalyzeOptions {
  definitions?: StaticDefinition[];
  parameterTypes?: StaticParameterType[];
  /** EZTest phrasing fallback (default true). */
  fallback?: boolean;
  language?: string;
  /** Turns definition files into paths shown in messages. */
  display?: (file: string) => string;
}

const RANK = { definition: 0, ez: 1, undefined: 2, ambiguous: 3 } as const;

/** Syntax and step-binding diagnostics for feature text. */
export function analyzeFeature(text: string, uri: string, o: AnalyzeOptions = {}): FeatureAnalysis {
  const { document, issues } = parseGherkinLenient(text, uri, { ...(o.language ? { language: o.language } : {}) });
  const show = o.display ?? ((f: string) => f);
  const diagnostics: FeatureDiagnostic[] = issues.map((i) => ({ line: i.line, column: i.column, severity: 'error', kind: 'syntax', message: i.message }));
  const params = new ParameterTypeRegistry();
  for (const p of o.parameterTypes ?? []) {
    try {
      params.define({ name: p.name, regexp: p.sources });
    } catch (e) {
      diagnostics.push({ line: 1, column: 1, severity: 'warning', kind: 'definitions', message: `${show(p.file)}:${p.line}: ${(e as Error).message}` });
    }
  }
  const defs: Array<StaticDefinition & { expr: StepExpression }> = [];
  for (const d of o.definitions ?? []) {
    try {
      const expr = d.regexp ? stepExpression(new RegExp(d.regexp.source, d.regexp.flags.replace(/[gy]/g, '')), params) : stepExpression(d.pattern, params);
      defs.push({ ...d, expr });
    } catch {
      // A pattern this scan cannot compile (a parameter type defined at run time): skipped.
    }
  }
  const { pickles, warnings } = compilePickles(document);
  for (const w of warnings) diagnostics.push({ line: w.line, column: 1, severity: 'warning', kind: 'outline', message: w.message });
  // One verdict per step line: the worst over the scenario's rows.
  const byLine = new Map<number, FeatureDiagnostic & { rank: number }>();
  const lines = text.split(/\r\n|\r|\n/);
  for (const p of pickles) {
    for (const s of p.steps) {
      const raw = lines[s.line - 1] ?? '';
      const column = s.column;
      const endColumn = raw.trimEnd().length + 1;
      const placeholder = /<[^<>]+>/.test(s.text);
      const hits = defs.filter((d) => {
        try {
          return !!d.expr.match(s.text);
        } catch {
          return false;
        }
      });
      let dgn: FeatureDiagnostic & { rank: number };
      if (hits.length > 1) {
        dgn = {
          line: s.line, column, endColumn, severity: 'error', kind: 'ambiguous', rank: RANK.ambiguous, location: hits.map((d) => `${show(d.file)}:${d.line}`).join(', '),
          message: `Ambiguous: ${hits.length} step definitions match: ${hits.map((d) => `${d.pattern} (${show(d.file)}:${d.line})`).join('; ')}`,
        };
      } else if (hits.length === 1) {
        dgn = { line: s.line, column, endColumn, severity: 'info', kind: 'definition', rank: RANK.definition, location: `${show(hits[0].file)}:${hits[0].line}`, message: `Step definition ${hits[0].keyword}(${hits[0].pattern}) at ${show(hits[0].file)}:${hits[0].line}` };
      } else {
        const fb = o.fallback === false ? undefined : ezFallback({ text: s.text, type: s.type, ...(s.docString ? { docString: s.docString } : {}), ...(s.dataTable ? { dataTable: s.dataTable } : {}) });
        if (fb) {
          dgn = { line: s.line, column, endColumn, severity: 'info', kind: 'ez', rank: RANK.ez, location: fb.rule, message: `EZTest phrasing (${fb.rule}): runs as ${fb.lines.map((l) => `"${l}"`).join(', ')}` };
        } else if (placeholder) {
          dgn = { line: s.line, column, endColumn, severity: 'info', kind: 'outline', rank: RANK.ez, message: 'Bound when the run reads this outline\'s Examples rows' };
        } else {
          const snip = snippet({ text: s.text, type: s.type, hasDataTable: !!s.dataTable, hasDocString: !!s.docString }, params);
          dgn = { line: s.line, column, endColumn, severity: 'warning', kind: 'undefined', rank: RANK.undefined, snippet: snip, message: `Undefined step: no step definition matches${o.fallback === false ? '' : ' and it is not an EZTest phrasing'}. Add:\n${snip}` };
        }
      }
      const prev = byLine.get(s.line);
      if (!prev || dgn.rank > prev.rank) byLine.set(s.line, dgn);
    }
  }
  for (const d of byLine.values()) {
    const { rank: _rank, ...rest } = d;
    diagnostics.push(rest);
  }
  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  const f = document.feature;
  return {
    ok: issues.length === 0 && !diagnostics.some((d) => d.severity === 'error'),
    issues,
    diagnostics,
    ...(f ? { feature: { name: f.name, line: f.location.line } } : {}),
    scenarios: pickles.map((p) => ({ name: p.name, line: p.scenario.line, ...(p.examples?.row ? { rowLine: p.examples.row.line } : {}), tags: p.tags })),
    steps: pickles.reduce((n, p) => n + p.steps.length, 0),
  };
}
