/**
 * Plain-English D365 phrasings, contributed to the grammar via
 * registerIntentRules(D365_INTENT_RULES). Every rule builds a
 * `{ action: 'custom', handler: 'd365.*', args }` step. Generic-looking
 * phrasings ("Open the X form") only match known entity names, so registering
 * these rules does not hijack ordinary web lines.
 */
import { Journey, type StepInput } from '../core/index.js';
import { defaultStepId, parseEzScript, registerIntentRules, parseIntent, protectQuotes, restoreQuotes, type IntentRule, type ParseEzOptions, type StepBody } from '../intent/index.js';
import { literal } from '../intent/quotes.js';

/** Common Dataverse table display names the generic phrasings recognise. */
export const DEFAULT_D365_ENTITY_NAMES = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Incident', 'Quote', 'Order', 'Invoice', 'Product',
  'Competitor', 'Campaign', 'Activity', 'Task', 'Appointment', 'Phone Call', 'Email', 'Team', 'User', 'Business Unit',
];

export function pluralize(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|ch|sh)$/i.test(name)) return name + 'es';
  return name + 's';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Q = '(⟦\\d+⟧)';
const ASSERT = String.raw`(?:expect|verify|assert|ensure|confirm|check)(?:\s+that)?`;
const TO_BE = String.raw`(?:to\s+(?:be|equal)|is|equals|should\s+be)`;

const V = (s: string, q: string[]) => literal(s, q);
const custom = (handler: string, args: Record<string, unknown>): StepBody => ({ action: 'custom', handler, args });

/** Parse `"a" = "b", "c" is "d" and e = f` into a record. */
export function parsePairs(s: string, q: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/\s*(?:,|\band\b)\s*/i)) {
    if (!part.trim()) continue;
    const m = /^(⟦\d+⟧|[A-Za-z_][\w.]*)\s*(?:=|:|\bis\b|\bequals\b)\s*(.+)$/i.exec(part.trim());
    if (!m) throw new Error(`Expected "field" = "value", got "${restoreQuotes(part, q)}"`);
    out[V(m[1], q)] = V(m[2], q);
  }
  if (!Object.keys(out).length) throw new Error('No "field" = "value" pairs given');
  return out;
}

export interface D365IntentOptions {
  /** Extra entity display names (custom tables) for the generic phrasings. */
  entities?: string[];
}

/** Build the D365 intent rules (optionally recognising extra entity names). */
export function createD365IntentRules(o: D365IntentOptions = {}): IntentRule[] {
  const names = [...new Set([...DEFAULT_D365_ENTITY_NAMES, ...(o.entities ?? [])].map((n) => n.trim()).filter(Boolean))];
  const forms = [...new Set(names.flatMap((n) => [n, pluralize(n)]))].sort((a, b) => b.length - a.length);
  // Either "D365 <quoted or any name>" or a known entity name (singular/plural).
  const ENT = String.raw`(?:(?:d365|dynamics(?:\s+365)?|dataverse)\s+(⟦\d+⟧|[A-Za-z][\w]*(?:\s+[A-Za-z][\w]*)?)|(${forms.map((f) => escapeRe(f).replace(/ /g, '\\s+')).join('|')}))`;
  const ent = (m: RegExpExecArray, i: number, q: string[]) => V(m[i] ?? m[i + 1], q);

  return [
    // ---------------------------------------------------------------- assertions
    { name: 'd365-verify-dataverse', keywords: ['verify', 'expect', 'check'], example: 'Verify in Dataverse that account "Contoso" has "telephone1" = "555-0100"',
      re: new RegExp(String.raw`^${ASSERT}\s+in\s+(?:dataverse|d365|dynamics(?:\s+365)?)\s+(?:that\s+)?(?:the\s+)?(⟦\d+⟧|[A-Za-z_]\w*)(?:\s+record)?\s+${Q}\s+has\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.verifyDataverse', { entity: V(m[1], q), name: V(m[2], q), expect: parsePairs(m[3], q) }) },
    { name: 'd365-expect-field', keywords: ['expect', 'verify', 'check'], example: 'Expect D365 field "Account Name" to be "Contoso"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:d365|dynamics|form)\s+field\s+${Q}\s+${TO_BE}\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'd365-expect-field-on-form', keywords: ['expect', 'verify', 'check'], example: 'Expect "Account Name" to be "Contoso" on the form',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:field\s+)?${Q}\s+${TO_BE}\s+(.+?)\s+on\s+the\s+(?:d365\s+)?form$`, 'i'),
      build: (m, q) => custom('d365.expectField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'd365-expect-saved', keywords: ['expect', 'verify', 'check'], example: 'Expect the record to be saved',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:d365\s+)?record\s+(?:to\s+be|is|was|has\s+been|should\s+be)\s+saved$`, 'i'),
      build: () => custom('d365.expectSaved', {}) },
    { name: 'd365-expect-stage', keywords: ['expect', 'verify', 'check'], example: 'Expect the business process stage to be "Develop"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?(?:active\s+|current\s+)?(?:business\s+process(?:\s+flow)?\s+|bpf\s+|process\s+)stage\s+${TO_BE}\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.expectStage', { stage: V(m[1], q) }) },
    { name: 'd365-expect-view', keywords: ['expect', 'verify', 'check'], example: 'Expect the Accounts view to contain "Contoso"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+)?${ENT}\s+(?:view|list|grid)\s+(?:to\s+(?:contain|include)|contains|should\s+contain|includes?|has)\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.expectView', { entity: ent(m, 1, q), value: V(m[3], q) }) },
    { name: 'd365-expect-notification', keywords: ['expect', 'verify', 'check'], example: 'Expect the form notification to contain "Required fields"',
      re: new RegExp(String.raw`^${ASSERT}\s+(?:the\s+|a\s+)?form\s+notification\s+(?:to\s+(?:contain|say|be)|contains|says|should\s+contain|is)\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.expectNotification', { text: V(m[1], q) }) },

    // ---------------------------------------------------------------- navigation
    { name: 'd365-open-new', keywords: ['open', 'create'], example: 'Open a new Opportunity',
      re: new RegExp(String.raw`^(?:open|create|start)\s+(?:a\s+|an\s+|the\s+)?new\s+${ENT}(?:\s+(?:form|record))?$`, 'i'),
      build: (m, q) => custom('d365.openForm', { entity: ent(m, 1, q), mode: 'new' }) },
    { name: 'd365-open-form', keywords: ['open'], example: 'Open the Account form',
      re: new RegExp(String.raw`^open\s+(?:the\s+|an?\s+)?${ENT}\s+form$`, 'i'),
      build: (m, q) => custom('d365.openForm', { entity: ent(m, 1, q), mode: 'new' }) },
    { name: 'd365-open-view', keywords: ['open', 'go', 'navigate'], example: 'Open the Accounts view',
      re: new RegExp(String.raw`^(?:open|go\s+to|navigate\s+to)\s+(?:the\s+)?${ENT}\s+(?:view|list|grid)$`, 'i'),
      build: (m, q) => custom('d365.openView', { entity: ent(m, 1, q) }) },
    { name: 'd365-open-record', keywords: ['open'], example: 'Open the Account record "Contoso"',
      re: new RegExp(String.raw`^open\s+(?:the\s+)?${ENT}\s+(?:record\s+)?(?:named\s+|called\s+)?${Q}$`, 'i'),
      build: (m, q) => custom('d365.openRecord', { entity: ent(m, 1, q), name: V(m[3], q) }) },

    // ---------------------------------------------------------------- fields
    { name: 'd365-set-lookup', keywords: ['set', 'change'], example: 'Set lookup "Parent Account" to "Fabrikam"',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?(?:d365\s+)?lookup\s+(?:field\s+)?${Q}\s+to\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.setField', { field: V(m[1], q), value: V(m[2], q), kind: 'lookup' }) },
    { name: 'd365-set-field', keywords: ['set', 'change', 'update'], example: 'Set D365 field "Account Name" to "Contoso"',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?(?:d365|dynamics|form)\s+field\s+${Q}\s+to\s+(.+)$`, 'i'),
      build: (m, q) => custom('d365.setField', { field: V(m[1], q), value: V(m[2], q) }) },
    { name: 'd365-set-field-on-form', keywords: ['set', 'change', 'update'], example: 'Set "Account Name" to "Contoso" on the form',
      re: new RegExp(String.raw`^(?:set|change|update)\s+(?:the\s+)?(?:field\s+)?${Q}\s+to\s+(.+?)\s+on\s+the\s+(?:d365\s+)?form$`, 'i'),
      build: (m, q) => custom('d365.setField', { field: V(m[1], q), value: V(m[2], q) }) },

    // ---------------------------------------------------------------- commands
    { name: 'd365-save-close', keywords: ['save'], example: 'Save and close the record',
      re: /^save\s+(?:and|&)\s+close\s+(?:the\s+)?(?:d365\s+)?(?:record|form)$/i,
      build: () => custom('d365.save', { close: true }) },
    { name: 'd365-save', keywords: ['save'], example: 'Save the record',
      re: /^save\s+(?:the\s+)?(?:d365\s+)?(?:record|form)$/i,
      build: () => custom('d365.save', { close: false }) },
    { name: 'd365-next-stage', keywords: ['move', 'advance'], example: 'Move to the next stage',
      re: /^(?:move|advance|go)\s+(?:on\s+)?to\s+the\s+next\s+(?:business\s+process\s+(?:flow\s+)?|bpf\s+)?stage$/i,
      build: () => custom('d365.nextStage', {}) },
  ];
}

/** The D365 rules for the default entity names. Register with registerIntentRules(D365_INTENT_RULES). */
export const D365_INTENT_RULES: IntentRule[] = createD365IntentRules();

const EZ_EXPECT = /^((?:(?:then|and|also)\s+)?)(expect|verify)(\s+.*)$/i;

/**
 * parseEzScript treats every "Expect/Verify ..." line that follows a step as a
 * post-condition of that step, which would swallow D365 assertions. This
 * wrapper turns D365 Expect/Verify lines into standalone steps (keeping their
 * original wording as the intent) and otherwise behaves exactly like
 * parseEzScript. The D365 rules must be registered (registerIntentRules).
 */
export function parseD365EzScript(text: string, opts: ParseEzOptions = {}, rules: IntentRule[] = D365_INTENT_RULES): Journey {
  // The core .ez parser lets add-on rules claim "Expect ..." lines as steps, so registering is enough.
  const off = registerIntentRules(rules);
  try {
    return parseEzScript(text, opts);
  } finally {
    off();
  }
}
