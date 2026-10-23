/**
 * A small, safe SOQL parser + evaluator for the mock:
 *   SELECT a, b, Rel.c FROM Obj [WHERE cond (AND cond)*] [ORDER BY f [ASC|DESC]] [LIMIT n]
 *   cond: path (= | != | < | <= | > | >= | LIKE) literal | path [NOT] IN (literal, ...)
 * Literals: 'strings' with backslash escapes, numbers, true/false/null,
 * unquoted dates (YYYY-MM-DD) and datetimes. Anything else is MALFORMED_QUERY.
 * Nothing is ever evaluated as code.
 */
import type { MockField, MockObject, MockRecord, Value } from './model.js';

export class SoqlError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
  }
}

export type Literal =
  | { kind: 'string'; value: string; /** raw text with LIKE escapes preserved */ like: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'date'; value: string }
  | { kind: 'datetime'; value: string };

export type Op = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'IN' | 'NOT IN';

export interface Condition {
  path: string;
  op: Op;
  values: Literal[];
}

export interface SoqlAst {
  fields: string[];
  object: string;
  where: Condition[];
  orderBy?: { path: string; desc: boolean };
  limit?: number;
}

type Tok = { t: 'ident' | 'string' | 'number' | 'date' | 'datetime' | 'op' | 'punct'; v: string; like?: string; pos: number };

const ESCAPES: Record<string, string> = { "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const malformed = (msg: string) => new SoqlError('MALFORMED_QUERY', `${msg} at position ${i}`);
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "'") {
      let v = '';
      let like = '';
      i++;
      for (;;) {
        if (i >= q.length) throw malformed('unterminated string literal');
        const ch = q[i];
        if (ch === '\\') {
          const nx = q[i + 1];
          if (nx === '%' || nx === '_') {
            v += nx;
            like += '\\' + nx;
          } else if (nx !== undefined && ESCAPES[nx] !== undefined) {
            v += ESCAPES[nx];
            like += ESCAPES[nx];
          } else throw malformed(`invalid escape sequence \\${nx ?? ''}`);
          i += 2;
          continue;
        }
        if (ch === "'") {
          i++;
          break;
        }
        v += ch;
        like += ch;
        i++;
      }
      out.push({ t: 'string', v, like, pos: start });
      continue;
    }
    let m: RegExpExecArray | null;
    const rest = q.slice(i);
    if ((m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/.exec(rest))) {
      out.push({ t: 'datetime', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if ((m = /^\d{4}-\d{2}-\d{2}(?![\w:])/.exec(rest))) {
      out.push({ t: 'date', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if ((m = /^-?\d+(?:\.\d+)?(?![\w.])/.exec(rest))) {
      out.push({ t: 'number', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest))) {
      out.push({ t: 'ident', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if ((m = /^(?:!=|<=|>=|=|<|>)/.exec(rest))) {
      out.push({ t: 'op', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if (c === ',' || c === '(' || c === ')') {
      out.push({ t: 'punct', v: c, pos: start });
      i++;
      continue;
    }
    throw malformed(`unexpected character '${c}'`);
  }
  return out;
}

export function parseSoql(q: string): SoqlAst {
  if (!q || !q.trim()) throw new SoqlError('MALFORMED_QUERY', 'Empty query');
  const toks = tokenize(q);
  let p = 0;
  const peek = () => toks[p];
  const kw = (word: string) => peek()?.t === 'ident' && peek()!.v.toUpperCase() === word;
  const unexpected = () => new SoqlError('MALFORMED_QUERY', `unexpected token: '${peek()?.v ?? '<end>'}'`);
  const expectKw = (word: string) => {
    if (!kw(word)) throw unexpected();
    p++;
  };
  const ident = () => {
    const t = peek();
    if (t?.t !== 'ident') throw unexpected();
    p++;
    return t.v;
  };
  expectKw('SELECT');
  const fields = [ident()];
  while (peek()?.v === ',') {
    p++;
    fields.push(ident());
  }
  expectKw('FROM');
  const object = ident();
  if (object.includes('.')) throw new SoqlError('MALFORMED_QUERY', `unexpected token: '${object}'`);
  const where: Condition[] = [];
  const literal = (): Literal => {
    const t = peek();
    if (!t) throw unexpected();
    p++;
    switch (t.t) {
      case 'string': return { kind: 'string', value: t.v, like: t.like ?? t.v };
      case 'number': return { kind: 'number', value: Number(t.v) };
      case 'date': return { kind: 'date', value: t.v };
      case 'datetime': return { kind: 'datetime', value: t.v };
      case 'ident': {
        const u = t.v.toUpperCase();
        if (u === 'TRUE' || u === 'FALSE') return { kind: 'boolean', value: u === 'TRUE' };
        if (u === 'NULL') return { kind: 'null' };
        break;
      }
      default:
        break;
    }
    p--;
    throw unexpected();
  };
  if (kw('WHERE')) {
    p++;
    for (;;) {
      const path = ident();
      let op: Op;
      const t = peek();
      if (t?.t === 'op') {
        op = t.v as Op;
        p++;
      } else if (kw('LIKE')) {
        op = 'LIKE';
        p++;
      } else if (kw('IN')) {
        op = 'IN';
        p++;
      } else if (kw('NOT')) {
        p++;
        expectKw('IN');
        op = 'NOT IN';
      } else throw unexpected();
      let values: Literal[];
      if (op === 'IN' || op === 'NOT IN') {
        if (peek()?.v !== '(') throw unexpected();
        p++;
        values = [literal()];
        while (peek()?.v === ',') {
          p++;
          values.push(literal());
        }
        if (peek()?.v !== ')') throw unexpected();
        p++;
      } else values = [literal()];
      where.push({ path, op, values });
      if (kw('AND')) {
        p++;
        continue;
      }
      break;
    }
  }
  let orderBy: SoqlAst['orderBy'];
  if (kw('ORDER')) {
    p++;
    expectKw('BY');
    const path = ident();
    let desc = false;
    if (kw('ASC')) p++;
    else if (kw('DESC')) {
      p++;
      desc = true;
    }
    orderBy = { path, desc };
  }
  let limit: number | undefined;
  if (kw('LIMIT')) {
    p++;
    const t = peek();
    if (t?.t !== 'number' || !/^\d+$/.test(t.v)) throw unexpected();
    p++;
    limit = Number(t.v);
  }
  if (p < toks.length) throw unexpected();
  return { fields, object, where, orderBy, limit };
}

// ------------------------------------------------------------------ evaluation

export interface FieldView {
  obj: MockObject;
  /** Fields visible to the querying user. */
  visible: (obj: MockObject) => MockField[];
  objectByName: (name: string) => MockObject | undefined;
  /** Can the user see this object at all? */
  canRead: (obj: MockObject) => boolean;
  lookup: (obj: MockObject, id: string) => MockRecord | undefined;
}

interface ResolvedPath {
  field: MockField;
  /** For relationship paths: the reference field on the base object. */
  via?: MockField;
  target?: MockObject;
}

function resolvePath(v: FieldView, path: string): ResolvedPath {
  const parts = path.split('.');
  const noColumn = () => new SoqlError('INVALID_FIELD', `No such column '${path}' on entity '${v.obj.name}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.`);
  if (parts.length === 1) {
    const f = v.visible(v.obj).find((x) => x.name.toLowerCase() === path.toLowerCase());
    if (!f) throw noColumn();
    return { field: f };
  }
  if (parts.length !== 2) throw new SoqlError('MALFORMED_QUERY', `The mock supports one relationship level, got '${path}'`);
  const via = v.visible(v.obj).find((x) => x.type === 'reference' && x.relationshipName?.toLowerCase() === parts[0].toLowerCase());
  if (!via) throw new SoqlError('INVALID_FIELD', `Didn't understand relationship '${parts[0]}' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name.`);
  const target = v.objectByName(via.referenceTo![0]);
  if (!target || !v.canRead(target)) throw noColumn();
  const f = v.visible(target).find((x) => x.name.toLowerCase() === parts[1].toLowerCase());
  if (!f) throw new SoqlError('INVALID_FIELD', `No such column '${parts[1]}' on entity '${target.name}'.`);
  return { field: f, via, target };
}

function valueOf(v: FieldView, rec: MockRecord, r: ResolvedPath): Value {
  if (!r.via) return rec[r.field.name] ?? null;
  const id = rec[r.via.name];
  if (typeof id !== 'string') return null;
  const t = v.lookup(r.target!, id);
  return t ? t[r.field.name] ?? null : null;
}

const NUMERIC = new Set(['currency', 'double', 'int', 'percent']);
const TEXTUAL = new Set(['string', 'textarea', 'picklist', 'phone', 'email', 'url', 'id', 'reference']);

function checkLiteral(f: MockField, lit: Literal, op: Op): void {
  if (lit.kind === 'null') {
    if (op !== '=' && op !== '!=') throw new SoqlError('MALFORMED_QUERY', `null can only be compared with = or != (field ${f.name})`);
    return;
  }
  const bad = (want: string) =>
    new SoqlError('INVALID_FIELD', `value of filter criterion for field '${f.name}' must be of type ${want}${want === 'date' || want === 'dateTime' || want === 'double' || want === 'boolean' ? ' and should not be enclosed in quotes' : ''}`);
  if (f.type === 'date' && lit.kind !== 'date') throw bad('date');
  if (f.type === 'datetime' && lit.kind !== 'datetime') throw bad('dateTime');
  if (NUMERIC.has(f.type) && lit.kind !== 'number') throw bad('double');
  if (f.type === 'boolean' && lit.kind !== 'boolean') throw bad('boolean');
  if (TEXTUAL.has(f.type) && lit.kind !== 'string') throw bad('string');
  if (op === 'LIKE' && !TEXTUAL.has(f.type)) throw new SoqlError('INVALID_FIELD', `invalid operator on field '${f.name}': LIKE`);
}

function likeToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && (pattern[i + 1] === '%' || pattern[i + 1] === '_')) {
      re += pattern[i + 1];
      i++;
    } else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

function compare(actual: Value, op: Op, lit: Literal): boolean {
  if (lit.kind === 'null') return op === '=' ? actual === null : actual !== null;
  if (actual === null) return op === '!=' || op === 'NOT IN';
  const want = lit.kind === 'string' ? lit.value : (lit as { value: unknown }).value;
  if (op === 'LIKE') return lit.kind === 'string' && likeToRegex(lit.like).test(String(actual));
  let a: string | number | boolean = actual;
  let b = want as string | number | boolean;
  if (typeof a === 'string' && typeof b === 'string') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  switch (op) {
    case '=': case 'IN': return a === b;
    case '!=': case 'NOT IN': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

/** Run a parsed query against records; returns REST-shaped rows (without attributes urls). */
export function runSoql(ast: SoqlAst, v: FieldView, rows: MockRecord[], recordUrl: (obj: string, id: string) => string): Array<Record<string, unknown>> {
  const sel = ast.fields.map((p) => ({ path: p, r: resolvePath(v, p) }));
  const conds = ast.where.map((c) => {
    const r = resolvePath(v, c.path);
    for (const lit of c.values) checkLiteral(r.field, lit, c.op);
    return { ...c, r };
  });
  let out = rows.filter((rec) =>
    conds.every((c) => {
      const val = valueOf(v, rec, c.r);
      if (c.op === 'IN') return c.values.some((l) => compare(val, '=', l));
      if (c.op === 'NOT IN') return c.values.every((l) => compare(val, '!=', l));
      return compare(val, c.op, c.values[0]);
    }),
  );
  if (ast.orderBy) {
    const r = resolvePath(v, ast.orderBy.path);
    const dir = ast.orderBy.desc ? -1 : 1;
    out = [...out].sort((a, b) => {
      const x = valueOf(v, a, r);
      const y = valueOf(v, b, r);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }
  if (ast.limit !== undefined) out = out.slice(0, ast.limit);
  return out.map((rec) => {
    const row: Record<string, unknown> = { attributes: { type: v.obj.name, url: recordUrl(v.obj.name, String(rec.Id)) } };
    for (const s of sel) {
      if (!s.r.via) {
        row[s.r.field.name] = rec[s.r.field.name] ?? null;
        continue;
      }
      const rel = s.r.via.relationshipName!;
      const id = rec[s.r.via.name];
      const target = typeof id === 'string' ? v.lookup(s.r.target!, id) : undefined;
      if (!target) {
        row[rel] = null;
        continue;
      }
      const cur = (row[rel] as Record<string, unknown> | undefined) ?? { attributes: { type: s.r.target!.name, url: recordUrl(s.r.target!.name, String(target.Id)) } };
      cur[s.r.field.name] = target[s.r.field.name] ?? null;
      row[rel] = cur;
    }
    return row;
  });
}
