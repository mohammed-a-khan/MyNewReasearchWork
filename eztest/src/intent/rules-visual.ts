/**
 * Visual assertion phrasings (element or page against a baseline):
 *
 *   Expect the Header to look like the baseline
 *   Expect the Invoice panel to look like baseline "invoice-panel" in layout mode
 *   Expect the page to match the baseline ignoring colors masking "testid=clock"
 *   Verify the full page looks like baseline "home" at viewports 1280x720 and 375x667 with tolerance 0.5%
 *
 * They are steps of their own (custom handler "eztest.visual"), never
 * post-conditions of the line above.
 */
import { describeTarget } from './target.js';
import { literal, restoreQuotes } from './quotes.js';
import type { IntentRule } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const HEAD = String.raw`^(?:expect|verify|assert|check)\s+(?:that\s+)?(.+?)\s+(?:to\s+look\s+like|looks?\s+like|to\s+match|matches|is\s+identical\s+to)\s+(?:the\s+)?baseline(?:\s+(${Q}))?`;
const VISUAL_RE = new RegExp(`${HEAD}((?:\\s+.*)?)$`, 'i');

/** "Expect X to look like the baseline ..." is a visual step, never a post-condition. */
export function isVisualExpectation(line: string): boolean {
  return new RegExp(HEAD, 'i').test(line.trim().replace(/"[^"]*"/g, '⟦0⟧'));
}

function options(tail: string, q: string[]): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  let rest = ` ${tail.trim()} `;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(rest);
    if (!m) return;
    fn(m);
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  };
  take(/\s(?:in|using)\s+(strict|layout|content|ignore[- ]colou?rs?)\s+(?:mode|comparison|match(?:\s+level)?)\s/i, (m) => (args.mode = m[1].toLowerCase().replace(/\s/, '-').replace(/colou?rs?$/, 'colors')));
  take(/\s(?:ignoring|ignore)\s+colou?rs?\s/i, () => (args.mode = 'ignore-colors'));
  take(/\s(?:ignoring|ignore)\s+(?:the\s+)?layout\s+only\s/i, () => (args.mode = 'layout'));
  take(/\s(?:with|counting)\s+(?:strict\s+)?anti-?alias(?:ing)?\s/i, () => (args.antiAlias = 'strict'));
  take(new RegExp(String.raw`\s(?:masking|ignoring|hiding)\s+((?:${Q})(?:\s*(?:,|and)\s*${Q})*)\s`, 'i'), (m) => (args.mask = [...m[1].matchAll(new RegExp(Q, 'g'))].map((x) => literal(x[0], q))));
  take(/\s(?:at|for)\s+viewports?\s+(\d+\s*x\s*\d+(?:\s*(?:,|and)\s*\d+\s*x\s*\d+)*)\s/i, (m) => (args.viewports = [...m[1].matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((x) => ({ width: Number(x[1]), height: Number(x[2]) }))));
  take(/\swith\s+(?:a\s+)?tolerance\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%\s/i, (m) => (args.maxDiffRatio = Number(m[1]) / 100));
  take(/\swith\s+(?:a\s+)?tolerance\s+(?:of\s+)?(\d+)\s*(?:px|pixels?)\s/i, (m) => (args.maxDiffPixels = Number(m[1]), args.tolerancePx = Number(m[1])));
  take(/\swith\s+(?:a\s+)?threshold\s+(?:of\s+)?(0(?:\.\d+)?|1(?:\.0+)?)\s/i, (m) => (args.threshold = Number(m[1])));
  take(/\s(?:keyed|per)\s+(?:by\s+)?browser\s+version\s/i, () => (args.keyBy = ['browserVersion', 'viewport']));
  if (rest.trim()) return undefined;
  return args;
}

export const VISUAL_RULES: IntentRule[] = [
  {
    name: 'visual-baseline', category: 'Visual', keywords: ['expect', 'verify', 'check'],
    example: 'Expect the Header to look like the baseline',
    re: VISUAL_RE,
    build: (m, q) => {
      const subject = restoreQuotes(m[1].trim(), q);
      const args = options(m[3] ?? '', q);
      if (!args) return undefined;
      if (m[2]) args.baseline = literal(m[2], q);
      const page = /^(?:the\s+)?(?:whole\s+|full\s+|entire\s+)?(?:page|screen|viewport)$/i.test(subject);
      if (/^(?:the\s+)?(?:whole|full|entire)\s+page$/i.test(subject)) args.fullPage = true;
      return { action: 'custom', handler: 'eztest.visual', args, ...(page ? {} : { target: describeTarget(subject) }) };
    },
  },
];
