/**
 * E2E (real browser): assertion depth: accessible name / description / role,
 * aria snapshots (baseline, partial match, rename detected with a diff,
 * --update-snapshots rewrites it), negated text/value and title/page patterns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { conditionToText, parseCondition } from '../../src/intent/index.js';
import { matchAriaSnapshot, parseAriaSnapshot } from '../../src/runner/conditions-depth.js';
import { describeSteps, expectPasses, runEz } from './advanced-helpers.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});
afterEach(() => {
  delete process.env.EZTEST_UPDATE_SNAPSHOTS;
});

describe('phrasings', () => {
  it('parse and render back', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['the Save button has accessible name "Save"', { type: 'accessible', property: 'name', op: 'equals', value: 'Save' }],
      ['the accessible name of the Help link matches "^He"', { type: 'accessible', property: 'name', op: 'matches', value: '^He' }],
      ['the accessible description of the Help link contains "help"', { type: 'accessible', property: 'description', op: 'contains' }],
      ['the Help link has accessible description "Get help"', { type: 'accessible', property: 'description', op: 'equals' }],
      ['#terms has role "checkbox"', { type: 'accessible', property: 'role', value: 'checkbox' }],
      ['the role of #badge is not "button"', { type: 'accessible', property: 'role', op: 'ne' }],
      ['the "Order summary" region matches the aria snapshot "order-summary"', { type: 'ariaSnapshot', name: 'order-summary' }],
      ['the page matches the aria snapshot "snapshots/home.aria.yml"', { type: 'ariaSnapshot', file: 'snapshots/home.aria.yml' }],
      ['#badge does not contain "Basic"', { type: 'textNot', mode: 'contains', field: 'text' }],
      ['#badge does not have text "Basic"', { type: 'textNot', mode: 'equals', field: 'text' }],
      ['the Name field does not have value "x"', { type: 'textNot', mode: 'equals', field: 'value' }],
      ['the title matches "^Form"', { type: 'pageMatches', what: 'title', pattern: '^Form' }],
      ['the page text matches "/premium/i"', { type: 'pageMatches', what: 'text', pattern: 'premium', flags: 'i' }],
      ['the page does not match "Error \\d+"', { type: 'pageMatches', what: 'text', negate: true }],
    ];
    for (const [phrase, want] of cases) {
      const c = parseCondition(phrase);
      expect(c, phrase).toMatchObject(want);
      expect(parseCondition(conditionToText(c)), phrase).toEqual(c);
    }
    // The page-level forms keep their old meaning.
    expect(parseCondition('the page does not contain "Error"')).toMatchObject({ type: 'pageNotContainsText' });
    expect(parseCondition('the title contains "Orders"')).toMatchObject({ type: 'titleContains' });
    expect(() => parseCondition('the title matches "("')).toThrow();
  });

  it('matches aria snapshots partially, in order, with regex names and attributes', () => {
    const actual = parseAriaSnapshot(`- region "Order summary"
  - heading "Order summary" [level=2]
  - list "Lines"
    - listitem
      - text "Widget x 2"
    - listitem
      - text "Gadget x 1"
  - text "Total: 89.48"
  - button "Confirm order"
  - link "Change"`);
    const m = (t: string) => matchAriaSnapshot(parseAriaSnapshot(t), actual);
    expect(m('- region "Order summary"\n  - button "Confirm order"')).toEqual({ ok: true });
    expect(m('- heading /Order/ [level=2]\n- text "Gadget"')).toEqual({ ok: true });
    expect(m('- list\n  - listitem\n    - text "Gadget x 1"')).toEqual({ ok: true });
    expect(m('- button "Confirm order"\n- heading "Order summary"')).toMatchObject({ ok: false, missing: '- heading "Order summary"' });
    expect(m('- heading "Order summary" [level=1]')).toMatchObject({ ok: false });
    expect(m('- region "Order summary"\n  - button "Pay now"')).toMatchObject({ ok: false, missing: '- button "Pay now"' });
    expect(() => parseAriaSnapshot('button Save')).toThrow(/Cannot read the aria snapshot line/);
  });
});

describe('in journeys', () => {
  it('accessible name, description, role, negations and patterns hold on the form lab', async () => {
    await expectPasses(server.url, `Journey: Depth
Open /lab/form
Expect the "Help" link has accessible name "Help"
Expect the "Help" link has accessible description "Get help"
Expect the accessible name of the Name field is "Name"
Expect #terms has role "checkbox"
Expect the role of #badge is not "button"
Expect #badge does not contain "Basic"
Expect #badge does not have text "Premium plus"
Expect the Reference field does not have value "REF-2"
Expect the title matches "^Form lab$"
Expect the page text matches "/premium/i"
Expect the page does not match "Error \\d+"
`);
  });

  it('fails with the actual value when an accessible name differs', async () => {
    const { j } = await runEz(server.url, `Journey: Wrong name
Open /lab/form
Expect the "Help" link has accessible name "Support"
`, { conditionTimeoutMs: 300 });
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/accessible name is "Help", expected to be "Support"/);
  });

  it('aria snapshot: no baseline fails, --update-snapshots writes it, a renamed button fails with a diff, updating fixes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-aria-'));
    const ez = (v: string) => `Journey: Summary structure
Open /lab/summary?v=${v}
Expect the "Order summary" region matches the aria snapshot "order-summary"
`;
    const baseline = join(dir, '.eztest', 'aria', 'order-summary.aria.yml');
    const first = await runEz(server.url, ez('a'), { baseDir: dir, conditionTimeoutMs: 300 });
    expect(first.j.status).toBe('failed');
    expect(describeSteps(first.j)).toMatch(/no aria snapshot baseline .* --update-snapshots/);
    process.env.EZTEST_UPDATE_SNAPSHOTS = '1';
    await expectPasses(server.url, ez('a'), { baseDir: dir });
    delete process.env.EZTEST_UPDATE_SNAPSHOTS;
    expect(existsSync(baseline)).toBe(true);
    expect(readFileSync(baseline, 'utf8')).toContain('- button "Confirm order"');
    await expectPasses(server.url, ez('a'), { baseDir: dir });
    // The app renames the button: the structure check names the missing role/name and shows a diff.
    const renamed = await runEz(server.url, ez('b'), { baseDir: dir, conditionTimeoutMs: 300 });
    expect(renamed.j.status).toBe('failed');
    const msg = describeSteps(renamed.j);
    expect(msg).toMatch(/missing - button "Confirm order"/);
    process.env.EZTEST_UPDATE_SNAPSHOTS = '1';
    await expectPasses(server.url, ez('b'), { baseDir: dir });
    delete process.env.EZTEST_UPDATE_SNAPSHOTS;
    await expectPasses(server.url, ez('b'), { baseDir: dir });
    expect(readFileSync(baseline, 'utf8')).toContain('- button "Pay now"');
  }, 180_000); // seven journeys, each with its own browser

  it('a hand-written partial snapshot file and an inline YAML snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-aria2-'));
    await writeFile(join(dir, 'summary.aria.yml'), '- heading "Order summary"\n- list "Lines"\n  - listitem\n- button /Confirm|Pay/\n');
    await expectPasses(server.url, `Journey: Partial
Open /lab/summary
Expect the page matches the aria snapshot "summary.aria.yml"
`, { baseDir: dir });
    const { normalizeJourneyInput } = await import('../../src/intent/index.js');
    const { runJourneys } = await import('../../src/runner/index.js');
    const j = normalizeJourneyInput({ name: 'Inline', steps: ['Open /lab/summary', { intent: 'Check the summary', action: 'assert', postconditions: [{ type: 'ariaSnapshot', target: { description: 'the summary', locators: [{ strategy: 'role', value: 'region', name: 'Order summary' }] }, snapshot: '- text "Total: 89.48"\n- button "Confirm order"' }] }] });
    const run = await runJourneys([j], { baseUrl: server.url, outputDir: dir, stepTimeoutMs: 6000, locateTimeoutMs: 2000, conditionTimeoutMs: 2000 });
    expect(run.journeys[0].status, describeSteps(run.journeys[0])).toBe('passed');
  });
});
