/**
 * Electron for real: EZTest launches a sample Electron app (devDependency
 * `electron`) with --remote-debugging-port=0 under Xvfb and drives it over
 * CDP through the CdpPageSeam (no Playwright). Skipped only when the
 * electron package or an X display/Xvfb is missing.
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { createDesktopIntegration } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { ensureDisplay } from './xvfb.js';

let hasElectron = false;
try {
  hasElectron = typeof createRequire(import.meta.url)('electron') === 'string';
} catch {
  hasElectron = false;
}
const display = hasElectron ? await ensureDisplay() : undefined;
afterAll(() => display?.stop());

const APP = resolve('test/desktop/fixtures/electron-app/main.cjs');
const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

async function runEz(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-electron-')));
  const integration = createDesktopIntegration({ desktop: { electron: { env: { DISPLAY: display!.display } } } }, { baseDir: process.cwd() });
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 10_000, conditionTimeoutMs: 4000, stepInterceptors: [integration.interceptor], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

(hasElectron && display ? describe : describe.skip)('Electron rung (real Electron over CDP)', () => {
  it('App: electron header launches the app; web phrasings act in its window; trace evidence is written', async () => {
    const { j, run, outputDir } = await runEz(`Journey: Place an order in the desktop app
App: electron "${APP}"
Expect the screen to contain "Orders Desk"
Type "Contoso" into the "Customer" field
Select "South" from the "Region" dropdown
Check the "Rush order" checkbox
Click the "Place order" button
  Expect the page to contain "Order placed for Contoso (South, rush)"
Press Enter in the "Customer" field
  Expect the screen to contain "Looked up Contoso"
Read #status as status
Click the "Open report" button
Switch to the new window
  Expect the screen to contain "3 orders today"
`, { screenshots: 'every-step' });
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.status).toBe('Looked up Contoso');
    const click = j.steps.find((s) => s.intent === 'Click the "Place order" button')!;
    expect(click.surface).toMatchObject({ driver: 'electron', rung: 'object' });
    expect(click.usedLocator).toMatchObject({ strategy: 'role', value: 'button', name: 'Place order' });
    const manifest = (await readFile(join(outputDir, run.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const ev = manifest.filter((e) => click.evidence.includes(e.id));
    expect(ev.map((e) => e.kind).sort()).toEqual(['dom', 'screenshot']);
    const png = await readFile(join(outputDir, run.runId, ev.find((e) => e.kind === 'screenshot')!.path));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });

  it('heals a changed button from its fingerprint (verified) and fails clearly on a missing one', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-electron-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    const ok = await runEz(`Journey: Heal
App: electron "${APP}"
Type "Initech" into the "Customer" field
Click the "Place order" button
  Expect the screen to contain "Order placed for Initech"
`, { outputDir, fingerprintStore });
    expect(ok.j.status, describeSteps(ok.j)).toBe('passed');
    // The next release renames the button to "Submit order": the fingerprint finds it, the expectation verifies it.
    const healed = await runEz(`Journey: Heal
App: electron "${APP}" --variant=renamed
Type "Initech" into the "Customer" field
Click the "Place order" button
  Expect the screen to contain "Order placed for Initech"
`, { outputDir, fingerprintStore });
    const step = healed.j.steps.find((s) => s.intent.startsWith('Click'))!;
    expect(step.status, describeSteps(healed.j)).toBe('passed-healed');
    expect(step.heal).toMatchObject({ tier: 'T1-fingerprint', verified: true });
    const missing = await runEz(`Journey: Missing
App: electron "${APP}"
Click the "Cancel order" button
`);
    expect(missing.j.steps[0].error?.message).toMatch(/no locator candidate matched exactly one element for the "Cancel order" button/);
  });
});
