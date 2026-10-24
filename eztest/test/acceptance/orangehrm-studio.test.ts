/**
 * Acceptance: what a new user does on day one, against the real OrangeHRM (not a mock page), through the Studio's
 * own screens with mouse and keyboard, the way a person does it:
 *
 *   eztest init -> eztest studio -> Record: start URL, Start recording -> in the recording browser click the
 *   Username field, type, click Password, type, click Login -> on the Studio page type an expectation and press Add
 *   -> Stop recording -> Save journey -> Journeys: open it, Run -> the run passes.
 *
 * Needs a running OrangeHRM and a display for the visible recording browser (Xvfb works):
 *   EZTEST_ORANGEHRM_URL=http://127.0.0.1:18080 EZTEST_ORANGEHRM_PASSWORD=admin123 xvfb-run -a npm test -- test/acceptance
 * Skipped without them, and says so.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '../../src/browser/index.js';
import { initProject } from '../../src/cli/init.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { client } from '../studio/helpers.js';

const APP = process.env.EZTEST_ORANGEHRM_URL?.replace(/\/$/, '');
const PASSWORD = process.env.EZTEST_ORANGEHRM_PASSWORD;
const DISPLAY = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
const ready = !!(APP && PASSWORD && DISPLAY);
if (!ready) console.warn('[acceptance] skipped: set EZTEST_ORANGEHRM_URL, EZTEST_ORANGEHRM_PASSWORD and run with a display (xvfb-run -a)');

let dir: string;
let studio: StudioHandle;
let browser: Browser;
let ui: Page;

/** A person's click: the mouse moves to the element's centre and presses there (real input events, not el.click()). */
async function click(page: Page, el: Locator): Promise<void> {
  await expect.poll(() => el.isVisible(), { timeout: 30_000 }).toBe(true);
  await el.scrollIntoViewIfNeeded(); // a person scrolls to what is below the fold first
  const b = (await el.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
/** A person's typing: one key at a time, with a short pause between keys. */
async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 40 });
}
const nav = (name: string) => ui.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name, exact: true });

describe.skipIf(!ready)('day one with the real OrangeHRM, through the Studio screens', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eztest-accept-ohrm-'));
    await initProject(dir, {}); // what `eztest init` writes: baseUrl http://localhost:3000, an example journey
    studio = await startStudio({ cwd: dir, watch: false });
    browser = await chromium.launch();
    ui = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await ui.goto(studio.url);
  });

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
  });

  let saved = '';

  it('records a login with a visible browser and an expectation typed in the Studio', async () => {
    await click(ui, nav('Record'));
    await click(ui, ui.getByLabel('Start URL'));
    await type(ui, `${APP}/web/index.php/auth/login`);
    await click(ui, ui.getByLabel('Journey name'));
    await type(ui, 'OrangeHRM login');
    await click(ui, ui.getByRole('button', { name: 'Start recording' }));
    await expect.poll(() => ui.getByRole('status').filter({ hasText: /^Recording / }).count(), { timeout: 60_000 }).toBe(1);

    const app = studio.app.recorder.page!;
    expect(app).toBeTruthy();
    await click(app, app.getByPlaceholder('Username'));
    await type(app, 'Admin');
    await click(app, app.getByPlaceholder('Password'));
    await type(app, PASSWORD!);
    await click(app, app.getByRole('button', { name: 'Login' }));
    await expect.poll(() => app.getByRole('heading', { name: 'Dashboard' }).isVisible(), { timeout: 60_000 }).toBe(true);

    // Straight to the Studio, the way a tester does it, while the recorder may still be settling.
    await click(ui, ui.getByLabel('Add an expectation to the last step'));
    await type(ui, 'verify user lands on "Dashboard" screen');
    await click(ui, ui.getByRole('button', { name: 'Add', exact: true }));
    await expect.poll(() => ui.getByLabel('Add an expectation to the last step').inputValue(), { timeout: 20_000 }).toBe('');
    expect(await ui.locator('.toast').filter({ hasText: /error|could not|not understood/i }).count()).toBe(0);

    await click(ui, ui.getByRole('button', { name: 'Stop recording' }));
    const ez = ui.getByLabel('Journey (you can edit it before saving)');
    await expect.poll(() => ez.inputValue(), { timeout: 30_000 }).toMatch(/Expect /);
    const text = await ez.inputValue();
    expect(text).toContain(`Base URL: ${APP}`);
    expect(text).toMatch(/Type "Admin" into/);
    expect(text).toMatch(/\$\{password\}/);
    expect(text).not.toContain(PASSWORD!);
    expect(text).not.toMatch(/css=|xpath=/);
    expect(text).toMatch(/Expect page contains "Dashboard"/);

    await click(ui, ui.getByRole('button', { name: 'Save journey' }));
    const saveStatus = ui.locator('#rec-result [role="status"]');
    await expect.poll(() => saveStatus.textContent(), { timeout: 20_000 }).toMatch(/^(Saved|Not saved)/);
    expect(await saveStatus.textContent()).toMatch(/^Saved /);
    saved = (await ui.getByLabel('Save as (path in the project)').inputValue()).trim();
    expect(await readFile(join(dir, saved), 'utf8')).toBe(text);
  }, 240_000);

  it('runs it from the journey editor: asks for the password, then passes', async () => {
    expect(saved).not.toBe('');
    await click(ui, nav('Journeys'));
    await click(ui, ui.getByRole('tree', { name: 'Journey files' }).getByRole('treeitem', { name: new RegExp(saved.split('/').pop()!.replace('.', '\\.')) }));
    await click(ui, ui.getByRole('toolbar', { name: 'Editor actions' }).getByRole('button', { name: /^Run/ }));
    const dialog = ui.getByRole('dialog', { name: 'Values for this run' });
    await click(ui, dialog.getByLabel('password'));
    await type(ui, PASSWORD!);
    await click(ui, dialog.getByRole('button', { name: 'Run' }));
    await expect.poll(() => ui.locator('#run-status').getAttribute('data-state'), { timeout: 180_000 }).toMatch(/complete|error/);
    const status = await ui.locator('#run-status').textContent();
    expect(status).toMatch(/complete/);
    const c = client(studio.port, studio.token);
    const runId = (await c.get('/api/runs')).json().runs[0].runId;
    const detail = (await c.get(`/api/runs/${runId}`)).body;
    expect(detail).not.toContain(PASSWORD!);
    expect(detail).toMatch(/"status":"passed"/);
    expect(detail).not.toMatch(/"status":"failed"/);
  }, 300_000);
});
