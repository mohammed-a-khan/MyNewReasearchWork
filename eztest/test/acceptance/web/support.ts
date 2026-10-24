/**
 * Shared helpers of the acceptance tests against real public websites (test/acceptance/web/*.test.ts).
 *
 * They run only with EZTEST_ONLINE=1 (they need the internet); recording also needs a display for the visible
 * browser (xvfb-run -a). `npm run test:acceptance` sets both up. A site that does not answer at all is skipped with
 * the reason; anything else (a slow page, a flaky response) is a failure: nothing here retries.
 *
 * Each scenario is authored the three ways teams do: recorded by using the site with the mouse and keyboard,
 * hand-written `.ez` (journeys/<site>/*.ez), and TypeScript code journeys (journeys/<site>/*.journey.ts).
 */
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '../../support/testkit.js';
import { chromium, type Locator, type Page } from '../../../src/browser/index.js';
import type { Journey, RunResult, StepResult } from '../../../src/core/index.js';
import { parseEzScript } from '../../../src/intent/index.js';
import { startRecording, type Recorder, type RecordingResult } from '../../../src/recorder/index.js';
import { runJourneys } from '../../../src/runner/index.js';
import { runEzTest } from '../../../src/index.js';

export const ONLINE = process.env.EZTEST_ONLINE === '1';
export const DISPLAY = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
export const HERE = dirname(fileURLToPath(import.meta.url));
export const BROWSER = process.env.EZTEST_BROWSER === 'firefox' ? 'firefox' : 'chromium';

/** Say once, per file, why the file did not run. */
export function announce(file: string): void {
  if (!ONLINE) console.warn(`[acceptance/web] ${file} skipped: set EZTEST_ONLINE=1 to run against the real public sites (needs the internet)`);
  else if (!DISPLAY) console.warn(`[acceptance/web] ${file}: recorded scenarios skipped: recording needs a display for the visible browser (run under xvfb-run -a)`);
}

/**
 * Whether the site answers at all (a page loads in a browser within 60 s). Returns the reason when it does not,
 * so the tests of a site that is down are skipped with it; a site that answers but misbehaves fails the tests.
 */
export async function siteDown(url: string): Promise<string | undefined> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const res = await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    const status = res?.status() ?? 0;
    return status >= 500 ? `${url} is down (HTTP ${status})` : undefined;
  } catch (e) {
    return `${url} did not answer: ${(e as Error).message.split('\n')[0]}`;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ a person's mouse and keyboard

/** Wait until the element shows, scroll it into view, move the mouse to its centre and click there. */
export async function click(page: Page, el: Locator, opts: { button?: 'left' | 'right' } = {}): Promise<void> {
  await expect.poll(() => el.isVisible(), { timeout: 30_000, message: `waiting to see ${String(el)}` }).toBe(true);
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, opts.button ? { button: opts.button } : {});
}

/** One key at a time, with a short pause between keys. */
export async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 35 });
}

/** Click a field and type into it. */
export async function fill(page: Page, el: Locator, text: string): Promise<void> {
  await click(page, el);
  await type(page, text);
}

/** Move the mouse over an element and leave it there. */
export async function hover(page: Page, el: Locator): Promise<void> {
  await expect.poll(() => el.isVisible(), { timeout: 30_000 }).toBe(true);
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await settle(600);
}

/** Press on one element, move to another in small steps and let go. */
export async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 15, a.y + a.height / 2 + 5, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await page.mouse.up();
  await settle(500);
}

/** What a person does between actions: look at the page for a moment. */
export function settle(ms = 700): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ recording

/** Record on a visible browser, doing `act` like a person; returns the recording. */
export async function record(url: string, act: (page: Page, rec: Recorder) => Promise<void>, opts: { name?: string } = {}): Promise<RecordingResult> {
  const rec = await startRecording({ url, headless: false, viewport: { width: 1280, height: 900 }, project: {}, ...(opts.name ? { name: opts.name } : {}) });
  try {
    await act(rec.page, rec);
    await settle(800);
  } catch (e) {
    await rec.stop().catch(() => undefined);
    throw e;
  }
  return rec.stop();
}

/** The recorded steps as plain English: no CSS or XPath unless `allowCss` lists the expected ones. */
export function expectPlainEnglish(r: RecordingResult, allowCss: RegExp[] = []): void {
  expect(r.ez, r.warnings.join('\n')).not.toBe('');
  const selectorLines = r.ez.split('\n').filter((l) => /\b(?:css|xpath)=/.test(l) && !allowCss.some((re) => re.test(l)));
  expect(selectorLines, `steps recorded with selectors:\n${r.ez}`).toEqual([]);
  expect(r.warnings.filter((w) => /could not|not recorded|cannot/i.test(w)), r.ez).toEqual([]);
}

/** The .ez lines of a recording without headers and comments. */
export function bodyOf(r: RecordingResult | string): string[] {
  const ez = typeof r === 'string' ? r : r.ez;
  return ez.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^(Journey|Base URL|Tags|Description):/.test(l));
}

// ------------------------------------------------------------------ running

function failures(steps: StepResult[], out: string[] = [], depth = 0): string[] {
  for (const s of steps) {
    if (s.status === 'failed') out.push(`${'  '.repeat(depth)}${s.intent ?? s.stepId}: ${s.error?.message ?? ''}`);
    if (s.children) failures(s.children, out, depth + 1);
  }
  return out;
}

/** Every journey passed, or the failing steps with their messages. */
export function expectPassed(run: RunResult): void {
  const bad = run.journeys.filter((j) => j.status !== 'passed');
  const why = bad.map((j) => `${j.journeyId}: ${j.status}${j.error ? ` (${j.error.message})` : ''}\n${failures(j.steps).join('\n')}`);
  expect(why.join('\n\n')).toBe('');
  expect(run.journeys.length).toBeGreaterThan(0);
}

/** Replay a recording (or any .ez text) with the runner, the way `eztest run` would. */
export async function replay(source: RecordingResult | string | Journey, variables: Record<string, string> = {}): Promise<RunResult> {
  const journey = typeof source === 'string' ? parseEzScript(source) : 'journey' in source ? parseEzScript(source.ez) : source;
  const outputDir = await mkdtemp(join(tmpdir(), 'eztest-accept-web-'));
  return runJourneys([journey], { outputDir, variables, screenshots: 'on-failure', browser: BROWSER });
}

/**
 * Run hand-written `.ez` files and code journeys of journeys/<site> in a fresh project, as `eztest run` does
 * (journeys/ and data/ are copied; code journeys are bundled by EZTest's own loader).
 */
export async function runProject(site: string, files: string[], opts: { vars?: Record<string, string> } = {}): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), `eztest-accept-${site}-`));
  await cp(join(HERE, 'journeys', site), join(dir, 'journeys'), { recursive: true });
  await writeFile(join(dir, 'eztest.config.yaml'), `journeysDir: journeys\nscreenshots: on-failure\nheadless: true\nbrowser: ${BROWSER}\n`);
  const { loadJourneys } = await import('../../../src/cli/journeys.js');
  const loaded = await loadJourneys(files.map((f) => join(dir, 'journeys', f)), dir);
  expect(loaded.errors ?? [], JSON.stringify(loaded.errors ?? [])).toEqual([]);
  const { run } = await runEzTest({ cwd: dir, journeys: loaded.journeys, analyze: false, overrides: { outputDir: join(dir, 'results'), ...(opts.vars ? { vars: opts.vars } : {}) } });
  return run;
}
