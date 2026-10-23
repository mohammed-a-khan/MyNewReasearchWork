/**
 * End to end: `.feature` files run natively by `eztest run` against the EZ
 * Shop demo app, with TypeScript step definitions (UI, API and DB steps, a
 * custom parameter type, the World, hooks) and EZTest phrasings with no glue
 * code; data tables, doc strings, outlines from inline tables, a CSV file and
 * an XLSX workbook; tag expressions; the reports' feature / rule / scenario
 * hierarchy; undefined, ambiguous and failing steps.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyEvidence, type StepResult } from '../../src/core/index.js';
import { bddProject, byId, cli, flat, latestRun, tree } from './helpers.js';

let restore: (() => Promise<void>) | undefined;
/** The results of a scenario's Gherkin steps (hooks left out). */
const gs = (j: { steps: StepResult[] }) => j.steps.filter((s) => s.gherkin?.kind === 'step');
/** Errors on stderr (warnings about the environment are not). */
const errors = (lines: string[]) => lines.filter((l) => !l.startsWith('warning:')).join('\n');
afterEach(async () => {
  await restore?.();
  restore = undefined;
});

describe('native BDD through eztest run (real browser, demo app)', () => {
  it('runs features with step definitions and EZTest phrasings; one result per scenario and Examples row', async () => {
    const p = await bddProject();
    restore = p.restore;
    const r = await cli(p.project, ['run', '--tags', '@shop and not @negative']);
    const { dir, run } = await latestRun(p.project);
    const summary = run.journeys.map((j) => `${j.journeyId} ${j.status}\n${tree(j.steps, 1)}`).join('\n');
    expect(errors(r.err), summary).toBe('');
    expect(run.journeys.map((j) => j.journeyId).sort(), summary).toEqual([
      'orders-ordering--eu-customers-come-from-the-database',
      'orders-ordering--place-an-order-through-the-ui',
      'orders-ordering--signed-in-as-user-1',
      'quotes--quote-for-a-gadget',
      'quotes--quote-from-a-json-request',
      'quotes--quote-sku-x-qty-from-a-csv-file-sku-200',
      'quotes--quote-sku-x-qty-from-a-csv-file-sku-300',
      'quotes--quote-sku-x-qty-from-a-workbook-sku-100',
      'quotes--quote-sku-x-qty-from-a-workbook-sku-300',
    ]);
    for (const j of run.journeys) expect(j.status, `${j.journeyId}\n${tree(j.steps)}`).toBe('passed');
    expect(r.exitCode).toBe(0);

    // Step results map one to one to Gherkin steps (Background first), each bound to a definition or an EZTest phrasing.
    const place = byId(run, 'orders-ordering--place-an-order-through-the-ui');
    expect(place.steps.map((s) => s.intent)).toEqual([
      expect.stringMatching(/^Before hook \(steps\/hooks\.steps\.ts:\d+\)$/),
      'Given I am on "/login"', 'When I type "bob" into the "Username" field', 'And I type "Builder#2" into the "Password" field', 'And I click the "Sign in" button',
      'Then the URL contains "/dashboard"', 'When I order 3 "Gadget (49.50)" for "Contoso Ltd"', 'Then the page contains "created"', 'And the order total is 148.50',
      'And the database has 1 order for "Contoso Ltd"',
      expect.stringMatching(/^After hook \(steps\/hooks\.steps\.ts:\d+\)$/),
    ] as unknown as string[]);
    expect(place.steps[0].gherkin).toMatchObject({ kind: 'before', match: 'hook' });
    const steps = gs(place);
    expect(steps.map((s) => s.gherkin?.match)).toEqual(['ez', 'ez', 'ez', 'ez', 'ez', 'definition', 'ez', 'definition', 'definition']);
    expect(steps.slice(0, 5).every((s) => s.gherkin?.background)).toBe(true);
    expect(steps.map((s) => s.stepId)).toEqual(['L7', 'L8', 'L9', 'L10', 'L11', 'L15', 'L16', 'L17', 'L18']);
    // An EZTest phrasing runs as the EZTest step itself (healing, evidence): no group around it.
    expect(steps[1].children).toBeUndefined();
    expect(steps[1].evidence.length).toBeGreaterThan(0);
    const order = steps[5];
    expect(order.gherkin?.location).toMatch(/^steps\/shop\.steps\.ts:\d+$/);
    expect(order.gherkin?.pattern).toBe('I order {int} {string} for {string}');
    expect(order.children!.map((c) => c.intent)).toEqual(expect.arrayContaining([expect.stringMatching(/^Open \/orders\/new/), expect.stringMatching(/^Click/)]));
    expect(place.tags).toEqual(['shop', 'ui', 'smoke', 'req:REQ-BDD-1']);
    expect(place.requirements).toEqual(['REQ-BDD-1']);
    expect(place.bdd).toEqual({ file: 'features/orders/ordering.feature', feature: { name: 'Ordering in the EZ Shop', line: 2 }, scenario: { name: 'Place an order through the UI', line: 14, keyword: 'Scenario' } });
    expect(place.ledger.hookLog).toEqual(['before:EZ Shop', 'after:passed']);
    // The database really has the order.
    expect((p.app.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_by = 'bob'").get() as { n: number }).n).toBe(1);

    // A data table passed to a definition.
    const eu = byId(run, 'orders-ordering--eu-customers-come-from-the-database');
    expect(gs(eu).at(-1)!.gherkin).toMatchObject({ match: 'definition', text: 'the EU customers are:' });
    // Zero glue code: an outline whose steps are all EZTest phrasings.
    const signed = byId(run, 'orders-ordering--signed-in-as-user-1');
    expect(signed.name).toBe('Signed in as bob');
    expect(gs(signed).slice(5).map((s) => [s.intent, s.gherkin?.match])).toEqual([
      ['Given I am on "/dashboard"', 'ez'], ['Then the page contains "Welcome, bob"', 'ez'], ['And the "Recent orders" table is visible', 'ez'],
    ]);
    expect(signed.bdd?.examples).toEqual({ name: '', line: 32, row: { line: 34, index: 0 } });
    expect(signed.tags).toContain('inline');

    // API steps, a doc string, a Rule, a regex definition and tag-filtered hooks.
    const gadget = byId(run, 'quotes--quote-for-a-gadget');
    expect(gadget.bdd?.rule).toEqual({ name: 'Quotes are priced per unit', line: 5 });
    expect(gadget.steps[0].intent).toMatch(/^Before hook: api scenarios/);
    expect(gadget.steps.find((s) => s.intent === 'And the quote is for "Gadget"')!.gherkin?.pattern).toBe('/^the quote is for "([^"]+)"$/');
    expect(gadget.ledger.hookLog).toEqual(['before-api', 'before:EZ Shop', 'after:passed']);
    const json = byId(run, 'quotes--quote-from-a-json-request');
    expect(json.steps.find((s) => s.intent === 'When I post this quote request:')!.children!.some((c) => /^POST /.test(c.intent) || /quote/.test(c.intent))).toBe(true);
    // Outlines from a CSV file (filtered) and an XLSX sheet: one result per row.
    const csv = byId(run, 'quotes--quote-sku-x-qty-from-a-csv-file-sku-200');
    expect(csv.name).toBe('Quote SKU-200 x 2 from a CSV file');
    expect(gs(csv).map((s) => s.intent)).toEqual(['When I request a quote for 2 of "SKU-200"', 'Then the quote total is 99.00']);
    expect(csv.tags).toContain('csv');
    expect(byId(run, 'quotes--quote-sku-x-qty-from-a-workbook-sku-100').name).toBe('Quote SKU-100 x 5 from a workbook');

    // Reports: JUnit with one suite per feature, the JSON and HTML hierarchy.
    const junit = await readFile(join(dir, 'junit.xml'), 'utf8');
    expect(junit).toContain('<testsuite name="Ordering in the EZ Shop"');
    expect(junit).toContain('<testsuite name="Price quotes"');
    expect(junit).toMatch(/<testcase name="Place an order through the UI" classname="Ordering in the EZ Shop"/);
    expect(junit).toMatch(/<testcase name="Quote for a gadget" classname="Price quotes\.Quotes are priced per unit"/);
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as { bdd?: { features: Array<{ name: string; rules: Array<{ name: string }>; scenarios: unknown[] }> } };
    expect(report.bdd?.features.map((f) => f.name)).toEqual(['Ordering in the EZ Shop', 'Price quotes']);
    expect(report.bdd?.features[1].rules.map((x) => x.name)).toEqual(['Quotes are priced per unit', 'Quotes for many products']);
    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('Features');
    expect(html).toContain('Quotes are priced per unit');
    expect((await verifyEvidence(dir)).ok).toBe(true);
    void flat;
  });

  it('reports undefined steps with a snippet, ambiguous steps, failures that skip the rest, and step hooks', async () => {
    const p = await bddProject();
    restore = p.restore;
    const r = await cli(p.project, ['run', '--tags', '@negative or @hooks']);
    expect(r.exitCode).toBe(1);
    const { run } = await latestRun(p.project);
    const undef = byId(run, 'problems--an-undefined-step');
    expect(undef.status).toBe('failed');
    const u = gs(undef)[1];
    expect(u.gherkin?.match).toBe('undefined');
    expect(u.error?.name).toBe('UndefinedStep');
    expect(u.gherkin?.snippet).toBe([
      "When('I do something nobody defined with {string} and {int}', async ({ ui, api, db, world }, string, int) => {",
      '  // Turn the phrase above into ui / api / db calls.',
      "  throw new Error('pending');",
      '});',
    ].join('\n'));
    expect(gs(undef)[2].status).toBe('skipped');
    expect(gs(undef)[2].error?.message).toMatch(/^not run: step "When I do something nobody defined/);
    expect(undef.steps.at(-1)!.gherkin?.kind).toBe('after');
    expect(undef.ledger.hookLog).toEqual(['before:EZ Shop', 'after:failed']);

    const amb = byId(run, 'problems--an-ambiguous-step');
    expect(gs(amb)[0].error?.name).toBe('AmbiguousStep');
    expect(gs(amb)[0].error?.message).toMatch(/2 step definitions match/);
    expect(gs(amb)[0].gherkin?.location).toMatch(/^steps\/hooks\.steps\.ts:\d+, steps\/hooks\.steps\.ts:\d+$/);

    const failing = byId(run, 'problems--a-failing-step-skips-the-rest-and-the-after-hook-still-runs');
    expect(failing.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'failed', 'skipped', 'passed']);
    expect(gs(failing)[1].gherkin?.match).toBe('ez');
    expect(failing.ledger.hookLog).toEqual(['before:EZ Shop', 'after:failed']);
    expect(failing.error?.message).toMatch(/^Then the page contains "Not on this page"/);

    const throws = byId(run, 'problems--a-step-definition-that-throws');
    expect(gs(throws)[0].status).toBe('failed');
    expect(gs(throws)[0].children!.at(-1)!.intent).toMatch(/^Code error at hooks\.steps\.ts:\d+$/);
    expect(gs(throws)[0].error?.message).toBe('business rule violated');

    const hooks = byId(run, 'hooks--hooks-around-every-step');
    expect(hooks.status, tree(hooks.steps)).toBe('passed');
    expect(hooks.ledger.hookLog).toEqual(['before:EZ Shop', 'step:5', 'after-step:passed', 'step:6', 'after-step:passed', 'after:passed']);
    // With step hooks, an EZTest phrasing runs inside a group for its Gherkin step.
    expect(gs(hooks)[1].children!.map((c) => c.intent)).toEqual(['Open "/login"']);
  });

  it('validate binds every step and prints snippets for undefined ones', async () => {
    const p = await bddProject();
    restore = p.restore;
    const ok = await cli(p.project, ['validate', 'features/quotes.feature', 'features/orders']);
    expect(errors(ok.err)).toBe('');
    expect(ok.out.join('\n')).toMatch(/^ok {5}\S*features\/quotes\.feature \(4 scenarios; 5 steps with definitions, 0 EZTest phrasings\)$/m);
    expect(ok.out.join('\n')).toMatch(/ordering\.feature \(3 scenarios; \d+ steps with definitions, \d+ EZTest phrasings\)/);
    const bad = await cli(p.project, ['validate', 'features/problems.feature']);
    expect(bad.exitCode).toBe(1);
    const err = bad.err.join('\n');
    expect(err).toMatch(/problems\.feature:6: undefined step "I do something nobody defined with "x" and 3"/);
    expect(err).toMatch(/When\('I do something nobody defined with \{string\} and \{int\}'/);
    expect(err).toMatch(/problems\.feature:10: ambiguous step "a duplicated step"/);
    // External Examples are checked too.
    await writeFile(join(p.project, 'features', 'missing.feature'), 'Feature: M\n  Scenario Outline: O\n    Given I am on "/<page>"\n    Examples: from data "data/nope.csv"\n');
    const missing = await cli(p.project, ['validate', 'features/missing.feature']);
    expect(missing.exitCode).toBe(1);
    expect(missing.err.join('\n')).toMatch(/missing\.feature:4: Examples: Examples data file not found: data\/nope\.csv/);
  });
});
