/**
 * Accessibility check phrasings (custom handler "eztest.a11y", see
 * src/a11y/step.ts):
 *
 *   Check accessibility
 *   Check the page for accessibility issues at WCAG 2.2 level AA
 *   Check accessibility of the Checkout form without dynamic checks
 *   Audit accessibility to level AAA including best practices
 *   Expect the page to be accessible
 *
 * They are steps of their own, never post-conditions of the line above.
 */
import { describeTarget } from './target.js';
import { restoreQuotes } from './quotes.js';
import type { IntentRule } from './rules.js';

const CHECK = String.raw`^(?:check|scan|audit|test)\s+(?:the\s+(?:page|screen)\s+for\s+|for\s+)?accessibility(?:\s+(?:issues|problems|violations))?`;
const EXPECT = String.raw`^(?:expect|verify|assert|ensure)\s+(?:that\s+)?(?:the\s+)?(?:page|screen)\s+(?:to\s+be|is)\s+accessible`;
const TAIL = String.raw`((?:\s+.*)?)$`;

/** "Expect the page to be accessible ..." is an accessibility step, never a post-condition. */
export function isA11yExpectation(line: string): boolean {
  return new RegExp(EXPECT, 'i').test(line.trim());
}

function options(tail: string): { args: Record<string, string>; target?: string } | undefined {
  const args: Record<string, string> = {};
  let target: string | undefined;
  let rest = ` ${tail.trim()} `;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(rest);
    if (!m) return;
    fn(m);
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  };
  take(/\s(?:to|at|against|for)\s+(?:wcag\s*2(?:\.[0-2])?\s+)?(?:level\s+)?(aaa|aa|a)(?:\s+level)?\s/i, (m) => (args.level = m[1].toUpperCase()));
  take(/\s(?:without|skipping|with\s+no)\s+(?:the\s+)?(?:dynamic|keyboard|interactive)\s+checks?\s/i, () => (args.dynamic = 'false'));
  take(/\s(?:including|with)\s+best[- ]practices?\s/i, () => (args.bestPractice = 'true'));
  take(/\sfailing\s+on\s+(minor|moderate|serious|critical)(?:\s+issues)?\s/i, (m) => (args.failOn = m[1].toLowerCase()));
  take(/\s(?:of|in|within|inside|for)\s+(?:the\s+)?(.+?)\s*$/i, (m) => (target = m[1]));
  if (rest.trim()) return undefined;
  return { args, target };
}

function build(tail: string, q: string[]) {
  const o = options(tail);
  if (!o) return undefined;
  const page = !o.target || /^(?:whole\s+|entire\s+)?(?:page|screen)$/i.test(o.target);
  return {
    action: 'custom' as const,
    handler: 'eztest.a11y',
    ...(Object.keys(o.args).length ? { args: o.args } : {}),
    ...(page ? {} : { target: describeTarget(restoreQuotes(o.target!.trim(), q)) }),
  };
}

export const A11Y_RULES: IntentRule[] = [
  {
    name: 'a11y-check', category: 'Accessibility', keywords: ['check', 'audit', 'scan'],
    example: 'Check accessibility',
    re: new RegExp(`${CHECK}${TAIL}`, 'i'),
    build: (m, q) => build(m[1] ?? '', q),
  },
  {
    name: 'a11y-expect', category: 'Accessibility', keywords: ['expect', 'verify'],
    example: 'Expect the page to be accessible',
    re: new RegExp(`${EXPECT}${TAIL}`, 'i'),
    build: (m, q) => build(m[1] ?? '', q),
  },
];
