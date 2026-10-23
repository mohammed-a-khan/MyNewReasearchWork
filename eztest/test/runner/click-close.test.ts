/** A click whose own window closes mid-click (OAuth/payment popups) counts as done; other click errors still fail. */
import { describe, expect, it } from '../support/testkit.js';
import type { Locator } from '../../src/browser/index.js';
import { parseJourney } from '../../src/core/index.js';
import { performAction } from '../../src/runner/actions.js';
import type { RunOptions, StepContext } from '../../src/runner/types.js';

const step = parseJourney({ id: 'j', name: 'j', steps: [{ id: 's', intent: 'Click "Send back"', action: 'click', target: { description: 'Send back' } }] }).steps[0];
const opts = { outputDir: '.' } as RunOptions;

function fakeLocator(closed: boolean): Locator {
  return {
    click: async () => {
      throw new Error('locator.click: Target page, context or browser has been closed');
    },
    page: () => ({ isClosed: () => closed }),
  } as unknown as Locator;
}

describe('click on a self-closing window', () => {
  it('succeeds when the page the click targeted is now closed', async () => {
    await expect(performAction(step, fakeLocator(true), { page: {} } as StepContext, opts, 1000)).resolves.toEqual({});
  });

  it('still fails when the page is open (a real click failure)', async () => {
    await expect(performAction(step, fakeLocator(false), { page: {} } as StepContext, opts, 1000)).rejects.toThrow(/Target page/);
  });
});
