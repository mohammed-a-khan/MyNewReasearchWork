/**
 * IBM i green screens end to end: EZTest's TN5250 client (src/legacy/tn5250)
 * talks telnet + GDS records + the 5250 data stream to EZTest's own 5250 host
 * simulator over TCP, driven by plain-English .ez journeys through the runner.
 * The phrasings are the TN3270 ones (Connect / Log on / Type into / Press /
 * Read / Expect), plus the display-station keys (Field Exit, Reset, Roll).
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../support/testkit.js';
import { flattenStepResults, type JourneyResult } from '../../src/core/index.js';
import { DesktopInterceptor, parseLegacyConfig } from '../../src/desktop/index.js';
import { parseEzScript } from '../../src/intent/index.js';
import { Ibmi5250Simulator, Screen5250, Tn5250Client, build5250Screen, createDemoIbmiApp, parseGds } from '../../src/legacy/index.js';
import { runJourneys, type RunOptions } from '../../src/runner/index.js';

let sim: Ibmi5250Simulator;
let moved: Ibmi5250Simulator;
let port = 0;
let movedPort = 0;

beforeAll(async () => {
  sim = new Ibmi5250Simulator(createDemoIbmiApp(), { delayMs: 15 });
  port = (await sim.start()).port;
  moved = new Ibmi5250Simulator(createDemoIbmiApp({ variant: 'moved' }));
  movedPort = (await moved.start()).port;
});
afterAll(async () => {
  await sim.stop();
  await moved.stop();
});

const describeSteps = (j: JourneyResult) =>
  flattenStepResults(j.steps).map(({ result: s }) => `${s.stepId} ${s.intent}: ${s.status}${s.error ? ` (${s.error.message})` : ''}`).join('\n');

function interceptor(p = port) {
  return new DesktopInterceptor(
    parseLegacyConfig({ mainframe: { hosts: { ez400: { host: '127.0.0.1', port: p, protocol: 'tn5250', deviceName: 'EZTEST01', users: { clerk: { user: 'CLERK01', password: 'secret://env/IBMI_PW' } } } } } }),
    { resolveSecret: async (ref) => (ref === 'secret://env/IBMI_PW' ? 'SECRET1' : ''), addSecret: () => undefined },
  );
}

async function run(ez: string, opts: Partial<RunOptions> = {}) {
  const outputDir = opts.outputDir ?? (await mkdtemp(join(tmpdir(), 'eztest-tn5250-')));
  const r = await runJourneys([parseEzScript(ez)], { outputDir, stepTimeoutMs: 8000, conditionTimeoutMs: 3000, stepInterceptors: [interceptor()], ...opts });
  return { run: r, j: r.journeys[0], outputDir };
}

const INQUIRY = `Journey: Customer inquiry on IBM i
Connect to IBM i "ez400"
  Expect the screen to contain "Sign On"
  Expect the screen to contain "EZTEST01"
Type "clerk01" into the "User" field
Type "SECRET1" into the "Password" field
Press Enter
  Expect the screen to contain "IBM i Main Menu"
Type "1" into the "Selection or command" field
Press Enter
  Expect the screen to contain "Customer Inquiry"
Type "100001" into the "Customer number" field
Press Enter
  Expect the screen to contain "Customer found."
Read the "Balance" field as balance
Expect the "Name" field contains "ADA LOVELACE"
Expect the field at row 8 column 34 to be "ACTIVE"
Type "7" into the "Customer number" field
Press Enter
  Expect the screen to contain "CUS0001 Customer number 7 not found."
Press Reset
  Expect the screen to not contain "CUS0001"
Press F3
  Expect the screen to contain "IBM i Main Menu"
Type "90" into the "Selection or command" field
Press Enter
  Expect the screen to contain "Sign On"
Sign off from the IBM i
`;

describe('TN5250 journeys against the IBM i simulator', () => {
  it('signs on, navigates the menu, reads fields, recovers from an error message with Reset and signs off', async () => {
    const { j, run: r, outputDir } = await run(INQUIRY);
    expect(j.status, describeSteps(j)).toBe('passed');
    expect(j.ledger.balance).toBe('1,250.00');
    const s = sim.sessions.at(-1)!;
    // Negotiation: terminal type, the device name over NEW-ENVIRON, and the 5250 query reply.
    expect(s.terminalType).toBe('IBM-3179-2');
    expect(s.environ.DEVNAME).toBe('EZTEST01');
    expect(s.queryReply?.subarray(5, 7)).toEqual(Buffer.from([0xd9, 0x70]));
    expect(s.history.map((h) => h.aid)).toEqual(['ENTER', 'ENTER', 'ENTER', 'ENTER', 'F3', 'ENTER']);
    // The User field is monocase: the host receives upper case. Only modified fields are sent (Read MDT).
    expect(s.history[0].inputs).toEqual({ user: 'CLERK01', password: 'SECRET1' });
    expect(s.history[2].inputs).toEqual({ customer: '100001' });
    const fill = j.steps.find((x) => x.intent.includes('"User"'))!;
    expect(fill.surface).toMatchObject({ driver: 'tn5250', rung: 'field' });
    expect(fill.surface?.via).toMatch(/label "User" at row 6 column 17/);
    // Evidence: an SVG picture and a JSON screen after each attention key, and the password never in it.
    const manifest = (await readFile(join(outputDir, r.runId, 'evidence-manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id: string; path: string; kind: string });
    const shots = manifest.filter((e) => e.path.includes('/desktop/'));
    expect(shots.some((e) => e.path.endsWith('.svg'))).toBe(true);
    for (const e of shots) expect(await readFile(join(outputDir, r.runId, e.path), 'utf8')).not.toContain('SECRET1');
  });

  it('signs on with configured credentials (secret:// through the vault, IBM i field defaults)', async () => {
    const { j } = await run(`Journey: Configured sign-on
Connect to IBM i "ez400"
Sign on to the IBM i as "clerk"
  Expect the screen to contain "IBM i Main Menu"
`);
    expect(j.status, describeSteps(j)).toBe('passed');
  });

  it('reports host messages and field rules clearly', async () => {
    const wrong = await run(`Journey: Wrong password
Connect to IBM i "ez400"
Type "CLERK01" into the "User" field
Type "nope" into the "Password" field
Press Enter
  Expect the screen to contain "IBM i Main Menu"
`);
    expect(wrong.j.status).toBe('failed');
    expect(wrong.j.steps[3].error?.message).toMatch(/does not show "IBM i Main Menu"/);
    const typed = await run(`Journey: Field rules
Connect to IBM i "ez400"
Sign on to the IBM i as "clerk"
Type "1" into the "Selection or command" field
Press Enter
Type "ABC" into the "Customer number" field
`);
    expect(typed.j.steps[4].error?.message).toMatch(/digits only/);
    const blocked = await run(`Journey: Locked by an error
Connect to IBM i "ez400"
Sign on to the IBM i as "clerk"
Type "1" into the "Selection or command" field
Press Enter
Type "7" into the "Customer number" field
Press Enter
Press F3
`);
    expect(blocked.j.steps[6].error?.message).toMatch(/press Reset/);
  });

  it('Field Exit right-adjusts with zero fill; SysReq interrupts; Page Down sends Roll Up', async () => {
    const { j } = await run(`Journey: Keys
Connect to IBM i "ez400"
Sign on to the IBM i as "clerk"
Type "1" into the "Selection or command" field
Press Enter
Type "42" into the "Customer number" field
Press Field Exit
Press Enter
  Expect the screen to contain "GRACE HOPPER"
Press Page Down
Press SysReq
  Expect the screen to contain "System Request"
Press F12
  Expect the screen to contain "Customer Inquiry"
`);
    expect(j.status, describeSteps(j)).toBe('passed');
    const s = sim.sessions.at(-1)!;
    expect(s.history.map((h) => h.aid)).toEqual(['ENTER', 'ENTER', 'ENTER', 'ROLLUP', 'SYSREQ', 'F12']);
    expect(s.history[2].inputs.customer).toBe('000042');
  });

  it('heals a relabelled, moved sign-on field from its fingerprint', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eztest-tn5250-heal-'));
    const fingerprintStore = join(outputDir, 'fp.json');
    const ez = `Journey: Sign on
Connect to IBM i "ez400"
Type "CLERK01" into the "User" field
Type "SECRET1" into the "Password" field
Press Enter
  Expect the screen to contain "IBM i Main Menu"
`;
    const first = await run(ez, { outputDir, fingerprintStore });
    expect(first.j.status, describeSteps(first.j)).toBe('passed');
    const second = await run(ez, { outputDir, fingerprintStore, stepInterceptors: [interceptor(movedPort)] });
    expect(second.j.status, describeSteps(second.j)).toBe('passed-healed');
    expect(second.j.steps[1].heal).toMatchObject({ tier: 'T1-fingerprint', verified: true });
    expect(moved.sessions.at(-1)!.history[0].inputs.user).toBe('CLERK01');
  });
});

describe('TN5250 client and data stream', () => {
  it('builds the format table from Start Of Field orders (FFW, attribute, length) and reads MDT fields back', () => {
    const screen = new Screen5250();
    const { data } = build5250Screen({ fields: [{ row: 3, col: 2, text: 'Item' }, { row: 3, col: 10, name: 'item', length: 5, numeric: 'digits' }, { row: 4, col: 10, name: 'note', length: 8, hidden: true }] });
    screen.process(data);
    expect(screen.keyboardLocked).toBe(false);
    const fields = screen.fields();
    expect(fields.map((f) => [f.row, f.col, f.length, f.numeric, f.hidden])).toEqual([[3, 10, 5, true, false], [4, 10, 8, false, true]]);
    expect(screen.cursor).toBe(screen.addressOf(3, 10));
    screen.fillField(fields[0], '42');
    const inbound = screen.inbound(0xf1);
    expect([...inbound]).toEqual([3, 12, 0xf1, 0x11, 3, 10, 0xf4, 0xf2]);
    // Save Screen produces a stream that rebuilds the same display.
    const copy = new Screen5250();
    copy.process(screen.saveImage());
    expect(copy.textRows()).toEqual(screen.textRows());
    expect(copy.fields().map((f) => f.value)).toEqual(screen.fields().map((f) => f.value));
  });

  it('frames GDS records and answers the 5250 query and Read Screen Immediate', async () => {
    const c = await Tn5250Client.connect({ host: '127.0.0.1', port, deviceName: 'RAW01' });
    try {
      await c.waitForText('Sign On');
      expect(c.negotiationTrace.join('; ')).toMatch(/terminal type; sending IBM-3179-2/);
      expect(c.log.filter((l) => l.dir === 'out').map((l) => l.note)).toContain('query reply');
      expect(parseGds(Buffer.from([0, 10, 0x12, 0xa0, 0, 0, 4, 0, 0, 3])).opcode).toBe(3);
      expect(c.text()).toContain('RAW01');
    } finally {
      c.close();
    }
  });
});
