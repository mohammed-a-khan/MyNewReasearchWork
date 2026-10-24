/**
 * The composer turns what a person did in tabs, frames, dialogs and with the mouse and keyboard into plain-English
 * steps the runner replays the same way: popups become "... and switch to the new tab", answers to dialogs are armed
 * before the click that opens them, steps in a frame go into an In frame block, downloads become Download steps.
 */
import { describe, expect, it } from '../support/testkit.js';
import { parseEzScript } from '../../src/intent/index.js';
import { JourneyComposer, diffJourneys, type ComposerEvent } from '../../src/recorder/index.js';
import type { ElementInfo } from '../../src/recorder/page-script.js';

const ORIGIN = 'https://shop.test';
let keys = 0;

function el(p: Partial<ElementInfo> & { tag: string }): ElementInfo {
  return {
    key: `k${++keys}`,
    classes: [],
    css: p.id ? `#${p.id}` : p.tag,
    field: false,
    secret: false,
    counts: { roleName: 1, label: 0, placeholder: 0, placeholderAsLabel: 0, text: 0, testId: 0, id: p.id ? 1 : 0 },
    ...p,
  };
}
const button = (name: string) => el({ tag: 'button', role: 'button', name, text: name });
const link = (name: string) => el({ tag: 'a', role: 'link', name, text: name, href: '/x' });

type Ev = { kind: ComposerEvent['kind']; t?: number; [key: string]: unknown };

function compose(events: Ev[], start = `${ORIGIN}/start`) {
  const c = new JourneyComposer({ startUrl: start, baseUrl: ORIGIN, name: 'Recorded' });
  let t = 1000;
  c.start(t);
  for (const e of events) {
    t = e.t ?? t + 100;
    c.apply({ url: '', ...e, t } as ComposerEvent);
  }
  const r = c.result();
  const body = r.ez.split('\n').filter((l) => l && !/^(Journey|Base URL|Tags|Description):|^#/.test(l));
  return { r, body };
}

describe('recorder composer: dialogs', () => {
  it('arms the answer before the click that opened each dialog and expects its message', () => {
    const { r, body } = compose([
      { kind: 'click', el: button('Alert') },
      { kind: 'dialog', type: 'alert', message: 'I am a JS Alert', accepted: true },
      { kind: 'click', el: button('Confirm') },
      { kind: 'dialog', type: 'confirm', message: 'Sure?', accepted: false },
      { kind: 'click', el: button('Prompt') },
      { kind: 'dialog', type: 'prompt', message: 'Name?', accepted: true, userInput: 'Ada' },
      { kind: 'dialog', type: 'beforeunload', message: '', accepted: true },
    ]);
    expect(body).toEqual([
      'Open /start',
      'Accept the next alert',
      'Click the "Alert" button',
      '  Expect an alert saying "I am a JS Alert"',
      'Dismiss the next confirm dialog',
      'Click the "Confirm" button',
      '  Expect a confirm dialog saying "Sure?"',
      'Answer the next prompt with "Ada"',
      'Click the "Prompt" button',
      '  Expect a prompt dialog saying "Name?"',
    ]);
    expect(r.warnings).toEqual([]);
    expect(diffJourneys(r.journey, parseEzScript(r.ez))).toEqual([]);
  });
});

describe('recorder composer: tabs, windows and popups', () => {
  it('follows a popup the click opened, checks where it landed, and returns when the person closes it', () => {
    const { r, body } = compose([
      { kind: 'click', el: link('Open help') },
      { kind: 'tab', op: 'open', tab: 2 },
      { kind: 'navigate', url: `${ORIGIN}/help/intro`, tab: 2 },
      { kind: 'click', el: button('Next'), tab: 2 },
      { kind: 'tab', op: 'close', tab: 2 },
      { kind: 'click', el: button('Done'), tab: 1 },
    ]);
    expect(body).toEqual([
      'Open /start',
      'Click the "Open help" link and switch to the new tab',
      '  Expect URL contains "/help/intro"',
      'Click the "Next" button',
      'Close the tab',
      'Click the "Done" button',
    ]);
    expect(diffJourneys(r.journey, parseEzScript(r.ez))).toEqual([]);
  });

  it('switches back to the main tab while the popup stays open, and does not close a tab the page closed itself', () => {
    const { body } = compose([
      { kind: 'click', el: link('Report') },
      { kind: 'tab', op: 'open', tab: 2 },
      { kind: 'navigate', url: `${ORIGIN}/report`, tab: 2 },
      { kind: 'expect', condition: { type: 'pageContainsText', value: 'Report' }, tab: 2 },
      { kind: 'click', el: button('Back'), tab: 1 },
      { kind: 'click', el: button('Print'), tab: 2 },
      { kind: 'closing', tab: 2 },
      { kind: 'tab', op: 'close', tab: 2 },
      { kind: 'click', el: button('Done'), tab: 1 },
    ]);
    expect(body).toEqual([
      'Open /start',
      'Click the "Report" link and switch to the new tab',
      '  Expect URL contains "/report"',
      '  Expect page contains "Report"',
      'Switch back to the main tab',
      'Click the "Back" button',
      'Switch to tab 2',
      'Click the "Print" button',
      'Click the "Done" button',
    ]);
  });
});

describe('recorder composer: frames', () => {
  it('groups steps in one frame into an In frame block; an address check after a link in the frame goes after the block', () => {
    const { r, body } = compose([
      { kind: 'click', el: button('Pay'), frames: ['payment'] },
      { kind: 'fill', el: el({ tag: 'input', field: true, role: 'textbox', label: 'Card', counts: { roleName: 0, label: 1, placeholder: 0, placeholderAsLabel: 0, text: 0, testId: 0, id: 0 } }), value: '4242', secret: false, frames: ['payment'] },
      { kind: 'expect', condition: { type: 'pageContainsText', value: 'Card accepted' } },
      { kind: 'click', el: link('Receipt'), frames: ['payment'] },
      { kind: 'navigate', url: `${ORIGIN}/receipt` },
      { kind: 'click', el: button('Inner'), frames: ['outer', 'inner frame'] },
      { kind: 'click', el: button('Close') },
    ]);
    expect(body).toEqual([
      'Open /start',
      'In frame "payment"',
      '  Click the "Pay" button',
      '  Type "4242" into the Card field',
      '    Expect page contains "Card accepted"',
      '  Click the "Receipt" link',
      'End',
      '  Expect URL contains "/receipt"',
      'In frame "outer" > "inner frame"',
      '  Click the "Inner" button',
      'End',
      'Click the "Close" button',
    ]);
    expect(r.warnings).toEqual([]);
    expect(diffJourneys(r.journey, parseEzScript(r.ez))).toEqual([]);
  });
});

describe('recorder composer: mouse, keyboard and downloads', () => {
  it('records a hover that a click needs, a drag, keys and a download', () => {
    const avatar = el({ tag: 'img', role: 'img', name: 'User Avatar', alt: 'User Avatar', counts: { roleName: 3, label: 0, placeholder: 0, placeholderAsLabel: 0, text: 0, testId: 0, id: 0 }, roleNth: 2 });
    const { r, body } = compose([
      { kind: 'hover', el: avatar },
      { kind: 'hover', el: avatar },
      { kind: 'click', el: link('View profile') },
      { kind: 'drag', el: el({ tag: 'div', id: 'column-a', text: 'A' }), to: el({ tag: 'div', id: 'column-b', text: 'B' }) },
      { kind: 'press', key: 'Escape' },
      { kind: 'press', key: 'Tab', el: el({ tag: 'input', field: true, role: 'textbox', label: 'Search', counts: { roleName: 0, label: 1, placeholder: 0, placeholderAsLabel: 0, text: 0, testId: 0, id: 0 } }) },
      { kind: 'press', key: 'a' },
      { kind: 'click', el: link('report.pdf') },
      { kind: 'download', filename: 'report.pdf' },
    ]);
    expect(body).toEqual([
      'Open /start',
      'Hover over the 2nd "User Avatar" image',
      'Click the "View profile" link',
      'Drag #column-a to #column-b',
      'Press Escape',
      'Press Tab in the Search field',
      'Press a',
      'Download the "report.pdf" link as reportFile',
      '  Expect download reportFile exists',
    ]);
    expect(r.warnings).toEqual([]);
    expect(diffJourneys(r.journey, parseEzScript(r.ez))).toEqual([]);
  });
});
