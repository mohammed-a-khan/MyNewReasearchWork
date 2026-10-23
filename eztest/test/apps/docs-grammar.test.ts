/**
 * Packaged-app phrasings: every rule's example parses to its own pack, no
 * pack phrasing is claimed by another pack or by the D365 / Salesforce
 * add-ons (and vice versa), ordinary web lines keep their meaning, and the
 * docs (docs/apps/*.md, docs/ez-language.md, README.md) list every
 * phrasing with the right counts.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { parseIntent, registerIntentRules, type IntentRule } from '../../src/intent/index.js';
import { INTENT_RULES } from '../../src/intent/rules.js';
import { D365_INTENT_RULES } from '../../src/d365/index.js';
import { SALESFORCE_INTENT_RULES } from '../../src/salesforce/index.js';
import { SERVICENOW_INTENT_RULES } from '../../src/apps/servicenow/index.js';
import { FIORI_INTENT_RULES } from '../../src/apps/sap/index.js';
import { WORKDAY_INTENT_RULES } from '../../src/apps/workday/index.js';
import { ORACLE_INTENT_RULES } from '../../src/apps/oracle/index.js';
import { createPowerAppsIntentRules } from '../../src/apps/powerapps/index.js';

const PACKS: Array<{ doc: string; prefix: string; rules: IntentRule[] }> = [
  { doc: 'servicenow', prefix: 'sn.', rules: SERVICENOW_INTENT_RULES },
  { doc: 'sap', prefix: 'fiori.', rules: FIORI_INTENT_RULES },
  { doc: 'workday', prefix: 'wd.', rules: WORKDAY_INTENT_RULES },
  { doc: 'oracle', prefix: 'oracle.', rules: ORACLE_INTENT_RULES },
  { doc: 'powerapps', prefix: 'pa.', rules: createPowerAppsIntentRules() },
];
const TOTAL = PACKS.reduce((n, p) => n + p.rules.length, 0);
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const startsWith = (prefix: string) => new RegExp(`^${prefix.replace('.', '\\.')}`);

/** Every pack plus one CRM add-on (D365 and Salesforce share generic object phrasings with each other; see ez-language.md). */
function withAll<T>(fn: () => T, crm: 'd365' | 'salesforce' = 'd365'): T {
  const offs = [
    registerIntentRules(crm === 'd365' ? D365_INTENT_RULES : SALESFORCE_INTENT_RULES),
    ...PACKS.map((p) => registerIntentRules(p.rules)),
    registerIntentRules(createPowerAppsIntentRules({ dataverse: true })),
  ];
  try {
    return fn();
  } finally {
    for (const off of offs.reverse()) off();
  }
}

/** Backtick snippets in the table rows of a doc's "## Phrasings" section (``double`` spans may contain backticks). */
function phrasingSnippets(text: string): string[] {
  const start = text.indexOf('## Phrasings');
  const section = text.slice(start, text.indexOf('\n## ', start + 5));
  const rows = section.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\| Purpose \|/.test(l)).map((l) => l.split('|').slice(2).join('|'));
  return rows
    .flatMap((r) => {
      const dbl = [...r.matchAll(/``\s?(.+?)\s?``/g)].map((m) => m[1]);
      const rest = r.replace(/``.+?``/g, '');
      return [...dbl, ...[...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1])];
    })
    .filter((s) => !/…|\.\.\.|^\$\{/.test(s) && /\s/.test(s));
}

describe('packaged-app phrasings', () => {
  it.each(PACKS.map((p) => [p.doc, p] as const))('%s: every rule example parses to the pack, with every add-on registered', (_doc, { prefix, rules }) => {
    for (const crm of ['d365', 'salesforce'] as const) {
      withAll(() => {
        for (const r of rules) expect(String(parseIntent(r.example).handler), r.example).toMatch(startsWith(prefix));
      }, crm);
    }
  });

  it('D365 and Salesforce phrasings keep their own handlers with every pack registered', () => {
    withAll(() => {
      for (const r of D365_INTENT_RULES) expect(String(parseIntent(r.example).handler ?? ''), r.example).toMatch(/^d365\./);
    }, 'd365');
    withAll(() => {
      for (const r of SALESFORCE_INTENT_RULES) expect(String(parseIntent(r.example).handler ?? ''), r.example).toMatch(/^sf\./);
    }, 'salesforce');
  });

  it('ordinary web phrasings are never claimed by a pack', () => {
    const packPrefix = /^(?:sn|fiori|wd|oracle|pa)\./;
    withAll(() => {
      for (const r of INTENT_RULES) {
        let h = '';
        try {
          h = String(parseIntent(r.example).handler ?? '');
        } catch {
          continue;
        }
        expect(h, r.example).not.toMatch(packPrefix);
      }
    });
  });

  it.each(PACKS.map((p) => [p.doc, p] as const))('docs/apps/%s.md says it is mock-tested, counts its phrasings and every listed phrasing parses', (doc, { prefix, rules }) => {
    const text = read(`docs/apps/${doc}.md`);
    expect(text).toMatch(/Tested against a mock, not a real/);
    expect(text).toContain(`(${rules.length} phrasings`);
    const snippets = phrasingSnippets(text);
    expect(snippets.length).toBeGreaterThan(8);
    withAll(() => {
      for (const s of snippets) {
        const h = String(parseIntent(s).handler ?? '');
        expect(h.startsWith(prefix) || h === 'd365.verifyDataverse', s).toBe(true);
      }
    });
  });

  it('docs/ez-language.md and the README count the pack phrasings', () => {
    expect(read('docs/ez-language.md')).toContain(`## Packaged-app phrasings (${TOTAL} phrasings`);
    expect(read('README.md')).toContain(`${TOTAL} packaged-app phrasings`);
  });
});
