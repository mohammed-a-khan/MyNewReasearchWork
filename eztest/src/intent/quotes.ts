/**
 * Quoted-string protection for the intent grammar. Quoted text is replaced by
 * opaque placeholders before the grammar runs so that words inside quotes
 * ("Sign in", "select * from x") can never be mistaken for grammar keywords,
 * and is restored exactly afterwards.
 */

const OPEN = '⟦';
const CLOSE = '⟧';
const PLACEHOLDER = /⟦(\d+)⟧/g;
const SINGLE = /^⟦(\d+)⟧$/;

export interface Protected {
  /** The line with every quoted segment replaced by a placeholder. */
  text: string;
  /** Raw contents of each quoted segment (without the quotes). */
  quotes: string[];
}

/**
 * Replace "double", 'single', `backtick` and “curly” quoted segments by placeholders. Inside a segment a backslash
 * before its own quote character escapes it (`"\"approver\":\s*true"` holds `"approver":\s*true`); every other
 * backslash is kept as written (regular expressions, Windows paths).
 */
export function protectQuotes(line: string): Protected {
  const quotes: string[] = [];
  const keep = (content: string, q: string) => {
    quotes.push(q && content.includes('\\') ? content.split(`\\${q}`).join(q) : content);
    return `${OPEN}${quotes.length - 1}${CLOSE}`;
  };
  // One left-to-right pass, so the outermost quote wins ('["EU"]' stays one segment). Each kind is tried with
  // escapes first, then as before without them (a segment that ends in a backslash, "C:\temp\").
  const text = line.replace(
    /"((?:[^"\\]|\\.)*)"|"([^"]*)"|\u201c([^\u201d]*)\u201d|`((?:[^`\\]|\\.)*)`|`([^`]*)`|(^|[\s(,=])(?:'((?:[^'\\]|\\.)*)'|'([^']*)')(?=$|[\s,.;:)])/g,
    (_w, d?: string, dPlain?: string, c?: string, b?: string, bPlain?: string, pre?: string, sq?: string, sqPlain?: string) => {
      if (d !== undefined) return keep(d, '"');
      if (dPlain !== undefined) return keep(dPlain, '');
      if (c !== undefined) return keep(c, '');
      if (b !== undefined) return keep(b, '`');
      if (bPlain !== undefined) return keep(bPlain, '');
      return (pre ?? '') + (sq !== undefined ? keep(sq, "'") : keep(sqPlain ?? '', ''));
    },
  );
  return { text, quotes };
}

/** Put quoted segments back, re-quoting them (double quotes unless the content contains one). */
export function restoreQuotes(text: string, quotes: string[]): string {
  return text.replace(PLACEHOLDER, (_w, i: string) => quoteText(quotes[Number(i)] ?? ''));
}

/**
 * Extract a literal value: when the whole fragment is one quoted segment the
 * raw content is returned exactly (whitespace preserved); otherwise the
 * fragment is trimmed and its quotes restored.
 */
export function literal(text: string, quotes: string[]): string {
  const t = text.trim();
  const m = SINGLE.exec(t);
  if (m) return quotes[Number(m[1])] ?? '';
  return restoreQuotes(t, quotes);
}

/** True when the fragment is exactly one quoted segment. */
export function isQuoted(text: string): boolean {
  return SINGLE.test(text.trim());
}

/** Quote a string for emission in an .ez script. */
export function quoteText(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('`')) return `\`${s}\``;
  throw new Error(`Cannot quote text containing all quote characters: ${s}`);
}
