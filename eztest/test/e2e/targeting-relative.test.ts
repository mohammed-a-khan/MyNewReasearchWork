/**
 * E2E (real browser): relative and scoped targets against /lab/relative, in
 * .ez, YAML and the SDK, with strictness (ambiguous anchors fail clearly) and
 * verified healing inside a scope.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { flattenStepResults } from '../../src/core/index.js';
import { createHealer } from '../../src/heal/index.js';
import { loadJourneyFile } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { describeSteps, expectPasses, FAST, outDir, runEz } from './advanced-helpers.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('relative and scoped targets (.ez)', () => {
  it('rows, sections, layout anchors, near and ordinals each pick the one element meant', async () => {
    await expectPasses(server.url, `Journey: Relative
Open /lab/relative
Click the "Edit" button in the row containing "Bob"
Expect the "Nothing yet" status is hidden
Expect the page contains "Editing Bob"
Click the "Delete" button in the "Acme" row
Expect the page contains "Deleted Acme"
Click the 2nd "Delete" button
Expect the page contains "Deleted Bob"
Click the last "Edit" button
Expect the page contains "Editing Acme"
Type "bill@example.com" into the field below "Email" inside the "Billing" section
Expect the value of the field below "Email" inside the "Billing" section is "bill@example.com"
Type "ship@example.com" into the field below "Email" in the "Shipping" section
Type "3" into the input right of the "Qty" text inside the "Billing" section
Type "R-9" into the field to the right of "Ref" inside the "Shipping" section
Expect #billing-email has value "bill@example.com"
Expect #shipping-email has value "ship@example.com"
Expect #billing-qty has value "3"
Expect #shipping-ref has value "R-9"
Type "555" into the field below "Phone" inside the "Billing" section
Expect #billing-phone has value "555"
Click the "Recalculate" button near "Total"
Expect the page contains "Recalculated near total"
Expect there are 3 "Edit" buttons
Expect there is 1 "Edit" button in the row containing "Alice"
Expect the "Edit" button in the row containing "Alice" is visible
`);
  });

  it('an ambiguous anchor fails with a clear message (strict), and is never healed', async () => {
    const { j } = await runEz(server.url, `Journey: Ambiguous anchor
Open /lab/relative
Type "x" into the field below "Email"
`, { healer: createHealer() });
    expect(j.status).toBe('failed');
    const step = flattenStepResults(j.steps).find((s) => s.result.stepId.startsWith('type-x'))!.result;
    expect(step.error?.message).toMatch(/anchor "Email" matched 2 elements/);
    expect(step.heal).toBeUndefined();
  });

  it('a target matching several elements suggests how to name one', async () => {
    const { j } = await runEz(server.url, `Journey: Ambiguous target
Open /lab/relative
Click the "Edit" button
`);
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/name one, e\.g\. the "Edit" button in the row containing "Alice", or the 2nd "Edit" button/);
  });

  it('a missing row or container says which one', async () => {
    const { j } = await runEz(server.url, `Journey: Missing row
Open /lab/relative
Click the "Edit" button in the row containing "Zed" [timeout=1s]
`);
    expect(j.status).toBe('failed');
    expect(describeSteps(j)).toMatch(/row containing "Zed" not found/);
  });

  it('heals a renamed container anchor (its own memory), verified by the outcome; ambiguity is never healed', async () => {
    const dir = await outDir('rel-anchor');
    const store = join(dir, 'fp.json');
    const ez = (v: string) => `Journey: Anchor heal
Open /lab/relative?v=${v}
Click the "Edit" button in the row containing "Bob" inside the "Customers" table [id=edit-bob-table]
Expect the page contains "Editing Bob"
`;
    const first = await runEz(server.url, ez('a'), { fingerprintStore: store, healer: createHealer() });
    expect(first.j.status, describeSteps(first.j)).toBe('passed');
    const { FingerprintStore } = await import('../../src/heal/index.js');
    expect((await FingerprintStore.open(store)).get('anchor-heal', 'edit-bob-table~scope0')?.fingerprint).toMatchObject({ role: 'table', name: 'Customers' });
    // The table is renamed "Clients": the container heals (T1 fingerprint), and "Editing Bob" verifies it.
    const second = await runEz(server.url, ez('b'), { fingerprintStore: store, healer: createHealer() });
    expect(second.j.status, describeSteps(second.j)).toBe('passed-healed');
    const step = flattenStepResults(second.j.steps).find((s) => s.result.stepId === 'edit-bob-table')!.result;
    expect(step.heal).toMatchObject({ anchor: 0, verified: true, healed: { strategy: 'role', value: 'table', name: 'Clients' } });
    // Without a healer the renamed container is reported by name.
    const plain = await runEz(server.url, ez('b'), {});
    expect(describeSteps(plain.j)).toMatch(/container the "Customers" table not found/);
  });

  it('heals inside the scope and verifies the heal', async () => {
    const dir = await outDir('rel-heal');
    const store = join(dir, 'fp.json');
    // The first run records the fingerprint of the Edit button in Bob's row.
    const ez = (label: string) => `Journey: Scoped heal
Open /lab/relative
Click the "${label}" button in the row containing "Bob" [id=edit-bob]
Expect the page contains "Editing Bob"
`;
    const first = await runEz(server.url, ez('Edit'), { fingerprintStore: store, healer: createHealer() });
    expect(first.j.status).toBe('passed');
    // The label in the journey drifts ("Modify"): the healer finds the button in Bob's row, and the outcome verifies it.
    const { parseEzScript } = await import('../../src/intent/index.js');
    const run = await runJourneys([parseEzScript(ez('Modify'))], { ...FAST, baseUrl: server.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
    const healed = flattenStepResults(run.journeys[0].steps).find((s) => s.result.status === 'passed-healed');
    expect(run.journeys[0].status, describeSteps(run.journeys[0])).toBe('passed-healed');
    expect(healed?.result.heal?.verified).toBe(true);
  });
});

describe('relative targets in YAML and JSON', () => {
  it('string steps and structured targets with a scope run the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-rel-yaml-'));
    const file = join(dir, 'relative.yaml');
    await writeFile(file, `name: Relative YAML
steps:
  - Open /lab/relative
  - Click the "Edit" button in the row containing "Alice"
  - intent: Fill the Billing phone
    action: fill
    value: "777"
    target:
      description: the Billing phone field
      locators: [{ strategy: role, value: textbox }]
      scope:
        - relation: within
          anchor: { description: the Billing section, locators: [{ strategy: section, value: Billing }] }
        - relation: below
          anchor: { description: Phone, locators: [{ strategy: text, value: Phone, exact: true }] }
    expect:
      - the page contains "Editing Alice"
      - '#billing-phone has value "777"'
`);
    const journey = await loadJourneyFile(file);
    expect(journey.steps[2].target?.scope?.[0]).toMatchObject({ relation: 'within' });
    const run = await runJourneys([journey], { ...FAST, baseUrl: server.url, outputDir: dir });
    expect(run.journeys[0].status, describeSteps(run.journeys[0])).toBe('passed');
  });
});

describe('relative targets and the clock from the SDK', () => {
  it('ui.* with plain-English scopes, within/inRow/below/rightOf/near/nth helpers, and clock', async () => {
    const { loadCodeJourneys } = await import('../../src/runner/index.js');
    const { resolve } = await import('node:path');
    const journeys = await loadCodeJourneys(resolve('test/e2e/fixtures/targeting.journey.ts'));
    const run = await runJourneys(journeys, { ...FAST, baseUrl: server.url, outputDir: await outDir('sdk-rel'), timezone: 'UTC' });
    for (const j of run.journeys) expect(j.status, `${j.name}: ${j.error?.message ?? ''}\n${describeSteps(j)}`).toBe('passed');
  });
});
