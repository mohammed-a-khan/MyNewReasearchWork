/**
 * Findings from running EZTest against public sites (test/acceptance/web), reproduced on small local pages so they
 * stay fixed without the network.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { describeTarget, parseIntent } from '../../src/intent/index.js';
import { Step } from '../../src/core/index.js';
import { evaluateConditionOnce, resolveTarget } from '../../src/runner/index.js';
import { frameSelectorCandidates } from '../../src/runner/pages.js';
import { Ledger } from '../../src/runner/ledger.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

const env = () => ({ page, ledger: new Ledger(), vars: () => ({}), interpolate: (s: string) => s });
const cond = (line: string) => Step.parse(parseIntent(line)).postconditions[0];

describe('FINDING (automationexercise.com): a link with an icon-font glyph was not "the Products link"', () => {
  it('ignores Private Use Area glyphs in names and text, in the DOM and in ::before content', async () => {
    await page.setContent(`<!doctype html><style>.fa-cart::before { content: "\\f07a"; }</style>
      <a href="/products"><i class="material-icons"></i> Products</a>
      <a href="/cart"><i class="fa-cart"></i> Cart</a>`);
    for (const d of ['the "Products" link', 'the "Cart" link', 'the "Products" text']) {
      const r = await resolveTarget(page, describeTarget(d), {}, 1000);
      expect(r.locator, `${d}: ${r.notes.join('; ')}`).toBeDefined();
    }
  });
});

describe('FINDING (automationexercise.com): "Expect the page contains" missed a heading styled in capitals', () => {
  it('holds for the words as written and as shown, and still not for hidden text', async () => {
    await page.setContent(`<!doctype html><h2 style="text-transform: uppercase">Searched Products</h2><p hidden>Secret words</p>`);
    for (const line of ['Expect the page contains "Searched Products"', 'Expect the page contains "SEARCHED PRODUCTS"']) {
      expect((await evaluateConditionOnce(cond(line), env())).passed, line).toBe(true);
    }
    expect((await evaluateConditionOnce(cond('Expect the page contains "Secret words"'), env())).passed).toBe(false);
    const heading = Step.parse(parseIntent('Click the "Searched Products" heading')).target!;
    expect((await evaluateConditionOnce({ type: 'textContains', target: heading, value: 'Searched Products' }, env())).passed).toBe(true);
  });
});

describe('FINDING (saucedemo.com): testid= found only data-testid, while the app marks elements with data-test', () => {
  it('matches the common test-id attributes, still strictly one element', async () => {
    await page.setContent(`<!doctype html><a data-test="shopping-cart-link" href="#">cart</a><span data-qa="badge">2</span>
      <button data-cy="go">Go</button><b data-test-id="dup">1</b><i data-testid="dup">2</i>`);
    for (const id of ['shopping-cart-link', 'badge', 'go']) {
      const r = await resolveTarget(page, describeTarget(`testid=${id}`), {}, 500);
      expect(r.locator, id).toBeDefined();
    }
    const dup = await resolveTarget(page, describeTarget('testid=dup'), {}, 200);
    expect(dup.locator).toBeUndefined();
    expect(dup.ambiguous).toBe(true);
  });
});

describe('FINDING (rahulshettyacademy.com): "the Radio2 radio button" inside <label for="radio2"> with no such id', () => {
  it('reads a wrapping label whose for= points nowhere as the label; a working for= still wins', async () => {
    await page.setContent(`<!doctype html><fieldset>
      <label for="radio1"><input type="radio" name="r" value="1"> Radio1</label>
      <label for="radio2"><input type="radio" name="r" value="2"> Radio2</label>
      <label for="real">Real</label><label for="other"><input id="x" type="checkbox"> Wrapped</label><input id="real" type="checkbox">
      </fieldset>`);
    const r = await resolveTarget(page, describeTarget('the Radio2 radio button'), {}, 500);
    expect(r.locator, r.notes.join('; ')).toBeDefined();
    expect(await r.locator!.evaluate((e) => (e as HTMLInputElement).value)).toBe('2');
    expect((await resolveTarget(page, describeTarget('the Real checkbox'), {}, 500)).locator).toBeDefined();
    expect((await resolveTarget(page, describeTarget('the Wrapped checkbox'), {}, 500)).locator).toBeDefined();
  });
});

describe('FINDING (the-internet nested frames): a frame named "frame-top" was taken for a CSS selector', () => {
  it('looks a frame name up as a name; selectors still work', () => {
    expect(frameSelectorCandidates('frame-top')[0]).toBe('iframe[name="frame-top"]');
    expect(frameSelectorCandidates('frame-top')).toContain('frame[name="frame-top"]');
    expect(frameSelectorCandidates('frame-top')).toContain('frame[title="frame-top"]');
    for (const sel of ['iframe', 'iframe.inner', 'frame:nth-of-type(2)', '#pay', 'iframe[name=x]']) expect(frameSelectorCandidates(sel)).toEqual([sel]);
  });
});
