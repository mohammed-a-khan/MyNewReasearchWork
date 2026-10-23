/**
 * "Expect ... to be keyboard operable" (G26) with EZTest's own driver:
 * a good form passes; a modal that traps focus fails naming the elements it
 * traps and the ones never reached; a control without a visible focus
 * indicator fails naming it; a container check stays inside the container.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEzScript, parseIntent } from '../../src/intent/index.js';
import { runJourneys } from '../../src/runner/index.js';
import { KEYBOARD_STEP, createKeyboardStepHandler } from '../../src/lenses/index.js';

const PAGES: Record<string, string> = {
  '/good': `<!doctype html><html lang="en"><head><title>Good</title></head><body><main><h1>Order</h1><section aria-label="Checkout"><form><label for="n">Name</label><input id="n"><label for="q">Quantity</label><input id="q" type="number"><button type="submit">Place order</button></form></section><a href="/help">Help</a></main></body></html>`,
  '/trap': `<!doctype html><html lang="en"><head><title>Trap</title></head><body><button id="before">Before</button>
    <div role="dialog" aria-label="Promo" id="promo"><button id="p1">Accept</button><button id="p2">Decline</button></div><button id="after">After</button>
    <script>
      document.getElementById('promo').addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        (document.activeElement.id === 'p1' ? document.getElementById('p2') : document.getElementById('p1')).focus();
      });
      document.getElementById('before').addEventListener('keydown', function (e) { if (e.key === 'Tab') { e.preventDefault(); document.getElementById('p1').focus(); } });
    </script></body></html>`,
  '/nofocus': `<!doctype html><html lang="en"><head><title>No focus</title><style>#bad:focus{outline:none}</style></head><body><button id="ok">Fine</button><button id="bad">Invisible focus</button></body></html>`,
};

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? ''] ?? '<!doctype html><title>x</title><p>x</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function run(path: string, line = 'Expect the page to be keyboard operable') {
  const j = parseEzScript(`Journey: Keyboard ${path}\nOpen ${base}${path}\n${line}\n`);
  return runJourneys([j], { outputDir: await mkdtemp(join(tmpdir(), 'eztest-kb-')), customSteps: { [KEYBOARD_STEP]: createKeyboardStepHandler() }, screenshots: 'off' });
}

describe('keyboard operability', () => {
  it('parses the phrasing as a step of its own (page or an element)', () => {
    expect(parseIntent('Expect the page to be keyboard operable')).toMatchObject({ action: 'custom', handler: 'eztest.keyboard' });
    expect(parseIntent('Verify the "Checkout" form is keyboard accessible within 20 tabs')).toMatchObject({ action: 'custom', handler: 'eztest.keyboard', args: { maxTabs: 20 }, target: { description: 'the "Checkout" form' } });
    const j = parseEzScript('Journey: K\nOpen /x\nExpect the page to be keyboard operable');
    expect(j.steps.map((s) => s.action)).toEqual(['navigate', 'custom']);
  });

  it('passes a form whose controls are all reachable with a visible focus indicator', async () => {
    const r = await run('/good');
    expect(r.journeys[0].steps.map((s) => [s.status, s.error?.message])).toEqual([['passed', undefined], ['passed', undefined]]);
    expect(r.journeys[0].ledger.keyboard).toMatchObject({ reached: 4, reachable: 4 });
    const c = await run('/good', 'Expect the "Checkout" region to be keyboard operable');
    expect(c.journeys[0].steps[1].error?.message).toBeUndefined();
    expect(c.journeys[0].ledger.keyboard).toMatchObject({ reached: 3, reachable: 3 });
  });

  it('fails a focus trap in a modal, naming the trapped and the unreachable elements', async () => {
    const r = await run('/trap');
    const s = r.journeys[0].steps[1];
    expect(s.status).toBe('failed');
    expect(s.error?.message).toMatch(/focus is trapped among button#p1 "Accept", button#p2 "Decline"; never reached: button#after "After"/);
  });

  it('fails a control without a visible focus indicator', async () => {
    const r = await run('/nofocus');
    expect(r.journeys[0].steps[1].error?.message).toMatch(/no visible focus indicator on button#bad "Invisible focus"/);
  });
});
