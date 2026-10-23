/**
 * Manual steps: a line a human carries out and gives a verdict on.
 *
 *   Manual: Open the order in the back office and press "Refund"
 *     Expected: The refund confirmation shows the original amount
 *     Attachment: docs/refund-policy.pdf
 *   Manual step: Check the printed invoice
 *
 * In a `.ez` script the indented `Expected:` and `Attachment:` lines after a
 * manual step belong to it (see ezscript.ts); `Expect ...` lines still become
 * automated post-conditions, checked after the tester's verdict in a hybrid
 * journey. Nothing here is evaluated: the instruction is text for a person.
 */
import { restoreQuotes } from './quotes.js';
import type { IntentRule } from './rules.js';

/** `Manual: ...` (also `Manual step:`, `Manual check:`, `Tester:`). */
export const MANUAL_LINE = /^(?:manual(?:\s+(?:step|check|test|action))?|tester)\s*:\s*(.+)$/i;
/** Continuation lines of a manual step. */
export const EXPECTED_LINE = /^(?:expected(?:\s+results?)?|expected\s+outcome)\s*:\s*(.+)$/i;
export const ATTACHMENT_LINE = /^(?:attachment|attach|reference)\s*:\s*(.+)$/i;

export const MANUAL_RULES: IntentRule[] = [
  {
    name: 'manual-step',
    category: 'Manual',
    keywords: ['manual', 'tester'],
    example: 'Manual: Check the printed invoice matches the order',
    re: MANUAL_LINE,
    build: (m, q) => {
      const text = restoreQuotes(m[1], q).replace(/\s+/g, ' ').trim();
      if (!text) return undefined;
      return { action: 'manual', value: text };
    },
  },
];

/** True when a line is a `Manual:` step. */
export function isManualLine(line: string): boolean {
  return MANUAL_LINE.test(line.trim());
}
