/**
 * Assertion-depth expectations and their canonical renderings:
 *
 *   the Save button has accessible name "Save order"     the accessible name of the Save button matches "^Save"
 *   the Help link has accessible description "Opens..."  the Save button has role "button"
 *   the "Order summary" region matches the aria snapshot "order-summary"   (or a file: "snapshots/x.aria.yml")
 *   the page matches the aria snapshot "home"
 *   the Status field does not contain "Error"            the Total does not have text "0.00"
 *   the Quantity field does not have value "0"
 *   the title matches "^Orders \d+"                       the page text matches "ORD-\d{4}"
 *
 * Rendering is the inverse of parsing (conditionToText(c) parses back to c).
 */
import type { Condition, Target } from '../core/index.js';
import { isQuoted, literal, quoteText, restoreQuotes } from './quotes.js';
import { describeTarget } from './target.js';

interface CondRule {
  name: string;
  re: RegExp;
  build(m: RegExpExecArray, q: string[]): Condition | undefined;
}

const Q = String.raw`⟦\d+⟧`;
const val = (s: string, q: string[]) => literal(s, q);
const tgt = (s: string, q: string[]): Target => describeTarget(restoreQuotes(s.trim(), q));
const isPage = (s: string) => /^(?:the\s+)?(?:current\s+)?(?:page|screen|url|address|title|console|response|request)$/i.test(s.trim());
const OPS: Record<string, 'equals' | 'contains' | 'matches' | 'ne'> = { is: 'equals', equals: 'equals', contains: 'contains', includes: 'contains', matches: 'matches', 'is not': 'ne' };

/** "/re/flags" or a plain pattern. */
function pattern(raw: string, q: string[]): { pattern: string; flags?: string } {
  const v = isQuoted(raw) ? val(raw, q) : raw.trim();
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(v);
  const p = m ? { pattern: m[1], ...(m[2] ? { flags: m[2] } : {}) } : { pattern: v };
  new RegExp(p.pattern, p.flags); // fail at parse time on a bad pattern
  return p;
}

export const DEPTH_CONDITION_RULES: CondRule[] = [
  // ---------------------------------------------------------------- accessible name, description, role
  { name: 'accessible-has', re: new RegExp(String.raw`^(.+?)\s+has\s+(?:the\s+|an?\s+)?accessible\s+(name|description)\s+(${Q})$`, 'i'),
    build: (m, q) => ({ type: 'accessible', target: tgt(m[1], q), property: m[2].toLowerCase() as 'name', op: 'equals', value: val(m[3], q) }) },
  { name: 'accessible-of', re: new RegExp(String.raw`^(?:the\s+)?accessible\s+(name|description)\s+of\s+(.+?)\s+(is\s+not|is|equals|contains|includes|matches)\s+(${Q})$`, 'i'),
    build: (m, q) => {
      const op = OPS[m[3].toLowerCase().replace(/\s+/g, ' ')];
      const value = op === 'matches' ? pattern(m[4], q).pattern : val(m[4], q);
      return { type: 'accessible', target: tgt(m[2], q), property: m[1].toLowerCase() as 'name', op, value };
    } },
  { name: 'role-has', re: new RegExp(String.raw`^(.+?)\s+has\s+(?:the\s+)?(?:aria\s+)?role\s+(${Q}|[a-z]+)$`, 'i'),
    build: (m, q) => ({ type: 'accessible', target: tgt(m[1], q), property: 'role', op: 'equals', value: val(m[2], q).toLowerCase() }) },
  { name: 'role-of', re: new RegExp(String.raw`^(?:the\s+)?(?:aria\s+)?role\s+of\s+(.+?)\s+(is\s+not|is|equals)\s+(${Q}|[a-z]+)$`, 'i'),
    build: (m, q) => ({ type: 'accessible', target: tgt(m[1], q), property: 'role', op: OPS[m[2].toLowerCase().replace(/\s+/g, ' ')], value: val(m[3], q).toLowerCase() }) },
  // ---------------------------------------------------------------- aria snapshots
  { name: 'aria-snapshot', re: new RegExp(String.raw`^(.+?)\s+(?:matches|has|conforms\s+to)\s+(?:the\s+)?aria\s+snapshot\s+(${Q})$`, 'i'),
    build: (m, q) => {
      const ref = val(m[2], q).trim();
      if (!ref) return undefined;
      const where = /\.ya?ml$/i.test(ref) ? { file: ref } : { name: ref };
      return /^(?:the\s+)?(?:page|screen)$/i.test(m[1].trim()) ? { type: 'ariaSnapshot', ...where } : { type: 'ariaSnapshot', target: tgt(m[1], q), ...where };
    } },
  // ---------------------------------------------------------------- negated text and value
  { name: 'text-not-contains', re: new RegExp(String.raw`^(.+?)\s+(?:does\s+not|doesn't)\s+(?:contain|include|show|display)(?:\s+(?:the\s+)?text)?\s+(${Q})$`, 'i'),
    build: (m, q) => (isPage(m[1]) ? undefined : { type: 'textNot', target: tgt(m[1], q), value: val(m[2], q), mode: 'contains', field: 'text' }) },
  { name: 'text-not-equals', re: new RegExp(String.raw`^(.+?)\s+(?:does\s+not|doesn't)\s+(?:have|show)\s+(?:the\s+)?(text|value)\s+(${Q})$|^(?:the\s+)?(text|value)\s+of\s+(.+?)\s+is\s+not\s+(${Q})$`, 'i'),
    build: (m, q) => {
      const subject = m[1] ?? m[5];
      if (isPage(subject)) return undefined;
      return { type: 'textNot', target: tgt(subject, q), value: val(m[3] ?? m[6], q), mode: 'equals', field: (m[2] ?? m[4]).toLowerCase() as 'text' };
    } },
  // ---------------------------------------------------------------- page title and text patterns
  { name: 'title-matches', re: /^(?:the\s+)?(?:page\s+|window\s+)?title\s+(matches|does\s+not\s+match|doesn't\s+match)\s+(.+)$/i,
    build: (m, q) => ({ type: 'pageMatches', what: 'title', ...pattern(m[2], q), ...(/not/i.test(m[1]) ? { negate: true } : {}) }) },
  { name: 'page-text-matches', re: /^(?:the\s+)?(?:page|screen)(?:\s+text)?\s+(matches|does\s+not\s+match|doesn't\s+match)\s+(?:the\s+pattern\s+)?(.+)$/i,
    build: (m, q) => ({ type: 'pageMatches', what: 'text', ...pattern(m[2], q), ...(/not/i.test(m[1]) ? { negate: true } : {}) }) },
];

const OP_WORD = { equals: 'is', contains: 'contains', matches: 'matches', ne: 'is not' } as const;

/** Canonical phrase of a depth condition, or undefined for other condition types. */
export function depthConditionToText(c: Condition): string | undefined {
  switch (c.type) {
    case 'accessible':
      if (c.property === 'role') return c.op === 'equals' ? `${c.target.description} has role ${quoteText(c.value)}` : `the role of ${c.target.description} ${OP_WORD[c.op]} ${quoteText(c.value)}`;
      if (c.op === 'equals') return `${c.target.description} has accessible ${c.property} ${quoteText(c.value)}`;
      return `the accessible ${c.property} of ${c.target.description} ${OP_WORD[c.op]} ${quoteText(c.value)}`;
    case 'ariaSnapshot': {
      const ref = c.file ?? c.name;
      if (!ref) throw new Error('an inline aria snapshot cannot be expressed in .ez; keep it in YAML/JSON or use a snapshot file');
      return `${c.target ? c.target.description : 'the page'} matches the aria snapshot ${quoteText(ref)}`;
    }
    case 'textNot':
      if (c.mode === 'contains') return `${c.target.description} does not contain ${quoteText(c.value)}`;
      return `${c.target.description} does not have ${c.field} ${quoteText(c.value)}`;
    case 'pageMatches': {
      const p = c.flags ? `/${c.pattern}/${c.flags}` : c.pattern;
      return `${c.what === 'title' ? 'the title' : 'the page text'} ${c.negate ? 'does not match' : 'matches'} ${quoteText(p)}`;
    }
    default:
      return undefined;
  }
}
