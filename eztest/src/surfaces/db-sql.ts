/**
 * SQL text helpers shared by the database clients, the `${var}` binder and the
 * named-query catalogue. Nothing here ever splices a value into SQL: the
 * scanner only finds where bind markers are, skipping string literals
 * ('..', Oracle q'[..]', E'..'), quoted identifiers ("..", [..], `..`),
 * comments (--, /* *\/), PostgreSQL casts (::) and PL/SQL assignments (:=).
 */

export type SqlDialect = 'sqlite' | 'postgres' | 'mssql' | 'oracle';

export type SqlToken =
  | { kind: 'named'; name: string; start: number; end: number }
  | { kind: 'positional'; start: number; end: number }
  | { kind: 'var'; name: string; start: number; end: number };

const Q_CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

/** End index (exclusive) of the quoted run starting at `i` (sql[i] is the opening quote). */
function skipQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

/**
 * Find bind markers in SQL. `:name` / `:1` are named markers, `?` is
 * positional, `${var}` (outside literals) is an EZ variable. With
 * `literals: 'vars'`, a quoted literal containing `${...}` is reported as one
 * `var` token spanning the whole literal (name = the literal's inner text).
 */
export function scanSql(sql: string, o: { named?: boolean; positional?: boolean; vars?: boolean; literalVars?: boolean } = {}): SqlToken[] {
  const named = o.named ?? true;
  const positional = o.positional ?? true;
  const vars = o.vars ?? false;
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    // comments
    if (c === '-' && n === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? sql.length : e;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    // Oracle alternative quoting: q'[ ... ]' (also Q, nq, NQ)
    if ((c === 'q' || c === 'Q') && n === "'" && !/[\w$#]/.test(sql[i - 1] ?? '')) {
      const open = sql[i + 2] ?? '';
      const close = Q_CLOSE[open] ?? open;
      const e = sql.indexOf(close + "'", i + 3);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    if (c === "'") {
      const end = skipQuoted(sql, i, "'");
      if (o.literalVars && sql.slice(i, end).includes('${')) {
        out.push({ kind: 'var', name: sql.slice(i + 1, end - 1).replace(/''/g, "'"), start: i, end });
      }
      i = end;
      continue;
    }
    if (c === '"' || c === '`') {
      i = skipQuoted(sql, i, c);
      continue;
    }
    if (c === '$' && n === '{') {
      const m = /^\$\{([A-Za-z_][\w.]*)\}/.exec(sql.slice(i));
      if (vars && m) {
        out.push({ kind: 'var', name: m[1], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (c === ':') {
      if (n === ':' ) {
        i += 2; // PostgreSQL cast
        continue;
      }
      if (n === '=') {
        i += 2; // PL/SQL assignment
        continue;
      }
      const prev = sql[i - 1] ?? '';
      const m = /^:([A-Za-z_][\w$#]*|\d+)/.exec(sql.slice(i));
      if (named && m && !/[\w$#:]/.test(prev)) {
        out.push({ kind: 'named', name: m[1], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (c === '?' && positional) {
      out.push({ kind: 'positional', start: i, end: i + 1 });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/** The placeholder for the n-th (1-based) bound value in a dialect. */
export function placeholder(dialect: SqlDialect, n: number): string {
  switch (dialect) {
    case 'postgres': return `$${n}`;
    case 'mssql': return `@p${n}`;
    case 'oracle': return `:${n}`;
    default: return '?';
  }
}

/** True for an Oracle PL/SQL block or a CREATE of a stored unit (these keep their trailing ";"). */
export function isPlsql(sql: string): boolean {
  const s = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  return /^(?:begin|declare)\b/i.test(s) || /^create\s+(?:or\s+replace\s+)?(?:editionable\s+|noneditionable\s+)?(?:procedure|function|package|trigger|type)\b/i.test(s);
}

/** Oracle rejects a trailing ";" (or SQL*Plus "/") on plain SQL; PL/SQL keeps its "END;". */
export function oracleStatement(sql: string): string {
  let s = sql.trim().replace(/\n\s*\/\s*$/, '').trim();
  if (!isPlsql(s)) s = s.replace(/;\s*$/, '');
  return s;
}

/**
 * Rewrite `:name` binds into the dialect's positional placeholders. Each
 * occurrence gets its own placeholder (Oracle binds arrays by position of
 * appearance, so a repeated name is bound once per occurrence everywhere).
 */
export function namedToPositional(sql: string, values: Record<string, unknown>, dialect: SqlDialect, startAt = 0): { sql: string; params: unknown[]; names: string[] } {
  const tokens = scanSql(sql, { named: true, positional: false });
  const params: unknown[] = [];
  const names: string[] = [];
  let text = '';
  let at = 0;
  let n = startAt;
  for (const t of tokens) {
    if (t.kind !== 'named') continue;
    if (!(t.name in values)) throw new Error(`no value for bind :${t.name}`);
    text += sql.slice(at, t.start) + placeholder(dialect, ++n);
    params.push(values[t.name]);
    names.push(t.name);
    at = t.end;
  }
  return { sql: text + sql.slice(at), params, names };
}
