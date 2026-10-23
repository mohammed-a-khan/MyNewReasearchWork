/**
 * Plain-English post-conditions ("the URL contains /dashboard", 'the
 * "Order created" message is visible', "there are 2 rows in the Recent orders
 * table") parsed into declarative core Conditions, and rendered back.
 */
import type { Condition, Target } from '../core/index.js';
import { isQuoted, literal, protectQuotes, quoteText, restoreQuotes } from './quotes.js';
import { describeTarget } from './target.js';
import { tableRowsTarget } from './table-target.js';
import { ADVANCED_CONDITION_RULES, FALLBACK_CONDITION_RULES, advancedConditionToText } from './conditions-ext.js';
import { CONTRACT_CONDITION_RULES, apiContractConditionText } from '../contracts/condition-rules.js';
import { DEPTH_CONDITION_RULES, depthConditionToText } from './conditions-depth.js';

export interface CondRule {
  name: string;
  re: RegExp;
  build(m: RegExpExecArray, q: string[]): Condition | undefined;
}

const val = (s: string, q: string[]) => literal(s, q);
const tgt = (s: string, q: string[]): Target => describeTarget(restoreQuotes(s.trim(), q));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export { tableRowsTarget };

/** Ordered condition grammar. The first rule whose regex matches and whose builder succeeds wins. */
export const CONDITION_RULES: CondRule[] = [
  // "The screen" of a desktop, terminal, SAP or Citrix surface (and the web page): see docs/desktop-and-legacy.md.
  { name: 'screen-not-contains', re: /^(?:the\s+)?(?:terminal\s+|mainframe\s+|sap\s+|desktop\s+)?screen\s+(?:does\s+not|doesn't|do\s+not)\s+(?:contain|show|display|include|have)(?:\s+(?:the\s+)?text)?\s+(.+)$/i,
    build: (m, q) => ({ type: 'pageNotContainsText', value: val(m[1], q) }) },
  { name: 'screen-contains', re: /^(?:the\s+)?(?:terminal\s+|mainframe\s+|sap\s+|desktop\s+)?screen\s+(?:contains|shows|displays|includes|has)(?:\s+(?:the\s+)?text)?\s+(.+)$/i,
    build: (m, q) => ({ type: 'pageContainsText', value: val(m[1], q) }) },
  // API contract conformance ("response x conforms to OpenAPI ...").
  ...CONTRACT_CONDITION_RULES,
  // Accessible name/role, aria snapshots, negated text, title/page patterns (before the generic "has"/"contains" forms).
  ...DEPTH_CONDITION_RULES,
  // Advanced expectations (attributes, states, counts, tabs, dialogs, console, network, cookies, ...) come first.
  ...ADVANCED_CONDITION_RULES,
  { name: 'page-not-contains', re: /^(?:the\s+)?(?:page|screen)\s+(?:does\s+not|doesn't|do\s+not)\s+(?:contain|show|display|include|have)(?:\s+(?:the\s+)?text)?\s+(.+)$/i,
    build: (m, q) => ({ type: 'pageNotContainsText', value: val(m[1], q) }) },
  { name: 'page-contains', re: /^(?:the\s+)?(?:page|screen)\s+(?:contains|shows|displays|includes|has)(?:\s+(?:the\s+)?text)?\s+(.+)$/i,
    build: (m, q) => ({ type: 'pageContainsText', value: val(m[1], q) }) },
  { name: 'not-see', re: /^(?:i\s+|we\s+|user\s+)?(?:do\s+not|don't|cannot|can't|can\s+not|does\s+not|doesn't|should\s+not|shouldn't|must\s+not)\s+see\s+(?:the\s+text\s+)?(.+)$/i,
    build: (m, q) => (isQuoted(m[1]) ? { type: 'pageNotContainsText', value: val(m[1], q) } : { type: 'hidden', target: tgt(m[1], q) }) },
  { name: 'see', re: /^(?:i\s+|we\s+|user\s+)?(?:can\s+|should\s+|must\s+)?sees?\s+(?:the\s+text\s+)?(.+)$/i,
    build: (m, q) => (isQuoted(m[1]) ? { type: 'pageContainsText', value: val(m[1], q) } : { type: 'visible', target: tgt(m[1], q) }) },
  { name: 'text-not-shown', re: /^(?:the\s+)?text\s+(⟦\d+⟧)\s+(?:is\s+not|isn't)\s+(?:visible|shown|displayed|present|on\s+the\s+page)$/i,
    build: (m, q) => ({ type: 'pageNotContainsText', value: val(m[1], q) }) },
  { name: 'text-shown', re: /^(?:the\s+)?text\s+(⟦\d+⟧)\s+(?:is\s+(?:visible|shown|displayed|present|on\s+the\s+page)|appears)$/i,
    build: (m, q) => ({ type: 'pageContainsText', value: val(m[1], q) }) },
  { name: 'url-contains', re: /^(?:the\s+)?(?:current\s+|page\s+)?(?:url|address)\s+(?:contains|includes|has)\s+(.+)$/i,
    build: (m, q) => ({ type: 'urlContains', value: val(m[1], q) }) },
  { name: 'url-matches', re: /^(?:the\s+)?(?:current\s+|page\s+)?(?:url|address)\s+matches\s+(.+)$/i,
    build: (m, q) => {
      const raw = isQuoted(m[1]) ? val(m[1], q) : m[1].trim();
      const sl = /^\/(.+)\/$/.exec(raw);
      return { type: 'urlMatches', pattern: sl ? sl[1] : raw };
    } },
  { name: 'url-is', re: /^(?:the\s+)?(?:current\s+|page\s+)?(?:url|address)\s+(?:is|equals)\s+(.+)$/i,
    build: (m, q) => {
      const v = val(m[1], q);
      return { type: 'urlMatches', pattern: /^https?:\/\//i.test(v) ? `^${escapeRe(v)}$` : `^https?://[^/]+${escapeRe(v)}(?:[?#].*)?$` };
    } },
  { name: 'title', re: /^(?:the\s+)?(?:page\s+|window\s+)?title\s+(?:contains|includes|has|is|equals)\s+(.+)$/i,
    build: (m, q) => ({ type: 'titleContains', value: val(m[1], q) }) },
  { name: 'ledger-equals', re: /^\$\{([\w.]+)\}\s+(?:equals|is|==|matches)\s+(.+)$/i,
    build: (m, q) => ledger(m[1], m[2], q) },
  { name: 'captured-equals', re: /^(?:the\s+)?(?:captured|stored|remembered)\s+(?:value\s+)?([\w.]+)\s+(?:equals|is|==)\s+(.+)$/i,
    build: (m, q) => ledger(m[1], m[2], q) },
  { name: 'api-status', re: /^(?:the\s+)?(?:api\s+)?(?:response\s+)?([\w.]+)\s+(?:has\s+)?(?:status|status\s+code)\s+(?:is\s+|equals\s+|==\s+|of\s+)?(\d{3})$/i,
    build: (m) => ({ type: 'apiStatus', captureKey: m[1], status: Number(m[2]) }) },
  { name: 'api-response-status', re: /^(?:the\s+)?([\w.]+)\s+(?:api\s+)?response\s+(?:status|status\s+code)\s+(?:is\s+|equals\s+|==\s+|of\s+)?(\d{3})$/i,
    build: (m) => ({ type: 'apiStatus', captureKey: m[1], status: Number(m[2]) }) },
  { name: 'api-status-of', re: /^(?:the\s+)?status\s+(?:code\s+)?of\s+([\w.]+)\s+(?:is|equals)\s+(\d{3})$/i,
    build: (m) => ({ type: 'apiStatus', captureKey: m[1], status: Number(m[2]) }) },
  { name: 'db-rows', re: /^(?:the\s+)?(?:query|result|results)\s+([\w.]+)\s+(?:returns|returned|has|contains)\s+(\d+)\s+rows?$/i,
    build: (m) => ({ type: 'dbRowCount', captureKey: m[1], equals: Number(m[2]) }) },
  { name: 'download-exists', re: /^(?:the\s+)?(?:download|downloaded\s+file|file)\s+([\w.]+)\s+(?:exists|was\s+downloaded|is\s+downloaded|is\s+saved|was\s+saved)$/i,
    build: (m) => ({ type: 'downloadExists', captureKey: m[1] }) },
  { name: 'rows-in-table', re: /^(?:there\s+(?:is|are)\s+)?(\d+)\s+rows?\s+(?:in|of)\s+(.+)$/i,
    build: (m, q) => ({ type: 'count', target: tableRowsTarget(restoreQuotes(m[2], q)), equals: Number(m[1]) }) },
  { name: 'table-has-rows', re: /^(.+?)\s+(?:has|have|contains|shows)\s+(\d+)\s+rows?$/i,
    build: (m, q) => ({ type: 'count', target: tableRowsTarget(restoreQuotes(m[1], q)), equals: Number(m[2]) }) },
  { name: 'has-n-items', re: /^(.+?)\s+(?:has|have|contains|shows)\s+(\d+)\s+(?:items|elements|entries|matches|occurrences)$/i,
    build: (m, q) => ({ type: 'count', target: tgt(m[1], q), equals: Number(m[2]) }) },
  { name: 'number-of', re: /^(?:the\s+)?(?:number|count)\s+of\s+(.+?)\s+(?:is|equals)\s+(\d+)$/i,
    build: (m, q) => ({ type: 'count', target: tgt(m[1], q), equals: Number(m[2]) }) },
  { name: 'there-are-n', re: /^there\s+(?:is|are)\s+(\d+)\s+(.+)$/i,
    build: (m, q) => ({ type: 'count', target: tgt(m[2], q), equals: Number(m[1]) }) },
  { name: 'hidden', re: /^(.+?)\s+(?:is\s+(?:hidden|not\s+visible|not\s+shown|not\s+displayed|not\s+present|gone|invisible|absent)|isn't\s+(?:visible|shown|displayed|present)|disappears|does\s+not\s+exist|doesn't\s+exist)$/i,
    build: (m, q) => ({ type: 'hidden', target: tgt(m[1], q) }) },
  { name: 'visible', re: /^(.+?)\s+(?:is\s+(?:visible|shown|displayed|present|on\s+the\s+page)|appears|exists)$/i,
    build: (m, q) => ({ type: 'visible', target: tgt(m[1], q) }) },
  { name: 'value-of', re: /^(?:the\s+)?value\s+of\s+(.+?)\s+(?:is|equals)\s+(.+)$/i,
    build: (m, q) => ({ type: 'valueEquals', target: tgt(m[1], q), value: val(m[2], q) }) },
  { name: 'has-value', re: /^(.+?)\s+(?:has\s+(?:the\s+)?value|value\s+is|value\s+equals)\s+(.+)$/i,
    build: (m, q) => ({ type: 'valueEquals', target: tgt(m[1], q), value: val(m[2], q) }) },
  { name: 'text-of', re: /^(?:the\s+)?text\s+of\s+(.+?)\s+(?:is|equals)\s+(.+)$/i,
    build: (m, q) => ({ type: 'textEquals', target: tgt(m[1], q), value: val(m[2], q) }) },
  { name: 'has-text', re: /^(.+?)\s+(?:has\s+(?:the\s+)?text|text\s+is|text\s+equals|reads|says)\s+(.+)$/i,
    build: (m, q) => ({ type: 'textEquals', target: tgt(m[1], q), value: val(m[2], q) }) },
  { name: 'contains-text', re: /^(.+?)\s+(?:contains|includes|shows|displays)(?:\s+(?:the\s+)?text)?\s+(.+)$/i,
    build: (m, q) => ({ type: 'textContains', target: tgt(m[1], q), value: val(m[2], q) }) },
  // Last resort: a safe expression ("${total} > 100", "len(rows) >= 2").
  ...FALLBACK_CONDITION_RULES,
];

function ledger(key: string, rhs: string, q: string[]): Condition {
  const other = /^\$\{([\w.]+)\}$/.exec(rhs.trim());
  if (other) return { type: 'ledgerEquals', key, otherKey: other[1] };
  return { type: 'ledgerEquals', key, expected: val(rhs, q) };
}

/** Normalise "should be/should contain/must be" phrasing into the indicative grammar. */
function normalise(s: string): string {
  return s
    .replace(/\s+(?:should|must|will)\s+not\s+be\s+/gi, ' is not ')
    .replace(/\s+(?:should|must|will)\s+be\s+/gi, ' is ')
    .replace(/\s+(?:should|must|will)\s+(contain|include|show|display|have|equal|match|exist|appear|read|say|return|disappear)\b/gi,
      (_w, v: string) => ' ' + (v.toLowerCase() === 'match' ? 'matches' : v.toLowerCase() + 's'))
    .replace(/\bhaves\b/gi, 'has')
    .replace(/\bequals\b/gi, 'equals')
    .replace(/[.!]\s*$/, '')
    .trim();
}

/** Parse one condition phrase (without the Expect/Verify prefix). Returns undefined if no rule matches. */
/**
 * Rewrite assertion-library style phrasing ("X to contain Y", "X not to be visible")
 * into the indicative forms the rules understand ("X contains Y", "X is not visible").
 */
export function indicative(body: string): string {
  const verbs: Array<[RegExp, string]> = [
    [/\s+(?:not\s+to|to\s+not)\s+(contain|show|display|include|have)\b/i, ' does not $1'],
    [/\s+(?:not\s+to|to\s+not)\s+be\b/i, ' is not'],
    [/\s+to\s+be\b/i, ' is'],
    [/\s+to\s+(contain|include|show|display|equal|match|read|say|appear|exist)\b/i, ' $1s'],
    [/\s+to\s+have\b/i, ' has'],
  ];
  for (const [re, rep] of verbs) {
    if (re.test(body)) return body.replace(re, rep);
  }
  return body;
}

export function tryParseCondition(text: string): Condition | undefined {
  const { text: p, quotes } = protectQuotes(text.trim());
  const base = normalise(p).replace(/^that\s+/i, '');
  const alt = indicative(base);
  for (const body of alt === base ? [base] : [base, alt]) {
    const c = matchCondition(body, quotes);
    if (c) return c;
  }
  return undefined;
}

function matchCondition(body: string, quotes: string[]): Condition | undefined {
  for (const r of CONDITION_RULES) {
    const m = r.re.exec(body);
    if (!m) continue;
    try {
      const c = r.build(m, quotes);
      if (c) return c;
    } catch {
      // Rule matched lexically but could not build (e.g. unnamed target); try the next one.
    }
  }
  return undefined;
}

/** Parse one condition phrase or throw a descriptive error. */
export function parseCondition(text: string): Condition {
  const c = tryParseCondition(text);
  if (!c) {
    throw new Error(
      `Cannot understand the expectation "${text}". Try e.g. 'page contains "Saved"', 'URL contains "/dashboard"', ` +
        `'the "Saved" message is visible', 'the Status field has value "Open"', 'there are 2 rows in the Orders table'.`,
    );
  }
  return c;
}

/** Render a condition as an .ez expectation phrase that parses back to the same condition. */
export function conditionToText(c: Condition): string {
  switch (c.type) {
    case 'urlContains': return `URL contains ${quoteText(c.value)}`;
    case 'urlMatches': return `URL matches ${quoteText(c.pattern)}`;
    case 'titleContains': return `title contains ${quoteText(c.value)}`;
    case 'visible': return `${c.target.description} is visible`;
    case 'hidden': return `${c.target.description} is hidden`;
    case 'textContains': return `${c.target.description} contains ${quoteText(c.value)}`;
    case 'textEquals': return `${c.target.description} has text ${quoteText(c.value)}`;
    case 'valueEquals': return `${c.target.description} has value ${quoteText(c.value)}`;
    case 'count':
      return `there are ${c.equals} ${c.target.description}`;
    case 'pageContainsText': return `page contains ${quoteText(c.value)}`;
    case 'pageNotContainsText': return `page does not contain ${quoteText(c.value)}`;
    case 'ledgerEquals':
      if (c.otherKey) return `\${${c.key}} equals \${${c.otherKey}}`;
      if (c.expected === undefined) throw new Error(`ledgerEquals on ${c.key} has neither expected nor otherKey`);
      return `\${${c.key}} equals ${quoteText(c.expected)}`;
    case 'apiStatus': return `response ${c.captureKey} status is ${c.status}`;
    case 'dbRowCount': return `query ${c.captureKey} returns ${c.equals} rows`;
    case 'downloadExists': return `download ${c.captureKey} exists`;
    case 'apiContract': return apiContractConditionText(c);
    default: return depthConditionToText(c) ?? advancedConditionToText(c);
  }
}
