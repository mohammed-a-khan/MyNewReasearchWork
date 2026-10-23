/**
 * Named-query catalogue phrasings (db.queries) and stored procedures with OUT
 * parameters. A quoted query NAME (letters, digits, _ . -) selects the
 * catalogue; quoted SQL text falls through to the inline-SQL rules.
 *
 *   Run query "OPEN_INVOICES" on ledger with customer_id=${customerId}, status="OPEN" and store the rows as invoices
 *   Get the value of query "INVOICE_TOTAL" on ledger with invoice_no=${no} as total
 *   Expect query "OPEN_INVOICES" on ledger with customer_id=7 returns 2 rows
 *   Wait until query "INVOICE_POSTED" on ledger with invoice_no=${no} returns 1 row within 30 seconds
 *   Call procedure "billing.close_invoice" on ledger with params '[42]' and out status, total:number as closed
 *
 * Values: quoted -> text; bare numbers, true/false and null -> typed; `${var}`
 * -> the variable at run time (bound as a parameter, never spliced).
 */
import type { Condition, DbQuery, Step } from '../core/index.js';
import { literal, protectQuotes, quoteText } from './quotes.js';
import type { IntentRule, StepBody } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;
const CONN = String.raw`(?:\s+(?:on|against|in|using)\s+([\w.-]+))?`;
const DUR = String.raw`(\d+(?:\.\d+)?)\s*(ms|millis|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)`;
const NAME_RE = /^[A-Za-z_][\w.-]*$/;
const SINGLE = /^⟦(\d+)⟧$/;

type BindValue = string | number | boolean | null;

function ms(n: string, unit?: string): number {
  const v = Number(n);
  const u = (unit ?? 'ms').toLowerCase();
  if (/^(?:ms|millis|milliseconds?)$/.test(u)) return Math.round(v);
  if (/^(?:s|secs?|seconds?)$/.test(u)) return Math.round(v * 1000);
  return Math.round(v * 60_000);
}

/** The catalogue name in a quoted segment, or undefined when it is SQL text. */
function queryName(m: string, q: string[]): string | undefined {
  const v = literal(m, q).trim();
  return NAME_RE.test(v) && !/^(select|with|insert|update|delete|merge|begin|call|exec|commit|rollback|vacuum|analyze|checkpoint|show|values|table)$/i.test(v) ? v : undefined;
}

function bindValue(raw: string, q: string[]): BindValue {
  const t = raw.trim();
  if (SINGLE.test(t)) return literal(t, q);
  if (/^null$/i.test(t)) return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t)) return Number(t);
  return literal(t, q);
}

/** "with a=1, b=${x} and c="z"" or "with params '[1, 2]'" -> binds / positional params. */
export function parseQueryArgs(text: string | undefined, q: string[]): Pick<DbQuery, 'binds' | 'params'> {
  if (!text?.trim()) return {};
  const p = /^params?\s+(\S+)$/i.exec(text.trim());
  if (p) {
    const v: unknown = JSON.parse(literal(p[1], q));
    if (!Array.isArray(v)) throw new Error('Query params must be a JSON array');
    return { params: v as BindValue[] };
  }
  const binds: Record<string, BindValue> = {};
  for (const part of text.split(/\s*(?:,|\band\b)\s*/i)) {
    if (!part.trim()) continue;
    const m = /^:?([A-Za-z_]\w*)\s*(?:=|:|is)\s*(.+)$/i.exec(part.trim());
    if (!m) throw new Error(`Expected name=value for a query param, got "${part.trim()}"`);
    binds[m[1]] = bindValue(m[2], q);
  }
  return { binds };
}

function ledgerKey(name: string): string {
  return `query_${name.replace(/\W/g, '_')}`;
}

function countCondition(key: string, kind: string | undefined, n: number): Condition {
  const k = (kind ?? '').trim().toLowerCase();
  if (k.startsWith('at least')) return { type: 'expr', expr: `len(${key}) >= ${n}` };
  if (k.startsWith('at most')) return { type: 'expr', expr: `len(${key}) <= ${n}` };
  return { type: 'dbRowCount', captureKey: key, equals: n };
}

/** "2 rows" / "at least 1 row" / "no rows" / "rows" -> [qualifier, n]. */
const COUNT = String.raw`(?:(at\s+least\s+|at\s+most\s+|exactly\s+)?(\d+)\s+rows?|(no)\s+rows|a\s+row|any\s+rows|rows)`;

function counted(m: RegExpExecArray, i: number): { kind?: string; n: number } {
  if (m[i + 2]) return { kind: 'exactly', n: 0 };
  if (m[i + 1] !== undefined) return { kind: m[i] ?? 'exactly', n: Number(m[i + 1]) };
  return { kind: 'at least', n: 1 };
}

function db(name: string, connection: string | undefined, args: Pick<DbQuery, 'binds' | 'params'>, capture?: DbQuery['capture']): DbQuery {
  return { connection: connection ?? '', sql: '', query: name, ...args, ...(capture && capture !== 'rows' ? { capture } : {}) };
}

function category(rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category: 'Database' }));
}

export const QUERY_RULES: IntentRule[] = category([
  { name: 'named-query-expect', keywords: ['expect', 'verify', 'assert'], example: 'Expect query "OPEN_INVOICES" on ledger with customer_id=7 returns 2 rows',
    re: new RegExp(String.raw`^(?:expect|verify|assert|ensure|confirm|check\s+that)\s+(?:that\s+)?(?:the\s+)?(?:named\s+)?query\s+(${Q})${CONN}(?:\s+with\s+(.+?))?\s+returns?\s+${COUNT}$`, 'i'),
    build: (m, q): StepBody | undefined => {
      const name = queryName(m[1], q);
      if (!name) return undefined;
      const key = ledgerKey(name);
      const c = counted(m, 4);
      return { action: 'db', db: db(name, m[2], parseQueryArgs(m[3], q)), captureAs: key, postconditions: [countCondition(key, c.kind, c.n)] };
    } },
  { name: 'named-query-wait', keywords: ['wait', 'poll'], example: 'Wait until query "INVOICE_POSTED" on ledger with invoice_no=${no} returns 1 row within 30 seconds',
    re: new RegExp(String.raw`^(?:wait|poll)\s+until\s+(?:the\s+)?(?:named\s+)?query\s+(${Q})${CONN}(?:\s+with\s+(.+?))?\s+returns?\s+${COUNT}(?:\s+(?:within|for\s+up\s+to)\s+${DUR})?(?:\s+(?:checking\s+)?every\s+${DUR})?(?:\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const name = queryName(m[1], q);
      if (!name) return undefined;
      const key = m[11] ?? ledgerKey(name);
      const c = counted(m, 4);
      const within = m[7] ? ms(m[7], m[8]) : 30_000;
      const every = m[9] ? ms(m[9], m[10]) : 1000;
      return { action: 'db', db: db(name, m[2], parseQueryArgs(m[3], q)), captureAs: key, postconditions: [countCondition(key, c.kind, c.n)], poll: { attempts: Math.max(1, Math.ceil(within / every)), intervalMs: every } };
    } },
  { name: 'named-query-get', keywords: ['get', 'fetch', 'count'], example: 'Get the value of query "INVOICE_TOTAL" on ledger with invoice_no=${no} as total',
    re: new RegExp(String.raw`^(?:get|fetch|read|capture)\s+the\s+(value|first\s+row|row|rows|row\s+count|number\s+of\s+rows)\s+(?:of|from)\s+(?:the\s+)?(?:named\s+)?query\s+(${Q})${CONN}(?:\s+with\s+(.+?))?\s+as\s+${KEY}$`, 'i'),
    build: (m, q) => {
      const name = queryName(m[2], q);
      if (!name) return undefined;
      const what = m[1].toLowerCase();
      const capture = what === 'value' ? 'cell' : /count|number/.test(what) ? 'count' : what === 'rows' ? 'rows' : 'row';
      return { action: 'db', db: db(name, m[3], parseQueryArgs(m[4], q), capture), captureAs: m[5] };
    } },
  { name: 'named-query-run', keywords: ['run', 'execute'], example: 'Run query "OPEN_INVOICES" on ledger with customer_id=${customerId} and store the rows as invoices',
    re: new RegExp(String.raw`^(?:run|execute)\s+(?:the\s+)?(?:named\s+)?query\s+(${Q})${CONN}(?:\s+with\s+(.+?))?(?:\s+(?:and\s+)?(?:store|save|keep)\s+(?:it\s+|them\s+|the\s+(?:rows|result|results)\s+)?as\s+${KEY}|\s+as\s+${KEY})?$`, 'i'),
    build: (m, q) => {
      const name = queryName(m[1], q);
      if (!name) return undefined;
      return { action: 'db', db: db(name, m[2], parseQueryArgs(m[3], q)), captureAs: m[4] ?? m[5] ?? 'rows' };
    } },
  { name: 'call-procedure-out', keywords: ['call', 'execute', 'exec'], example: 'Call procedure "billing.close_invoice" on ledger with params \'[42]\' and out status, total:number as closed',
    re: new RegExp(String.raw`^(?:call|execute|run|exec)\s+(?:the\s+)?(?:stored\s+)?procedure\s+(${Q}|[\w.]+)\s+(?:on|against|in|using)\s+([\w.-]+)(?:\s+with\s+params?\s+(\S+))?\s+(?:and\s+)?(?:with\s+)?out(?:put)?\s+(?:params?\s+|parameters?\s+)?(.+?)\s+(?:and\s+(?:store\s+(?:them\s+)?)?)?as\s+${KEY}$`, 'i'),
    build: (m, q) => {
      const params = m[3] ? (JSON.parse(literal(m[3], q)) as unknown) : [];
      if (!Array.isArray(params)) throw new Error('Procedure params must be a JSON array');
      const out = m[4].split(/\s*(?:,|\band\b)\s*/i).filter(Boolean).map((p) => {
        const o = /^([A-Za-z_]\w*)(?:\s*:\s*(string|number|date|clob|cursor|boolean))?$/i.exec(p.trim());
        if (!o) throw new Error(`Expected an OUT parameter like "total:number", got "${p}"`);
        return { name: o[1], type: (o[2]?.toLowerCase() ?? 'string') as NonNullable<DbQuery['out']>[number]['type'] };
      });
      return { action: 'db', db: { connection: m[2], sql: '', procedure: literal(m[1], q), params: params as BindValue[], out }, captureAs: m[5] };
    } },
]);

function renderValue(v: BindValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (/^\$\{[A-Za-z_][\w.]*\}$/.test(v)) return v;
  return quoteText(v);
}

/** Canonical .ez line for a catalogue-query or OUT-param procedure step (undefined for other db steps). */
export function queryStepToText(s: Pick<Step, 'db' | 'captureAs'>): string | undefined {
  const d = s.db;
  if (!d) return undefined;
  if (d.procedure && d.out?.length) {
    const params = d.params?.length ? ` with params ${quoteText(JSON.stringify(d.params))}` : '';
    const out = d.out.map((o) => (o.type && o.type !== 'string' ? `${o.name}:${o.type}` : o.name)).join(', ');
    return `Call procedure ${quoteText(d.procedure)} on ${d.connection}${params} and out ${out} as ${s.captureAs ?? 'out'}`;
  }
  if (!d.query) return undefined;
  const on = d.connection ? ` on ${d.connection}` : '';
  const args = d.params?.length
    ? ` with params ${quoteText(JSON.stringify(d.params))}`
    : d.binds && Object.keys(d.binds).length
      ? ` with ${Object.entries(d.binds).map(([k, v]) => `${k}=${renderValue(v)}`).join(', ')}`
      : '';
  const key = s.captureAs ?? 'rows';
  if (d.capture && d.capture !== 'rows') {
    const what = d.capture === 'cell' ? 'value' : d.capture === 'count' ? 'row count' : 'first row';
    return `Get the ${what} of query ${quoteText(d.query)}${on}${args} as ${key}`;
  }
  return `Run query ${quoteText(d.query)}${on}${args} and store the rows as ${key}`;
}

/**
 * YAML/JSON sugar for catalogue queries, as the equivalent .ez line:
 *   - query: OPEN_INVOICES        - query: INVOICE_TOTAL       - query: OPEN_INVOICES
 *     on: ledger                    with: { invoice_no: 7 }      with: { customer_id: 7 }
 *     with: { customer_id: 7 }      capture: value               returns: 2            (or "at least 1")
 *     as: invoices                  as: total                    within: 30 seconds    (waits until it does)
 */
export function querySugarIntent(s: Record<string, unknown>): string | undefined {
  const name = s.query;
  if (typeof name !== 'string' || s.action !== undefined || !NAME_RE.test(name)) return undefined;
  const on = typeof s.on === 'string' && s.on ? ` on ${s.on}` : '';
  const w = Array.isArray(s.with)
    ? `params ${quoteText(JSON.stringify(s.with))}`
    : s.with && typeof s.with === 'object'
      ? Object.entries(s.with as Record<string, unknown>).map(([k, v]) => `${k}=${renderValue(v === undefined ? null : (v as BindValue))}`).join(', ')
      : '';
  const args = w ? ` with ${w}` : '';
  const as = typeof s.as === 'string' ? s.as : undefined;
  if (s.returns !== undefined) {
    const r = String(s.returns).trim();
    const count = /rows?$/i.test(r) ? r : `${r} rows`;
    if (s.within !== undefined) return `Wait until query ${quoteText(name)}${on}${args} returns ${count} within ${String(s.within)}${as ? ` as ${as}` : ''}`;
    return `Expect query ${quoteText(name)}${on}${args} returns ${count}`;
  }
  const cap = typeof s.capture === 'string' ? s.capture.toLowerCase() : 'rows';
  if (cap !== 'rows') {
    const what = cap === 'value' || cap === 'cell' ? 'value' : cap === 'count' ? 'row count' : 'first row';
    return `Get the ${what} of query ${quoteText(name)}${on}${args} as ${as ?? 'value'}`;
  }
  return `Run query ${quoteText(name)}${on}${args} and store the rows as ${as ?? 'rows'}`;
}

/**
 * True for "Expect query "NAME" ... returns N rows" with a catalogue NAME: in
 * .ez files such a line is a step of its own (it runs the query), not a
 * post-condition of the previous step.
 */
export function isNamedQueryExpectation(line: string): boolean {
  const { text, quotes } = protectQuotes(line.trim().replace(/[.;]+$/, ''));
  const rule = QUERY_RULES.find((r) => r.name === 'named-query-expect')!;
  const m = rule.re.exec(text.replace(/^(?:and|then|but|also)\s+/i, ''));
  if (!m) return false;
  try {
    return !!rule.build(m, quotes);
  } catch {
    return false;
  }
}
