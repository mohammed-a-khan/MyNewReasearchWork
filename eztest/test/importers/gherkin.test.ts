import { describe, expect, it } from '../support/testkit.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEzScript } from '../../src/intent/index.js';
import { importGherkin, parseFeature, tableCells } from '../../src/importers/index.js';

const FEATURE = readFileSync(fileURLToPath(new URL('./fixtures/bob-order.feature', import.meta.url)), 'utf8');

// Lines read from free text carry an [unverified] marker until --verify replays them.
const plain = (ez: string) => ez.replace(/ \[unverified\]/g, '');
const lines = (ez: string) => plain(ez).split('\n');

describe('Gherkin importer', () => {
  const r = importGherkin(FEATURE, { file: 'bob-order.feature' });

  it('expands Scenario Outline examples into one journey per row with substituted values', () => {
    expect(r.converted.map((c) => c.name)).toEqual([
      'EZ Shop orders - Bob orders 2 x Gadget (49.50)',
      'EZ Shop orders - Bob orders 3 x Widget (19.99)',
      'EZ Shop orders - Sign-in page lists credentials fields',
    ]);
    const widget = r.converted[1].ez;
    expect(widget).toContain('Select "Widget (19.99)" from the Product dropdown');
    expect(widget).toContain('Fill the Quantity field with 3');
    expect(widget).toContain('  Expect testid=order-total has text "59.97"');
  });

  it('prepends Background steps, strips keywords and turns Then lines into post-conditions', () => {
    const l = lines(r.converted[0].ez);
    expect(l.slice(1, 3)).toEqual(['Journey: EZ Shop orders - Bob orders 2 x Gadget (49.50)', 'Description: Managers can create orders from the order form.']);
    expect(l).toContain('Tags: @shop @smoke @orders');
    const i = l.indexOf('Click the "Sign in" button');
    expect(i).toBeGreaterThan(0);
    expect(l[i - 3]).toBe('Open /login');
    expect(l[i + 1]).toBe('  Expect the URL contains "/dashboard"');
    expect(l[i + 2]).toBe('  Expect page contains "Welcome"');
    const j = r.journeys[0];
    const signIn = j.steps.find((s) => s.intent === 'Click the "Sign in" button')!;
    expect(signIn.postconditions).toEqual([
      { type: 'urlContains', value: '/dashboard' },
      { type: 'pageContainsText', value: 'Welcome' },
    ]);
    // the generated .ez parses back to the same journey
    expect(parseEzScript(r.converted[0].ez)).toEqual(j);
  });

  it('keeps unconvertible lines as TODO comments and in the report', () => {
    expect(r.converted[0].ez).toContain('# TODO (not converted): And the order is persisted in the ERP');
    expect(r.todo.filter((t) => t.original === 'And the order is persisted in the ERP')).toHaveLength(2);
    const table = r.todo.find((t) => t.reason.includes('data table'))!;
    expect(table).toMatchObject({ file: 'bob-order.feature', line: 35, original: 'And the following fields are shown:' });
    expect(r.converted[2].ez).toContain('# | Username |');
  });

  it('maps a single-line doc string onto the step', () => {
    expect(r.converted[2].ez).toContain('  Expect the page contains "Sign in to EZ Shop"');
  });

  it('counts coverage per generated journey', () => {
    // Background: 4 actions + 2 assertions per journey; outline: 4 actions + 3 assertions (1 TODO) x2; last: 1 action + 2 assertions (1 TODO)
    expect(r.coverage).toEqual({ sourceSteps: 4 * 2 + 4 * 2 + 5, convertedSteps: 21, assertions: 5 * 2 + 4, convertedAssertions: 11 });
    expect(r.converted[0].coverage).toEqual({ sourceSteps: 8, convertedSteps: 8, assertions: 5, convertedAssertions: 4 });
  });

  it('maps a two-column "fill in" data table to typing steps and turns a step after a TODO into a standalone assertion', () => {
    const rr = importGherkin(
      `Feature: F
  Scenario: Profile
    Given I am on the profile page
    When I fill in the form with:
      | field    | value |
      | Username | bob   |
      | Password | x\\|y  |
    Then I should see "Saved"
`,
      { file: 'f.feature' },
    );
    const ez = rr.converted[0].ez;
    expect(ez).toContain('# TODO (not converted): Given I am on the profile page');
    expect(ez).toContain('Type "bob" into the "Username" field');
    expect(ez).toContain('Type "x|y" into the "Password" field');
    expect(ez).toContain('  Expect page contains "Saved"');
    expect(rr.coverage).toEqual({ sourceSteps: 3, convertedSteps: 2, assertions: 1, convertedAssertions: 1 });
  });

  it('a scenario with nothing convertible yields no journey but keeps its TODOs', () => {
    const rr = importGherkin('Feature: X\n  Scenario: Vague\n    Given the system is ready\n    Then everything works\n', { file: 'x.feature' });
    expect(rr.journeys).toHaveLength(0);
    expect(rr.converted[0].journey).toBeUndefined();
    expect(rr.todo).toHaveLength(2);
    expect(rr.warnings.join()).toMatch(/no convertible steps/);
  });

  it('parses rules, tags and tables', () => {
    const f = parseFeature('@a\nFeature: F\n  Rule: R1\n    Background:\n      Given I open /x\n    @b\n    Example: E\n      When I click the "Go" button\n');
    expect(f.scenarios[0]).toMatchObject({ name: 'E', rule: 'R1', tags: ['b'] });
    expect(f.scenarios[0].backgrounds.flat()).toHaveLength(1);
    expect(tableCells('| a | b \\| c |  |')).toEqual(['a', 'b | c', '']);
    const rr = importGherkin('Feature: F\n  Rule: R1\n    Background:\n      Given I open /x\n    Example: E\n      When I click the "Go" button\n');
    expect(plain(rr.converted[0].ez)).toContain('Open /x\n# Scenario: E\nClick the "Go" button');
  });
});
