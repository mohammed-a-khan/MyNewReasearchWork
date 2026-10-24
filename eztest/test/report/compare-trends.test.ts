/** `eztest report compare`, `eztest report trends`, `report render` and `report schema`, and the pages they write. */
import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProgram } from '../../src/cli/index.js';
import { chromium, type Browser } from '../../src/browser/index.js';
import { buildTrends, writeReports, recordIntegration } from '../../src/report/index.js';
import { makeRichFixture, type RichFixture } from './rich-fixture.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let rich: RichFixture;
let browser: Browser;
beforeAll(async () => {
  rich = await makeRichFixture();
  await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json'] });
  await mkdir(join(rich.root, '.eztest'), { recursive: true });
  await writeFile(join(rich.root, '.eztest', 'history.json'), JSON.stringify({ version: 1, runs: rich.history }));
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function cli(cwd: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: { PATH: process.env.PATH } }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('eztest report compare', () => {
  it('lists newly failing, fixed, slower, new and removed tests, links into the run report and can gate on new failures', async () => {
    const r = await cli(rich.root, ['report', 'compare', 'eztest-results/run-2026-10-21-0800', 'eztest-results/run-2026-10-22-0800', '--json', 'cmp.json', '--fail-on-new-failures']);
    expect(r.out).toMatch(/^run-2026-10-21-0800 -> run-2026-10-22-0800: 2 newly failing, 1 fixed, 3 still failing, 1 slower, 1 new, 1 removed/);
    expect(r.out).toContain('NEW FAIL account-profile (passed -> failed)');
    expect(r.exitCode).toBe(1);
    const j = JSON.parse(await readFile(join(rich.root, 'cmp.json'), 'utf8'));
    expect(j).toMatchObject({ format: 'eztest-comparison', baselineRunId: 'run-2026-10-21-0800' });
    // Written next to the run folders, never into the run folder (its files are the run's evidence).
    expect(existsSync(join(rich.runDir, 'compare.html'))).toBe(false);
    const file = join(rich.runDir, '..', 'compare', 'run-2026-10-21-0800--run-2026-10-22-0800.html');
    expect(r.out).toContain(`comparison: ${file}`);
    const html = await readFile(file, 'utf8');
    expect(html).toContain('href="../run-2026-10-22-0800/report.html#test/api-orders"');
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href);
    expect(await page.locator('h1').textContent()).toBe('Run comparison');
    await expectNoSeriousA11y(page, 'compare');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11y(page, 'compare-dark');
    await page.close();
  });
});

describe('eztest report trends', () => {
  it('builds the portfolio over history: pass-rate trend, readiness history, flakiest, slowest and most failing tests, heat map by day and suite', async () => {
    const t = buildTrends(rich.history, { suiteOf: (id) => id.split('-')[0] });
    expect(t.totals.runs).toBe(15);
    expect(t.runs[t.runs.length - 1]).toMatchObject({ runId: 'run-2026-10-22-0800', readiness: 'NO_GO' });
    expect(t.flakiest[0].id).toMatch(/checkout-split|search-sort/);
    expect(t.mostFailing.map((x) => x.id)).toContain('data-import');
    expect(t.heatmap.suites).toContain('checkout');
    expect(t.heatmap.days.length).toBeGreaterThan(5);
    const r = await cli(rich.root, ['report', 'trends', '-o', 'trends.html', '--json', 'trends.json']);
    expect(r.out).toMatch(/^15 runs, 20 tests, average pass rate \d+\.\d%: .*trends\.html$/);
    const html = await readFile(join(rich.root, 'trends.html'), 'utf8');
    expect(html).toContain('Failure rate by day and suite');
    expect(html).toContain('Readiness history');
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(rich.root, 'trends.html')).href);
    await expectNoSeriousA11y(page, 'trends');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11y(page, 'trends-dark');
    await page.close();
  });
});

describe('eztest report render and schema', () => {
  it('renders a run again with new integration links; prints the JSON schema', async () => {
    await recordIntegration(rich.runDir, { resultsServer: { url: 'https://results.example/ui/p/x/runs/rerendered', at: new Date().toISOString() } });
    const r = await cli(rich.root, ['report', 'render', 'eztest-results/run-2026-10-22-0800']);
    expect(r.out).toContain('report html:');
    expect(await readFile(join(rich.runDir, 'report.html'), 'utf8')).toContain('https://results.example/ui/p/x/runs/rerendered');
    expect(JSON.parse(await readFile(join(rich.runDir, 'report.json'), 'utf8')).model.integrations.resultsServer.url).toBe('https://results.example/ui/p/x/runs/rerendered');
    const s = await cli(rich.root, ['report', 'schema']);
    expect(JSON.parse(s.out).$id).toBe('eztest:report/2');
  });
});
