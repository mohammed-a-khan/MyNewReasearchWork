/**
 * Heal review decisions: the store's semantics, and the healer refusing a
 * rejected heal (real Chromium, demo app variant b) so the step fails as a
 * suspected regression, including when the rejected heal sits in the T0 cache.
 */
import { describe, expect, it } from '../support/testkit.js';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHealer, HealDecisions, FingerprintStore, type HealDecision } from '../../src/heal/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { triageRun } from '../../src/insights/index.js';
import { readEvidenceManifest } from '../../src/insights/index.js';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { FAST, bobOrderJourney, tempDir } from '../runner/fixtures.js';

const signIn = { strategy: 'role' as const, value: 'button', name: 'Log in', exact: true };

function decision(over: Partial<HealDecision>): HealDecision {
  return { journeyId: 'j', stepId: 's', decision: 'rejected', tier: 'T1-fingerprint', locator: signIn, reviewer: 'Rita', decidedAt: '2026-10-01T00:00:00Z', ...over };
}

describe('HealDecisions', () => {
  it('blocks the rejected tier for the step and the rejected locator at any tier', () => {
    const d = HealDecisions.from([decision({})]);
    expect(d.rejection('j', 's', 'T1-fingerprint', { strategy: 'css', value: '#other' })?.reviewer).toBe('Rita');
    expect(d.rejection('j', 's', 'T0-cache', signIn)).toBeTruthy();
    expect(d.rejection('j', 's', 'T0-cache', { strategy: 'css', value: '#x' }, 'T1-fingerprint')).toBeTruthy();
    expect(d.rejection('j', 's', 'T2-semantic', { strategy: 'css', value: '#x' })).toBeUndefined();
    expect(d.rejection('j', 'other', 'T1-fingerprint', signIn)).toBeUndefined();
  });

  it('a later acceptance on the same heal replaces the rejection; remove() undoes', async () => {
    const d = HealDecisions.from([decision({})]);
    d.record(decision({ decision: 'accepted', decidedAt: '2026-10-02T00:00:00Z' }));
    expect(d.list()).toHaveLength(1);
    expect(d.rejection('j', 's', 'T1-fingerprint', signIn)).toBeUndefined();
    expect(d.remove('j', 's', 'T1-fingerprint', signIn)).toBe(true);
    const dir = await tempDir('decisions');
    const p = join(dir, 'heal-decisions.json');
    d.record(decision({}));
    await d.save(p);
    const back = await HealDecisions.open(p);
    expect(back.list()[0]).toMatchObject({ decision: 'rejected', reviewer: 'Rita' });
  });

  it('refuses a corrupt or unknown-format file instead of silently forgetting rejections', async () => {
    const dir = await tempDir('decisions-bad');
    const p = join(dir, 'd.json');
    await (await import('node:fs/promises')).writeFile(p, '{"version":2,"decisions":[]}');
    await expect(HealDecisions.open(p)).rejects.toThrow(/unsupported version/);
    await (await import('node:fs/promises')).writeFile(p, 'not json');
    await expect(HealDecisions.open(p)).rejects.toThrow(/not valid JSON/);
  });
});

async function runOn(variant: 'a' | 'b', store: string, decisions?: HealDecisions) {
  const server = await startDemoApp({ variant });
  const outputDir = await tempDir(`dec-${variant}`);
  try {
    const run = await runJourneys([bobOrderJourney()], { ...FAST, baseUrl: server.url, outputDir, fingerprintStore: store, healer: createHealer({}, { decisions }) });
    return { run, runDir: join(outputDir, run.runId) };
  } finally {
    await server.close();
  }
}

describe('healer respects heal decisions (real Chromium)', () => {
  it('a rejected T1 heal fails the step as a suspected regression; other steps still heal; the T0 cache cannot replay it', async () => {
    const dir = await tempDir('dec-store');
    const store = join(dir, 'fingerprints.json');
    expect((await runOn('a', store)).run.journeys[0].status).toBe('passed');
    const afterA = join(dir, 'after-a.json');
    await copyFile(store, afterA);

    const rejected = HealDecisions.from([decision({ journeyId: 'bob-order', stepId: 'click-the-sign-in-button', tier: 'T1-fingerprint', reason: 'the Log in button is a different control' })]);
    const b = await runOn('b', store, rejected);
    const j = b.run.journeys[0];
    expect(j.status).toBe('failed');
    const step = j.steps.find((s) => s.stepId === 'click-the-sign-in-button')!;
    expect(step.status).toBe('failed');
    expect(step.heal).toBeUndefined(); // the rejected candidate was never tried
    expect(step.error?.message).toMatch(/suspected regression: this heal was rejected in review by Rita/);
    // The username step (not rejected) still healed and was verified.
    expect(j.steps.find((s) => s.stepId.startsWith('type-bob'))?.status).toBe('passed-healed');
    // Triage reads it as a product bug (suspected regression), citing evidence.
    const t = triageRun({ run: b.run, evidence: await readEvidenceManifest(b.runDir) });
    expect(t.verdicts[0].candidates.some((c) => c.rule === 'rejected-heal' && c.category === 'product-bug')).toBe(true);

    // T0: heal once without decisions (so the heal is cached), then reject it -> the cache is not replayed.
    const cacheStore = join(dir, 'cache.json');
    await copyFile(afterA, cacheStore);
    const healed = await runOn('b', cacheStore);
    expect(healed.run.journeys[0].status).toBe('passed-healed');
    const mem = (await FingerprintStore.open(cacheStore)).get('bob-order', 'click-the-sign-in-button');
    expect(mem?.healed?.locator).toEqual(signIn);
    const again = await runOn('b', cacheStore, rejected);
    const s2 = again.run.journeys[0].steps.find((s) => s.stepId === 'click-the-sign-in-button')!;
    expect(s2.status).toBe('failed');
    expect(s2.error?.message).toMatch(/T0-cache: suspected regression: this heal was rejected in review/);
    expect(JSON.parse(await readFile(cacheStore, 'utf8')).version).toBe(1);
  }, 180_000);
});
