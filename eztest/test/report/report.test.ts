import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { writeReports, renderHtmlReport, renderJUnit, buildJsonReport, healProposals, escapeHtml, safeRelativeUrl, scriptJson } from '../../src/report/index.js';
import { loadRunArtifacts, triageRun, evaluateReadiness, scoreFlakiness } from '../../src/insights/index.js';
import { makeRunFixture, type Fixture } from '../insights/fixtures.js';
import { makeRichFixture, type RichFixture } from './rich-fixture.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let fx: Fixture;
let rich: RichFixture;
let browser: Browser;

async function insights() {
  const art = await loadRunArtifacts(fx.runDir);
  const triage = triageRun({ ...art, ownership: { owned: ['127.0.0.1:4600/**'] } });
  const readiness = evaluateReadiness('gates: { noFailedCriticalJourneys: true, minPassRate: 0.5 }', { run: fx.run, evidence: art.evidence, triage });
  const flaky = [scoreFlakiness('search', ['passed', 'failed', 'passed', 'failed', 'passed', 'failed'])];
  return { triage, readiness, flaky, evidence: art.evidence };
}

async function open(file: string, hash = ''): Promise<{ page: Page; errors: string[]; external: string[] }> {
  const page = await browser.newPage();
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) external.push(r.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(file).href + hash);
  return { page, errors, external };
}

beforeAll(async () => {
  fx = await makeRunFixture();
  rich = await makeRichFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe('escaping helpers', () => {
  it('escapes html, rejects unsafe paths and keeps embedded JSON inside its script element', () => {
    expect(escapeHtml('<a href="x">\'&`')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
    expect(safeRelativeUrl('screenshots/a b.png')).toBe('screenshots/a%20b.png');
    expect(safeRelativeUrl('../etc/passwd')).toBeUndefined();
    expect(safeRelativeUrl('/abs.png')).toBeUndefined();
    expect(safeRelativeUrl('javascript:alert(1)')).toBeUndefined();
    const j = scriptJson({ x: '</script><img src=x onerror=alert(1)>', y: '<!--', z: ' ' });
    expect(j).not.toMatch(/<\/script|<!--|<img/);
    expect(JSON.parse(j)).toEqual({ x: '</script><img src=x onerror=alert(1)>', y: '<!--', z: ' ' });
  });
});

describe('writeReports', () => {
  it('writes HTML (with its CSV, one-page summary, e-mail summary, Excel workbook and PDF), JSON v2 with the model, and JUnit XML', async () => {
    const ins = await insights();
    const out = await writeReports(fx.runDir, fx.run, { formats: ['html', 'json', 'junit'], ...ins });
    expect(Object.keys(out).sort()).toEqual(['csv', 'email', 'html', 'json', 'junit', 'pdf', 'summary', 'xlsx']);
    const json = JSON.parse(await readFile(out.json!, 'utf8'));
    expect(json).toMatchObject({ format: 'eztest-report', version: 2 });
    expect(json.run.runId).toBe(fx.run.runId);
    expect(json.insights.triage.verdicts.length).toBe(4);
    expect(json.insights.healProposals).toHaveLength(2);
    expect(json.model.tests).toHaveLength(8);
    expect(existsSync(join(fx.runDir, 'report-model.json'))).toBe(true);
    expect(existsSync(join(fx.runDir, 'context.json'))).toBe(true);
    await expect(writeReports(fx.runDir, fx.run, { formats: [] })).rejects.toThrow(/no formats/);
    await expect(writeReports(fx.runDir, fx.run, { formats: ['docx' as never] })).rejects.toThrow(/Not supported/);
    await expect(writeReports(fx.runDir, fx.run, { formats: ['ctrf' as never] })).rejects.toThrow(/Not supported/);
    await expect(writeReports(fx.runDir, { ...fx.run, journeys: [] }, { formats: ['json'] })).rejects.toThrow(/no journeys/);
  });
});

describe('JUnit', () => {
  it('is valid XML and keeps healed steps visible', () => {
    const xml = renderJUnit(fx.run);
    expect(XMLValidator.validate(xml)).toBe(true);
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const suite = doc.testsuites.testsuite;
    expect(suite.tests).toBe('8');
    expect(suite.failures).toBe('4');
    const cases = suite.testcase as Array<Record<string, any>>;
    const healed = cases.find((c) => c.classname === 'eztest.create-order')!;
    const props = healed.properties.property as Array<{ name: string; value: string }>;
    expect(props.find((p) => p.name === 'eztest.status')!.value).toBe('passed-healed');
    expect(props.find((p) => p.name === 'eztest.heal.s3')!.value).toMatch(/T1-fingerprint confidence=0.92 verified=true css=#submit-order -> css=#place-order/);
    const failed = cases.find((c) => c.classname === 'eztest.checkout')!;
    expect(failed.failure.message).toContain('Post-condition failed');
    expect(cases.find((c) => c.classname === 'eztest.later')!.skipped).toBe('');
    expect(xml).not.toContain('<img src=x');
    expect(xml).not.toContain('<script>');
  });
});

describe('HTML report (static)', () => {
  it('escapes all dynamic content, loads nothing external and leads with the readiness verdict', async () => {
    const ins = await insights();
    const html = renderHtmlReport(fx.run, ins);
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html.indexOf('Release readiness')).toBeLessThan(html.indexOf('id="tests"'));
    expect(html).toContain('<div class="v-decision">NO GO</div>');
    expect(html).toContain('Heal proposals');
    expect(html).toMatch(/title="not in the evidence manifest">E-999</);
    // charts: real SVG with a title, description and a data-table twin
    expect(html).toMatch(/<svg class="viz [^"]*"[^>]*role="(?:img|group)" aria-labelledby="(\w+)-t \1-d"/);
    expect(html).toContain('<summary>Data table</summary>');
    expect(() => renderHtmlReport({ ...fx.run, journeys: [] })).toThrow(/no journeys/);
    expect(buildJsonReport(fx.run).insights.healProposals).toEqual(healProposals(fx.run));
  });

  it('shows every integration with its links and the run context', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json', 'junit'] });
    const html = await readFile(out.html!, 'utf8');
    expect(html).toContain('href="https://dev.azure.com/contoso/Shop/_testManagement/runs?_a=runCharts&amp;runId=4711"');
    expect(html).toMatch(/Azure DevOps <span class="badge status b-flaky">partial<\/span>/);
    expect(html).toContain('1 test case has no test point in suite 88');
    expect(html).toContain('https://dev.azure.com/contoso/Shop/_workitems/edit/5521');
    expect(html).toContain('https://dev.azure.com/contoso/Shop/_git/shop-web/pullrequest/318');
    expect(html).toContain('https://contoso.atlassian.net/browse/SHOP-982');
    expect(html).toContain('https://eztest.contoso.example/ui/p/shop/runs/run-2026-10-22-0800');
    expect(html).toContain('https://dev.azure.com/contoso/Shop/_git/shop-web/commit/9f2c4e1b7a3d5c6e8f9012ab34cd56ef78901234');
    expect(html).toContain('20261022.4');
    expect(html).toMatch(/<strong>teams<\/strong> <span class="badge status b-passed">sent/);
    expect(html).toContain('@contoso/payments');
    expect(html).toContain('Europe/Berlin');
    expect(html).toContain('1 of 2'); // shard
    // comparison against the baseline
    expect(html).toMatch(/Newly failing <span class="cnt ink-failed">2<\/span>/);
    expect(html).toContain('Legacy checkout');
  });
});

describe('HTML report in a real browser', () => {
  it('filters, searches, opens permalinks, navigates by keyboard, shows the lightbox and switches theme', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json'] });
    const { page, errors, external } = await open(out.html!);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    const count = () => page.locator('#count').textContent();
    expect(await count()).toBe('20 of 20 tests');
    // state filter
    await page.locator('.fchip[data-state="failed"]').click();
    expect(await count()).toBe('4 of 20 tests');
    expect(await page.locator('#vlist .row:not(.group)').count()).toBe(4);
    await page.locator('.fchip[data-state="flaky"]').click();
    expect(await count()).toBe('2 of 20 tests');
    await page.locator('.fchip[data-state="all"]').click();
    // full-text search over steps and errors
    await page.locator('#q').fill('discount applied twice');
    await expect.poll(count).toBe('2 of 20 tests matching "discount applied twice"');
    await page.locator('#q').fill('');
    await expect.poll(count).toBe('20 of 20 tests');
    // owner facet and grouping
    await page.selectOption('#f-owner', '@contoso/platform');
    await expect.poll(count).toBe('4 of 20 tests');
    await page.selectOption('#f-owner', '');
    await page.selectOption('#group', 'tag');
    expect(await page.locator('#vlist .row.group').first().textContent()).toContain('@critical');
    await page.selectOption('#group', 'suite');
    // permalink
    await page.goto(pathToFileURL(out.html!).href + '#test/checkout-card');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a saved card');
    const detail = await page.locator('#detail').textContent();
    expect(detail).toContain('discount applied twice');
    expect(detail).toContain('Probable cause');
    expect(detail).toContain('Test case #1201');
    expect(detail).toContain('Bug 5521 (created)');
    expect(detail).toContain('Shares a root cause with 1 other test(s)');
    // before/after screenshots: a compare slider, side by side, and the lightbox
    expect(await page.locator('#detail .cmp-stage img').count()).toBe(2);
    await page.locator('#detail .cmp-bar button', { hasText: 'Side by side' }).click();
    const thumb = page.locator('#detail .ba button').last();
    await thumb.click();
    expect(await page.locator('#lightbox').evaluate((d) => (d as HTMLDialogElement).open)).toBe(true);
    await expect.poll(() => page.locator('#lb-img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(320);
    const cap = await page.locator('#lb-cap').textContent();
    await page.locator('#lb-next').click();
    expect(await page.locator('#lb-cap').textContent()).not.toBe(cap);
    await page.locator('#lb-zoom').click();
    expect(await page.locator('#lb-img').getAttribute('class')).toContain('actual');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#lightbox').evaluate((d) => (d as HTMLDialogElement).open)).toBe(false);
    // the test's evidence vault: names, SHA-256, chain position, filter by kind
    const vault = page.locator('#detail section.panel', { has: page.locator('h3', { hasText: 'Evidence vault' }) });
    const vrows = await vault.locator('tbody tr').count();
    expect(vrows).toBeGreaterThan(0);
    expect(await vault.locator('tbody tr').first().textContent()).toMatch(/#\d+/);
    const kinds = vault.locator('select[aria-label="Filter evidence by kind"] option');
    if ((await kinds.count()) > 2) {
      await vault.locator('select[aria-label="Filter evidence by kind"]').selectOption({ index: 1 });
      expect(await vault.locator('tbody tr').count()).toBeLessThan(vrows);
    }
    // the run-wide evidence browser in the Evidence section
    expect(await page.locator('#ev-browser tbody tr').count()).toBeGreaterThan(0);
    // steps expand; API exchange and DB rows render as code and tables
    await page.goto(pathToFileURL(out.html!).href + '#test/api-orders');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Orders API: create and read');
    await page.locator('#detail .step-row').first().click();
    expect(await page.locator('#detail .step-body').first().textContent()).toContain('"traceId": "7f3a"');
    await page.goto(pathToFileURL(out.html!).href + '#test/db-inventory');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Inventory is reserved in the database');
    await page.locator('#detail .step-row').nth(1).click();
    expect(await page.locator('#detail table caption').first().textContent()).toContain('Query result reserved (2 rows');
    // retries: attempts side by side, the differing step marked
    await page.goto(pathToFileURL(out.html!).href + '#test/checkout-split');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Split payment');
    expect(await page.locator('#detail .attempts th.diff').count()).toBeGreaterThan(0);
    // keyboard: / focuses search, arrows move, Enter opens
    await page.locator('#detail').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    expect(await page.evaluate('document.activeElement.id')).toBe('q');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a voucher [voucher=SAVE10, country=DE]');
    expect(await page.evaluate('location.hash')).toBe('#test/checkout-voucher');
    expect(await page.locator('#detail').textContent()).toContain('SAVE10'); // the data row
    // theme toggle
    const before = await page.evaluate('document.documentElement.getAttribute("data-theme")');
    await page.locator('#theme-toggle').click();
    expect(await page.evaluate('document.documentElement.getAttribute("data-theme")')).not.toBe(before);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('has no serious accessibility violations in light and dark (summary and an open failed test)', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    for (const theme of ['light', 'dark']) {
      const { page } = await open(out.html!);
      await page.evaluate(`localStorage.setItem('ez-report-theme', '${theme}')`);
      await page.goto(pathToFileURL(out.html!).href + `?theme=${theme}#test/account-profile`);
      await expect.poll(() => page.locator('#d-title').textContent()).toBe('Edit the profile');
      expect(await page.evaluate('document.documentElement.getAttribute("data-theme")')).toBe(theme);
      await expectNoSeriousA11y(page, `report-${theme}`);
      await page.evaluate('localStorage.clear()');
      await page.close();
    }
    const plain = await writeReports(fx.runDir, fx.run, { formats: ['html'], ...(await insights()) });
    const { page } = await open(plain.html!);
    await expectNoSeriousA11y(page, 'report-small');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11y(page, 'report-small-dark');
    await page.close();
  });

  it('the one-page summary, comparison and trends pages are accessible and self-contained', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    const { page, external, errors } = await open(out.summary!);
    expect(await page.locator('.v-decision').textContent()).toBe('NO GO');
    await expectNoSeriousA11y(page, 'summary');
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });
});
