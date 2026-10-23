/**
 * Plain-English ServiceNow phrasings. Every line names ServiceNow, so these
 * never compete with web lines or the D365/Salesforce add-ons.
 */
import type { Journey } from '../../core/index.js';
import type { IntentRule, ParseEzOptions } from '../../intent/index.js';
import { ASSERT, CONTAIN, Q, TO_BE, V, categorize, custom, parsePairs, parseWithRules } from '../common/intents.js';

const SN = String.raw`(?:servicenow|service-now|snow)`;
/** A table: quoted, or one to three words ("incident", "change request"). */
const TBL = String.raw`(⟦\d+⟧|[A-Za-z][\w]*(?:\s+[A-Za-z][\w]*){0,2}?)`;
const EXPECT_ERR = String.raw`(?:\s+and\s+expect(?:ing)?\s+(?:the\s+|an?\s+)?error\s+(?:containing\s+)?(.+))?`;

export function createServiceNowIntentRules(): IntentRule[] {
  return categorize('ServiceNow', [
    { name: 'sn-login', keywords: ['log', 'login', 'sign'], example: 'Log in to ServiceNow as itil',
      re: new RegExp(String.raw`^(?:log\s*in|login|sign\s*in)\s+(?:to\s+)?${SN}\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('sn.login', { role: V(m[1], q) }) },

    // ---------------------------------------------------------------- assertions
    { name: 'sn-verify-record', keywords: ['verify', 'expect', 'check'], example: 'Verify in ServiceNow that incident "INC0010001" has state = "Resolved"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+${SN}\s+(?:that\s+)?(?:the\s+)?${TBL}(?:\s+record)?\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('sn.verifyRecord', { table: V(m[1], q), key: V(m[2], q), expect: parsePairs(m[3], q) }) },
    { name: 'sn-expect-field-state', keywords: ['expect', 'verify', 'check'], example: 'Expect ServiceNow field "Caller" to be mandatory',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SN}\s+field\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(mandatory|required|read[\s-]?only|editable|hidden|not\s+visible)$`, 'i'),
      build: (m, q) => {
        const s = m[2].toLowerCase().replace(/\s+/g, '-');
        const state = s === 'required' ? 'mandatory' : s === 'readonly' ? 'read-only' : s === 'not-visible' ? 'hidden' : s;
        return custom('sn.expectFieldState', { field: V(m[1], q), state });
      } },
    { name: 'sn-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect ServiceNow field "State" to be "In Progress"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SN}\s+(?:field|variable)\s+${Q}\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => custom('sn.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sn-expect-message', keywords: ['expect', 'verify', 'check'], example: 'Expect the ServiceNow info message to contain "created"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?${SN}\s+(info|error)?\s*message\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sn.expectMessage', { kind: (m[1] ?? 'info').toLowerCase(), text: V(m[2], q) }) },
    { name: 'sn-expect-related-list', keywords: ['expect', 'verify', 'check'], example: 'Expect the ServiceNow related list "Task SLAs" to contain "Priority 3 resolution"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SN}\s+related\s+list\s+${Q}\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sn.expectRelatedList', { list: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sn-expect-ui-action', keywords: ['expect', 'verify', 'check'], example: 'Expect the ServiceNow UI action "Resolve" to be hidden',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SN}\s+(?:ui\s+action|button)\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(visible|available|hidden|not\s+visible|unavailable)$`, 'i'),
      build: (m, q) => custom('sn.expectUiAction', { action: V(m[1], q), visible: /^(visible|available)$/i.test(m[2]) }) },
    { name: 'sn-expect-list', keywords: ['expect', 'verify', 'check'], example: 'Expect the ServiceNow incident list to contain "VPN down"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SN}\s+${TBL}\s+list\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sn.expectList', { table: V(m[1], q), value: V(m[2], q) }) },

    // ---------------------------------------------------------------- navigation
    { name: 'sn-open-catalog-item', keywords: ['open'], example: 'Open the ServiceNow catalog item "Standard Laptop"',
      re: new RegExp(String.raw`^(?:open|go\s+to)\s+(?:the\s+)?${SN}\s+(?:catalog|catalogue)\s+item\s+${Q}$`, 'i'),
      build: (m, q) => custom('sn.openCatalogItem', { item: V(m[1], q) }) },
    { name: 'sn-open-list', keywords: ['open', 'go', 'navigate'], example: 'Open the ServiceNow incident list',
      re: new RegExp(String.raw`^(?:open|go\s+to|navigate\s+to)\s+(?:the\s+)?${SN}\s+${TBL}\s+list$`, 'i'),
      build: (m, q) => custom('sn.openList', { table: V(m[1], q) }) },
    { name: 'sn-new-record', keywords: ['create', 'open', 'start'], example: 'Create a new ServiceNow incident',
      re: new RegExp(String.raw`^(?:create|open|start)\s+(?:a\s+|an\s+)?new\s+${SN}\s+${TBL}(?:\s+record)?$`, 'i'),
      build: (m, q) => custom('sn.newRecord', { table: V(m[1], q) }) },
    { name: 'sn-open-record', keywords: ['open'], example: 'Open the ServiceNow incident "INC0010001"',
      re: new RegExp(String.raw`^open\s+(?:the\s+)?${SN}\s+${TBL}(?:\s+record)?\s+${Q}$`, 'i'),
      build: (m, q) => custom('sn.openRecord', { table: V(m[1], q), key: V(m[2], q) }) },

    // ---------------------------------------------------------------- fields and actions
    { name: 'sn-set-field', keywords: ['set', 'change', 'update', 'fill'], example: 'Set ServiceNow field "Short description" to "Printer jam"',
      re: new RegExp(String.raw`^(?:set|change|update|fill)\s+(?:the\s+)?${SN}\s+(?:field|variable)\s+${Q}\s+(?:to|with)\s+(.+)$`, 'i'),
      build: (m, q) => custom('sn.setField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sn-submit', keywords: ['submit'], example: 'Submit the ServiceNow form',
      re: new RegExp(String.raw`^submit\s+the\s+${SN}\s+(?:form|record)${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('sn.uiAction', { action: 'Submit', ...(m[1] ? { expectError: V(m[1], q) } : {}) }) },
    { name: 'sn-update', keywords: ['update', 'save'], example: 'Update the ServiceNow record',
      re: new RegExp(String.raw`^(?:update|save)\s+the\s+${SN}\s+(?:form|record)${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('sn.uiAction', { action: 'Update', ...(m[1] ? { expectError: V(m[1], q) } : {}) }) },
    { name: 'sn-ui-action', keywords: ['click', 'press', 'run'], example: 'Click the ServiceNow UI action "Resolve"',
      re: new RegExp(String.raw`^(?:click|press|run|use)\s+(?:the\s+)?${SN}\s+(?:ui\s+action|button)\s+${Q}${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('sn.uiAction', { action: V(m[1], q), ...(m[2] ? { expectError: V(m[2], q) } : {}) }) },
    { name: 'sn-order', keywords: ['order', 'submit'], example: 'Order the ServiceNow catalog item',
      re: new RegExp(String.raw`^(?:order|submit)\s+the\s+${SN}\s+(?:catalog|catalogue)\s+item${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('sn.orderCatalogItem', { ...(m[1] ? { expectError: V(m[1], q) } : {}) }) },
  ]);
}

export const SERVICENOW_INTENT_RULES: IntentRule[] = createServiceNowIntentRules();

export function parseServiceNowEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  return parseWithRules(text, SERVICENOW_INTENT_RULES, opts);
}
