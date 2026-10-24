/**
 * Code journeys on the runner path (real Chromium, demo app): verified healing
 * inside code steps (variant b), the time-travel trace and evidence chain for
 * code steps, and the debugger (line breakpoints on step() and ui.* calls,
 * step over between SDK calls, no edit-and-continue for code).
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { join, resolve } from 'node:path';
import { verifyEvidence, type Journey } from '../../src/core/index.js';
import { createHealer } from '../../src/heal/index.js';
import { DebugController, DebugStateError, loadCodeJourneys, readTrace, runJourneys } from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { FAST, runDirOf, tempDir } from '../runner/fixtures.js';
import { flat, tree } from './helpers.js';

const FILE = resolve(__dirname, 'fixtures/runner/flows.journey.ts');
let journeys: Journey[];
let a: DemoServer;
beforeAll(async () => {
  journeys = await loadCodeJourneys(FILE, { cwd: await tempDir('sdk-cache') });
  a = await startDemoApp({ variant: 'a' });
});
afterAll(async () => {
  await a.close();
});

describe('code journeys on the runner path', () => {
  it('loads as a Journey with a code reference and a source-mapped placeholder step', () => {
    expect(journeys).toHaveLength(1);
    const j = journeys[0];
    expect(j).toMatchObject({ id: 'code-bob-order', name: 'Bob orders a gadget', tags: ['heal'], code: { file: FILE, name: 'Bob orders a gadget', line: 4 } });
    expect(j.steps[0]).toMatchObject({ action: 'code', source: { file: FILE, line: 4 } });
  });

  // Three full runs, each launching its browser (the heals of the second wait out the locate timeout of each
  // renamed element first): more than the default 60 s per test on a slow machine or Firefox.
  it('heals a renamed button inside code steps (variant b): verified by the post-condition, T0 cache next time', async () => {
    const dir = await tempDir('sdk-heal');
    const store = join(dir, 'fp.json');
    const r1 = await runJourneys(journeys, { ...FAST, baseUrl: a.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
    expect(r1.journeys[0].status, tree(r1.journeys[0].steps)).toBe('passed');
    const b = await startDemoApp({ variant: 'b' });
    try {
      const r2 = await runJourneys(journeys, { ...FAST, baseUrl: b.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
      const j = r2.journeys[0];
      expect(j.status, tree(j.steps)).toBe('passed-healed');
      const healed = flat(j.steps).filter((s) => s.status === 'passed-healed' && !s.children);
      expect(healed.map((s) => s.intent).sort()).toEqual(['Click the "Sign in" button', 'Click the "Submit order" button', 'Type "bob" into the Username field']);
      for (const s of healed) {
        expect(s.heal?.verified).toBe(true);
        expect(s.heal?.evidence.length).toBeGreaterThan(0);
      }
      // Groups that hold a healed step report passed-healed too.
      expect(j.steps.find((s) => s.intent === 'Sign in')!.status).toBe('passed-healed');
      expect((await verifyEvidence(runDirOf(dir, r2))).ok).toBe(true);
      const r3 = await runJourneys(journeys, { ...FAST, baseUrl: b.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
      const tiers = flat(r3.journeys[0].steps).filter((s) => s.heal).map((s) => s.heal!.tier);
      expect(tiers.length).toBe(3);
      expect(new Set(tiers)).toEqual(new Set(['T0-cache']));
      // With a verified heal cached, a step looks for its original element only briefly before using the heal,
      // instead of waiting out the locate timeout as the first heal had to.
      const healTime = (r: typeof r2) => flat(r.journeys[0].steps).filter((s) => s.heal && !s.children).reduce((t, s) => t + s.durationMs, 0);
      expect(healTime(r3)).toBeLessThan(healTime(r2));
    } finally {
      await b.close();
    }
  }, 120_000);

  it('a heal is never accepted when the outcome does not happen (variant b + silent save bug)', async () => {
    const dir = await tempDir('sdk-regress');
    const store = join(dir, 'fp.json');
    await runJourneys(journeys, { ...FAST, baseUrl: a.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
    const bug = await startDemoApp({ variant: 'b', bug: 'save-silently-fails' });
    try {
      const r = await runJourneys(journeys, { ...FAST, baseUrl: bug.url, outputDir: dir, fingerprintStore: store, healer: createHealer() });
      const j = r.journeys[0];
      expect(j.status).toBe('failed');
      const submit = flat(j.steps).find((s) => s.intent === 'Click the "Submit order" button')!;
      expect(submit.status).toBe('failed');
      expect(submit.error?.message).toMatch(/suspected regression/);
      // Nothing after the failed group ran.
      expect(flat(j.steps).some((s) => s.intent.startsWith('Read the text'))).toBe(false);
    } finally {
      await bug.close();
    }
  });

  it('records code steps in the time-travel trace with their nesting, and evidence ids exist', async () => {
    const dir = await tempDir('sdk-trace');
    const run = await runJourneys(journeys, { ...FAST, baseUrl: a.url, outputDir: dir, timeTravel: { enabled: true, screenshots: false } });
    const j = run.journeys[0];
    expect(j.status, tree(j.steps)).toBe('passed');
    const t = await readTrace(runDirOf(dir, run), j.journeyId, 1);
    const intents = t.steps.map((s) => s.intent);
    expect(intents).toContain('Click the "Sign in" button');
    expect(intents).toContain('Download the "Download invoice" link');
    // Node-side steps (value assertions, PDF reading) are in the trace too.
    expect(intents.some((i) => i.startsWith('Expect "ORD-'))).toBe(true);
    expect(intents.some((i) => i.startsWith('Read PDF'))).toBe(true);
    const click = t.steps.find((s) => s.intent === 'Click the "Sign in" button')!;
    expect(click.stepId).toMatch(/^L\d+$/);
    expect((await verifyEvidence(runDirOf(dir, run))).ok).toBe(true);
    const download = flat(j.steps).find((s) => s.intent.startsWith('Download'))!;
    expect(download.evidence.length).toBe(1);
  });

  it('debugger: line breakpoints on ui.* and step() lines, step over between SDK calls, no edit-and-continue', async () => {
    const dir = await tempDir('sdk-debug');
    const dbg = new DebugController({ breakpoints: [{ line: 9, file: 'flows.journey.ts' }] });
    const running = runJourneys(journeys, { ...FAST, baseUrl: a.url, outputDir: dir, debug: dbg });
    const s1 = await dbg.waitForPause();
    expect(s1).toMatchObject({ status: 'paused', phase: 'before-step', reason: 'breakpoint bp-1', intent: 'Click the "Sign in" button', source: { file: FILE, line: 9 } });
    expect(s1.code).toMatchObject({ name: 'Bob orders a gadget' });
    expect(dbg.page?.url()).toMatch(/\/login$/);
    expect(() => dbg.replaceStep('Click the "Log in" button')).toThrow(DebugStateError);
    expect(() => dbg.replaceStep('Click the "Log in" button')).toThrow(/code journey/);
    // Step over: the next SDK call is the step() group on line 11.
    dbg.stepOver();
    const s2 = await dbg.waitForPause();
    expect(s2).toMatchObject({ reason: 'step', intent: 'Create the order', source: { line: 11 } });
    expect(s2.url).toMatch(/\/dashboard$/);
    dbg.stepOver();
    const s3 = await dbg.waitForPause();
    expect(s3).toMatchObject({ reason: 'step', intent: 'Open /orders/new', source: { line: 12 } });
    // An ad-hoc .ez step still works against the live page while paused.
    const probe = await dbg.evaluate('Verify the page contains "Dashboard"');
    expect(probe.status).toBe('passed');
    dbg.addBreakpoint({ line: 17 });
    dbg.resume();
    const s4 = await dbg.waitForPause();
    expect(s4).toMatchObject({ source: { line: 17 } });
    expect(s4.intent).toMatch(/^Read the text of testid=order-number/);
    dbg.resume();
    const run = await running;
    expect(run.journeys[0].status, tree(run.journeys[0].steps)).toBe('passed');
  });
});
