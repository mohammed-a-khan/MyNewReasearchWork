/**
 * A visible (headed) browser shows only the pages under test, at their size:
 *  - each context's window is a normal window sized to its viewport (Chrome's own default on a desktop is nearly
 *    the whole screen, which looked like every test maximised its window);
 *  - EZTest's video encoder page (https://eztest-encoder.invalid/) runs in a headless helper browser, never in a
 *    window of the visible one (the video is still written).
 * Needs a display (xvfb-run -a npm test -- test/browser/headed-windows).
 */
import { describe, expect, it } from '../support/testkit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../src/browser/index.js';

const DISPLAY = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
if (!DISPLAY) console.warn('[headed-windows] skipped: needs a display (run under xvfb-run -a)');

describe.skipIf(!DISPLAY)('headed Chromium windows', () => {
  it('opens a normal window the size of the viewport, and the video encoder in no window at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ez-headed-'));
    const browser = await chromium.launch({ headless: false });
    try {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, recordVideo: { dir } });
      const page = await ctx.newPage();
      await page.setContent('<h1 style="font-size:60px">recording</h1>');
      for (let i = 0; i < 5; i++) {
        await page.evaluate((n) => { document.querySelector('h1')!.textContent = `frame ${n}`; }, i);
        await new Promise((r) => setTimeout(r, 120));
      }
      // The video is encoded when the context closes; the encoder's page stays open in the browser after that.
      const video = page.video()!;
      await ctx.close();
      const file = await video.path();
      expect((await import('node:fs')).statSync(file).size).toBeGreaterThan(100);
      const probe = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
      await probe.setContent('<p>after</p>');
      const cdp = await browser.newBrowserCDPSession();
      const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
      const windows = new Map<number, { url: string; state: string; width: number; height: number }>();
      for (const t of targetInfos.filter((x) => x.type === 'page')) {
        const w = (await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => undefined)) as { windowId: number; bounds: { width: number; height: number; windowState: string } } | undefined;
        if (w) windows.set(w.windowId, { url: t.url, state: w.bounds.windowState, width: w.bounds.width, height: w.bounds.height });
      }
      const shown = [...windows.values()];
      expect(shown.some((w) => w.url.includes('eztest-encoder')), JSON.stringify(shown)).toBe(false);
      const mine = shown.find((w) => !w.url.includes('eztest-encoder'))!;
      expect(mine.state).toBe('normal');
      expect(mine.width).toBeGreaterThanOrEqual(800);
      expect(mine.width).toBeLessThan(900);
      expect(mine.height).toBeGreaterThanOrEqual(600);
      expect(mine.height).toBeLessThan(760);
      // The video was encoded by a headless helper browser: the encoder page is not even in this browser.
      expect(targetInfos.some((t) => t.url.includes('eztest-encoder'))).toBe(false);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const FIREFOX = process.env.EZTEST_FIREFOX_PATH;
describe.skipIf(!DISPLAY || !FIREFOX)('headed Firefox video', () => {
  it('records the video without showing the encoder page in the visible browser', async () => {
    const { firefox } = await import('../../src/browser/index.js');
    const dir = await mkdtemp(join(tmpdir(), 'ez-headed-ff-'));
    const browser = await firefox.launch({ headless: false });
    try {
      const ctx = await browser.newContext({ viewport: { width: 640, height: 480 }, recordVideo: { dir } });
      const page = await ctx.newPage();
      await page.setContent('<h1>firefox</h1>');
      await new Promise((r) => setTimeout(r, 500));
      const video = page.video()!;
      await ctx.close();
      expect((await import('node:fs')).statSync(await video.path()).size).toBeGreaterThan(100);
      const urls = browser.contexts().flatMap((c) => c.pages().map((p) => p.url()));
      expect(urls.some((u) => u.includes('eztest-encoder')), urls.join(', ')).toBe(false);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
