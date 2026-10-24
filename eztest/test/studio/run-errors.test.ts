/**
 * A Studio run that fails (here: the config names a setup hook journey that does
 * not exist, so the run errors before any journey runs) keeps its reason visible on the Run page after the run ends, and
 * shows up in the Results history with its error. The Run page offers only the
 * browsers EZTest supports, as the server lists them.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { BROWSER_ENGINES, BROWSER_TARGETS } from '../../src/core/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { buildProgram } from '../../src/cli/program.js';
import { client, readSse } from './helpers.js';

let studio: StudioHandle;
let c: ReturnType<typeof client>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-run-errors-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://127.0.0.1:9\njourneysDir: journeys\noutputDir: results\nreporters: [console]\nhooks:\n  beforeAll: [missing-setup]\n');
  await writeFile(join(dir, 'journeys', 'home.ez'), 'Journey: Home\nId: home\nOpen "/"\n');
  studio = await startStudio({ cwd: dir, watch: false });
  c = client(studio.port, studio.token);
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

async function go(name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name, exact: true }).click();
  await expect.poll(() => page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name, exact: true }).getAttribute('aria-current')).toBe('page');
}

describe('Studio run errors', () => {
  it('the API ends an errored run with its reason, lists it in Results and serves its detail', async () => {
    expect((await c.get('/api/session')).json().browsers).toEqual({ engines: [...BROWSER_ENGINES], targets: [...BROWSER_TARGETS] });
    expect((await c.post('/api/runs', { browser: 'webkit' })).status).toBe(400);
    const start = await c.post('/api/runs', {});
    expect(start.status).toBe(202);
    const { id } = start.json();
    const events = await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done');
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', state: 'error' });
    expect(done.error).toMatch(/hooks: no journey "missing-setup"/);
    expect(events.find((e) => e.type === 'run-error')?.message).toBe(done.error);
    const listed = (await c.get('/api/runs')).json().runs.find((r: { runId: string }) => r.runId === id);
    expect(listed).toMatchObject({ runId: id, state: 'error', hasReport: false });
    expect(listed.error).toMatch(/hooks: no journey "missing-setup"/);
    expect((await c.get(`/api/runs/${id}`)).json()).toMatchObject({ runId: id, state: 'error', error: done.error });
  });

  it('the Run page keeps "Run failed: <reason>" after the run ends, and Results shows the run with its error', async () => {
    await page.goto(studio.url);
    await go('Run');
    // Only supported browsers, from the server.
    await expect.poll(() => page.locator('select[id^="run-browser"] option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(['', ...BROWSER_ENGINES]);
    expect(await page.locator('#run-browsers input[type="checkbox"]').evaluateAll((o) => o.map((x) => (x as HTMLInputElement).value))).toEqual([...BROWSER_TARGETS]);
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('#run-status').getAttribute('data-state'), { timeout: 60_000 }).toBe('error');
    const status = (await page.locator('#run-status').textContent())!;
    expect(status).toMatch(/^Run run-[\w-]+ failed: .*no journey "missing-setup"/);
    expect(await page.locator('#run-error').textContent()).toMatch(/hooks: no journey "missing-setup"/);

    await go('Results');
    await page.getByRole('combobox', { name: 'Filter by outcome' }).selectOption('run-error');
    const rows = page.getByRole('grid', { name: /Past runs/ }).getByRole('row');
    await expect.poll(() => rows.count()).toBe(3); // header + the two errored runs
    expect(await page.getByRole('grid', { name: /Past runs/ }).textContent()).toMatch(/Run error.*no journey "missing-setup"/);
    await rows.nth(1).click();
    await expect.poll(() => page.locator('#run-detail-error').textContent()).toMatch(/hooks: no journey "missing-setup"/);
  });

  it('the CLI offers the same browsers for --browser (no webkit)', () => {
    const program = buildProgram();
    for (const name of ['run', 'record']) {
      const opt = program.commands.find((c) => c.name() === name)?.options.find((o) => o.long === '--browser');
      expect(opt?.argChoices, name).toEqual([...BROWSER_ENGINES]);
    }
  });
});
