/**
 * XPath literal escaping. XPath 1.0 has no escape character inside string
 * literals: a value with an apostrophe must be quoted with double quotes, a
 * value with a double quote with apostrophes, and a value with both must be
 * built with concat(). A backslash (`\'`) is NOT an escape and breaks the
 * expression.
 *
 * Every place EZTest puts a value into an XPath goes through these functions:
 * `${var}` interpolation of xpath locator candidates and `<column>` Examples
 * placeholders.
 */

/** An XPath 1.0 string literal for any text: 'a', "it's", or concat('a"b', "'", 'c'). */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  const parts: string[] = [];
  s.split("'").forEach((chunk, i) => {
    if (i > 0) parts.push(`"'"`);
    if (chunk) parts.push(`'${chunk}'`);
  });
  return `concat(${parts.join(', ')})`;
}

interface Piece {
  kind: 'code' | 'literal';
  text: string;
}

/** Split an XPath expression into code and string-literal pieces (literal text without its quotes). */
export function splitXPathLiterals(xpath: string): Piece[] {
  const out: Piece[] = [];
  let code = '';
  for (let i = 0; i < xpath.length; i++) {
    const ch = xpath[i];
    if (ch === "'" || ch === '"') {
      const end = xpath.indexOf(ch, i + 1);
      if (end < 0) {
        code += xpath.slice(i);
        break;
      }
      if (code) out.push({ kind: 'code', text: code });
      code = '';
      out.push({ kind: 'literal', text: xpath.slice(i + 1, end) });
      i = end;
      continue;
    }
    code += ch;
  }
  if (code) out.push({ kind: 'code', text: code });
  return out;
}

/**
 * Fill placeholders in an XPath template. Placeholders inside a string literal are
 * substituted and the whole literal is re-quoted safely (so `//a[text()='${name}']`
 * with name = `Bob's "best"` becomes `//a[text()=concat('Bob', "'", 's "best"')]`).
 * Placeholders outside literals are substituted as written (they are expression code).
 * `fill` returns the substituted text of a piece.
 */
export function fillXPath(template: string, fill: (text: string) => string): string {
  return splitXPathLiterals(template)
    .map((p) => {
      if (p.kind === 'code') return fill(p.text);
      const filled = fill(p.text);
      // Untouched literals keep their original quoting.
      return filled === p.text ? quoteLike(p.text) : xpathLiteral(filled);
    })
    .join('');
}

function quoteLike(text: string): string {
  return text.includes("'") ? `"${text}"` : `'${text}'`;
}

/** True when a template places a placeholder (`${x}` or `<col>`) inside an XPath string literal. */
export function hasPlaceholderInLiteral(template: string, placeholder: RegExp = /\$\{[^}]+\}|<[A-Za-z_][\w -]*>/): boolean {
  return splitXPathLiterals(template).some((p) => p.kind === 'literal' && placeholder.test(p.text));
}
