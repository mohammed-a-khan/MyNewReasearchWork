/**
 * Test management and Coverage in a real Chromium driven by EZTest's own
 * browser driver, against the EZ Shop demo app:
 * - a manual case authored in the Studio case editor (steps, expected
 *   results, requirement, assignee) and saved as .ez;
 * - a guided manual run: pass with an uploaded screenshot, fail with notes
 *   and a pasted screenshot; the result is a normal run (hash-chained
 *   evidence, readiness, traceability);
 * - a hybrid journey that pauses at a manual step (with a screenshot of the
 *   live page) and resumes the automation after the verdict;
 * - cycles: assignment, the dashboard's "my assignments", progress;
 * - converting the case through the grammar; Quality › Coverage with the
 *   heat overlay in a sandboxed iframe; accessibility checks in light and dark.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../support/testkit.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '../../src/browser/index.js';
import { startDemoApp, DEMO_TOTP_SECRET, type DemoServer } from '../../examples/demo-app/server.js';
import { startStudio, type StudioHandle } from '../../src/studio/index.js';
import { verifyEvidence, type RunResult } from '../../src/core/index.js';
import { readEvidenceManifest } from '../../src/insights/index.js';
import { solidPng } from '../insights/fixtures.js';
import { client, copyShopProject, SHOP_ENV_KEYS } from './helpers.js';
import { expectNoSeriousA11y } from '../a11y/assert.js';


let app: DemoServer;
let studio: StudioHandle;
let project: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let c: ReturnType<typeof client>;
const pageErrors: string[] = [];
const saved: Record<string, string | undefined> = {};
let manualRunId = '';
const CASE_ID = 'refund-a-cancelled-order';
const ON_FIREFOX = process.env.EZTEST_BROWSER === 'firefox';

const checkA11y = (p: Page, label: string) => expectNoSeriousA11y(p, label);

const view = () => page.locator('.page:not([hidden]) .section-page:not([hidden])');

async function go(hash: string, heading: string | RegExp): Promise<void> {
  await page.goto(`${studio.origin}/${hash}`);
  await expect.poll(() => page.getByRole('heading', { name: heading, level: 1 }).isVisible(), { timeout: 20_000 }).toBe(true);
}

async function waitRunDone(id: string, timeout = 180_000): Promise<RunResult> {
  const t0 = Date.now();
  for (;;) {
    const s = (await c.get(`/api/manual/session/${id}`)).json() as { state: string };
    if (s.state === 'done' || s.state === 'cancelled' || s.state === 'error') break;
    if (Date.now() - t0 > timeout) throw new Error(`run ${id} still ${s.state}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return JSON.parse(await readFile(join(project, 'eztest-results', id, 'run.json'), 'utf8')) as RunResult;
}

/** Answer the one-time "Who is testing?" prompt if it appears. */
async function testerPrompt(name = 'Quinn Tester'): Promise<void> {
  const d = page.getByRole('dialog', { name: 'Who is testing?' });
  await expect.poll(() => d.isVisible().catch(() => false), { timeout: 5000 }).toBe(true).catch(() => undefined);
  if (await d.isVisible().catch(() => false)) {
    await d.getByLabel('Your name').fill(name);
    await d.getByRole('button', { name: 'Continue' }).click();
  }
}

beforeAll(async () => {
  project = await copyShopProject();
  app = await startDemoApp({ dbFile: join(project, 'shop.db') });
  const env: Record<string, string> = {
    SHOP_URL: app.url, SHOP_DB: join(project, 'shop.db'), SHOP_ALICE_PASSWORD: 'Wonderland#1', SHOP_ALICE_TOTP: DEMO_TOTP_SECRET, SHOP_BOB_PASSWORD: 'Builder#2', SHOP_API_CLIENT_SECRET: 'ez-client-secret',
  };
  for (const k of SHOP_ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  await writeFile(join(project, 'readiness-policy.yaml'), 'version: 1\ngates:\n  noFailedCriticalJourneys: { minRisk: 4 }\n  manualVerified: true\n');
  await writeFile(join(project, 'journeys', 'hybrid-cancel.ez'), [
    'Journey: Cancel an order after a manual check', 'Tags: @hybrid', 'Requirements: ORD-9', '', 'Log in as manager', 'Go to /orders/new', 'Click the "Submit order" button',
    '  Expect the page to contain "created"', 'Manual: Check the new order shows the right customer and total', '  Expected: Customer and total match the order you placed',
    '  Expect the page to contain "Order"', 'Click the "Cancel order" button', '  Expect the page to contain "cancelled"', '',
  ].join('\n'));
  studio = await startStudio({ cwd: project, recordHeadless: true, env: process.env });
  c = client(studio.port, studio.token);
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(studio.url);
});

/** End whatever run a test left open (a failed test must not block the next one with "a run is in progress"). */
afterEach(async () => {
  const cur = studio?.app.runs.current;
  if (!cur) return;
  studio.app.manual.end(cur.id);
  if (studio.app.runs.current?.state === 'running') studio.app.runs.cancel(cur.id);
  for (let i = 0; i < 300 && studio.app.runs.current; i++) await new Promise((r) => setTimeout(r, 100));
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

describe('Test management (Chromium, EZTest driver)', () => {
  it('authors a manual case in the case editor and saves it as .ez', async () => {
    await go('#/manual/cases', 'Manual and hybrid cases');
    expect(await view().textContent()).toMatch(/Cancel an order after a manual check/);
    await checkA11y(page, 'cases-list');
    await view().getByRole('button', { name: 'New case' }).click();
    await expect.poll(() => page.getByRole('heading', { name: 'New manual case', level: 1 }).isVisible()).toBe(true);
    const v = view();
    await v.getByLabel('Name').fill('Refund a cancelled order');
    await v.getByLabel('Assignee').fill('Quinn Tester');
    await v.getByLabel('Requirements').fill('ORD-9');
    await v.getByLabel('Risk').selectOption('4');
    await v.getByLabel('Preconditions').fill('A cancelled order exists');
    await v.getByLabel('Step 1: what the tester does').fill('Open the cancelled order in the back office');
    await v.getByLabel('Step 1: expected results, one per line').fill('The status is Cancelled');
    await v.getByRole('button', { name: 'Add manual step' }).click();
    await v.getByLabel('Step 2: what the tester does').fill('Press Refund and confirm');
    await v.getByLabel('Step 2: expected results, one per line').fill('A refund line appears\nThe customer gets an e-mail');
    await v.getByRole('button', { name: 'Preview .ez' }).click();
    await expect.poll(() => v.locator('#case-preview').textContent()).toContain('Manual: Press Refund and confirm');
    await checkA11y(page, 'case-editor');
    await v.getByRole('button', { name: 'Save case' }).click();
    await expect.poll(() => page.locator('.toast').last().textContent()).toMatch(/Created journeys\/manual\/refund-a-cancelled-order\.ez/);
    const ez = await readFile(join(project, 'journeys', 'manual', `${CASE_ID}.ez`), 'utf8');
    expect(ez).toBe([
      'Journey: Refund a cancelled order', 'Type: manual', 'Requirements: ORD-9', 'Risk: 4', 'Assignee: Quinn Tester', 'Preconditions: A cancelled order exists', '',
      'Manual: Open the cancelled order in the back office', '  Expected: The status is Cancelled', 'Manual: Press Refund and confirm', '  Expected: A refund line appears', '  Expected: The customer gets an e-mail', '',
    ].join('\n'));
    await expect.poll(() => page.getByRole('heading', { name: 'Edit case', level: 1 }).isVisible()).toBe(true);
  });

  it('runs the case guided: pass with an uploaded screenshot, fail with notes and a pasted screenshot; the result is a normal run', async () => {
    await view().getByRole('button', { name: 'Run this case' }).click();
    await testerPrompt();
    await expect.poll(() => page.url(), { timeout: 20_000 }).toMatch(/#\/manual\/run\/run-/);
    manualRunId = decodeURIComponent(/#\/manual\/run\/([^/?]+)/.exec(page.url())![1]);
    const cur = page.locator('#manual-current');
    await expect.poll(() => cur.isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await page.locator('#manual-instruction').textContent()).toBe('Open the cancelled order in the back office');
    expect(await page.locator('#manual-expected').textContent()).toContain('The status is Cancelled');
    expect(await cur.textContent()).toContain('Preconditions: A cancelled order exists');
    await checkA11y(page, 'runner');
    // Pass, with a screenshot uploaded through the file input.
    await page.getByRole('radio', { name: 'Pass' }).check();
    await page.getByLabel('Screenshots and files').setInputFiles({ name: 'order.png', mimeType: 'image/png', buffer: solidPng(8, 8, [0, 120, 0]) });
    await expect.poll(() => page.locator('#verdict-attachments img').count()).toBe(1);
    await page.getByRole('button', { name: 'Record verdict' }).click();
    await expect.poll(() => page.locator('#manual-instruction').textContent(), { timeout: 20_000 }).toBe('Press Refund and confirm');
    // Fail without notes is refused; with notes and a pasted screenshot it is recorded.
    await page.getByRole('radio', { name: 'Fail' }).check();
    await page.getByRole('button', { name: 'Record verdict' }).click();
    await expect.poll(() => page.locator('#verdict-error').textContent()).toMatch(/needs notes/);
    await page.getByLabel('What you observed').fill('The Refund button is disabled');
    await page.getByLabel('Notes').fill('Blocked by the payment provider sandbox');
    const png = solidPng(6, 6, [200, 0, 0]).toString('base64');
    // A paste event carrying the screenshot. Firefox hands script-created paste events an empty copy of
    // their clipboard data (real pastes carry the files), so there the same file is dropped on the zone.
    await page.locator('#verdict-paste').evaluate((el, a) => {
      const bytes = Uint8Array.from(atob(a.b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      el.dispatchEvent(a.drop ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }) : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { b64: png, drop: ON_FIREFOX });
    await expect.poll(() => page.locator('#verdict-attachments img').count()).toBe(1);
    await page.getByRole('button', { name: 'Record verdict' }).click();
    await expect.poll(() => page.locator('#manual-done').isVisible(), { timeout: 60_000 }).toBe(true);
    expect(await page.locator('#manual-finished').textContent()).toMatch(/1 journeys: 0 passed, 1 failed/);
    await checkA11y(page, 'runner-done');

    const run = await waitRunDone(manualRunId);
    const j = run.journeys.find((x) => x.journeyId === CASE_ID)!;
    expect(j.status).toBe('failed');
    expect(j.manual).toEqual({ type: 'manual', executed: 2, pending: 0, testers: ['Quinn Tester'], assignee: 'Quinn Tester' });
    expect(j.steps.map((s) => [s.manual?.verdict, s.manual?.attachments.length])).toEqual([['passed', 1], ['failed', 1]]);
    expect(j.steps[1].manual).toMatchObject({ actual: 'The Refund button is disabled', notes: 'Blocked by the payment provider sandbox' });
    const dir = join(project, 'eztest-results', manualRunId);
    expect((await verifyEvidence(dir)).ok).toBe(true);
    const ev = await readEvidenceManifest(dir);
    expect(ev.filter((e) => e.kind === 'screenshot' && e.journeyId === CASE_ID).map((e) => e.description)).toEqual(['tester attachment: order.png', 'tester attachment: pasted.png']);
    // Readiness and traceability see the manual result like an automated one.
    const ready = (await c.get(`/api/quality/readiness?run=${manualRunId}`)).json() as { result: { decision: string; gates: Array<{ gate: string; status: string }> } };
    expect(ready.result.gates.find((g) => g.gate === 'manualVerified')!.status).toBe('pass');
    expect(ready.result.gates.find((g) => g.gate === 'noFailedCriticalJourneys')!.status).toBe('fail');
    expect(ready.result.decision).toBe('NO_GO');
    const trace = (await c.get('/api/quality/traceability')).json() as { rows: Array<{ requirement: { id: string }; journeys: Array<{ journeyId: string; status: string; runId?: string }> }> };
    const ord9 = trace.rows.find((r) => r.requirement.id === 'ORD-9')!;
    expect(ord9.journeys.find((x) => x.journeyId === CASE_ID)).toMatchObject({ status: 'failed', runId: manualRunId });
    // The case list shows the latest result.
    await go('#/manual/cases', 'Manual and hybrid cases');
    await expect.poll(() => view().locator(`tr[data-id="${CASE_ID}"]`).textContent()).toMatch(/Failed.*Quinn Tester/);
  }, 240_000);

  it('a hybrid journey pauses at the manual step with a screenshot of the live page and resumes the automation', async () => {
    const started = await c.post('/api/manual/run', { journeys: ['cancel-an-order-after-a-manual-check'], tester: 'Quinn Tester', timeTravel: true });
    expect(started.status, started.body).toBe(202);
    const r = started.json() as { id: string };
    await go(`#/manual/run/${r.id}`, 'Guided run');
    const shot = page.locator('#manual-pause-shot');
    await expect.poll(() => shot.isVisible(), { timeout: 90_000 }).toBe(true);
    expect(await page.locator('#manual-instruction').textContent()).toBe('Check the new order shows the right customer and total');
    expect(await page.locator('#manual-current').textContent()).toMatch(/The automation paused on .*\/orders\/\d+/);
    expect(await page.locator('#manual-current').textContent()).toContain('Checked automatically after your verdict');
    expect(await shot.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
    // While paused, the automation waits: the step after the manual one has not run.
    const before = (await c.get(`/api/manual/session/${r.id}`)).json() as { status: Record<string, Record<string, string>>; pending: unknown[] };
    expect(before.pending).toHaveLength(1);
    expect(before.status['cancel-an-order-after-a-manual-check']?.['click-the-cancel-order-button']).toBeUndefined();
    await page.getByRole('radio', { name: 'Pass' }).check();
    await page.getByRole('button', { name: 'Record verdict' }).click();
    await expect.poll(() => page.locator('#manual-done').isVisible(), { timeout: 90_000 }).toBe(true);
    const run = await waitRunDone(r.id);
    const j = run.journeys[0];
    expect(j.status).toBe('passed');
    expect(j.manual).toMatchObject({ type: 'hybrid', executed: 1, pending: 0 });
    const manualStep = j.steps.find((s) => s.manual)!;
    expect(manualStep.manual).toMatchObject({ verdict: 'passed', tester: 'Quinn Tester', pageScreenshot: expect.stringMatching(/^E-\d+$/) });
    expect(manualStep.conditions).toEqual([expect.objectContaining({ passed: true })]);
    const after = j.steps.slice(j.steps.indexOf(manualStep) + 1);
    expect(after.map((s) => [s.intent, s.status])).toEqual([['Click the "Cancel order" button', 'passed']]);
    expect((await verifyEvidence(join(project, 'eztest-results', r.id))).ok).toBe(true);
  }, 240_000);

  it('plans a cycle with assignments; the dashboard shows progress and my assignments', async () => {
    const plans = {
      version: 1,
      suites: [{ id: 'orders', name: 'Orders', cases: [CASE_ID, 'cancel-an-order-after-a-manual-check'], tags: [] }],
      cycles: [{ id: 'r26', name: 'Release 26.10', suites: ['orders'], assignments: { 'cancel-an-order-after-a-manual-check': 'Ravi' }, state: 'active', runs: [manualRunId], due: '2026-10-31' }],
    };
    expect((await c.put('/api/manual/plans', { plans })).status).toBe(400);
    expect((await c.put('/api/manual/plans', { plans: { ...plans, cycles: [{ ...plans.cycles[0], suites: ['nope'] }] }, confirm: true })).status).toBe(422);
    const saved = await c.put('/api/manual/plans', { plans, confirm: true });
    expect(saved.status, saved.body).toBe(200);
    expect(JSON.parse(await readFile(join(project, 'test-plans.json'), 'utf8')).cycles[0].id).toBe('r26');
    await page.evaluate(() => localStorage.setItem('eztest.manual.tester', 'Quinn Tester'));
    await go('#/manual/dashboard', 'Test management dashboard');
    const mine = view().locator('#my-assignments');
    await expect.poll(() => mine.textContent(), { timeout: 20_000 }).toMatch(/Refund a cancelled order.*Release 26\.10.*Failed/);
    const cyc = view().locator('#dash-cycle-r26');
    expect(await cyc.textContent()).toMatch(/Failed 1/);
    expect(await cyc.textContent()).toMatch(/Untested 1/);
    expect(await cyc.locator('[role="img"]').first().getAttribute('aria-label')).toMatch(/1 failed, 1 untested/);
    await checkA11y(page, 'dashboard');
    await go('#/manual/cycles', 'Suites and test cycles');
    await expect.poll(() => view().locator('#cycle-r26').textContent()).toMatch(/Run my open cases/);
    // Reassign the hybrid case to Quinn from the cycle table.
    const assign = view().getByLabel('Assign Cancel an order after a manual check to');
    await assign.fill('Quinn Tester');
    await assign.press('Tab');
    await expect.poll(async () => JSON.parse(await readFile(join(project, 'test-plans.json'), 'utf8')).cycles[0].assignments['cancel-an-order-after-a-manual-check']).toBe('Quinn Tester');
    await checkA11y(page, 'cycles');
    const progress = (await c.get('/api/manual/plans')).json() as { progress: Array<{ counts: Record<string, number>; byAssignee: Array<{ assignee: string; total: number }> }> };
    expect(progress.progress[0].byAssignee).toEqual([expect.objectContaining({ assignee: 'Quinn Tester', total: 2 })]);
  });

  it('converts the manual case through the grammar (what it cannot read stays manual)', async () => {
    await go(`#/manual/automate/journeys/manual/${CASE_ID}.ez`, 'Automate: Refund a cancelled order');
    await view().getByRole('button', { name: 'Convert with the grammar' }).click();
    await expect.poll(() => view().locator('#automate-summary').textContent()).toMatch(/0 steps automated, 2 steps kept manual/);
    expect(await view().locator('#automate-ez').textContent()).toContain('Manual: Press Refund and confirm');
    await checkA11y(page, 'automate');
  });

  it('converts a manual case with the recorder: lines recorded per step replace it; unrecorded steps stay manual', async () => {
    await writeFile(join(project, 'journeys', 'manual', 'start-an-order.ez'), [
      'Journey: Start an order by hand', 'Type: manual', '', 'Manual: Sign in as bob', '  Expected: the URL contains "/dashboard"', 'Manual: Open the new order form', 'Manual: Phone the customer to confirm', '',
    ].join('\n'));
    await go('#/manual/automate/journeys/manual/start-an-order.ez', 'Automate: Start an order by hand');
    await view().getByLabel('Start URL').fill(`${app.url}/login`);
    await view().getByRole('button', { name: 'Start recording' }).click();
    await expect.poll(() => (studio.app.recorder as unknown as { recorder?: { page: Page } }).recorder?.page !== undefined, { timeout: 30_000 }).toBe(true);
    const rp = (studio.app.recorder as unknown as { recorder: { page: Page } }).recorder.page;
    await expect.poll(() => view().locator('#automate-steps li.is-current').count()).toBe(1);
    await rp.getByLabel('Username').fill('bob');
    await rp.getByLabel('Password').fill('Builder#2');
    await rp.getByRole('button', { name: 'Sign in' }).click();
    await rp.waitForURL('**/dashboard');
    await expect.poll(() => view().locator('#automate-steps li').first().textContent(), { timeout: 20_000 }).toContain('Click the "Sign in" button');
    await view().getByRole('button', { name: 'Next step' }).click();
    await rp.getByRole('navigation').getByRole('link', { name: 'New order' }).click();
    await rp.waitForURL('**/orders/new');
    await expect.poll(() => view().locator('#automate-steps li').nth(1).textContent(), { timeout: 20_000 }).toMatch(/Click /);
    await view().getByRole('button', { name: 'Stop and convert' }).click();
    await expect.poll(() => view().locator('#automate-summary').textContent(), { timeout: 30_000 }).toMatch(/2 steps automated, 1 step kept manual/);
    const ez = (await view().locator('#automate-ez').textContent())!;
    expect(ez).toContain('# Manual: Sign in as bob');
    expect(ez).toContain('Click the "Sign in" button');
    expect(ez).toContain('  Expect the URL contains "/dashboard"');
    expect(ez).toContain('Manual: Phone the customer to confirm');
    expect(ez).toContain('Type: hybrid');
    await view().getByRole('button', { name: 'Replace the case with this journey' }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Replace' }).click();
    await expect.poll(async () => readFile(join(project, 'journeys', 'manual', 'start-an-order.ez'), 'utf8'), { timeout: 15_000 }).toContain('Type: hybrid');
    // Writing opens the journey in the editor.
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('#/journeys/');
    // Leave the editor with a fresh load (the editor keeps its file open across hash changes).
    await page.goto(studio.url);
  }, 120_000);

  it('Quality › Coverage: dimensions, the UI map with a heat overlay in a sandboxed iframe, and the trend', async () => {
    await go('#/quality/coverage', 'Coverage');
    await expect.poll(() => page.locator('#coverage-pages').isVisible(), { timeout: 60_000 }).toBe(true);
    expect(await page.locator('#coverage-dimensions').textContent()).toMatch(/UI elements.*Requirements.*Manual verification/);
    const row = page.locator('#coverage-pages tr[data-route="/orders/:id"]');
    await row.getByRole('button').click();
    const frame = page.locator('#coverage-overlay');
    await expect.poll(() => frame.getAttribute('src')).toContain('route=%2Forders%2F%3Aid');
    expect(await frame.getAttribute('sandbox')).toBe('');
    const res = await c.get('/api/quality/coverage/overlay?route=%2Forders%2F%3Aid');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-security-policy'])).toMatch(/^sandbox; default-src 'none'/);
    expect(res.body).toContain('data-ez-coverage');
    expect(res.body).toMatch(/outline:3px solid #(?:22c55e|15803d|166534)/);
    expect(res.body).not.toContain('<script');
    const els = page.locator('#coverage-elements');
    await expect.poll(() => els.isVisible()).toBe(true);
    await checkA11y(page, 'coverage');
    const csv = await c.get('/api/quality/coverage/export.csv');
    expect(csv.body.split('\n')[0]).toBe('page,role,element,count,tested,interactions,assertions,journeys');
    expect(csv.body).toMatch(/\/orders\/:id,button,Cancel order,1,yes/);
  }, 120_000);

  it('has no serious accessibility violations in dark mode either, and no page errors', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const [hash, title] of [['#/manual/dashboard', 'Test management dashboard'], ['#/manual/cases', 'Manual and hybrid cases'], [`#/manual/run/${manualRunId}`, 'Guided run'], ['#/manual/cycles', 'Suites and test cycles'], ['#/quality/coverage', 'Coverage']] as const) {
      await go(hash, title);
      if (hash === '#/quality/coverage') await expect.poll(() => page.locator('#coverage-pages').isVisible(), { timeout: 60_000 }).toBe(true);
      await checkA11y(page, `${hash}-dark`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    expect(pageErrors).toEqual([]);
  }, 120_000);
});
