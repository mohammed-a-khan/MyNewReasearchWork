/**
 * Parse selector strings accepted by `locator(selector)` into a selector
 * chain for the injected engine.
 *
 * Supported:
 *   - CSS (default), `css=...`
 *   - XPath: `xpath=...`, or anything starting with `//`, `..`, `(//`
 *   - `text=foo` (case-insensitive substring), `text="Foo"` (exact), `text=/re/i`
 *   - `id=x`, `data-testid=x` (also data-test-id, data-test)
 *   - `role=button[name="Save"][exact]`, `nth=2`, `visible=true`
 *   - `section="Billing"` (a container labelled Billing), `row="Acme"` (the row containing Acme);
 *     same text rules as `text=`
 *   - chaining with ` >> `
 *   - trailing CSS pseudo filters: `:visible`, `:has-text("...")`, `:text("...")`, `:text-is("...")`
 */
import type { RegexSource, RoleStep, SelectorChain, SelectorStep, TextMatch } from './injected/contract.js';

/** Split on `>>` that is outside quotes / brackets / parentheses. */
function splitChain(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && c === '>' && selector[i + 1] === '>' && selector[i + 2] !== '>') {
      parts.push(selector.slice(start, i).trim());
      i++;
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}

function unquote(s: string): { value: string; quoted: boolean } {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return { value: t.slice(1, -1).replace(/\\(.)/g, '$1'), quoted: true };
  }
  return { value: t, quoted: false };
}

function regexLiteral(s: string): RegexSource | undefined {
  const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(s.trim());
  return m ? { regex: m[1], flags: m[2] } : undefined;
}

/** text= engine semantics: quoted = exact, /re/ = regex, else substring. A trailing `i` / `s` after quotes sets case. */
function textStep(body: string): SelectorStep {
  const re = regexLiteral(body);
  if (re) return { text: re };
  const m = /^(["'])(.*)\1([is])?$/s.exec(body.trim());
  if (m) return m[3] === 'i' ? { text: m[2] } : { text: m[2], exact: true };
  return { text: body.trim() };
}

function parseRole(body: string): RoleStep {
  const m = /^([a-zA-Z-]+)(.*)$/s.exec(body.trim());
  if (!m) throw new Error(`Malformed role selector "${body}"`);
  const step: RoleStep = { role: m[1] };
  let rest = m[2];
  while (rest.trim()) {
    const a = /^\s*\[\s*([a-z-]+)\s*(?:=\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)*\/[a-z]*|[^\]\s]+)))?\s*([is])?\s*\]/i.exec(rest);
    if (!a) throw new Error(`Malformed role selector "${body}"`);
    rest = rest.slice(a[0].length);
    const key = a[1].toLowerCase();
    const raw = a[2];
    const flag = a[3];
    const val = (): string => (raw === undefined ? 'true' : unquote(raw).value);
    switch (key) {
      case 'name': {
        const re = raw ? regexLiteral(raw) : undefined;
        if (re) step.name = re;
        else {
          step.name = val();
          if (flag === 's' || (raw && unquote(raw).quoted && flag !== 'i')) step.exact = flag === 's' ? true : step.exact;
        }
        break;
      }
      case 'exact': step.exact = val() !== 'false'; break;
      case 'checked': step.checked = val() === 'mixed' ? 'mixed' : val() !== 'false'; break;
      case 'pressed': step.pressed = val() === 'mixed' ? 'mixed' : val() !== 'false'; break;
      case 'expanded': step.expanded = val() !== 'false'; break;
      case 'selected': step.selected = val() !== 'false'; break;
      case 'disabled': step.disabled = val() !== 'false'; break;
      case 'level': step.level = Number(val()); break;
      case 'include-hidden': step.includeHidden = val() !== 'false'; break;
      default: throw new Error(`Unknown role attribute "${key}" in "${body}"`);
    }
  }
  return step;
}

/** Strip trailing EZTest pseudo filters (`:has-text()`, `:visible`, ...) from a CSS selector. */
function cssWithFilters(css: string): SelectorStep[] {
  const filters: SelectorStep[] = [];
  let s = css.trim();
  for (;;) {
    let m = /:visible\s*$/.exec(s);
    if (m) {
      filters.unshift({ visible: true });
      s = s.slice(0, m.index);
      continue;
    }
    m = /:(has-text|text|text-is)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)*\/[a-z]*)\s*\)\s*$/.exec(s);
    if (m) {
      const re = regexLiteral(m[2]);
      const text: TextMatch = re ?? unquote(m[2]).value;
      filters.unshift(m[1] === 'text-is' ? { hasText: text, exact: true } : { hasText: text });
      s = s.slice(0, m.index);
      continue;
    }
    break;
  }
  if (!s.trim() || /[\s>+~,(]$/.test(s)) s = `${s}*`;
  const alternatives = splitList(s.trim());
  if (alternatives.length > 1 && alternatives.some((a) => splitDescendants(a).length > 1)) {
    // A list with descendant combinators: each alternative becomes its own (shadow-piercing) chain.
    return [{ anyOf: alternatives.map((a) => splitDescendants(a).map((css) => ({ css }))) } as unknown as SelectorStep, ...filters];
  }
  return [...splitDescendants(s.trim()).map((css) => ({ css })), ...filters];
}

/** Split a selector list at top-level commas. */
export function splitList(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += css[++i] ?? '';
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Split a selector at its top-level descendant combinators ("a b" -> "a", "b"),
 * so each part is a chain step: chain steps pierce open shadow roots, which
 * makes "host-element inner" match like it reads. Selector lists (",") and
 * other combinators stay inside one part.
 */
export function splitDescendants(css: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += css[++i] ?? '';
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) return [css];
    if (/\s/.test(c) && depth === 0) {
      let j = i;
      while (j < css.length && /\s/.test(css[j])) j++;
      const next = css[j];
      const prev = cur.trimEnd().slice(-1);
      if (next && !'>+~'.includes(next) && prev && !'>+~'.includes(prev)) {
        parts.push(cur.trim());
        cur = '';
      } else cur += ' ';
      i = j - 1;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [css];
}

function attrValue(body: string): TextMatch {
  const re = regexLiteral(body);
  return re ?? unquote(body).value;
}

/** Parse a selector string into a chain. Throws on malformed input. */
export function parseSelector(selector: string): SelectorChain {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('Selector must be a non-empty string');
  const chain: SelectorChain = [];
  for (const part of splitChain(selector)) {
    const eng = /^([a-zA-Z_:-]+)\s*=\s*([\s\S]*)$/.exec(part);
    const name = eng?.[1].toLowerCase();
    const body = eng?.[2] ?? '';
    if (part.startsWith('//') || part.startsWith('..') || part.startsWith('(//')) {
      chain.push({ xpath: part });
      continue;
    }
    switch (name) {
      case 'css': chain.push(...cssWithFilters(body)); continue;
      case 'xpath': chain.push({ xpath: body }); continue;
      case 'text':
      case 'internal:text': chain.push(textStep(body)); continue;
      case 'internal:has-text': {
        const t = textStep(body) as { text: TextMatch; exact?: boolean };
        chain.push({ hasText: t.text, ...(t.exact ? { exact: true } : {}) });
        continue;
      }
      case 'id': chain.push({ css: `[id="${unquote(body).value.replace(/"/g, '\\"')}"]` }); continue;
      case 'data-testid':
      case 'data-test-id':
      case 'data-test': chain.push({ testId: attrValue(body), attr: name }); continue;
      case 'role':
      case 'internal:role': chain.push(parseRole(body)); continue;
      case 'section': {
        const t = textStep(body) as { text: TextMatch; exact?: boolean };
        chain.push({ section: t.text, ...(t.exact ? { exact: true } : {}) });
        continue;
      }
      case 'row': {
        const t = textStep(body) as { text: TextMatch; exact?: boolean };
        chain.push({ row: t.text, ...(t.exact ? { exact: true } : {}) });
        continue;
      }
      case 'nth': chain.push({ nth: Number(body) }); continue;
      case 'visible': chain.push({ visible: body.trim() !== 'false' }); continue;
      case 'internal:label': chain.push({ label: textStep(body).hasOwnProperty('text') ? (textStep(body) as { text: TextMatch }).text : body, exact: !!(textStep(body) as { exact?: boolean }).exact }); continue;
      default: break;
    }
    chain.push(...cssWithFilters(part));
  }
  return chain;
}
