/**
 * Examples from a catalogue query: `Examples: from query "NAME" on <alias> [where a = "x" and b = 2]`.
 * Each result row becomes one Examples row (string values), so the journey runs
 * once per row. This is the DataSourceResolver for query sources; the
 * `Examples: from data ...` grammar and the engine hook call it.
 */
import { EzTestError } from '../core/index.js';
import type { DbClient } from '../surfaces/db.js';
import type { QueryCatalogue, QueryValue } from './catalogue.js';

export interface QueryExamplesContext {
  catalogue: QueryCatalogue;
  /** Opens a configured connection (e.g. `(n) => engine.dbs.get(n)`). */
  open(connection: string): Promise<DbClient>;
  /** Variables for `${var}` in where-values (e.g. config variables). */
  vars?: Record<string, unknown>;
  /** Column-name casing of the produced rows (default "as-is"; Oracle returns UPPER CASE unless quoted aliases are used). */
  keys?: 'as-is' | 'lower';
  /** Refuse more rows than this (default 10000). */
  maxRows?: number;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Run catalogue query `name` on connection `alias` (or the query's header
 * connection) with `params` bound as `:name` binds, and return Examples rows.
 */
export async function resolveQueryExamples(name: string, alias: string | undefined, params: Record<string, QueryValue>, ctx: QueryExamplesContext): Promise<Array<Record<string, string>>> {
  const q = ctx.catalogue.get(name);
  const connection = alias ?? q.connection;
  if (!connection) throw new EzTestError(`Examples from query "${name}": no connection (add "on <alias>" or a "-- connection:" header)`, 'EXAMPLES_SOURCE');
  const client = await ctx.open(connection);
  const vars = ctx.vars ?? {};
  const binds = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (w, n: string) => (n in vars ? String(vars[n]) : w)) : v]),
  );
  const compiled = ctx.catalogue.compile(name, { binds }, client.dialect);
  const rows = await client.query(compiled.sql, compiled.params as never);
  const max = ctx.maxRows ?? 10_000;
  if (rows.length > max) throw new EzTestError(`Examples from query "${name}" returned ${rows.length} rows (limit ${max}); narrow the query`, 'EXAMPLES_SOURCE');
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [ctx.keys === 'lower' ? k.toLowerCase() : k, cellText(v)])));
}

/**
 * Parse the source part of `Examples: from query "NAME" [on alias] [where a = "x" and b = 2]`
 * (everything after "Examples:"). Returns undefined when the text is not a query source.
 */
export function parseQueryExamplesSource(text: string): { name: string; alias?: string; params: Record<string, QueryValue> } | undefined {
  const m = /^\s*from\s+(?:the\s+)?query\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.-]*))(?:\s+on\s+([\w.-]+))?(?:\s+(?:where|with)\s+(.+?))?\s*$/i.exec(text);
  if (!m) return undefined;
  const params: Record<string, QueryValue> = {};
  if (m[5]) {
    const parts = m[5].match(/(?:[^,"']|"[^"]*"|'[^']*')+/g) ?? [];
    for (const raw of parts.flatMap((p) => p.split(/\s+and\s+(?=(?:[^"']|"[^"]*"|'[^']*')*$)/i))) {
      const kv = /^\s*:?([A-Za-z_]\w*)\s*(?:=|is)\s*(.+?)\s*$/i.exec(raw);
      if (!kv) throw new EzTestError(`Examples from query: cannot read "${raw.trim()}" (use name = "value")`, 'EXAMPLES_SOURCE');
      const v = kv[2];
      const quoted = /^"(.*)"$|^'(.*)'$/.exec(v);
      params[kv[1]] = quoted ? (quoted[1] ?? quoted[2]) : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : /^null$/i.test(v) ? null : /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : v;
    }
  }
  return { name: m[1] ?? m[2] ?? m[3], ...(m[4] ? { alias: m[4] } : {}), params };
}
