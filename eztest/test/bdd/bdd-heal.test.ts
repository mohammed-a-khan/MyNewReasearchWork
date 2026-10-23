/**
 * Healing of Gherkin steps that run as EZTest phrasings: a renamed UI (demo app
 * variant b) heals the steps, verified; heals inside groups (steps wrapped by step
 * hooks) reach the heal proposals, the report and the Studio's Heal review, and an
 * accepted heal goes to the feature's sidecar, which later runs use first.
 */
import { afterEach, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { flattenStepResults } from '../../src/core/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { bddProject, cli, latestRun, tree } from './helpers.js';

const FEATURE = `@healing
Feature: Healing

  Scenario: Sign in
    Given I am on "/login"
    When I type "bob" into the "Username" field
    And I type "Builder#2" into the "Password" field
    And I press Enter
    Then the URL contains "/dashboard"

  @hooks
  Scenario: Sign in with step hooks
    Given I am on "/login"
    When I type "bob" into the "Username" field
    And I type "Builder#2" into the "Password" field
    And I press Enter
    Then the URL contains "/dashboard"
`;

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => undefined);
  cleanup = [];
});

describe('healing Gherkin steps', () => {
  it('heals fallback steps (top level and inside groups), lists them for review and applies an accepted heal through the sidecar', async () => {
    const p = await bddProject();
    let restored = false;
    cleanup.push(async () => !restored && p.restore());
    await writeFile(join(p.project, 'features', 'heal.feature'), FEATURE);
    const first = await cli(p.project, ['run', '--tags', '@healing']);
    expect(first.exitCode, (await latestRun(p.project)).run.journeys.map((j) => tree(j.steps)).join('\n')).toBe(0);

    // The same app with renamed ids, labels and texts.
    await p.restore();
    restored = true;
    const app: DemoServer = await startDemoApp({ variant: 'b', dbFile: join(p.project, 'shop.db') });
    const saved = { url: process.env.SHOP_URL, db: process.env.SHOP_DB };
    process.env.SHOP_URL = app.url;
    process.env.SHOP_DB = join(p.project, 'shop.db');
    cleanup.push(async () => {
      await app.close();
      for (const [k, v] of [['SHOP_URL', saved.url], ['SHOP_DB', saved.db]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const second = await cli(p.project, ['run', '--tags', '@healing']);
    const { dir, run } = await latestRun(p.project);
    const all = run.journeys.map((j) => `${j.journeyId} ${j.status}\n${tree(j.steps)}`).join('\n');
    expect(run.journeys.map((j) => j.status), all).toEqual(['passed-healed', 'passed-healed']);
    expect(second.exitCode).toBe(0);
    const top = run.journeys.find((j) => j.journeyId === 'heal--sign-in')!;
    const nested = run.journeys.find((j) => j.journeyId === 'heal--sign-in-with-step-hooks')!;
    const click = top.steps.find((s) => s.intent === 'When I type "bob" into the "Username" field')!;
    expect(click.status).toBe('passed-healed');
    expect(click.heal?.verified).toBe(true);
    // With step hooks the phrasing runs inside the Gherkin step's group: the heal is one level down.
    const group = nested.steps.find((s) => s.intent === 'When I type "bob" into the "Username" field')!;
    expect(group.status).toBe('passed-healed');
    expect(group.heal).toBeUndefined();
    const inner = group.children!.find((c) => c.heal)!;
    expect(inner.stepId).toBe(`${group.stepId}-1`);

    // Proposals (file, report) include the nested heals.
    const hp = JSON.parse(await readFile(join(dir, 'heal-proposals.json'), 'utf8')) as { proposals: Array<{ journeyId: string; stepId: string }> };
    expect(hp.proposals.map((x) => `${x.journeyId}/${x.stepId}`)).toEqual(expect.arrayContaining([`heal--sign-in/${click.stepId}`, `heal--sign-in-with-step-hooks/${inner.stepId}`]));
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as { insights: { healProposals: Array<{ journeyId: string; stepId: string }> } };
    expect(report.insights.healProposals.map((x) => `${x.journeyId}/${x.stepId}`)).toContain(`heal--sign-in-with-step-hooks/${inner.stepId}`);
    expect(await readFile(join(dir, 'junit.xml'), 'utf8')).toContain(`eztest.heal.${inner.stepId}`);

    // Quality > Heal review lists both; accepting the top-level one writes the feature's sidecar.
    const studio: StudioHandle = await startStudio({ cwd: p.project, recordHeadless: true, watch: false });
    cleanup.push(() => studio.close());
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    const heals = (await api('GET', '/api/quality/heals')).json.items as Array<{ journeyId: string; stepId: string; healed: unknown; tier: string; file?: { path: string; format: string } }>;
    const mine = heals.filter((x) => x.journeyId.startsWith('heal--'));
    expect(mine.map((x) => `${x.journeyId}/${x.stepId}`)).toEqual(expect.arrayContaining([`heal--sign-in/${click.stepId}`, `heal--sign-in-with-step-hooks/${inner.stepId}`]));
    const item = mine.find((x) => x.journeyId === 'heal--sign-in' && x.stepId === click.stepId)!;
    expect(item.file).toEqual({ path: 'features/heal.feature', format: 'feature' });
    const ref = { journeyId: item.journeyId, stepId: item.stepId, healed: item.healed, tier: item.tier };
    const preview = (await api('POST', '/api/quality/heals/preview', { items: [ref] })).json;
    expect(preview.errors).toEqual([]);
    expect(preview.plans[0].method).toBe('feature-sidecar');
    expect(preview.files[0].path).toBe('features/heal.feature.locators.json');
    const ok = await api('POST', '/api/quality/heals/accept', { items: [ref], reviewer: 'Ann', expected: { [preview.files[0].path]: preview.files[0].beforeHash }, confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(existsSync(join(p.project, 'features', 'heal.feature.locators.json'))).toBe(true);
    expect(await readFile(join(p.project, 'features', 'heal.feature'), 'utf8')).toBe(FEATURE);

    // The next run uses the accepted locator first: the step passes without healing; listing the feature ignores the sidecar file.
    await studio.close();
    const third = await cli(p.project, ['run', '--tags', '@healing']);
    expect(third.exitCode).toBe(0);
    const again = (await latestRun(p.project)).run.journeys.find((j) => j.journeyId === 'heal--sign-in')!;
    const clickAgain = again.steps.find((s) => s.intent === 'When I type "bob" into the "Username" field')!;
    expect(clickAgain.status, tree(again.steps)).toBe('passed');
    expect(clickAgain.heal).toBeUndefined();
    expect(flattenStepResults(again.steps).length).toBeGreaterThan(4);
  });
});
