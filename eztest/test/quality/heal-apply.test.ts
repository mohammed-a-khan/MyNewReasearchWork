/**
 * Accepting a heal rewrites the journey file per format: .ez phrase rewrite
 * (with the step id pinned), .ez sidecar fallback (merged by the loader),
 * YAML/JSON string steps (phrase) and object steps (target locators), with
 * comments preserved and a unified diff.
 */
import { describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { planHealRewrite, phrasesFor, rewriteStepLine, sidecarPath, unifiedDiff, type HealRewritePlan } from '../../src/heal/index.js';
import { loadJourneyFile, parseEzScript, normalizeJourneyInput } from '../../src/intent/index.js';
import { loadJourneys, findJourneyFiles } from '../../src/cli/journeys.js';
import { BOB_ORDER_EZ, tempDir } from '../runner/fixtures.js';

const placeOrder = { strategy: 'role' as const, value: 'button', name: 'Place order', exact: true };
const STEP = 'click-the-submit-order-button';

async function plan(file: string, text: string, journeyId: string, stepId: string, healed = placeOrder as Parameters<typeof planHealRewrite>[0]['healed']): Promise<HealRewritePlan> {
  return planHealRewrite({ file, displayPath: file.split('/').slice(-2).join('/'), text, journeyId, stepId, healed, now: '2026-10-22T00:00:00.000Z' });
}

describe('accept-heal rewrite: .ez', () => {
  it('rewrites the target phrase, pins the step id, keeps everything else and parses back to the healed locator', async () => {
    const dir = await tempDir('apply-ez');
    const file = join(dir, 'bob.ez');
    await writeFile(file, BOB_ORDER_EZ);
    const p = await plan(file, BOB_ORDER_EZ, 'bob-order', STEP);
    expect(p.method).toBe('ez-phrase');
    expect(p.newLine).toBe(`Click the "Place order" button [id=${STEP}]`);
    expect(p.changes).toHaveLength(1);
    const after = p.changes[0].after;
    expect(after.split('\n').filter((l, i) => l !== BOB_ORDER_EZ.split('\n')[i])).toEqual([`Click the "Place order" button [id=${STEP}]`]);
    const j = parseEzScript(after);
    expect(j.steps.map((s) => s.id)).toEqual(parseEzScript(BOB_ORDER_EZ).steps.map((s) => s.id));
    expect(j.steps.find((s) => s.id === STEP)!.target!.locators[0]).toEqual(placeOrder);
    // Post-conditions of the step are untouched.
    expect(j.steps.find((s) => s.id === STEP)!.postconditions).toEqual(parseEzScript(BOB_ORDER_EZ).steps.find((s) => s.id === STEP)!.postconditions);
    // Unified diff: one removed and one added line with context.
    const d = p.changes[0].diff;
    expect(d.filter((l) => l.kind === '-').map((l) => l.text)).toEqual(['Click the "Submit order" button']);
    expect(d.filter((l) => l.kind === '+').map((l) => l.text)).toEqual([`Click the "Place order" button [id=${STEP}]`]);
    expect(p.changes[0].unified).toMatch(/^--- a\/.*bob\.ez\n\+\+\+ b\//);
  });

  it('rewrites a step nested in an If block (and a repeated step by occurrence), keeping its indentation', async () => {
    const text = [
      'Journey: Nested',
      'Open /orders/new',
      'Click the "Submit order" button',
      '  Expect the page contains "created"',
      'If the "Submit order" button is visible then',
      '  Click the "Submit order" button',
      '    Expect the page contains "created"',
      'End',
      '',
    ].join('\n');
    const j = parseEzScript(text);
    const { flattenSteps } = await import('../../src/core/index.js');
    const ids = flattenSteps(j.steps).map((s) => s.id);
    const nestedId = ids.filter((id) => id.startsWith(STEP)).pop()!;
    expect(nestedId).not.toBe(STEP);
    const p = await plan('/x/nested.ez', text, j.id, nestedId);
    expect(p.method).toBe('ez-phrase');
    const after = p.changes[0].after.split('\n');
    expect(after[5]).toBe(`  Click the "Place order" button [id=${nestedId}]`);
    expect(after[2]).toBe('Click the "Submit order" button'); // the top-level step is untouched
    const back = flattenSteps(parseEzScript(p.changes[0].after).steps);
    expect(back.map((s) => s.id)).toEqual(ids);
    expect(back.find((s) => s.id === nestedId)!.target!.locators[0]).toEqual(placeOrder);
  });

  it('keeps an existing annotation and adds the id inside it', () => {
    const j = parseEzScript('Journey: J\nClick the "Save" button [optional]\n  Expect the page contains "ok"\n');
    const r = rewriteStepLine('Click the "Save" button [optional]', j.steps[0], { strategy: 'role', value: 'button', name: 'Store', exact: true });
    expect(r?.line).toBe('Click the "Store" button [id=click-the-save-button optional]');
  });

  it('uses grammar selector forms (testid=, #id) and label phrases for fields', () => {
    expect(phrasesFor({ strategy: 'testId', value: 'place-order' }, 'click')).toEqual(['testid=place-order']);
    expect(phrasesFor({ strategy: 'css', value: '#place-order' }, 'click')).toEqual(['#place-order']);
    expect(phrasesFor({ strategy: 'label', value: 'Email', exact: true }, 'fill')[0]).toBe('the "Email" field');
    const j = parseEzScript('Journey: J\nType "bob" into the Username field\n');
    const r = rewriteStepLine('Type "bob" into the Username field', j.steps[0], { strategy: 'label', value: 'Email or username', exact: true });
    expect(r?.line).toBe('Type "bob" into the "Email or username" field [id=type-bob-into-the-username-field]');
  });

  it('falls back to a sidecar for a locator no phrase expresses; the loader puts it first', async () => {
    const dir = await tempDir('apply-side');
    const jdir = join(dir, 'journeys');
    await (await import('node:fs/promises')).mkdir(jdir);
    const file = join(jdir, 'bob.ez');
    await writeFile(file, BOB_ORDER_EZ);
    const css = { strategy: 'css' as const, value: 'form.order > button.primary' };
    const p = await plan(file, BOB_ORDER_EZ, 'bob-order', STEP, css);
    expect(p.method).toBe('ez-sidecar');
    expect(p.changes[0].path).toMatch(/bob\.ez\.locators\.json$/);
    expect(p.changes[0].existed).toBe(false);
    await writeFile(sidecarPath(file), p.changes[0].after);
    // The sidecar is not itself a journey, and the loader merges it.
    expect((await findJourneyFiles([jdir], dir)).map((f) => f.split('/').pop())).toEqual(['bob.ez']);
    const { journeys, errors } = await loadJourneys([jdir], dir);
    expect(errors).toEqual([]);
    expect(journeys[0].steps.find((s) => s.id === STEP)!.target!.locators[0]).toEqual(css);
    // The .ez text itself is unchanged.
    expect(await readFile(file, 'utf8')).toBe(BOB_ORDER_EZ);
    // A second accepted heal for the same step goes first; earlier ones stay as fallbacks.
    const p2 = await plan(file, BOB_ORDER_EZ, 'bob-order', STEP, { strategy: 'xpath', value: '//form//button[2]' });
    const side = JSON.parse(p2.changes[0].after);
    expect(side.steps[STEP].locators.map((l: { strategy: string }) => l.strategy)).toEqual(['xpath', 'css']);
  });

  it('refuses the wrong journey or an unknown step', async () => {
    await expect(plan('/x/bob.ez', BOB_ORDER_EZ, 'other', STEP)).rejects.toThrow(/holds journey "bob-order"/);
    await expect(plan('/x/bob.ez', BOB_ORDER_EZ, 'bob-order', 'nope')).rejects.toThrow(/Step "nope" is not in/);
  });
});

const YAML_TEXT = `# Order journey (YAML)
name: YAML order
id: yaml-order
steps:
  - Open /orders/new
  # the submit step
  - intent: Click the "Submit order" button
    expect:
      - page contains "created"
  - Click the "Download invoice" link
  - intent: Click the save button
    target:
      description: the save button
      locators:
        - { strategy: css, value: "#save" }
`;

describe('accept-heal rewrite: YAML and JSON', () => {
  it('rewrites a plain-English string step as a phrase (YAML)', async () => {
    const p = await plan('/p/j/order.yaml', YAML_TEXT, 'yaml-order', 'click-the-download-invoice-link', { strategy: 'role', value: 'link', name: 'Get invoice', exact: true });
    expect(p.method).toBe('yaml-phrase');
    expect(p.changes[0].after).toContain('- Click the "Get invoice" link [id=click-the-download-invoice-link]');
    expect(p.changes[0].after).toContain('# the submit step');
    expect(p.changes[0].after).toContain('# Order journey (YAML)');
  });

  it('puts the healed locator first in an object step target, keeping the rest (YAML)', async () => {
    const p = await plan('/p/j/order.yaml', YAML_TEXT, 'yaml-order', 'click-the-save-button', { strategy: 'testId', value: 'save-btn' });
    expect(p.method).toBe('yaml-target');
    const j = normalizeJourneyInput(YAML.parse(p.changes[0].after));
    expect(j.steps[3].target!.locators).toEqual([{ strategy: 'testId', value: 'save-btn' }, { strategy: 'css', value: '#save' }]);
    expect(p.changes[0].after).toContain('# the submit step');
  });

  it('adds a target to an object step that only had an intent (YAML), pinning its id', async () => {
    const css = { strategy: 'css' as const, value: 'form > button.go' };
    const p = await plan('/p/j/order.yaml', YAML_TEXT, 'yaml-order', STEP, css);
    expect(p.method).toBe('yaml-target');
    const j = normalizeJourneyInput(YAML.parse(p.changes[0].after));
    const s = j.steps.find((x) => x.id === STEP)!;
    expect(s.target!.locators[0]).toEqual(css);
    expect(s.target!.locators.slice(1).map((l) => l.strategy)).toEqual(['role', 'text']);
    expect(s.postconditions).toHaveLength(1);
  });

  it('JSON: string step -> phrase; object target -> locators; indentation kept', async () => {
    const json = JSON.stringify({ name: 'JSON order', id: 'json-order', steps: ['Open /orders/new', 'Click the "Submit order" button', { intent: 'Click the save button', target: { description: 'the save button', locators: [{ strategy: 'css', value: '#save' }] } }] }, null, 4) + '\n';
    const a = await plan('/p/j/o.json', json, 'json-order', STEP);
    expect(a.method).toBe('json-phrase');
    expect(a.changes[0].after).toContain(`        "Click the \\"Place order\\" button [id=${STEP}]"`);
    const b = await plan('/p/j/o.json', json, 'json-order', 'click-the-save-button', { strategy: 'css', value: '#store' });
    expect(b.method).toBe('json-target');
    expect(JSON.parse(b.changes[0].after).steps[2].target.locators).toEqual([{ strategy: 'css', value: '#store' }, { strategy: 'css', value: '#save' }]);
  });

  it('loads the rewritten files from disk through the normal loader', async () => {
    const dir = await tempDir('apply-yaml');
    const file = join(dir, 'order.yaml');
    const p = await plan(file, YAML_TEXT, 'yaml-order', 'click-the-save-button', { strategy: 'testId', value: 'save-btn' });
    await writeFile(file, p.changes[0].after);
    expect((await loadJourneyFile(file)).steps[3].target!.locators[0]).toEqual({ strategy: 'testId', value: 'save-btn' });
  });
});

describe('unifiedDiff', () => {
  it('keeps 3 lines of context and numbers both sides', () => {
    const a = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n');
    const b = a.replace('l6', 'L6');
    const d = unifiedDiff(a, b);
    expect(d.map((l) => `${l.kind}${l.text}`)).toEqual([' l3', ' l4', ' l5', '-l6', '+L6', ' l7', ' l8', ' l9']);
    expect(d[3]).toMatchObject({ oldNo: 6 });
    expect(d[4]).toMatchObject({ newNo: 6 });
  });
});
