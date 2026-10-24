/**
 * Acceptance on the real OrangeHRM: recording its own widgets with a visible browser, acting like a person (mouse
 * and keyboard), then replaying the recording. Labels that are not linked to their fields, custom selects that open
 * on mousedown, an autocomplete that writes the picked name into its field, a record id in the URL after Save.
 *
 *   EZTEST_ORANGEHRM_URL=http://127.0.0.1:18080 EZTEST_ORANGEHRM_PASSWORD=... xvfb-run -a npm test -- test/acceptance
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '../../src/browser/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { startRecording } from '../../src/recorder/index.js';
import { runJourneys } from '../../src/runner/index.js';

const APP = process.env.EZTEST_ORANGEHRM_URL?.replace(/\/$/, '');
const PASSWORD = process.env.EZTEST_ORANGEHRM_PASSWORD;
const DISPLAY = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
const ready = !!(APP && PASSWORD && DISPLAY);
if (!ready) console.warn('[acceptance] skipped: set EZTEST_ORANGEHRM_URL, EZTEST_ORANGEHRM_PASSWORD and run with a display (xvfb-run -a)');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function click(page: Page, el: Locator): Promise<void> {
  await el.waitFor({ timeout: 30_000 });
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await pause(400); // a person looks at the result before the next move
}
const type = (page: Page, text: string) => page.keyboard.type(text, { delay: 50 });

async function login(page: Page): Promise<void> {
  await click(page, page.getByPlaceholder('Username'));
  await type(page, 'Admin');
  await click(page, page.getByPlaceholder('Password'));
  await type(page, PASSWORD!);
  await click(page, page.getByRole('button', { name: 'Login' }));
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 });
}

async function replay(ez: string) {
  const run = await runJourneys([parseEzScript(ez, { source: 'recorded.ez' })], {
    outputDir: await mkdtemp(join(tmpdir(), 'ez-accept-ohrm-')),
    headless: true,
    baseUrl: 'http://localhost:3000', // what `eztest init` writes: the recording must not depend on it
    variables: { password: PASSWORD! },
  });
  const jr = run.journeys[0];
  return { status: jr.status, failures: jr.steps.filter((s) => s.status === 'failed').map((s) => `${s.intent}: ${s.error?.message ?? ''}`) };
}

describe.skipIf(!ready)('recording the real OrangeHRM widgets', () => {
  const last = `Rahman${Date.now().toString(36).slice(-5)}`;

  it('adds an employee and searches users by role: unlinked labels, a custom select, a new record id', async () => {
    const rec = await startRecording({ url: `${APP}/web/index.php/auth/login`, headless: false, name: 'add employee, search users' });
    const p = rec.page;
    await login(p);
    await click(p, p.getByRole('link', { name: 'PIM' }));
    await click(p, p.getByRole('button', { name: 'Add' }));
    // A person waits until the form has finished loading (OrangeHRM shows a loader over it first).
    await pause(800);
    await p.locator('.oxd-form-loader').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined);
    await click(p, p.getByPlaceholder('First Name'));
    await type(p, 'Ayesha');
    await click(p, p.getByPlaceholder('Last Name'));
    await type(p, last);
    await click(p, p.getByRole('button', { name: 'Save' }));
    await p.getByRole('heading', { name: 'Personal Details' }).waitFor({ timeout: 30_000 }).catch(async (e) => {
      await p.screenshot({ path: join(tmpdir(), 'ez-accept-ohrm-save.png') });
      throw e;
    });
    await pause(1500);
    await rec.addExpectation('the "Personal Details" heading is visible');
    await click(p, p.getByRole('link', { name: 'Admin' }));
    await click(p, p.locator('.oxd-select-text').first());
    await click(p, p.getByRole('option', { name: 'Admin' }));
    await click(p, p.getByRole('button', { name: 'Search' }));
    await pause(2000);
    await rec.addExpectation('page contains "Record Found"');
    const { ez, warnings } = await rec.stop();

    const lines = ez.split('\n').map((l) => l.trim());
    expect(lines).toContain(`Base URL: ${APP}`);
    expect(lines).toContain('Type "Admin" into the Username field');
    expect(lines).toContain('Type "Ayesha" into the "First Name" field');
    expect(lines).toContain('Select "Admin" from the User Role dropdown');
    expect(lines).toContain('Expect URL contains "/web/index.php/pim/viewPersonalDetails/empNumber/"');
    expect(ez).not.toMatch(/css=|xpath=/);
    expect(warnings).toEqual([]);
    expect(await replay(ez)).toEqual({ status: 'passed', failures: [] });
  }, 300_000);

  it('searches an employee with the autocomplete and a select: the pick is recorded, the app filling the field is not', async () => {
    const rec = await startRecording({ url: `${APP}/web/index.php/auth/login`, headless: false, name: 'employee search' });
    const p = rec.page;
    await login(p);
    await click(p, p.getByRole('link', { name: 'PIM' }));
    await p.locator('.oxd-table-card').first().waitFor({ timeout: 30_000 });
    await click(p, p.getByPlaceholder('Type for hints...').first());
    await type(p, last); // specific enough that the suggestion list shows the new employee
    // The replay of the first test added a second employee of that name: either may be picked, as a person would.
    await click(p, p.getByRole('option', { name: new RegExp(`Ayesha\\s+${last}`) }).first());
    await click(p, p.locator('.oxd-select-text').nth(1));
    await click(p, p.getByRole('option', { name: 'Current Employees Only' }));
    await click(p, p.getByRole('button', { name: 'Search' }));
    await pause(2500);
    await rec.addExpectation(`page contains "${last}"`);
    const { ez } = await rec.stop();

    const lines = ez.split('\n').map((l) => l.trim());
    expect(lines).toContain(`Type "${last}" into the Employee Name field`);
    expect(lines.filter((l) => /into the Employee Name field/.test(l))).toHaveLength(1);
    expect(lines.some((l) => new RegExp(`^Click the (?:1st )?"Ayesha\\s+${last}" option$`).test(l))).toBe(true);
    expect(lines).toContain('Select "Current Employees Only" from the Include dropdown');
    expect(ez).not.toMatch(/css=|xpath=/);
    expect(await replay(ez)).toEqual({ status: 'passed', failures: [] });
  }, 300_000);
});
