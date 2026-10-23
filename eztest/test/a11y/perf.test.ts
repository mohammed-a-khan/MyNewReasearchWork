/**
 * Performance of EZTest's accessibility engine on a large page (about
 * 16,000 elements: a 1,500-row data table, 1,000 links, 400 labelled
 * fields, nested shadow components and running text) under a time budget.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { scanAccessibility, selectRules } from '../../src/a11y/index.js';
import { page as wrap } from './fixtures.js';

let browser: Browser;
let pg: Page;

/**
 * Every static rule must finish within this budget on the large page. About
 * 1.3 s on a lightly loaded machine; the budget leaves room for loaded CI agents.
 */
const BUDGET_MS = Number(process.env.EZTEST_A11Y_BUDGET_MS ?? 15_000);

function largePage(): string {
  const rows = Array.from({ length: 1500 }, (_, i) => `<tr><th scope="row">Order ${i}</th><td>Customer ${i % 97}</td><td>${(i * 3.7).toFixed(2)}</td><td><a href="/o/${i}">Open</a></td><td><button type="button" aria-label="Delete order ${i}">×</button></td></tr>`).join('');
  const links = Array.from({ length: 1000 }, (_, i) => `<li><a href="/p/${i}">Product ${i}</a></li>`).join('');
  const fields = Array.from({ length: 400 }, (_, i) => `<div><label for="f${i}">Field ${i}</label><input id="f${i}" name="f${i}" autocomplete="off"></div>`).join('');
  const text = Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i} with <strong>bold</strong>, <em>emphasis</em> and a <a href="/t/${i}">link</a> in running text.</p>`).join('');
  return wrap(`
    <nav aria-label="Catalogue"><ul>${links}</ul></nav>
    <style>td, th { padding: 6px; } nav li { padding: 4px 0; } form div { margin: 6px 0; }</style>
    <table><caption>Orders</caption><thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Total</th><th scope="col">Link</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table>
    <form aria-label="Big form">${fields}</form>
    <section aria-label="Articles">${text}</section>
    <div id="components"></div>
    <script>
      const host = document.getElementById('components');
      for (let i = 0; i < 200; i++) {
        const el = document.createElement('div');
        el.attachShadow({ mode: 'open' }).innerHTML = '<p>Card ' + i + '</p><button>Act ' + i + '</button><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
        host.appendChild(el);
      }
    </script>`);
}

beforeAll(async () => {
  browser = await chromium.launch();
  pg = await browser.newPage({ viewport: { width: 1280, height: 900 } });
});
afterAll(async () => {
  await browser?.close();
});

describe('accessibility engine performance', () => {
  it(`scans a ~16,000-element page with every static rule in under ${BUDGET_MS} ms`, async () => {
    await pg.setContent(largePage());
    const count = (await pg.evaluate('document.querySelectorAll("*").length')) as number;
    expect(count).toBeGreaterThan(15_000);
    await scanAccessibility(pg, { rules: ['page.title'] }); // install the engine once
    const t0 = Date.now();
    const r = await scanAccessibility(pg, { level: 'AAA' });
    const ms = Date.now() - t0;
    if (process.env.EZTEST_A11Y_PERF_REPORT) {
      console.log(`[a11y perf] ${count} elements, ${r.rules.length} rules: ${ms} ms`);
      const rules = selectRules({ level: 'AAA' }).map((x) => x.id);
      const t1 = Date.now();
      const raw = (await pg.evaluate(`globalThis.__eztestA11y.run(${JSON.stringify({ rules })})`)) as { timings: Record<string, number>; ms: number };
      console.log(`page run ${raw.ms} ms (round trip ${Date.now() - t1} ms), rules sum ${Object.values(raw.timings).reduce((x, y) => x + y, 0)} ms`);
      console.log(Object.entries(raw.timings).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${k} ${v}ms`).join('\n'));
    }
    expect(ms).toBeLessThan(BUDGET_MS);
    // The page is accessible apart from the AAA rules (contrast 7:1 and 44px targets).
    expect(r.violations.filter((v) => !['contrast.text-enhanced', 'target.size-enhanced'].includes(v.ruleId)).map((v) => `${v.ruleId}: ${v.nodes[0]?.failureSummary}`)).toEqual([]);
    expect(r.passes).toBeGreaterThan(20);
  }, 120_000);
});
