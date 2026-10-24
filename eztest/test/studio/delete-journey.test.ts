/**
 * Deleting a journey from the Studio: the editor's Delete button and the explorer's Delete key both ask
 * first, then remove the file from disk, close its tab and refresh the explorer. Cancelling keeps the file.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';

let studio: StudioHandle;
let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eztest-delete-journey-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://127.0.0.1:9\njourneysDir: journeys\noutputDir: results\nreporters: [console]\n');
  for (const id of ['keep', 'by-button', 'by-key']) await writeFile(join(dir, 'journeys', `${id}.ez`), `Journey: ${id}\nId: ${id}\nOpen "/"\n`);
  studio = await startStudio({ cwd: dir, watch: false });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(studio.url);
  await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name: 'Journeys', exact: true }).click();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

const tree = () => page.getByRole('tree', { name: 'Journey files' });

describe('deleting a journey in the Studio', () => {
  it('the editor Delete button asks, and Cancel keeps the file', async () => {
    await tree().getByRole('treeitem', { name: /by-button\.ez/ }).click();
    await page.getByRole('toolbar', { name: 'Editor actions' }).getByRole('button', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete journey file?' });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(existsSync(join(dir, 'journeys', 'by-button.ez'))).toBe(true);
  });

  it('the editor Delete button deletes the file, closes its tab and refreshes the explorer', async () => {
    await page.getByRole('toolbar', { name: 'Editor actions' }).getByRole('button', { name: 'Delete…' }).click();
    await page.getByRole('dialog', { name: 'Delete journey file?' }).getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => existsSync(join(dir, 'journeys', 'by-button.ez'))).toBe(false);
    await expect.poll(() => tree().getByRole('treeitem', { name: /by-button\.ez/ }).count()).toBe(0);
    expect(existsSync(join(dir, 'journeys', 'keep.ez'))).toBe(true);
  });

  it('the Delete key on a file in the explorer deletes it after confirmation', async () => {
    const item = tree().getByRole('treeitem', { name: /by-key\.ez/ });
    await item.click();
    await item.press('Delete');
    await page.getByRole('dialog', { name: 'Delete journey file?' }).getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => existsSync(join(dir, 'journeys', 'by-key.ez'))).toBe(false);
    await expect.poll(() => tree().getByRole('treeitem', { name: /by-key\.ez/ }).count()).toBe(0);
    expect(existsSync(join(dir, 'journeys', 'keep.ez'))).toBe(true);
  });
});
