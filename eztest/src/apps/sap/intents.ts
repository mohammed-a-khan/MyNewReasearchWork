/**
 * Plain-English SAP Fiori phrasings. Every line names "Fiori" (or "SAP
 * OData"), so these never collide with the SAP GUI rung's phrasings
 * ("Set SAP field", "Press SAP button", "Run transaction", "the SAP status
 * bar"), which keep driving SAP GUI for Windows through the desktop bridge.
 */
import type { Journey } from '../../core/index.js';
import type { IntentRule, ParseEzOptions } from '../../intent/index.js';
import { ASSERT, CONTAIN, Q, TO_BE, V, categorize, custom, parsePairs, parseWithRules } from '../common/intents.js';

const FIORI = String.raw`(?:sap\s+)?fiori`;
const EXPECT_ERR = String.raw`(?:\s+and\s+expect(?:ing)?\s+(?:the\s+|an?\s+)?error\s+(?:containing\s+)?(.+))?`;

export function createFioriIntentRules(): IntentRule[] {
  return categorize('SAP Fiori', [
    { name: 'fiori-login', keywords: ['log', 'login', 'sign'], example: 'Log in to SAP Fiori as clerk',
      re: new RegExp(String.raw`^(?:log\s*(?:in|on)|login|sign\s*in)\s+(?:to\s+)?(?:the\s+)?${FIORI}(?:\s+launchpad)?\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('fiori.login', { role: V(m[1], q) }) },

    { name: 'fiori-verify-odata', keywords: ['verify', 'expect', 'check'], example: 'Verify in SAP OData that A_SalesOrder "4711" has SalesOrderType = "OR"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+(?:sap|s/?4\s*hana)(?:\s+odata)?\s+(?:that\s+)?(?:the\s+)?(⟦\d+⟧|[A-Za-z]\w*(?:\s+[A-Za-z]\w*)?)\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('fiori.verifyOData', { entity: V(m[1], q), key: V(m[2], q), expect: parsePairs(m[3], q) }) },
    { name: 'fiori-expect-field-state', keywords: ['expect', 'verify', 'check'], example: 'Expect Fiori field "Customer Reference" to be mandatory',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+field\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(mandatory|required|read[\s-]?only|editable|hidden|not\s+visible)$`, 'i'),
      build: (m, q) => {
        const s = m[2].toLowerCase().replace(/\s+/g, '-');
        return custom('fiori.expectFieldState', { field: V(m[1], q), state: s === 'required' ? 'mandatory' : s === 'readonly' ? 'read-only' : s === 'not-visible' ? 'hidden' : s });
      } },
    { name: 'fiori-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect Fiori field "Sales Order Type" to be "Standard Order"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+field\s+${Q}\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => custom('fiori.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'fiori-expect-toast', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori toast to contain "created"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?${FIORI}\s+(?:message\s+)?toast\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('fiori.expectMessage', { kind: 'toast', text: V(m[1], q) }) },
    { name: 'fiori-expect-popover', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori message popover to contain "Enter a purchase order number"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+(?:message\s+popover|messages)\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('fiori.expectMessage', { kind: 'popover', text: V(m[1], q) }) },
    { name: 'fiori-expect-table-count', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori table to have 2 rows',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+(?:table|list)\s+(?:to\s+have|has|should\s+have)\s+(\d+)\s+rows?$`, 'i'),
      build: (m) => custom('fiori.expectTable', { count: Number(m[1]) }) },
    { name: 'fiori-expect-table', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori table to contain "4711"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+(?:table|list)\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('fiori.expectTable', { value: V(m[1], q) }) },
    { name: 'fiori-expect-tile', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori tile "Manage Products" to be hidden',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+(?:tile|app)\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(visible|available|hidden|not\s+visible|unavailable)$`, 'i'),
      build: (m, q) => custom('fiori.expectTile', { app: V(m[1], q), visible: /^(visible|available)$/i.test(m[2]) }) },
    { name: 'fiori-expect-value-help', keywords: ['expect', 'verify', 'check'], example: 'Expect the Fiori value help for "Sold-To Party" to contain "Domestic Customer US 11"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${FIORI}\s+value\s+help\s+(?:for|of)\s+(?:the\s+)?(filter\s+)?${Q}\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('fiori.expectValueHelp', { field: V(m[2], q), value: V(m[3], q), ...(m[1] ? { filter: true } : {}) }) },

    { name: 'fiori-open-app', keywords: ['open', 'launch', 'start'], example: 'Open the Fiori app "Manage Sales Orders"',
      re: new RegExp(String.raw`^(?:open|launch|start|go\s+to)\s+(?:the\s+)?${FIORI}\s+(?:app|tile|application)\s+${Q}$`, 'i'),
      build: (m, q) => custom('fiori.openApp', { app: V(m[1], q) }) },
    { name: 'fiori-open-item', keywords: ['open', 'select'], example: 'Open the Fiori list item "4711"',
      re: new RegExp(String.raw`^(?:open|select|navigate\s+to)\s+(?:the\s+)?${FIORI}\s+(?:list\s+item|table\s+row|row|item|object)\s+${Q}$`, 'i'),
      build: (m, q) => custom('fiori.openItem', { value: V(m[1], q) }) },
    { name: 'fiori-set-field', keywords: ['set', 'change', 'enter'], example: 'Set Fiori field "Sold-To Party" to "17100002" using the value help',
      re: new RegExp(String.raw`^(?:set|change|enter|fill)\s+(?:the\s+)?${FIORI}\s+(field|filter)\s+${Q}\s+(?:to|with)\s+${Q}(\s+(?:using|via|from|through)\s+the\s+value\s+help)?$`, 'i'),
      build: (m, q) => custom('fiori.setField', { field: V(m[2], q), value: V(m[3], q), ...(m[1].toLowerCase() === 'filter' ? { filter: true } : {}), ...(m[4] ? { valueHelp: true } : {}) }) },
    { name: 'fiori-press', keywords: ['press', 'click'], example: 'Press the Fiori button "Go"',
      re: new RegExp(String.raw`^(?:press|click|choose|tap)\s+(?:the\s+)?${FIORI}\s+button\s+${Q}$`, 'i'),
      build: (m, q) => custom('fiori.press', { button: V(m[1], q) }) },
    { name: 'fiori-save', keywords: ['save', 'create'], example: 'Save the Fiori object',
      re: new RegExp(String.raw`^(?:save|create|submit)\s+the\s+${FIORI}\s+(?:object|record|document|entry)${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('fiori.save', { ...(m[1] ? { expectError: V(m[1], q) } : {}) }) },
  ]);
}

export const FIORI_INTENT_RULES: IntentRule[] = createFioriIntentRules();

export function parseFioriEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  return parseWithRules(text, FIORI_INTENT_RULES, opts);
}
