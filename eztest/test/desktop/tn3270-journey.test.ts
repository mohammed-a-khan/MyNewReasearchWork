/**
 * Mainframe journeys end to end: the real TN3270 client in src/legacy talks
 * telnet + 3270 data stream to the TN3270 host simulator over TCP, driven by
 * plain-English .ez journeys through the runner (Chromium is launched as for
 * any run; the terminal steps never touch it).
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { DesktopInterceptor, parseLegacyConfig } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { MainframeSimulator, createDemoBankApp } from '../../src/legacy/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';

let sim: MainframeSimulator;
let moved: MainframeSimulator;
let port = 0;
let movedPort = 0;

beforeAll(async () => {
  sim = new MainframeSimulator(createDemoBankApp(), { delayMs: 20 });
  port = (await sim.start()).port;
  moved = new MainframeSimulator(createDemoBankApp({ variant: 'moved' }));
  movedPort = (await moved.start()).port;
});
afterAll(async () => {
  await sim.stop();
  await moved.stop();
});

const describeSteps = (j: JourneyResult) =>
  flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId} ${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

function interceptor(p = port, extra: Record<string, unknown> = {}) {
  return new DesktopInterceptor(
    parseLegacyConfig({ mainframe: { hosts: { bank: { host: '127.0.0.1', port: p, users: { clerk: { user: 'CLERK01', password: 'secret://env/BANK_PW' } }, ...extra } } } }),
    { resolveSecret: async (ref) => (ref === 'secret://env/BANK_PW' ? 'SECRET1' : ''), addSecret: () => undefined },
  );
}

async function run(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-tn3270-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 8000, conditionTimeoutMs: 3000, stepInterceptors: [interceptor()], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

const INQUIRY = `Journey: Account inquiry on the mainframe
Connect to mainframe "bank"
  Expect the screen to contain "ACME BANKING SYSTEM"
Type "CLERK01" into the "USERID" field
Type "SECRET1" into the "PASSWORD" field
Press Enter
  Expect the screen to contain "MAIN MENU"
Type "1" in field at row 20 column 14
Press Enter
  Expect the screen to contain "ACCOUNT INQUIRY"
Type "10000001" into the "ACCOUNT NUMBER" field
Press Enter
  Expect the screen to contain "ACCOUNT FOUND"
Expect the field at row 8 column 22 to be "ACTIVE"
Read the "BALANCE" field as balance
Expect the "NAME" field contains "ADA LOVELACE"
Press PF3
  Expect the screen to contain "MAIN MENU"
Press PF3
  Expect the screen to contain "SIGNED OFF"
Disconnect from the mainframe
`;

describe('TN3270 journeys against the host simulator', () => {
  it('signs on, navigates three screens with Enter and PF3, reads and asserts fields', async () => {
    const { j, run: r, outputDir } = await run(INQUIRY);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.balance).toBe('1,250.00');
    // The host saw the operator's input exactly as typed, with real AID keys.
    const s = sim.sessions.at(-1)!;
    expect(s.terminalType).toBe('IBM-3278-2-E');
    expect(s.queryReply?.[0]).toBe(0x88);
    expect(s.history.map((h) => h.aid)).toEqual(['ENTER', 'ENTER', 'ENTER', 'PF3', 'PF3']);
    expect(s.history[0].inputs).toEqual({ userid: 'CLERK01', password: 'SECRET1' });
    expect(s.history[2].inputs).toEqual({ account: '10000001' });
    // Steps record the driver and how the field was found.
    const fill = j.steps.find((x) => x.intent.includes('"USERID"'))!;
    expect(fill.surface).toMatchObject({ driver: 'tn3270', rung: 'field' });
    expect(fill.surface?.via).toMatch(/label "USERID" at row 5 column 10/);
    expect(fill.usedLocator).toEqual({ strategy: 'label', value: 'USERID' });
    // Screen snapshots (SVG picture + JSON screen) are evidence after every AID key.
    const press = j.steps.find((x) => x.intent === 'Press Enter')!;
    const ev = press.evidence.map((id) => r.journeys[0] && id);
    expect(ev.length).toBeGreaterThanOrEqual(2);
    const manifest = (await readFile(join(outputDir, r.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const shots = manifest.filter((e) => press.evidence.includes(e.id));
    expect(shots.map((e) => e.kind).sort()).toEqual(['data', 'screenshot']);
    const svg = await readFile(join(outputDir, r.runId, shots.find((e) => e.kind === 'screenshot')!.path), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('MAIN MENU');
    const json = JSON.parse(await readFile(join(outputDir, r.runId, shots.find((e) => e.kind === 'data')!.path), 'utf8')) as { text: string[]; fields: Array<{ hidden: boolean; value: string }> };
    expect(json.text.join('\n')).toContain('WELCOME CLERK01');
    // The hidden password never reaches a snapshot.
    for (const e of manifest.filter((x) => x.path.includes('/desktop/'))) {
      expect(await readFile(join(outputDir, r.runId, e.path), 'utf8')).not.toContain('SECRET1');
    }
  });

  it('logs on with configured credentials (secret:// resolved through the vault)', async () => {
    const { j } = await run(`Journey: Configured logon
Connect to mainframe "bank"
Log on to the mainframe as "clerk"
  Expect the screen to contain "WELCOME CLERK01"
`);
    expect(j.status, describeSteps(j)).toBe('passed');
  });

  it('fails clearly: wrong expectation, protected field, unknown label', async () => {
    const { j } = await run(`Journey: Failures
Connect to mainframe "bank"
Type "X" at row 1 column 30
`);
    expect(j.status).toBe('failed');
    expect(j.steps[1].error?.message).toMatch(/protected field/);
    const r2 = await run(`Journey: Unknown label
Connect to mainframe "bank"
Type "X" into the "BRANCH" field
`);
    expect(r2.j.steps[1].error?.message).toMatch(/no input field labelled "BRANCH"/);
    const r3 = await run(`Journey: Wrong screen
Connect to mainframe "bank"
Press Enter
  Expect the screen to contain "MAIN MENU"
`);
    expect(r3.j.steps[1].status).toBe('failed');
    expect(r3.j.steps[1].error?.message).toMatch(/does not show "MAIN MENU"/);
    // Failure evidence is the terminal screen, not the idle browser page.
    expect(r3.j.steps[1].evidence.length).toBe(2);
  });

  it('heals a renamed and moved field from its fingerprint, verified by the post-condition', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-tn3270-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    const ez = `Journey: Sign on
Connect to mainframe "bank"
Type "CLERK01" into the "USERID" field
Type "SECRET1" into the "PASSWORD" field
Press Enter
  Expect the screen to contain "WELCOME CLERK01"
`;
    const first = await run(ez, { outputDir, fingerprintStore });
    expect(first.j.status, describeSteps(first.j)).toBe('passed');
    // Same journey against the release where the label became "USER ID" and the field moved 4 columns.
    const second = await run(ez, { outputDir, fingerprintStore, stepInterceptors: [interceptor(movedPort)] });
    const healed = second.j.steps[1];
    expect(second.j.status, describeSteps(second.j)).toBe('passed-healed');
    expect(healed.status).toBe('passed-healed');
    expect(healed.heal).toMatchObject({ tier: 'T1-fingerprint', verified: true, healed: { strategy: 'label', value: 'USER ID' } });
    // The heal proposal rewrites the step to the field's new label.
    const { collectHealProposals, rewriteStepLine } = await import('../../src/heal/index.js');
    const props = collectHealProposals(second.run, [parseEzScript(ez)]);
    expect(props.proposals).toHaveLength(1);
    const step = parseEzScript(ez).steps[1];
    expect(rewriteStepLine('Type "CLERK01" into the "USERID" field', step, props.proposals[0].healed)?.line).toMatch(/^Type "CLERK01" into the "USER ID" field/);
    expect(healed.heal?.reason).toMatch(/now labelled "USER ID"/);
    expect(moved.sessions.at(-1)!.history[0].inputs.userid).toBe('CLERK01');
  });
});
