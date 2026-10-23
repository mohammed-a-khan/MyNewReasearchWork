/** E2E (real Chromium): tabs, windows, popups, frames and dialogs. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { expectPasses, runEz, describeSteps, outDir } from './advanced-helpers.js';
import { createHealer } from '../../src/heal/index.js';
import { readTrace } from '../../src/runner/index.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('tabs, windows and popups', () => {
  it('time-travel trace covers steps inside a For-each loop and follows a tab switch', async () => {
    const out = await outDir('tt-loop');
    const { j, run } = await expectPasses(server.url, `Journey: Looping tabs
Open /lab/tabs
For each n in [1, 2]
  Click the "Open report" link and switch to the new tab
  Capture the text of #total as total
  Close the tab
End
  Expect the page contains "Tabs lab"
`, { outputDir: out, timeTravel: { enabled: true } });
    const t = await readTrace(join(out, run.runId), j.journeyId, 1);
    const top = j.steps.length;
    // Leaf steps inside the loop get their own trace entries (indices after the top-level steps).
    const inner = t.steps.filter((s) => s.index >= top);
    expect(inner.length, t.steps.map((s) => `${s.index} ${s.stepId}`).join('\n')).toBe(6);
    const captures = inner.filter((s) => s.action === 'capture' || /capture/i.test(s.intent));
    expect(captures).toHaveLength(2);
    // The trace followed the switch: the capture ran (and was recorded) on the report tab.
    for (const c of captures) expect(c.url.after).toContain('/lab/report');
    expect(new Set(t.steps.map((s) => s.index)).size).toBe(t.steps.length);
  });

  it('clicks a target=_blank link and switches to the new tab; evidence follows the current tab', async () => {
    const { j, run } = await expectPasses(server.url, `Journey: Report in a new tab
Open /lab/tabs
Click the "Open report" link and switch to the new tab
  Expect the title contains "Quarterly report"
  Expect there are 2 tabs open
Capture the text of #total as total
Switch back to the main tab
  Expect the page contains "Tabs lab"
Switch to the tab titled "Quarterly report"
  Expect the URL contains "/lab/report"
Close the tab
  Expect there is 1 tab open
  Expect the page contains "Tabs lab"
`, { screenshots: 'every-step' });
    expect(j.ledger.total).toBe('Total: 42');
    // The screenshot after the switch shows the report tab (evidence follows the current page).
    const shot = j.steps[1].evidence[0];
    expect(shot).toBeTruthy();
    expect(run.journeys[0].steps.length).toBe(6);
  });

  it('handles popups (window.open), switching by URL, by number and back to the previous window', async () => {
    await expectPasses(server.url, `Journey: Popup
Open /lab/tabs
Click the "Open help popup" button
Go to the newly opened window
  Expect the page contains "Need assistance?"
Switch back to the previous tab
  Expect the page contains "Tabs lab"
Switch to the tab with URL "/lab/popup"
Click the "Send back" button
  Expect there is 1 tab open
Expect #popup-result has text "Popup says hi"
Open a new tab with /lab/report as report
  Expect there are 2 tabs open
Switch to tab 1
  Expect the page contains "Tabs lab"
Switch to tab 2
  Expect the title contains "Quarterly"
`);
  });

  it('treats a click that closes its own window as done (OAuth/payment-style popups)', async () => {
    // "Close now" closes the popup on mousedown, before the click can complete.
    await expectPasses(server.url, `Journey: Self-closing popup
Open /lab/tabs
Click the "Open help popup" button and switch to the new tab
Click the "Close now" button
  Expect there is 1 tab open
Expect #popup-result has text "Closed early"
`);
  });

  it('waits for a tab that opens later', async () => {
    await expectPasses(server.url, `Journey: Late tab
Open /lab/tabs
Click the "Open report later" button
Switch to the new tab
  Expect the URL contains "late=1"
`);
  });
});

describe('frames', () => {
  it('works inside nested frames with blocks and switches, and post-conditions follow the frame', async () => {
    await expectPasses(server.url, `Journey: Pay inside iframes
Open /lab/frames
In the "payment" frame
  Type "4242424242424242" into the Card number field
    Expect the Card number field has value "4242424242424242"
  In the "verify" frame
    Click the "Verify" button
      Expect #v has text "Verified"
  End
  Click the "Pay now" button
End
Expect #status has text "Paid with card ending 4242"
Switch to frame "payment" > "verify"
  Expect #v has text "Verified"
Switch to the parent frame
  Expect the "Pay now" button is visible
Switch to the main frame
  Expect #status is visible
`);
  });

  it('verified healing works inside frame blocks (the healer searches the current frame)', async () => {
    const { j } = await runEz(server.url, `Journey: Heal in a frame
Open /lab/frames
In frame "payment" > "verify"
  Click the "Verify now" button
    Expect #v has text "Verified"
End
`, { healer: createHealer({ enabled: true }) });
    expect(j.status, describeSteps(j)).toBe('passed-healed');
    const healed = j.steps[1].children![0];
    expect(healed.heal).toMatchObject({ verified: true });
    expect(healed.status).toBe('passed-healed');
  });

  it('finds frames by title and selector, and reports a missing frame clearly', async () => {
    await expectPasses(server.url, `Journey: Frame lookups
Open /lab/frames
Switch to frame "Payment form"
  Expect the "Pay now" button is visible
Switch to the main frame
Switch to frame "iframe[name=payment]"
  Expect the Card number field is visible
`);
    const { j } = await runEz(server.url, `Journey: Missing frame
Open /lab/frames
Switch to frame "shipping"`);
    expect(j.status).toBe('failed');
    expect(j.steps[1].error?.message).toMatch(/No frame "shipping" found/);
  });
});

describe('dialogs', () => {
  it('accepts, dismisses and answers dialogs declaratively and captures their text', async () => {
    const { j } = await expectPasses(server.url, `Journey: Dialogs
Open /lab/dialogs
Accept the next dialog and store it as alertText
Click the "Show alert" button
  Expect an alert saying "Order saved"
Dismiss the next confirm dialog
Click the "Delete order" button
  Expect #confirm-result has text "Kept"
Accept the next dialog
Click the "Delete order" button
  Expect #confirm-result has text "Deleted"
  Expect a confirm dialog saying "Delete the order?"
Answer the next prompt with "Ada"
Click the "Enter name" button
  Expect #prompt-result has text "Hello Ada"
Capture the dialog text as lastDialog
`);
    expect(j.ledger.alertText).toBe('Order saved');
    expect(j.ledger.lastDialog).toBe('Your name?');
  });

  it('records unexpected dialogs as evidence, dismisses them with a warning and never hangs', async () => {
    const out = await outDir('dialogs');
    const { j, run } = await runEz(server.url, `Journey: Unexpected dialog
Open /lab/dialogs
Click the "Delete order" button
  Expect #confirm-result has text "Kept"
`, { outputDir: out });
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.steps[1].warnings?.[0]).toMatch(/unexpected confirm dialog "Delete the order\?" was dismissed/);
    const manifest = await readFile(join(out, run.runId, 'evidence-manifest.jsonl'), 'utf8');
    const entry = manifest.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { path: string; description?: string }).find((e) => e.path.endsWith('dialogs.json'));
    expect(entry?.description).toBe('JavaScript dialogs');
    const dialogs = JSON.parse(await readFile(join(out, run.runId, entry!.path), 'utf8')) as Array<{ kind: string; unexpected: boolean; handledAs: string }>;
    expect(dialogs).toEqual([expect.objectContaining({ kind: 'confirm', unexpected: true, handledAs: 'dismissed' })]);
  });

  it('masks secrets in dialog text and the default policy can accept', async () => {
    const { j } = await expectPasses(server.url, `Journey: Accept policy
Open /lab/dialogs
Click the "Delete order" button
  Expect #confirm-result has text "Deleted"
`, { dialogs: { default: 'accept' }, mask: (s) => s.replace(/Delete/g, '****') });
    expect(j.steps[1].warnings?.[0]).toMatch(/unexpected confirm dialog "\*\*\*\* the order\?" was accepted/);
  });
});
