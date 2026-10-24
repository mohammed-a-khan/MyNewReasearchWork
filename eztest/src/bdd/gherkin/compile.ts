/**
 * Compile a Gherkin document into runnable scenarios ("pickles"): background
 * steps first (the Feature's, then the Rule's), tags inherited from Feature,
 * Rule, Scenario and Examples, and one pickle per Examples row of an outline
 * with `<placeholder>` values substituted in the name, step text, doc strings
 * and data tables. An external Examples block (`from data` / `from query`)
 * becomes one pickle whose rows are read when the run starts.
 */
import type { ExamplesSource } from '../../intent/examples-source.js';
import type { Background, DocString, Examples, Feature, GherkinDocument, Rule, Scenario, Step } from './ast.js';
import type { KeywordType } from './languages.js';

export interface PickleStep {
  /** The keyword as written ("Given", "And", "*", "Angenommen"). */
  keyword: string;
  /** What the step reads as: And/But/`*` take the type of the step before (the first one is a context step). */
  type: 'context' | 'action' | 'outcome';
  /** The keyword's own type. */
  keywordType: KeywordType;
  text: string;
  line: number;
  column: number;
  /** Comes from a Background. */
  background?: boolean;
  docString?: { content: string; mediaType?: string; line: number };
  /** Data table cells, rows of strings. */
  dataTable?: string[][];
}

export interface PickleExamples {
  keyword: string;
  name: string;
  line: number;
  tags: string[];
  /** 0-based index of the Examples block in the outline. */
  index: number;
  /** The row this pickle runs (inline tables), with its values. */
  row?: { line: number; index: number; values: Record<string, string> };
  /** External rows (EZTest extension), read when the run starts. */
  source?: ExamplesSource;
}

export interface Pickle {
  uri: string;
  language: string;
  /** Scenario name with this row's values (outlines). */
  name: string;
  feature: { keyword: string; name: string; description: string; line: number; tags: string[] };
  rule?: { keyword: string; name: string; description: string; line: number; tags: string[] };
  scenario: { keyword: string; name: string; description: string; line: number; tags: string[]; outline: boolean };
  examples?: PickleExamples;
  /** Every inherited tag, with "@", deduplicated in order. */
  tags: string[];
  steps: PickleStep[];
}

export interface CompileResult {
  pickles: Pickle[];
  /** Outlines that produce no scenario (no Examples rows), and similar notes. */
  warnings: Array<{ line: number; message: string }>;
}

const tagNames = (tags: Array<{ name: string }>) => tags.map((t) => t.name);
const dedupe = (xs: string[]) => [...new Set(xs)];

function fill(s: string, values: Record<string, string> | undefined): string {
  if (!values) return s;
  return s.replace(/<([^<>]+)>/g, (w, k: string) => (k in values ? values[k] : w));
}

function pickleSteps(steps: Step[], background: boolean, values: Record<string, string> | undefined, prev: { type: PickleStep['type'] }): PickleStep[] {
  return steps.map((s) => {
    const type: PickleStep['type'] = s.keywordType === 'context' || s.keywordType === 'action' || s.keywordType === 'outcome' ? s.keywordType : prev.type;
    prev.type = type;
    const doc = s.docString as DocString | undefined;
    return {
      keyword: s.keyword, type, keywordType: s.keywordType, text: fill(s.text, values), line: s.location.line, column: s.location.column,
      ...(background ? { background: true } : {}),
      ...(doc ? { docString: { content: fill(doc.content, values), ...(doc.mediaType ? { mediaType: fill(doc.mediaType, values) } : {}), line: doc.location.line } } : {}),
      ...(s.dataTable ? { dataTable: s.dataTable.rows.map((r) => r.cells.map((c) => fill(c.value, values))) } : {}),
    };
  });
}

/** Turn a parsed document into pickles. */
export function compilePickles(doc: GherkinDocument): CompileResult {
  const out: CompileResult = { pickles: [], warnings: [] };
  const f = doc.feature;
  if (!f) return out;
  const featureBg = f.children.find((c): c is Background => c.kind === 'background');
  const visit = (sc: Scenario, rule: Rule | undefined) => {
    const ruleBg = rule?.children.find((c): c is Background => c.kind === 'background');
    const bgs = [featureBg, ruleBg].filter((b): b is Background => !!b);
    const base = {
      uri: doc.uri, language: f.language,
      feature: featureInfo(f),
      ...(rule ? { rule: { keyword: rule.keyword, name: rule.name, description: rule.description, line: rule.location.line, tags: tagNames(rule.tags) } } : {}),
      scenario: { keyword: sc.keyword, name: sc.name, description: sc.description, line: sc.location.line, tags: tagNames(sc.tags), outline: sc.outline },
    };
    const inherited = [...tagNames(f.tags), ...tagNames(rule?.tags ?? []), ...tagNames(sc.tags)];
    const build = (values: Record<string, string> | undefined): PickleStep[] => {
      const prev = { type: 'context' as PickleStep['type'] };
      return [...bgs.flatMap((b) => pickleSteps(b.steps, true, values, prev)), ...pickleSteps(sc.steps, false, values, prev)];
    };
    if (!sc.outline || !sc.examples.length) {
      if (sc.outline) out.warnings.push({ line: sc.location.line, message: `"${sc.name}" is a Scenario Outline without Examples: it runs no scenario` });
      else out.pickles.push({ ...base, name: sc.name, tags: dedupe(inherited), steps: build(undefined) });
      return;
    }
    let produced = 0;
    sc.examples.forEach((ex: Examples, index) => {
      const exTags = tagNames(ex.tags);
      const exInfo = { keyword: ex.keyword, name: ex.name, line: ex.location.line, tags: exTags, index };
      if (ex.source) {
        produced++;
        out.pickles.push({ ...base, name: sc.name, examples: { ...exInfo, source: ex.source }, tags: dedupe([...inherited, ...exTags]), steps: build(undefined) });
        return;
      }
      if (!ex.tableHeader) return;
      const header = ex.tableHeader.cells.map((c) => c.value);
      ex.tableBody.forEach((row, ri) => {
        const values: Record<string, string> = {};
        header.forEach((h, k) => (values[h] = row.cells[k]?.value ?? ''));
        produced++;
        out.pickles.push({
          ...base, name: fill(sc.name, values), examples: { ...exInfo, row: { line: row.location.line, index: ri, values } },
          tags: dedupe([...inherited, ...exTags]), steps: build(values),
        });
      });
    });
    if (!produced) out.warnings.push({ line: sc.location.line, message: `Scenario Outline "${sc.name}" has no Examples rows: it runs no scenario` });
  };
  for (const c of f.children) {
    if (c.kind === 'scenario') visit(c, undefined);
    else if (c.kind === 'rule') for (const k of c.children) if (k.kind === 'scenario') visit(k, c);
  }
  return out;
}

function featureInfo(f: Feature): Pickle['feature'] {
  return { keyword: f.keyword, name: f.name, description: f.description, line: f.location.line, tags: tagNames(f.tags) };
}
