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
import { describeElement } from '../../src/recorder/index.js';

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

describe('FINDING (parabank.parasoft.com): "the First Name field" in a form laid out as a table without <label>s', () => {
  it('finds a field by the words before it, in the table cell before it or right before it, and the recorder writes them', async () => {
    await page.setContent(`<!doctype html><form><table>
      <tr><td><b>First Name:</b></td><td><input id="customer.firstName"></td><td></td></tr>
      <tr><td>* Phone #:</td><td><input id="phone"></td></tr>
      <tr><td>Notes</td><td><textarea id="notes"></textarea></td></tr>
      </table><p>Amount: <input id="amount"> <input type="submit" value="Transfer"></p>
      <p><label for="ok">Labelled</label><input id="ok"></p></form>`);
    for (const [d, id] of [['the First Name field', 'customer.firstName'], ['the Phone # field', 'phone'], ['the Notes field', 'notes'], ['the Amount field', 'amount'], ['the Labelled field', 'ok']]) {
      const r = await resolveTarget(page, describeTarget(d), {}, 500);
      expect(r.locator, `${d}: ${r.notes.join('; ')}`).toBeDefined();
      expect(await r.locator!.evaluate((e) => e.id)).toBe(id);
    }
    expect((await describeElement(page.locator('[id="customer.firstName"]'))).descriptions[0]).toBe('the First Name field');
    expect((await describeElement(page.locator('#amount'))).descriptions[0]).toBe('the Amount field');
  });

  it('reads a checkbox by the words after it (the-internet checkboxes)', async () => {
    await page.setContent(`<!doctype html><form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>`);
    const r = await resolveTarget(page, describeTarget('the checkbox 2 checkbox'), {}, 500);
    expect(r.locator, r.notes.join('; ')).toBeDefined();
    expect(await r.locator!.evaluate((e) => (e as HTMLInputElement).checked)).toBe(true);
    expect((await describeElement(page.locator('#checkboxes input').first())).descriptions[0]).toBe('the checkbox 1 checkbox');
  });
});

describe('FINDING (demoqa.com under load): a click before the page wired its buttons opened no tab', () => {
  it('clicks once more when the first click changed nothing, and never twice when it did', async () => {
    const { createServer } = await import('node:http');
    const { runJourneys } = await import('../../src/runner/index.js');
    const { parseEzScript } = await import('../../src/intent/index.js');
    const { FAST, tempDir } = await import('./fixtures.js');
    const pages: Record<string, string> = {
      // The buttons work only after 1.5 s, like a server-rendered page whose scripts are still loading.
      '/late': `<!doctype html><button id="tab">New Tab</button><button id="say">Say hello</button><p id="out"></p><script>
        setTimeout(() => {
          document.getElementById('tab').onclick = () => window.open('/sample');
          document.getElementById('say').onclick = () => { document.getElementById('out').textContent = 'Hello'; };
        }, 1500);</script>`,
      '/sample': '<!doctype html><h1>Sample</h1>',
      '/count': `<!doctype html><button onclick="n.textContent = String(Number(n.textContent) + 1)">Add</button><p id="n">0</p>`,
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[new URL(req.url ?? '/', 'http://x').pathname] ?? '');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const ez = `Journey: Late buttons\nBase URL: http://127.0.0.1:${port}\n\nOpen /late\nClick the "Say hello" button\n  Expect the page contains "Hello"\nClick the "New Tab" button and switch to the new tab\n  Expect the page contains "Sample"\nOpen /count\nClick the "Add" button\n  Expect the text of #n is "1"\nWait 2.5 seconds\nExpect the text of #n is "1"\n`;
      const run = await runJourneys([parseEzScript(ez)], { ...FAST, outputDir: await tempDir('eztest-dead-click-') });
      const j = run.journeys[0];
      expect(j.steps.map((s) => `${s.status} ${s.intent}${s.error ? `: ${s.error.message}` : ''}`).filter((l) => !l.startsWith('passed'))).toEqual([]);
      expect(j.status).toBe('passed');
    } finally {
      server.close();
    }
  });
});

describe('FINDING (automationexercise.com): a full-screen Google ad after a link click stopped the journey', () => {
  it('closes the ad the way a person does, and the link then goes where it was going', async () => {
    const { createServer } = await import('node:http');
    const { runJourneys } = await import('../../src/runner/index.js');
    const { parseEzScript } = await import('../../src/intent/index.js');
    const { FAST, tempDir } = await import('./fixtures.js');
    // Google's vignette: the click is held back, #google_vignette is added to the address, a full-screen ad shows
    // until its "Close" button in the ad's frame is clicked, then the page goes to the link.
    const ad = `<div id='dismiss-button' role='button' aria-label='Close ad' onclick='parent.closeAd()' style='width:80px;height:30px'>Close</div>`;
    const pages: Record<string, string> = {
      '/': `<!doctype html><a href="/products" id="p">Products</a>
        <ins class="adsbygoogle" style="display:none"></ins><script>
        const ins = document.querySelector('ins');
        document.getElementById('p').addEventListener('click', (e) => {
          e.preventDefault();
          location.hash = 'google_vignette';
          ins.setAttribute('data-vignette-loaded', 'true');
          ins.style.cssText = 'display:block;position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:99';
          ins.innerHTML = ${JSON.stringify(`<iframe srcdoc="${ad.replace(/"/g, '&quot;')}" style="width:300px;height:100px"></iframe>`)};
        });
        window.closeAd = () => { ins.style.display = 'none'; location.href = '/products'; };
        </script>`,
      '/products': '<!doctype html><h1>All Products</h1>',
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[new URL(req.url ?? '/', 'http://x').pathname] ?? '');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const ez = `Journey: Ad in the way\nBase URL: http://127.0.0.1:${port}\n\nOpen /\nClick the "Products" link\n  Expect the URL contains "/products"\n  Expect the page contains "All Products"\n`;
      const run = await runJourneys([parseEzScript(ez)], { ...FAST, outputDir: await tempDir('eztest-vignette-') });
      const j = run.journeys[0];
      expect(j.steps.map((s) => `${s.status} ${s.intent}${s.error ? `: ${s.error.message}` : ''}`).filter((l) => !l.startsWith('passed'))).toEqual([]);
    } finally {
      server.close();
    }
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
