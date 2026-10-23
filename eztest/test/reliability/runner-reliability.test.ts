/**
 * Flakiness root causes, handled (real Chromium, demo app /rel pages): each
 * test shows the failure mode without the fix and that the fix handles it.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { tempDir } from '../runner/fixtures.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

const OFF: RunOptions['reliability'] = { actionability: false, appIdle: false, verifyFill: false, reresolve: false };
const ON: RunOptions['reliability'] = { appIdle: true };

async function run(ez: string, reliability: RunOptions['reliability'], extra: Partial<RunOptions> = {}) {
  const out = await tempDir('rel');
  const r = await runJourneys([parseEzScript(ez)], {
    baseUrl: server.url, outputDir: out, stepTimeoutMs: 3000, locateTimeoutMs: 1500, conditionTimeoutMs: 1500, reliability, suggestLocators: false, ...extra,
  });
  return r.journeys[0];
}

describe('actionability: overlays are waited out, and named when they stay', () => {
  it('an overlay that stays fails with the overlay named in the error', async () => {
    const j = await run(`Journey: Overlay stays\nOpen /rel/overlay?ms=never\nClick the "Save" button\n  Expect the page contains "Saved"\n`, {});
    const step = j.steps[1];
    expect(step.status).toBe('failed');
    expect(step.error?.message).toMatch(/the "Save" button is covered by <div#cookie-banner\.overlay\.cookie-consent role=dialog> "Cookie consent" \(an overlay\); the click would land on it/);
  });

  it('an overlay that goes away is waited for and recorded as the root cause', async () => {
    const j = await run(`Journey: Overlay goes\nOpen /rel/overlay?ms=1500\nClick the "Save" button\n  Expect the page contains "Saved"\n`, {});
    expect(j.status).toBe('passed');
    const waits = j.steps[1].reliability?.waits ?? [];
    expect(waits.some((w) => w.cause === 'overlay' && /cookie-banner/.test(w.detail ?? '') && w.ms > 0)).toBe(true);
  });
});

describe('app idle: hydration and slow XHR', () => {
  const HYDRATE = `Journey: Hydration\nOpen /rel/hydrate?ms=700\nClick the "Apply discount" button\n  Expect the page contains "Discount applied"\n`;
  it('without the idle check a click before hydration is lost (the failure mode)', async () => {
    const j = await run(HYDRATE, OFF);
    expect(j.status).toBe('failed');
  });
  it('with the idle check the click waits for the pending request and works', async () => {
    const j = await run(HYDRATE, ON);
    expect(j.status).toBe('passed');
    expect(j.steps[1].reliability?.waits.some((w) => w.cause === 'network' && /pending request/.test(w.detail ?? ''))).toBe(true);
  });

  const SLOW = `Journey: Slow total\nOpen /rel/slow?ms=1500\nCapture the text of testid=basket-total as total\n  Expect \${total} == "42.50"\n`;
  it('a capture before the data arrived reads the placeholder without the idle check', async () => {
    const j = await run(SLOW, OFF);
    expect(j.status).toBe('failed');
    expect(String(j.ledger.total)).toBe('Loading...');
  });
  it('the capture reads the real value with the idle check', async () => {
    const j = await run(SLOW, ON);
    expect(j.status).toBe('passed');
    expect(j.ledger.total).toBe('42.50');
  });
});

describe('re-render safety', () => {
  const RERENDER = `Journey: Rerender after keystroke\nOpen /rel/rerender?on=input&ms=200\nType "Ann Lee" into the Full name field\nClick the "Greet" button\n  Expect the page contains "Hello, Ann Lee"\n`;
  it('a re-render right after typing wipes the value (the failure mode)', async () => {
    const j = await run(RERENDER, { appIdle: true, verifyFill: false });
    expect(j.status).toBe('failed');
  });
  it('the typed value is verified after the app settles and typed again into the re-rendered field', async () => {
    const j = await run(RERENDER, ON);
    expect(j.status).toBe('passed');
    const rec = j.steps[1].reliability?.recovered ?? [];
    expect(rec.some((r) => r.cause === 'detached' && /lost its value after a re-render/.test(r.detail))).toBe(true);
  });
});

describe('animations', () => {
  it('a sliding button is waited for until it stops (recorded as timing)', async () => {
    const j = await run(`Journey: Animated\nOpen /rel/animate?ms=2000\nClick the "Confirm" button\n  Expect the page contains "Confirmed"\n`, {});
    expect(j.status).toBe('passed');
    expect(j.steps[1].reliability?.waits.some((w) => w.cause === 'timing' && /animation|unstable/.test(w.detail ?? ''))).toBe(true);
  });

  it('slowMo pauses before each action (debugging only)', async () => {
    const t0 = Date.now();
    const j = await run(`Journey: Slow motion\nOpen /rel/animate\nClick the "Confirm" button\n`, { slowMo: 400 });
    expect(j.status).toBe('passed');
    expect(Date.now() - t0).toBeGreaterThan(800);
  });
});
