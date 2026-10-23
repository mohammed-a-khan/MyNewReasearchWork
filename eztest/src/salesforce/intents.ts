/**
 * Plain-English Salesforce phrasings, contributed to the grammar via
 * registerIntentRules(SALESFORCE_INTENT_RULES). Every rule builds a
 * `{ action: 'custom', handler: 'sf.*', args }` step. Generic-looking
 * phrasings ("Open the Accounts tab") only match known object names (or an
 * explicit "Salesforce <Object>"), so registering these rules does not
 * hijack ordinary web lines.
 */
import type { Journey } from '../core/index.js';
import { parseEzScript, registerIntentRules, restoreQuotes, type IntentRule, type ParseEzOptions, type StepBody } from '../intent/index.js';
import { literal } from '../intent/quotes.js';

/** Standard object labels the generic phrasings recognise. */
export const DEFAULT_SALESFORCE_OBJECT_NAMES = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Campaign', 'Product', 'Quote', 'Contract', 'Order', 'Task', 'Event', 'Asset', 'Solution',
];

export function pluralizeLabel(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|ch|sh)$/i.test(name)) return name + 'es';
  return name + 's';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Q = '(⟦\\d+⟧)';
const ASSERT = String.raw`(?:expect|verify|assert|ensure|confirm|check)(?:\s+that)?`;
const TO_BE = String.raw`(?:to\s+(?:be|equal)|is|equals|should\s+be)`;
const CONTAIN = String.raw`(?:to\s+(?:contain|include|have)|contains|includes|should\s+(?:contain|include)|has)`;
const SF = String.raw`(?:salesforce|sf)`;

const V = (s: string, q: string[]) => literal(s, q);
const custom = (handler: string, args: Record<string, unknown>): StepBody => ({ action: 'custom', handler, args });

/** Parse `Industry = "Energy" and "Annual Revenue" is "5000000"` into a record. */
export function parseFieldPairs(s: string, q: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s*(?:,|\band\b)\s*/i)) {
    if (!part.trim()) continue;
    const m = /^(⟦\d+⟧|[A-Za-z][\w.]*)\s*(?:=|:|\bis\b|\bequals\b)\s*(.+)$/i.exec(part.trim());
    if (!m) throw new Error(`Expected Field = "value", got "${restoreQuotes(part, q)}"`);
    out[V(m[1], q)] = V(m[2], q);
  }
  if (!Object.keys(out).length) throw new Error('No Field = "value" pairs given');
  return out;
}

export interface SalesforceIntentOptions {
  /** Extra object labels (custom objects) for the generic phrasings. */
  objects?: string[];
}

/** Build the Salesforce intent rules (optionally recognising extra object labels). */
export function createSalesforceIntentRules(o: SalesforceIntentOptions = {}): IntentRule[] {
  const names = [...new Set([...DEFAULT_SALESFORCE_OBJECT_NAMES, ...(o.objects ?? [])].map((n) => n.trim()).filter(Boolean))];
  const forms = [...new Set(names.flatMap((n) => [n, pluralizeLabel(n)]))].sort((a, b) => b.length - a.length);
  // "Salesforce <quoted or any API name>" or a known object label (singular/plural).
  const ENT = String.raw`(?:${SF}\s+(⟦\d+⟧|[A-Za-z]\w*)|(${forms.map((f) => escapeRe(f).replace(/ /g, '\\s+')).join('|')}))`;
  const ent = (m: RegExpExecArray, i: number, q: string[]) => V(m[i] ?? m[i + 1], q);

  return [
    // ---------------------------------------------------------------- session
    { name: 'sf-login', keywords: ['log', 'login', 'sign'], example: 'Log in to Salesforce as rep',
      re: new RegExp(String.raw`^(?:log\s*in|login|sign\s*in)\s+(?:to\s+)?salesforce\s+as\s+(?:the\s+|an?\s+)?(⟦\d+⟧|[\w.@+-]+)(?:\s+user)?$`, 'i'),
      build: (m, q) => custom('sf.login', { role: V(m[1], q) }) },

    // ---------------------------------------------------------------- assertions
    { name: 'sf-verify-soql', keywords: ['verify', 'expect', 'check'], example: 'Verify in Salesforce that Account "Acme" has Industry = "Energy"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+salesforce\s+(?:that\s+)?(?:the\s+)?(⟦\d+⟧|[A-Za-z]\w*)(?:\s+record)?\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.verifySoql', { object: V(m[1], q), name: V(m[2], q), expect: parseFieldPairs(m[3], q) }) },
    { name: 'sf-expect-toast', keywords: ['expect', 'verify', 'check'], example: 'Expect the toast to contain "was created"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?(?:${SF}\s+)?toast(?:\s+message)?\s+(?:to\s+(?:contain|say|include)|contains|says|should\s+(?:contain|say))\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.expectToast', { text: V(m[1], q) }) },
    { name: 'sf-expect-field-access', keywords: ['expect', 'verify', 'check'], example: 'Expect field "Annual Revenue" to be read-only',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(${SF}\s+)?field\s+${Q}\s+(?:to\s+be|is|should\s+be)\s+(read[\s-]?only|editable|hidden|not\s+visible)$`, 'i'),
      build: (m, q) => {
        const access = m[3].toLowerCase().replace(/\s+/g, '-').replace(/^readonly$/, 'read-only').replace(/^not-visible$/, 'hidden');
        // Without "Salesforce", only read-only/editable are claimed ("Expect field X to be hidden" stays a web assertion).
        if (!m[1] && access === 'hidden') return undefined;
        return custom('sf.expectFieldAccess', { field: V(m[2], q), access });
      } },
    { name: 'sf-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect Salesforce field "Stage" to be "Prospecting"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${SF}\s+field\s+${Q}\s+${TO_BE}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sf-expect-field-on-record', keywords: ['expect', 'verify', 'check'], example: 'Expect "Stage" to be "Prospecting" on the record',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:field\s+)?${Q}\s+${TO_BE}\s+(.+?)\s+on\s+the\s+(?:salesforce\s+)?record$`, 'i'),
      build: (m, q) => custom('sf.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sf-expect-path-stage', keywords: ['expect', 'verify', 'check'], example: 'Expect the path stage to be "Qualification"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:current\s+)?(?:${SF}\s+)?path\s+stage\s+${TO_BE}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.expectPathStage', { stage: V(m[1], q) }) },
    { name: 'sf-expect-related-list', keywords: ['expect', 'verify', 'check'], example: 'Expect the related list "Contacts" to contain "Jane Doe"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?related\s+list\s+${Q}\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.expectRelatedList', { list: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sf-expect-list-view', keywords: ['expect', 'verify', 'check'], example: 'Expect the Accounts list view to contain "Acme"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ENT}\s+list\s+view\s+${CONTAIN}\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.expectListView', { object: ent(m, 1, q), value: V(m[3], q) }) },
    { name: 'sf-expect-tab', keywords: ['expect', 'verify', 'check'], example: 'Expect the Cases tab to be hidden',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ENT}\s+tab\s+(?:to\s+be|is|should\s+be)\s+(visible|available|hidden|not\s+visible|not\s+available|unavailable)$`, 'i'),
      build: (m, q) => custom('sf.expectTab', { tab: ent(m, 1, q), visible: /^(visible|available)$/i.test(m[3]) }) },

    // ---------------------------------------------------------------- navigation
    { name: 'sf-open-tab', keywords: ['open', 'go', 'navigate'], example: 'Open the Accounts tab',
      re: new RegExp(String.raw`^(?:open|go\s+to|navigate\s+to|switch\s+to)\s+(?:the\s+)?${ENT}\s+tab$`, 'i'),
      build: (m, q) => custom('sf.openTab', { tab: ent(m, 1, q) }) },
    { name: 'sf-new-record', keywords: ['create', 'open', 'start'], example: 'Create a new Opportunity',
      re: new RegExp(String.raw`^(?:create|open|start)\s+(?:a\s+|an\s+)?new\s+${ENT}(?:\s+record)?$`, 'i'),
      build: (m, q) => custom('sf.newRecord', { object: ent(m, 1, q) }) },
    { name: 'sf-open-record', keywords: ['open'], example: 'Open the Account "Acme"',
      re: new RegExp(String.raw`^open\s+(?:the\s+)?${ENT}\s+(?:record\s+)?(?:named\s+|called\s+)?${Q}$`, 'i'),
      build: (m, q) => custom('sf.openRecord', { object: ent(m, 1, q), name: V(m[3], q) }) },

    // ---------------------------------------------------------------- fields
    { name: 'sf-set-lookup', keywords: ['set', 'change'], example: 'Set lookup "Account Name" to "Acme"',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?(?:${SF}\s+)?lookup\s+(?:field\s+)?${Q}\s+to\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.setField', { field: V(m[1], q), value: V(m[2], q), kind: 'lookup' }) },
    { name: 'sf-set-field', keywords: ['set', 'change', 'update'], example: 'Set Salesforce field "Account Name" to "Acme"',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?${SF}\s+field\s+${Q}\s+to\s+(.+)$`, 'i'),
      build: (m, q) => custom('sf.setField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'sf-set-field-on-record', keywords: ['set', 'change', 'update'], example: 'Set "Stage" to "Prospecting" on the record',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?(?:field\s+)?${Q}\s+to\s+(.+?)\s+on\s+the\s+(?:salesforce\s+)?record$`, 'i'),
      build: (m, q) => custom('sf.setField', { field: V(m[1], q), value: V(m[2], q) }) },

    // ---------------------------------------------------------------- commands
    { name: 'sf-save-expect-error', keywords: ['save'], example: 'Save the Salesforce record and expect the error "Close Date must be in the future"',
      re: new RegExp(String.raw`^save\s+the\s+${SF}\s+record\s+(?:and\s+)?expect(?:ing)?\s+(?:the\s+|an?\s+)?error\s+(?:containing\s+)?(.+)$`, 'i'),
      build: (m, q) => custom('sf.save', { expectError: V(m[1], q) }) },
    { name: 'sf-save', keywords: ['save'], example: 'Save the Salesforce record',
      re: new RegExp(String.raw`^save\s+the\s+${SF}\s+record$`, 'i'),
      build: () => custom('sf.save', {}) },
    { name: 'sf-cancel', keywords: ['cancel'], example: 'Cancel the Salesforce record',
      re: new RegExp(String.raw`^cancel\s+(?:the\s+)?${SF}\s+(?:record|edit)$`, 'i'),
      build: () => custom('sf.cancel', {}) },
    { name: 'sf-mark-stage-complete', keywords: ['mark'], example: 'Mark the stage as complete',
      re: /^mark\s+(?:the\s+)?(?:current\s+)?(?:path\s+)?stage\s+as\s+complete(?:d)?$/i,
      build: () => custom('sf.markStageComplete', {}) },
  ];
}

/** The Salesforce rules for the default object labels. Register with registerIntentRules(SALESFORCE_INTENT_RULES). */
export const SALESFORCE_INTENT_RULES: IntentRule[] = createSalesforceIntentRules();

/**
 * Parse a .ez script with the Salesforce rules registered for the duration
 * of the parse (the core parser lets add-on rules claim "Expect ..." lines
 * as standalone steps, keeping their original wording as the intent).
 */
export function parseSalesforceEzScript(text: string, opts: ParseEzOptions = {}, rules: IntentRule[] = SALESFORCE_INTENT_RULES): Journey {
  const off = registerIntentRules(rules);
  try {
    return parseEzScript(text, opts);
  } finally {
    off();
  }
}
