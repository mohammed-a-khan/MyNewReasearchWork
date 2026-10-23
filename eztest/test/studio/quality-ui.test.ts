/**
 * The Quality Center in a real Chromium against real runs of the demo app:
 * a heal produced by the renamed UI (variant b) is accepted in the inbox, the
 * journey file changes and the next run passes without healing; triage
 * reclassification; quarantine makes `eztest run` ignore a failing journey;
 * readiness sign-off lands in the evidence vault (unsigned, then ed25519
 * signed); traceability exports; the accessibility engine in light and dark; strict CSP.
 */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer, type DemoOptions } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { buildProgram } from '../../src/cli/index.js';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';
import { canonicalJson, generateSigningKey } from '../../src/evidence-pack/manifest.js';
import { client, copyShopProject, readSse, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';

const ORDER = 'create-an-order-and-verify-the-invoice-three-ways';
const SUBMIT = 'click-the-submit-order-button';

let app: DemoServer;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let c: ReturnType<typeof client>;
const pageErrors: string[] = [];
const saved: Record<string, string | undefined> = {};

const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

async function restartApp(opts: DemoOptions): Promise<void> {
  await app.close();
  app = await startDemoApp({ ...opts, dbFile: join(project, 'shop.db') });
  process.env.SHOP_URL = app.url;
}

async function runViaApi(body: Record<string, unknown>): Promise<RunResult> {
  const r = await c.post('/api/runs', body);
  expect(r.status, r.body).toBe(202);
  const { id } = r.json();
  await readSse(studio.port, `/api/runs/${id}/events`, studio.token, (e) => e.type === 'done', 180_000);
  return JSON.parse(await readFile(join(project, 'eztest-results', id, 'run.json'), 'utf8')) as RunResult;
}

async function cli(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const before = process.exitCode;
  process.exitCode = 0;
  await buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s), cwd: project, env: process.env }).exitOverride().parseAsync(['node', 'eztest', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = before;
  return { out, err, exitCode };
}

async function go(hash: string, heading: string): Promise<void> {
  await page.goto(`${studio.origin}/${hash}`);
  await expect.poll(() => page.getByRole('heading', { name: heading, level: 1 }).isVisible(), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.locator('.page:not([hidden]) .q-body').getAttribute('aria-busy'), { timeout: 30_000 }).toBeNull();
}

/** Answer the one-time "Who is reviewing?" prompt if it appears. */
async function reviewerPrompt(name = 'Quinn QA'): Promise<void> {
  const d = page.getByRole('dialog', { name: 'Who is reviewing?' });
  if (await d.isVisible().catch(() => false)) {
    await d.getByLabel('Your name').fill(name);
    await d.getByRole('button', { name: 'Continue' }).click();
  }
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
  studio = await startStudio({ cwd: project, recordHeadless: true, env: process.env });
  c = client(studio.port, studio.token);
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // The tokenized URL sets the session cookie; later navigations use plain hashes.
  await page.goto(studio.url);
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

describe('Quality Center (Chromium, real runs of the demo app)', () => {
  it('shows empty states before any run, and the Quality nav group', async () => {
    await go('#/quality/heals', 'Heal review');
    expect(await page.locator('.q-heal-list').textContent()).toMatch(/No heals to review/);
    const nav = page.getByRole('navigation', { name: 'Studio sections' });
    for (const name of ['Heal review', 'Triage', 'Flaky', 'Readiness', 'Traceability', 'Compare', 'Trends']) {
      await expect.poll(() => nav.getByRole('link', { name, exact: true }).isVisible()).toBe(true);
    }
    await go('#/quality/triage', 'Triage board');
    expect(await page.locator('.page:not([hidden]) .q-body').textContent()).toMatch(/No runs yet/);
    await go('#/quality/compare', 'Run compare');
    expect(await page.locator('.page:not([hidden]) .q-body').textContent()).toMatch(/Not enough runs/);
    await checkA11y(page, 'empty-compare');
  });

  it('accepts a verified heal (variant b) in the inbox: diff, file rewrite, fingerprint store, and the next run passes without healing', async () => {
    expect((await runViaApi({ tags: ['orders'] })).journeys[0].status).toBe('passed');
    await restartApp({ variant: 'b' });
    const healed = await runViaApi({ tags: ['orders'] });
    expect(healed.journeys[0].status).toBe('passed-healed');
    const healedStep = healed.journeys[0].steps.find((s) => s.stepId === SUBMIT)!;
    expect(healedStep.status).toBe('passed-healed');

    await go('#/quality/heals', 'Heal review');
    const card = page.locator('.q-heal', { hasText: 'Click the "Submit order" button' });
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.textContent()).toMatch(/role=button\[name="Place order"\]/);
    expect(await card.textContent()).toMatch(/page contains "created"/);
    expect(await card.locator('.q-shot img').count()).toBeGreaterThan(0);
    await checkA11y(page, 'heals');

    // Keyboard: focus the card, "a" opens the accept flow.
    await card.focus();
    await page.keyboard.press('a');
    await reviewerPrompt();
    const dialog = page.getByRole('dialog', { name: 'Accept 1 heal' });
    await expect.poll(() => dialog.isVisible(), { timeout: 15_000 }).toBe(true);
    expect(await dialog.locator('.q-diff').textContent()).toContain(`Click the "Place order" button [id=${SUBMIT}]`);
    expect(await dialog.textContent()).toMatch(/Rewrite the \.ez target phrase/);
    await checkA11y(page, 'accept-dialog');
    await dialog.getByRole('button', { name: 'Write 1 file' }).click();
    await expect.poll(() => page.locator('.toast').last().textContent()).toMatch(/Accepted 1 heal; wrote journeys\/create-order\.ez/);

    const text = await readFile(join(project, 'journeys', 'create-order.ez'), 'utf8');
    expect(text).toContain(`Click the "Place order" button [id=${SUBMIT}]`);
    expect(text).not.toContain('Submit order');
    const decisions = JSON.parse(await readFile(join(project, '.eztest', 'heal-decisions.json'), 'utf8'));
    expect(decisions.decisions[0]).toMatchObject({ journeyId: ORDER, stepId: SUBMIT, decision: 'accepted', reviewer: 'Quinn QA', rewrite: 'ez-phrase' });
    const fp = JSON.parse(await readFile(join(project, '.eztest', 'fingerprints.json'), 'utf8')).steps[`${ORDER}/${SUBMIT}`];
    expect(fp.healed).toBeUndefined();
    expect(fp.lastGood).toEqual({ strategy: 'role', value: 'button', name: 'Place order', exact: true });

    const next = await runViaApi({ tags: ['orders'] });
    expect(next.journeys[0].status).toBe('passed');
    expect(next.journeys[0].steps.some((s) => s.heal)).toBe(false);
    expect(next.journeys[0].steps.find((s) => s.stepId === SUBMIT)!.usedLocator).toEqual({ strategy: 'role', value: 'button', name: 'Place order', exact: true });
    // The accepted heal leaves the "to review" list.
    await go('#/quality/heals', 'Heal review');
    expect(await page.locator('.q-heal-list').textContent()).toMatch(/Nothing matches these filters|No heals to review/);
    await page.locator('.page:not([hidden])').getByLabel('Show', { exact: true }).selectOption('accepted');
    await expect.poll(() => page.locator('.q-heal.is-accepted').count()).toBe(1);
  });

  it('reclassifies a triaged failure with a reason, persisted and inherited by later runs', async () => {
    await restartApp({ variant: 'b', bug: 'invoice-total' });
    const failed = await runViaApi({ tags: ['orders'] });
    expect(failed.journeys[0].status).toBe('failed');
    await go(`#/quality/triage/${failed.runId}`, 'Triage board');
    const card = page.locator('.q-tcard').first();
    await expect.poll(() => card.isVisible()).toBe(true);
    const before = await card.evaluate((el) => el.closest('.q-col')!.className);
    expect(await card.locator('.q-cites a').count()).toBeGreaterThan(0);
    await checkA11y(page, 'triage');
    await card.getByRole('button', { name: 'Reclassify…' }).click();
    await reviewerPrompt();
    const d = page.getByRole('dialog', { name: 'Reclassify failure' });
    await d.getByLabel('Classification').selectOption('environment');
    await d.getByLabel('Reason (required)').fill('staging invoice service was redeployed during the run');
    await d.getByRole('button', { name: 'Reclassify' }).click();
    await expect.poll(() => page.locator('.q-col-environment .q-tcard').count()).toBe(1);
    expect(before).not.toContain('q-col-environment');
    expect(await page.locator('.q-col-environment .q-tcard').textContent()).toMatch(/reclassified by Quinn QA/);
    const overrides = JSON.parse(await readFile(join(project, '.eztest', 'triage-overrides.json'), 'utf8'));
    expect(overrides.overrides[0]).toMatchObject({ runId: failed.runId, journeyId: ORDER, to: 'environment', by: 'Quinn QA' });

    // Copy as Markdown (clipboard permission granted for this check).
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.q-col-environment .q-tcard').getByRole('button', { name: 'Copy as Markdown' }).click();
    const md = await page.evaluate(() => navigator.clipboard.readText());
    expect(md).toMatch(/^### Environment: /);
    expect(md).toContain(`**Run:** ${failed.runId}`);

    // ADO is not configured: the bug button explains the setup instead of failing.
    await page.locator('.q-col-environment .q-tcard').getByRole('button', { name: /File bug in ADO/ }).click();
    const hint = page.getByRole('dialog', { name: 'Azure DevOps is not configured' });
    await expect.poll(() => hint.isVisible()).toBe(true);
    expect(await hint.textContent()).toMatch(/ado\.organizationUrl, ado\.project, ado\.pat/);
    await hint.getByRole('button', { name: 'Close' }).first().click();

    // Same failure again: the classification is inherited from the earlier review; trends see it.
    const again = await runViaApi({ tags: ['orders'] });
    const board = (await c.get(`/api/quality/triage?run=${again.runId}`)).json();
    expect(board.cards[0]).toMatchObject({ category: 'environment', override: { inherited: true, by: 'Quinn QA' } });
    const trends = (await c.get('/api/quality/trends')).json();
    expect(trends.points.at(-1).failures.environment).toBe(1);
  });

  it('quarantines a failing journey: `eztest run` exit code ignores it, readiness does not count it, un-quarantine restores it', async () => {
    await go('#/quality/flaky', 'Flaky tests and quarantine');
    await checkA11y(page, 'flaky');
    const row = page.locator(`#flaky-table tr[data-journey="${ORDER}"]`);
    await row.getByRole('button', { name: /^Quarantine / }).click();
    await reviewerPrompt();
    const d = page.getByRole('dialog', { name: /^Quarantine Create an order/ });
    await d.getByLabel('Reason (required)').fill('invoice service flaky on staging');
    await d.getByLabel('Owner (required)').fill('Olivia Owner');
    const expiry = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await d.getByLabel('Expires (required)').fill(expiry);
    await d.getByRole('button', { name: 'Quarantine', exact: true }).click();
    await expect.poll(() => page.locator('#quarantined').textContent()).toMatch(/Olivia Owner/);
    const q = JSON.parse(await readFile(join(project, '.eztest', 'quarantine.json'), 'utf8'));
    expect(q.entries[0]).toMatchObject({ journeyId: ORDER, owner: 'Olivia Owner', expires: expiry });

    // The journey still runs and still fails, but the run exits 0.
    const r = await cli(['run', '--tags', 'orders']);
    expect(r.out.join('\n')).toMatch(/=> failed/);
    expect(r.out.join('\n')).toMatch(new RegExp(`quarantined \\(not failing the run\\): ${ORDER} failed`));
    expect(r.exitCode).toBe(0);
    const latest = (await c.get('/api/quality/readiness')).json();
    expect(latest.result.quarantineIgnored).toEqual([ORDER]);

    // Un-quarantine: the same failure fails the run again.
    await go('#/quality/flaky', 'Flaky tests and quarantine');
    await page.locator(`#flaky-table tr[data-journey="${ORDER}"]`).getByRole('button', { name: /^Un-quarantine/ }).click();
    await page.getByRole('dialog', { name: /^Un-quarantine/ }).getByRole('button', { name: 'Un-quarantine' }).click();
    await expect.poll(() => page.locator('#quarantined').textContent()).toMatch(/Nothing is quarantined/);
    expect((await cli(['run', '--tags', 'orders', '--no-analyze'])).exitCode).toBe(1);
  });

  it('records a readiness sign-off in the evidence vault: hashed and unsigned without a key, ed25519-signed with one', async () => {
    await restartApp({ variant: 'b' });
    const ok = await runViaApi({});
    await go(`#/quality/readiness/${ok.runId}`, 'Release readiness');
    await expect.poll(() => page.locator('#readiness-decision').textContent()).toMatch(/GO/);
    expect(await page.locator('#gates-table').textContent()).toMatch(/Minimum pass rate/);
    await checkA11y(page, 'readiness');
    await page.getByLabel('Approver (required)').fill('Rhea Release');
    await page.getByLabel('Comment (required)').fill('Approved for 2.4');
    await page.getByRole('button', { name: 'Sign off…' }).click();
    const d = page.getByRole('dialog', { name: 'Sign off this run' });
    expect(await d.textContent()).toMatch(/hashed but unsigned/);
    await d.getByRole('button', { name: 'Sign off' }).click();
    await expect.poll(() => page.locator('#signoff').textContent(), { timeout: 15_000 }).toMatch(/Rhea Release/);
    const runDir = join(project, 'eztest-results', ok.runId);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    const manifest = (await readFile(join(runDir, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const entry = manifest.at(-1);
    expect(entry.path).toMatch(/^signoffs\/signoff-.*\.json$/);
    const note = JSON.parse(await readFile(join(runDir, entry.path), 'utf8'));
    expect(note).toMatchObject({ type: 'eztest.readiness-signoff', approver: 'Rhea Release', comment: 'Approved for 2.4', runId: ok.runId });
    expect(note.unsigned).toMatch(/not signed/);

    // With the evidence-pack key configured, the note is ed25519-signed and verifiable.
    const key = generateSigningKey();
    await writeFile(join(project, 'eztest-signing.key.pem'), key.privateKeyPem, { mode: 0o600 });
    const r = await c.post('/api/quality/readiness/signoff', { runId: ok.runId, approver: 'Rhea Release', comment: 'Re-signed with key', confirm: true });
    expect(r.status, r.body).toBe(200);
    const signed = r.json().note;
    const { signature, digest: _d, ...body } = signed;
    expect(verify(null, Buffer.from(canonicalJson(body)), createPublicKey(key.publicKeyPem), Buffer.from(signature.value, 'base64'))).toBe(true);
    expect((await verifyEvidence(runDir)).ok).toBe(true);
    // Sign-off needs confirmation, a name and a comment.
    expect((await c.post('/api/quality/readiness/signoff', { runId: ok.runId, approver: 'x', comment: 'y' })).status).toBe(400);
    expect((await c.post('/api/quality/readiness/signoff', { runId: ok.runId, approver: ' ', comment: 'y', confirm: true })).status).toBe(400);
  });

  it('exports the traceability matrix (CSV, XLSX, HTML) and shows gaps from an uploaded requirements list', async () => {
    await go('#/quality/traceability', 'Requirements traceability');
    await expect.poll(() => page.locator('#trace-table').textContent()).toMatch(/AUTH-1/);
    await page.locator('#req-file').setInputFiles({ name: 'reqs.csv', mimeType: 'text/csv', buffer: Buffer.from('id,title\nAUTH-1,Sign in with MFA\nORD-1,Create orders\nORD-7,Invoice\nPAY-9,Refunds\n') });
    const d = page.getByRole('dialog', { name: /Use reqs\.csv/ });
    await d.getByRole('button', { name: 'Save list' }).click();
    await expect.poll(() => page.locator('tr[data-req="PAY-9"]').getAttribute('data-coverage')).toBe('uncovered');
    expect(await page.locator('tr[data-req="AUTH-1"]').getAttribute('data-coverage')).toBe('covered-passing');
    await checkA11y(page, 'traceability');

    const grab = async (fmt: string) => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(`#trace-export-${fmt}`).click()]);
      expect(dl.suggestedFilename()).toMatch(new RegExp(`^traceability-\\d{4}-\\d{2}-\\d{2}\\.${fmt}$`));
      return readFile((await dl.path())!);
    };
    const csv = (await grab('csv')).toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('Requirement,Title,Coverage,Journey,Journey name,Latest status,Quarantined,Run,Gap');
    expect(csv).toMatch(/PAY-9,Refunds,uncovered,/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await grab('xlsx')) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Traceability')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Requirement');
    const ids = ws.getColumn(1).values.slice(2);
    expect(ids).toContain('PAY-9');
    expect(wb.getWorksheet('Summary')!.getCell('A1').value).toBe('Requirements');
    const html = (await grab('html')).toString('utf8');
    expect(html).toMatch(/<title>Requirements traceability<\/title>/);
    expect(html).toContain('PAY-9');
    expect(html).not.toMatch(/<script/i);
  });

  it('compares runs and shows trends; run details link into the Quality Center; the dashboard has a Quality card', async () => {
    await go('#/quality/compare', 'Run compare');
    await expect.poll(() => page.locator('#compare-counts').isVisible()).toBe(true);
    await checkA11y(page, 'compare');
    await go('#/quality/trends', 'Trends and analytics');
    await expect.poll(() => page.locator('#trend-rates svg').count()).toBe(1);
    expect(await page.locator('#trend-rates svg').getAttribute('aria-label')).toMatch(/Pass rate: latest/);
    // Keyboard on the chart: focus + ArrowLeft shows a tooltip.
    await page.locator('#trend-rates svg').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => page.locator('#trend-rates .q-tip').isVisible()).toBe(true);
    await checkA11y(page, 'trends');

    const runs = (await c.get('/api/runs')).json().runs;
    await page.goto(`${studio.origin}/#/runs/${runs[0].runId}`);
    await page.getByRole('tab', { name: /Quality/ }).click();
    await expect.poll(() => page.locator('.q-links').textContent()).toMatch(/Triage board/);
    await page.goto(`${studio.origin}/#/home`);
    await expect.poll(() => page.locator('#dash-quality').textContent(), { timeout: 15_000 }).toMatch(/Heals to review/);
    // Palette command.
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: /Search pages, journeys/ }).fill('>review heals');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toContain('#/quality/heals');
  });

  it('has no serious accessibility violations on every Quality page, light and dark', async () => {
    const pages: Array<[string, string]> = [
      ['#/quality/heals', 'Heal review'],
      ['#/quality/triage', 'Triage board'],
      ['#/quality/flaky', 'Flaky tests and quarantine'],
      ['#/quality/readiness', 'Release readiness'],
      ['#/quality/traceability', 'Requirements traceability'],
      ['#/quality/compare', 'Run compare'],
      ['#/quality/trends', 'Trends and analytics'],
    ];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [hash, title] of pages) {
        await go(hash, title);
        if (hash === '#/quality/heals') await page.locator('.page:not([hidden])').getByLabel('Show', { exact: true }).selectOption('all');
        await checkA11y(page, `${hash}-${scheme}`);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);
  }, 240_000);

  it('runs under the real CSP without violations', async () => {
    const strict = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await strict.newPage();
    const problems: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || /Content Security Policy/.test(m.text())) problems.push(m.text());
    });
    p.on('pageerror', (e) => problems.push(e.message));
    await p.goto(studio.url);
    await expect.poll(() => p.getByRole('heading', { name: 'Dashboard' }).isVisible()).toBe(true);
    for (const hash of ['heals', 'triage', 'flaky', 'readiness', 'traceability', 'compare', 'trends']) {
      await p.goto(`${studio.origin}/#/quality/${hash}`);
      // Wait on state: the page's body has loaded (not busy) and holds content.
      const body = p.locator('.page:not([hidden]) .q-body');
      await expect.poll(async () => (await body.count()) === 1 && (await body.getAttribute('aria-busy')) === null && ((await body.textContent()) ?? '').length > 0, { timeout: 30_000 }).toBe(true);
    }
    await strict.close();
    expect(problems).toEqual([]);
  });
});
