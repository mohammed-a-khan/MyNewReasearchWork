/**
 * External Examples sources for data-driven journeys:
 *
 *   Examples: from data "data/orders.json" path "$.rows" where scenarioId = "TS_1" and runFlag = Yes
 *   Examples: from data "data/users.xlsx" sheet "Active" where (region = EU or region = UK) and age >= 18
 *   Examples: from query "ACTIVE_USERS" on crm with region="EU" where status != closed
 *
 * The row filter language: comparisons `column OP value` with
 * `=` (`==`), `!=` (`<>`), `>`, `<`, `>=`, `<=`, `~` (contains), combined with
 * `and` / `or` (also `&&` / `||`), `not`, and parentheses. `and` binds tighter
 * than `or`. Column names match case-insensitively; `=`, `!=` and `~` compare
 * text case-insensitively, and numerically when both sides are numbers.
 * Values may be quoted; `${var}` in a value is resolved at run time.
 */
import { checkExpression } from '../core/expr.js';
import { protectQuotes, quoteText } from './quotes.js';

/** Where an Examples table comes from (a data file or a named query). */
export interface ExamplesSource {
  /** Data file (json, csv, tsv, xlsx), relative to the project directory. */
  from?: string;
  /** Named query (resolved by the run's DataSourceResolver). */
  query?: string;
  /** DB connection for `query`. */
  connection?: string;
  /** Named parameters for `query`. */
  params?: Record<string, string>;
  /** JSONPath to the row array inside a JSON file (default: the document, or its `rows`). */
  path?: string;
  /** Worksheet for xlsx files. */
  sheet?: string;
  /** Row filter, in the filter language above. */
  where?: string;
  /**
   * Derived columns (`with ref = unique("VIS-"), due = addDays(today(), 14)`): safe expressions evaluated
   * once per journey attempt, with the row's values as variables.
   */
  derive?: Array<{ name: string; expr: string }>;
  /**
   * Live data per row (`resolve with query "FIND_PET" on clinic with state=<requiredState> as pet when dataMode = live`):
   * for rows matching `when` (all rows without it), the query's first row joins the row's values as `<as>.<column>`.
   * No row is a data problem of that row, unless `keepRowValues` (`or keep row values`).
   */
  resolve?: { query: string; connection?: string; binds: Record<string, string>; as: string; when?: string; keepRowValues?: boolean };
}

export type FilterOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | '~' | '^=' | '$=' | 'in';

export type RowFilter =
  | { type: 'cmp'; column: string; op: FilterOp; value: string; values?: string[] }
  | { type: 'and' | 'or'; left: RowFilter; right: RowFilter }
  | { type: 'not'; inner: RowFilter };

export class FilterSyntaxError extends Error {
  constructor(message: string, readonly filter: string) {
    super(`Invalid filter "${filter}": ${message}`);
    this.name = 'FilterSyntaxError';
  }
}

type Tok = { t: 'lp' } | { t: 'rp' } | { t: 'comma' } | { t: 'and' } | { t: 'or' } | { t: 'not' } | { t: 'op'; v: FilterOp } | { t: 'word'; v: string; quoted: boolean };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const err = (m: string) => new FilterSyntaxError(m, src);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma' }); i++; continue; }
    if (src.startsWith('&&', i)) { out.push({ t: 'and' }); i += 2; continue; }
    if (src.startsWith('||', i)) { out.push({ t: 'or' }); i += 2; continue; }
    const op = /^(?:==|!=|<>|>=|<=|\^=|\$=|=|>|<|~)/.exec(src.slice(i));
    if (op) {
      const v = op[0] === '==' ? '=' : op[0] === '<>' ? '!=' : op[0];
      out.push({ t: 'op', v: v as FilterOp });
      i += op[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw err(`unterminated quote at ${i + 1}`);
      out.push({ t: 'word', v: src.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    // A bare word runs until whitespace, a parenthesis or an operator character.
    let j = i;
    while (j < src.length && !/[\s()=!<>~,]/.test(src[j]) && !((src[j] === '^' || src[j] === '$') && src[j + 1] === '=')) {
      if (src[j] === '$' && src[j + 1] === '{') {
        const close = src.indexOf('}', j);
        j = close < 0 ? src.length : close + 1;
      } else j++;
    }
    if (j === i) throw err(`unexpected "${c}" at ${i + 1}`);
    const w = src.slice(i, j);
    if (/^and$/i.test(w)) out.push({ t: 'and' });
    else if (/^or$/i.test(w)) out.push({ t: 'or' });
    else if (/^not$/i.test(w)) out.push({ t: 'not' });
    else out.push({ t: 'word', v: w, quoted: false });
    i = j;
  }
  return out;
}

/** Parse a row filter. Throws FilterSyntaxError with a readable message. */
export function parseRowFilter(text: string): RowFilter {
  const src = text.trim();
  if (!src) throw new FilterSyntaxError('empty filter', text);
  const toks = tokenize(src);
  let p = 0;
  const err = (m: string) => new FilterSyntaxError(m, src);
  const peek = () => toks[p];
  const orExpr = (): RowFilter => {
    let left = andExpr();
    while (peek()?.t === 'or') {
      p++;
      left = { type: 'or', left, right: andExpr() };
    }
    return left;
  };
  const andExpr = (): RowFilter => {
    let left = unary();
    while (peek()?.t === 'and') {
      p++;
      left = { type: 'and', left, right: unary() };
    }
    return left;
  };
  const unary = (): RowFilter => {
    const t = peek();
    if (!t) throw err('expected a comparison at the end');
    if (t.t === 'not') {
      p++;
      return { type: 'not', inner: unary() };
    }
    if (t.t === 'lp') {
      p++;
      const e = orExpr();
      if (peek()?.t !== 'rp') throw err('missing ")"');
      p++;
      return e;
    }
    if (t.t !== 'word') throw err(`expected a column name, got "${t.t === 'op' ? t.v : t.t}"`);
    p++;
    const op = peek();
    // `status in (open, "on hold")`: any of the listed values.
    if (op?.t === 'word' && !op.quoted && /^in$/i.test(op.v)) {
      p++;
      if (peek()?.t !== 'lp') throw err(`expected "(" after "${t.v} in"`);
      p++;
      const values: string[] = [];
      for (;;) {
        const v = peek();
        if (v?.t !== 'word') throw err(`expected a value in "${t.v} in (...)"`);
        values.push(v.v);
        p++;
        const sep = peek();
        if (sep?.t === 'comma') { p++; continue; }
        if (sep?.t === 'rp') { p++; break; }
        throw err(`expected "," or ")" in "${t.v} in (...)"`);
      }
      return { type: 'cmp', column: t.v, op: 'in', value: values.join(', '), values };
    }
    if (op?.t !== 'op') throw err(`expected an operator (= != > < >= <= ~ ^= $= in) after "${t.v}"`);
    p++;
    const v = peek();
    if (v?.t !== 'word') throw err(`expected a value after "${t.v} ${op.v}"`);
    p++;
    return { type: 'cmp', column: t.v, op: op.v, value: v.v };
  };
  const tree = orExpr();
  if (p < toks.length) throw err(`unexpected "${(() => { const t = toks[p]; return t.t === 'word' || t.t === 'op' ? t.v : t.t; })()}"`);
  return tree;
}

/** Columns a filter refers to. */
export function rowFilterColumns(f: RowFilter): string[] {
  if (f.type === 'cmp') return [f.column];
  if (f.type === 'not') return rowFilterColumns(f.inner);
  return [...new Set([...rowFilterColumns(f.left), ...rowFilterColumns(f.right)])];
}

/** All comparisons in a filter (in order). */
export function rowFilterComparisons(f: RowFilter): Array<Extract<RowFilter, { type: 'cmp' }>> {
  if (f.type === 'cmp') return [f];
  if (f.type === 'not') return rowFilterComparisons(f.inner);
  return [...rowFilterComparisons(f.left), ...rowFilterComparisons(f.right)];
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Case-insensitive column lookup. */
export function rowValue(row: Record<string, unknown>, column: string): { found: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(row, column)) return { found: true, value: row[column] };
  const lc = column.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === lc);
  return key === undefined ? { found: false, value: undefined } : { found: true, value: row[key] };
}

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** Does a row satisfy the filter? `resolve` interpolates `${var}` in values. */
export function matchRow(f: RowFilter, row: Record<string, unknown>, resolve: (s: string) => string = (s) => s): boolean {
  switch (f.type) {
    case 'and': return matchRow(f.left, row, resolve) && matchRow(f.right, row, resolve);
    case 'or': return matchRow(f.left, row, resolve) || matchRow(f.right, row, resolve);
    case 'not': return !matchRow(f.inner, row, resolve);
    case 'cmp': {
      const { found, value } = rowValue(row, f.column);
      if (!found) return false;
      const a = cell(value);
      if (f.op === 'in') {
        const an = num(a);
        return (f.values ?? [f.value]).some((x) => {
          const b = resolve(x);
          const bn = num(b);
          return an !== undefined && bn !== undefined ? an === bn : a.toLowerCase() === b.toLowerCase();
        });
      }
      const b = resolve(f.value);
      const an = num(a);
      const bn = num(b);
      const numeric = an !== undefined && bn !== undefined;
      switch (f.op) {
        case '=': return numeric ? an === bn : a.toLowerCase() === b.toLowerCase();
        case '!=': return numeric ? an !== bn : a.toLowerCase() !== b.toLowerCase();
        case '~': return a.toLowerCase().includes(b.toLowerCase());
        case '^=': return a.toLowerCase().startsWith(b.toLowerCase());
        case '$=': return a.toLowerCase().endsWith(b.toLowerCase());
        case '>': return numeric ? an > bn : a > b;
        case '<': return numeric ? an < bn : a < b;
        case '>=': return numeric ? an >= bn : a >= b;
        case '<=': return numeric ? an <= bn : a <= b;
      }
    }
  }
  return false;
}

function valueText(v: string): string {
  return /^[^\s()=!<>~,"'`]+$/.test(v) && !/[\^$]=/.test(v) && !/^(?:and|or|not|in)$/i.test(v) ? v : quoteText(v);
}

/** Canonical text of a filter (parses back to the same tree). */
export function rowFilterToText(f: RowFilter, parent?: RowFilter['type']): string {
  switch (f.type) {
    case 'cmp': return f.op === 'in' ? `${valueText(f.column)} in (${(f.values ?? [f.value]).map(valueText).join(', ')})` : `${valueText(f.column)} ${f.op} ${valueText(f.value)}`;
    case 'not': return `not ${rowFilterToText(f.inner, 'not')}`;
    default: {
      const s = `${rowFilterToText(f.left, f.type)} ${f.type} ${rowFilterToText(f.right, f.type)}`;
      return (parent === 'and' && f.type === 'or') || parent === 'not' ? `(${s})` : s;
    }
  }
}

const EXAMPLES_FROM = /^(?:examples|scenarios|data\s+table)\s*:\s*from\s+(.+)$/i;

/** True when an .ez line is an `Examples: from ...` line. */
export function isExamplesFromLine(line: string): boolean {
  return EXAMPLES_FROM.test(line.trim());
}

/**
 * Parse an `Examples: from ...` line (or just the part after `from`).
 * Throws with a readable message on malformed input.
 */
export function parseExamplesSource(line: string): ExamplesSource {
  const t = line.trim();
  const m = EXAMPLES_FROM.exec(t);
  const body = m ? m[1] : t.replace(/^from\s+/i, '');
  const prot = protectQuotes(body);
  let text = prot.text;
  const quotes = prot.quotes;
  const Q = String.raw`⟦(\d+)⟧`;
  const unq = (i: string) => quotes[Number(i)] ?? '';
  const requote = (s: string) => s.replace(/⟦(\d+)⟧/g, (_x, i: string) => quoteText(unq(i))).trim();
  // "resolve with query ..." (live data per row) comes last.
  let resolveText: string | undefined;
  const rv = /\s+resolve\s+with\s+(?:the\s+)?query\s+/i.exec(text);
  if (rv) {
    resolveText = text.slice(rv.index + rv[0].length);
    text = text.slice(0, rv.index);
  }
  // Split off "where <filter>" (the filter keeps its own quotes), then derived columns ("with ref = unique(...)").
  const w = /\s+where\s+/i.exec(text);
  let head = w ? text.slice(0, w.index) : text;
  let where: string | undefined;
  let deriveText: string | undefined;
  if (w) {
    let filter = text.slice(w.index + w[0].length);
    const d = /\s+with\s+(?=[A-Za-z_][\w.-]*\s*=)/i.exec(filter);
    if (d) {
      deriveText = filter.slice(d.index + d[0].length);
      filter = filter.slice(0, d.index);
    }
    where = requote(filter);
    parseRowFilter(where); // validate now: errors carry the filter text
  }
  // In the head: a query's own "with" binds come first; a data file has none, so its "with" is derived columns.
  const withs = head.split(/\s+with\s+/i);
  head = withs[0];
  const isQuery = /^\s*query\s/i.test(head);
  const paramsText = isQuery && withs.length > 1 ? withs[1] : undefined;
  const headDerive = withs.slice(isQuery ? 2 : 1);
  if (headDerive.length > 1 || (headDerive.length && deriveText !== undefined)) throw new Error('Examples: give the derived columns once ("with name = expression, ...")');
  if (headDerive.length) deriveText = headDerive[0];
  const src: ExamplesSource = {};
  let rest = (paramsText !== undefined ? `${head} with ${paramsText}` : head).trim();
  let mm: RegExpExecArray | null;
  if ((mm = new RegExp(String.raw`^(?:data|file|data\s+file)\s+${Q}`, 'i').exec(rest))) {
    src.from = unq(mm[1]);
    rest = rest.slice(mm[0].length).trim();
  } else if ((mm = new RegExp(String.raw`^query\s+(?:${Q}|([\w.-]+))\s+(?:on|against|using)\s+([\w.-]+)`, 'i').exec(rest))) {
    src.query = mm[1] !== undefined ? unq(mm[1]) : mm[2];
    src.connection = mm[3];
    rest = rest.slice(mm[0].length).trim();
  } else {
    throw new Error(`Examples: expected 'from data "file"' or 'from query "NAME" on <connection>', got "from ${body}"`);
  }
  while (rest) {
    if ((mm = new RegExp(String.raw`^path\s+${Q}`, 'i').exec(rest))) src.path = unq(mm[1]);
    else if ((mm = new RegExp(String.raw`^sheet\s+${Q}`, 'i').exec(rest))) src.sheet = unq(mm[1]);
    else if (src.query && (mm = /^with\s+(.+)$/i.exec(rest))) {
      src.params = {};
      for (const part of mm[1].split(',')) {
        const kv = new RegExp(String.raw`^\s*([A-Za-z_][\w.-]*)\s*=\s*(?:${Q}|(\S+))\s*$`).exec(part);
        if (!kv) throw new Error(`Examples: expected name=value in "with", got "${part.trim()}"`);
        src.params[kv[1]] = kv[2] !== undefined ? unq(kv[2]) : kv[3];
      }
    } else throw new Error(`Examples: unexpected "${rest.replace(/⟦(\d+)⟧/g, (_x, i: string) => quoteText(unq(i)))}"`);
    rest = rest.slice(mm[0].length).trim();
  }
  if (src.path && !src.from) throw new Error('Examples: "path" applies to data files only');
  if (where !== undefined) src.where = where;
  if (deriveText !== undefined) src.derive = parseDerived(deriveText, requote, unq);
  if (resolveText !== undefined) src.resolve = parseResolve(resolveText, unq, requote);
  return src;
}

/** Split at commas outside parentheses and brackets (quoted text is already protected). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth <= 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** `ref = unique("VIS-"), due = addDays(today(), 14)` */
function parseDerived(text: string, requote: (s: string) => string, unqOf: (i: string) => string): Array<{ name: string; expr: string }> {
  const out: Array<{ name: string; expr: string }> = [];
  for (const part of splitTopLevel(text)) {
    const m = /^\s*([A-Za-z_][\w.-]*)\s*=\s*(.+?)\s*$/.exec(part);
    if (!m) throw new Error(`Examples: expected "name = expression" in "with", got "${requote(part)}"`);
    // Single quotes inside: the value lands in step text such as "<ref>", where a double quote would end the string.
    const expr = m[2].replace(/⟦(\d+)⟧/g, (_x, i: string) => `'${unqOf(i).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).trim();
    const problem = checkExpression(expr);
    if (problem) throw new Error(`Examples: derived column ${m[1]}: ${problem}`);
    out.push({ name: m[1], expr });
  }
  return out;
}

/** `"FIND_PET" on clinic with state=<requiredState> as pet when dataMode = live or keep row values` */
function parseResolve(text: string, unq: (i: string) => string, requote: (s: string) => string): NonNullable<ExamplesSource['resolve']> {
  const m = new RegExp(String.raw`^(?:⟦(\d+)⟧|([A-Za-z_][\w.-]*))(?:\s+(?:on|against|using)\s+([\w.-]+))?(?:\s+with\s+(.+?))?\s+as\s+([A-Za-z_]\w*)(?:\s+when\s+(.+?))?(\s+or\s+keep\s+(?:the\s+)?row(?:'s)?\s+values)?\s*$`, 'i').exec(text.trim());
  if (!m) throw new Error(`Examples: expected 'resolve with query "NAME" on <connection> [with name=value, ...] as <name> [when <filter>] [or keep row values]', got "resolve with query ${requote(text)}"`);
  const query = m[1] !== undefined ? unq(m[1]) : m[2];
  if (!/^[A-Za-z_][\w.-]*$/.test(query)) throw new Error(`Examples: resolve with query "${query}": not a catalogue query name`);
  const binds: Record<string, string> = {};
  for (const part of m[4] ? splitTopLevel(m[4]) : []) {
    const kv = /^\s*:?([A-Za-z_][\w.-]*)\s*=\s*(?:⟦(\d+)⟧|(\S+))\s*$/.exec(part);
    if (!kv) throw new Error(`Examples: expected name=value in "resolve with query ... with", got "${requote(part)}"`);
    binds[kv[1]] = kv[2] !== undefined ? unq(kv[2]) : kv[3];
  }
  const when = m[6] !== undefined ? requote(m[6]) : undefined;
  if (when !== undefined) parseRowFilter(when);
  return { query, ...(m[3] ? { connection: m[3] } : {}), binds, as: m[5], ...(when !== undefined ? { when } : {}), ...(m[7] ? { keepRowValues: true } : {}) };
}

/** Render a source as an `Examples: from ...` line. */
export function examplesSourceToText(src: ExamplesSource): string {
  const parts: string[] = ['Examples: from'];
  if (src.from !== undefined) parts.push('data', quoteText(src.from));
  else parts.push('query', quoteText(src.query ?? ''), 'on', src.connection ?? '');
  if (src.sheet) parts.push('sheet', quoteText(src.sheet));
  if (src.path) parts.push('path', quoteText(src.path));
  if (src.params && Object.keys(src.params).length) parts.push('with', Object.entries(src.params).map(([k, v]) => `${k}=${quoteText(v)}`).join(', '));
  if (src.where) parts.push('where', src.where);
  if (src.derive?.length) parts.push('with', src.derive.map((d) => `${d.name} = ${d.expr}`).join(', '));
  if (src.resolve) {
    const r = src.resolve;
    const binds = Object.entries(r.binds).map(([k, v]) => `${k}=${/^[^\s,"']+$/.test(v) ? v : quoteText(v)}`).join(', ');
    parts.push('resolve with query', quoteText(r.query), ...(r.connection ? ['on', r.connection] : []), ...(binds ? ['with', binds] : []), 'as', r.as, ...(r.when ? ['when', r.when] : []), ...(r.keepRowValues ? ['or keep row values'] : []));
  }
  return parts.join(' ');
}

/** Normalise a YAML/JSON `examples: { from|data|file, query, on|connection, with|params, path, sheet, where|filter }` object. */
export function examplesSourceFromObject(o: Record<string, unknown>): ExamplesSource {
  const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const src: ExamplesSource = {};
  const from = s(o.from ?? o.data ?? o.file ?? o.source);
  const query = s(o.query);
  if (from && query) throw new Error('examples: give either "from" (a data file) or "query", not both');
  if (from) src.from = from;
  else if (query) {
    src.query = query;
    const conn = s(o.on ?? o.connection);
    if (!conn) throw new Error('examples: a "query" needs "on: <connection>"');
    src.connection = conn;
    const params = o.with ?? o.params;
    if (params && typeof params === 'object') src.params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  } else throw new Error('examples: expected "from: <data file>" or "query: <name>"');
  if (o.path !== undefined) src.path = s(o.path);
  if (o.sheet !== undefined) src.sheet = s(o.sheet);
  const where = s(o.where ?? o.filter);
  if (where) {
    parseRowFilter(where);
    src.where = where;
  }
  return src;
}
