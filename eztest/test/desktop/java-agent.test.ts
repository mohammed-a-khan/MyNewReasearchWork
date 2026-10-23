/**
 * Java Swing apps for real: EZTest's own -javaagent (agents/java, built here
 * with javac) runs inside a sample Swing app under Xvfb, and plain-English
 * journeys drive it through the ez-agent/1 protocol. Skipped only when there
 * is no JDK or no X display/Xvfb.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { AgentClient, createDesktopIntegration, ensureJavaAgentJar, launchJavaApp } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { ensureDisplay, type Display } from './xvfb.js';

const hasJdk = spawnSync('javac', ['-version']).status === 0;
const display: Display | undefined = hasJdk ? await ensureDisplay() : undefined;
let classes = '';
let agentJar = '';
let work = '';

beforeAll(async () => {
  if (!hasJdk || !display) return;
  work = await mkdtemp(join(tmpdir(), 'eztest-java-'));
  classes = join(work, 'app');
  execFileSync('javac', ['-d', classes, resolve('agents/java/sample/InvoiceApp.java')], { stdio: 'ignore' });
  agentJar = await ensureJavaAgentJar({ cacheDir: join(work, 'agents') });
}, 120_000);
afterAll(() => display?.stop());

const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

function integration(variant?: string) {
  return createDesktopIntegration({
    desktop: {
      java: {
        agentJar,
        apps: { invoices: { command: ['java', ...(variant ? [`-Dsample.variant=${variant}`] : []), '-cp', classes, 'InvoiceApp'], env: { DISPLAY: display!.display } } },
      },
    },
  }).interceptor;
}

async function runEz(ez: string, opts: Partial<RunOptions> & { variant?: string } = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-java-run-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 15_000, conditionTimeoutMs: 4000, stepInterceptors: [integration(opts.variant)], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

const JOURNEY = `Journey: Create an invoice in the Swing app
Launch the Java app "invoices"
  Expect the screen to contain "Invoice Manager"
Type "ACME Corp" into the "Customer" field
Type "120.50" into the "Amount" field
Select "EUR" from the "Currency" dropdown
Check the "Paid" checkbox
Click the "Save" button
  Expect the screen to contain "Saved invoice 1 for ACME Corp"
Expect cell row 1 column "Status" of the "invoiceTable" grid to be "Paid"
Read cell row 1 column "Amount" of the "invoiceTable" grid as amount
Choose "File > New Invoice" from the menu
  Expect the screen to contain "New invoice"
Type "7" into the "Amount" field
Press Enter in the "Amount" field
  Expect the screen to contain "Amount entered: 7"
Read the "statusLabel" as status
Close the desktop app
`;

(hasJdk && display ? describe : describe.skip)('Java Swing agent (real JVM under Xvfb)', () => {
  it('serves ez-agent/1 from inside the app: windows, elements with labels and control types, screenshots', async () => {
    const app = await launchJavaApp(['java', '-cp', classes, 'InvoiceApp'], { agentJar, env: { DISPLAY: display!.display } });
    try {
      const c: AgentClient = app.client;
      expect((await c.hello()).agent).toBe('java');
      const [w] = await c.windows();
      expect(w.title).toBe('Invoice Manager');
      const { elements } = await c.elements(w.id);
      const customer = elements.find((e) => e.automationId === 'customerField')!;
      expect(customer).toMatchObject({ controlType: 'Edit', labeledBy: 'Customer:', framework: 'Swing', enabled: true, visible: true });
      expect(elements.find((e) => e.automationId === 'saveBtn')).toMatchObject({ controlType: 'Button', name: 'Save' });
      expect(elements.find((e) => e.name === 'New Invoice')).toMatchObject({ controlType: 'MenuItem', visible: false });
      const png = await c.screenshot(w.id);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      // A wrong token is refused.
      await expect(new AgentClient({ url: c.options.url, token: 'nope' }).hello()).rejects.toThrow(/token/);
    } finally {
      await app.stop();
    }
  });

  it('runs a plain-English journey: fields by label, combo, checkbox, button, table cell, menu path, keys', async () => {
    const { j, run: r, outputDir } = await runEz(JOURNEY);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.amount).toBe('120.50 EUR');
    expect(j.ledger.status).toBe('Amount entered: 7');
    const click = j.steps.find((s) => s.intent === 'Click the "Save" button')!;
    expect(click.surface).toMatchObject({ driver: 'java', rung: 'object' });
    expect(click.surface?.via).toContain('Button "Save" in window "Invoice Manager"');
    // Evidence: window screenshot (PNG) and UI tree (XML) after the click.
    const manifest = (await readFile(join(outputDir, r.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const ev = manifest.filter((e) => click.evidence.includes(e.id));
    expect(ev.map((e) => e.kind).sort()).toEqual(['aria', 'screenshot']);
    const xml = await readFile(join(outputDir, r.runId, ev.find((e) => e.kind === 'aria')!.path), 'utf8');
    expect(xml).toContain('<Button Name="Save" AutomationId="saveBtn"');
  });

  it('heals a renamed button from its fingerprint and verifies it with the post-condition', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-java-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    const ez = `Journey: Save an invoice
Launch the Java app "invoices"
Type "Initech" into the "Customer" field
Click the "Save" button
  Expect the screen to contain "Saved invoice 1 for Initech"
Close the desktop app
`;
    const first = await runEz(ez, { outputDir, fingerprintStore });
    expect(first.j.status, describeSteps(first.j)).toBe('passed');
    const second = await runEz(ez, { outputDir, fingerprintStore, variant: 'renamed' });
    expect(second.j.status, describeSteps(second.j)).toBe('passed-healed');
    const healed = second.j.steps[2];
    expect(healed.heal).toMatchObject({ tier: 'T1-fingerprint', verified: true, healed: { strategy: 'testId', value: 'saveBtn' } });
    expect(healed.heal?.reason).toMatch(/Button "Store invoice" matches the recorded fingerprint/);
  });

  it('fails clearly on ambiguous and missing elements', async () => {
    const { j } = await runEz(`Journey: Missing
Launch the Java app "invoices"
Click the "Delete" button
Close the desktop app
`);
    expect(j.steps[1].status).toBe('failed');
    expect(j.steps[1].error?.message).toMatch(/"Delete" button was not found in window "Invoice Manager"/);
  });
});
