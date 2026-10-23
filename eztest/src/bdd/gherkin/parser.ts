/**
 * EZTest's own Gherkin parser, written from the Gherkin language reference.
 *
 * Line based: every line is one token (blank, comment, language header, tags,
 * a block keyword line, a step, a table row, a doc string delimiter, or free
 * text that is a description). The parser keeps going after an error so an
 * editor can show every problem; `parseGherkin` throws a GherkinParseError
 * carrying all of them, each with its line and column.
 *
 * Supported: Feature, Rule, Background, Scenario / Example, Scenario Outline /
 * Scenario Template with several (tagged) Examples blocks, tags on Feature,
 * Rule, Scenario and Examples, Given / When / Then / And / But / `*`, doc
 * strings (`"""` and three backticks, with a media type), data tables (with
 * `\|`, `\\` and `\n` escapes), comments, descriptions, `# language:` and the
 * EZTest extension `Examples: from data "file" [sheet "S"] [where ...]`.
 */
import { EzTestError } from '../../core/index.js';
import { isExamplesFromLine, parseExamplesSource } from '../../intent/examples-source.js';
import type { Background, Comment, DataTable, DocString, Examples, Feature, GherkinDocument, Location, Rule, Scenario, Step, Tag, TableCell, TableRow } from './ast.js';
import { dialectFor, languages, type BlockKind, type CompiledDialect } from './languages.js';

export interface GherkinIssue {
  line: number;
  column: number;
  message: string;
}

/** A feature file that does not parse. `issues` holds every problem found, in line order. */
export class GherkinParseError extends EzTestError {
  constructor(readonly uri: string, readonly issues: GherkinIssue[]) {
    super(
      issues.map((i) => `${uri}:${i.line}:${i.column}: ${i.message}`).join('\n'),
      'GHERKIN_PARSE',
      { uri, issues },
    );
    this.name = 'GherkinParseError';
  }

  get line(): number {
    return this.issues[0]?.line ?? 1;
  }

  get column(): number {
    return this.issues[0]?.column ?? 1;
  }
}

export interface ParseGherkinOptions {
  /** Language when the file has no `# language:` header (default "en"). */
  language?: string;
}

const LANGUAGE_RE = /^#\s*language\s*:\s*([\w-]+)\s*$/;

/** Split a table row into cells (with their columns). Escapes: `\|`, `\\`, `\n`. */
export function splitTableRow(raw: string, line: number): { cells: TableCell[]; error?: GherkinIssue } {
  const start = raw.indexOf('|');
  const cells: TableCell[] = [];
  let cur = '';
  let cellStart = start + 1;
  let closed = false;
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const nx = raw[i + 1];
      if (nx === '|') cur += '|';
      else if (nx === '\\') cur += '\\';
      else if (nx === 'n') cur += '\n';
      else cur += ch + nx;
      i++;
      continue;
    }
    if (ch === '|') {
      const lead = /^\s*/.exec(cur)?.[0].length ?? 0;
      // Column of the cell's first non-space character (raw offsets; escapes are 2 chars wide).
      const rawCell = raw.slice(cellStart, i);
      const rawLead = /^\s*/.exec(rawCell)?.[0].length ?? lead;
      cells.push({ value: cur.trim(), location: { line, column: cellStart + rawLead + 1 } });
      cur = '';
      cellStart = i + 1;
      closed = i === raw.trimEnd().length - 1;
      continue;
    }
    cur += ch;
  }
  if (!closed && cur.trim()) {
    return { cells, error: { line, column: cellStart + (/^\s*/.exec(cur)?.[0].length ?? 0) + 1, message: 'a table row must end with "|"' } };
  }
  return { cells };
}

type Section =
  | { type: 'none' }
  | { type: 'feature' }
  | { type: 'rule'; rule: Rule }
  | { type: 'background'; bg: Background }
  | { type: 'scenario'; sc: Scenario }
  | { type: 'examples'; ex: Examples; sc: Scenario };

/** Parse feature text into a Gherkin document. Throws GherkinParseError (every problem, with line and column). */
export function parseGherkin(text: string, uri = 'feature.feature', opts: ParseGherkinOptions = {}): GherkinDocument {
  const r = parseGherkinLenient(text, uri, opts);
  if (r.issues.length) throw new GherkinParseError(uri, r.issues);
  return r.document;
}

/** Parse and return the document together with the problems found (the document holds what could be read). */
export function parseGherkinLenient(text: string, uri = 'feature.feature', opts: ParseGherkinOptions = {}): { document: GherkinDocument; issues: GherkinIssue[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const issues: GherkinIssue[] = [];
  const comments: Comment[] = [];
  const err = (line: number, column: number, message: string) => issues.push({ line, column, message });
  let dialect: CompiledDialect = dialectFor(opts.language ?? 'en') ?? dialectFor('en')!;
  let feature: Feature | undefined;
  let section: Section = { type: 'none' };
  let pendingTags: Tag[] = [];
  let pendingTagsLine = 0;
  let rule: Rule | undefined;
  /** Description lines of the current block (kept until the first step / child). */
  let desc: string[] | undefined;
  let setDesc: ((d: string) => void) | undefined;
  /** The step a doc string or table attaches to (only right after it). */
  let lastStep: Step | undefined;

  const flushDesc = () => {
    if (desc && setDesc) {
      while (desc.length && !desc[desc.length - 1].trim()) desc.pop();
      setDesc(desc.join('\n'));
    }
    desc = undefined;
    setDesc = undefined;
  };
  const startDesc = (fn: (d: string) => void) => {
    desc = [];
    setDesc = fn;
  };
  const takeTags = (kind: BlockKind): Tag[] => {
    const t = pendingTags;
    pendingTags = [];
    if (t.length && kind === 'background') err(pendingTagsLine, t[0].location.column, 'tags are not allowed on a Background');
    return kind === 'background' ? [] : t;
  };
  const container = (): { children: Array<Background | Scenario | Rule> | Array<Background | Scenario> } | undefined => rule ?? feature;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    const trimmed = raw.trim();
    const col = raw.length - raw.trimStart().length + 1;

    // ------------------------------------------------------------ blank lines
    if (!trimmed) {
      if (desc && desc.length) desc.push('');
      continue;
    }

    // ------------------------------------------------------------ comments and the language header
    if (trimmed.startsWith('#')) {
      const lang = LANGUAGE_RE.exec(trimmed);
      if (lang && !feature) {
        const d = dialectFor(lang[1]);
        if (!d) err(ln, col, `unknown language "${lang[1]}" (known: ${languages().join(', ')})`);
        else dialect = d;
      }
      comments.push({ text: raw, location: { line: ln, column: col } });
      continue;
    }

    // ------------------------------------------------------------ doc strings
    if (trimmed.startsWith('"""') || trimmed.startsWith('```')) {
      const delim = trimmed.slice(0, 3);
      const mediaType = trimmed.slice(3).trim() || undefined;
      const indent = col - 1;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === delim) break;
        const l = lines[j];
        // Remove the opening delimiter's indentation (whitespace only).
        const lead = /^[ \t]*/.exec(l)?.[0].length ?? 0;
        body.push(l.slice(Math.min(lead, indent)));
      }
      if (j >= lines.length) {
        err(ln, col, `doc string opened here is not closed (expected a line with ${delim})`);
        i = lines.length;
        continue;
      }
      const esc = delim === '"""' ? /\\"\\"\\"/g : /\\`\\`\\`/g;
      const doc: DocString = { content: body.join('\n').replace(esc, delim), delimiter: delim, location: { line: ln, column: col }, ...(mediaType ? { mediaType } : {}) };
      if (!lastStep) err(ln, col, 'a doc string must follow a step');
      else if (lastStep.docString || lastStep.dataTable) err(ln, col, 'a step takes one argument: a doc string or a data table');
      else lastStep.docString = doc;
      i = j;
      continue;
    }

    // ------------------------------------------------------------ table rows
    if (trimmed.startsWith('|')) {
      const { cells, error } = splitTableRow(raw, ln);
      if (error) err(error.line, error.column, error.message);
      const row: TableRow = { cells, location: { line: ln, column: col } };
      if (section.type === 'examples' && !lastStep) {
        const ex = section.ex;
        flushDesc();
        if (ex.source) {
          err(ln, col, 'an Examples block "from data" / "from query" has no table of its own');
          continue;
        }
        if (!ex.tableHeader) ex.tableHeader = row;
        else {
          if (row.cells.length !== ex.tableHeader.cells.length) err(ln, col, `inconsistent cell count: this row has ${row.cells.length} cells, the header has ${ex.tableHeader.cells.length}`);
          ex.tableBody.push(row);
        }
        continue;
      }
      if (!lastStep || lastStep.docString) {
        err(ln, col, lastStep ? 'a step takes one argument: a doc string or a data table' : 'a table row must follow a step or an Examples line');
        continue;
      }
      const table: DataTable = lastStep.dataTable ?? { rows: [], location: { line: ln, column: col } };
      if (table.rows.length && table.rows[0].cells.length !== row.cells.length) err(ln, col, `inconsistent cell count: this row has ${row.cells.length} cells, the first row has ${table.rows[0].cells.length}`);
      table.rows.push(row);
      lastStep.dataTable = table;
      continue;
    }

    // ------------------------------------------------------------ tags
    if (trimmed.startsWith('@')) {
      // A " #" starts a trailing comment.
      const body = trimmed.replace(/\s+#.*$/, '');
      const offset = col - 1;
      const tags: Tag[] = [];
      for (const m of body.matchAll(/\S+/g)) {
        const tok = m[0];
        const at = offset + (m.index ?? 0);
        if (!tok.startsWith('@') || tok.length < 2) err(ln, at + 1, `"${tok}" is not a tag (tags start with "@" and contain no spaces)`);
        else tags.push({ name: tok, location: { line: ln, column: at + 1 } });
      }
      if (!pendingTags.length) pendingTagsLine = ln;
      pendingTags.push(...tags);
      lastStep = undefined;
      continue;
    }

    // ------------------------------------------------------------ block keyword lines (Feature:, Scenario: ...)
    const block = matchBlock(dialect, trimmed);
    if (block) {
      lastStep = undefined;
      flushDesc();
      const loc: Location = { line: ln, column: col };
      const kind = block.kind;
      if (kind === 'feature') {
        if (feature) {
          err(ln, col, 'a file holds one Feature');
          continue;
        }
        feature = { keyword: block.keyword, name: block.name, description: '', tags: takeTags(kind), language: dialect.code, children: [], location: loc };
        const f = feature;
        startDesc((d) => (f.description = d));
        section = { type: 'feature' };
        continue;
      }
      if (!feature) {
        err(ln, col, `"${block.keyword}:" before the Feature line (a feature file starts with "${dialect.dialect.feature[0]}:")`);
        pendingTags = [];
        continue;
      }
      if (kind === 'rule') {
        rule = { kind: 'rule', keyword: block.keyword, name: block.name, description: '', tags: takeTags(kind), children: [], location: loc };
        feature.children.push(rule);
        const r = rule;
        startDesc((d) => (r.description = d));
        section = { type: 'rule', rule };
        continue;
      }
      if (kind === 'background') {
        takeTags(kind);
        const host = container()!;
        const kids = host.children as Array<Background | Scenario | Rule>;
        if (kids.some((c) => c.kind === 'background')) err(ln, col, `only one Background per ${rule ? 'Rule' : 'Feature'}`);
        else if (kids.some((c) => c.kind === 'scenario' || c.kind === 'rule')) err(ln, col, `the Background must come before the first Scenario${rule ? ' of the Rule' : ''}`);
        const bg: Background = { kind: 'background', keyword: block.keyword, name: block.name, description: '', steps: [], location: loc };
        kids.push(bg);
        startDesc((d) => (bg.description = d));
        section = { type: 'background', bg };
        continue;
      }
      if (kind === 'scenario' || kind === 'scenarioOutline') {
        const sc: Scenario = {
          kind: 'scenario', keyword: block.keyword, name: block.name, description: '', tags: takeTags(kind), steps: [], examples: [],
          outline: kind === 'scenarioOutline', location: loc,
        };
        (container()!.children as Array<Background | Scenario | Rule>).push(sc);
        startDesc((d) => (sc.description = d));
        section = { type: 'scenario', sc };
        continue;
      }
      // examples
      const sc: Scenario | undefined = section.type === 'scenario' ? section.sc : section.type === 'examples' ? section.sc : undefined;
      const tags = takeTags(kind);
      if (!sc) {
        err(ln, col, `"${block.keyword}:" must follow a Scenario Outline`);
        continue;
      }
      const ex: Examples = { keyword: block.keyword, name: block.name, description: '', tags, tableBody: [], location: loc };
      const fromLine = `Examples: ${block.name}`;
      if (/^from\s+/i.test(block.name) && isExamplesFromLine(fromLine)) {
        try {
          ex.source = parseExamplesSource(fromLine);
        } catch (e) {
          err(ln, col + block.keyword.length + 2, (e as Error).message);
        }
      }
      sc.examples.push(ex);
      sc.outline = true;
      startDesc((d) => (ex.description = d));
      section = { type: 'examples', ex, sc };
      continue;
    }

    // ------------------------------------------------------------ steps
    const step = matchStep(dialect, trimmed);
    if (step) {
      if (pendingTags.length) {
        err(pendingTagsLine, pendingTags[0].location.column, 'tags must be followed by a Feature, Rule, Scenario or Examples line');
        pendingTags = [];
      }
      const target = section.type === 'background' ? section.bg.steps : section.type === 'scenario' ? section.sc.steps : undefined;
      if (!target) {
        err(ln, col, section.type === 'examples'
          ? 'steps cannot follow Examples (start a new Scenario first)'
          : `a step must be inside a Scenario or a Background (got "${trimmed.slice(0, 60)}")`);
        lastStep = undefined;
        continue;
      }
      flushDesc();
      const st: Step = { keyword: step.keyword, keywordType: step.type, text: step.text, location: { line: ln, column: col } };
      if (!st.text) err(ln, col, `the step "${step.keyword}" has no text`);
      target.push(st);
      lastStep = st;
      continue;
    }

    // ------------------------------------------------------------ free text: a description, or an error
    if (pendingTags.length) {
      err(pendingTagsLine, pendingTags[0].location.column, 'tags must be followed by a Feature, Rule, Scenario or Examples line');
      pendingTags = [];
    }
    if (desc) {
      desc.push(trimmed);
      continue;
    }
    lastStep = undefined;
    if (!feature) err(ln, col, `expected a "${dialect.dialect.feature[0]}:" line, got "${trimmed.slice(0, 60)}"`);
    else if (section.type === 'examples') err(ln, col, `expected a table row in Examples, got "${trimmed.slice(0, 60)}"`);
    else err(ln, col, `unexpected text "${trimmed.slice(0, 60)}" (expected a step, a table row, a doc string, tags or a new block such as "${dialect.dialect.scenario[0]}:"; step keywords for "${dialect.code}": ${dialect.steps.map((s) => s.keyword).slice(0, 6).join(', ')})`);
  }
  flushDesc();
  if (pendingTags.length) err(pendingTagsLine, pendingTags[0].location.column, 'tags at the end of the file are not followed by a Feature, Rule, Scenario or Examples line');
  // Outlines need examples; examples need a header.
  const scenarios: Scenario[] = [];
  for (const c of feature?.children ?? []) {
    if (c.kind === 'scenario') scenarios.push(c);
    if (c.kind === 'rule') for (const k of c.children) if (k.kind === 'scenario') scenarios.push(k);
  }
  for (const sc of scenarios) {
    for (const ex of sc.examples) {
      if (!ex.source && !ex.tableHeader) err(ex.location.line, ex.location.column, `"${ex.keyword}:" has no table (a header row and one row per example, or "from data \\"file\\"")`);
    }
  }
  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return { document: { uri, ...(feature ? { feature } : {}), comments }, issues };
}

function matchBlock(d: CompiledDialect, line: string): { kind: BlockKind; keyword: string; name: string } | undefined {
  for (const b of d.blocks) {
    if (line.startsWith(b.keyword) && line[b.keyword.length] === ':') {
      return { kind: b.kind, keyword: b.keyword, name: line.slice(b.keyword.length + 1).trim() };
    }
  }
  return undefined;
}

function matchStep(d: CompiledDialect, line: string): { type: CompiledDialect['steps'][number]['type']; keyword: string; text: string } | undefined {
  for (const s of d.steps) {
    if (!line.startsWith(s.keyword)) continue;
    const next = line[s.keyword.length];
    if (next === undefined || next === ' ' || next === '\t' || s.keyword.endsWith("'")) {
      return { type: s.type, keyword: s.keyword, text: line.slice(s.keyword.length).trim() };
    }
  }
  return undefined;
}
