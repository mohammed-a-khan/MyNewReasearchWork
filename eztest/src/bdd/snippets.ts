/**
 * Snippets for undefined steps: the step definition to paste into a steps
 * file. Quoted text becomes {string}, whole numbers {int}, decimals {float};
 * custom parameter types marked useForSnippets are used where their regexp
 * matches a whole word.
 */
import type { ParameterTypeRegistry } from './expressions.js';

export interface SnippetInput {
  text: string;
  /** What the step reads as (picks Given / When / Then). */
  type: 'context' | 'action' | 'outcome';
  hasDataTable?: boolean;
  hasDocString?: boolean;
}

const escapeExpr = (s: string) => s.replace(/([\\(){}/])/g, '\\$1');

/** The expression and parameter names a snippet would use. */
export function snippetExpression(text: string, params?: ParameterTypeRegistry): { expression: string; args: Array<{ name: string; type: string }> } {
  const args: Array<{ name: string; type: string }> = [];
  const custom = (params?.all() ?? []).filter((p) => !p.builtin && p.useForSnippets);
  const counts = new Map<string, number>();
  const arg = (type: string) => {
    const n = (counts.get(type) ?? 0) + 1;
    counts.set(type, n);
    args.push({ name: n > 1 ? `${type}${n}` : type, type });
    return `{${type}}`;
  };
  let out = '';
  let i = 0;
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?<![\w.])-?\d+\.\d+(?![\w.])|(?<![\w.])-?\d+(?![\w.])/g;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += literalPart(text.slice(i, at), custom, arg);
    const tok = m[0];
    out += tok.startsWith('"') || tok.startsWith("'") ? arg('string') : tok.includes('.') ? arg('float') : arg('int');
    i = at + tok.length;
  }
  out += literalPart(text.slice(i), custom, arg);
  return { expression: out, args };
}

function literalPart(s: string, custom: Array<{ name: string; sources: string[] }>, arg: (t: string) => string): string {
  if (!custom.length) return escapeExpr(s);
  return s.split(/(\s+)/).map((w) => {
    if (!w.trim()) return w;
    const t = custom.find((p) => p.sources.some((src) => new RegExp(`^(?:${src})$`).test(w)));
    return t ? arg(t.name) : escapeExpr(w);
  }).join('');
}

const KEYWORD = { context: 'Given', action: 'When', outcome: 'Then' } as const;

/** A TypeScript step definition for an undefined step. */
export function snippet(input: SnippetInput, params?: ParameterTypeRegistry): string {
  const { expression, args } = snippetExpression(input.text, params);
  const names = args.map((a) => a.name);
  if (input.hasDataTable) names.push('dataTable');
  else if (input.hasDocString) names.push('docString');
  const quoted = expression.includes("'") ? (expression.includes('`') ? JSON.stringify(expression) : `\`${expression}\``) : `'${expression}'`;
  return [
    `${KEYWORD[input.type]}(${quoted}, async ({ ui, api, db, world }${names.length ? `, ${names.join(', ')}` : ''}) => {`,
    '  // Turn the phrase above into ui / api / db calls.',
    "  throw new Error('pending');",
    '});',
  ].join('\n');
}
