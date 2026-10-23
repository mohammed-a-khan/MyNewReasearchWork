/**
 * E2E (real browser + Studio): the shared element repository. Two journeys use
 * one element (by @reference and by alias); the app renames the button; both
 * heal through one memory (@elements/<id>); ONE accepted heal in the Quality
 * Center (diff preview first) rewrites elements/checkout.yaml, and the next
 * run passes both journeys without healing.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { loadJourneys } from '../../src/cli/journeys.js';
import { flattenStepResults, type RunResult } from '../../src/core/index.js';
import { ElementRepository } from '../../src/elements/index.js';
import { createHealer, FingerprintStore } from '../../src/heal/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client } from '../studio/helpers.js';
import { describeSteps, FAST } from './advanced-helpers.js';

let server: DemoServer;
let project: string;
let studio: StudioHandle;

const ELEMENTS = `# The checkout screen, shared by every journey that places an order.
screen: Checkout
elements:
  placeOrder:
    description: the "Place order" button
    locators:
      - role=button[name="Place order"]
    aliases: [the Checkout button]
  emptyBasket: the "Empty basket" button
  unusedThing: testid=nothing-uses-this
`;

beforeAll(async () => {
  server = await startDemoApp();
  project = await mkdtemp(join(tmpdir(), 'eztest-elements-'));
  await mkdir(join(project, 'journeys'));
  await mkdir(join(project, 'elements'));
  await writeFile(join(project, 'eztest.config.yaml'), `baseUrl: ${server.url}\nbrowser: chromium\nheadless: true\njourneysDir: journeys\noutputDir: eztest-results\n`);
  await writeFile(join(project, 'elements', 'checkout.yaml'), ELEMENTS);
  await writeFile(join(project, 'journeys', 'place-by-reference.ez'), `Journey: Place by reference
Open /lab/checkout?v=\${variant}
Click the @Checkout.placeOrder button
Expect the page contains "Order placed"
`);
  await writeFile(join(project, 'journeys', 'place-by-alias.ez'), `Journey: Place by alias
Open /lab/checkout?v=\${variant}
Click the "Empty basket" button
Expect the page contains "Basket emptied"
Click the Checkout button
Expect the page contains "Order placed"
`);
  studio = await startStudio({ cwd: project, watch: false });
});

afterAll(async () => {
  await studio?.close();
  await server?.close();
});

async function runProject(variant: string, heal: boolean): Promise<RunResult> {
  const { journeys, errors } = await loadJourneys(['journeys'], project);
  expect(errors).toEqual([]);
  return runJourneys(journeys, {
    ...FAST, baseUrl: server.url, outputDir: join(project, 'eztest-results'), fingerprintStore: join(project, '.eztest', 'fingerprints.json'),
    variables: { variant }, elements: await ElementRepository.load(project), ...(heal ? { healer: createHealer() } : {}),
  });
}

describe('shared element repository', () => {
  it('one accepted heal in the Quality Center fixes both journeys', async () => {
    // 1. Both journeys pass on the original app; the element's fingerprint is stored once, by id.
    const a = await runProject('a', true);
    for (const j of a.journeys) expect(j.status, describeSteps(j)).toBe('passed');
    const store = await FingerprintStore.open(join(project, '.eztest', 'fingerprints.json'));
    expect(store.get('@elements', 'Checkout.placeOrder')?.fingerprint).toMatchObject({ role: 'button', name: 'Place order' });

    // 2. The app renames the button: both journeys heal (verified by "Order placed"), through one memory.
    const b = await runProject('b', true);
    for (const j of b.journeys) expect(j.status, describeSteps(j)).toBe('passed-healed');
    const heals = b.journeys.flatMap((j) => flattenStepResults(j.steps).map((s) => s.result.heal).filter(Boolean));
    expect(heals).toHaveLength(2);
    for (const h of heals) expect(h).toMatchObject({ element: 'Checkout.placeOrder', verified: true });

    // 3. The Quality Center shows ONE item for the element, with both usages; the preview is a diff of the element file.
    const c = client(studio.port, studio.token);
    const inbox = (await c.get('/api/quality/heals')).json();
    const items = inbox.items.filter((i: { element?: string }) => i.element === 'Checkout.placeOrder');
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.usages.map((u: { journeyName: string }) => u.journeyName).sort()).toEqual(['Place by alias', 'Place by reference']);
    expect(item.file.path).toBe('elements/checkout.yaml');
    const ref = { journeyId: item.journeyId, stepId: item.stepId, healed: item.healed, tier: item.tier, runId: item.lastRunId, element: item.element };
    const preview = (await c.post('/api/quality/heals/preview', { items: [ref] })).json();
    expect(preview.errors).toEqual([]);
    expect(preview.plans[0].method).toBe('element-yaml');
    expect(preview.files.map((f: { path: string }) => f.path)).toEqual(['elements/checkout.yaml']);
    const added = preview.files[0].diff.filter((l: { kind: string }) => l.kind === '+').map((l: { text: string }) => l.text).join('\n');
    expect(added).toMatch(/Submit order|submit-order-v2/);
    // Nothing is written by the preview.
    expect(await readFile(join(project, 'elements', 'checkout.yaml'), 'utf8')).toBe(ELEMENTS);

    const accepted = await c.post('/api/quality/heals/accept', { items: [ref], reviewer: 'Rae', expected: { 'elements/checkout.yaml': preview.files[0].beforeHash }, confirm: true });
    expect(accepted.status, accepted.body).toBe(200);
    expect(accepted.json().written).toEqual(['elements/checkout.yaml']);
    const yaml = await readFile(join(project, 'elements', 'checkout.yaml'), 'utf8');
    expect(yaml).toContain('# The checkout screen, shared by every journey');
    expect(yaml).toContain('role=button[name="Place order"]');
    // The journeys were not touched.
    expect(await readFile(join(project, 'journeys', 'place-by-reference.ez'), 'utf8')).toContain('Click the @Checkout.placeOrder button');
    const after = (await c.get('/api/quality/heals')).json().items.find((i: { element?: string }) => i.element === 'Checkout.placeOrder');
    expect(after.status).toBe('accepted');

    // 4. Next run, healing off: both journeys pass with the repository's new locator.
    const fixed = await runProject('b', false);
    for (const j of fixed.journeys) expect(j.status, describeSteps(j)).toBe('passed');
    const store2 = await FingerprintStore.open(join(project, '.eztest', 'fingerprints.json'));
    expect(store2.get('@elements', 'Checkout.placeOrder')?.healed).toBeUndefined();
  }, 240_000); // eight journey runs, each with its own browser

  it('the Studio Elements page lists elements with usages, unused ones and problems', async () => {
    const c = client(studio.port, studio.token);
    const r = (await c.get('/api/project/elements')).json();
    const place = r.elements.find((e: { id: string }) => e.id === 'Checkout.placeOrder');
    expect(place.usages.map((u: { journeyName: string }) => u.journeyName).sort()).toEqual(['Place by alias', 'Place by reference']);
    expect(place.usages.find((u: { journeyName: string }) => u.journeyName === 'Place by alias').via).toBe('description');
    expect(r.unused).toEqual(['Checkout.unusedThing']);
    expect(r.unknown).toEqual([]);
  });
});
