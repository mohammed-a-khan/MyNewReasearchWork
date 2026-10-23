/**
 * Closing a browser leaves no timer behind: the grace periods of the kill
 * sequence are cleared as soon as the browser exits, so a CLI run or a test
 * worker ends right after its last browser closes.
 */
import { describe, expect, it } from '../support/testkit.js';
import { chromium } from '../../src/browser/index.js';
import { settleWithin } from '../../src/browser/util.js';

const timers = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('browser close timers', () => {
  it('settleWithin clears its timer when the promise settles first', async () => {
    const before = timers();
    expect(await settleWithin(Promise.resolve('done'), 60_000, 'late')).toBe('done');
    expect(await settleWithin(new Promise(() => undefined), 10, 'late')).toBe('late');
    expect(timers()).toBe(before);
  });

  it('launch, close: no timer of the kill sequence is left running', async () => {
    const browser = await chromium.launch();
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<p>hi</p>');
    const before = timers();
    await browser.close();
    // Nothing of ours may outlive the close (the 3 s / 2 s grace timers used to).
    expect(timers()).toBeLessThanOrEqual(before);
  });
});
