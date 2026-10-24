/**
 * Phrases added for teams migrating from other frameworks: downloaded files read
 * as rows, rows compared with a named query, and the global loader wait. They are
 * tried before the generic assertion rules so "Expect rows ..." is never read as a
 * plain condition.
 */
import { literal } from './quotes.js';
import type { IntentRule } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const KEY = String.raw`([A-Za-z_][\w.-]*)`;

function quotedList(s: string | undefined, q: string[]): string[] {
  if (!s) return [];
  const parts = [...s.matchAll(new RegExp(`${Q}|[\\w.-]+`, 'g'))].map((m) => (m[0].startsWith('⟦') ? literal(m[0], q) : m[0]));
  return parts.filter((p) => !/^(?:and|or)$/i.test(p));
}

/** "Expect rows ... equal ..." is a step of its own (it runs a comparison), never a post-condition of the line above. */
export function isStepExpectation(line: string): boolean {
  return /^(?:expect|verify|assert|check)\s+(?:that\s+)?(?:the\s+)?rows\s+\S+\s+(?:equal|equals|match|matches)\s/i.test(line.trim());
}

export const MIGRATION_RULES: IntentRule[] = [
  { name: 'wait-loaders', keywords: ['wait'], category: 'Wait', example: 'Wait for loaders to disappear',
    re: new RegExp(String.raw`^wait\s+(?:for|until)\s+(?:the\s+|all\s+)?(?:loaders?|spinners?|loading\s+indicators?)(?:\s+(${Q}(?:\s*,\s*${Q})*))?\s+(?:to\s+)?(?:disappear|vanish|go\s+away|(?:are|is)\s+gone|(?:to\s+)?finish)(?:\s+(?:within|for\s+up\s+to)\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?))?$`, 'i'),
    build: (m, q) => ({
      action: 'wait',
      args: {
        for: 'loaders',
        ...(m[1] ? { selectors: quotedList(m[1], q) } : {}),
        ...(m[2] ? { timeoutMs: Math.round(Number(m[2]) * (/^ms$/i.test(m[3]) ? 1 : 1000)) } : {}),
      },
    }) },
  { name: 'read-download-rows', keywords: ['read', 'load', 'parse'], category: 'Files', example: 'Read the download invoice as rows into r',
    re: new RegExp(String.raw`^(?:read|load|parse)\s+(?:the\s+)?(?:download(?:ed\s+file)?|file|export)\s+${KEY}(?:\s+(?:sheet|worksheet)\s+(${Q}))?\s+as\s+rows\s+(?:into|as)\s+${KEY}(?:\s+(?:with\s+)?(?:delimiter|separator)\s+(${Q}))?$`, 'i'),
    build: (m, q) => ({
      action: 'set',
      captureAs: m[3],
      args: { extract: { from: m[1], kind: 'rows', ...(m[2] ? { sheet: literal(m[2], q) } : {}), ...(m[4] ? { delimiter: literal(m[4], q) } : {}) } },
    }) },
  { name: 'expect-rows-query', keywords: ['expect', 'verify', 'compare'], category: 'Database', example: 'Expect rows r equal query "INVOICE_LINES" on demo by key "Id" ignoring columns "Updated" with tolerance 0.01',
    re: new RegExp(
      String.raw`^(?:expect|verify|assert|check)\s+(?:that\s+)?(?:the\s+)?rows\s+(\$\{[\w.]+\}|[\w.]+)\s+(?:equal|equals|match|matches)\s+(?:the\s+)?(?:(?:named\s+)?query\s+(${Q})(?:\s+on\s+([\w.-]+))?(?:\s+with\s+params?\s+((?:${Q}|\$\{[\w.]+\}|[\w.-]+)(?:\s*,\s*(?:${Q}|\$\{[\w.]+\}|[\w.-]+))*)|\s+with\s+((?:[A-Za-z_]\w*\s*=\s*(?:${Q}|\$\{[\w.]+\}|[\w.-]+))(?:\s*,\s*[A-Za-z_]\w*\s*=\s*(?:${Q}|\$\{[\w.]+\}|[\w.-]+))*))?|(?:rows\s+)?(\$\{[\w.]+\}|[\w.]+))` +
        String.raw`\s+(?:by|on|using)\s+(?:key|keys|column|columns)\s+((?:${Q}|[\w.-]+)(?:\s*(?:,|and)\s*(?:${Q}|[\w.-]+))*)` +
        String.raw`(?:\s+ignoring\s+(?:columns?\s+)?((?:${Q}|[\w.-]+)(?:\s*(?:,|and)\s*(?:${Q}|[\w.-]+))*))?` +
        String.raw`(?:\s+(?:with\s+)?tolerance\s+(\d+(?:\.\d+)?))?(?:\s+ignoring\s+case)?$`,
      'i',
    ),
    build: (m, q) => {
      const strip = (s: string) => s.replace(/^\$\{|\}$/g, '');
      const keys = quotedList(m[7], q);
      const params = m[4] ? [...m[4].matchAll(new RegExp(`${Q}|\\$\\{[\\w.]+\\}|[\\w.-]+`, 'g'))].map((x) => (x[0].startsWith('⟦') ? literal(x[0], q) : x[0])) : undefined;
      // Named binds, like the other named-query phrasings: with batch_id="${jobId}", region=EU
      const binds = m[5]
        ? Object.fromEntries([...m[5].matchAll(new RegExp(`([A-Za-z_]\\w*)\\s*=\\s*(${Q}|\\$\\{[\\w.]+\\}|[\\w.-]+)`, 'g'))].map((x) => [x[1], x[2].startsWith('⟦') ? literal(x[2], q) : x[2]]))
        : undefined;
      return {
        action: 'compareData',
        args: {
          actual: strip(m[1]),
          ...(m[2] ? { expectedQuery: { name: literal(m[2], q), ...(m[3] ? { connection: m[3] } : {}), ...(params ? { params } : {}), ...(binds ? { binds } : {}) } } : { expected: strip(m[6]) }),
          key: keys.length === 1 ? keys[0] : keys,
          ...(m[8] ? { ignore: quotedList(m[8], q) } : {}),
          ...(m[9] ? { tolerance: Number(m[9]) } : {}),
          ...(/ignoring\s+case$/i.test(m[0]) ? { ignoreCase: true } : {}),
          caseInsensitiveColumns: true,
        },
      };
    } },
];
