/**
 * A deliberately small GraphQL executor (no library): parses one operation
 * (query or mutation, variables, arguments, aliases, nested selections,
 * __typename) and resolves it against plain resolver objects. Unknown fields
 * are errors, as in a real schema.
 */

type Value = unknown;
interface Field {
  alias?: string;
  name: string;
  args: Record<string, ArgValue>;
  selections?: Field[];
}
type ArgValue = { kind: 'var'; name: string } | { kind: 'lit'; value: Value } | { kind: 'list'; items: ArgValue[] } | { kind: 'obj'; fields: Record<string, ArgValue> };

export class GraphQLError extends Error {}

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  private ws() {
    for (;;) {
      while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
      if (this.s[this.i] === '#') while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      else break;
    }
  }
  private peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }
  private eat(ch: string) {
    if (this.peek() !== ch) throw new GraphQLError(`Syntax error: expected "${ch}" at ${this.i}, found "${this.s[this.i] ?? 'end'}"`);
    this.i++;
  }
  private name(): string {
    this.ws();
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.s.slice(this.i));
    if (!m) throw new GraphQLError(`Syntax error: expected a name at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  document(): { op: 'query' | 'mutation'; fields: Field[] } {
    let op: 'query' | 'mutation' = 'query';
    if (this.peek() !== '{') {
      const kw = this.name();
      if (kw !== 'query' && kw !== 'mutation') throw new GraphQLError(`Unsupported operation "${kw}"`);
      op = kw;
      if (/[_A-Za-z]/.test(this.peek())) this.name();
      if (this.peek() === '(') {
        // variable definitions: ($id: ID!, $input: QuoteInput) - types are not enforced
        this.eat('(');
        while (this.peek() !== ')') {
          this.eat('$');
          this.name();
          this.eat(':');
          this.type();
          if (this.peek() === '=') {
            this.i++;
            this.value();
          }
        }
        this.eat(')');
      }
    }
    const fields = this.selectionSet();
    if (this.peek() !== '') throw new GraphQLError('Only one operation per document is supported');
    return { op, fields };
  }
  private type() {
    if (this.peek() === '[') {
      this.eat('[');
      this.type();
      this.eat(']');
    } else this.name();
    if (this.peek() === '!') this.i++;
  }
  private selectionSet(): Field[] {
    this.eat('{');
    const out: Field[] = [];
    while (this.peek() !== '}') {
      let name = this.name();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.i++;
        alias = name;
        name = this.name();
      }
      const args: Record<string, ArgValue> = {};
      if (this.peek() === '(') {
        this.eat('(');
        while (this.peek() !== ')') {
          const a = this.name();
          this.eat(':');
          args[a] = this.value();
        }
        this.eat(')');
      }
      const selections = this.peek() === '{' ? this.selectionSet() : undefined;
      out.push({ alias, name, args, selections });
    }
    this.eat('}');
    return out;
  }
  private value(): ArgValue {
    const c = this.peek();
    if (c === '$') {
      this.i++;
      return { kind: 'var', name: this.name() };
    }
    if (c === '"') {
      let j = this.i + 1;
      let out = '';
      while (j < this.s.length && this.s[j] !== '"') {
        if (this.s[j] === '\\') {
          j++;
          out += ({ n: '\n', t: '\t', '"': '"', '\\': '\\' } as Record<string, string>)[this.s[j]] ?? this.s[j];
        } else out += this.s[j];
        j++;
      }
      this.i = j + 1;
      return { kind: 'lit', value: out };
    }
    if (c === '[') {
      this.eat('[');
      const items: ArgValue[] = [];
      while (this.peek() !== ']') items.push(this.value());
      this.eat(']');
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.eat('{');
      const fields: Record<string, ArgValue> = {};
      while (this.peek() !== '}') {
        const k = this.name();
        this.eat(':');
        fields[k] = this.value();
      }
      this.eat('}');
      return { kind: 'obj', fields };
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { kind: 'lit', value: Number(m[0]) };
    }
    const n = this.name();
    return { kind: 'lit', value: n === 'true' ? true : n === 'false' ? false : n === 'null' ? null : n };
  }
}

function resolveArg(a: ArgValue, vars: Record<string, unknown>): unknown {
  if (a.kind === 'var') return vars[a.name];
  if (a.kind === 'lit') return a.value;
  if (a.kind === 'list') return a.items.map((x) => resolveArg(x, vars));
  return Object.fromEntries(Object.entries(a.fields).map(([k, v]) => [k, resolveArg(v, vars)]));
}

/** A resolver object: properties are values or functions of (args). Functions may return promises. */
export type Resolved = Record<string, unknown> & { __typename?: string };

async function select(value: unknown, fields: Field[] | undefined, vars: Record<string, unknown>, path: string): Promise<unknown> {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return Promise.all(value.map((v, i) => select(v, fields, vars, `${path}[${i}]`)));
  if (!fields) {
    if (typeof value === 'object') throw new GraphQLError(`Field "${path}" of an object type must have a selection of subfields`);
    return value;
  }
  if (typeof value !== 'object') throw new GraphQLError(`Field "${path}" is a scalar and cannot have a selection`);
  const obj = value as Resolved;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') {
      out[key] = obj.__typename ?? 'Object';
      continue;
    }
    if (!(f.name in obj)) throw new GraphQLError(`Cannot query field "${f.name}" on type "${obj.__typename ?? 'Object'}"`);
    let v = obj[f.name];
    if (typeof v === 'function') v = await (v as (args: Record<string, unknown>) => unknown)(Object.fromEntries(Object.entries(f.args).map(([k, a]) => [k, resolveArg(a, vars)])));
    out[key] = await select(v, f.selections, vars, `${path}.${f.name}`);
  }
  return out;
}

export async function executeGraphQL(
  root: { Query: Resolved; Mutation: Resolved },
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  try {
    const doc = new Parser(query).document();
    const data = await select(doc.op === 'mutation' ? root.Mutation : root.Query, doc.fields, variables, doc.op === 'mutation' ? 'Mutation' : 'Query');
    return { data };
  } catch (e) {
    return { data: null, errors: [{ message: (e as Error).message }] };
  }
}
