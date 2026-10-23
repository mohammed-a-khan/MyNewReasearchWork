/**
 * Grammar helpers for the packaged-app phrasings. Every pack phrasing names
 * its platform ("ServiceNow", "Fiori", "Workday", "Oracle", "Power Apps"), so
 * the packs never compete with each other, with the D365/Salesforce add-ons
 * ("Open the Account record", "Save the record") or with ordinary web lines.
 */
import type { Journey } from '../../core/index.js';
import { parseEzScript, registerIntentRules, type IntentRule, type ParseEzOptions, type StepBody } from '../../intent/index.js';
import { literal } from '../../intent/quotes.js';
import { parseFieldPairs } from '../../salesforce/intents.js';

export const Q = '(⟦\\d+⟧)';
export const ASSERT = String.raw`(?:expect|verify|assert|ensure|confirm|check)(?:\s+that)?`;
export const TO_BE = String.raw`(?:to\s+(?:be|equal|show)|is|equals|shows|should\s+(?:be|show))`;
export const CONTAIN = String.raw`(?:to\s+(?:contain|include|have|show)|contains|includes|should\s+(?:contain|include)|has|shows)`;
export const SET = String.raw`(?:set|change|update|fill|enter)`;
export const KEY = '([A-Za-z_][\\w.]*)';

export const V = (s: string, q: string[]) => literal(s, q);
export const custom = (handler: string, args: Record<string, unknown>): StepBody => ({ action: 'custom', handler, args });

/** `Field = "value" and "Other" is "x"` into a record (quoted or bare keys). */
export const parsePairs = parseFieldPairs;

/** Tag every rule with a palette category. */
export function categorize(category: string, rules: IntentRule[]): IntentRule[] {
  return rules.map((r) => ({ ...r, category }));
}

/** Parse a .ez script with `rules` registered for the duration of the parse. */
export function parseWithRules(text: string, rules: IntentRule[], opts: ParseEzOptions = {}): Journey {
  const off = registerIntentRules(rules);
  try {
    return parseEzScript(text, opts);
  } finally {
    off();
  }
}
