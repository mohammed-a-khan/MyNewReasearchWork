/**
 * The Source Control page in a real Chromium on a real git checkout: word
 * diff, stage, commit, blame by step, the conflict indicator and hunk
 * resolver, the status bar item; the accessibility engine in light and dark; and no CSP
 * violations under the real policy.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { git } from '../../src/git/index.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { copyShopProject } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';


let project: string;
let studio: StudioHandle;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
const g = (args: string[]) => git(args, { cwd: project });

const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

const scm = () => page.locator('.page:not([hidden])');

beforeAll(async () => {
  project = await copyShopProject();
  await g(['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.name', 'Ada Author'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) await g(['config', k, v]);
  await writeFile(join(project, '.gitignore'), 'eztest-results/\n.eztest/\n');
  await g(['add', '-A']);
  await g(['commit', '-q', '-m', 'Shop project']);
  const f = join(project, 'journeys', 'login-mfa.ez');
  await writeFile(f, (await readFile(f, 'utf8')).replace('Log in as sales-rep', 'Log in as manager'));
  studio = await startStudio({ cwd: project, env: { SHOP_URL: 'http://127.0.0.1:9' } });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
});

afterAll(async () => {
  await browser?.close();
  await studio?.close();
});

describe('Source Control page (Chromium)', () => {
  it('shows changes with a word-level diff, stages and commits, and blames lines to steps', async () => {
    await page.getByRole('navigation', { name: 'Studio sections' }).getByRole('link', { name: 'Source Control', exact: true }).click();
    await expect.poll(() => page.getByRole('heading', { name: 'Source Control', level: 1 }).isVisible()).toBe(true);
    await expect.poll(() => page.locator('#scm-branch-line').textContent()).toMatch(/On main at [0-9a-f]{8}, no upstream yet/);
    await expect.poll(() => page.locator('#status-scm').textContent()).toMatch(/1 change\(s\)/);
    const changes = scm().getByRole('list', { name: 'Changes: Journeys' });
    await expect.poll(() => changes.getByRole('button', { name: /^journeys\/login-mfa\.ez/ }).isVisible()).toBe(true);
    await checkA11y(page, 'scm-changes-light');

    await changes.getByRole('button', { name: /^journeys\/login-mfa\.ez/ }).click();
    await expect.poll(() => page.url()).toContain('#/scm/journeys/login-mfa.ez');
    const diff = scm().getByRole('region', { name: 'Word-level changes to journeys/login-mfa.ez' });
    await expect.poll(() => diff.locator('del').first().textContent()).toBe('sales-rep');
    expect(await diff.locator('ins').first().textContent()).toBe('manager');
    await checkA11y(page, 'scm-diff-light');

    await scm().getByRole('button', { name: 'Stage journeys/login-mfa.ez' }).click();
    await expect.poll(() => scm().getByRole('list', { name: 'Staged: Journeys' }).isVisible()).toBe(true);
    await scm().getByLabel('Commit message').fill('Log in as manager');
    await page.locator('#scm-commit').click();
    await expect.poll(() => page.locator('#scm-clean').isVisible(), { timeout: 30_000 }).toBe(true);
    expect((await g(['log', '-1', '--format=%s %an'])).stdout.trim()).toBe('Log in as manager Ada Author');

    await page.goto(`${studio.origin}/#/scm/journeys/login-mfa.ez`);
    await scm().getByRole('tab', { name: 'Blame' }).click();
    const row = scm().getByRole('row', { name: /log-in-as-manager/ });
    await expect.poll(() => row.textContent()).toMatch(/Ada Author/);
    await scm().getByRole('tab', { name: 'History' }).click();
    await expect.poll(() => scm().getByRole('table', { name: 'History of journeys/login-mfa.ez' }).textContent()).toMatch(/Log in as manager.*Shop project/s);
  });

  it('flags a merge conflict and resolves it hunk by hunk into a valid journey', async () => {
    const f = join(project, 'journeys', 'login-mfa.ez');
    await g(['checkout', '-q', '-b', 'other']);
    await writeFile(f, (await readFile(f, 'utf8')).replace('Log in as manager', 'Log in as admin'));
    await g(['commit', '-q', '-am', 'admin']);
    await g(['checkout', '-q', 'main']);
    await writeFile(f, (await readFile(f, 'utf8')).replace('Log in as manager', 'Log in as auditor'));
    await g(['commit', '-q', '-am', 'auditor']);
    await g(['merge', '--no-edit', 'other']).catch(() => undefined);
    await page.goto(`${studio.origin}/#/scm`);
    await scm().getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => page.locator('#scm-conflict-banner').textContent()).toMatch(/A merge is in progress. 1 file\(s\) have conflicts/);
    await expect.poll(() => page.locator('#status-scm').textContent()).toMatch(/1 conflict\(s\)/);
    await scm().getByRole('list', { name: 'Conflicts: Journeys' }).getByRole('button', { name: /^journeys\/login-mfa\.ez/ }).click();
    await expect.poll(() => scm().getByRole('tab', { name: 'Resolve' }).getAttribute('aria-selected')).toBe('true');
    const hunk = scm().getByRole('group', { name: /Conflict 1 at line/ });
    await expect.poll(() => hunk.textContent()).toMatch(/Log in as auditor.*Log in as admin/s);
    await checkA11y(page, 'scm-resolve-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await checkA11y(page, 'scm-resolve-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await hunk.getByRole('radio', { name: 'Edit' }).check();
    await hunk.getByRole('textbox').fill('Lgo ni as admin');
    await expect.poll(() => page.locator('#scm-resolve-check').textContent()).toMatch(/Not valid yet/);
    expect(await page.locator('#scm-resolve-save').isDisabled()).toBe(true);
    await hunk.getByRole('radio', { name: 'Keep theirs' }).check();
    await expect.poll(() => page.locator('#scm-resolve-check').textContent()).toMatch(/Valid journey/);
    await page.locator('#scm-resolve-save').click();
    await expect.poll(() => page.locator('#scm-conflict-banner').count(), { timeout: 30_000 }).toBe(1); // merge still in progress until committed
    await expect.poll(() => page.locator('#scm-conflict-banner').textContent(), { timeout: 30_000 }).not.toMatch(/conflicts/);
    expect(await readFile(f, 'utf8')).toContain('Log in as admin');
    await scm().getByLabel('Commit message').fill('Merge other');
    await page.locator('#scm-commit').click();
    await expect.poll(() => page.locator('#scm-clean').isVisible(), { timeout: 30_000 }).toBe(true);
    expect((await g(['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('has no serious accessibility violations in dark mode and no CSP violations under the real policy', async () => {
    const f = join(project, 'journeys', 'login-mfa.ez');
    await writeFile(f, (await readFile(f, 'utf8')) + '\n# a note\n');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${studio.origin}/#/scm/journeys/login-mfa.ez`);
    await page.reload();
    await expect.poll(() => scm().getByRole('region', { name: /Word-level changes/ }).isVisible(), { timeout: 30_000 }).toBe(true);
    await checkA11y(page, 'scm-diff-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);

    const strict = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await strict.newPage();
    const problems: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/.test(m.text())) problems.push(m.text());
    });
    p.on('pageerror', (e) => problems.push(e.message));
    await p.goto(studio.url);
    await p.goto(`${studio.origin}/#/scm/journeys/login-mfa.ez`);
    await expect.poll(() => p.getByRole('region', { name: /Word-level changes/ }).isVisible(), { timeout: 15_000 }).toBe(true);
    await strict.close();
    expect(problems).toEqual([]);
  });
});
