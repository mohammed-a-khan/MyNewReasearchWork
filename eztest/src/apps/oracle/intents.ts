/** Plain-English Oracle phrasings (Fusion Redwood and EBS OA Framework); every line names Oracle. */
import type { Journey } from '../../core/index.js';
import type { IntentRule, ParseEzOptions } from '../../intent/index.js';
import { ASSERT, CONTAIN, Q, TO_BE, V, categorize, custom, parsePairs, parseWithRules } from '../common/intents.js';

const ORA = String.raw`oracle(?:\s+(fusion|ebs|e-business\s+suite|cloud))?`;
const sys = (s?: string) => (s && /^(ebs|e-business)/i.test(s) ? { system: 'ebs' } : {});

export function createOracleIntentRules(): IntentRule[] {
  return categorize('Oracle', [
    { name: 'ora-login', keywords: ['log', 'login', 'sign'], example: 'Log in to Oracle Fusion as buyer',
      re: new RegExp(String.raw`^(?:log\s*in|login|sign\s*in)\s+(?:to\s+)?${ORA}\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('oracle.login', { role: V(m[2], q), ...sys(m[1]) }) },
    { name: 'ora-verify-rest', keywords: ['verify', 'expect', 'check'], example: 'Verify in Oracle Fusion that purchase order "1002" has Supplier = "Lee Supplies"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+oracle(?:\s+fusion)?(?:\s+rest)?\s+(?:that\s+)?(?:the\s+)?(⟦\d+⟧|[A-Za-z]\w*(?:\s+[A-Za-z]\w*)?)\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('oracle.verifyRest', { resource: V(m[1], q), key: V(m[2], q), expect: parsePairs(m[3], q) }) },
    { name: 'ora-expect-field-state', keywords: ['expect', 'verify', 'check'], example: 'Expect Oracle field "Requisitioning BU" to be mandatory',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ORA}\s+field\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(mandatory|required|read[\s-]?only|editable|hidden|not\s+visible)$`, 'i'),
      build: (m, q) => {
        const s = m[3].toLowerCase().replace(/\s+/g, '-');
        return custom('oracle.expectFieldState', { field: V(m[2], q), state: s === 'required' ? 'mandatory' : s === 'readonly' ? 'read-only' : s === 'not-visible' ? 'hidden' : s });
      } },
    { name: 'ora-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect Oracle field "Buyer" to be "Casey Brown"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ORA}\s+field\s+${Q}\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => custom('oracle.expectField', { field: V(m[2], q), value: V(m[3], q) }) },
    { name: 'ora-expect-message', keywords: ['expect', 'verify', 'check'], example: 'Expect the Oracle message to contain "submitted"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|an?\s+)?${ORA}\s+(message|error|confirmation)s?\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('oracle.expectMessage', { text: V(m[3], q), kind: m[2].toLowerCase() === 'error' ? 'error' : m[2].toLowerCase() === 'confirmation' ? 'info' : 'any' }) },
    { name: 'ora-expect-table-count', keywords: ['expect', 'verify', 'check'], example: 'Expect the Oracle table "Lines" to have 2 rows',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ORA}\s+table\s+${Q}\s+(?:to\s+have|has|should\s+have)\s+(\d+)\s+rows?$`, 'i'),
      build: (m, q) => custom('oracle.expectTable', { table: V(m[2], q), count: Number(m[3]) }) },
    { name: 'ora-expect-table', keywords: ['expect', 'verify', 'check'], example: 'Expect the Oracle table "Purchase Orders" to contain "Lee Supplies"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ORA}\s+table\s+${Q}\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('oracle.expectTable', { table: V(m[2], q), value: V(m[3], q) }) },
    { name: 'ora-expect-page', keywords: ['expect', 'verify', 'check'], example: 'Expect the Oracle page "Create Purchase Order" to be unavailable',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ORA}\s+page\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(available|visible|unavailable|hidden|not\s+available)$`, 'i'),
      build: (m, q) => custom('oracle.expectPage', { page: V(m[2], q), visible: /^(available|visible)$/i.test(m[3]) }) },
    { name: 'ora-open-page', keywords: ['open', 'go', 'navigate'], example: 'Open the Oracle page "Create Purchase Order"',
      re: new RegExp(String.raw`^(?:open|go\s+to|navigate\s+to)\s+(?:the\s+)?${ORA}\s+(?:page|function|task)\s+${Q}$`, 'i'),
      build: (m, q) => custom('oracle.navigate', { page: V(m[2], q), ...sys(m[1]) }) },
    { name: 'ora-set-cell', keywords: ['set'], example: 'Set Oracle table "Lines" row 1 column "Quantity" to "2"',
      re: new RegExp(String.raw`^(?:set|enter|change)\s+(?:the\s+)?${ORA}\s+table\s+${Q}\s+row\s+(\d+)\s+column\s+${Q}\s+to\s+(.+)$`, 'i'),
      build: (m, q) => custom('oracle.setCell', { table: V(m[2], q), row: Number(m[3]), column: V(m[4], q), value: V(m[5], q) }) },
    { name: 'ora-set-field', keywords: ['set', 'change', 'enter'], example: 'Set Oracle field "Category" to "COMPUTER.HARDWARE" using the list of values',
      re: new RegExp(String.raw`^(?:set|change|enter|fill|select)\s+(?:the\s+)?${ORA}\s+field\s+${Q}\s+(?:to|with)\s+${Q}(\s+(?:using|via|from)\s+the\s+(?:list\s+of\s+values|lov|search\s+and\s+select))?$`, 'i'),
      build: (m, q) => custom('oracle.setField', { field: V(m[2], q), value: V(m[3], q), ...(m[4] ? { lov: true } : {}) }) },
    { name: 'ora-press', keywords: ['press', 'click'], example: 'Press the Oracle button "Submit"',
      re: new RegExp(String.raw`^(?:press|click|choose)\s+(?:the\s+)?${ORA}\s+button\s+${Q}$`, 'i'),
      build: (m, q) => custom('oracle.press', { button: V(m[2], q) }) },
  ]);
}

export const ORACLE_INTENT_RULES: IntentRule[] = createOracleIntentRules();

export function parseOracleEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  return parseWithRules(text, ORACLE_INTENT_RULES, opts);
}
