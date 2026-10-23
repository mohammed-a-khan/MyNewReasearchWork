/** E2E (real Chromium): keyboard, mouse and gestures, drag and drop, scrolling, touch and DOM events. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';
import { expectPasses, runEz } from './advanced-helpers.js';

let server: DemoServer;
beforeAll(async () => {
  server = await startDemoApp();
});
afterAll(async () => {
  await server.close();
});

describe('keyboard', () => {
  it('presses combos (platform-aware Mod), holds and releases keys, types slowly and presses keys repeatedly', async () => {
    await expectPasses(server.url, `Journey: Keyboard
Open /lab/keys
Press Control+Shift+K
  Expect #last-key has text "Control+Shift+K"
Press Mod+K on the page
  Expect the "Command palette" dialog is visible
  Expect the Command field is focused
Press Escape
  Expect the "Command palette" dialog is hidden
Hold down Shift
  Expect #shift has text "down"
Release Shift
  Expect #shift has text "up"
Type "laptop" slowly into the Search field
  Expect the Search field has value "laptop"
  Expect #input-count has text "6"
Press Backspace 3 times in the Search field
  Expect the Search field has value "lap"
Press Ctrl+A in the Search field
Press Del in the Search field
  Expect the Search field has value ""
Focus the Notes field
Type "Hello" on the keyboard
  Expect the Notes field has value "Hello"
Insert text " world" into the Notes field
  Expect the Notes field has value "Hello world"
Use the keyboard shortcut Mod+K
  Expect the "Command palette" dialog is visible
`);
  });
});

describe('mouse and gestures', () => {
  it('right-click context menu, middle click, modifier clicks, offsets, multi-clicks, hover, mouse down/up, focus and blur', async () => {
    await expectPasses(server.url, `Journey: Mouse
Open /lab/menu
Open the context menu on #file-item
  Expect the "File menu" menu is visible
Click the "Rename" menu item
  Expect #menu-status has text "Renamed"
Middle-click the "Docs" link
  Expect #aux has text "middle click"
Shift+ctrl-click the "Modifier target" button
  Expect #mods has text "shift+ctrl"
Click the "Modifier target" button while holding Alt
  Expect #mods has text "alt"
Click the "Drawing pad" region at 30, 40
  Expect #xy has text "x=30 y=40"
Triple-click the "Multi click" button
  Expect #clicks has text "clicks=3"
Hover over #hover-me
  Expect the text "Tooltip text" is visible
Press the mouse button on #press-area
  Expect #mouse-state has text "down"
Release the mouse button over #press-area
  Expect #mouse-state has text "up"
Focus the "Focus me" field
  Expect #focus-state has text "focused"
  Expect the "Focus me" field is focused
Blur the "Focus me" field
  Expect #focus-state has text "blurred"
Click at 5, 5
Move the mouse to 10, 10
Scroll the mouse wheel down by 50
`);
  });

  it('drags with the mouse (sortable list, slider by offset) and HTML5 drag and drop via the event fallback', async () => {
    await expectPasses(server.url, `Journey: Drag
Open /lab/dnd
Drag the "Task A" text to the "Done column" region
  Expect #dnd-status has text "Task A moved to Done"
Drag #card-b to #done using HTML5 events
  Expect #dnd-status has text "Task B moved to Done"
Drag the "Charlie" text to the "Alpha" text
  Expect #order has text "Charlie, Alpha, Bravo"
Drag the "Volume knob" slider by 120, 0
  Expect #slider-value has text "120"
Drag the "Volume knob" slider 20 pixels left
  Expect #slider-value has text "100"
`);
  });

  it('uploads several files, drops files onto a drop zone and checks downloads by name, size and type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eztest-files-'));
    await writeFile(join(dir, 'a.txt'), 'alpha');
    await writeFile(join(dir, 'b.csv'), 'x,y\n1,2\n');
    const { j } = await expectPasses(server.url, `Journey: Files
Open /lab/upload
Upload "a.txt" and "b.csv" to the Attachments field
  Expect #names has text "a.txt, b.csv"
Download the "Download CSV report" link as report
  Expect the download report is named "report.csv"
  Expect the download report has type "csv"
  Expect the download report is at least 10 bytes
  Expect the download report name matches "^report\\.csv$"
Open /lab/dnd
Drop files "a.txt", "b.csv" onto the "Drop zone" region
  Expect #dropped has text "a.txt (5 bytes), b.csv (8 bytes)"
`, { baseDir: dir });
    expect((j.ledger.report as { filename: string }).filename).toBe('report.csv');
  });

  it('scrolls the page, elements and infinite lists until an item appears', async () => {
    const { j } = await expectPasses(server.url, `Journey: Scroll
Open /lab/list
Scroll down until the "Item 95" text is visible
  Expect the "Item 95" text is in the viewport
Scroll to the top
  Expect the "Item 1" text is in the viewport
Scroll down by 400
Open /lab/form
Scroll to #footer
  Expect #footer is in the viewport
Scroll #footer into view
Scroll to the top
  Expect #footer is not in the viewport
`);
    expect(j.status).toBe('passed');
  });

  it('taps and swipes with touch emulation', async () => {
    await expectPasses(server.url, `Journey: Touch
Device: iPhone 13
Open /lab/touch
Touch the "Menu" button
  Expect #touch-state has text "Tapped"
Swipe left on the "Carousel" region
  Expect #swipe-state has text "Swiped left"
Swipe up on the "Carousel" region by 80
  Expect #swipe-state has text "Swiped up"
`);
  });

  it('a tap without touch emulation explains how to enable it', async () => {
    const { j } = await runEz(server.url, `Journey: No touch
Open /lab/touch
Touch the "Menu" button`);
    expect(j.steps[1].error?.message).toMatch(/touch emulation|Device:/);
  });
});

describe('DOM events', () => {
  it('dispatches events with init, waits for events and captures their detail', async () => {
    const { j } = await expectPasses(server.url, `Journey: Events
Open /lab/events
Fill the Quantity field with 5
Trigger the "change" event on the Quantity field
  Expect #changed has text "Changed to 5"
Trigger the "custom-ping" event on the Quantity field with detail '{"n":1}'
  Expect #changed has text 'Pinged {"n":1}'
Listen for the "cart-updated" event on the window
Click the "Update cart later" button
Wait for the "cart-updated" event and store it as cart
  Expect #cart has text "Cart has 3"
Trigger the "cart-updated" event on the window with '{"detail": {"count": 9}}'
  Expect #cart has text "Cart has 9"
`);
    expect(j.ledger.cart).toEqual({ count: 3 });
  });
});
