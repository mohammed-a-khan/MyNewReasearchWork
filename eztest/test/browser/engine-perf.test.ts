/**
 * Performance budget: css, text and role queries over a 10k-element DOM
 * (with open shadow roots) must stay under 50 ms each.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '../../src/browser/index.js';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { ev, launch, load } from './harness.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

/** 1000 table rows x 9 elements + 100 shadow cards x 10 elements + scaffolding ≈ 10k elements. */
const BUILD = `
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  for (let i = 0; i < 1000; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><span class="sku">SKU-' + i + '</span></td><td><a href="#p' + i + '">Product ' + i + '</a></td>'
      + '<td><input aria-label="Quantity ' + i + '" value="1"></td><td><button class="buy">Buy ' + i + '</button></td>';
    tbody.appendChild(tr);
  }
  document.body.appendChild(table);
  for (let i = 0; i < 100; i++) {
    const host = document.createElement('x-card');
    host.attachShadow({ mode: 'open' }).innerHTML = '<div class="card"><h3>Card ' + i + '</h3><p>Lorem <b>ipsum</b> dolor</p>'
      + '<ul><li>a</li><li>b</li></ul><button class="buy">Shadow buy ' + i + '</button><span>x</span></div>';
    document.body.appendChild(host);
  }
  document.body.getBoundingClientRect(); // settle style and layout, as on a loaded page
  return document.getElementsByTagName('*').length + [...document.querySelectorAll('x-card')].reduce((n, h) => n + h.shadowRoot.querySelectorAll('*').length, 0);
`;

const CASES: Array<[string, unknown[], number]> = [
  ['css', [{ css: 'button.buy' }], 1100],
  ['text', [{ text: 'Product 999' }], 1],
  ['role', [{ role: 'button', name: 'Buy 500', exact: true }], 1],
  ['role (no name)', [{ role: 'link' }], 1000],
];

describe('engine performance (10k elements)', () => {
  it('css, text and role queries each take < 50 ms', async () => {
    await load(page, '<main id=root></main>');
    const count = await ev<number>(page, BUILD);
    expect(count).toBeGreaterThanOrEqual(10_000);
    const results: Record<string, { cold: number; median: number; matches: number }> = {};
    for (const [label, chain, expected] of CASES) {
      const r = await ev<{ times: number[]; matches: number }>(
        page,
        `const times = []; let matches = 0;
         for (let i = 0; i < 7; i++) { const t0 = performance.now(); matches = E.query(ARG).length; times.push(performance.now() - t0); }
         return { times, matches };`,
        chain,
      );
      const sorted = [...r.times].sort((a, b) => a - b);
      results[label] = { cold: +r.times[0].toFixed(1), median: +sorted[3].toFixed(1), matches: r.matches };
      expect(r.matches).toBe(expected);
    }
    const out = join(tmpdir(), 'eztest-engine-perf.json');
    writeFileSync(out, JSON.stringify({ elements: count, results }, null, 2));
    console.log(`engine perf over ${count} elements (ms): ${JSON.stringify(results)}`);
    for (const [label, r] of Object.entries(results)) expect(r.median, label).toBeLessThan(50);
  });
});
