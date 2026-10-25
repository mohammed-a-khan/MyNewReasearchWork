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
  it('escapes all dynamic content, loads nothing external and carries no verdict by default', async () => {
    const ins = await insights();
    const html = renderHtmlReport(fx.run, ins);
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)\\u003e journey');
    // A readiness policy ran (NO_GO), but the report shows no verdict unless report.readiness is on.
    expect(html).not.toMatch(/NO GO|NO_GO|GO WITH RISKS|Release readiness|readiness score/i);
    expect(html).not.toContain('id="tab-policy"');
    // charts: real SVG with a title
    expect(html).toMatch(/<svg class="viz"[^>]*role="img" aria-labelledby="donut-t"/);
    expect(() => renderHtmlReport({ ...fx.run, journeys: [] })).toThrow(/no journeys/);
    expect(buildJsonReport(fx.run).insights.healProposals).toEqual(healProposals(fx.run));
  });

  it('shows the readiness decision only in a secondary Policy tab when report.readiness is on', async () => {
    const ins = await insights();
    const html = renderHtmlReport(fx.run, { ...ins, showPolicy: true });
    expect(html).toMatch(/<button type="button" role="tab" class="tab secondary" id="tab-policy"/);
    expect(html).toContain('<div class="decision">NO GO</div>');
    // The decision is in the Policy panel only: not in the header, the Overview or another tab.
    const policy = html.indexOf('id="p-policy"');
    expect(html.indexOf('NO GO')).toBeGreaterThan(policy);
    expect(html.lastIndexOf('NO GO', policy)).toBe(-1);
  });

  it('puts every integration and the run context in the Environment tab, the comparison in Trends', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json', 'junit'] });
    const html = await readFile(out.html!, 'utf8');
    const env = html.slice(html.indexOf('id="p-environment"'), html.indexOf('</section>', html.indexOf('id="env-extra"') > 0 ? html.indexOf('id="env-extra"') : html.indexOf('id="p-environment"')) + 2000);
    expect(env).toContain('href="https://dev.azure.com/contoso/Shop/_testManagement/runs?_a=runCharts&amp;runId=4711"');
    expect(env).toMatch(/Azure DevOps <span class="badge status b-flaky">partial<\/span>/);
    expect(env).toContain('1 test case has no test point in suite 88');
    expect(env).toContain('https://dev.azure.com/contoso/Shop/_workitems/edit/5521');
    expect(env).toContain('https://dev.azure.com/contoso/Shop/_git/shop-web/pullrequest/318');
    expect(env).toContain('https://contoso.atlassian.net/browse/SHOP-982');
    expect(env).toContain('https://eztest.contoso.example/ui/p/shop/runs/run-2026-10-22-0800');
    expect(env).toContain('https://dev.azure.com/contoso/Shop/_git/shop-web/commit/9f2c4e1b7a3d5c6e8f9012ab34cd56ef78901234');
    expect(env).toContain('20261022.4');
    expect(env).toMatch(/<strong>teams<\/strong> <span class="badge status b-passed">sent/);
    expect(env).toContain('@contoso/payments');
    expect(env).toContain('Europe/Berlin');
    expect(env).toContain('1 of 2'); // shard
    // The comparison against the baseline is in Trends.
    const trends = html.slice(html.indexOf('id="p-trends"'), html.indexOf('id="p-quality"'));
    expect(trends).toMatch(/Newly failing <span class="cnt">2<\/span>/);
    expect(html).toContain('Legacy checkout');
  });
});

/** Visible text of the elements matching `sel` (innerText: hidden panels and sr-only text excluded by layout). */
const visibleText = (page: Page, sel = 'body') => page.locator(sel).evaluate((el) => (el as HTMLElement).innerText);
/** Visible text of a panel without screen-reader-only text and without the list rows (group sizes are per group, not the run's). */
const panelText = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.sr-only, #vinner').forEach((x) => x.remove());
    document.body.appendChild(c);
    const t = c.innerText;
    c.remove();
    return t;
  });

describe('HTML report in a real browser', () => {
  it('has real tabs: one panel visible, arrow keys, deep links, back and forward, the tab remembered', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json'] });
    const { page, errors, external } = await open(out.html!);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    const tabs = page.getByRole('tab');
    expect(await page.locator('#tablist [role=tab]').allTextContents()).toEqual(['Overview', 'Tests', 'Failures', 'Trends', 'Quality', 'Environment']);
    const visiblePanels = () => page.locator('[role=tabpanel].tabpanel').evaluateAll((ps) => ps.filter((p) => (p as HTMLElement).offsetParent !== null).map((p) => p.getAttribute('data-tab')));
    expect(await visiblePanels()).toEqual(['overview']);
    expect(await page.locator('#tab-overview').getAttribute('aria-selected')).toBe('true');
    // Keyboard: arrows move along the tablist and select; Home / End.
    await page.locator('#tab-overview').focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate('document.activeElement.id')).toBe('tab-tests');
    expect(await visiblePanels()).toEqual(['tests']);
    expect(await page.evaluate('location.hash')).toBe('#tests');
    await page.keyboard.press('End');
    expect(await visiblePanels()).toEqual(['environment']);
    await page.keyboard.press('Home');
    expect(await visiblePanels()).toEqual(['overview']);
    await page.keyboard.press('ArrowLeft');
    expect(await visiblePanels()).toEqual(['environment']);
    expect(await tabs.count()).toBeGreaterThanOrEqual(6);
    // Clicks and the history: back and forward restore the tab and the open test.
    await page.locator('#tab-failures').click();
    expect(await visiblePanels()).toEqual(['failures']);
    await page.locator('#p-failures .group-tests a', { hasText: 'Checkout with a saved card' }).click();
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a saved card');
    expect(await page.evaluate('location.hash')).toBe('#tests/checkout-card');
    expect(await visiblePanels()).toEqual(['tests']);
    await page.goBack();
    await expect.poll(visiblePanels).toEqual(['failures']);
    await page.goForward();
    await expect.poll(visiblePanels).toEqual(['tests']);
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a saved card');
    // Deep links straight to a tab and to a test; legacy links still work.
    await page.goto(pathToFileURL(out.html!).href + '#quality');
    await expect.poll(visiblePanels).toEqual(['quality']);
    await page.goto(pathToFileURL(out.html!).href + '#test/api-orders');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Orders API: create and read');
    expect(await page.evaluate('location.hash')).toBe('#tests/api-orders');
    // The selected tab is remembered for the next visit without a hash.
    await page.goto(pathToFileURL(out.html!).href + '#environment');
    await expect.poll(visiblePanels).toEqual(['environment']);
    await page.goto(pathToFileURL(out.html!).href);
    await expect.poll(visiblePanels).toEqual(['environment']);
    await page.evaluate('localStorage.clear()');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows each summary count exactly once, in the header', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    const { page } = await open(out.html!);
    const k = { tests: 20, passed: 9, failed: 4, flaky: 2, skipped: 2 };
    for (const tab of ['overview', 'tests', 'failures', 'trends', 'quality', 'environment']) {
      await page.evaluate(`location.hash = '#${tab}'`);
      await expect.poll(() => page.locator(`#p-${tab}`).isVisible()).toBe(true);
      const text = await panelText(page, "body");
      for (const [label, n] of Object.entries(k)) expect(text.match(new RegExp(`(^|\\s)${n}\\s+${label}\\b`, 'gi')) ?? [], `${n} ${label} on ${tab}`).toHaveLength(1);
      // The panels themselves repeat none of the header's counts as "<n> <label>" or "<label> <n>".
      const panel = await panelText(page, `#p-${tab}`);
      for (const [label, n] of Object.entries(k)) expect(panel).not.toMatch(new RegExp(`\\b(${n}[ \\u00a0]+${label}|${label}[ \\u00a0]+${n})\\b`, 'i'));
      expect(text).not.toMatch(/NO GO|readiness/i);
    }
    await page.close();
  });

  it('filters, searches, opens a test in the split detail with its timeline, attempts, sub-tabs and lightbox, and switches theme', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html', 'json'] });
    const { page, errors } = await open(out.html!, '#tests');
    const count = () => page.locator('#count').textContent();
    expect(await count()).toBe('Showing all');
    await page.locator('.fchip[data-state="failed"]').click();
    expect(await count()).toBe('4 shown');
    expect(await page.locator('#vlist .row:not(.group)').count()).toBe(4);
    await page.locator('.fchip[data-state="flaky"]').click();
    expect(await count()).toBe('2 shown');
    await page.locator('.fchip[data-state="all"]').click();
    await page.locator('#q').fill('discount applied twice');
    await expect.poll(count).toBe('2 shown for "discount applied twice"');
    await page.locator('#q').fill('');
    await expect.poll(count).toBe('Showing all');
    await page.locator('#more-filters summary').click();
    await page.selectOption('#f-owner', '@contoso/platform');
    await expect.poll(count).toBe('4 shown');
    await page.selectOption('#f-owner', '');
    await page.selectOption('#group', 'tag');
    expect(await page.locator('#vlist .row.group').first().textContent()).toContain('@critical');
    await page.selectOption('#group', 'suite');
    // The detail: header, the cause once, the failing step expanded with its error, expected / actual and before/after screenshots.
    await page.goto(pathToFileURL(out.html!).href + '#tests/checkout-card');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a saved card');
    const detail = page.locator('#detail');
    expect(await detail.locator('.d-head').textContent()).toMatch(/Duration[\s\S]*@critical[\s\S]*Test case #1201[\s\S]*Bug 5521 \(created\)/);
    expect(await detail.locator('.cause').textContent()).toMatch(/Product defect[\s\S]*Next step:[\s\S]*Same cause as 1 other test/);
    expect(await detail.locator('.cause details summary').textContent()).toMatch(/Probable cause/);
    const failingStep = detail.locator('.step.failed .step-body');
    await expect.poll(() => failingStep.isVisible()).toBe(true);
    expect(await failingStep.locator('.err').textContent()).toContain('discount applied twice');
    expect((await detail.textContent())!.match(/discount applied twice/g)).toHaveLength(1);
    expect(await detail.locator('.cmp-stage img').count()).toBe(2);
    await detail.locator('.cmp-bar button', { hasText: 'Side by side' }).click();
    await detail.locator('.ba button').last().click();
    expect(await page.locator('#lightbox').evaluate((d) => (d as HTMLDialogElement).open)).toBe(true);
    await expect.poll(() => page.locator('#lb-img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(320);
    const cap = await page.locator('#lb-cap').textContent();
    await page.locator('#lb-next').click();
    expect(await page.locator('#lb-cap').textContent()).not.toBe(cap);
    await page.locator('#lb-zoom').click();
    expect(await page.locator('#lb-img').getAttribute('class')).toContain('actual');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#lightbox').evaluate((d) => (d as HTMLDialogElement).open)).toBe(false);
    // A step's thumbnail opens the lightbox too.
    await detail.locator('.step-thumb').first().click();
    expect(await page.locator('#lightbox').evaluate((d) => (d as HTMLDialogElement).open)).toBe(true);
    await page.keyboard.press('Escape');
    // Sub-tabs: logs, network and evidence live inside the detail, one at a time, with arrow keys.
    const subs = detail.locator('[role=tablist] [role=tab]');
    expect(await subs.allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/^Steps/), expect.stringMatching(/^Evidence/)]));
    await detail.locator('[role=tab][data-sub=steps]').focus();
    await page.keyboard.press('End');
    const shownSub = () => detail.locator('[role=tabpanel]:not([hidden])').evaluateAll((ps) => ps.map((p) => p.id.split('-').pop()));
    expect((await shownSub()).length).toBe(1);
    await detail.locator('[role=tab][data-sub=evidence]').click();
    expect(await shownSub()).toEqual(['evidence']);
    const vault = detail.locator('[role=tabpanel]:not([hidden])');
    const vrows = await vault.locator('tbody tr').count();
    expect(vrows).toBeGreaterThan(0);
    expect(await vault.locator('tbody tr').first().textContent()).toMatch(/#\d+/);
    // API exchange and DB rows render as code and tables inside the step.
    await page.goto(pathToFileURL(out.html!).href + '#tests/api-orders');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Orders API: create and read');
    await detail.locator('[role=tab][data-sub=steps]').click();
    expect(await detail.locator('.step-body').first().textContent()).toContain('"traceId": "7f3a"');
    await page.goto(pathToFileURL(out.html!).href + '#tests/db-inventory');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Inventory is reserved in the database');
    await detail.locator('.step-row').nth(1).click();
    expect(await detail.locator('table caption').first().textContent()).toContain('Query result reserved (2 rows');
    // Retries: a segmented control; an earlier attempt shows its steps, the differing ones marked.
    await page.goto(pathToFileURL(out.html!).href + '#tests/checkout-split');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Split payment');
    const seg = detail.getByRole('group', { name: 'Attempts' });
    expect(await seg.locator('button').allTextContents()).toEqual(['Attempt 1', 'Attempt 2 (final)']);
    await seg.locator('button').first().click();
    expect(await detail.locator('.attempt-steps li.diff').count()).toBeGreaterThan(0);
    // Keyboard: Esc closes, / searches, arrows move, Enter opens.
    await detail.focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#d-title').count()).toBe(0);
    await page.keyboard.press('/');
    expect(await page.evaluate('document.activeElement.id')).toBe('q');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a voucher [voucher=SAVE10, country=DE]');
    expect(await page.evaluate('location.hash')).toBe('#tests/checkout-voucher');
    expect(await detail.locator('.d-head').textContent()).toMatch(/voucher\s*SAVE10/); // the data row
    // Theme toggle.
    const before = await page.evaluate('document.documentElement.getAttribute("data-theme")');
    await page.locator('#theme-toggle').click();
    expect(await page.evaluate('document.documentElement.getAttribute("data-theme")')).not.toBe(before);
    await page.evaluate('localStorage.clear()');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('on a phone opens the test full screen, with no horizontal scroll', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(pathToFileURL(out.html!).href + '#tests');
    await page.locator('#vinner .row[data-id="checkout-card"]').click();
    await expect.poll(() => page.locator('#d-title').textContent()).toBe('Checkout with a saved card');
    const box = await page.locator('#detail').boundingBox();
    expect(box).toMatchObject({ x: 0, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Back to the list' }).click();
    await expect.poll(() => page.locator('#detail').isVisible()).toBe(false);
    for (const tab of ['overview', 'failures', 'environment']) {
      await page.evaluate(`location.hash = '#${tab}'`);
      await expect.poll(() => page.locator(`#p-${tab}`).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), tab).toBeLessThanOrEqual(1);
    }
    await page.close();
  });

  it('prints every section without tabs, one section per test', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    const { page } = await open(out.html!);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('#tablist').isVisible()).toBe(false);
    for (const tab of ['overview', 'failures', 'trends', 'quality', 'environment']) expect(await page.locator(`#p-${tab}`).isVisible(), tab).toBe(true);
    expect(await page.locator('#explorer').isVisible()).toBe(false);
    expect(await page.locator('#print-tests .ptest').count()).toBe(20);
    expect(await page.locator('#print-tests .ptest.fail').count()).toBe(7);
    await page.close();
  });

  it('has no serious accessibility violations in light and dark (overview and an open failed test)', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    for (const theme of ['light', 'dark']) {
      const { page } = await open(out.html!);
      await page.goto(pathToFileURL(out.html!).href + `?theme=${theme}#tests/account-profile`);
      await expect.poll(() => page.locator('#d-title').textContent()).toBe('Edit the profile');
      expect(await page.evaluate('document.documentElement.getAttribute("data-theme")')).toBe(theme);
      await expectNoSeriousA11y(page, `report-${theme}`);
      await page.goto(pathToFileURL(out.html!).href + `?theme=${theme}#overview`);
      await expectNoSeriousA11y(page, `report-${theme}-overview`);
      await page.close();
    }
    const plain = await writeReports(fx.runDir, fx.run, { formats: ['html'], ...(await insights()) });
    const { page } = await open(plain.html!);
    await expectNoSeriousA11y(page, 'report-small');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11y(page, 'report-small-dark');
    await page.close();
  });

  it('the one-page summary is accessible, self-contained and carries no verdict', async () => {
    const out = await writeReports(rich.runDir, rich.run, { ...rich.insights, formats: ['html'] });
    const { page, external, errors } = await open(out.summary!);
    expect(await page.locator('body').textContent()).not.toMatch(/NO GO|readiness/i);
    expect(await page.locator('.s-kpis').textContent()).toMatch(/20\s*Tests/);
    await expectNoSeriousA11y(page, 'summary');
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });
});
