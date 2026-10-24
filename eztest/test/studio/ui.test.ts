/**
 * The Studio UI in a real Chromium: editor with live diagnostics, quick fixes
 * and autocomplete; the visual step view round trip; the command palette;
 * theme toggle; a live run, results with screenshots, deep links and
 * cancellation; EZTest's accessibility engine on every view (light and dark); keyboard access; and
 * no CSP violations under the real policy.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';


let app: DemoServer;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const saved: Record<string, string | undefined> = {};


const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

async function go(name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name, exact: true }).click();
  await expect.poll(() => page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name, exact: true }).getAttribute('aria-current')).toBe('page');
}

const editorText = () => page.locator('#editor-host .cm-line').allTextContents().then((l) => l.join('\n'));
const summary = () => page.locator('#validation-summary').textContent();

async function setEditor(text: string): Promise<void> {
  await page.locator('#editor-host .cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

beforeAll(async () => {
  project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = {
    SHOP_URL: app.url,
    SHOP_DB: join(project, 'shop.db'),
    SHOP_ALICE_PASSWORD: 'Wonderland#1',
    SHOP_ALICE_TOTP: DEMO_TOTP_SECRET,
    SHOP_BOB_PASSWORD: 'Builder#2',
    SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  studio = await startStudio({ cwd: project, recordHeadless: true });
  browser = await chromium.launch();
  // No bypassCSP: EZTest's accessibility engine runs through the driver, under the page's real CSP.
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('Studio UI (Chromium)', () => {
  it('opens on the dashboard and edits a journey with live diagnostics, quick fixes and save', async () => {
    await page.goto(studio.url);
    // The first load parses the whole Studio bundle and asks the server for the project: seconds on a busy machine.
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain('token=');
    await expect.poll(() => page.getByRole('heading', { name: 'Dashboard' }).isVisible(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.locator('#dash-journeys').textContent(), { timeout: 15_000 }).toMatch(/3\s*Journeys/);
    await checkA11y(page, 'dashboard');

    await go('Journeys');
    await page.getByRole('treeitem', { name: /Sales rep signs in with MFA/ }).click();
    await expect.poll(editorText).toContain('Log in as sales-rep');
    await expect.poll(summary).toMatch(/Valid: Sales rep signs in with MFA, 2 steps/);
    await expect.poll(() => page.url()).toContain('#/journeys/journeys/login-mfa.ez');
    const original = await readFile(join(project, 'journeys/login-mfa.ez'), 'utf8');

    // A typo becomes an inline diagnostic with a line number, in the Problems panel and the status bar.
    await setEditor(original.replace('Open "/dashboard"', 'Opne /login'));
    await expect.poll(summary, { timeout: 8000 }).toMatch(/1 problem/);
    await expect.poll(() => page.locator('.cm-lintRange-error').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#status-problems').textContent()).toMatch(/1 problem/);
    await page.locator('#status-problems').click();
    const problem = page.locator('.problems .problem').first();
    await expect.poll(() => problem.textContent()).toMatch(/cannot understand.*Ln 7/);
    // Quick fix from the diagnostic tooltip.
    await page.locator('.cm-lintRange-error').first().hover();
    const fix = page.locator('.cm-diagnosticAction').first();
    await expect.poll(() => fix.isVisible()).toBe(true);
    const suggestion = /Use “(.+)”/.exec((await fix.textContent()) ?? '')?.[1];
    expect(suggestion).toMatch(/^Open /);
    await fix.click();
    await expect.poll(editorText).toContain(suggestion);
    await expect.poll(summary).toMatch(/Valid/);
    await expect.poll(() => page.locator('#status-problems').textContent()).toMatch(/No problems/);

    // Dirty indicator, then Ctrl+S saves.
    await setEditor(original);
    await page.keyboard.insertText('\n');
    await expect.poll(() => page.locator('.etab.active .dirty-dot').count()).toBe(1);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(original);
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.locator('.toast').last().textContent()).toMatch(/Saved journeys\/login-mfa\.ez/);
    expect(await readFile(join(project, 'journeys/login-mfa.ez'), 'utf8')).toBe(original);
    await expect.poll(() => page.locator('.etab.active .dirty-dot').count()).toBe(0);
    await checkA11y(page, 'journeys');
  });

  it('keeps unsaved edits when navigating to a line of the open file (outline, problems, deep links)', async () => {
    const original = await editorText();
    try {
      await page.locator('#editor-host .cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\nReload the page');
      await expect.poll(editorText).toMatch(/\nReload the page$/);
      await page.evaluate(() => { location.hash = '#/journeys/journeys/login-mfa.ez:2'; });
      // The page jumps to line 2 and then tidies the URL back to the file path, so check the cursor, not the URL.
      await expect.poll(() => page.locator('.cursor-info').textContent()).toMatch(/Ln 2$/);
      expect(await editorText()).toMatch(/\nReload the page$/);
      await expect.poll(() => page.locator('.etab.active .dirty-dot').count()).toBe(1);
    } finally {
      await setEditor(original + '\n');
      await page.keyboard.press('Control+s');
      await expect.poll(summary).toMatch(/Valid/);
    }
  });

  it('autocompletes phrasings and role names from the grammar and config', async () => {
    const original = await editorText();
    try {
    await page.locator('#editor-host .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Cli');
    const popup = page.locator('.cm-tooltip-autocomplete');
    await expect.poll(() => popup.textContent()).toContain('Click the "Sign in" button');
    await page.getByRole('option', { name: /Click the "Sign in" button/ }).click();
    await expect.poll(editorText).toMatch(/\nClick the "Sign in" button$/);
    // The quoted placeholder is selected, so typing replaces it.
    await page.keyboard.type('Save');
    await expect.poll(editorText).toMatch(/\nClick the "Save" button$/);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Log in as m');
    // CodeMirror ignores Enter for a short interaction delay after the popup (re)opens, so under load
    // a keyboard accept can become a newline; choose the option by clicking it instead.
    await expect.poll(() => popup.textContent()).toContain('manager');
    await popup.getByRole('option', { name: /manager/ }).first().click();
    await expect.poll(editorText).toMatch(/\nLog in as manager$/);
    } finally {
      await setEditor(original + '\n');
      await page.keyboard.press('Control+s');
      await expect.poll(summary).toMatch(/Valid/);
    }
  });

  it('round-trips the visual step view to the file text (reorder, duplicate, edit, add, keyboard move)', async () => {
    const original = await readFile(join(project, 'journeys/login-mfa.ez'), 'utf8');
    await page.getByRole('button', { name: 'Steps', exact: true }).click();
    const cards = page.locator('.vs-card');
    await expect.poll(() => cards.count()).toBe(2);
    expect(await cards.nth(0).textContent()).toMatch(/Log in as sales-rep.*login/);
    expect(await cards.nth(1).textContent()).toMatch(/Open "\/dashboard".*navigate.*the page to contain "Welcome, alice"/);
    await checkA11y(page, 'visual-steps');

    await page.getByRole('button', { name: 'Move step 2 up' }).click();
    await expect.poll(() => cards.nth(0).textContent()).toMatch(/Open "\/dashboard"/);
    await page.getByRole('button', { name: 'Duplicate step 2' }).click();
    await expect.poll(() => cards.count()).toBe(3);
    await page.getByRole('button', { name: 'Edit step 3' }).click();
    await page.getByLabel('Edit step 3').fill('Log in as manager');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => cards.nth(2).textContent()).toMatch(/Log in as manager/);
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('New step 4').fill('Reload the page');
    await page.getByRole('button', { name: 'Add expectation' }).click();
    await page.getByLabel('Expectation 1', { exact: true }).fill('the page contains "Welcome"');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => cards.count()).toBe(4);
    // A step the grammar does not understand is refused on its card with suggestions.
    await page.getByRole('button', { name: 'Edit step 4' }).click();
    await page.getByLabel('Edit step 4').fill('Relaod teh page');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => page.locator('.vs-edit-error').textContent()).toMatch(/Step 4/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    // Keyboard reorder: Alt+ArrowDown on the focused card.
    await cards.nth(0).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => cards.nth(1).textContent()).toMatch(/Open "\/dashboard"/);

    await page.getByRole('button', { name: 'Code', exact: true }).click();
    const text = await editorText();
    expect(text.split('\n').filter((l) => l && !l.includes(':')).map((l) => l.trim())).toEqual([
      'Log in as sales-rep',
      'Open "/dashboard"',
      'Expect the page to contain "Welcome, alice"',
      'Log in as manager',
      'Reload the page',
      'Expect the page contains "Welcome"',
    ]);
    expect(text.startsWith('Journey: Sales rep signs in with MFA\nTags: @smoke @identity')).toBe(true);
    await expect.poll(summary).toMatch(/Valid: .*4 steps/);
    // Undo the visual edits by restoring the file text.
    await setEditor(original.replace(/\n$/, ''));
    await page.keyboard.press('Control+s');
    await expect.poll(async () => readFile(join(project, 'journeys/login-mfa.ez'), 'utf8')).toBe(original.replace(/\n$/, ''));
  });

  it('drives everything from the command palette and toggles the theme', async () => {
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: /Search pages, journeys/ });
    const palette = page.getByRole('listbox', { name: 'Results' });
    await expect.poll(() => input.isVisible()).toBe(true);
    await input.fill('create order invoice');
    await expect.poll(() => palette.getByRole('option').first().textContent()).toMatch(/Create an order and verify the invoice/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toContain('create-order.ez');
    await expect.poll(editorText).toContain('Compare document invoice');
    expect(await page.locator('.etab').count()).toBe(2);

    // "@" jumps to a step of the open journey.
    await page.keyboard.press('Control+k');
    await input.fill('@submit');
    await expect.poll(() => palette.getByRole('option').first().textContent()).toMatch(/Click the "Submit order" button/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.outline-item.current').textContent()).toMatch(/Submit order/);

    // ">" commands: theme.
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.keyboard.press('Control+k');
    await input.fill('>theme');
    await expect.poll(() => palette.getByRole('option').first().textContent()).toMatch(/Toggle light \/ dark theme/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(before);
    await checkA11y(page, 'journeys-dark');
    await page.locator('#theme-toggle').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    // Pages from the palette, and the shortcuts overlay.
    await page.keyboard.press('Control+k');
    await input.fill('go to insights');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toContain('#/insights');
    await page.getByRole('heading', { name: 'Insights', level: 1 }).focus();
    await page.keyboard.press('?');
    await expect.poll(() => page.getByRole('dialog', { name: 'Keyboard shortcuts' }).isVisible()).toBe(true);
    expect(await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).textContent()).toMatch(/Command palette/);
    await page.keyboard.press('Escape');
  });

  it('runs a journey with a live step timeline and the readiness decision', async () => {
    await go('Run');
    await page.getByRole('checkbox', { name: /Sales rep signs in with MFA/ }).check();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('.jt-step').count(), { timeout: 60_000 }).toBe(2);
    await expect.poll(() => page.locator('#run-status').getAttribute('data-state'), { timeout: 120_000 }).toBe('complete');
    const statuses = await page.locator('.jt-step').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-status')));
    expect(statuses).toEqual(['passed', 'passed']);
    expect(await page.locator('#readiness').textContent()).toMatch(/GO/);
    expect(await page.getByRole('progressbar', { name: 'Run progress' }).getAttribute('aria-valuenow')).toBe('100');
    await checkA11y(page, 'run');
  });

  it('shows the run in Results with a screenshot gallery, lightbox and step deep links', async () => {
    await go('Results');
    await expect.poll(() => page.locator('#run-detail-title').isVisible()).toBe(true);
    expect(await page.locator('#run-detail').textContent()).toMatch(/Evidence verified/);
    expect(await page.getByRole('link', { name: 'Open the full HTML report' }).getAttribute('href')).toMatch(/\/runs\/run-.+\/report\.html$/);
    await checkA11y(page, 'results');
    await page.getByRole('tab', { name: /Screenshots/ }).click();
    const thumbs = page.locator('.gallery .thumb');
    await expect.poll(() => thumbs.count()).toBe(2);
    await expect.poll(() => thumbs.first().locator('img').evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await thumbs.first().click();
    const dialog = page.getByRole('dialog', { name: 'Screenshot' });
    await expect.poll(() => dialog.locator('.lightbox-img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await dialog.locator('.lightbox-caption').textContent()).toMatch(/Log in as sales-rep/);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => dialog.locator('.lightbox-caption').textContent()).toMatch(/Open "\/dashboard"/);
    await checkA11y(page, 'lightbox');
    await page.keyboard.press('Escape');

    // Deep link to a step of the run.
    const runId = (await page.locator('#run-detail-title').textContent())!.replace('Run ', '');
    const detail = await (await fetch(`${studio.origin}/api/runs/${runId}`, { headers: { 'x-eztest-token': studio.token } })).json();
    const j = detail.run.journeys[0];
    await page.goto(`${studio.origin}/#/runs/${runId}/${j.journeyId}/${j.steps[1].stepId}`);
    await expect.poll(() => page.locator('.tl-step.target').textContent()).toMatch(/Open "\/dashboard"/);
    expect(await page.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
  });

  it('cancels a run in progress from the Run page', async () => {
    await go('Run');
    await page.getByRole('checkbox', { name: /Sales rep signs in with MFA/ }).uncheck();
    await page.getByRole('checkbox', { name: /Create an order and verify/ }).check();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('.jt-step[data-status="passed"]').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#status-run').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect.poll(() => page.locator('#run-status').getAttribute('data-state'), { timeout: 60_000 }).toBe('cancelled');
    expect(await page.locator('.jt-step[data-status="skipped"]').count()).toBeGreaterThan(0);
    expect(await page.locator('#run-summary').textContent()).toMatch(/cancelled/);
    await expect.poll(() => page.locator('#status-run').isVisible()).toBe(false);
    await go('Results');
    await page.getByRole('combobox', { name: 'Filter by outcome' }).selectOption('cancelled');
    await expect.poll(() => page.getByRole('grid', { name: /Past runs/ }).getByRole('row').count()).toBe(2);
  });

  it('has no serious accessibility violations on the other views (light and dark)', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await go('Home');
      await expect.poll(() => page.locator('#dash-last').textContent()).toMatch(/run-/);
      await checkA11y(page, `home-${scheme}`);
      await go('Insights');
      await expect.poll(() => page.locator('#flaky').isVisible()).toBe(true);
      await checkA11y(page, `insights-${scheme}`);
      await go('Record');
      await checkA11y(page, `record-${scheme}`);
      await go('Import');
      await expect.poll(() => page.locator('.fs-list li').count()).toBeGreaterThan(0);
      await checkA11y(page, `import-${scheme}`);
      await go('Settings');
      await expect.poll(() => page.locator('#config-json').isVisible(), { timeout: 30_000 }).toBe(true);
      expect(await page.locator('#config-json').textContent()).not.toContain('Builder#2');
      await checkA11y(page, `settings-${scheme}`);
      await go('Run');
      await checkA11y(page, `run-${scheme}`);
      await go('Results');
      await expect.poll(() => page.locator('#run-detail-title').isVisible()).toBe(true);
      await checkA11y(page, `results-${scheme}`);
      // Ctrl+J toggles the bottom panel (it may already be open from the Problems check).
      if (await page.locator('.bottom-panel').isVisible()) await page.keyboard.press('Control+j');
      await expect.poll(() => page.locator('.bottom-panel').isVisible()).toBe(false);
      await page.keyboard.press('Control+j');
      await expect.poll(() => page.locator('.bottom-panel').isVisible()).toBe(true);
      await checkA11y(page, `panel-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);
  });

  it('is keyboard navigable with a visible focus indicator', async () => {
    await page.goto(studio.origin + '/index.html#/home');
    await expect.poll(() => page.getByRole('heading', { name: 'Dashboard' }).isVisible()).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Skip to content');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(outline).not.toBe('none');
    // Alt+2 opens Journeys; the explorer tree works with the arrow keys.
    await page.keyboard.press('Alt+2');
    await expect.poll(() => page.url()).toContain('#/journeys');
    await page.getByRole('treeitem', { name: /^journeys/ }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.etab').count()).toBeGreaterThan(0);
  });

  it('runs under the real CSP without violations or errors', async () => {
    const strict = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await strict.newPage();
    const problems: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/.test(m.text())) problems.push(m.text());
    });
    p.on('pageerror', (e) => problems.push(e.message));
    await p.goto(studio.url);
    await expect.poll(() => p.getByRole('heading', { name: 'Dashboard' }).isVisible()).toBe(true);
    for (const hash of ['#/journeys/journeys/create-order.ez:5', '#/run', '#/runs', '#/insights', '#/record', '#/import', '#/settings']) {
      await p.goto(`${studio.origin}/${hash}`);
      await p.waitForTimeout(600);
    }
    await p.goto(`${studio.origin}/#/journeys/journeys/create-order.ez:5`);
    await expect.poll(() => p.locator('.cm-editor .cm-gutters').isVisible()).toBe(true);
    // CodeMirror's own styles applied (they need the style nonce): the gutter sits beside the content.
    const layout = await p.evaluate(() => {
      const g = document.querySelector('.cm-gutters')!.getBoundingClientRect();
      const c = document.querySelector('.cm-content')!.getBoundingClientRect();
      return { gutterRight: g.right, contentLeft: c.left, sameRow: Math.abs(g.top - c.top) < 20 };
    });
    expect(layout.sameRow).toBe(true);
    expect(layout.contentLeft).toBeGreaterThanOrEqual(layout.gutterRight - 1);
    await strict.close();
    expect(problems).toEqual([]);
  });
});
