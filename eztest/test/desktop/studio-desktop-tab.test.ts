/**
 * Studio shows desktop/legacy results through its run-detail extension point:
 * the "Desktop & legacy" tab lists the driver and rung of each step, how the
 * element was found, the screen picture and the terminal screen text. A real
 * Studio server and a real Chromium, driven over EZTest's own CDP seam (no
 * Playwright), with a run produced by the TN3270 simulator.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ElectronApp, createDesktopIntegration, type CdpPageSeam } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { MainframeSimulator, createDemoBankApp } from '../../src/legacy/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { findChromium } from '../../src/browser/launcher/find.js';

function chromiumBinary(): string | undefined {
  try {
    return findChromium().executablePath;
  } catch {
    return undefined;
  }
}

const chrome = chromiumBinary();
let sim: MainframeSimulator;
let studio: StudioHandle;
let runId = '';

beforeAll(async () => {
  if (!chrome) return;
  sim = new MainframeSimulator(createDemoBankApp());
  const { port } = await sim.start();
  const project = await mkdtemp(join(tmpdir(), 'eztest-studio-desktop-'));
  await writeFile(join(project, 'eztest.config.yaml'), 'outputDir: eztest-results\n');
  const { interceptor } = createDesktopIntegration({ mainframe: { hosts: { bank: { host: '127.0.0.1', port } } } });
  const run = await runJourneys([parseEzScript(`Journey: Mainframe sign on
Connect to mainframe "bank"
Type "CLERK01" into the "USERID" field
Type "SECRET1" into the "PASSWORD" field
Press Enter
  Expect the screen to contain "MAIN MENU"
`)], { outputDir: join(project, 'eztest-results'), stepInterceptors: [interceptor], conditionTimeoutMs: 3000 });
  expect(run.journeys[0].status).toBe('passed');
  runId = run.runId;
  studio = await startStudio({ cwd: project });
}, 120_000);

afterAll(async () => {
  await studio?.close();
  await sim?.stop();
});

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined as T);
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

(chrome ? describe : describe.skip)('Studio "Desktop & legacy" run tab', () => {
  it('shows driver, rung, how the field was found, the screen picture and the terminal screen text', async () => {
    const url = studio.url.includes('#') ? studio.url.replace(/#.*$/, `#/runs/${runId}`) : `${studio.url}#/runs/${runId}`;
    const app = await ElectronApp.launch({ app: url, executable: chrome!, args: ['--headless=new', '--window-size=1300,900'], timeoutMs: 30_000 });
    let page: CdpPageSeam | undefined;
    try {
      const [target] = await app.windows();
      page = await app.connect(target);
      const p = page;
      const tabs = await poll(() => p.evaluate<string[]>(`[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())`), (t) => t.some((x) => x.startsWith('Desktop & legacy')));
      expect(tabs.some((t) => t.startsWith('Desktop & legacy')), JSON.stringify({ url, tabs, body: await p.evaluate<string>('location.href + " " + document.body.innerText.slice(0, 400)') })).toBe(true);
      await p.evaluate(`[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim().startsWith('Desktop & legacy')).click()`);
      const cards = await poll(() => p.evaluate<string[]>(`[...document.querySelectorAll('.card')].map((c) => c.innerText)`), (c) => c.some((x) => x.includes('USERID')));
      const fill = cards.find((c) => c.includes('Type "CLERK01" into the "USERID" field'))!;
      expect(fill).toMatch(/Mainframe 3270/);
      expect(fill).toMatch(/rung: field/);
      expect(fill).toMatch(/Found by label "USERID" at row 5 column 10/);
      expect(fill).toMatch(/Row 5, column 24, 8 positions/);
      const screen = await poll(() => p.evaluate<string>(`[...document.querySelectorAll('.card')].find((c) => c.innerText.includes('Press Enter')).querySelector('pre').textContent`), (t) => t.includes('MAIN MENU'));
      expect(screen).toContain('WELCOME CLERK01');
      const img = await poll(() => p.evaluate<number>(`[...document.querySelectorAll('.card')].find((c) => c.innerText.includes('Press Enter')).querySelector('img').naturalWidth`), (w) => w > 0);
      expect(img).toBeGreaterThan(0);
    } finally {
      await page?.close();
      await app.close();
    }
  }, 90_000);
});
