/** Record a real session on the demo app (headless Chromium), then replay it with the runner. */
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEzScript } from '../../src/intent/index.js';
import { diffJourneys, startRecording, verifyRecording, type RecordingResult } from '../../src/recorder/index.js';
import { DEMO_USERS, startDemoApp, type DemoServer } from '../../examples/demo-app/server.js';

const PASSWORD = DEMO_USERS.bob.password;

let server: DemoServer;
let result: RecordingResult;

beforeAll(async () => {
  server = await startDemoApp({ variant: 'a' });
  const recorder = await startRecording({ url: `${server.url}/login`, headless: true, name: 'Bob orders a gadget' });
  const page = recorder.page;
  // Typing key by key: must coalesce into one fill with the final value.
  await page.getByLabel('Username').pressSequentially('bobb');
  await page.getByLabel('Username').press('Backspace');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  // "New order" exists twice on the dashboard (nav + body): the recorder must disambiguate.
  await page.getByRole('navigation').getByRole('link', { name: 'New order' }).click();
  await page.waitForURL('**/orders/new');
  await page.getByLabel('Product').selectOption({ label: 'Gadget (49.50)' });
  await page.getByLabel('Quantity').fill('3');
  await page.getByRole('button', { name: 'Submit order' }).click();
  await page.waitForURL(/\/orders\/\d+/);
  // Alt+Click records an expectation instead of a click.
  await page.getByTestId('order-number').click({ modifiers: ['Alt'] });
  recorder.addExpectation('the page contains "created"');
  result = await recorder.stop();
});

afterAll(async () => {
  await server?.close();
});

describe('recording the demo app', () => {
  it('produces the expected plain-English lines', () => {
    const lines = result.ez.split('\n').map((l) => l.trimEnd());
    const body = lines.filter((l) => l && !l.startsWith('#') && !/^(Journey|Description|Tags):/.test(l));
    expect(body).toEqual([
      'Open /login',
      'Type "bob" into the Username field',
      'Type "${password}" into the Password field',
      'Click the "Sign in" button',
      '  Expect URL contains "/dashboard"',
      'Click the "New order" link inside the "Main" navigation',
      '  Expect URL contains "/orders/new"',
      'Select "Gadget (49.50)" from the Product dropdown',
      'Type "3" into the Quantity field',
      'Click the "Submit order" button',
      '  Expect URL contains "/orders/1"',
      '  Expect testid=order-number contains "ORD-1"',
      '  Expect page contains "created"',
    ]);
    expect(result.ez).toContain('Journey: Bob orders a gadget');
    expect(result.ez).toMatch(/# Variables to supply at run time.*password/);
    expect(result.variables).toEqual(['password']);
  });

  it('names the repeated link by its navigation, without a CSS warning, and keeps measured locator candidates', () => {
    expect(result.warnings.some((w) => /CSS selector/.test(w))).toBe(false);
    const submit = result.journey.steps.find((s) => s.intent === 'Click the "Submit order" button')!;
    expect(result.targets[submit.id]?.[0]).toEqual({ strategy: 'role', value: 'button', name: 'Submit order', exact: true });
    expect(submit.target?.fingerprint).toMatchObject({ tag: 'button', id: 'submit-order', role: 'button', name: 'Submit order' });
  });

  it('parses back to an equivalent journey', () => {
    const back = parseEzScript(result.ez);
    expect(diffJourneys(result.journey, back)).toEqual([]);
  });

  it('never stores the password anywhere', async () => {
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result.ez).not.toContain(PASSWORD);
  });

  it('replays green against a fresh app with the password supplied as a variable', async () => {
    const fresh = await startDemoApp({ variant: 'a' });
    try {
      const out = await mkdtemp(join(tmpdir(), 'eztest-rec-'));
      await expect(verifyRecording(result, { baseUrl: fresh.url, outputDir: out })).rejects.toThrow(/password/);
      const report = await verifyRecording(result, {
        baseUrl: fresh.url, outputDir: out, headless: true, variables: { password: PASSWORD }, screenshots: 'off',
      });
      expect(report.failed).toEqual([]);
      expect(report.passed).toBe(true);
      expect(report.steps.map((s) => s.status)).toEqual(result.journey.steps.map(() => 'passed'));
      // The secret supplied at run time does not leak into the run record either.
      const runJson = await readFile(join(out, report.run.runId, 'run.json'), 'utf8');
      expect(runJson).not.toContain(PASSWORD);
    } finally {
      await fresh.close();
    }
  });

  it('reports recorded steps that fail on replay instead of dropping them', async () => {
    const broken = await startDemoApp({ variant: 'b' });
    try {
      const out = await mkdtemp(join(tmpdir(), 'eztest-rec-'));
      const report = await verifyRecording(result, {
        baseUrl: broken.url, outputDir: out, variables: { password: PASSWORD }, screenshots: 'off',
        stepTimeoutMs: 1500, locateTimeoutMs: 800, conditionTimeoutMs: 800,
      });
      expect(report.passed).toBe(false);
      expect(report.steps).toHaveLength(result.journey.steps.length);
      expect(report.failed.length).toBeGreaterThan(0);
      expect(report.failed[0].status).toBe('failed');
      expect(report.failed[0].error).toBeTruthy();
      expect(report.failed.slice(1).every((s) => s.status === 'skipped' || s.status === 'blocked' || s.status === 'failed')).toBe(true);
      expect((await readdir(out)).length).toBeGreaterThan(0);
      expect((await stat(join(out, report.run.runId))).isDirectory()).toBe(true);
    } finally {
      await broken.close();
    }
  });
});
