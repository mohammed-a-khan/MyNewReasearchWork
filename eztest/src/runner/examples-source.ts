/**
 * Run-time resolution of external Examples sources (`Examples: from data ...`
 * / `from query ...`): load the rows, apply the filter and hand them to the
 * Examples expansion, so each row becomes one journey instance.
 *
 * Data files (json, csv, tsv, xlsx) are read here. Named queries go through a
 * `DataSourceResolver` hook (RunOptions.dataSourceResolver), which the engine
 * wires to the database layer; a resolver may also serve data files itself
 * (returning undefined falls back to the built-in file reader).
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError, interpolate, type Journey } from '../core/index.js';
import { matchRow, parseRowFilter, rowFilterComparisons, rowValue, type ExamplesSource } from '../intent/examples-source.js';
import { queryPath } from '../surfaces/jsonpath.js';
import { readDataRows } from './flow.js';

export type DataRow = Record<string, unknown>;

export interface DataSourceContext {
  /** Directory relative data files resolve against. */
  baseDir: string;
  /** Run variables (config variables), for `${var}` in file names, params and filter values. */
  variables: Record<string, unknown>;
  /** Journey that declared the source. */
  journey: Journey;
}

/**
 * Supplies rows for an Examples source. Return undefined to let the built-in
 * reader handle it (data files); named queries need a resolver.
 */
export type DataSourceResolver = (source: ExamplesSource, ctx: DataSourceContext) => Promise<DataRow[] | undefined>;

export interface LoadRowsOptions {
  baseDir?: string;
  variables?: Record<string, unknown>;
  resolver?: DataSourceResolver;
  journey?: Journey;
}

/** Absolute path of a data source file. */
export function dataSourcePath(file: string, baseDir: string = process.cwd()): string {
  return isAbsolute(file) ? file : resolve(baseDir, file);
}

/** Read a JSON file's rows, following an optional JSONPath. */
async function jsonRows(path: string, jsonPath?: string): Promise<DataRow[]> {
  const { readFile } = await import('node:fs/promises');
  const doc: unknown = JSON.parse(await readFile(path, 'utf8'));
  let v: unknown = doc;
  if (jsonPath && jsonPath.trim() !== '$') {
    const hits = queryPath(doc, jsonPath);
    v = hits.length === 1 ? hits[0] : hits;
  }
  if (Array.isArray(v)) return v.filter((r) => r && typeof r === 'object') as DataRow[];
  if (v && typeof v === 'object') {
    const rows = (v as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as DataRow[];
    return [v as DataRow];
  }
  throw new EzTestError(`${path}: ${jsonPath ? `path ${jsonPath}` : 'the file'} does not hold a list of rows`, 'BAD_DATA');
}

/** All rows of a source before filtering. */
export async function loadSourceRows(src: ExamplesSource, opts: LoadRowsOptions = {}): Promise<DataRow[]> {
  const baseDir = opts.baseDir ?? process.cwd();
  const variables = opts.variables ?? {};
  if (opts.resolver) {
    const ctx: DataSourceContext = { baseDir, variables, journey: opts.journey ?? ({ id: 'examples', name: 'examples' } as Journey) };
    const rows = await opts.resolver(src, ctx);
    if (rows) return rows;
  }
  if (src.query !== undefined) {
    throw new EzTestError(
      `Examples from query "${src.query}" on ${src.connection ?? '?'}: no data source resolver for named queries is configured (needs a db.queries catalogue)`,
      'NO_DATA_SOURCE',
    );
  }
  const file = interpolate(src.from ?? '', variables as Record<string, unknown>);
  const path = dataSourcePath(file, baseDir);
  if (!existsSync(path)) throw new EzTestError(`Examples data file not found: ${file} (looked in ${path})`, 'NO_DATA_FILE');
  if (/\.json$/i.test(path)) return jsonRows(path, src.path);
  return readDataRows(path, src.sheet);
}

/** Apply a source's filter to rows. */
export function filterRows(rows: DataRow[], where: string | undefined, variables: Record<string, unknown> = {}): DataRow[] {
  if (!where) return rows;
  const f = parseRowFilter(where);
  return rows.filter((r) => matchRow(f, r, (s) => interpolate(s, variables)));
}

/** Row values as strings (Examples variables are text). */
export function rowToStrings(row: DataRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Load and filter the rows of a source. */
export async function loadExamplesRows(src: ExamplesSource, opts: LoadRowsOptions = {}): Promise<Array<Record<string, string>>> {
  const rows = await loadSourceRows(src, opts);
  return filterRows(rows, src.where, opts.variables).map(rowToStrings);
}

export interface ResolvedExamples {
  /** Journeys with `examplesFrom` replaced by inline `examples` (journeys without a source unchanged). */
  journeys: Journey[];
  /** Journeys whose source produced no rows, or failed to load, with the reason. They do not run. */
  empty: Array<{ journey: Journey; reason: string }>;
}

/** Resolve every journey's external Examples source into inline rows. */
export async function resolveExamplesSources(journeys: Journey[], opts: LoadRowsOptions = {}): Promise<ResolvedExamples> {
  const out: Journey[] = [];
  const empty: ResolvedExamples['empty'] = [];
  for (const j of journeys) {
    if (!j.examplesFrom) {
      out.push(j);
      continue;
    }
    const { examplesFrom: src, ...rest } = j;
    try {
      const rows = await loadExamplesRows(src, { ...opts, journey: j });
      if (!rows.length) empty.push({ journey: j, reason: `Examples ${src.from ? `from data "${src.from}"` : `from query "${src.query}"`}${src.where ? ` where ${src.where}` : ''} matched no rows` });
      else out.push({ ...rest, examples: rows });
    } catch (e) {
      empty.push({ journey: j, reason: (e as Error).message });
    }
  }
  return { journeys: out, empty };
}

// ------------------------------------------------------------------ validation (eztest validate)

export type ExamplesIssueKind = 'missing-file' | 'bad-source' | 'bad-filter' | 'no-rows' | 'unknown-column' | 'placeholder' | 'not-checked';

export interface ExamplesIssue {
  kind: ExamplesIssueKind;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ValidateExamplesOptions extends LoadRowsOptions {
  /** Placeholder values that must not remain in data (default /REPLACE_WITH_\w*|TODO_FILL_IN/). */
  placeholder?: RegExp;
}

export const DEFAULT_PLACEHOLDER = /\bREPLACE_WITH_[A-Za-z0-9_]*|\bTODO_FILL_IN\b/;

/**
 * Check a journey's external Examples source without running it: the file
 * exists and parses, the filter is valid, refers to existing columns and
 * matches at least one row, and the matched rows hold no placeholder values.
 */
export async function validateExamplesSource(src: ExamplesSource, opts: ValidateExamplesOptions = {}): Promise<ExamplesIssue[]> {
  const issues: ExamplesIssue[] = [];
  if (src.where) {
    try {
      parseRowFilter(src.where);
    } catch (e) {
      return [{ kind: 'bad-filter', severity: 'error', message: (e as Error).message }];
    }
  }
  if (src.query !== undefined && !opts.resolver) {
    return [{ kind: 'not-checked', severity: 'info', message: `Examples from query "${src.query}" on ${src.connection}: not checked offline` }];
  }
  let rows: DataRow[];
  try {
    rows = await loadSourceRows(src, opts);
  } catch (e) {
    const err = e as EzTestError;
    return [{ kind: err.code === 'NO_DATA_FILE' ? 'missing-file' : 'bad-source', severity: 'error', message: err.message }];
  }
  const label = src.from ? `"${src.from}"` : `query "${src.query}"`;
  if (src.where) {
    const f = parseRowFilter(src.where);
    for (const c of rowFilterComparisons(f)) {
      if (rows.length && !rows.some((r) => rowValue(r, c.column).found)) {
        issues.push({ kind: 'unknown-column', severity: 'warning', message: `${label}: filter column "${c.column}" is not in the data` });
      }
    }
  }
  const matched = filterRows(rows, src.where, opts.variables);
  if (!matched.length) {
    issues.push({ kind: 'no-rows', severity: 'warning', message: `${label}${src.where ? ` where ${src.where}` : ''}: no rows match (${rows.length} row(s) in the source)` });
  }
  const ph = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  const hits = new Map<string, number>();
  for (const r of matched) {
    for (const [k, v] of Object.entries(rowToStrings(r))) {
      const m = ph.exec(v);
      if (m) hits.set(`${k}=${m[0]}`, (hits.get(`${k}=${m[0]}`) ?? 0) + 1);
    }
  }
  for (const [what, n] of hits) {
    issues.push({ kind: 'placeholder', severity: 'warning', message: `${label}: placeholder value ${what} in ${n} matched row(s)` });
  }
  return issues;
}
