/**
 * Keyboard operability checks (custom step "eztest.keyboard", src/lenses/keyboard.ts):
 *
 *   Expect the page to be keyboard operable
 *   Verify the "Checkout" form is keyboard accessible
 *
 * A step of its own (it drives Tab through the page), never a post-condition.
 */
import { describeTarget } from './target.js';
import { restoreQuotes } from './quotes.js';
import type { IntentRule } from './rules.js';

const HEAD = String.raw`^(?:expect|verify|assert|check)\s+(?:that\s+)?(.+?)\s+(?:to\s+be|is|are)\s+(?:fully\s+)?keyboard[-\s](?:operable|accessible|navigable|usable)`;
const RE = new RegExp(`${HEAD}(?:\\s+within\\s+(\\d+)\\s+tabs?)?\\s*$`, 'i');

export function isKeyboardExpectation(line: string): boolean {
  return new RegExp(HEAD, 'i').test(line.trim());
}

export const KEYBOARD_RULES: IntentRule[] = [
  {
    name: 'keyboard-operable', category: 'Accessibility', keywords: ['expect', 'verify', 'check'],
    example: 'Expect the page to be keyboard operable',
    re: RE,
    build: (m, q) => {
      const subject = restoreQuotes(m[1].trim(), q);
      const page = /^(?:the\s+)?(?:whole\s+|full\s+|entire\s+)?(?:page|screen|app|application)$/i.test(subject);
      return { action: 'custom', handler: 'eztest.keyboard', args: m[2] ? { maxTabs: Number(m[2]) } : {}, ...(page ? {} : { target: describeTarget(subject) }) };
    },
  },
];
