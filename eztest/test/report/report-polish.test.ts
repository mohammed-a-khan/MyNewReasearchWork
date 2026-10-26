/**
 * The run report at real-world scale (0.1.0-beta.8 polish): long titles and step texts, many evidence
 * files per step, a dozen tags, long engine messages. No horizontal scroll at laptop and phone widths,
 * bounded controls, human failure headlines with the raw text one click away, integrity details collapsed,
 * no zero-information lines, grouping that fits the run, and the opened test's title in view.
 */
import { describe, it, expect, beforeAll, afterAll } from '../support/testkit.js';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { writeReports, buildReportModel, renderReportModelHtml } from '../../src/report/index.js';
import { failureHeadline } from '../../src/report/headline.js';
import { triageRun } from '../../src/insights/index.js';
import { makeMessyFixture, type MessyFixture } from './messy-fixture.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

let browser: Browser;
let one: MessyFixture;
let two: MessyFixture;
let html1: string;
let html2: string;
const roots: string[] = [];
const messy = async (o: Parameters<typeof makeMessyFixture>[0]) => { const f = await makeMessyFixture(o); roots.push(f.root); return f; };

beforeAll(async () => {
  one = await messy({ count: 13 });
  two = await messy({ count: 6, browsers: ['chromium', 'firefox'] });
  html1 = (await writeReports(one.runDir, one.run, { formats: ['html'], evidence: one.evidence, triage: triageRun({ run: one.run, evidence: one.evidence }) })).html!;
  html2 = (await writeReports(two.runDir, two.run, { formats: ['html'], evidence: two.evidence })).html!;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function open(file: string, hash: string, width = 1366, height = 768): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(pathToFileURL(file).href + hash);
  return { page, errors };
}
const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe('failure headlines', () => {
  it('turns engine messages into a short sentence and keeps anything unknown as its first line', () => {
    expect(failureHeadline('post-condition failed: urlContains: URL does not contain "/pim/viewPersonalDetails/empNumber/"')).toBe('Expected the URL to contain /pim/viewPersonalDetails/empNumber/');
    expect(failureHeadline('post-condition failed: urlContains: URL does not contain "/a/"; pageContainsText: page does not contain "Saved"; did you mean role=link "New" (0.61)?')).toBe('Expected the URL to contain /a/ (and 1 more check)');
    expect(failureHeadline('query returned no rows')).toBe('The database query returned no rows');
    expect(failureHeadline('post-condition failed: textEquals: testid=total text is "21.00", expected "21.50"')).toBe('Expected testid=total to read "21.50", but it reads "21.00"');
    expect(failureHeadline('expected quote total to be "301.35" (actual: "299.85")')).toBe('Expected quote total to be "301.35", but it was "299.85"');
    expect(failureHeadline('post-condition failed: pageContainsText: page does not contain "Welcome, bob"')).toBe('Expected the page to show "Welcome, bob"');
    expect(failureHeadline("locator.fill: Timeout 5000ms exceeded.\nwaiting for getByLabel('First name')")).toBe("Timed out after 5 s waiting for getByLabel('First name')");
    expect(failureHeadline('Error: something odd\n  at x')).toBe('Something odd');
    expect(failureHeadline('x'.repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe('the report with messy, real-world data', () => {
  it('never scrolls sideways: list, detail and evidence at 1366, 1536, 1920 and 390 px, light and dark', async () => {
    for (const [w, h] of [[1366, 768], [1536, 864], [1920, 1000], [390, 844]]) {
      for (const theme of ['light', 'dark']) {
        const { page, errors } = await open(html1, `?theme=${theme}#tests/${one.ids.urlFail}`, w, h);
        await expect.poll(() => page.locator('#d-title').count()).toBe(1);
        expect(await overflowX(page), `page ${w} ${theme}`).toBeLessThanOrEqual(1);
        const list = await page.locator('#vlist').evaluate((v) => v.scrollWidth - v.clientWidth);
        expect(list, `list ${w}`).toBeLessThanOrEqual(1);
        const detail = () => page.locator('#detail').evaluate((d) => d.scrollWidth - d.clientWidth);
        expect(await detail(), `detail ${w}`).toBeLessThanOrEqual(1);
        await page.locator('#detail [role=tab][data-sub=evidence]').click();
        expect(await detail(), `evidence ${w}`).toBeLessThanOrEqual(1);
        expect(await overflowX(page), `page with evidence ${w}`).toBeLessThanOrEqual(1);
        for (const tab of ['overview', 'failures', 'environment']) {
          await page.goto(pathToFileURL(html1).href + `?theme=${theme}#${tab}`);
          await expect.poll(() => page.locator(`#p-${tab}`).isVisible()).toBe(true);
          expect(await overflowX(page), `${tab} ${w}`).toBeLessThanOrEqual(1);
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    }
  }, 180_000);

  it('lists tests with two-line titles (the full title as a tooltip) and the duration and category in their own column', async () => {
    const { page } = await open(html1, '#tests');
    const rows = page.locator('#vlist .row:not(.group)');
    await expect.poll(() => rows.count()).toBeGreaterThan(3);
    const first = rows.first();
    expect(await first.locator('.rname').evaluate((n) => getComputedStyle(n).webkitLineClamp)).toBe('2');
    const title = (await first.getAttribute('title'))!;
    expect(title.split('\n')[0]).toBe(await first.locator('.rname').evaluate((n) => n.firstChild!.textContent));
    const lh = await first.locator('.rname').evaluate((n) => parseFloat(getComputedStyle(n).lineHeight));
    for (const h of await rows.locator('.rname').evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(lh * 2 + 1);
    // The tail column: the same width and right edge on every row.
    const tails = await rows.locator('.rtail').evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.width)]; }));
    expect(new Set(tails.map((x) => x.join(','))).size).toBe(1);
    // A failed test says where it failed; a passed one shows three tags and "+n".
    expect(await page.locator(`#vlist .row[data-id="${one.ids.urlFail}"] .rsub`).textContent()).toMatch(/^Failed at: /);
    expect(await page.locator(`#vlist .row[data-id="${one.ids.passed}"] .rsub`).textContent()).toMatch(/^@hr @pim @regression \+\d+$/);
    // One browser: never repeated on every row.
    expect(await rows.locator('.rsub').allTextContents()).not.toContainEqual(expect.stringContaining('chromium'));
    await page.close();
  });

  it('groups by feature and offers only the groupings and filters with more than one value', async () => {
    const { page } = await open(html1, '#tests');
    const groups = () => page.locator('#group option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(await groups()).toEqual(['suite', 'category', 'none']);
    expect(await page.locator('#group').inputValue()).toBe('suite');
    expect(await page.locator('#vlist .row.group').first().textContent()).toContain('Employee personal details management');
    // A filter that cannot narrow the list is not shown: every test has the same tags, one browser, no owners.
    for (const id of ['f-tag', 'f-browser', 'f-owner']) expect(await page.locator(`#${id}`).isVisible(), id).toBe(false);
    // A grouping remembered from another report (browser) falls back to the feature.
    await page.evaluate(() => localStorage.setItem('ez-report-group', 'browser'));
    await page.reload();
    expect(await page.locator('#group').inputValue()).toBe('suite');
    await page.evaluate(() => localStorage.clear());
    await page.close();
    const p2 = (await open(html2, '#tests')).page;
    expect(await p2.locator('#group option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toContain('browser');
    expect(await p2.locator('#group').inputValue()).toBe('suite');
    expect(await p2.locator('#vlist .row:not(.group) .rsub').first().textContent()).toMatch(/chromium|firefox/);
    await p2.close();
  });

  it('keeps the opened test\'s title below the sticky header, and the detail scrolls on its own', async () => {
    const { page } = await open(html1, '#tests', 1366, 768);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator(`#vlist .row[data-id="${one.ids.urlFail}"]`).click();
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    const visible = async () => {
      const t = await page.locator('#d-title').boundingBox();
      const head = await page.locator('#top').boundingBox();
      const bar = await page.locator('#detail .d-bar').boundingBox();
      return t!.y >= head!.y + head!.height - 1 && t!.y >= bar!.y + bar!.height - 1 && t!.y + t!.height <= 768;
    };
    expect(await visible()).toBe(true);
    // The detail pane scrolls without moving the list or the page.
    const before = await page.evaluate(() => [window.scrollY, document.getElementById('vlist')!.scrollTop]);
    await page.locator('#detail').evaluate((d) => { d.scrollTop = d.scrollHeight; });
    expect(await page.locator('#detail').evaluate((d) => d.scrollTop)).toBeGreaterThan(100);
    expect(await page.evaluate(() => [window.scrollY, document.getElementById('vlist')!.scrollTop])).toEqual(before);
    // Opening another test starts at its title again.
    await page.locator(`#vlist .row[data-id="${one.ids.noRows}"]`).click();
    await expect.poll(() => page.locator('#d-title').textContent()).toMatch(/^Employee onboarding/);
    expect(await page.locator('#detail').evaluate((d) => d.scrollTop)).toBe(0);
    expect(await visible()).toBe(true);
    // A deep link too.
    await page.goto(pathToFileURL(html1).href + `#tests/${one.ids.passed}`);
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    expect(await visible()).toBe(true);
    await page.close();
  });

  it('evidence: one filter row with bounded selects and short options, a compact list by step, integrity details collapsed', async () => {
    const { page } = await open(html1, `#tests/${one.ids.noRows}`, 1366, 768);
    await page.locator('#detail [role=tab][data-sub=evidence]').click();
    const pane = page.locator('#detail [role=tabpanel]:not([hidden])');
    const tools = pane.locator('.evb-tools');
    const mids = await tools.locator(':scope > :not([hidden])').evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
    expect(mids.length).toBe(4);
    expect(Math.max(...mids) - Math.min(...mids)).toBeLessThanOrEqual(4); // one line
    const selects = await tools.locator('select').evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect().width));
    for (const w of selects) expect(w).toBeLessThanOrEqual(340);
    const opts = await tools.locator('select').nth(1).locator('option').allTextContents();
    expect(opts[0]).toBe('All steps');
    for (const o of opts) expect(o.length).toBeLessThanOrEqual(60);
    expect(opts.some((o) => /^Step 7 · Then I get the value of query .*…$/.test(o))).toBe(true);
    // Rows: a human title, the size and time; no paths, hashes or chain positions on show.
    const rows = pane.locator('.evrow');
    expect(await rows.count()).toBeGreaterThan(10);
    expect(await rows.first().locator('.ev-title').textContent()).toBe('Screenshot after step 1');
    expect(await pane.locator('.evgroup-h').first().textContent()).toMatch(/^Step 1 · Given I am logged in/);
    const shown = await pane.evaluate((p) => (p as HTMLElement).innerText);
    expect(shown).not.toMatch(/SHA-256|chain #|journeys\/scenario-1/);
    expect(await pane.locator('.ev-int:not([hidden])').count()).toBe(0);
    // ...one click away.
    await rows.first().getByRole('button', { name: /Integrity details/ }).click();
    const int = rows.first().locator('.ev-int');
    expect(await int.isVisible()).toBe(true);
    expect(await int.textContent()).toMatch(/SHA-256[0-9a-f]{64}[\s\S]*position \d+/);
    // Filtering by step.
    await tools.locator('select').nth(1).selectOption({ index: 2 });
    expect(await pane.locator('.evgroup').count()).toBe(1);
    await page.close();
  });

  it('shows human failure headlines with the raw message available, and no zero-information lines', async () => {
    const { page } = await open(html1, '#failures');
    const msgs = await page.locator('#p-failures .group-msg').allTextContents();
    expect(msgs).toContain('Expected the URL to contain /pim/viewPersonalDetails/empNumber/ (and 1 more check)');
    expect(msgs).toContain('The database query returned no rows');
    const card = page.locator('#p-failures .cause-card', { hasText: 'Expected the URL to contain' });
    const tech = card.locator('details.tech');
    expect(await tech.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await tech.locator('pre').textContent()).toContain('post-condition failed: urlContains: URL does not contain "/pim/viewPersonalDetails/empNumber/"');
    // Overview: the same headlines.
    await page.goto(pathToFileURL(html1).href + '#overview');
    expect(await page.locator('#p-overview .reason .msg').allTextContents()).toContain('The database query returned no rows');
    // The test detail: the headline first, the raw text under "Technical details".
    await page.goto(pathToFileURL(html1).href + `#tests/${one.ids.urlFail}`);
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    const err = page.locator('#detail .step.failed .err');
    await expect.poll(() => err.isVisible()).toBe(true);
    expect(await err.locator('.err-h').textContent()).toBe('Failure: Expected the URL to contain /pim/viewPersonalDetails/empNumber/ (and 1 more check)');
    expect(await err.locator('details.err-tech').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await err.locator('details.err-tech pre').first().textContent()).toMatch(/^post-condition failed: urlContains/);
    // The triage knew nothing about the missing rows: no "unknown (0% confidence)", no "needs review".
    await page.goto(pathToFileURL(html1).href + `#tests/${one.ids.noRows}`);
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    const text = await page.locator('#detail').evaluate((d) => (d as HTMLElement).innerText);
    expect(text).not.toMatch(/0% confidence|unknown \(|needs review/i);
    expect(await page.locator('#detail .cause .cat').first().textContent()).toBe('Test data');
    await page.close();
  });

  it('collapses long tables and tag lists: "Show all 11 tags", "+n more"', async () => {
    const big = await messy({ count: 4 });
    // Every test has its own extra tags: many rows in "Results by tag".
    big.run.journeys.forEach((j, i) => { j.tags = [...j.tags, `@extra-${i}`, `@extra-${i}-b`]; });
    const html = renderReportModelHtml(buildReportModel(big.run, { evidence: big.evidence }));
    const shown = (html.match(/<tr class="more-row"/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(html).toMatch(/Show all 19 tags/);
    const { page } = await open(html1, '#overview');
    const tagCard = page.locator('#p-overview section', { has: page.locator('#ov-tag') });
    const visibleRows = () => tagCard.locator('tbody tr').evaluateAll((rs) => rs.filter((r) => (r as HTMLElement).offsetParent !== null).length);
    expect(await visibleRows()).toBe(8);
    await tagCard.getByRole('button', { name: 'Show all 11 tags' }).click();
    expect(await visibleRows()).toBe(11);
    await page.goto(pathToFileURL(html1).href + `#tests/${one.ids.passed}`);
    await expect.poll(() => page.locator('#d-title').count()).toBe(1);
    const chips = page.locator('#detail .d-head .chips');
    const all = await chips.locator('.chip:not(.chip-more)').count();
    expect(all).toBeGreaterThan(8);
    expect(await chips.locator('.chip:not([hidden])').count()).toBe(9); // 8 and "+n more"
    await chips.getByRole('button', { name: `+${all - 8} more` }).click();
    expect(await chips.locator('.chip:not([hidden])').count()).toBe(all);
    await page.close();
  });

  it('shows the Overview notice only when something is wrong (a failed preflight), never empty', async () => {
    expect(html1).not.toContain('class="banner"');
    const bad = await messy({ count: 2, preflightFailed: true });
    const html = renderReportModelHtml(buildReportModel(bad.run, { evidence: bad.evidence }));
    expect(html).toMatch(/<div class="banner" role="note">[\s\S]*Environment unavailable:[\s\S]*returned 503/);
  });

  it('has no serious accessibility violations with the messy data (list, detail, evidence; light and dark)', async () => {
    for (const theme of ['light', 'dark']) {
      const { page } = await open(html1, `?theme=${theme}#tests/${one.ids.urlFail}`);
      await expect.poll(() => page.locator('#d-title').count()).toBe(1);
      await expectNoSeriousA11y(page, `messy-${theme}`);
      await page.locator('#detail [role=tab][data-sub=evidence]').click();
      await page.locator('#detail .evrow').first().getByRole('button', { name: /Integrity details/ }).click();
      await expectNoSeriousA11y(page, `messy-evidence-${theme}`);
      await page.goto(pathToFileURL(html1).href + `?theme=${theme}#failures`);
      await expectNoSeriousA11y(page, `messy-failures-${theme}`);
      await page.close();
    }
  }, 120_000);
});
