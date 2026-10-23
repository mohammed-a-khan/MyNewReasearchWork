import { describe, expect, it } from '../support/testkit.js';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventBus, verifyEvidence, type EzEvent } from '../../src/core/index.js';
import { createHealer, type HealProposalFile } from '../../src/heal/index.js';
import { runJourneys, SUSPECTED_REGRESSION } from '../../src/runner/index.js';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { FAST, bobOrderJourney, tempDir } from '../runner/fixtures.js';

async function runOn(variant: 'a' | 'b', bug: 'none' | 'save-silently-fails', storePath: string, events?: EventBus) {
  const server = await startDemoApp({ variant, bug });
  const outputDir = await tempDir(`heal-${variant}`);
  try {
    const run = await runJourneys([bobOrderJourney()], {
      ...FAST, baseUrl: server.url, outputDir, fingerprintStore: storePath, healer: createHealer(), events,
    });
    return { run, runDir: join(outputDir, run.runId) };
  } finally {
    await server.close();
  }
}

describe('verified healing (real Chromium, demo app variants)', () => {
  it('records on variant a, heals on variant b (T1, verified), reuses the T0 cache, and never hides a regression', async () => {
    const dir = await tempDir('heal-store');
    const store = join(dir, 'fingerprints.json');

    // 1. Variant a: everything passes, fingerprints are recorded.
    const a = await runOn('a', 'none', store);
    expect(a.run.journeys[0].status).toBe('passed');
    const afterA = join(dir, 'after-a.json');
    await copyFile(store, afterA);

    // 2. Variant b: renamed ids/text. Steps heal through fingerprints and are verified.
    const events: EzEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const b = await runOn('b', 'none', store, bus);
    const jb = b.run.journeys[0];
    expect(jb.steps.map((s) => `${s.stepId}:${s.status}:${s.error?.message ?? ''}`).filter((s) => s.includes('failed'))).toEqual([]);
    expect(jb.status).toBe('passed-healed');
    expect(b.run.summary.passedHealed).toBe(1);
    const healed = jb.steps.filter((s) => s.status === 'passed-healed');
    expect(healed.map((s) => s.stepId).sort()).toEqual(['click-the-sign-in-button', 'click-the-submit-order-button', 'type-bob-into-the-username-field']);
    for (const s of healed) {
      expect(s.heal?.verified).toBe(true);
      expect(s.heal?.tier).toBe('T1-fingerprint');
      expect(s.heal?.confidence).toBeGreaterThanOrEqual(0.72);
      expect(s.heal?.evidence.length).toBeGreaterThan(0);
    }
    const signIn = healed.find((s) => s.stepId === 'click-the-sign-in-button')!;
    expect(signIn.heal?.healed).toEqual({ strategy: 'role', value: 'button', name: 'Log in', exact: true });
    expect(signIn.conditions.every((c) => c.passed)).toBe(true);
    expect(healed.find((s) => s.stepId.startsWith('type-bob'))!.heal?.healed).toMatchObject({ strategy: 'role', value: 'textbox', name: 'Email or username' });
    expect(events.filter((e) => e.type === 'heal')).toHaveLength(3);
    // Unchanged steps are plain passes, never passed-healed.
    expect(jb.steps.find((s) => s.stepId === 'type-builder-2-into-the-password-field')?.status).toBe('passed');

    const proposals = JSON.parse(await readFile(join(b.runDir, 'heal-proposals.json'), 'utf8')) as HealProposalFile;
    expect(proposals.proposals).toHaveLength(3);
    expect(proposals.rejected).toHaveLength(0);
    const p = proposals.proposals.find((x) => x.stepId === 'click-the-sign-in-button')!;
    expect(p.original[0]).toMatchObject({ strategy: 'role', name: 'Sign in' });
    expect(p.suggestedTarget?.locators[0]).toEqual(p.healed);
    expect((await verifyEvidence(b.runDir)).ok).toBe(true);

    // 3. Variant b again: the verified heals come from the T0 cache.
    const b2 = await runOn('b', 'none', store);
    const jb2 = b2.run.journeys[0];
    expect(jb2.status).toBe('passed-healed');
    const tiers = jb2.steps.filter((s) => s.heal).map((s) => [s.stepId, s.heal!.tier, s.heal!.verified]);
    expect(tiers).toHaveLength(3);
    for (const t of tiers) expect(t.slice(1)).toEqual(['T0-cache', true]);

    // 4. Variant b with a real bug (order save silently fails): the order
    //    button is found by healing, but the outcome does not happen -> failed.
    const regressionStore = join(dir, 'regression.json');
    await copyFile(afterA, regressionStore);
    const bug = await runOn('b', 'save-silently-fails', regressionStore);
    const jr = bug.run.journeys[0];
    expect(jr.status).toBe('failed');
    const order = jr.steps.find((s) => s.stepId === 'click-the-submit-order-button')!;
    expect(order.status).toBe('failed');
    expect(order.status).not.toBe('passed-healed');
    expect(order.error?.message).toContain(SUSPECTED_REGRESSION);
    expect(order.error?.message).toContain('suspected regression: a matching element was found but the expected outcome did not happen');
    expect(order.heal?.verified).toBe(false);
    const bugProposals = JSON.parse(await readFile(join(bug.runDir, 'heal-proposals.json'), 'utf8')) as HealProposalFile;
    expect(bugProposals.rejected.map((r) => r.stepId)).toEqual(['click-the-submit-order-button']);
    expect(bugProposals.proposals.map((r) => r.stepId)).not.toContain('click-the-submit-order-button');
    // Earlier steps healed fine; later ones did not run.
    expect(jr.steps.find((s) => s.stepId === 'click-the-sign-in-button')?.status).toBe('passed-healed');
    expect(jr.steps.at(-1)?.status).toBe('skipped');
  });

  it('without a healer, variant b simply fails (no silent fallback)', async () => {
    const server = await startDemoApp({ variant: 'b' });
    const outputDir = await tempDir('heal-none');
    try {
      const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir });
      const s = run.journeys[0].steps.find((x) => x.status === 'failed')!;
      expect(s.stepId).toBe('type-bob-into-the-username-field');
      expect(s.error?.message).toMatch(/no locator candidate matched exactly one element/);
    } finally {
      await server.close();
    }
  });
});
