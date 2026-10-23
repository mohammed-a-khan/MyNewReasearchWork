/**
 * Gherkin / Cucumber importer: Feature, Rule, Background, Scenario and
 * Scenario Outline (one journey per Examples row). Step text goes through the
 * EZ grammar with the keyword stripped; "Then" lines become post-conditions of
 * the preceding action. Doc strings and data tables are converted only when
 * they map cleanly; otherwise they stay as TODO lines.
 */
import { quoteText, type ExamplesSource } from '../intent/index.js';
import { JourneyDraft, oneLine, type SourceRef } from './builder.js';
import { assembleReport } from './report.js';
import type { ImportKind, ImportReport, ImporterOptions, SourceDiagnostic } from './types.js';

export interface GStep {
  keyword: string;
  text: string;
  line: number;
  doc?: { lines: string[]; line: number };
  table?: Array<{ cells: string[]; line: number; raw: string }>;
}

export interface GExamples {
  name: string;
  tags: string[];
  line: number;
  rows: Array<{ cells: string[]; line: number }>;
}

export interface GScenario {
  name: string;
  line: number;
  tags: string[];
  description: string[];
  steps: GStep[];
  outline: boolean;
  examples: GExamples[];
  backgrounds: GStep[][];
  rule?: string;
  ruleTags: string[];
}

const STEP = /^(Given|When|Then|And|But|\*)\s+(.*)$/;
const BLOCK = /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios)\s*:\s*(.*)$/;

/** Split a table row `| a | b \| c |` into trimmed cells. */
export function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && (t[i + 1] === '|' || t[i + 1] === '\\' || t[i + 1] === 'n')) {
      cur += t[i + 1] === 'n' ? '\n' : t[i + 1];
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

export interface ParsedFeature {
  name: string;
  line: number;
  tags: string[];
  description: string[];
  scenarios: GScenario[];
  warnings: string[];
}

/** Parse feature text into a small Gherkin AST. */
export function parseFeature(text: string, file = 'feature'): ParsedFeature {
  const lines = text.split(/\r?\n/);
  const f: ParsedFeature = { name: '', line: 1, tags: [], description: [], scenarios: [], warnings: [] };
  let pendingTags: string[] = [];
  let featureBg: GStep[] = [];
  let ruleBg: GStep[] = [];
  let rule: string | undefined;
  let ruleTags: string[] = [];
  let mode: 'none' | 'feature' | 'background' | 'scenario' | 'examples' | 'rule' = 'none';
  let cur: GScenario | undefined;
  let curSteps: GStep[] | undefined;
  let ex: GExamples | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const ln = i + 1;
    if (!t) continue;
    if (t.startsWith('#')) {
      const lang = /^#\s*language\s*:\s*(\S+)/i.exec(t);
      if (lang && !/^en/i.test(lang[1])) f.warnings.push(`${file}:${ln}: language "${lang[1]}" — only English Gherkin keywords are recognised`);
      continue;
    }
    if (t.startsWith('"""') || t.startsWith('```')) {
      const fence = t.slice(0, 3);
      const indent = raw.indexOf(fence);
      const doc: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== fence; j++) doc.push(lines[j].slice(Math.min(indent, lines[j].search(/\S|$/))));
      const last = curSteps?.[curSteps.length - 1];
      if (last) last.doc = { lines: doc, line: ln };
      else f.warnings.push(`${file}:${ln}: doc string without a step`);
      i = j;
      continue;
    }
    if (t.startsWith('|')) {
      if (mode === 'examples' && ex) {
        ex.rows.push({ cells: tableCells(t), line: ln });
      } else {
        const last = curSteps?.[curSteps.length - 1];
        if (last) (last.table ??= []).push({ cells: tableCells(t), line: ln, raw: t });
        else f.warnings.push(`${file}:${ln}: table row without a step`);
      }
      continue;
    }
    if (t.startsWith('@')) {
      pendingTags.push(...t.split(/\s+/).filter((x) => x.startsWith('@')).map((x) => x.slice(1)));
      continue;
    }
    const b = BLOCK.exec(t);
    if (b) {
      const kw = b[1];
      const name = b[2].trim();
      if (kw === 'Feature') {
        f.name = name;
        f.line = ln;
        f.tags = pendingTags;
        mode = 'feature';
      } else if (kw === 'Rule') {
        rule = name;
        ruleTags = pendingTags;
        ruleBg = [];
        mode = 'rule';
      } else if (kw === 'Background') {
        curSteps = rule !== undefined ? ruleBg : featureBg;
        mode = 'background';
      } else if (kw === 'Examples' || kw === 'Scenarios') {
        if (!cur?.outline) {
          f.warnings.push(`${file}:${ln}: Examples outside a Scenario Outline`);
        } else {
          ex = { name, tags: pendingTags, line: ln, rows: [] };
          cur.examples.push(ex);
        }
        mode = 'examples';
      } else {
        const outline = kw === 'Scenario Outline' || kw === 'Scenario Template';
        cur = {
          name, line: ln, tags: pendingTags, description: [], steps: [], outline, examples: [],
          backgrounds: rule !== undefined ? [featureBg, ruleBg] : [featureBg], ...(rule !== undefined ? { rule } : {}), ruleTags,
        };
        f.scenarios.push(cur);
        curSteps = cur.steps;
        mode = 'scenario';
      }
      pendingTags = [];
      continue;
    }
    const s = STEP.exec(t);
    if (s && (mode === 'background' || mode === 'scenario') && curSteps) {
      curSteps.push({ keyword: s[1], text: s[2].trim(), line: ln });
      continue;
    }
    if (mode === 'feature') f.description.push(t);
    else if (mode === 'scenario' && cur && cur.steps.length === 0) cur.description.push(t);
    else f.warnings.push(`${file}:${ln}: unrecognised line ignored: ${t}`);
  }
  return f;
}

const subst = (s: string, vars: Record<string, string>) => s.replace(/<([^<>]+)>/g, (w, k: string) => (k in vars ? vars[k] : w));

function q(s: string): string | undefined {
  try {
    return quoteText(s);
  } catch {
    return undefined;
  }
}

/** A step as handed to a GherkinImportOptions.convertStep hook. */
export interface StepHookInput {
  step: GStep;
  /** Effective keyword (And/But resolved to the preceding Given/When/Then). */
  primary: string;
  /** Step text with Examples values (or `${col}` for external Examples) substituted. */
  text: string;
  vars: Record<string, string>;
}

/** What a GherkinImportOptions.externalExamples hook is asked to read. */
export interface ExternalExamplesInput {
  /** The text after `Examples:` of a block without a table, or a scenario tag (without "@"). */
  text: string;
  /** True when `text` is a scenario tag. */
  tag: boolean;
  file: string;
  line: number;
}

/** An external Examples source read by a GherkinImportOptions.externalExamples hook. */
export interface ExternalExamples {
  /** The EZ source (`Examples: from data ...`); absent when it could not be built. */
  source?: ExamplesSource;
  /** Column names known from the data (each `<col>` becomes `${col}`). */
  columns?: string[];
  /** Problems found while reading the source (reported as source-suite diagnostics). */
  diagnostics?: SourceDiagnostic[];
  /** Why the description is malformed (it may still have been read). */
  malformed?: string;
}

/** Options of the Gherkin importer beyond the shared ones (used by importer plugins built on it). */
export interface GherkinImportOptions extends ImporterOptions {
  /** Importer kind recorded on the journeys (default "gherkin"). */
  kind?: ImportKind;
  /** Convert a step itself; return true when handled (otherwise the EZ grammar is used). */
  convertStep?: (d: JourneyDraft, input: StepHookInput) => boolean;
  /** Rewrite step text before conversion (e.g. resolver tokens). */
  rewrite?: (text: string) => string;
  /**
   * Read external Examples: called for each Scenario Outline tag and each `Examples:` block
   * without a table. Return undefined when the text does not describe an external source.
   * Without this hook, table-less Examples blocks have no rows and tags stay tags.
   */
  externalExamples?: (input: ExternalExamplesInput) => ExternalExamples | undefined;
  /** Collects source-suite diagnostics (missing data files, dangling filters, ...). */
  diagnostics?: SourceDiagnostic[];
}

/** Convert one Gherkin step into the draft. `primary` is the effective keyword (And/But resolved). */
function convertStep(d: JourneyDraft, st: GStep, primary: string, vars: Record<string, string>, opts: GherkinImportOptions = {}): void {
  const rewritten = opts.rewrite ? opts.rewrite(st.text) : st.text;
  const text = subst(rewritten, vars);
  if (opts.convertStep?.(d, { step: st, primary, text, vars })) return;
  const src: SourceRef = { line: st.line, original: `${st.keyword} ${text}` };
  const isThen = primary === 'Then';
  if (st.table) {
    const rows = st.table.map((r) => ({ ...r, cells: r.cells.map((c) => subst(c, vars)) }));
    const twoCol = rows.every((r) => r.cells.length === 2);
    if (twoCol && !isThen && /\b(?:fill|enter|type|complete|provide|input)\b/i.test(text)) {
      const body = /^(?:field|name|label|input)$/i.test(rows[0]?.cells[0] ?? '') ? rows.slice(1) : rows;
      d.comment(`${st.keyword} ${text}`);
      for (const r of body) {
        const [field, value] = r.cells;
        const qf = q(field);
        const qv = q(value);
        const rsrc = { line: r.line, original: r.raw };
        if (!qf || !qv) d.addTodo(rsrc, 'table cell cannot be quoted');
        else d.step(`Type ${qv} into the ${qf} field`, rsrc, { action: 'fill', value, candidate: { strategy: 'label', value: field } });
      }
      return;
    }
    d.addTodo(src, 'data table is not mappable to EZ steps', isThen ? 'assertion' : 'step');
    for (const r of rows) d.comment(`  ${r.raw}`);
    return;
  }
  if (st.doc) {
    const doc = st.doc.lines.map((l) => subst(l, vars));
    const single = doc.filter((l) => l.trim()).length === 1 ? doc.find((l) => l.trim())!.trim() : undefined;
    const qd = single !== undefined ? q(single) : undefined;
    if (qd) {
      const merged = `${text.replace(/\s*:\s*$/, '')} ${qd}`;
      const before = d.todo.length;
      const probe = new JourneyDraft('probe', { kind: 'gherkin', file: 'probe', line: 0, ids: new Set() });
      if (probe.english(merged, src, isThen) && probe.todo.length === 0) {
        d.english(merged, src, isThen);
        if (d.todo.length === before) return;
      }
    }
    d.addTodo(src, 'doc string is not mappable to EZ steps', isThen ? 'assertion' : 'step');
    for (const l of doc) d.comment(`  ${l}`);
    return;
  }
  d.english(text, src, isThen);
}

function convertSteps(d: JourneyDraft, steps: GStep[], vars: Record<string, string>, opts: GherkinImportOptions = {}): void {
  let primary = 'Given';
  for (const st of steps) {
    if (st.keyword === 'Given' || st.keyword === 'When' || st.keyword === 'Then') primary = st.keyword;
    try {
      convertStep(d, st, primary, vars, opts);
    } catch (e) {
      d.addTodo({ line: st.line, original: `${st.keyword} ${st.text}` }, `conversion error: ${(e as Error).message}`, primary === 'Then' ? 'assertion' : 'step');
    }
  }
}

/** Count a scenario's steps as unconverted (an outline whose Examples yield no rows still has source steps). */
function countUnconverted(d: JourneyDraft, steps: GStep[], reason: string): void {
  let primary = 'Given';
  for (const st of steps) {
    if (st.keyword === 'Given' || st.keyword === 'When' || st.keyword === 'Then') primary = st.keyword;
    d.addTodo({ line: st.line, original: `${st.keyword} ${st.text}` }, reason, primary === 'Then' ? 'assertion' : 'step');
  }
}

/** Placeholders `<col>` used in an outline's name and steps. */
function outlineColumns(sc: GScenario): string[] {
  const cols = new Set<string>();
  for (const t of [sc.name, ...sc.steps.flatMap((s) => [s.text, ...(s.table ?? []).flatMap((r) => r.cells), ...(s.doc?.lines ?? [])])]) {
    for (const m of t.matchAll(/<([^<>]+)>/g)) cols.add(m[1]);
  }
  return [...cols];
}

/** Import a Gherkin feature file. */
export function importGherkin(text: string, opts: GherkinImportOptions = {}): ImportReport {
  const file = opts.file ?? 'feature.feature';
  const ids = opts.ids ?? new Set<string>();
  const kind = opts.kind ?? 'gherkin';
  const f = parseFeature(text, file);
  const warnings = [...f.warnings];
  if (!f.name) warnings.push(`${file}: no "Feature:" line found`);
  const drafts: JourneyDraft[] = [];
  for (const sc of f.scenarios) {
    // External Examples (read by the externalExamples hook): a scenario tag naming a data source is not kept as a tag.
    const external = opts.externalExamples;
    const tagSource = external
      ? sc.tags.map((t) => ({ t, x: external({ text: t, tag: true, file, line: sc.line }) })).find((e) => e.x !== undefined)
      : undefined;
    const baseTags = [...(opts.tags ?? []), ...f.tags, ...sc.ruleTags, ...sc.tags].filter((t) => t !== tagSource?.t);
    const description = oneLine(sc.description.join(' ')) || oneLine(f.description.join(' ')) || undefined;
    const runs: Array<{ name: string; vars: Record<string, string>; tags: string[]; line: number; examplesFrom?: ExamplesSource }> = [];
    const unresolved: string[] = [];
    const externals = new Map<GExamples, ExternalExamples>();
    if (sc.outline && external) {
      for (const ex of sc.examples) {
        if (ex.rows.length) continue;
        const x = external({ text: ex.name, tag: false, file, line: ex.line });
        if (x) externals.set(ex, x);
      }
    }
    if (!sc.outline) {
      runs.push({ name: sc.name, vars: {}, tags: baseTags, line: sc.line });
    } else {
      const sources: Array<{ ex: GExamples; x: ExternalExamples }> = [
        ...(tagSource ? [{ ex: { name: tagSource.t, tags: [], line: sc.line, rows: [] }, x: tagSource.x! }] : []),
        ...[...externals].map(([ex, x]) => ({ ex, x })),
      ];
      for (const { ex, x } of sources) {
        if (x.malformed) {
          const d = { kind: 'malformed-examples', file, line: ex.line, message: `Examples ${x.malformed}` };
          opts.diagnostics?.push(d);
          warnings.push(`${file}:${ex.line}: ${d.message}`);
        }
        const diags = x.diagnostics ?? [];
        opts.diagnostics?.push(...diags);
        if (!x.source) {
          unresolved.push(diags.length || !x.malformed
            ? `Examples at line ${ex.line}: ${diags.map((d) => d.message).join('; ') || 'no usable source'}`
            : `Examples at line ${ex.line} could not be read (${x.malformed})`);
          continue;
        }
        // One journey per Examples source; rows expand at run time and <col> becomes ${col}.
        const vars = Object.fromEntries([...new Set([...outlineColumns(sc), ...(x.columns ?? [])])].map((c) => [c, '${' + c + '}']));
        runs.push({ name: sc.name, vars, tags: [...baseTags, ...ex.tags], line: ex.line, examplesFrom: x.source });
      }
      for (const ex of sc.examples) {
        if (externals.has(ex)) continue;
        const [header, ...rows] = ex.rows;
        if (!header) {
          unresolved.push(`Examples at line ${ex.line} has no table${ex.name ? ` ("${oneLine(ex.name).slice(0, 80)}")` : ''}`);
          continue;
        }
        rows.forEach((r) => {
          const vars: Record<string, string> = {};
          header.cells.forEach((h, i) => (vars[h] = r.cells[i] ?? ''));
          let name = subst(sc.name, vars);
          if (name === sc.name) name = `${sc.name} (${header.cells.map((h) => `${h}=${vars[h]}`).join(', ')})`;
          runs.push({ name, vars, tags: [...baseTags, ...ex.tags], line: r.line });
        });
      }
      if (!runs.length) {
        warnings.push(`${file}:${sc.line}: Scenario Outline "${sc.name}" has no Examples rows${unresolved.length ? ` (${unresolved.join('; ')})` : ''}`);
        // Honest coverage: the outline's steps are source steps that were not converted.
        const fullName = f.name ? `${f.name} - ${sc.name}` : sc.name;
        const d = new JourneyDraft(fullName, { kind, file, line: sc.line, ids, tags: baseTags, ...(description ? { description } : {}) });
        const reason = `Scenario Outline has no usable Examples rows${unresolved.length ? `: ${unresolved[0]}` : ''}`;
        countUnconverted(d, sc.backgrounds.flat(), reason);
        countUnconverted(d, sc.steps, reason);
        drafts.push(d);
        continue;
      }
    }
    for (const run of runs) {
      const fullName = f.name ? `${f.name} - ${run.name}` : run.name;
      const d = new JourneyDraft(fullName, {
        kind, file, line: run.line, ids, tags: run.tags, markUnverified: true, ...(description ? { description } : {}),
        ...(run.examplesFrom ? { examplesFrom: run.examplesFrom } : {}),
      });
      const bg = sc.backgrounds.flat();
      if (bg.length) {
        d.comment('Background');
        convertSteps(d, bg, run.vars, opts);
        d.comment(`Scenario: ${run.name}`);
      }
      convertSteps(d, sc.steps, run.vars, opts);
      drafts.push(d);
    }
  }
  if (!f.scenarios.length) warnings.push(`${file}: no scenarios found`);
  return assembleReport(drafts, [file], warnings);
}
