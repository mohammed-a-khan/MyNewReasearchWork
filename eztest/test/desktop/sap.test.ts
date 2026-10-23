/**
 * SAP GUI journeys through EZTest's SAP bridge protocol, against a simulator
 * of the bridge (MOCKED: no SAP system here). The PowerShell bridge itself is
 * parsed and, when the PowerShell image is available locally, its HTTP layer
 * (hello, token check) is exercised for real; its COM calls are not.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { AgentClient, createDesktopIntegration, sapVKey } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';
import { SapBridgeSim } from './fixtures/sap-bridge-sim.js';

let sim: SapBridgeSim;
beforeEach(async () => {
  sim = new SapBridgeSim();
  await sim.start();
});
afterEach(() => sim.stop());

const describeSteps = (j: JourneyResult) => flattenStepResults(j.steps).map(({ result: s }) => `${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');
const secrets: Record<string, string> = { 'secret://env/SAP_PW': 'S3cret!', 'secret://env/SAP_BRIDGE': 'sap-token' };

function interceptor(s = sim) {
  return createDesktopIntegration(
    { desktop: { sap: { bridge: s.url, token: 'secret://env/SAP_BRIDGE', systems: { ERP: { connection: 'ERP Development', client: '100', user: 'TESTER', password: 'secret://env/SAP_PW', language: 'EN' } } } } },
    { resolveSecret: async (r) => secrets[r] ?? '' },
  ).interceptor;
}

async function runEz(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-sap-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 5000, conditionTimeoutMs: 1500, stepInterceptors: [interceptor()], ...opts });
  return { run: r, j: r.journeys[0] };
}

const VA01 = `Journey: Create a standard order in VA01
Connect to SAP "ERP"
Log on to SAP
  Expect the screen to contain "SAP Easy Access"
Run transaction "VA01"
Set SAP field "Order Type" to "OR"
Type "1000" into the "Sales Organization" field
Press Enter
  Expect the screen to contain "Create Standard Order: Overview"
Set SAP field "Sold-To Party" to "1000"
Type "PO-77" into the "Cust. Reference" field
Set cell row 1 column "Material" of SAP table "All Items" to "M-01"
Set cell row 1 column "Order Quantity" of SAP table "All Items" to "2"
Press SAP button "Save"
Expect the SAP status bar to be a success message
Capture the number from the SAP status bar as orderNumber
Expect the SAP status bar to contain "has been saved"
`;

describe('SAP GUI scripting (simulated bridge)', () => {
  it('creates a VA01 order and captures the order number from the status bar (G09 acceptance, simulated)', async () => {
    const { j } = await runEz(VA01);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.orderNumber).toBe('12345');
    expect(sim.orders).toEqual(['12345']);
    expect(sim.user).toBe('TESTER');
    const set = j.steps.find((s) => s.intent.startsWith('Set SAP field "Sold-To Party"'))!;
    expect(set.surface?.via).toContain('ctxtKUAGV-KUNNR');
  });

  it('reports the status bar error when the order cannot be saved', async () => {
    const { j } = await runEz(VA01.replace('Set SAP field "Sold-To Party" to "1000"\n', ''));
    const st = j.steps.find((s) => s.intent.includes('success message'))!;
    expect(st.status).toBe('failed');
    expect(st.error?.message).toMatch(/type "E" \("Enter a sold-to party"\), expected "S"/);
  });

  it('heals a relabelled field by its technical-name fingerprint (verified by the value it holds)', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-sap-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    expect((await runEz(VA01, { outputDir, fingerprintStore })).j.status).toBe('passed');
    const relabelled = new SapBridgeSim('relabelled');
    await relabelled.start();
    try {
      const { j } = await runEz(VA01, { outputDir, fingerprintStore, stepInterceptors: [interceptor(relabelled)] });
      expect(j.status, describeSteps(j)).toBe('passed-healed');
      const healed = j.steps.find((s) => s.status === 'passed-healed')!;
      expect(healed.heal?.reason).toMatch(/labelled "Customer"/);
    } finally {
      await relabelled.stop();
    }
  });

  it('maps keys to SAP virtual keys and refuses a wrong bridge token', async () => {
    expect([sapVKey('Enter'), sapVKey('F3'), sapVKey('Shift+F1'), sapVKey('Ctrl+S'), sapVKey('Ctrl+F12'), sapVKey('Alt+Q')]).toEqual([0, 3, 13, 11, 36, undefined]);
    await expect(new AgentClient({ url: sim.url, token: 'x' }).hello()).rejects.toThrow(/refused the token/);
    const { j } = await runEz(`Journey: Bad system
Connect to SAP "PRD"
`);
    expect(j.steps[0].error?.message).toMatch(/SAP Logon has no connection "PRD"/);
  });
});

// The real PowerShell bridge: parse it, and run its HTTP layer when the PowerShell image is present locally.
const hasPwshImage = spawnSync('docker', ['image', 'inspect', 'mcr.microsoft.com/powershell:latest'], { stdio: 'ignore' }).status === 0;
(hasPwshImage ? describe : describe.skip)('agents/sap/ez-sap-bridge.ps1 (real PowerShell in Docker, no SAP GUI)', () => {
  it('serves hello with the token and refuses requests without it', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const dir = resolve('agents/sap');
    const p = spawn('docker', ['run', '--rm', '--name', `ez-sap-bridge-${port}`, '--network', 'host', '-v', `${dir}:/s:ro`, 'mcr.microsoft.com/powershell:latest', 'pwsh', '-NoProfile', '-File', '/s/ez-sap-bridge.ps1', '-Port', String(port), '-Token', 'tok'], { stdio: 'ignore' });
    try {
      const c = new AgentClient({ url: `http://127.0.0.1:${port}`, token: 'tok', timeoutMs: 2000 });
      let hello: Awaited<ReturnType<AgentClient['hello']>> | undefined;
      for (let i = 0; i < 60 && !hello; i++) {
        hello = await c.hello().catch(() => undefined);
        if (!hello) await new Promise((r) => setTimeout(r, 500));
      }
      expect(hello).toMatchObject({ agent: 'sap', protocol: 'ez-agent/1' });
      await expect(new AgentClient({ url: `http://127.0.0.1:${port}`, token: 'bad' }).hello()).rejects.toThrow(/token/);
      // Without SAP GUI the COM layer reports a clear error instead of crashing the bridge.
      await expect(c.call('open', { connection: 'ERP' })).rejects.toThrow(/SapROTWr|COM|class|not/i);
      expect((await c.hello()).agent).toBe('sap');
    } finally {
      p.kill();
      spawnSync('docker', ['kill', `ez-sap-bridge-${port}`], { stdio: 'ignore' });
    }
  }, 60_000);
});
