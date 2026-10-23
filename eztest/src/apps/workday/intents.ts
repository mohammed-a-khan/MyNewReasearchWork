/** Plain-English Workday phrasings; every line names Workday. */
import type { Journey } from '../../core/index.js';
import type { IntentRule, ParseEzOptions } from '../../intent/index.js';
import { ASSERT, CONTAIN, Q, TO_BE, V, categorize, custom, parsePairs, parseWithRules } from '../common/intents.js';

const WD = 'workday';
const EXPECT_ERR = String.raw`(?:\s+and\s+expect(?:ing)?\s+(?:the\s+|an?\s+)?error\s+(?:containing\s+)?(.+))?`;

export function createWorkdayIntentRules(): IntentRule[] {
  return categorize('Workday', [
    { name: 'wd-login', keywords: ['log', 'login', 'sign'], example: 'Log in to Workday as hr',
      re: new RegExp(String.raw`^(?:log\s*in|login|sign\s*in)\s+(?:to\s+)?${WD}\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('wd.login', { role: V(m[1], q) }) },
    { name: 'wd-verify-soap', keywords: ['verify', 'expect', 'check'], example: 'Verify in Workday SOAP that employee "21004" has Business_Title = "Software Engineer"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+${WD}\s+soap\s+(?:that\s+)?(?:the\s+)?employee\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.verifySoap', { employeeId: V(m[1], q), expect: parsePairs(m[2], q) }) },
    { name: 'wd-verify-worker', keywords: ['verify', 'expect', 'check'], example: 'Verify in Workday that worker "Ada Lovelace" has "Worker Status" = "Active"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+${WD}\s+(?:that\s+)?(?:the\s+)?(?:worker|employee)\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.verifyWorker', { worker: V(m[1], q), expect: parsePairs(m[2], q) }) },
    { name: 'wd-expect-confirmation', keywords: ['expect', 'verify', 'check'], example: 'Expect the Workday confirmation to contain "You have submitted"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${WD}\s+confirmation\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.expectConfirmation', { text: V(m[1], q) }) },
    { name: 'wd-expect-error', keywords: ['expect', 'verify', 'check'], example: 'Expect the Workday error to contain "is required"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?${WD}\s+errors?\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.expectError', { text: V(m[1], q) }) },
    { name: 'wd-expect-field-state', keywords: ['expect', 'verify', 'check'], example: 'Expect Workday field "Time Type" to be mandatory',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${WD}\s+field\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(mandatory|required|read[\s-]?only|editable|hidden|not\s+visible)$`, 'i'),
      build: (m, q) => {
        const s = m[2].toLowerCase().replace(/\s+/g, '-');
        return custom('wd.expectFieldState', { field: V(m[1], q), state: s === 'required' ? 'mandatory' : s === 'readonly' ? 'read-only' : s === 'not-visible' ? 'hidden' : s });
      } },
    { name: 'wd-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect Workday field "Business Title" to be "Software Engineer"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${WD}\s+field\s+${Q}\s+${TO_BE}\s+${Q}$`, 'i'),
      build: (m, q) => custom('wd.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'wd-expect-task', keywords: ['expect', 'verify', 'check'], example: 'Expect the Workday task "Hire Employee" to be unavailable',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${WD}\s+task\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(available|visible|unavailable|hidden|not\s+available)$`, 'i'),
      build: (m, q) => custom('wd.expectTask', { task: V(m[1], q), visible: /^(available|visible)$/i.test(m[2]) }) },
    { name: 'wd-expect-inbox', keywords: ['expect', 'verify', 'check'], example: 'Expect the Workday inbox to contain "Hire: Ada Lovelace"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${WD}\s+inbox\s+(not\s+to\s+contain|to\s+not\s+contain|does\s+not\s+contain|${CONTAIN.slice(3, -1)})\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.expectInbox', { item: V(m[2], q), present: !/not/i.test(m[1]) }) },
    { name: 'wd-open-inbox-item', keywords: ['open'], example: 'Open the Workday inbox item "Hire: Ada Lovelace"',
      re: new RegExp(String.raw`^open\s+(?:the\s+)?${WD}\s+inbox\s+item\s+${Q}$`, 'i'),
      build: (m, q) => custom('wd.openInboxItem', { item: V(m[1], q) }) },
    { name: 'wd-open-task', keywords: ['open', 'start', 'run'], example: 'Open the Workday task "Hire Employee"',
      re: new RegExp(String.raw`^(?:open|start|run|search\s+for)\s+(?:the\s+)?${WD}\s+task\s+${Q}$`, 'i'),
      build: (m, q) => custom('wd.openTask', { task: V(m[1], q) }) },
    { name: 'wd-open-worker', keywords: ['open', 'find'], example: 'Open the Workday worker "Alex Jones"',
      re: new RegExp(String.raw`^(?:open|find|go\s+to)\s+(?:the\s+)?${WD}\s+(?:worker|employee|person|profile\s+of)\s+${Q}$`, 'i'),
      build: (m, q) => custom('wd.openWorker', { worker: V(m[1], q) }) },
    { name: 'wd-related-action', keywords: ['run', 'use', 'open'], example: 'Run the Workday related action "Job Change > Change Job"',
      re: new RegExp(String.raw`^(?:run|use|open|choose)\s+(?:the\s+)?${WD}\s+related\s+action\s+${Q}$`, 'i'),
      build: (m, q) => custom('wd.relatedAction', { path: V(m[1], q) }) },
    { name: 'wd-set-field', keywords: ['set', 'change', 'enter'], example: 'Set Workday field "Hire Date" to "2026-11-02"',
      re: new RegExp(String.raw`^(?:set|change|enter|fill|select)\s+(?:the\s+)?${WD}\s+(?:field|prompt)\s+${Q}\s+(?:to|with)\s+(.+)$`, 'i'),
      build: (m, q) => custom('wd.setField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'wd-submit', keywords: ['submit'], example: 'Submit the Workday task',
      re: new RegExp(String.raw`^submit\s+the\s+${WD}\s+(?:task|form|business\s+process)${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('wd.submit', { ...(m[1] ? { expectError: V(m[1], q) } : {}) }) },
    { name: 'wd-inbox-action', keywords: ['approve', 'send', 'deny'], example: 'Approve the Workday inbox item',
      re: new RegExp(String.raw`^(approve|send\s+back|deny)\s+the\s+${WD}\s+(?:inbox\s+item|task|business\s+process)${EXPECT_ERR}$`, 'i'),
      build: (m, q) => custom('wd.inboxAction', { action: m[1].toLowerCase().startsWith('send') ? 'Send Back' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), ...(m[2] ? { expectError: V(m[2], q) } : {}) }) },
  ]);
}

export const WORKDAY_INTENT_RULES: IntentRule[] = createWorkdayIntentRules();

export function parseWorkdayEzScript(text: string, opts: ParseEzOptions = {}): Journey {
  return parseWithRules(text, WORKDAY_INTENT_RULES, opts);
}
