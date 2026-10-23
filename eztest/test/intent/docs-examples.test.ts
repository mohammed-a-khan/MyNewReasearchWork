/** Every phrasing example in docs/ez-language.md tables parses (the docs cannot drift from the grammar). */
import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { parseCondition, parseEzScript, parseIntent } from '../../src/intent/index.js';
import { isNamedQueryExpectation } from '../../src/intent/rules-queries.js';
import { isStepExpectation } from '../../src/intent/rules-migration.js';
import { isDesktopExpectation } from '../../src/intent/rules-desktop.js';
import { isIntegrationExpectation } from '../../src/integration/rules.js';
import { isA11yExpectation } from '../../src/intent/rules-a11y.js';
import { isSpecialistExpectation } from '../../src/intent/rules-specialist.js';
import { isStoreExpectation } from '../../src/store/rules.js';

const doc = readFileSync(new URL('../../docs/ez-language.md', import.meta.url), 'utf8');
const actionsPart = doc.slice(doc.indexOf('## Actions ('), doc.indexOf('## Expectations ('));
const expectationsPart = doc.slice(doc.indexOf('## Expectations ('), doc.indexOf('## How targets are found'));

/** Backtick snippets in table rows (second column onward). */
function snippets(part: string): string[] {
  const out: string[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\| (Purpose|Checks|Header) \|/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).slice(2).join('|');
    for (const m of cells.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

const SKIP = /…|\.\.\.|<[a-z]|^(?:End|Otherwise|On failure|Try|CALL|EXEC)$|^\$\{|^[A-Z][\w ]*:( |$)/;

describe('docs/ez-language.md examples', () => {
  const actions = snippets(actionsPart).filter((s) => !SKIP.test(s));
  const expectations = snippets(expectationsPart).filter((s) => !/…|\.\.\./.test(s));

  it('has many examples to check', () => {
    expect(actions.length).toBeGreaterThan(250);
    expect(expectations.length).toBeGreaterThan(80);
  });

  it.each(actions)('action: %s', (line) => {
    const expectLine = /^Expect\s+(.+)$/i.exec(line);
    // "Expect query "NAME" ... returns N rows" (named-query catalogue) is a step of its own.
    if (expectLine && !isNamedQueryExpectation(line) && !isStepExpectation(line) && !isDesktopExpectation(line) && !isIntegrationExpectation(line) && !isSpecialistExpectation(line) && !isA11yExpectation(line) && !isStoreExpectation(line)) {
      expect(() => parseCondition(expectLine[1])).not.toThrow();
      return;
    }
    const s = parseIntent(line);
    if (Array.isArray(s.steps) && s.steps.length === 0) {
      expect(() => parseEzScript(`Journey: J\n${line}\n  Press Tab\nEnd\n`)).not.toThrow();
    }
  });

  it.each(expectations)('expectation: %s', (phrase) => {
    expect(() => parseCondition(phrase)).not.toThrow();
  });

  it('the flow-control and Examples code samples parse', () => {
    for (const m of doc.matchAll(/```text\n([\s\S]*?)```/g)) {
      const body = m[1].replace(/\s+#.*$/gm, '');
      if (/^Journey:/m.test(body)) expect(() => parseEzScript(body)).not.toThrow();
      else if (/^If /m.test(body)) expect(() => parseEzScript(`Journey: Sample\n${body}`)).not.toThrow();
    }
  });
});
