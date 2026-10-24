/**
 * Recording without a display: `eztest studio --record-headless` records with a
 * headless browser, and without it the Studio says why a visible browser cannot
 * open (no DISPLAY / WAYLAND_DISPLAY) and what to do.
 */
import { describe, expect, it } from '../support/testkit.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildProgram } from '../../src/cli/program.js';
import { RecordManager, noDisplayHint } from '../../src/studio/record.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../src/browser/index.js';
import { startStudio } from '../../src/studio/index.js';

describe('recording without a display', () => {
  it('noDisplayHint: only on X11/Wayland systems without DISPLAY and WAYLAND_DISPLAY', () => {
    expect(noDisplayHint({}, 'linux')).toMatch(/No display found .*eztest studio --record-headless/);
    expect(noDisplayHint({ DISPLAY: ':0' }, 'linux')).toBeUndefined();
    expect(noDisplayHint({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeUndefined();
    expect(noDisplayHint({}, 'darwin')).toBeUndefined();
    expect(noDisplayHint({}, 'win32')).toBeUndefined();
  });

  it('eztest studio has --record-headless', () => {
    const studio = buildProgram().commands.find((c) => c.name() === 'studio')!;
    expect(studio.options.map((o) => o.long)).toContain('--record-headless');
  });

  it('headless recording works without a display; a headed start without one fails with the hint', async () => {
    const site = createServer((_q, r) => r.end('<!doctype html><html lang="en"><title>x</title><main><button>Go</button></main></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    try {
      const headless = new RecordManager({ headless: true, env: {} });
      const s = await headless.start({ url });
      expect(s.state).toBe('recording');
      await headless.stop();
      if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        const headed = new RecordManager({ env: {} });
        await expect(headed.start({ url })).rejects.toThrow(/Could not start recording: .*No display found .*--record-headless/);
      }
    } finally {
      site.close();
    }
  }, 60_000);

  it('the Record page (Studio --record-headless): one recorded step reads "1 step", and an added expectation is listed once', async () => {
    const site = createServer((_q, r) => r.end('<!doctype html><html lang="en"><title>Shop</title><main><h1>Saved</h1></main></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const dir = await mkdtemp(join(tmpdir(), 'eztest-record-ui-'));
    await mkdir(join(dir, 'journeys'));
    await writeFile(join(dir, 'eztest.config.yaml'), 'journeysDir: journeys\n');
    const studio = await startStudio({ cwd: dir, watch: false, recordHeadless: true });
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
      await page.goto(studio.url);
      await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name: 'Record', exact: true }).click();
      await page.getByLabel('Start URL').fill(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
      await page.getByRole('button', { name: 'Start recording' }).click();
      await expect.poll(() => page.getByLabel('Add an expectation to the last step').isVisible(), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => page.getByRole('list', { name: 'Recorded steps' }).locator('li').count(), { timeout: 20_000 }).toBe(1);
      await page.getByLabel('Add an expectation to the last step').fill('the page contains "Saved"');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect.poll(() => page.getByRole('list', { name: 'Recorded steps' }).locator('li').allTextContents(), { timeout: 20_000 }).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 500)); // a duplicate would arrive right after
      const items = await page.getByRole('list', { name: 'Recorded steps' }).locator('li').allTextContents();
      expect(items.filter((t) => /Expect .*"Saved"/.test(t)), items.join(" | ")).toHaveLength(1);
      await page.getByRole('button', { name: 'Stop recording' }).click();
      await expect.poll(() => page.getByRole('status').filter({ hasText: 'Recording stopped' }).textContent(), { timeout: 30_000 }).toBe('Recording stopped: 1 step.');
    } finally {
      await browser.close();
      await studio.close();
      site.close();
    }
  }, 120_000);
});
