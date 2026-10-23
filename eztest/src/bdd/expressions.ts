/**
 * Step expressions: how a step definition's pattern matches step text.
 *
 * EZTest's own implementation of the expression syntax BDD teams use:
 *
 *   the customer {string} has {int} order(s)        parameters and optional text
 *   I pay by card/cash                              alternatives (word level)
 *   it costs \{x\}                                  backslash escapes ( ) { } / \
 *
 * Built-in parameters: {int}, {float}, {string} ("double" or 'single' quoted,
 * quotes removed, `\"` unescaped), {word} (no whitespace), {} (anything), and
 * {double}, {long}, {short}, {byte}, {bigint}, {biginteger}, {bigdecimal}.
 * Custom ones come from defineParameterType(). A regular expression may be
 * used instead of an expression; its capture groups are passed as strings.
 */
import { EzTestError } from '../core/index.js';

export interface ParameterTypeSpec<T = unknown> {
  /** Name used in expressions: `{color}`. */
  name: string;
  /** What the parameter matches (one or several alternatives). */
  regexp: RegExp | string | Array<RegExp | string>;
  /** Turns the match (or its capture groups) into the argument. Called with the scenario's world as `this`. */
  transformer?: (this: unknown, ...groups: string[]) => T | Promise<T>;
  /** Snippets for undefined steps may use this type (default true for custom types). */
  useForSnippets?: boolean;
}

export interface ParameterType {
  name: string;
  /** Regex sources of the alternatives. */
  sources: string[];
  transform: (world: unknown, whole: string, groups: Array<string | undefined>) => unknown;
  useForSnippets: boolean;
  builtin: boolean;
}

/** Number of capture groups in a regex source. */
export function groupCount(source: string): number {
  return (new RegExp(`${source}|`).exec('')?.length ?? 1) - 1;
}

const sourceOf = (r: RegExp | string) => {
  if (typeof r === 'string') return r;
  if (r.flags.replace(/[gyu]/g, '')) throw new EzTestError(`Parameter regexps cannot use flags (/${r.source}/${r.flags})`, 'BAD_PARAMETER_TYPE');
  return r.source;
};

const unescapeQuoted = (s: string, q: string) => s.replace(new RegExp(`\\\\(${q}|\\\\)`, 'g'), '$1');

function builtins(): ParameterType[] {
  const num = (name: string, sources: string[], conv: (s: string) => unknown, snippets = true): ParameterType => ({
    name, sources, builtin: true, useForSnippets: snippets, transform: (_w, whole) => conv(whole),
  });
  const INT = ['-?\\d+', '\\d+'];
  const FLOAT = ['[-+]?(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[eE][-+]?\\d+)?'];
  return [
    num('int', INT, (s) => parseInt(s, 10)),
    num('float', FLOAT, (s) => parseFloat(s)),
    num('double', FLOAT, (s) => parseFloat(s), false),
    num('long', INT, (s) => parseInt(s, 10), false),
    num('short', INT, (s) => parseInt(s, 10), false),
    num('byte', INT, (s) => parseInt(s, 10), false),
    num('bigint', INT, (s) => BigInt(s), false),
    num('biginteger', INT, (s) => BigInt(s), false),
    num('bigdecimal', FLOAT, (s) => s, false),
    { name: 'word', sources: ['[^\\s]+'], builtin: true, useForSnippets: false, transform: (_w, whole) => whole },
    {
      name: 'string', builtin: true, useForSnippets: true,
      sources: ['"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"', "'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'"],
      transform: (_w, whole, g) => (g[0] !== undefined ? unescapeQuoted(g[0], '"') : g[1] !== undefined ? unescapeQuoted(g[1], "'") : whole),
    },
    { name: '', sources: ['.*'], builtin: true, useForSnippets: false, transform: (_w, whole) => whole },
  ];
}

/** Parameter types by name: the built-ins plus the project's own. */
export class ParameterTypeRegistry {
  private readonly types = new Map<string, ParameterType>();

  constructor() {
    for (const t of builtins()) this.types.set(t.name, t);
  }

  define(spec: ParameterTypeSpec): ParameterType {
    if (!spec || typeof spec.name !== 'string') throw new EzTestError('defineParameterType needs a name', 'BAD_PARAMETER_TYPE');
    if (!/^[^\s(){}/\\]*$/.test(spec.name)) throw new EzTestError(`Parameter type name "${spec.name}" cannot contain spaces, (, ), {, }, / or \\`, 'BAD_PARAMETER_TYPE');
    const existing = this.types.get(spec.name);
    if (existing?.builtin) throw new EzTestError(`{${spec.name}} is a built-in parameter type`, 'BAD_PARAMETER_TYPE');
    const sources = (Array.isArray(spec.regexp) ? spec.regexp : [spec.regexp]).map(sourceOf);
    if (!sources.length) throw new EzTestError(`Parameter type {${spec.name}} needs a regexp`, 'BAD_PARAMETER_TYPE');
    const fn = spec.transformer;
    const t: ParameterType = {
      name: spec.name, sources, builtin: false, useForSnippets: spec.useForSnippets ?? true,
      transform: (world, whole, groups) => {
        if (!fn) return whole;
        const args = groups.length ? groups.map((g) => g as string) : [whole];
        return fn.apply(world, args);
      },
    };
    this.types.set(spec.name, t);
    return t;
  }

  get(name: string): ParameterType | undefined {
    return this.types.get(name);
  }

  all(): ParameterType[] {
    return [...this.types.values()];
  }
}

export interface ExpressionMatch {
  /** Arguments in order; transformers may return promises (resolved before the step runs). */
  args: unknown[];
  /** Where each argument sits in the step text. */
  spans: Array<{ start: number; end: number; parameter: string }>;
}

export interface StepExpression {
  /** The pattern as written. */
  readonly source: string;
  readonly kind: 'expression' | 'regexp';
  readonly regexp: RegExp;
  /** Parameter type names in order (`{}` is ""). Regex expressions report "" per group. */
  readonly parameters: string[];
  match(text: string, world?: unknown): ExpressionMatch | null;
}

export class ExpressionSyntaxError extends EzTestError {
  constructor(message: string, readonly expression: string, readonly column: number) {
    super(`Invalid step expression "${expression}" at column ${column}: ${message}`, 'BAD_STEP_EXPRESSION', { expression, column });
    this.name = 'ExpressionSyntaxError';
  }
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * Compile an expression to a regex source, with the parameter types in order.
 * Alternatives (`a/b`) bind to the whitespace-delimited word they are in.
 */
function compileExpression(expr: string, reg: ParameterTypeRegistry): { source: string; params: ParameterType[] } {
  const params: ParameterType[] = [];
  // Tokenise into: text (escaped), params, optionals, whitespace, alternation slashes.
  type Part = { t: 'text'; v: string } | { t: 'param'; v: ParameterType } | { t: 'opt'; v: string } | { t: 'ws'; v: string } | { t: 'alt' };
  const parts: Part[] = [];
  let i = 0;
  const pushText = (v: string) => {
    const last = parts[parts.length - 1];
    if (last?.t === 'text') last.v += v;
    else parts.push({ t: 'text', v });
  };
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '\\') {
      const nx = expr[i + 1];
      if (nx === undefined || !/[(){}/\\]/.test(nx)) throw new ExpressionSyntaxError(`only ( ) { } / and \\ can be escaped, got "\\${nx ?? ''}"`, expr, i + 1);
      pushText(nx);
      i += 2;
      continue;
    }
    if (ch === '{') {
      const close = expr.indexOf('}', i);
      if (close < 0) throw new ExpressionSyntaxError('"{" is not closed', expr, i + 1);
      const name = expr.slice(i + 1, close);
      if (/[{(/\\]/.test(name)) throw new ExpressionSyntaxError(`bad parameter name "${name}"`, expr, i + 2);
      const type = reg.get(name);
      if (!type) throw new ExpressionSyntaxError(`undefined parameter type {${name}} (define it with defineParameterType)`, expr, i + 1);
      params.push(type);
      parts.push({ t: 'param', v: type });
      i = close + 1;
      continue;
    }
    if (ch === '}') throw new ExpressionSyntaxError('"}" without "{" (escape it as \\})', expr, i + 1);
    if (ch === '(') {
      let j = i + 1;
      let v = '';
      for (; j < expr.length && expr[j] !== ')'; j++) {
        if (expr[j] === '\\' && j + 1 < expr.length) {
          v += expr[++j];
          continue;
        }
        if (expr[j] === '{') throw new ExpressionSyntaxError('an optional "( )" cannot contain a parameter', expr, j + 1);
        if (expr[j] === '(') throw new ExpressionSyntaxError('optionals cannot be nested', expr, j + 1);
        if (expr[j] === '/') throw new ExpressionSyntaxError('an optional "( )" cannot contain an alternative "/"', expr, j + 1);
        v += expr[j];
      }
      if (j >= expr.length) throw new ExpressionSyntaxError('"(" is not closed', expr, i + 1);
      if (!v) throw new ExpressionSyntaxError('an optional "( )" cannot be empty', expr, i + 1);
      parts.push({ t: 'opt', v });
      i = j + 1;
      continue;
    }
    if (ch === ')') throw new ExpressionSyntaxError('")" without "(" (escape it as \\))', expr, i + 1);
    if (ch === '/') {
      parts.push({ t: 'alt' });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      let v = '';
      while (i < expr.length && /\s/.test(expr[i])) v += expr[i++];
      parts.push({ t: 'ws', v });
      continue;
    }
    pushText(ch);
    i++;
  }
  // Group into words (split at whitespace); a word with "/" is an alternation of its pieces.
  const words: Part[][] = [[]];
  for (const p of parts) {
    if (p.t === 'ws') words.push([p], []);
    else words[words.length - 1].push(p);
  }
  const render = (ps: Part[]): string => ps.map((p) => {
    if (p.t === 'text') return reEscape(p.v);
    if (p.t === 'ws') return reEscape(p.v);
    if (p.t === 'opt') return `(?:${reEscape(p.v)})?`;
    if (p.t === 'param') return `(${p.v.sources.map((s) => `(?:${s})`).join('|')})`;
    return '';
  }).join('');
  let source = '';
  for (const w of words) {
    if (!w.some((p) => p.t === 'alt')) {
      source += render(w);
      continue;
    }
    const alts: Part[][] = [[]];
    for (const p of w) {
      if (p.t === 'alt') alts.push([]);
      else alts[alts.length - 1].push(p);
    }
    if (alts.some((a) => !a.length)) throw new ExpressionSyntaxError('an alternative "/" needs text on both sides', expr, expr.indexOf('/') + 1);
    if (alts.some((a) => a.some((p) => p.t === 'param'))) throw new ExpressionSyntaxError('an alternative cannot contain a parameter', expr, expr.indexOf('/') + 1);
    source += `(?:${alts.map(render).join('|')})`;
  }
  return { source: `^${source}$`, params };
}

class CompiledExpression implements StepExpression {
  readonly kind = 'expression' as const;
  readonly regexp: RegExp;
  readonly parameters: string[];
  private readonly params: ParameterType[];

  constructor(readonly source: string, reg: ParameterTypeRegistry) {
    const c = compileExpression(source, reg);
    this.regexp = new RegExp(c.source, 'd');
    this.params = c.params;
    this.parameters = c.params.map((p) => p.name);
  }

  match(text: string, world?: unknown): ExpressionMatch | null {
    const m = this.regexp.exec(text);
    if (!m) return null;
    const args: unknown[] = [];
    const spans: ExpressionMatch['spans'] = [];
    let g = 1;
    for (const p of this.params) {
      const whole = m[g] ?? '';
      const ix = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices?.[g];
      // Inner groups of the parameter: each alternative contributes its own groups.
      const inner: Array<string | undefined> = [];
      let k = g + 1;
      for (const s of p.sources) {
        const n = groupCount(s);
        for (let q = 0; q < n; q++) inner.push(m[k + q]);
        k += n;
      }
      args.push(p.transform(world, whole, p.builtin ? inner : inner.filter((x) => x !== undefined)));
      spans.push({ start: ix?.[0] ?? -1, end: ix?.[1] ?? -1, parameter: p.name });
      g = k;
    }
    return { args, spans };
  }
}

class RegexpExpression implements StepExpression {
  readonly kind = 'regexp' as const;
  readonly source: string;
  readonly parameters: string[];
  readonly regexp: RegExp;

  constructor(re: RegExp) {
    this.source = re.toString();
    const flags = re.flags.replace(/[gy]/g, '');
    this.regexp = new RegExp(re.source, flags.includes('d') ? flags : `${flags}d`);
    this.parameters = Array.from({ length: groupCount(re.source) }, () => '');
  }

  match(text: string): ExpressionMatch | null {
    const m = this.regexp.exec(text);
    if (!m) return null;
    const ind = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
    const args = m.slice(1);
    return { args, spans: args.map((_a, i) => ({ start: ind?.[i + 1]?.[0] ?? -1, end: ind?.[i + 1]?.[1] ?? -1, parameter: '' })) };
  }
}

/** Compile a step pattern (an expression string or a RegExp). */
export function stepExpression(pattern: string | RegExp, reg: ParameterTypeRegistry): StepExpression {
  if (pattern instanceof RegExp) return new RegexpExpression(pattern);
  if (typeof pattern !== 'string' || !pattern.trim()) throw new EzTestError('A step definition needs a pattern: an expression string or a RegExp', 'BAD_STEP_EXPRESSION');
  return new CompiledExpression(pattern, reg);
}
