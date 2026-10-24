/**
 * Named-query catalogue. Each query lives in its own `NAME.sql` file under
 * `db.queries.dir` (or a listed file), or in `db.queries.inline`. A file may
 * start with a header of `--` comments:
 *
 *   -- connection: ledger
 *   -- description: Open invoices of a customer, newest first
 *   -- params: customer_id, status = 'OPEN', limit:number = 10
 *   SELECT invoice_no, amount FROM invoices
 *    WHERE customer_id = :customer_id AND status = :status
 *    {{> not_archived}}
 *    FETCH FIRST :limit ROWS ONLY
 *
 * Rules (no SQL splicing, ever):
 *   - Values only reach the database as bind parameters: `:name` (named) or `?`
 *     (positional), rewritten into each dialect's placeholders.
 *   - `{{> other}}` includes another catalogue entry's SQL as text. Includes
 *     come from catalogue files only and are resolved when the catalogue is
 *     compiled, never from runtime values.
 *   - `${var}` and any other `{{...}}` in catalogue SQL are rejected.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import { scanSql, placeholder, type SqlDialect } from '../surfaces/db-sql.js';

export type QueryValue = string | number | boolean | null | Date;
export type QueryParamType = 'string' | 'number' | 'boolean' | 'date' | 'any';

export interface QueryParamSpec {
  name: string;
  type: QueryParamType;
  /** Present when the param is optional. */
  default?: QueryValue;
}

export interface CatalogueQuery {
  name: string;
  /** The SQL text without the header (includes not yet expanded). */
  sql: string;
  connection?: string;
  description?: string;
  /** Declared params (header), or undefined when the header declares none. */
  declared?: QueryParamSpec[];
  /** Only meant to be included by other queries (header "-- fragment: true" or a file under fragments/). */
  fragment: boolean;
  /** Source file relative to the project, or "inline". */
  source: string;
}

export class QueryCatalogueError extends EzTestError {
  constructor(message: string, code = 'QUERY_CATALOGUE', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'QueryCatalogueError';
  }
}

const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const INCLUDE_RE = /\{\{>\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function parseLiteral(raw: string): QueryValue {
  const v = raw.trim();
  if (/^null$/i.test(v)) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const q = /^'(.*)'$|^"(.*)"$/.exec(v);
  return q ? (q[1] ?? q[2]) : v;
}

/** "a, b:number = 2, c = 'x'" -> param specs. */
export function parseParamList(text: string, where: string): QueryParamSpec[] {
  const out: QueryParamSpec[] = [];
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^:?([A-Za-z_]\w*)\s*(?::\s*(string|text|number|int|integer|decimal|boolean|bool|date|any))?\s*(?:=\s*(.+))?$/i.exec(part);
    if (!m) throw new QueryCatalogueError(`${where}: cannot read param "${part}" (use name, name:number or name = default)`, 'QUERY_HEADER');
    const t = (m[2] ?? 'any').toLowerCase();
    const type: QueryParamType = /^(number|int|integer|decimal)$/.test(t) ? 'number' : /^(bool|boolean)$/.test(t) ? 'boolean' : t === 'date' ? 'date' : /^(string|text)$/.test(t) ? 'string' : 'any';
    out.push({ name: m[1], type, ...(m[3] !== undefined ? { default: parseLiteral(m[3]) } : {}) });
  }
  return out;
}

/** Split a .sql file into its header fields and body. */
export function parseQueryFile(text: string, name: string, source: string): CatalogueQuery {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const q: CatalogueQuery = { name, sql: '', fragment: /(^|[\\/])fragments[\\/]/.test(source), source };
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (!l.startsWith('--')) break;
    const m = /^--\s*([A-Za-z][\w ]*?)\s*:\s*(.*)$/.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'name') {
      if (value && value !== name) throw new QueryCatalogueError(`${source}: header name "${value}" differs from the file name "${name}"`, 'QUERY_HEADER');
    } else if (key === 'connection' || key === 'conn' || key === 'on') q.connection = value;
    else if (key === 'description' || key === 'desc') q.description = value;
    else if (key === 'params' || key === 'param' || key === 'parameters') q.declared = [...(q.declared ?? []), ...parseParamList(value, source)];
    else if (key === 'fragment') q.fragment = /^(true|yes|1)$/i.test(value);
  }
  q.sql = lines.slice(i).join('\n').trim();
  return q;
}

export interface CatalogueOptions {
  cwd: string;
  dir?: string;
  files?: string[];
  inline?: Record<string, string>;
  /**
   * The configured connections (`db.connections`): queries on a MySQL/MariaDB connection are read with MySQL's
   * string rules (a backslash escapes the next character, so 'it\'s :x' holds no bind).
   */
  connections?: Record<string, { driver?: string }>;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && extname(e.name).toLowerCase() === '.sql') out.push(p);
  }
  return out.sort();
}

export interface CompiledQuery {
  name: string;
  connection?: string;
  /** SQL in the dialect's placeholder style. */
  sql: string;
  params: Array<string | number | boolean | null | Date>;
  /** The expanded SQL with `:name` markers (for display). */
  text: string;
}

export interface QueryCall {
  /** Named values for `:name` binds. */
  binds?: Record<string, QueryValue>;
  /** Positional values for `?` binds. */
  params?: QueryValue[];
}

export class QueryCatalogue {
  private readonly byName = new Map<string, CatalogueQuery>();
  /** Connections whose SQL follows MySQL's string rules (backslash escapes). */
  private mysqlConnections = new Set<string>();
  private allMysql = false;

  constructor(queries: CatalogueQuery[] = []) {
    for (const q of queries) this.add(q);
  }

  /** Load from `dir` (recursively, *.sql), `files` and `inline`. A missing default dir is an empty catalogue. */
  static async load(o: CatalogueOptions): Promise<QueryCatalogue> {
    const cat = new QueryCatalogue();
    const conns = Object.entries(o.connections ?? {});
    cat.mysqlConnections = new Set(conns.filter(([, c]) => c?.driver === 'mysql').map(([n]) => n));
    cat.allMysql = conns.length > 0 && cat.mysqlConnections.size === conns.length;
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(o.cwd, p));
    const rel = (p: string) => relative(o.cwd, p).split('\\').join('/');
    const files: string[] = [];
    const dir = abs(o.dir ?? 'queries');
    if (o.files?.length) {
      for (const f of o.files) {
        const candidates = [abs(f), resolve(dir, f)];
        const hit = candidates.find((c) => existsSync(c));
        if (!hit) throw new QueryCatalogueError(`db.queries.files: "${f}" not found`, 'QUERY_FILE_MISSING');
        if (statSync(hit).isDirectory()) files.push(...walk(hit));
        else files.push(hit);
      }
    } else if (existsSync(dir) && statSync(dir).isDirectory()) files.push(...walk(dir));
    for (const f of files) {
      const name = basename(f, extname(f));
      if (!NAME_RE.test(name)) throw new QueryCatalogueError(`${rel(f)}: query file names must be letters, digits, "_", "." or "-"`, 'QUERY_NAME');
      cat.add(parseQueryFile(await readFile(f, 'utf8'), name, rel(f)));
    }
    for (const [name, sql] of Object.entries(o.inline ?? {})) cat.add(parseQueryFile(sql, name, 'inline'));
    cat.verify();
    return cat;
  }

  /** From config `db.queries` (dir relative to cwd) and `db.connections`. */
  static fromConfig(queries: { dir?: string; files?: string[]; inline?: Record<string, string> } | undefined, cwd: string, connections?: Record<string, { driver?: string }>): Promise<QueryCatalogue> {
    return QueryCatalogue.load({ cwd, dir: queries?.dir, files: queries?.files, inline: queries?.inline, connections });
  }

  /** True when a query's SQL is read with MySQL's backslash escapes (its connection, or every connection, is MySQL). */
  private backslashes(name: string): boolean {
    const c = this.byName.get(name)?.connection;
    return c ? this.mysqlConnections.has(c) : this.allMysql;
  }

  add(q: CatalogueQuery): void {
    if (!NAME_RE.test(q.name)) throw new QueryCatalogueError(`Invalid query name "${q.name}"`, 'QUERY_NAME');
    const prev = this.byName.get(q.name);
    if (prev) throw new QueryCatalogueError(`Query "${q.name}" is defined twice (${prev.source} and ${q.source})`, 'QUERY_DUPLICATE');
    if (!q.sql.trim()) throw new QueryCatalogueError(`${q.source}: query "${q.name}" has no SQL`, 'QUERY_EMPTY');
    if (q.sql.includes('${')) {
      throw new QueryCatalogueError(`${q.source}: query "${q.name}" uses \${...}; catalogue SQL is bind-parameter only. Use :name binds and pass values with "with name=\${var}".`, 'QUERY_SPLICE');
    }
    const stray = /\{\{(?!>\s*[A-Za-z_][\w.-]*\s*\}\})[^}]*\}\}/.exec(q.sql);
    if (stray) {
      throw new QueryCatalogueError(`${q.source}: query "${q.name}" has text substitution "${stray[0]}"; only {{> fragment}} includes of catalogue files are allowed. Pass values as :binds.`, 'QUERY_SPLICE');
    }
    this.byName.set(q.name, q);
  }

  names(o: { fragments?: boolean } = {}): string[] {
    return [...this.byName.values()].filter((q) => o.fragments || !q.fragment).map((q) => q.name).sort();
  }

  all(): CatalogueQuery[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): CatalogueQuery {
    const q = this.byName.get(name);
    if (!q) {
      const near = this.names({ fragments: true }).filter((n) => n.toLowerCase() === name.toLowerCase() || n.toLowerCase().includes(name.toLowerCase())).slice(0, 5);
      throw new QueryCatalogueError(`Unknown query "${name}"${near.length ? `. Did you mean: ${near.join(', ')}?` : this.byName.size ? '' : ' (the query catalogue is empty: add queries/NAME.sql or db.queries.inline)'}`, 'QUERY_UNKNOWN', { name });
    }
    return q;
  }

  /** The SQL with every {{> include}} expanded (recursively; cycles are an error). */
  expand(name: string, stack: string[] = []): string {
    if (stack.includes(name)) throw new QueryCatalogueError(`Include cycle: ${[...stack, name].join(' -> ')}`, 'QUERY_INCLUDE_CYCLE');
    if (stack.length > 20) throw new QueryCatalogueError(`Includes nested too deeply in "${stack[0]}"`, 'QUERY_INCLUDE_DEPTH');
    const q = this.get(name);
    return q.sql.replace(INCLUDE_RE, (_w, inc: string) => {
      if (!this.byName.has(inc)) throw new QueryCatalogueError(`${q.source}: "${name}" includes unknown fragment "${inc}"`, 'QUERY_INCLUDE_UNKNOWN');
      return this.expand(inc, [...stack, name]).replace(/;\s*$/, '');
    });
  }

  /** Bind names used by a query (after includes), in order of first use, plus the number of `?` markers. */
  bindsOf(name: string): { named: string[]; positional: number } {
    const sql = this.expand(name);
    const named: string[] = [];
    let positional = 0;
    for (const t of scanSql(sql, { named: true, positional: true, backslashEscapes: this.backslashes(name) })) {
      if (t.kind === 'named' && !named.includes(t.name)) named.push(t.name);
      if (t.kind === 'positional') positional++;
    }
    return { named, positional };
  }

  /** The params a query takes: declared ones (header) or the binds it uses. */
  paramsOf(name: string): QueryParamSpec[] {
    const q = this.get(name);
    const used = this.bindsOf(name).named;
    if (q.declared) return q.declared;
    return used.map((n) => ({ name: n, type: 'any' as const }));
  }

  /** Static problems of one query (unknown includes, cycles, undeclared or unused params, mixed bind styles). */
  problemsOf(name: string): string[] {
    const out: string[] = [];
    const q = this.get(name);
    let b: { named: string[]; positional: number };
    try {
      b = this.bindsOf(name);
    } catch (e) {
      return [(e as Error).message];
    }
    if (b.named.length && b.positional) out.push(`${q.source}: "${name}" mixes :name and ? binds; use one style`);
    if (b.named.some((n) => /^\d+$/.test(n))) out.push(`${q.source}: "${name}" uses numbered binds (:1); use :name or ?`);
    if (q.declared) {
      const declared = new Set(q.declared.map((p) => p.name.toLowerCase()));
      for (const n of b.named) if (!declared.has(n.toLowerCase())) out.push(`${q.source}: "${name}" uses :${n} but the header does not declare it`);
      for (const p of q.declared) if (!b.named.some((n) => n.toLowerCase() === p.name.toLowerCase())) out.push(`${q.source}: "${name}" declares param "${p.name}" but never uses :${p.name}`);
    }
    return out;
  }

  /**
   * Structural check run on load: every include resolves and no include cycles.
   * Param problems (undeclared or unused binds, mixed styles) are reported per
   * query by problemsOf(), `eztest queries check`, `eztest validate` and when the
   * query is run, so one broken query never hides the others.
   */
  verify(): void {
    const problems: string[] = [];
    for (const n of this.names({ fragments: true })) {
      try {
        this.expand(n);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (problems.length) throw new QueryCatalogueError(`Query catalogue problems:\n  - ${[...new Set(problems)].join('\n  - ')}`, 'QUERY_CATALOGUE', { problems });
  }

  /**
   * Problems with a call (for `eztest validate`): unknown query, missing
   * required params, unknown param names, wrong positional count.
   */
  checkCall(name: string, supplied: string[], positional = 0): string[] {
    if (!this.has(name)) {
      try {
        this.get(name);
      } catch (e) {
        return [(e as Error).message];
      }
    }
    const out: string[] = [...this.problemsOf(name)];
    if (out.length) return out;
    const q = this.get(name);
    if (q.fragment) out.push(`"${name}" is a fragment (include it with {{> ${name}}}); it cannot be run on its own`);
    const b = this.bindsOf(name);
    const specs = this.paramsOf(name);
    const lower = new Set(supplied.map((s) => s.toLowerCase()));
    for (const p of specs) if (p.default === undefined && !lower.has(p.name.toLowerCase())) out.push(`query "${name}" needs param "${p.name}"`);
    for (const s of supplied) if (!specs.some((p) => p.name.toLowerCase() === s.toLowerCase())) out.push(`query "${name}" has no param "${s}" (params: ${specs.map((p) => p.name).join(', ') || 'none'})`);
    if (b.positional !== positional && (b.positional || positional)) out.push(`query "${name}" has ${b.positional} ? marker(s) but ${positional} positional value(s) were given`);
    return out;
  }

  /**
   * Compile a call into dialect SQL and bound values. Values are never placed in the SQL text.
   * `lenient` (used by `queries check`) binds NULL for missing values instead of failing.
   */
  compile(name: string, call: QueryCall, dialect: SqlDialect, o: { lenient?: boolean } = {}): CompiledQuery {
    const q = this.get(name);
    const problems = o.lenient ? [] : this.checkCall(name, Object.keys(call.binds ?? {}), call.params?.length ?? 0);
    if (problems.length) throw new QueryCatalogueError(problems.join('; '), 'QUERY_PARAMS', { name });
    const text = this.expand(name);
    const specs = this.paramsOf(name);
    const given = new Map(Object.entries(call.binds ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const valueOf = (bind: string): QueryValue => {
      const spec = specs.find((p) => p.name.toLowerCase() === bind.toLowerCase());
      const v = given.has(bind.toLowerCase()) ? given.get(bind.toLowerCase())! : spec?.default;
      if (v === undefined && o.lenient) return null;
      if (v === undefined) throw new QueryCatalogueError(`query "${name}" needs param "${bind}"`, 'QUERY_PARAMS');
      return coerce(v, spec?.type ?? 'any', `${name}.${bind}`);
    };
    const params: CompiledQuery['params'] = [];
    let sql = '';
    let at = 0;
    let n = 0;
    let pos = 0;
    for (const t of scanSql(text, { named: true, positional: true, backslashEscapes: dialect === 'mysql' })) {
      if (t.kind === 'var') continue;
      sql += text.slice(at, t.start) + placeholder(dialect, ++n);
      params.push(t.kind === 'named' ? valueOf(t.name) : coerce(call.params?.[pos++] ?? null, 'any', `${name}[${pos}]`));
      at = t.end;
    }
    sql += text.slice(at);
    return { name, connection: q.connection, sql, params, text };
  }
}

function coerce(v: QueryValue, type: QueryParamType, where: string): string | number | boolean | null | Date {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'number': {
      if (typeof v === 'number') return v;
      const n = Number(String(v).trim());
      if (String(v).trim() === '' || !Number.isFinite(n)) throw new QueryCatalogueError(`${where} must be a number, got "${String(v)}"`, 'QUERY_PARAM_TYPE');
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (/^(true|yes|1)$/i.test(String(v))) return true;
      if (/^(false|no|0)$/i.test(String(v))) return false;
      throw new QueryCatalogueError(`${where} must be true or false, got "${String(v)}"`, 'QUERY_PARAM_TYPE');
    case 'date': {
      if (v instanceof Date) return v;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) throw new QueryCatalogueError(`${where} must be a date, got "${String(v)}"`, 'QUERY_PARAM_TYPE');
      return d;
    }
    case 'string':
      return v instanceof Date ? v.toISOString() : String(v);
    default:
      return v;
  }
}
