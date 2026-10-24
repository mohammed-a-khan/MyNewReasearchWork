/** The Project page's chips say "1 key" / "7 keys", without a stray "(s)". */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '../../src/browser/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';

let studio: StudioHandle;
let browser: Browser;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eztest-project-chips-'));
  await mkdir(join(dir, 'journeys'));
  await writeFile(join(dir, 'eztest.config.yaml'), 'baseUrl: http://127.0.0.1:9\njourneysDir: journeys\noutputDir: results\nreporters: [console]\n');
  // One EZTest setting from the environment, so its layer has exactly one key.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EZTEST_')));
  studio = await startStudio({ cwd: dir, watch: false, env: { ...env, EZTEST_RETRIES: '1' } });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

describe('Project page chips', () => {
  it('layer pills count keys with a proper plural', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
    await page.goto(`${studio.url.split('#')[0]}#/project/environments`);
    const pills = page.locator('.pill-list .pill');
    await expect.poll(() => pills.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    const texts = await pills.allTextContents();
    expect(texts.filter((t) => t.includes('(s)'))).toEqual([]);
    expect(texts).toContain('eztest.config.yaml · 4 keys');
    expect(texts.find((t) => t.startsWith('environment')), texts.join(' | ')).toBe('environment · 1 key');
  });
});
