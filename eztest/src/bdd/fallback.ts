/**
 * The plain-English fallback: a Gherkin step that no step definition matches
 * runs as an EZTest step when its text is an EZTest phrasing.
 *
 *   When I click the "Save" button          -> Click the "Save" button
 *   Then the page contains "Saved"          -> Expect the page contains "Saved"
 *   Given I am on "/login"                  -> Open "/login"
 *   When I fill in the form:                -> one "Type ... into the ... field" per row
 *     | Username | bob |
 *
 * The keyword and a leading "I" / "we" / "the user" are dropped (the EZTest
 * grammar does that itself). "Then" steps are read as expectations first.
 * A doc string with one line is appended as quoted text. Nothing is guessed:
 * the same text always gives the same step, or none.
 */
import { Step, type StepInput } from '../core/index.js';
import { matchedRule, parseIntent, quoteText, tryParseCondition } from '../intent/index.js';

export interface FallbackInput {
  text: string;
  type: 'context' | 'action' | 'outcome';
  docString?: { content: string; mediaType?: string };
  dataTable?: string[][];
}

export interface FallbackStep {
  /** One step, or several (a form-filling data table). */
  steps: StepInput[];
  /** The phrasing that matched: a grammar rule name, or "expect" for an expectation. */
  rule: string;
  kind: 'action' | 'assertion';
  /** The EZTest line(s) the step runs as. */
  lines: string[];
}

const ALIASES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  // "I am on "/login"", "I am on the "/login" page", "the user is on "/orders""
  [/^(?:(?:i|we)\s+am|(?:i|we)\s+are|(?:the\s+)?user\s+is|i'm)\s+on\s+(?:the\s+)?("[^"]*"|'[^']*'|\S+)(?:\s+page)?$/i, (m) => `Open ${m[1]}`],
  // "I act as "desk"", "I am acting as desk" (several users: @actors:desk=receptionist,...)
  [/^(?:(?:i|we)\s+(?:act|am\s+acting|are\s+acting)|(?:the\s+)?user\s+acts)\s+as\s+("[^"]*"|'[^']*'|[A-Za-z_][\w.-]*)$/i, (m) => `Switch to user ${m[1]}`],
  // "I am logged in as "manager"", "I am signed in as manager"
  [/^(?:(?:i|we)\s+am|(?:the\s+)?user\s+is|i'm)\s+(?:logged|signed)\s+in\s+as\s+(.+)$/i, (m) => `Log in as ${m[1]}`],
];

const EXPECT_ALIASES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  // "I should be on "/dashboard"", "I am on the "/dashboard" page" (as an outcome)
  [/^(?:(?:i|we)\s+(?:should\s+)?(?:be|am|are)|(?:the\s+)?user\s+(?:should\s+be|is))\s+on\s+(?:the\s+)?("[^"]*"|'[^']*')(?:\s+page)?$/i, (m) => `the URL contains ${m[1]}`],
];

function alias(text: string, list: typeof ALIASES): string | undefined {
  for (const [re, f] of list) {
    const m = re.exec(text);
    if (m) return f(m);
  }
  return undefined;
}

function asCondition(text: string): StepInput | undefined {
  const body = text
    .replace(/^(?:(?:i|we)\s+)?(?:verify|expect|assert|ensure|confirm|check)\s+(?:that\s+)?/i, '')
    .replace(/[.;]+$/, '');
  const phrase = alias(body, EXPECT_ALIASES) ?? body;
  const c = tryParseCondition(phrase);
  if (!c) return undefined;
  return { id: 'bdd', intent: `Expect ${phrase}`, action: 'assert', postconditions: [c] };
}

function asAction(text: string): StepInput | undefined {
  for (const t of [alias(text, ALIASES), text]) {
    if (!t) continue;
    try {
      const s = parseIntent(t, { id: 'bdd' });
      Step.parse(s);
      return s;
    } catch {
      // not an EZTest phrasing
    }
  }
  return undefined;
}

function ruleName(text: string, step: StepInput): string {
  if (step.action === 'assert' && !matchedRule(text)) return 'expect';
  return matchedRule(text)?.name ?? (step.action === 'assert' ? 'expect' : step.action);
}

/** The EZTest step(s) for a Gherkin step, or undefined when its text is not an EZTest phrasing. */
export function ezFallback(input: FallbackInput): FallbackStep | undefined {
  let text = input.text.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  // A two-column table after a "fill in" style step: one field per row.
  if (input.dataTable && input.type !== 'outcome' && /\b(?:fill(?:s|ed)?(?:\s+in)?|enter|enters|type|types|complete|provide|input)\b/i.test(text)) {
    const rows = input.dataTable;
    if (rows.length && rows.every((r) => r.length === 2)) {
      const body = /^(?:field|name|label|input)$/i.test(rows[0][0]) && rows.length > 1 ? rows.slice(1) : rows;
      const lines: string[] = [];
      const steps: StepInput[] = [];
      for (const [field, value] of body) {
        let line: string;
        try {
          line = `Type ${quoteText(value)} into the ${quoteText(field)} field`;
        } catch {
          return undefined;
        }
        const s = asAction(line);
        if (!s) return undefined;
        lines.push(line);
        steps.push(s);
      }
      return { steps, rule: 'fill-table', kind: 'action', lines };
    }
    return undefined;
  }
  if (input.dataTable) return undefined;
  if (input.docString) {
    const lines = input.docString.content.split('\n').filter((l) => l.trim());
    if (lines.length !== 1) return undefined;
    try {
      text = `${text.replace(/\s*:\s*$/, '')} ${quoteText(lines[0].trim())}`;
    } catch {
      return undefined;
    }
  }
  const order = input.type === 'outcome' ? [asCondition, asAction] : [asAction, asCondition];
  for (const f of order) {
    const s = f(text);
    if (s) {
      const kind = s.action === 'assert' ? 'assertion' : 'action';
      return { steps: [s], rule: ruleName(text, s), kind, lines: [s.intent] };
    }
  }
  return undefined;
}
