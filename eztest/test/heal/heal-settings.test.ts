/**
 * healing.requireVerification and healing.autoApply, through the engine and
 * the config (real Chromium, demo app: variant a records fingerprints, variant b
 * renames the login form).
 *
 * - requireVerification: true (default): a heal of a step with no post-condition
 *   fails ("could not be verified"). false: it passes healed, marked unverified,
 *   listed under `unverified` in heal-proposals.json, never cached or applied.
 * - autoApply: true writes the verified heals into the journey file (with a
 *   diff in the run folder and accepted decisions); the next run passes without
 *   healing. Off by default: the journey file is never touched.
 */
import { describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { createEngine, HEAL_APPLIED_FILES } from '../../src/engine/index.js';
import { loadJourneys } from '../../src/cli/journeys.js';
import { AUTO_APPLY_REVIEWER, FingerprintStore, type HealProposalFile } from '../../src/heal/index.js';
import type { RunResult } from '../../src/core/index.js';
import { startDemoApp } from '../../examples/demo-app/server.js';
import { FAST, tempDir } from '../runner/fixtures.js';

const LOGIN = `Journey: Bob signs in
Id: login
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
  Expect the URL contains "/dashboard"
`;
// The same, with nothing to verify the click: a heal of it cannot be verified.
const LOGIN_UNCHECKED = `Journey: Bob signs in, unchecked
Id: login-unchecked
Open /login
Type "bob" into the Username field
Type "Builder#2" into the Password field
Click the "Sign in" button
`;

async function project(journey: string, file: string): Promise<string> {
  const dir = await tempDir('heal-settings');
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), 'journeysDir: journeys\noutputDir: results\nreporters: [console]\nvideo: off\n');
  await writeFile(join(dir, 'journeys', file), journey);
  return dir;
}

async function runOn(dir: string, variant: 'a' | 'b', healing: Record<string, unknown> = {}): Promise<{ run: RunResult; runDir: string }> {
  const server = await startDemoApp({ variant });
  try {
    const loaded = await loadConfig({ cwd: dir, environment: {}, overrides: { baseUrl: server.url, healing } });
    const { journeys, errors } = await loadJourneys(['journeys'], dir);
    expect(errors).toEqual([]);
    const engine = await createEngine(loaded, { cwd: dir, runOptions: { ...FAST } });
    try {
      const run = await engine.run(journeys);
      return { run, runDir: join(engine.runOptions.outputDir, run.runId) };
    } finally {
      await engine.close();
    }
  } finally {
    await server.close();
  }
}

const step = (run: RunResult, id: string) => run.journeys[0].steps.find((s) => s.stepId === id)!;

describe('healing.requireVerification', () => {
  it('true fails an unverifiable heal; false passes it healed, marked unverified, never cached or applied', async () => {
    const dir = await project(LOGIN_UNCHECKED, 'login-unchecked.ez');
    expect((await runOn(dir, 'a')).run.journeys[0].status).toBe('passed');

    const strict = await runOn(dir, 'b');
    const click = step(strict.run, 'click-the-sign-in-button');
    expect(click.status).toBe('failed');
    expect(click.error?.message).toMatch(/heal could not be verified: the step has no post-conditions/);

    const lenient = await runOn(dir, 'b', { requireVerification: false, autoApply: true });
    expect(lenient.run.journeys[0].status).toBe('passed-healed');
    const healed = step(lenient.run, 'click-the-sign-in-button');
    expect(healed.status).toBe('passed-healed');
    expect(healed.heal).toMatchObject({ verified: false, unverified: true });
    expect(healed.warnings?.join(' ')).toMatch(/unverified heal .*requireVerification is false/);
    const proposals = JSON.parse(await readFile(join(lenient.runDir, 'heal-proposals.json'), 'utf8')) as HealProposalFile;
    expect(proposals.unverified?.map((p) => p.stepId)).toEqual(['click-the-sign-in-button']);
    expect(proposals.proposals.map((p) => p.stepId)).not.toContain('click-the-sign-in-button');
    expect(proposals.rejected.map((p) => p.stepId)).not.toContain('click-the-sign-in-button');
    // Never cached as a heal, never written back, never accepted.
    const store = await FingerprintStore.open(join(dir, '.eztest', 'fingerprints.json'));
    expect(store.get('login-unchecked', 'click-the-sign-in-button')?.healed).toBeUndefined();
    // autoApply wrote the verified heal of the typed field (its value is checked), not the unverified click.
    const text = await readFile(join(dir, 'journeys', 'login-unchecked.ez'), 'utf8');
    expect(text.split('\n').at(-2)).toBe('Click the "Sign in" button');
    const applied = JSON.parse(await readFile(join(lenient.runDir, HEAL_APPLIED_FILES.json), 'utf8')) as { applied: Array<{ stepId: string }> };
    expect(applied.applied.map((a) => a.stepId)).toEqual(['type-bob-into-the-username-field']);
  }, 180_000);

  it('false still fails a heal whose post-condition does not hold (a suspected regression is never accepted)', async () => {
    const dir = await project(LOGIN.replace('Expect the URL contains "/dashboard"', 'Expect the URL contains "/nowhere"'), 'login.ez');
    await runOn(dir, 'a');
    const r = await runOn(dir, 'b', { requireVerification: false });
    const click = step(r.run, 'click-the-sign-in-button');
    expect(click.status).toBe('failed');
    expect(click.heal?.unverified).toBeUndefined();
  }, 180_000);
});

describe('healing.autoApply', () => {
  it('off (default): the journey file is not touched', async () => {
    const dir = await project(LOGIN, 'login.ez');
    await runOn(dir, 'a');
    const r = await runOn(dir, 'b');
    expect(r.run.journeys[0].status).toBe('passed-healed');
    expect(await readFile(join(dir, 'journeys', 'login.ez'), 'utf8')).toBe(LOGIN);
    expect(existsSync(join(r.runDir, HEAL_APPLIED_FILES.json))).toBe(false);
  }, 180_000);

  it('on: verified heals are written into the journey file with a diff and accepted decisions; the next run needs no healing', async () => {
    const dir = await project(LOGIN, 'login.ez');
    await cp(join(dir, 'journeys', 'login.ez'), join(dir, 'login.before.ez'));
    await runOn(dir, 'a');
    const r = await runOn(dir, 'b', { autoApply: true });
    expect(r.run.journeys[0].status).toBe('passed-healed');
    const out = JSON.parse(await readFile(join(r.runDir, HEAL_APPLIED_FILES.json), 'utf8')) as { applied: Array<{ stepId: string; file: string }>; skipped: unknown[] };
    expect(out.applied.map((a) => a.stepId).sort()).toEqual(['click-the-sign-in-button', 'type-bob-into-the-username-field']);
    expect(new Set(out.applied.map((a) => a.file))).toEqual(new Set(['journeys/login.ez']));
    const diff = await readFile(join(r.runDir, HEAL_APPLIED_FILES.diff), 'utf8');
    expect(diff).toContain('--- a/journeys/login.ez');
    expect(diff).toMatch(/^-Click the "Sign in" button$/m);
    expect(diff).toMatch(/^\+.*Log in.*$/m);
    const text = await readFile(join(dir, 'journeys', 'login.ez'), 'utf8');
    expect(text).not.toBe(LOGIN);
    expect(text).toContain('Log in');
    const decisions = JSON.parse(await readFile(join(dir, '.eztest', 'heal-decisions.json'), 'utf8')) as { decisions: Array<{ stepId: string; decision: string; reviewer: string }> };
    expect(decisions.decisions.filter((d) => d.reviewer === AUTO_APPLY_REVIEWER && d.decision === 'accepted').map((d) => d.stepId).sort()).toEqual(['click-the-sign-in-button', 'type-bob-into-the-username-field']);

    // With healing off, the rewritten journey passes on the renamed UI.
    const again = await runOn(dir, 'b', { enabled: false });
    expect(again.run.journeys[0].steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
  }, 240_000);
});
