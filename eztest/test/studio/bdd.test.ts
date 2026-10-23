/**
 * Gherkin features in the Studio: listing (one entry per scenario and
 * Examples row, nothing executed), editing with Gherkin highlighting and step
 * diagnostics (syntax with line and column, undefined steps with a snippet,
 * ambiguous steps, the definition or EZTest phrasing a step binds to),
 * formatting, running and debugging a scenario, and the feature / rule /
 * scenario grouping in Results.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '../../src/browser/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { bddProject } from '../bdd/helpers.js';

let project: string;
let restoreProject: (() => Promise<void>) | undefined;
let studio: StudioHandle;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-eztest-token': studio.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

const dbgState = () => page.locator('#dbg-status').getAttribute('data-state');

beforeAll(async () => {
  const p = await bddProject();
  project = p.project;
  restoreProject = p.restore;
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await restoreProject?.();
});

describe('Studio: Gherkin features', { timeout: 180_000 }, () => {
  it('lists features from the feature folder with one entry per scenario and Examples row', async () => {
    const r = (await api('GET', '/api/journeys')).json;
    expect(r.featureDirs).toEqual(['features']);
    const list = r.journeys as Array<{ path: string; format: string; name: string; code?: Array<{ id: string; line: number; row?: number }>; error?: string }>;
    const ordering = list.find((j) => j.path === 'features/orders/ordering.feature')!;
    expect(ordering.format).toBe('feature');
    expect(ordering.name).toBe('Ordering in the EZ Shop');
    expect(ordering.code!.map((c) => [c.id, c.line, c.row])).toEqual([
      ['orders-ordering--place-an-order-through-the-ui', 14, undefined],
      ['orders-ordering--eu-customers-come-from-the-database', 20, undefined],
      ['orders-ordering--signed-in-as-user-1', 26, 34],
    ]);
    const quotes = list.find((j) => j.path === 'features/quotes.feature')!;
    expect(quotes.code!.length).toBe(4);
    const f = await api('GET', `/api/file?path=${encodeURIComponent('features/quotes.feature')}`);
    expect(f.json.format).toBe('feature');
    expect(f.json.content).toContain('Rule: Quotes are priced per unit');
  });

  it('validates as you type: syntax with line and column, and how every step binds', async () => {
    const bad = await api('POST', '/api/validate', { format: 'feature', path: 'features/x.feature', content: 'Feature: F\n  Scenario: S\n    Given I am on "/login"\n      | a | b |\n      | 1 |\n' });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.errors[0]).toMatchObject({ line: 5, column: 7, message: expect.stringMatching(/inconsistent cell count/) });

    const content = [
      'Feature: Diagnostics',
      '  Scenario: S',
      '    Given I am on "/login"',
      '    When I order 2 "Widget (19.99)" for "Contoso Ltd"',
      '    And a duplicated step',
      '    Then the customer "Acme" owes 12 dollars',
      '',
    ].join('\n');
    const v = (await api('POST', '/api/validate', { format: 'feature', path: 'features/x.feature', content })).json;
    const d = v.bdd.diagnostics as Array<{ line: number; column: number; kind: string; severity: string; message: string; location?: string; snippet?: string }>;
    expect(d.map((x) => [x.line, x.kind, x.severity])).toEqual([[3, 'ez', 'info'], [4, 'definition', 'info'], [5, 'ambiguous', 'error'], [6, 'undefined', 'warning']]);
    expect(d[0].location).toBe('navigate');
    expect(d[1].location).toMatch(/^steps\/shop\.steps\.ts:\d+$/);
    expect(d[1].column).toBe(5);
    expect(d[2].message).toMatch(/2 step definitions match/);
    expect(d[3].snippet).toMatch(/^Then\('the customer \{string\} owes \{int\} dollars'/);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e: { line: number }) => e.line)).toEqual([5]);
    expect(v.bdd.definitions).toBeGreaterThan(8);

    const defs = (await api('GET', '/api/bdd/definitions')).json;
    expect(defs.files).toEqual(['steps/hooks.steps.ts', 'steps/shop.steps.ts']);
    expect(defs.definitions.map((x: { pattern: string }) => x.pattern)).toContain('I order {int} {string} for {string}');
    expect(defs.definitions.map((x: { pattern: string }) => x.pattern)).toContain('/^the quote is for "([^"]+)"$/');
    expect(defs.parameterTypes.map((x: { name: string }) => x.name)).toEqual(['money']);
  });

  it('formats, creates, saves and refuses to convert features', async () => {
    const fmt = await api('POST', '/api/format', { format: 'feature', content: 'Feature: F\nScenario: S\nGiven x\n|a|bb|\n|ccc|d|\n' });
    expect(fmt.json.content).toBe('Feature: F\n\n  Scenario: S\n    Given x\n      | a   | bb |\n      | ccc | d  |\n'.replace('\n\n  Scenario', '\n  Scenario'));
    const created = await api('POST', '/api/journeys', { path: 'features/new.feature', name: 'Checkout' });
    expect(created.status).toBe(201);
    expect(created.json.content).toContain('Feature: Checkout');
    const saved = await api('PUT', '/api/file', { path: 'features/new.feature', content: created.json.content });
    expect(saved.status).toBe(200);
    expect(saved.json.validation.ok).toBe(true);
    expect(saved.json.validation.bdd.diagnostics.map((x: { kind: string }) => x.kind)).toEqual(['ez', 'ez']);
    expect((await api('POST', '/api/convert', { content: created.json.content, from: 'feature', to: 'ez' })).status).toBe(422);
    expect((await api('PUT', '/api/file', { path: 'step_definitions/more.ts', content: 'export {};\n' })).status).toBe(200);
  });

  it('editor: Gherkin highlighting, step diagnostics and the outline', async () => {
    await page.goto(`${studio.origin}/#/journeys/features/problems.feature`);
    await page.locator('.cm-content').first().waitFor();
    await expect.poll(() => page.locator('.cm-content .tok-heading').count(), { timeout: 20_000 }).toBeGreaterThan(3);
    expect(await page.locator('.cm-content .tok-keyword').count()).toBeGreaterThan(5);
    expect(await page.locator('.cm-content .tok-labelName').first().textContent()).toBe('@negative');
    expect(await page.locator('.cm-content .tok-string').count()).toBeGreaterThan(2);
    // The undefined step is underlined; the ambiguous one is an error.
    await expect.poll(() => page.locator('.cm-lintRange-warning').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.cm-lintRange-error').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('.outline-item').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Scenario: An undefined step'), expect.stringContaining('Given a duplicated step')]));
    // After a step keyword, autocomplete offers the project's step definitions and EZTest phrasings.
    await page.locator('.cm-line').nth(4).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('    When I ord');
    await expect.poll(() => page.locator('.cm-tooltip-autocomplete li').allTextContents(), { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.stringContaining('I order {int} {string} for {string}')]));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    expect(pageErrors).toEqual([]);
  });

  it('debugger: a breakpoint on a feature step pauses there; the scenario at the cursor is the one debugged', async () => {
    const text = await readFile(join(project, 'features', 'quotes.feature'), 'utf8');
    const thenLine = text.split('\n').findIndex((l) => l.includes('Then the quote total is 148.50')) + 1;
    await page.goto(`${studio.origin}/#/debug/features/quotes.feature`);
    await expect.poll(() => page.locator('.dbg-editor .cm-line').count(), { timeout: 20_000 }).toBeGreaterThan(10);
    await expect.poll(() => page.locator('.dbg-step').count()).toBeGreaterThan(5);
    await page.locator(`.dbg-step[data-id="L${thenLine}"] .dbg-step-btn`).click();
    await page.keyboard.press('F9');
    await expect.poll(() => page.locator('.dbg-editor .cm-bp-gutter .bp-dot').count()).toBe(1);
    await page.keyboard.press('F5');
    await expect.poll(dbgState, { timeout: 60_000 }).toBe('paused');
    const s = (await api('GET', '/api/debug/session')).json;
    expect(s.debug).toMatchObject({ journeyId: 'quotes--quote-for-a-gadget', source: { line: thenLine } });
    await expect.poll(() => page.locator('.dbg-editor [data-debug-current="paused"]').textContent()).toContain('Then the quote total is 148.50');
    // Continue (the toolbar button is F5 / F8 while paused).
    await page.locator('#dbg-start').click();
    await expect.poll(dbgState, { timeout: 90_000 }).toBe('done');
    expect(await page.locator('#dbg-status').textContent()).toMatch(/Finished: passed/);
  });

  it('runs scenarios from the Studio; Results groups them by feature and rule', async () => {
    const r = await api('POST', '/api/runs', { journeys: ['quotes--quote-for-a-gadget', 'quotes--quote-from-a-json-request', 'problems--an-undefined-step'] });
    expect(r.status).toBe(202);
    let run: any;
    for (let i = 0; i < 400 && !run; i++) {
      const d = await api('GET', `/api/runs/${r.json.id}`);
      run = d.json.run;
      if (!run) await new Promise((x) => setTimeout(x, 300));
    }
    expect(run.journeys.map((j: any) => [j.journeyId, j.status]).sort()).toEqual([
      ['problems--an-undefined-step', 'failed'], ['quotes--quote-for-a-gadget', 'passed'], ['quotes--quote-from-a-json-request', 'passed'],
    ]);
    await page.goto(`${studio.origin}/#/runs/${r.json.id}`);
    await page.getByRole('tab', { name: /Features/ }).click();
    await expect.poll(() => page.locator('.bdd-feature').count(), { timeout: 20_000 }).toBe(2);
    expect(await page.locator('.bdd-rule summary').first().textContent()).toContain('Rule: Quotes are priced per unit');
    expect(await page.locator('.bdd-scenario').count()).toBe(3);
    expect(await page.locator('.bdd-match-undefined').count()).toBe(1);
    expect(await page.locator('.bdd-snippet').first().textContent()).toContain("When('I do something nobody defined with {string} and {int}'");
    expect(pageErrors).toEqual([]);
  });
});
