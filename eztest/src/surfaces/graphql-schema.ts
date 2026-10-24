/**
 * GraphQL documents checked against a server's schema, written from the
 * GraphQL specification (October 2021): a lexer and parser for executable
 * documents, the introspection query, and the validation rules a test author
 * trips over:
 *
 *   operations     unique names, a lone anonymous operation, a schema root for
 *                  the operation type, one root field per subscription
 *   fields         defined on the type (unions: only __typename), leaf
 *                  fields without selections, object fields with them
 *   arguments      known, not repeated, required ones given, literal values
 *                  of the right kind (Int range, enum values, input fields)
 *   fragments      unique, known, used, on composite types that exist, able
 *                  to apply where spread, no cycles
 *   variables      unique, of input types that exist, all used ones defined,
 *                  all defined ones used, nullable ones not passed where a
 *                  value is required (unless they have a default)
 *   directives     known, in an allowed place, required arguments given
 *
 * Errors carry line:column locations like a GraphQL server's.
 */
import { EzTestError } from '../core/index.js';

// ------------------------------------------------------------------ lexer

type TokKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
interface Tok { kind: TokKind; value: string; start: number; line: number; col: number }

export interface GqlLocation { line: number; column: number }
export interface GqlError { message: string; locations: GqlLocation[] }

export class GraphQLSyntaxError extends EzTestError {
  constructor(message: string, readonly location: GqlLocation) {
    super(`GraphQL syntax error at ${location.line}:${location.column}: ${message}`, 'GRAPHQL_SYNTAX', { location });
    this.name = 'GraphQLSyntaxError';
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const loc = (at: number) => ({ line, col: at - lineStart + 1 });
  const err = (m: string, at = i): never => {
    throw new GraphQLSyntaxError(m, { line, column: at - lineStart + 1 });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === ' ' || c === '\t' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    const start = i;
    if (src.startsWith('...', i)) {
      out.push({ kind: 'punct', value: '...', start, ...loc(start) });
      i += 3;
      continue;
    }
    if ('!$&()=:@[]{}|'.includes(c)) {
      out.push({ kind: 'punct', value: c, start, ...loc(start) });
      i++;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
      out.push({ kind: 'name', value: src.slice(i, j), start, ...loc(start) });
      i = j;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) err(`unexpected character "${c}"`);
      const next = src[i + m![0].length];
      if (next && /[_A-Za-z.0-9]/.test(next)) err(`invalid number "${src.slice(i, i + m![0].length + 1)}"`);
      out.push({ kind: m![1] || m![2] ? 'float' : 'int', value: m![0], start, ...loc(start) });
      i += m![0].length;
      continue;
    }
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end < 0) err('unterminated block string');
      const raw = src.slice(i + 3, end).replace(/\\"""/g, '"""');
      out.push({ kind: 'string', value: blockString(raw), start, ...loc(start) });
      for (let k = i; k < end + 3; k++) if (src[k] === '\n') {
        line++;
        lineStart = k + 1;
      }
      i = end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n') err('unterminated string');
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === 'u') {
            const hex = /^[0-9a-fA-F]{4}/.exec(src.slice(j + 2));
            if (!hex) err('invalid unicode escape', j);
            s += String.fromCharCode(parseInt(hex![0], 16));
            j += 6;
            continue;
          }
          if (!(e in map)) err(`invalid escape "\\${e}"`, j);
          s += map[e];
          j += 2;
          continue;
        }
        s += ch;
        j++;
      }
      out.push({ kind: 'string', value: s, start, ...loc(start) });
      i = j + 1;
      continue;
    }
    err(`unexpected character "${c}"`);
  }
  out.push({ kind: 'eof', value: '', start: i, ...loc(i) });
  return out;
}

function blockString(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let common: number | undefined;
  for (const l of lines.slice(1)) {
    const ind = l.length - l.trimStart().length;
    if (ind < l.length && (common === undefined || ind < common)) common = ind;
  }
  const out = lines.map((l, i) => (i && common ? l.slice(common) : l));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

// ------------------------------------------------------------------ AST

export type GqlTypeRef = { kind: 'named'; name: string } | { kind: 'list'; of: GqlTypeRef } | { kind: 'nonnull'; of: GqlTypeRef };
export type GqlValue =
  | { kind: 'variable'; name: string; loc: GqlLocation }
  | { kind: 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum'; value: string; loc: GqlLocation }
  | { kind: 'list'; values: GqlValue[]; loc: GqlLocation }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue; loc: GqlLocation }>; loc: GqlLocation };
export interface GqlArg { name: string; value: GqlValue; loc: GqlLocation }
export interface GqlDirective { name: string; args: GqlArg[]; loc: GqlLocation }
export type GqlSelection =
  | { kind: 'field'; alias?: string; name: string; args: GqlArg[]; directives: GqlDirective[]; selections?: GqlSelection[]; loc: GqlLocation }
  | { kind: 'spread'; name: string; directives: GqlDirective[]; loc: GqlLocation }
  | { kind: 'inline'; typeCondition?: string; directives: GqlDirective[]; selections: GqlSelection[]; loc: GqlLocation };
export interface GqlVarDef { name: string; type: GqlTypeRef; defaultValue?: GqlValue; loc: GqlLocation }
export type GqlDefinition =
  | { kind: 'operation'; operation: 'query' | 'mutation' | 'subscription'; name?: string; variables: GqlVarDef[]; directives: GqlDirective[]; selections: GqlSelection[]; loc: GqlLocation }
  | { kind: 'fragment'; name: string; typeCondition: string; directives: GqlDirective[]; selections: GqlSelection[]; loc: GqlLocation };
export interface GqlDocument { definitions: GqlDefinition[] }

/** Parse an executable GraphQL document (operations and fragments). */
export function parseGraphQL(source: string): GqlDocument {
  const t = lex(source);
  let p = 0;
  const peek = () => t[p];
  const at = (k: Tok): GqlLocation => ({ line: k.line, column: k.col });
  const fail = (m: string, k = peek()): never => {
    throw new GraphQLSyntaxError(m, at(k));
  };
  const is = (v: string) => peek().kind === 'punct' && peek().value === v;
  const expect = (v: string): Tok => {
    if (!is(v)) fail(`expected "${v}", found ${describe(peek())}`);
    return t[p++];
  };
  const describe = (k: Tok) => (k.kind === 'eof' ? 'the end of the document' : `"${k.value}"`);
  const name = (): Tok => {
    if (peek().kind !== 'name') fail(`expected a name, found ${describe(peek())}`);
    return t[p++];
  };
  const value = (constant: boolean): GqlValue => {
    const k = peek();
    const l = at(k);
    if (is('$')) {
      if (constant) fail('a variable is not allowed in a constant value');
      p++;
      return { kind: 'variable', name: name().value, loc: l };
    }
    if (is('[')) {
      p++;
      const values: GqlValue[] = [];
      while (!is(']')) {
        if (peek().kind === 'eof') fail('unterminated list');
        values.push(value(constant));
      }
      p++;
      return { kind: 'list', values, loc: l };
    }
    if (is('{')) {
      p++;
      const fields: Array<{ name: string; value: GqlValue; loc: GqlLocation }> = [];
      while (!is('}')) {
        if (peek().kind === 'eof') fail('unterminated object');
        const n = name();
        expect(':');
        fields.push({ name: n.value, value: value(constant), loc: at(n) });
      }
      p++;
      return { kind: 'object', fields, loc: l };
    }
    if (k.kind === 'int' || k.kind === 'float' || k.kind === 'string') {
      p++;
      return { kind: k.kind, value: k.value, loc: l };
    }
    if (k.kind === 'name') {
      p++;
      if (k.value === 'true' || k.value === 'false') return { kind: 'boolean', value: k.value, loc: l };
      if (k.value === 'null') return { kind: 'null', value: 'null', loc: l };
      return { kind: 'enum', value: k.value, loc: l };
    }
    return fail(`expected a value, found ${describe(k)}`);
  };
  const args = (constant: boolean): GqlArg[] => {
    if (!is('(')) return [];
    p++;
    const out: GqlArg[] = [];
    while (!is(')')) {
      const n = name();
      expect(':');
      out.push({ name: n.value, value: value(constant), loc: at(n) });
    }
    p++;
    if (!out.length) fail('an argument list cannot be empty');
    return out;
  };
  const directives = (constant: boolean): GqlDirective[] => {
    const out: GqlDirective[] = [];
    while (is('@')) {
      const k = t[p++];
      out.push({ name: name().value, args: args(constant), loc: at(k) });
    }
    return out;
  };
  const typeRef = (): GqlTypeRef => {
    let ty: GqlTypeRef;
    if (is('[')) {
      p++;
      ty = { kind: 'list', of: typeRef() };
      expect(']');
    } else ty = { kind: 'named', name: name().value };
    if (is('!')) {
      p++;
      return { kind: 'nonnull', of: ty };
    }
    return ty;
  };
  const selections = (): GqlSelection[] => {
    expect('{');
    const out: GqlSelection[] = [];
    while (!is('}')) {
      if (peek().kind === 'eof') fail('unterminated selection set');
      out.push(selection());
    }
    p++;
    if (!out.length) fail('a selection set cannot be empty');
    return out;
  };
  const selection = (): GqlSelection => {
    if (is('...')) {
      const k = t[p++];
      if (peek().kind === 'name' && peek().value !== 'on') return { kind: 'spread', name: name().value, directives: directives(false), loc: at(k) };
      let typeCondition: string | undefined;
      if (peek().kind === 'name' && peek().value === 'on') {
        p++;
        typeCondition = name().value;
      }
      return { kind: 'inline', ...(typeCondition ? { typeCondition } : {}), directives: directives(false), selections: selections(), loc: at(k) };
    }
    const first = name();
    let alias: string | undefined;
    let fieldName = first.value;
    if (is(':')) {
      p++;
      alias = first.value;
      fieldName = name().value;
    }
    const a = args(false);
    const d = directives(false);
    return { kind: 'field', ...(alias ? { alias } : {}), name: fieldName, args: a, directives: d, ...(is('{') ? { selections: selections() } : {}), loc: at(first) };
  };
  const definitions: GqlDefinition[] = [];
  while (peek().kind !== 'eof') {
    const k = peek();
    if (is('{')) {
      definitions.push({ kind: 'operation', operation: 'query', variables: [], directives: [], selections: selections(), loc: at(k) });
      continue;
    }
    if (k.kind !== 'name') fail(`expected an operation or fragment, found ${describe(k)}`);
    if (k.value === 'fragment') {
      p++;
      const n = name();
      if (n.value === 'on') fail('a fragment cannot be named "on"', n);
      const on = name();
      if (on.value !== 'on') fail(`expected "on", found "${on.value}"`, on);
      definitions.push({ kind: 'fragment', name: n.value, typeCondition: name().value, directives: directives(false), selections: selections(), loc: at(k) });
      continue;
    }
    if (k.value === 'query' || k.value === 'mutation' || k.value === 'subscription') {
      p++;
      const opName = peek().kind === 'name' ? name().value : undefined;
      const variables: GqlVarDef[] = [];
      if (is('(')) {
        p++;
        while (!is(')')) {
          const dollar = expect('$');
          const vn = name().value;
          expect(':');
          const ty = typeRef();
          let defaultValue: GqlValue | undefined;
          if (is('=')) {
            p++;
            defaultValue = value(true);
          }
          directives(true);
          variables.push({ name: vn, type: ty, ...(defaultValue ? { defaultValue } : {}), loc: at(dollar) });
        }
        p++;
      }
      definitions.push({ kind: 'operation', operation: k.value, ...(opName ? { name: opName } : {}), variables, directives: directives(false), selections: selections(), loc: at(k) });
      continue;
    }
    fail(`"${k.value}" is not an operation or a fragment (type system definitions are not executable)`);
  }
  if (!definitions.length) fail('the document has no operation');
  return { definitions };
}

// ------------------------------------------------------------------ introspection

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }';

/** The introspection query EZTest sends (types, fields, arguments, input fields, enums, interfaces, possible types, directives). */
export const INTROSPECTION_QUERY = `query EZTestIntrospection {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      kind name
      fields(includeDeprecated: true) { name args { name defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } }
      inputFields { name defaultValue type { ${TYPE_REF} } }
      interfaces { name }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { name }
    }
    directives { name locations args { name defaultValue type { ${TYPE_REF} } } }
  }
}`;

export interface IntroTypeRef { kind: string; name?: string | null; ofType?: IntroTypeRef | null }
export interface IntroInputValue { name: string; defaultValue?: string | null; type: IntroTypeRef }
export interface IntroType {
  kind: 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'LIST' | 'NON_NULL';
  name: string;
  fields?: Array<{ name: string; args: IntroInputValue[]; type: IntroTypeRef }> | null;
  inputFields?: IntroInputValue[] | null;
  interfaces?: Array<{ name: string }> | null;
  enumValues?: Array<{ name: string }> | null;
  possibleTypes?: Array<{ name: string }> | null;
}
export interface IntrospectionSchema {
  queryType?: { name: string } | null;
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types: IntroType[];
  directives?: Array<{ name: string; locations: string[]; args: IntroInputValue[] }>;
}

const BUILTIN_DIRECTIVES: NonNullable<IntrospectionSchema['directives']> = [
  { name: 'include', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean' } } }] },
  { name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean' } } }] },
];

function refText(r: IntroTypeRef): string {
  if (r.kind === 'NON_NULL') return `${refText(r.ofType!)}!`;
  if (r.kind === 'LIST') return `[${refText(r.ofType!)}]`;
  return String(r.name);
}
function astText(r: GqlTypeRef): string {
  return r.kind === 'nonnull' ? `${astText(r.of)}!` : r.kind === 'list' ? `[${astText(r.of)}]` : r.name;
}
function namedOf(r: IntroTypeRef): string {
  return r.kind === 'NON_NULL' || r.kind === 'LIST' ? namedOf(r.ofType!) : String(r.name);
}
function astNamed(r: GqlTypeRef): string {
  return r.kind === 'named' ? r.name : astNamed(r.of);
}

// ------------------------------------------------------------------ validation

/** Validate a document (text or parsed) against an introspected schema. Empty = valid. */
export function validateGraphQL(document: string | GqlDocument, schema: IntrospectionSchema | { __schema: IntrospectionSchema } | { data: { __schema: IntrospectionSchema } }): GqlError[] {
  const s: IntrospectionSchema = 'types' in schema ? schema : '__schema' in schema ? schema.__schema : schema.data.__schema;
  let doc: GqlDocument;
  try {
    doc = typeof document === 'string' ? parseGraphQL(document) : document;
  } catch (e) {
    if (e instanceof GraphQLSyntaxError) return [{ message: e.message.replace(/^GraphQL syntax error at \d+:\d+: /, 'Syntax error: '), locations: [e.location] }];
    throw e;
  }
  const types = new Map(s.types.map((t) => [t.name, t]));
  const directives = new Map([...BUILTIN_DIRECTIVES, ...(s.directives ?? [])].map((d) => [d.name, d]));
  const errors: GqlError[] = [];
  const add = (message: string, ...locations: GqlLocation[]): void => {
    errors.push({ message, locations });
  };
  const ops = doc.definitions.filter((d): d is Extract<GqlDefinition, { kind: 'operation' }> => d.kind === 'operation');
  const frags = new Map<string, Extract<GqlDefinition, { kind: 'fragment' }>>();
  for (const d of doc.definitions) {
    if (d.kind !== 'fragment') continue;
    if (frags.has(d.name)) add(`There can be only one fragment named "${d.name}".`, frags.get(d.name)!.loc, d.loc);
    else frags.set(d.name, d);
  }
  const seenOps = new Map<string, GqlLocation>();
  for (const o of ops) {
    if (!o.name) continue;
    if (seenOps.has(o.name)) add(`There can be only one operation named "${o.name}".`, seenOps.get(o.name)!, o.loc);
    else seenOps.set(o.name, o.loc);
  }
  if (ops.length > 1 && ops.some((o) => !o.name)) add('An anonymous operation must be the only operation in the document.', ...ops.filter((o) => !o.name).map((o) => o.loc));
  if (!ops.length) add('The document has fragments but no operation.', doc.definitions[0].loc);

  const isComposite = (t?: IntroType) => !!t && (t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'UNION');
  const isLeaf = (t?: IntroType) => !!t && (t.kind === 'SCALAR' || t.kind === 'ENUM');
  const possible = (t: IntroType): Set<string> => new Set(t.kind === 'OBJECT' ? [t.name] : (t.possibleTypes ?? []).map((x) => x.name));
  const overlap = (a: IntroType, b: IntroType) => [...possible(a)].some((x) => possible(b).has(x));

  // Literal values against input types.
  const checkValue = (v: GqlValue, ref: IntroTypeRef, where: string, vars: Map<string, GqlVarDef> | undefined, usages: Array<{ name: string; ref: IntroTypeRef; hasDefault: boolean; loc: GqlLocation }>, hasDefault = false): void => {
    if (v.kind === 'variable') {
      usages.push({ name: v.name, ref, hasDefault, loc: v.loc });
      return;
    }
    if (ref.kind === 'NON_NULL') {
      if (v.kind === 'null') return add(`${where} cannot be null (type ${refText(ref)}).`, v.loc);
      return checkValue(v, ref.ofType!, where, vars, usages);
    }
    if (v.kind === 'null') return;
    if (ref.kind === 'LIST') {
      if (v.kind === 'list') v.values.forEach((x) => checkValue(x, ref.ofType!, where, vars, usages));
      else checkValue(v, ref.ofType!, where, vars, usages);
      return;
    }
    const t = types.get(String(ref.name));
    if (!t) return;
    const bad = () => add(`${where} expects a value of type ${refText(ref)}, not ${v.kind === 'enum' ? v.value : v.kind === 'list' || v.kind === 'object' ? `a ${v.kind}` : `${v.kind} ${v.kind === 'string' ? JSON.stringify(v.value) : v.value}`}.`, v.loc);
    if (t.kind === 'ENUM') {
      if (v.kind !== 'enum') return bad();
      if (!(t.enumValues ?? []).some((e) => e.name === v.value)) add(`${where}: "${v.value}" is not a value of enum ${t.name} (${(t.enumValues ?? []).map((e) => e.name).join(', ')}).`, v.loc);
      return;
    }
    if (t.kind === 'INPUT_OBJECT') {
      if (v.kind !== 'object') return bad();
      const fields = new Map((t.inputFields ?? []).map((f) => [f.name, f]));
      const given = new Set<string>();
      for (const f of v.fields) {
        if (given.has(f.name)) add(`${where}: input field "${f.name}" is given twice.`, f.loc);
        given.add(f.name);
        const def = fields.get(f.name);
        if (!def) {
          add(`${where}: input type ${t.name} has no field "${f.name}"${suggest(f.name, [...fields.keys()])}.`, f.loc);
          continue;
        }
        checkValue(f.value, def.type, `${where}.${f.name}`, vars, usages, def.defaultValue !== undefined && def.defaultValue !== null);
      }
      for (const def of fields.values()) {
        if (def.type.kind === 'NON_NULL' && (def.defaultValue === undefined || def.defaultValue === null) && !given.has(def.name)) add(`${where}: input field ${t.name}.${def.name} of type ${refText(def.type)} is required.`, v.loc);
      }
      return;
    }
    if (t.kind === 'SCALAR') {
      switch (t.name) {
        case 'Int':
          if (v.kind !== 'int') return bad();
          if (Number(v.value) > 2147483647 || Number(v.value) < -2147483648) add(`${where}: ${v.value} is outside the 32-bit Int range.`, v.loc);
          return;
        case 'Float': if (v.kind !== 'int' && v.kind !== 'float') bad(); return;
        case 'String': if (v.kind !== 'string') bad(); return;
        case 'Boolean': if (v.kind !== 'boolean') bad(); return;
        case 'ID': if (v.kind !== 'string' && v.kind !== 'int') bad(); return;
        default: return; // custom scalars: the server decides
      }
    }
  };

  const checkDirectives = (ds: GqlDirective[], location: string, vars: Map<string, GqlVarDef> | undefined, usages: Parameters<typeof checkValue>[4]) => {
    for (const d of ds) {
      const def = directives.get(d.name);
      if (!def) {
        add(`Unknown directive "@${d.name}".`, d.loc);
        continue;
      }
      if (!def.locations.includes(location)) add(`Directive "@${d.name}" may not be used on ${location.toLowerCase().replace(/_/g, ' ')}.`, d.loc);
      checkArgs(d.args, def.args, `directive "@${d.name}"`, d.loc, vars, usages);
    }
  };

  const checkArgs = (given: GqlArg[], defs: IntroInputValue[], owner: string, loc: GqlLocation, vars: Map<string, GqlVarDef> | undefined, usages: Parameters<typeof checkValue>[4]) => {
    const byName = new Map(defs.map((a) => [a.name, a]));
    const seen = new Set<string>();
    for (const a of given) {
      if (seen.has(a.name)) add(`Argument "${a.name}" of ${owner} is given twice.`, a.loc);
      seen.add(a.name);
      const def = byName.get(a.name);
      if (!def) {
        add(`Unknown argument "${a.name}" on ${owner}${suggest(a.name, [...byName.keys()])}.`, a.loc);
        continue;
      }
      checkValue(a.value, def.type, `Argument "${a.name}" of ${owner}`, vars, usages, def.defaultValue !== undefined && def.defaultValue !== null);
    }
    for (const def of defs) {
      if (def.type.kind === 'NON_NULL' && (def.defaultValue === undefined || def.defaultValue === null) && !seen.has(def.name)) add(`${owner[0].toUpperCase()}${owner.slice(1)} needs argument "${def.name}" of type ${refText(def.type)}.`, loc);
    }
  };

  // Selections, recording fragment spreads and variable usages per operation.
  const walk = (sel: GqlSelection[], parent: IntroType, vars: Map<string, GqlVarDef> | undefined, usages: Parameters<typeof checkValue>[4], spreads: Set<string>, visiting: string[]) => {
    for (const x of sel) {
      if (x.kind === 'field') {
        checkDirectives(x.directives, 'FIELD', vars, usages);
        if (x.name === '__typename') {
          if (x.selections) add('Field "__typename" is a String and cannot have a selection.', x.loc);
          continue;
        }
        const isRootQuery = parent.name === s.queryType?.name;
        if (isRootQuery && (x.name === '__schema' || x.name === '__type')) {
          const t = types.get(x.name === '__schema' ? '__Schema' : '__Type');
          if (x.selections && t) walk(x.selections, t, vars, usages, spreads, visiting);
          continue;
        }
        if (parent.kind === 'UNION') {
          add(`Cannot query field "${x.name}" on union ${parent.name}: select it inside "... on <Type>" (members: ${(parent.possibleTypes ?? []).map((p) => p.name).join(', ')}).`, x.loc);
          continue;
        }
        const f = (parent.fields ?? []).find((y) => y.name === x.name);
        if (!f) {
          add(`Cannot query field "${x.name}" on type ${parent.name}${suggest(x.name, (parent.fields ?? []).map((y) => y.name))}.`, x.loc);
          continue;
        }
        checkArgs(x.args, f.args ?? [], `field "${parent.name}.${x.name}"`, x.loc, vars, usages);
        const ft = types.get(namedOf(f.type));
        if (isLeaf(ft) && x.selections) add(`Field "${x.name}" is of type ${refText(f.type)} and cannot have a selection.`, x.loc);
        if (isComposite(ft) && !x.selections) add(`Field "${x.name}" of type ${refText(f.type)} needs a selection of subfields, e.g. "${x.name} { ... }".`, x.loc);
        if (isComposite(ft) && x.selections) walk(x.selections, ft!, vars, usages, spreads, visiting);
        continue;
      }
      if (x.kind === 'inline') {
        checkDirectives(x.directives, 'INLINE_FRAGMENT', vars, usages);
        let t = parent;
        if (x.typeCondition) {
          const c = types.get(x.typeCondition);
          if (!c) {
            add(`Unknown type "${x.typeCondition}" in an inline fragment.`, x.loc);
            continue;
          }
          if (!isComposite(c)) {
            add(`An inline fragment cannot be on the non-composite type "${c.name}".`, x.loc);
            continue;
          }
          if (!overlap(c, parent)) add(`Fragment on "${c.name}" can never apply inside "${parent.name}".`, x.loc);
          t = c;
        }
        walk(x.selections, t, vars, usages, spreads, visiting);
        continue;
      }
      checkDirectives(x.directives, 'FRAGMENT_SPREAD', vars, usages);
      const f = frags.get(x.name);
      if (!f) {
        add(`Unknown fragment "${x.name}".`, x.loc);
        continue;
      }
      spreads.add(x.name);
      if (visiting.includes(x.name)) {
        add(`Fragment "${x.name}" spreads itself (${[...visiting, x.name].join(' -> ')}).`, x.loc);
        continue;
      }
      const c = types.get(f.typeCondition);
      if (c && isComposite(c)) {
        if (!overlap(c, parent)) add(`Fragment "${x.name}" (on "${c.name}") can never apply inside "${parent.name}".`, x.loc);
        walk(f.selections, c, vars, usages, spreads, [...visiting, x.name]);
      }
    }
  };

  // Fragments on their own (type conditions), once.
  for (const f of frags.values()) {
    checkDirectives(f.directives, 'FRAGMENT_DEFINITION', undefined, []);
    const c = types.get(f.typeCondition);
    if (!c) add(`Unknown type "${f.typeCondition}" for fragment "${f.name}".`, f.loc);
    else if (!isComposite(c)) add(`Fragment "${f.name}" cannot be on the non-composite type "${c.name}".`, f.loc);
  }

  const used = new Set<string>();
  for (const o of ops) {
    const rootName = o.operation === 'query' ? s.queryType?.name : o.operation === 'mutation' ? s.mutationType?.name : s.subscriptionType?.name;
    const root = rootName ? types.get(rootName) : undefined;
    if (!root) {
      add(`The schema has no ${o.operation} type, so ${o.operation} operations are not supported.`, o.loc);
      continue;
    }
    const vars = new Map<string, GqlVarDef>();
    for (const v of o.variables) {
      if (vars.has(v.name)) add(`Variable "$${v.name}" is defined twice.`, v.loc);
      vars.set(v.name, v);
      const t = types.get(astNamed(v.type));
      if (!t) add(`Unknown type "${astNamed(v.type)}" for variable "$${v.name}".`, v.loc);
      else if (!(t.kind === 'SCALAR' || t.kind === 'ENUM' || t.kind === 'INPUT_OBJECT')) add(`Variable "$${v.name}" cannot be of the output type "${astText(v.type)}".`, v.loc);
      else if (v.defaultValue) {
        const ref = toIntro(v.type);
        checkValue(v.defaultValue, ref, `The default value of "$${v.name}"`, vars, []);
      }
    }
    checkDirectives(o.directives, o.operation.toUpperCase(), vars, []);
    const usages: Parameters<typeof checkValue>[4] = [];
    const spreads = new Set<string>();
    walk(o.selections, root, vars, usages, spreads, []);
    for (const n of spreads) used.add(n);
    if (o.operation === 'subscription') {
      const rootFields = o.selections.filter((x) => x.kind === 'field' && x.name !== '__typename');
      if (rootFields.length > 1 || o.selections.some((x) => x.kind !== 'field')) add(`Subscription${o.name ? ` "${o.name}"` : ''} must select exactly one root field.`, o.loc);
    }
    const label = o.name ? `operation "${o.name}"` : 'the operation';
    const usedVars = new Set<string>();
    for (const u of usages) {
      usedVars.add(u.name);
      const def = vars.get(u.name);
      if (!def) {
        add(`Variable "$${u.name}" is not defined by ${label}.`, u.loc, o.loc);
        continue;
      }
      // A nullable variable cannot go where a value is required, unless it (or the argument) has a default.
      if (u.ref.kind === 'NON_NULL' && def.type.kind !== 'nonnull' && !def.defaultValue && !u.hasDefault) add(`Variable "$${u.name}" of type ${astText(def.type)} is used where ${refText(u.ref)} is required.`, u.loc);
      else if (namedOf(u.ref) !== astNamed(def.type) && !(namedOf(u.ref) === 'Float' && astNamed(def.type) === 'Int')) add(`Variable "$${u.name}" of type ${astText(def.type)} is used where ${refText(u.ref)} is expected.`, u.loc);
    }
    for (const v of o.variables) if (!usedVars.has(v.name)) add(`Variable "$${v.name}" is never used in ${label}.`, v.loc);
  }
  for (const f of frags.values()) if (!used.has(f.name)) add(`Fragment "${f.name}" is never used.`, f.loc);
  return errors;
}

function toIntro(r: GqlTypeRef): IntroTypeRef {
  return r.kind === 'nonnull' ? { kind: 'NON_NULL', ofType: toIntro(r.of) } : r.kind === 'list' ? { kind: 'LIST', ofType: toIntro(r.of) } : { kind: 'NAMED', name: r.name };
}

function suggest(name: string, options: string[]): string {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
    return d[a.length][b.length];
  };
  const close = options.filter((o) => dist(name, o) <= Math.max(1, Math.floor(name.length / 3))).slice(0, 3);
  return close.length ? ` (did you mean ${close.map((c) => `"${c}"`).join(' or ')}?)` : '';
}

/** The errors as one readable line each ("2:5 Cannot query field ..."). */
export function formatGraphQLErrors(errors: GqlError[]): string[] {
  return errors.map((e) => `${e.locations[0] ? `${e.locations[0].line}:${e.locations[0].column} ` : ''}${e.message}`);
}
