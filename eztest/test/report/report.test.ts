import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { chromium, type Browser } from '../../src/browser/index.js';
import { writeReports, renderHtmlReport, renderJUnit, buildJsonReport, healProposals, escapeHtml, safeRelativeUrl } from '../../src/report/index.js';
import { loadRunArtifacts, triageRun, evaluateReadiness, scoreFlakiness } from '../../src/insights/index.js';
import { makeRunFixture, type Fixture } from '../insights/fixtures.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let fx: Fixture;
let browser: Browser;

async function insights() {
  const art = await loadRunArtifacts(fx.runDir);
  const triage = triageRun({ ...art, ownership: { owned: ['127.0.0.1:4600/**'] } });
  const readiness = evaluateReadiness('gates: { noFailedCriticalJourneys: true, minPassRate: 0.5 }', { run: fx.run, evidence: art.evidence, triage });
  const flaky = [scoreFlakiness('search', ['passed', 'failed', 'passed', 'failed', 'passed', 'failed'])];
  return { triage, readiness, flaky, evidence: art.evidence };
}

beforeAll(async () => {
  fx = await makeRunFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

describe('escaping helpers', () => {
  it('escapes html and rejects unsafe paths', () => {
    expect(escapeHtml('<a href="x">\'&`')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
    expect(safeRelativeUrl('screenshots/a b.png')).toBe('screenshots/a%20b.png');
    expect(safeRelativeUrl('../etc/passwd')).toBeUndefined();
    expect(safeRelativeUrl('/abs.png')).toBeUndefined();
    expect(safeRelativeUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('writeReports', () => {
  it('writes all three formats (HTML, JSON, JUnit XML) into the run directory', async () => {
    const ins = await insights();
    const out = await writeReports(fx.runDir, fx.run, { formats: ['html', 'json', 'junit'], ...ins });
    expect(Object.keys(out).sort()).toEqual(['html', 'json', 'junit']);
    const json = JSON.parse(await readFile(out.json!, 'utf8'));
    expect(json.run.runId).toBe(fx.run.runId);
    expect(json.insights.triage.verdicts.length).toBe(4);
    expect(json.insights.healProposals).toHaveLength(2);
    await expect(writeReports(fx.runDir, fx.run, { formats: [] })).rejects.toThrow(/no formats/);
    await expect(writeReports(fx.runDir, fx.run, { formats: ['pdf' as never] })).rejects.toThrow(/Not supported/);
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
    // hostile names are escaped
    expect(xml).not.toContain('<img src=x');
    expect(xml).not.toContain('<script>');
  });
});

describe('HTML report', () => {
  it('escapes all dynamic content and has no external resources', async () => {
    const ins = await insights();
    const html = renderHtmlReport(fx.run, ins);
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain('Release readiness: NO GO');
    expect(html).toContain('Heal proposals');
    expect(html).toContain('E-999'); // cited by heal but missing -> shown as missing
    expect(html).toMatch(/class="ev missing"[^>]*>E-999/);
    expect(() => renderHtmlReport({ ...fx.run, journeys: [] })).toThrow(/no journeys/);
    expect(buildJsonReport(fx.run).insights.healProposals).toEqual(healProposals(fx.run));
  });

  it('works in a real browser: screenshots, filters, keyboard step navigation, dark mode, accessibility', async () => {
    const ins = await insights();
    const out = await writeReports(fx.runDir, fx.run, { formats: ['html'], ...ins });
    const page = await browser.newPage();
    const external: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('file:')) external.push(r.url());
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(out.html!).href);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);

    // screenshot of the failing checkout step is visible and actually loaded
    const img = page.locator('#j-checkout img');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(40);

    // filters
    await page.getByRole('button', { name: /^Failed/ }).click();
    expect(await page.locator('.journey:not([hidden])').count()).toBe(4);
    await page.getByRole('button', { name: /^Healed/ }).click();
    expect(await page.locator('.journey:not([hidden])').count()).toBe(1);
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByLabel('Search journeys by name, id or tag').fill('@orders');
    expect(await page.locator('.journey:not([hidden])').count()).toBe(2);
    await page.getByLabel('Search journeys by name, id or tag').fill('');

    // time-travel viewer: failing step selected by default, arrows move selection
    const tabs = page.locator('#j-checkout [role=tab]');
    expect(await tabs.nth(1).getAttribute('aria-selected')).toBe('true');
    await tabs.nth(1).focus();
    await page.keyboard.press('ArrowDown');
    expect(await tabs.nth(2).getAttribute('aria-selected')).toBe('true');
    expect(await page.locator('#j-checkout [role=tabpanel]:not([hidden])').count()).toBe(1);
    await page.keyboard.press('Home');
    expect(await tabs.nth(0).getAttribute('aria-selected')).toBe('true');

    // dark mode toggle
    const before = await page.evaluate('document.documentElement.getAttribute("data-theme")');
    await page.locator('#theme-toggle').click();
    const after = await page.evaluate('document.documentElement.getAttribute("data-theme")');
    expect(after).not.toBe(before);

    // the report itself has no serious/critical accessibility violations (light and dark)
    await expectNoSeriousA11y(page, 'report');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11y(page, 'report-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.close();
    void join;
  });
});
