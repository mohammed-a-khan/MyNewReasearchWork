/**
 * Windows desktop journeys through the TypeScript side of EZTest's Windows
 * agent, against a simulator of the agent's API (ez-agent/1). MOCKED: the C#
 * agent itself (agents/windows) needs Windows UI Automation and is only
 * compiled here, not run.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { AgentClient, createDesktopIntegration, parseAgentKeys } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { WindowsAgentSim } from './fixtures/windows-agent-sim.js';

let sim: WindowsAgentSim;
beforeEach(async () => {
  sim = new WindowsAgentSim();
  await sim.start();
});
afterEach(() => sim.stop());

const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

function interceptor(s = sim) {
  return createDesktopIntegration(
    { desktop: { windows: { url: s.url, token: 'secret://env/AGENT_TOKEN', apps: { invoice: { app: 'C:\\Apps\\Invoice.exe' } } } } },
    { resolveSecret: async () => s.token },
  ).interceptor;
}

async function runEz(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-win-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 5000, conditionTimeoutMs: 1500, stepInterceptors: [interceptor()], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

describe('Windows agent client (simulated agent)', () => {
  it('types, saves through the File menu and the Save As dialog, and checks the result (G06 acceptance, simulated)', async () => {
    const { j, run, outputDir } = await runEz(`Journey: Save an invoice
Launch the desktop app "invoice"
  Expect the screen to contain "Invoice - Untitled"
Type "Contoso" into the "Customer" field
Type "120" into the "Amount" field
Check the "Urgent" checkbox
Click the "Save" button
  Expect the screen to contain "Saved invoice for Contoso"
Choose "File > Save As..." from the menu
Expect the "Save As" window to be open
Choose "C:\\data\\inv-1.inv" in the file dialog
  Expect the screen to contain "Saved to C:\\data\\inv-1.inv"
Expect the "Save As" window not to be open
Expect cell row 1 column "Qty" of the "Lines" grid to be "2"
Set cell row 1 column "Qty" of the "Lines" grid to "5"
Read cell row 1 column "Qty" of the "Lines" grid as qty
Expand "Customers > Europe" in the "Accounts" tree
Press Ctrl+S
  Expect the screen to contain "Saved (Ctrl+S)"
Read the "Customer" field as customer
Close the desktop app
`);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(sim.saved).toEqual(['C:\\data\\inv-1.inv']);
    expect(j.ledger).toMatchObject({ qty: '5', customer: 'Contoso' });
    expect(sim.treeExpanded).toEqual(['expand:Customers>Europe']);
    expect(sim.els.find((e) => e.id === 'urgent')).toBeUndefined(); // window closed at the end
    // The client sent the token, and the agent saw UIA-level operations only.
    const methods = new Set(sim.calls.map((c) => c.method));
    expect([...methods]).toEqual(expect.arrayContaining(['hello', 'launch', 'elements', 'setValue', 'toggle', 'invoke', 'expand', 'keys', 'cell', 'treePath', 'screenshot', 'closeWindow']));
    const type = j.steps.find((s) => s.intent.startsWith('Type "Contoso"'))!;
    expect(type.surface).toMatchObject({ driver: 'windows', rung: 'object' });
    expect(type.usedLocator).toEqual({ strategy: 'role', value: 'Edit', name: 'Customer' });
    // UI tree XML evidence after a click (UIA-style element names and AutomationIds).
    const click = j.steps.find((s) => s.intent === 'Click the "Save" button')!;
    const manifest = (await readFile(join(outputDir, run.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const xml = manifest.find((e) => click.evidence.includes(e.id) && e.kind === 'aria')!;
    expect(await readFile(join(outputDir, run.runId, xml.path), 'utf8')).toContain('<Button Name="Save" AutomationId="btnSave"');
  });

  it('finds by AutomationId, scopes to a named window and fails on ambiguity', async () => {
    const { j } = await runEz(`Journey: Locators
Launch the desktop app "invoice"
Type "9" into #txtAmount
Click the "Save" button in the "Invoice - Untitled" window
Click the "Customer:"
`);
    expect(j.steps[1].status, describeSteps(j)).toBe('passed');
    expect(j.steps[1].usedLocator).toEqual({ strategy: 'testId', value: 'txtAmount' });
    expect(j.steps[2].status).toBe('passed');
    expect(j.steps[3].status).toBe('failed');
    expect(j.steps[3].error?.message).toMatch(/matches 2 elements/);
  });

  it('heals a renamed button by fingerprint, verified by the post-condition', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-win-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    const ez = `Journey: Save
Launch the desktop app "invoice"
Type "Fabrikam" into the "Customer" field
Click the "Save" button
  Expect the screen to contain "Saved invoice for Fabrikam"
`;
    expect((await runEz(ez, { outputDir, fingerprintStore })).j.status).toBe('passed');
    const renamed = new WindowsAgentSim('renamed');
    await renamed.start();
    try {
      const { j } = await runEz(ez, { outputDir, fingerprintStore, stepInterceptors: [interceptor(renamed)] });
      expect(j.status, describeSteps(j)).toBe('passed-healed');
      expect(j.steps[2].heal).toMatchObject({ tier: 'T1-fingerprint', verified: true, healed: { strategy: 'testId', value: 'btnSave' } });
    } finally {
      await renamed.stop();
    }
  });

  it('reports agent errors and refuses a wrong token', async () => {
    const { j } = await runEz(`Journey: Missing app
Launch the desktop app "C:\\Apps\\Missing.exe"
`);
    expect(j.steps[0].error?.message).toMatch(/could not start Windows app .*not found/);
    await expect(new AgentClient({ url: sim.url, token: 'wrong' }).hello()).rejects.toThrow(/refused the token/);
    expect(parseAgentKeys('Ctrl+Shift+S')).toEqual(['CTRL', 'SHIFT', 'S']);
    expect(parseAgentKeys('Alt+F4')).toEqual(['ALT', 'F4']);
    expect(parseAgentKeys('Hyper+Q')).toBeUndefined();
  });
});
